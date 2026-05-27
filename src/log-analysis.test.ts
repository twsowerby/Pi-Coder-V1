/**
 * Tests for Pi Coder Log Analysis — Spec 14, Phase 3
 *
 * Tests pure analysis functions:
 * - Session counting, lifecycle duration
 * - TDD first-try success rate
 * - Most-looped specs, review distribution
 * - Nudge effectiveness, token usage
 * - RED tautology counting
 * - Summary formatting
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseLogEntries,
  computeTotalSessions,
  computeAvgLifecycleDuration,
  computeTddFirstTryRate,
  computeMostLoopedSpecs,
  computeReviewDistribution,
  computeNudgeEffectiveness,
  computeTokenUsage,
  computeRedTautologyCount,
  computeFullSummary,
  formatSummary,
  computeTimeInState,
  computeOrchestratorTurnsPerSpec,
  computeSkillUtilization,
  type LogEntry,
} from "../src/log-analysis.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Build a JSONL string from an array of event objects. */
function buildJsonl(events: Array<{ type: string; payload: Record<string, unknown>; sessionId?: string }>): string {
  const baseTime = "2026-05-25T10:00:00.000Z";
  const sid = "test-session-001";
  return events.map((e, i) => JSON.stringify({
    timestamp: `2026-05-25T10:0${i}:00.000Z`,
    sessionId: e.sessionId ?? sid,
    type: e.type,
    payload: e.payload,
  })).join("\n");
}

// ---------------------------------------------------------------------------
// Phase 3: Log Analysis Tests
// ---------------------------------------------------------------------------

describe("Phase 3: Log Analysis", () => {
  // --- Session counting ---

  it("computes total sessions from unique sessionIds", () => {
    const jsonl = buildJsonl([
      { type: "fsm_transition", payload: { from: "IDLE", to: "SPEC_WORK" } },
      { type: "fsm_transition", payload: { from: "IDLE", to: "SPEC_WORK" }, sessionId: "session-002" },
      { type: "fsm_transition", payload: { from: "IDLE", to: "SPEC_WORK" }, sessionId: "session-003" },
    ]);
    const entries = parseLogEntries(jsonl);
    assert.strictEqual(computeTotalSessions(entries), 3);
  });

  it("returns 0 sessions for empty entries", () => {
    assert.strictEqual(computeTotalSessions([]), 0);
  });

  // --- Lifecycle duration ---

  it("computes average lifecycle duration from lifecycle_end events", () => {
    const entries: LogEntry[] = [
      { timestamp: "2026-05-25T10:00:00.000Z", sessionId: "s1", type: "lifecycle_end", payload: { outcome: "COMPLETE", wallClockMs: 30000, totalTokens: {} } },
      { timestamp: "2026-05-25T10:00:00.000Z", sessionId: "s2", type: "lifecycle_end", payload: { outcome: "COMPLETE", wallClockMs: 50000, totalTokens: {} } },
    ];
    const avg = computeAvgLifecycleDuration(entries);
    assert.strictEqual(avg, 40000); // (30000 + 50000) / 2
  });

  it("returns null when no lifecycle_end events", () => {
    assert.strictEqual(computeAvgLifecycleDuration([]), null);
  });

  // --- TDD first-try rate ---

  it("computes 100% first-try rate when all GREEN passes on first attempt", () => {
    const entries: LogEntry[] = [
      { timestamp: "2026-05-25T10:00:00.000Z", sessionId: "s1", type: "tdd_green_validate", payload: { valid: true, specId: "auth" } },
      { timestamp: "2026-05-25T10:00:00.000Z", sessionId: "s1", type: "tdd_green_validate", payload: { valid: true, specId: "cart" } },
    ];
    const rate = computeTddFirstTryRate(entries);
    assert.strictEqual(rate, 1.0);
  });

  it("computes 50% first-try rate when one spec needs loops", () => {
    const entries: LogEntry[] = [
      { timestamp: "2026-05-25T10:00:00.000Z", sessionId: "s1", type: "tdd_green_validate", payload: { valid: true, specId: "auth" } },
      { timestamp: "2026-05-25T10:01:00.000Z", sessionId: "s1", type: "tdd_green_validate", payload: { valid: true, specId: "auth" } }, // second attempt
    ];
    const rate = computeTddFirstTryRate(entries);
    assert.strictEqual(rate, 0.5); // first one was first-try, second needed retry
  });

  it("returns null when no GREEN validations", () => {
    assert.strictEqual(computeTddFirstTryRate([]), null);
  });

  // --- Most-looped specs ---

  it("finds most-looped specs from circuit_breaker and fsm_transition events", () => {
    const entries: LogEntry[] = [
      { timestamp: "2026-05-25T10:00:00.000Z", sessionId: "s1", type: "circuit_breaker", payload: { specId: "auth", loopCount: 3, maxLoops: 3 } },
      { timestamp: "2026-05-25T10:00:00.000Z", sessionId: "s1", type: "fsm_transition", payload: { specId: "cart", loopCount: 2 } },
    ];
    const result = computeMostLoopedSpecs(entries, 5);
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].specId, "auth");
    assert.strictEqual(result[0].loopCount, 3);
    assert.strictEqual(result[1].specId, "cart");
    assert.strictEqual(result[1].loopCount, 2);
  });

  it("returns empty array when no loop data", () => {
    assert.deepStrictEqual(computeMostLoopedSpecs([]), []);
  });

  // --- Review distribution ---

  it("computes review outcome distribution", () => {
    const entries: LogEntry[] = [
      { timestamp: "2026-05-25T10:00:00.000Z", sessionId: "s1", type: "review_result", payload: { verdict: "approved" } },
      { timestamp: "2026-05-25T10:00:00.000Z", sessionId: "s1", type: "review_result", payload: { verdict: "needs_changes" } },
      { timestamp: "2026-05-25T10:00:00.000Z", sessionId: "s1", type: "review_result", payload: { verdict: "approved" } },
      { timestamp: "2026-05-25T10:00:00.000Z", sessionId: "s1", type: "review_result", payload: { verdict: "request_changes" } },
    ];
    const dist = computeReviewDistribution(entries);
    assert.strictEqual(dist.approved, 2);
    assert.strictEqual(dist.needsChanges, 1);
    assert.strictEqual(dist.requestChanges, 1);
  });

  it("returns all zeros for empty entries", () => {
    const dist = computeReviewDistribution([]);
    assert.strictEqual(dist.approved, 0);
    assert.strictEqual(dist.needsChanges, 0);
    assert.strictEqual(dist.requestChanges, 0);
  });

  // --- Nudge effectiveness ---

  it("computes nudge effectiveness", () => {
    const entries: LogEntry[] = [
      { timestamp: "2026-05-25T10:00:00.000Z", sessionId: "s1", type: "nudge_fired", payload: { fsmState: "SPEC_WORK", level: 1 } },
      { timestamp: "2026-05-25T10:00:00.000Z", sessionId: "s1", type: "nudge_fired", payload: { fsmState: "TDD_RED_WRITE", level: 1 } },
      { timestamp: "2026-05-25T10:00:00.000Z", sessionId: "s1", type: "nudge_escalation", payload: { fsmState: "TDD_RED_WRITE", newLevel: 2 } },
    ];
    const eff = computeNudgeEffectiveness(entries);
    assert.strictEqual(eff.actedWithinTurn, 1); // 2 fired - 1 escalated
    assert.strictEqual(eff.escalated, 1);
  });

  // --- Token usage ---

  it("computes token usage totals and per-agent breakdown", () => {
    const entries: LogEntry[] = [
      { timestamp: "2026-05-25T10:00:00.000Z", sessionId: "s1", type: "subagent_end", payload: { agent: "pi-coder.researcher", tokenUsage: { input: 1000, output: 2000, total: 3000 } } },
      { timestamp: "2026-05-25T10:00:00.000Z", sessionId: "s1", type: "subagent_end", payload: { agent: "pi-coder.implementor", tokenUsage: { input: 500, output: 1500, total: 2000 } } },
    ];
    const usage = computeTokenUsage(entries);
    assert.strictEqual(usage.total.input, 1500);
    assert.strictEqual(usage.total.output, 3500);
    assert.strictEqual(usage.total.total, 5000);
    assert.strictEqual(usage.perAgent["pi-coder.researcher"].total, 3000);
    assert.strictEqual(usage.perAgent["pi-coder.implementor"].total, 2000);
  });

  it("computes avg tokens per spec from lifecycle_end events", () => {
    const entries: LogEntry[] = [
      { timestamp: "2026-05-25T10:00:00.000Z", sessionId: "s1", type: "lifecycle_end", payload: { specId: "auth", outcome: "COMPLETE", totalTokens: { input: 1000, output: 2000, total: 3000 } } },
      { timestamp: "2026-05-25T10:00:00.000Z", sessionId: "s1", type: "lifecycle_end", payload: { specId: "cart", outcome: "COMPLETE", totalTokens: { input: 2000, output: 4000, total: 6000 } } },
    ];
    const usage = computeTokenUsage(entries);
    assert.ok(usage.avgPerSpec);
    assert.strictEqual(usage.avgPerSpec.total, 4500); // (3000 + 6000) / 2
  });

  // --- RED tautology ---

  it("counts RED_TAUTOLOGY occurrences", () => {
    const entries: LogEntry[] = [
      { timestamp: "2026-05-25T10:00:00.000Z", sessionId: "s1", type: "tdd_red_validate", payload: { valid: false, reason: "RED_TAUTOLOGY" } },
      { timestamp: "2026-05-25T10:00:00.000Z", sessionId: "s1", type: "tdd_red_validate", payload: { valid: true } },
      { timestamp: "2026-05-25T10:00:00.000Z", sessionId: "s1", type: "tdd_red_validate", payload: { valid: false, reason: "RED_TAUTOLOGY" } },
    ];
    assert.strictEqual(computeRedTautologyCount(entries), 2);
  });

  it("returns 0 for no tautologies", () => {
    assert.strictEqual(computeRedTautologyCount([]), 0);
  });

  // --- Full summary ---

  it("computes a full summary from diverse log data", () => {
    const entries: LogEntry[] = [
      { timestamp: "2026-05-25T10:00:00.000Z", sessionId: "s1", type: "lifecycle_start", payload: { specId: "auth", userRequest: "impl auth" } },
      { timestamp: "2026-05-25T10:01:00.000Z", sessionId: "s1", type: "subagent_start", payload: { agent: "pi-coder.researcher", taskSummary: "research", specId: "auth", fsmState: "SPEC_WORK" } },
      { timestamp: "2026-05-25T10:02:00.000Z", sessionId: "s1", type: "subagent_end", payload: { agent: "pi-coder.researcher", durationMs: 60000, tokenUsage: { input: 1000, output: 2000, total: 3000 }, outcome: "success", specId: "auth" } },
      { timestamp: "2026-05-25T10:03:00.000Z", sessionId: "s1", type: "tdd_red_validate", payload: { valid: true, reason: undefined, passed: null, failed: null, specId: "auth" } },
      { timestamp: "2026-05-25T10:04:00.000Z", sessionId: "s1", type: "tdd_green_validate", payload: { valid: true, reason: undefined, passed: 5, failed: 0, specId: "auth" } },
      { timestamp: "2026-05-25T10:05:00.000Z", sessionId: "s1", type: "review_result", payload: { verdict: "approved", issueCount: 0, highSeverityCount: 0, loopCount: 0, specId: "auth" } },
      { timestamp: "2026-05-25T10:06:00.000Z", sessionId: "s1", type: "lifecycle_end", payload: { specId: "auth", outcome: "COMPLETE", wallClockMs: 6000, totalTokens: { input: 1000, output: 2000, total: 3000 } } },
    ];
    const summary = computeFullSummary(entries);
    assert.strictEqual(summary.totalSessions, 1);
    assert.strictEqual(summary.avgLifecycleDurationMs, 6000);
    assert.strictEqual(summary.tddFirstTrySuccessRate, 1.0);
    assert.strictEqual(summary.reviewDistribution.approved, 1);
    assert.strictEqual(summary.redTautologyCount, 0);
    assert.strictEqual(summary.specCount, 1);
  });

  // --- Summary formatting ---

  it("formats summary as human-readable text", () => {
    const summary = computeFullSummary([]);
    const text = formatSummary(summary);
    assert.ok(text.includes("Pi Coder Log Summary"));
    assert.ok(text.includes("Sessions: 0"));
  });

  it("formats summary with data correctly", () => {
    const entries: LogEntry[] = [
      { timestamp: "2026-05-25T10:00:00.000Z", sessionId: "s1", type: "lifecycle_end", payload: { specId: "auth", outcome: "COMPLETE", wallClockMs: 30000, totalTokens: { input: 1000, output: 2000, total: 3000 } } },
      { timestamp: "2026-05-25T10:00:00.000Z", sessionId: "s1", type: "review_result", payload: { verdict: "approved", issueCount: 0, highSeverityCount: 0, loopCount: 0, specId: "auth" } },
      { timestamp: "2026-05-25T10:00:00.000Z", sessionId: "s1", type: "tdd_red_validate", payload: { valid: false, reason: "RED_TAUTOLOGY", specId: "auth" } },
    ];
    const summary = computeFullSummary(entries);
    const text = formatSummary(summary);
    assert.ok(text.includes("30.0s"));
    assert.ok(text.includes("✅"));
    assert.ok(text.includes("🔴"));
  });

  // --- Edge cases ---

  it("handles parseLogEntries with malformed lines", () => {
    const jsonl = '{"type":"fsm_transition","payload":{},"sessionId":"s1","timestamp":"2026-05-25T10:00:00.000Z"}\nMALFORMED\n{"type":"fsm_transition","payload":{},"sessionId":"s2","timestamp":"2026-05-25T10:00:00.000Z"}';
    const entries = parseLogEntries(jsonl);
    assert.strictEqual(entries.length, 2); // Malformed line skipped
  });

  it("handles empty JSONL", () => {
    const entries = parseLogEntries("");
    assert.strictEqual(entries.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Unit 5g: New Analysis Functions
// ---------------------------------------------------------------------------

describe("Unit 5g: New Analysis Functions", () => {
  it("computeTimeInState computes avg/min/max per state", () => {
    const entries = [
      { type: "fsm_transition", payload: { from: "IDLE", to: "SPEC_WORK" }, sessionId: "s1", timestamp: "2026-05-25T10:00:00.000Z" },
      { type: "fsm_transition", payload: { from: "SPEC_WORK", to: "SPEC_APPROVED" }, sessionId: "s1", timestamp: "2026-05-25T10:01:00.000Z" },
      { type: "fsm_transition", payload: { from: "SPEC_APPROVED", to: "GIT_CHECKPOINT" }, sessionId: "s1", timestamp: "2026-05-25T10:02:30.000Z" },
      { type: "fsm_transition", payload: { from: "GIT_CHECKPOINT", to: "TDD_RED_WRITE" }, sessionId: "s1", timestamp: "2026-05-25T10:03:00.000Z" },
    ] as LogEntry[];

    const result = computeTimeInState(entries);

    // IDLE: 60s (10:00 → 10:01)
    assert.ok(result.IDLE);
    assert.strictEqual(result.IDLE.avgMs, 60000);
    assert.strictEqual(result.IDLE.count, 1);

    // SPEC_WORK: 90s (10:01 → 10:02:30)
    assert.ok(result.SPEC_WORK);
    assert.strictEqual(result.SPEC_WORK.avgMs, 90000);

    // SPEC_APPROVED: 30s (10:02:30 → 10:03)
    assert.ok(result.SPEC_APPROVED);
    assert.strictEqual(result.SPEC_APPROVED.avgMs, 30000);
  });

  it("computeTimeInState handles empty entries", () => {
    const result = computeTimeInState([]);
    assert.deepStrictEqual(result, {});
  });

  it("computeTimeInState handles single transition (no duration)", () => {
    const entries = [
      { type: "fsm_transition", payload: { from: "IDLE", to: "SPEC_WORK" }, sessionId: "s1", timestamp: "2026-05-25T10:00:00.000Z" },
    ] as LogEntry[];
    const result = computeTimeInState(entries);
    assert.deepStrictEqual(result, {});
  });

  it("computeOrchestratorTurnsPerSpec counts tool_calls by specId", () => {
    const entries = [
      { type: "tool_call", payload: { toolName: "pi_coder_advance_fsm", specId: "spec-a" }, sessionId: "s1", timestamp: "2026-05-25T10:00:00.000Z" },
      { type: "tool_call", payload: { toolName: "subagent", specId: "spec-a" }, sessionId: "s1", timestamp: "2026-05-25T10:01:00.000Z" },
      { type: "tool_call", payload: { toolName: "pi_coder_advance_fsm", specId: "spec-b" }, sessionId: "s1", timestamp: "2026-05-25T10:02:00.000Z" },
    ] as LogEntry[];

    const result = computeOrchestratorTurnsPerSpec(entries);
    assert.strictEqual(result["spec-a"], 2);
    assert.strictEqual(result["spec-b"], 1);
  });

  it("computeOrchestratorTurnsPerSpec handles none specId", () => {
    const entries = [
      { type: "tool_call", payload: { toolName: "ls", specId: "none" }, sessionId: "s1", timestamp: "2026-05-25T10:00:00.000Z" },
    ] as LogEntry[];

    const result = computeOrchestratorTurnsPerSpec(entries);
    assert.strictEqual(result["none"], 1);
  });

  it("computeSkillUtilization counts skill_reads by skillName", () => {
    const entries = [
      { type: "skill_read", payload: { skillName: "pi-coder-core" }, sessionId: "s1", timestamp: "2026-05-25T10:00:00.000Z" },
      { type: "skill_read", payload: { skillName: "pi-coder-tdd" }, sessionId: "s1", timestamp: "2026-05-25T10:01:00.000Z" },
      { type: "skill_read", payload: { skillName: "pi-coder-core" }, sessionId: "s1", timestamp: "2026-05-25T10:02:00.000Z" },
    ] as LogEntry[];

    const result = computeSkillUtilization(entries);
    assert.strictEqual(result["pi-coder-core"], 2);
    assert.strictEqual(result["pi-coder-tdd"], 1);
  });

  it("computeSkillUtilization handles empty entries", () => {
    const result = computeSkillUtilization([]);
    assert.deepStrictEqual(result, {});
  });

  it("computeFullSummary includes new fields", () => {
    const entries = [
      { type: "lifecycle_start", payload: { specId: "spec-a" }, sessionId: "s1", timestamp: "2026-05-25T10:00:00.000Z" },
      { type: "lifecycle_end", payload: { specId: "spec-a", outcome: "COMPLETE", wallClockMs: 45000, totalTokens: { input: 100, output: 200, total: 300 } }, sessionId: "s1", timestamp: "2026-05-25T10:01:00.000Z" },
    ] as LogEntry[];

    const summary = computeFullSummary(entries);

    // New fields should exist
    assert.ok("timeInState" in summary);
    assert.ok("orchestratorTurnsPerSpec" in summary);
    assert.ok("skillUtilization" in summary);
  });
});
