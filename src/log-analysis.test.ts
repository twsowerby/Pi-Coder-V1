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
  computeCostAnalysis,
  computeAgentDurations,
  computeUnitStats,
  computeRedTautologyCount,
  computeFullSummary,
  formatSummary,
  computeTimeInState,
  computeOrchestratorTurnsPerSpec,
  computeSkillUtilization,
  computePhaseTokenBreakdown,
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

  it("computeTokenUsage handles new-shape events with cacheRead/cacheWrite/cost", () => {
    const entries: LogEntry[] = [
      { timestamp: "2026-05-25T10:00:00.000Z", sessionId: "s1", type: "subagent_end", payload: { agent: "pi-coder.researcher", model: "anthropic/claude-sonnet-4", tokenUsage: { input: 1000, output: 2000, cacheRead: 500, cacheWrite: 100, cost: 0.05 } } },
      { timestamp: "2026-05-25T10:00:00.000Z", sessionId: "s1", type: "subagent_end", payload: { agent: "pi-coder.implementor", model: "anthropic/claude-sonnet-4", tokenUsage: { input: 500, output: 1500, cacheRead: 200, cacheWrite: 50, cost: 0.03 } } },
    ];
    const usage = computeTokenUsage(entries);
    assert.strictEqual(usage.total.input, 1500);
    assert.strictEqual(usage.total.output, 3500);
    assert.strictEqual(usage.total.cacheRead, 700);
    assert.strictEqual(usage.total.cacheWrite, 150);
    assert.strictEqual(usage.total.cost, 0.08);
    assert.strictEqual(usage.perAgent["pi-coder.researcher"].cost, 0.05);
    assert.strictEqual(usage.perAgent["pi-coder.implementor"].cost, 0.03);
  });

  it("computeTokenUsage is backward-compatible with old { input, output, total } shape", () => {
    const entries: LogEntry[] = [
      { timestamp: "2026-05-25T10:00:00.000Z", sessionId: "s1", type: "subagent_end", payload: { agent: "pi-coder.researcher", tokenUsage: { input: 1000, output: 2000, total: 3000 } } },
    ];
    const usage = computeTokenUsage(entries);
    assert.strictEqual(usage.total.input, 1000);
    assert.strictEqual(usage.total.output, 2000);
    assert.strictEqual(usage.total.total, 3000);
    assert.strictEqual(usage.total.cacheRead, 0);
    assert.strictEqual(usage.total.cost, 0);
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
    // Spec 17 new fields
    assert.ok("costAnalysis" in summary);
    assert.ok("agentDurations" in summary);
    assert.ok("unitStats" in summary);
  });
});

// ---------------------------------------------------------------------------
// Spec 17: Logging Observability Tests
// ---------------------------------------------------------------------------

describe("Spec 17: Cost Analysis", () => {
  it("computeCostAnalysis uses usage.cost when available", () => {
    const entries: LogEntry[] = [
      { timestamp: "2026-05-25T10:00:00.000Z", sessionId: "s1", type: "subagent_end", payload: { agent: "pi-coder.researcher", model: "anthropic/claude-sonnet-4", tokenUsage: { input: 1000, output: 2000, cacheRead: 500, cost: 0.05 } } },
      { timestamp: "2026-05-25T10:01:00.000Z", sessionId: "s1", type: "subagent_end", payload: { agent: "pi-coder.implementor", model: "anthropic/claude-sonnet-4", tokenUsage: { input: 500, output: 1500, cost: 0.03 } } },
    ];
    const result = computeCostAnalysis(entries);
    assert.strictEqual(result.totalCostUsd, 0.08);
    assert.strictEqual(result.source, "usage_cost");
    assert.strictEqual(result.perAgent["pi-coder.researcher"].costUsd, 0.05);
    assert.strictEqual(result.perAgent["pi-coder.researcher"].source, "usage_cost");
  });

  it("computeCostAnalysis falls back to user pricing when usage.cost is 0", () => {
    const entries: LogEntry[] = [
      { timestamp: "2026-05-25T10:00:00.000Z", sessionId: "s1", type: "subagent_end", payload: { agent: "pi-coder.researcher", model: "anthropic/claude-sonnet-4", tokenUsage: { input: 1000000, output: 2000000, cacheRead: 500000, cost: 0 } } },
    ];
    const userPricing = {
      "anthropic/claude-sonnet-4": {
        inputPerMillion: 3.0,
        outputPerMillion: 15.0,
        cacheReadPerMillion: 0.3,
        cacheWritePerMillion: 3.75,
      },
    };
    const result = computeCostAnalysis(entries, userPricing);
    assert.strictEqual(result.source, "user_pricing");
    // Input: 1M * $3/M = $3, Output: 2M * $15/M = $30, CacheRead: 0.5M * $0.3/M = $0.15
    const expectedCost = 3.0 + 30.0 + 0.15;
    assert.strictEqual(result.totalCostUsd, expectedCost);
  });

  it("computeCostAnalysis returns unavailable when no cost and no user pricing", () => {
    const entries: LogEntry[] = [
      { timestamp: "2026-05-25T10:00:00.000Z", sessionId: "s1", type: "subagent_end", payload: { agent: "pi-coder.researcher", tokenUsage: { input: 1000, output: 2000, cost: 0 } } },
    ];
    const result = computeCostAnalysis(entries);
    assert.strictEqual(result.source, "unavailable");
    assert.strictEqual(result.totalCostUsd, 0);
  });

  it("computeCostAnalysis computes cacheSavingsPercent correctly", () => {
    const entries: LogEntry[] = [
      { timestamp: "2026-05-25T10:00:00.000Z", sessionId: "s1", type: "subagent_end", payload: { agent: "pi-coder.researcher", tokenUsage: { input: 1000, output: 2000, cacheRead: 4000, cacheWrite: 100, cost: 0.05 } } },
    ];
    const result = computeCostAnalysis(entries);
    assert.ok(result.cacheSavingsPercent !== null);
    // cacheRead/(input + cacheRead) * 100 = 4000/5000 * 100 = 80%
    assert.strictEqual(result.cacheSavingsPercent, 80);
  });

  it("computeCostAnalysis returns null cacheSavingsPercent when no cacheRead", () => {
    const entries: LogEntry[] = [
      { timestamp: "2026-05-25T10:00:00.000Z", sessionId: "s1", type: "subagent_end", payload: { agent: "pi-coder.researcher", tokenUsage: { input: 1000, output: 2000, cost: 0.02 } } },
    ];
    const result = computeCostAnalysis(entries);
    assert.strictEqual(result.cacheSavingsPercent, null);
  });

  it("computeCostAnalysis produces correct coverageStats", () => {
    const entries: LogEntry[] = [
      { timestamp: "2026-05-25T10:00:00.000Z", sessionId: "s1", type: "subagent_end", payload: { agent: "a1", model: "anthropic/claude-sonnet-4", tokenUsage: { input: 1000, output: 2000, cost: 0.05 } } },
      { timestamp: "2026-05-25T10:01:00.000Z", sessionId: "s1", type: "subagent_end", payload: { agent: "a2", model: "unknown-model", tokenUsage: { input: 500, output: 1500, cost: 0 } } },
    ];
    const result = computeCostAnalysis(entries);
    assert.strictEqual(result.coverageStats.withCost, 1);
    assert.strictEqual(result.coverageStats.withoutCost, 1);
    assert.strictEqual(result.coverageStats.total, 2);
    assert.strictEqual(result.source, "mixed");
  });

  it("computeCostAnalysis with empty entries returns unavailable", () => {
    const result = computeCostAnalysis([]);
    assert.strictEqual(result.source, "unavailable");
    assert.strictEqual(result.totalCostUsd, 0);
    assert.strictEqual(result.cacheSavingsPercent, null);
  });
});

describe("Spec 17: Agent Durations", () => {
  it("computeAgentDurations groups by agent and computes stats", () => {
    const entries: LogEntry[] = [
      { timestamp: "2026-05-25T10:00:00.000Z", sessionId: "s1", type: "subagent_end", payload: { agent: "pi-coder.researcher", durationMs: 30000, tokenUsage: {} } },
      { timestamp: "2026-05-25T10:01:00.000Z", sessionId: "s1", type: "subagent_end", payload: { agent: "pi-coder.researcher", durationMs: 60000, tokenUsage: {} } },
      { timestamp: "2026-05-25T10:02:00.000Z", sessionId: "s1", type: "subagent_end", payload: { agent: "pi-coder.implementor", durationMs: 90000, tokenUsage: {} } },
    ];
    const result = computeAgentDurations(entries);
    assert.ok(result["pi-coder.researcher"]);
    assert.strictEqual(result["pi-coder.researcher"].avgMs, 45000);
    assert.strictEqual(result["pi-coder.researcher"].count, 2);
    assert.strictEqual(result["pi-coder.researcher"].minMs, 30000);
    assert.strictEqual(result["pi-coder.researcher"].maxMs, 60000);
    assert.strictEqual(result["pi-coder.implementor"].avgMs, 90000);
  });

  it("computeAgentDurations handles empty entries", () => {
    const result = computeAgentDurations([]);
    assert.deepStrictEqual(result, {});
  });
});

describe("Spec 17: Unit Stats", () => {
  it("computeUnitStats groups by unit name", () => {
    const entries: LogEntry[] = [
      { timestamp: "2026-05-25T10:00:00.000Z", sessionId: "s1", type: "unit_end", payload: { unitName: "signup", specId: "auth", loopCount: 1, outcome: "green_validated" } },
      { timestamp: "2026-05-25T10:01:00.000Z", sessionId: "s1", type: "unit_end", payload: { unitName: "signup", specId: "auth", loopCount: 3, outcome: "circuit_breaker" } },
      { timestamp: "2026-05-25T10:02:00.000Z", sessionId: "s1", type: "unit_end", payload: { unitName: "persistence", specId: "auth", loopCount: 0, outcome: "green_validated" } },
    ];
    const result = computeUnitStats(entries);
    assert.strictEqual(result.length, 2);
    const signup = result.find(u => u.unitName === "signup");
    assert.ok(signup);
    assert.strictEqual(signup!.count, 2);
    assert.strictEqual(signup!.avgLoopCount, 2); // (1+3)/2
    assert.strictEqual(signup!.outcomes["green_validated"], 1);
    assert.strictEqual(signup!.outcomes["circuit_breaker"], 1);
  });

  it("computeUnitStats handles empty entries", () => {
    const result = computeUnitStats([]);
    assert.strictEqual(result.length, 0);
  });

  it("computeUnitStats distinguishes same unit name across different specs", () => {
    const entries: LogEntry[] = [
      { timestamp: "2026-05-25T10:00:00.000Z", sessionId: "s1", type: "unit_end", payload: { unitName: "persistence", specId: "auth", loopCount: 0, outcome: "green_validated" } },
      { timestamp: "2026-05-25T10:01:00.000Z", sessionId: "s1", type: "unit_end", payload: { unitName: "persistence", specId: "cart", loopCount: 2, outcome: "circuit_breaker" } },
    ];
    const result = computeUnitStats(entries);
    assert.strictEqual(result.length, 2); // Two separate entries, not merged
    const authPersistence = result.find(u => u.specId === "auth" && u.unitName === "persistence");
    const cartPersistence = result.find(u => u.specId === "cart" && u.unitName === "persistence");
    assert.ok(authPersistence);
    assert.ok(cartPersistence);
    assert.strictEqual(authPersistence!.outcomes["green_validated"], 1);
    assert.strictEqual(cartPersistence!.outcomes["circuit_breaker"], 1);
  });
});

describe("Spec 17: Format Summary with Cost", () => {
  it("formatSummary includes cost section when data is available", () => {
    const entries: LogEntry[] = [
      { timestamp: "2026-05-25T10:00:00.000Z", sessionId: "s1", type: "subagent_end", payload: { agent: "pi-coder.researcher", model: "anthropic/claude-sonnet-4", durationMs: 30000, tokenUsage: { input: 1000, output: 2000, cost: 0.05 } } },
    ];
    const summary = computeFullSummary(entries);
    const text = formatSummary(summary);
    assert.ok(text.includes("💰"));
    assert.ok(text.includes("$0.05"));
    assert.ok(text.includes("usage.cost"));
  });

  it("formatSummary shows no data note when cost is unavailable", () => {
    const entries: LogEntry[] = [
      { timestamp: "2026-05-25T10:00:00.000Z", sessionId: "s1", type: "subagent_end", payload: { agent: "pi-coder.researcher", durationMs: 30000, tokenUsage: { input: 1000, output: 2000, cost: 0 } } },
    ];
    const summary = computeFullSummary(entries);
    const text = formatSummary(summary);
    // Without cost, the 💰 section should either not appear or say no data
    const hasCostSection = text.includes("💰");
    if (hasCostSection) {
      assert.ok(text.includes("no data") || text.includes("tokenPricing"));
    }
  });

  it("formatSummary shows cache stats without false no-data message when cost=0 but cache>0", () => {
    const entries: LogEntry[] = [
      { timestamp: "2026-05-25T10:00:00.000Z", sessionId: "s1", type: "subagent_end", payload: { agent: "pi-coder.researcher", tokenUsage: { input: 1000, output: 2000, cacheRead: 5000, cacheWrite: 100, cost: 0 } } },
    ];
    const summary = computeFullSummary(entries);
    const text = formatSummary(summary);
    // Should NOT say "no data available" when cache stats exist
    const noDataMsg = text.includes("no data available");
    const hasCache = text.includes("Cache:") || text.includes("cache");
    // Either there's no misleading "no data" message, or there are cache stats to accompany it
    assert.ok(!noDataMsg || hasCache, "Should not say 'no data' when cache stats are present");
  });

  it("formatSummary includes per-agent durations", () => {
    const entries: LogEntry[] = [
      { timestamp: "2026-05-25T10:00:00.000Z", sessionId: "s1", type: "subagent_end", payload: { agent: "pi-coder.researcher", durationMs: 45000, tokenUsage: { input: 0, output: 0, cost: 0 } } },
      { timestamp: "2026-05-25T10:01:00.000Z", sessionId: "s1", type: "subagent_end", payload: { agent: "pi-coder.researcher", durationMs: 78000, tokenUsage: { input: 0, output: 0, cost: 0 } } },
    ];
    const summary = computeFullSummary(entries);
    const text = formatSummary(summary);
    assert.ok(text.includes("⏱️ Per-agent durations"));
    assert.ok(text.includes("pi-coder.researcher"));
    assert.ok(text.includes("61.5s")); // avg of 45s and 78s
  });

  it("formatSummary includes cache info when cacheRead > 0", () => {
    const entries: LogEntry[] = [
      { timestamp: "2026-05-25T10:00:00.000Z", sessionId: "s1", type: "subagent_end", payload: { agent: "pi-coder.researcher", tokenUsage: { input: 1000, output: 2000, cacheRead: 4000, cacheWrite: 100, cost: 0.05 } } },
    ];
    const summary = computeFullSummary(entries);
    const text = formatSummary(summary);
    assert.ok(text.includes("Cache:"));
  });
});

describe("Phase Token Breakdown", () => {
  it("computePhaseTokenBreakdown from lifecycle_end.phaseTokens", () => {
    const entries: LogEntry[] = [
      {
        timestamp: "2026-05-25T10:00:00.000Z", sessionId: "s1", type: "lifecycle_end", payload: {
          specId: "auth", outcome: "COMPLETE", wallClockMs: 50000,
          totalTokens: { input: 5000, output: 3000, cost: 0.1 },
          phaseTokens: {
            SPEC_WORK: {
              input: 1000, output: 500, cacheRead: 800, cacheWrite: 0, cost: 0.02, turns: 3,
              source: {
                orchestrator: { input: 500, output: 200, cacheRead: 300, cacheWrite: 0, cost: 0.01, turns: 3 },
                subagent: { input: 500, output: 300, cacheRead: 500, cacheWrite: 0, cost: 0.01, turns: 0 },
              },
            },
            TDD_RED_WRITE: {
              input: 2000, output: 1500, cacheRead: 700, cacheWrite: 0, cost: 0.05, turns: 4,
              source: {
                orchestrator: { input: 200, output: 100, cacheRead: 100, cacheWrite: 0, cost: 0.005, turns: 4 },
                subagent: { input: 1800, output: 1400, cacheRead: 600, cacheWrite: 0, cost: 0.045, turns: 0 },
              },
            },
          },
        },
      },
    ];
    const result = computePhaseTokenBreakdown(entries);
    assert.ok(result.byState.SPEC_WORK, "SPEC_WORK should be in breakdown");
    assert.strictEqual(result.byState.SPEC_WORK.input, 1000);
    assert.strictEqual(result.byState.SPEC_WORK.source.orchestrator.input, 500);
    assert.strictEqual(result.byState.SPEC_WORK.source.subagent.input, 500);
    assert.ok(result.byState.TDD_RED_WRITE, "TDD_RED_WRITE should be in breakdown");
    assert.strictEqual(result.byState.TDD_RED_WRITE.input, 2000);
    assert.strictEqual(result.byState.TDD_RED_WRITE.source.subagent.input, 1800);
  });

  it("computePhaseTokenBreakdown from fsm_state_usage events", () => {
    const entries: LogEntry[] = [
      {
        timestamp: "2026-05-25T10:00:00.000Z", sessionId: "s1", type: "fsm_state_usage", payload: {
          state: "REVIEWING",
          input: 3000, output: 2000, cacheRead: 1500, cacheWrite: 0, cost: 0.08, turns: 5,
          source: {
            orchestrator: { input: 1000, output: 500, cacheRead: 500, cacheWrite: 0, cost: 0.02, turns: 5 },
            subagent: { input: 2000, output: 1500, cacheRead: 1000, cacheWrite: 0, cost: 0.06, turns: 0 },
          },
          specId: "auth",
          nextState: "APPROVED",
        },
      },
    ];
    const result = computePhaseTokenBreakdown(entries);
    assert.ok(result.byState.REVIEWING);
    assert.strictEqual(result.byState.REVIEWING.input, 3000);
    assert.strictEqual(result.byState.REVIEWING.source.orchestrator.input, 1000);
    assert.strictEqual(result.byState.REVIEWING.source.subagent.input, 2000);
  });

  it("computePhaseTokenBreakdown returns empty for no data", () => {
    const result = computePhaseTokenBreakdown([]);
    assert.strictEqual(Object.keys(result.byState).length, 0);
  });

  it("computeFullSummary includes phaseTokenBreakdown", () => {
    const entries: LogEntry[] = [
      {
        timestamp: "2026-05-25T10:00:00.000Z", sessionId: "s1", type: "lifecycle_end", payload: {
          specId: "auth", outcome: "COMPLETE", wallClockMs: 30000,
          totalTokens: { input: 1000, output: 2000, total: 3000 },
          phaseTokens: {
            SPEC_WORK: {
              input: 500, output: 1000, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 2,
              source: {
                orchestrator: { input: 250, output: 500, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 2 },
                subagent: { input: 250, output: 500, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
              },
            },
          },
        },
      },
    ];
    const summary = computeFullSummary(entries);
    assert.ok(summary.phaseTokenBreakdown);
    assert.ok(summary.phaseTokenBreakdown.byState.SPEC_WORK);
    assert.strictEqual(summary.phaseTokenBreakdown.byState.SPEC_WORK.input, 500);
  });

  it("formatSummary includes per-state token breakdown", () => {
    const entries: LogEntry[] = [
      {
        timestamp: "2026-05-25T10:00:00.000Z", sessionId: "s1", type: "lifecycle_end", payload: {
          specId: "auth", outcome: "COMPLETE", wallClockMs: 30000,
          totalTokens: { input: 5000, output: 3000, total: 8000 },
          phaseTokens: {
            SPEC_WORK: {
              input: 1000, output: 500, cacheRead: 800, cacheWrite: 0, cost: 0, turns: 3,
              source: {
                orchestrator: { input: 500, output: 200, cacheRead: 300, cacheWrite: 0, cost: 0, turns: 3 },
                subagent: { input: 500, output: 300, cacheRead: 500, cacheWrite: 0, cost: 0, turns: 0 },
              },
            },
            TDD_RED_WRITE: {
              input: 4000, output: 2500, cacheRead: 1000, cacheWrite: 0, cost: 0, turns: 7,
              source: {
                orchestrator: { input: 200, output: 100, cacheRead: 100, cacheWrite: 0, cost: 0, turns: 7 },
                subagent: { input: 3800, output: 2400, cacheRead: 900, cacheWrite: 0, cost: 0, turns: 0 },
              },
            },
          },
        },
      },
    ];
    const summary = computeFullSummary(entries);
    const text = formatSummary(summary);
    assert.ok(text.includes("Per-state tokens"), "Should include per-state section");
    assert.ok(text.includes("SPEC_WORK"), "Should mention SPEC_WORK");
    assert.ok(text.includes("TDD_RED_WRITE"), "Should mention TDD_RED_WRITE");
    assert.ok(text.includes("orchestrator:"), "Should include source breakdown");
    assert.ok(text.includes("subagent:"), "Should include source breakdown");
  });
});
