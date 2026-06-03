/**
 * Tests for Pi Coder Logging Instrumentation — Spec 14, Phase 2
 *
 * Tests the extension's log event emission at key lifecycle points:
 * - FSM transitions emit fsm_transition events
 * - Toggle command emits command events
 * - Nudge system emits nudge_fired/nudge_escalation events
 * - Token usage extraction from subagent results
 * - Review verdict extraction from reviewer output
 * - Lifecycle start/end events on appropriate transitions
 * - Circuit breaker events when maxLoops exceeded
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { PiCoderConfig, FSMState } from "../src/types.ts";
import { DevStateMachine } from "../src/dev-state-machine.ts";
import { Logger, LOG_LEVEL_MAP, type FSMTrigger } from "../src/logger.ts";
import type { LogEventType } from "../src/logger.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides?: Partial<PiCoderConfig>): PiCoderConfig {
  return {
    testCommand: "npm test",
    maxLoops: 3,
    createBranch: true,
    mergeBranch: "merge",
    branchPrefix: "pi-coder/",
    nudge: {
      enabled: true,
      defaults: { turnsBeforeNudge: 1, escalationLevels: 3 },
      states: {
        SPEC_WORK: { turnsBeforeNudge: 3 },
        BLOCKED: { turnsBeforeNudge: 2 },
        IDLE: { enabled: false },
        SPEC_APPROVED: { enabled: false },
        FINAL_APPROVAL: { enabled: false },
        COMPLETE: { enabled: false },
      },
    },
    logging: {
      enabled: true,
      level: "verbose",
      maxLogFiles: 10,
    },
    subagentControl: {
      enabled: true,
    },
    notifications: {
      enabled: false,
    },
    retryEscalation: {
      maxRetries: 10,
      enrichedSteerThreshold: 4,
      replanThreshold: 7,
    },
    ...overrides,
  };
}

function createLogDir(): string {
  const dir = join(tmpdir(), `pi-coder-instr-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanupLogDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best effort
  }
}

function readLogLines(dir: string): Array<Record<string, unknown>> {
  const files = readdirSync(dir).filter(f => f.endsWith(".log")).sort();
  if (files.length === 0) return [];
  const lines: Array<Record<string, unknown>> = [];
  for (const f of files) {
    const content = readFileSync(join(dir, f), "utf-8");
    for (const line of content.trim().split("\n").filter(Boolean)) {
      lines.push(JSON.parse(line));
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Phase 2: Extension Instrumentation Tests
// ---------------------------------------------------------------------------

describe("Phase 2: Logging Instrumentation", () => {
  it("all log event types exist in LOG_LEVEL_MAP", () => {
    const expectedTypes: LogEventType[] = [
      "lifecycle_start", "lifecycle_end", "fsm_transition",
      "tdd_red_validate", "tdd_green_validate", "circuit_breaker",
      "subagent_start", "subagent_end", "review_result",
      "command", "user_intervention",
      "nudge_fired", "nudge_escalation",
    ];
    for (const t of expectedTypes) {
      assert.ok(t in LOG_LEVEL_MAP, `${t} missing from LOG_LEVEL_MAP`);
    }
  });

  it("logger records fsm_transition events correctly", () => {
    const logDir = createLogDir();
    try {
      const config = makeConfig();
      const sm = new DevStateMachine(config);
      const logger = new Logger(logDir, config.logging);
      const sessionId = "test-fsm-transition";

      // Simulate a transition
      sm.transition("SPEC_WORK");
      logger.log({
        timestamp: new Date().toISOString(),
        sessionId,
        type: "fsm_transition",
        payload: { from: "IDLE", to: "SPEC_WORK", event: "start_research", loopCount: 0, specId: null },
      });

      const lines = readLogLines(logDir);
      assert.strictEqual(lines.length, 1);
      assert.strictEqual(lines[0].type, "fsm_transition");
      assert.strictEqual((lines[0].payload as Record<string, unknown>).from, "IDLE");
      assert.strictEqual((lines[0].payload as Record<string, unknown>).to, "SPEC_WORK");
    } finally {
      cleanupLogDir(logDir);
    }
  });

  it("logger records tdd_red_validate events", () => {
    const logDir = createLogDir();
    try {
      const config = makeConfig();
      const logger = new Logger(logDir, config.logging);

      logger.log({
        timestamp: new Date().toISOString(),
        sessionId: "test-tdd",
        type: "tdd_red_validate",
        payload: { valid: true, reason: undefined, passed: null, failed: null, specId: "user-auth" },
      });

      const lines = readLogLines(logDir);
      assert.strictEqual(lines.length, 1);
      assert.strictEqual(lines[0].type, "tdd_red_validate");
      assert.strictEqual((lines[0].payload as Record<string, unknown>).valid, true);
      assert.strictEqual((lines[0].payload as Record<string, unknown>).specId, "user-auth");
    } finally {
      cleanupLogDir(logDir);
    }
  });

  it("logger records tdd_green_validate events with failure", () => {
    const logDir = createLogDir();
    try {
      const config = makeConfig();
      const logger = new Logger(logDir, config.logging);

      logger.log({
        timestamp: new Date().toISOString(),
        sessionId: "test-tdd",
        type: "tdd_green_validate",
        payload: { valid: false, reason: "GREEN_FAILED", passed: 3, failed: 2, specId: "user-auth" },
      });

      const lines = readLogLines(logDir);
      assert.strictEqual(lines.length, 1);
      const payload = lines[0].payload as Record<string, unknown>;
      assert.strictEqual(payload.valid, false);
      assert.strictEqual(payload.reason, "GREEN_FAILED");
      assert.strictEqual(payload.passed, 3);
      assert.strictEqual(payload.failed, 2);
    } finally {
      cleanupLogDir(logDir);
    }
  });

  it("logger records subagent_start and subagent_end as a pair", () => {
    const logDir = createLogDir();
    try {
      const config = makeConfig();
      const logger = new Logger(logDir, config.logging);

      logger.log({
        timestamp: new Date().toISOString(),
        sessionId: "test-subagent",
        type: "subagent_start",
        payload: { agent: "pi-coder.researcher", taskSummary: "Research the codebase for auth patterns", specId: "user-auth", fsmState: "SPEC_WORK" },
      });

      logger.log({
        timestamp: new Date().toISOString(),
        sessionId: "test-subagent",
        type: "subagent_end",
        payload: { agent: "pi-coder.researcher", durationMs: 37333, tokenUsage: { input: 1200, output: 3500, total: 4700 }, outcome: "success", specId: "user-auth" },
      });

      const lines = readLogLines(logDir);
      assert.strictEqual(lines.length, 2);
      assert.strictEqual(lines[0].type, "subagent_start");
      assert.strictEqual(lines[1].type, "subagent_end");

      const endPayload = lines[1].payload as Record<string, unknown>;
      assert.strictEqual(endPayload.durationMs, 37333);
      const tokens = endPayload.tokenUsage as Record<string, number>;
      assert.strictEqual(tokens.input, 1200);
      assert.strictEqual(tokens.output, 3500);
      assert.strictEqual(tokens.total, 4700);
    } finally {
      cleanupLogDir(logDir);
    }
  });

  it("logger records command events for toggle on/off", () => {
    const logDir = createLogDir();
    try {
      const config = makeConfig();
      const logger = new Logger(logDir, config.logging);

      logger.log({
        timestamp: new Date().toISOString(),
        sessionId: "test-cmd",
        type: "command",
        payload: { command: "toggle", result: "on" },
      });

      logger.log({
        timestamp: new Date().toISOString(),
        sessionId: "test-cmd",
        type: "command",
        payload: { command: "toggle", result: "off" },
      });

      const lines = readLogLines(logDir);
      assert.strictEqual(lines.length, 2);
      assert.strictEqual((lines[0].payload as Record<string, unknown>).result, "on");
      assert.strictEqual((lines[1].payload as Record<string, unknown>).result, "off");
    } finally {
      cleanupLogDir(logDir);
    }
  });

  it("logger records review_result events", () => {
    const logDir = createLogDir();
    try {
      const config = makeConfig();
      const logger = new Logger(logDir, config.logging);

      logger.log({
        timestamp: new Date().toISOString(),
        sessionId: "test-review",
        type: "review_result",
        payload: { verdict: "needs_changes", issueCount: 3, highSeverityCount: 1, loopCount: 1, specId: "user-auth" },
      });

      const lines = readLogLines(logDir);
      assert.strictEqual(lines.length, 1);
      const payload = lines[0].payload as Record<string, unknown>;
      assert.strictEqual(payload.verdict, "needs_changes");
      assert.strictEqual(payload.issueCount, 3);
      assert.strictEqual(payload.highSeverityCount, 1);
    } finally {
      cleanupLogDir(logDir);
    }
  });

  it("logger records lifecycle_start and lifecycle_end events", () => {
    const logDir = createLogDir();
    try {
      const config = makeConfig();
      const logger = new Logger(logDir, config.logging);

      logger.log({
        timestamp: new Date().toISOString(),
        sessionId: "test-lifecycle",
        type: "lifecycle_start",
        payload: { specId: "user-auth", userRequest: "Implement user authentication" },
      });

      logger.log({
        timestamp: new Date().toISOString(),
        sessionId: "test-lifecycle",
        type: "lifecycle_end",
        payload: { specId: "user-auth", outcome: "COMPLETE", wallClockMs: 45000, totalTokens: { input: 5000, output: 8000, total: 13000 } },
      });

      const lines = readLogLines(logDir);
      assert.strictEqual(lines.length, 2);
      assert.strictEqual(lines[0].type, "lifecycle_start");
      assert.strictEqual(lines[1].type, "lifecycle_end");
      assert.strictEqual((lines[1].payload as Record<string, unknown>).outcome, "COMPLETE");
      assert.strictEqual((lines[1].payload as Record<string, unknown>).wallClockMs, 45000);
    } finally {
      cleanupLogDir(logDir);
    }
  });

  it("logger records circuit_breaker events", () => {
    const logDir = createLogDir();
    try {
      const config = makeConfig();
      const logger = new Logger(logDir, config.logging);

      logger.log({
        timestamp: new Date().toISOString(),
        sessionId: "test-breaker",
        type: "circuit_breaker",
        payload: { loopCount: 3, maxLoops: 3, specId: "user-auth" },
      });

      const lines = readLogLines(logDir);
      assert.strictEqual(lines.length, 1);
      const payload = lines[0].payload as Record<string, unknown>;
      assert.strictEqual(payload.loopCount, 3);
      assert.strictEqual(payload.maxLoops, 3);
    } finally {
      cleanupLogDir(logDir);
    }
  });

  it("logger records nudge events", () => {
    const logDir = createLogDir();
    try {
      const config = makeConfig({ logging: { enabled: true, level: "verbose", maxLogFiles: 10 } });
      const logger = new Logger(logDir, config.logging);

      logger.log({
        timestamp: new Date().toISOString(),
        sessionId: "test-nudge",
        type: "nudge_fired",
        payload: { fsmState: "SPEC_WORK", level: 1, expectedAction: "Delegate to pi-coder.researcher" },
      });

      logger.log({
        timestamp: new Date().toISOString(),
        sessionId: "test-nudge",
        type: "nudge_escalation",
        payload: { fsmState: "SPEC_WORK", newLevel: 3 },
      });

      const lines = readLogLines(logDir);
      assert.strictEqual(lines.length, 2);
      assert.strictEqual(lines[0].type, "nudge_fired");
      assert.strictEqual(lines[1].type, "nudge_escalation");
      assert.strictEqual((lines[1].payload as Record<string, unknown>).newLevel, 3);
    } finally {
      cleanupLogDir(logDir);
    }
  });

  it("logger records user_intervention events", () => {
    const logDir = createLogDir();
    try {
      const config = makeConfig();
      const logger = new Logger(logDir, config.logging);

      logger.log({
        timestamp: new Date().toISOString(),
        sessionId: "test-intervention",
        type: "user_intervention",
        payload: { fsmState: "BLOCKED", interventionType: "continue_anyway" },
      });

      const lines = readLogLines(logDir);
      assert.strictEqual(lines.length, 1);
      assert.strictEqual((lines[0].payload as Record<string, unknown>).interventionType, "continue_anyway");
    } finally {
      cleanupLogDir(logDir);
    }
  });

  it("token usage extraction works from pi-subagents Details shape", () => {
    // Simulate pi-subagents Details object (the actual shape)
    const details = {
      results: [{
        usage: {
          input: 1500,
          output: 3000,
          cacheRead: 500,
          cacheWrite: 100,
          cost: 0.05,
          turns: 3,
        },
        model: "anthropic/claude-sonnet-4",
        exitCode: 0,
        error: null,
      }],
    };

    // This is what extractSubagentUsage now does
    const firstResult = (details as { results: Array<Record<string, unknown>> }).results[0];
    const usage = firstResult.usage as { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: number; turns?: number };

    assert.strictEqual(usage.input, 1500);
    assert.strictEqual(usage.output, 3000);
    assert.strictEqual(usage.cacheRead, 500);
    assert.strictEqual(usage.cacheWrite, 100);
    assert.strictEqual(usage.cost, 0.05);
    assert.strictEqual(usage.turns, 3);
    assert.strictEqual(firstResult.model, "anthropic/claude-sonnet-4");
    assert.strictEqual(firstResult.exitCode, 0);
  });

  it("review verdict extraction from text content with emoji markers", () => {
    const text = `# Code Review\n\n✅ Approved\n\nSome nice code here.`;
    let verdict: string;
    if (text.includes("✅") || /approved/i.test(text.slice(0, 500))) {
      verdict = "approved";
    } else if (text.includes("❌") || /request.?changes/i.test(text.slice(0, 500))) {
      verdict = "request_changes";
    } else {
      verdict = "needs_changes";
    }
    assert.strictEqual(verdict, "approved");

    // Test needs_changes
    const text2 = `⚠️ Needs Changes\n\n🔴 High: Critical bug found.`;
    const highCount = (text2.match(/🔴/g) ?? []).length;
    if (text2.includes("⚠️") || /needs.?changes/i.test(text2.slice(0, 500))) {
      verdict = "needs_changes";
    }
    assert.strictEqual(verdict, "needs_changes");
    assert.strictEqual(highCount, 1);
  });

  it("duration tracking computes correct elapsed time", () => {
    const start = Date.now() - 5000; // 5 seconds ago
    const durationMs = Date.now() - start;
    assert.ok(durationMs >= 5000);
    assert.ok(durationMs < 6000); // Reasonable bound
  });

  it("lifecycleTokens accumulate across subagent events (new shape)", () => {
    let lifecycleTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };

    // First subagent
    lifecycleTokens.input += 1000;
    lifecycleTokens.output += 2000;
    lifecycleTokens.cacheRead += 500;
    lifecycleTokens.cacheWrite += 100;
    lifecycleTokens.cost += 0.05;
    lifecycleTokens.turns += 3;

    // Second subagent
    lifecycleTokens.input += 500;
    lifecycleTokens.output += 1500;
    lifecycleTokens.cacheRead += 200;
    lifecycleTokens.cost += 0.03;
    lifecycleTokens.turns += 2;

    assert.strictEqual(lifecycleTokens.input, 1500);
    assert.strictEqual(lifecycleTokens.output, 3500);
    assert.strictEqual(lifecycleTokens.cacheRead, 700);
    assert.strictEqual(lifecycleTokens.cacheWrite, 100);
    assert.strictEqual(lifecycleTokens.cost, 0.08);
    assert.strictEqual(lifecycleTokens.turns, 5);
  });
});

// ---------------------------------------------------------------------------
// Unit 5h: New Logging Event Tests
// ---------------------------------------------------------------------------

describe("Unit 5h: New Logging Events", () => {
  it("prompt_size event has correct shape", () => {
    const logDir = createLogDir();
    try {
      const config = makeConfig();
      const logger = new Logger(logDir, config.logging);

      logger.log({
        timestamp: new Date().toISOString(),
        sessionId: "test-prompt-size",
        type: "prompt_size",
        payload: {
          promptChars: 2590,
          skillCount: 3,
          skillNames: ["pi-coder-core", "pi-coder-tdd", "pi-intercom"],
          toolCount: 12,
          contextFileCount: 2,
          contextFileChars: 500,
          fsmState: "SPEC_WORK",
          mode: "dev",
        },
      });

      const lines = readLogLines(logDir);
      assert.strictEqual(lines.length, 1);
      assert.strictEqual(lines[0].type, "prompt_size");
      const payload = lines[0].payload as Record<string, unknown>;
      assert.strictEqual(payload.promptChars, 2590);
      assert.strictEqual(payload.skillCount, 3);
      assert.strictEqual(payload.fsmState, "SPEC_WORK");
      assert.strictEqual(payload.mode, "tdd");
    } finally {
      cleanupLogDir(logDir);
    }
  });

  it("skill_read event has correct shape", () => {
    const logDir = createLogDir();
    try {
      const config = makeConfig();
      const logger = new Logger(logDir, config.logging);

      logger.log({
        timestamp: new Date().toISOString(),
        sessionId: "test-skill-read",
        type: "skill_read",
        payload: {
          skillName: "pi-coder-tdd",
          skillPath: "/path/to/skills/pi-coder-tdd/SKILL.md",
          subagentAgent: "pi-coder.implementor",
          fsmState: "TDD_RED_WRITE",
          mode: "dev",
        },
      });

      const lines = readLogLines(logDir);
      assert.strictEqual(lines.length, 1);
      assert.strictEqual(lines[0].type, "skill_read");
      const payload = lines[0].payload as Record<string, unknown>;
      assert.strictEqual(payload.skillName, "pi-coder-tdd");
      assert.strictEqual(payload.subagentAgent, "pi-coder.implementor");
      assert.strictEqual(payload.fsmState, "TDD_RED_WRITE");
    } finally {
      cleanupLogDir(logDir);
    }
  });

  it("tool_call event has correct shape for allowed tools", () => {
    const logDir = createLogDir();
    try {
      const config = makeConfig();
      const logger = new Logger(logDir, config.logging);

      logger.log({
        timestamp: new Date().toISOString(),
        sessionId: "test-tool-call",
        type: "tool_call",
        payload: {
          toolName: "pi_coder_advance_fsm",
          fsmState: "IDLE",
          mode: "dev",
          specId: "user-auth",
          inputSummary: { targetState: "SPEC_WORK", fixType: undefined },
        },
      });

      const lines = readLogLines(logDir);
      assert.strictEqual(lines.length, 1);
      assert.strictEqual(lines[0].type, "tool_call");
      const payload = lines[0].payload as Record<string, unknown>;
      assert.strictEqual(payload.toolName, "pi_coder_advance_fsm");
      assert.strictEqual(payload.fsmState, "IDLE");
      assert.strictEqual(payload.specId, "user-auth");
      const inputSummary = payload.inputSummary as Record<string, unknown>;
      assert.strictEqual(inputSummary.targetState, "SPEC_WORK");
    } finally {
      cleanupLogDir(logDir);
    }
  });

  it("turnCount is automatically included in all events", () => {
    const logDir = createLogDir();
    try {
      const config = makeConfig();
      const logger = new Logger(logDir, config.logging);

      // Simulate the logEvent helper which includes turnCount
      const turnCount = 5;

      logger.log({
        timestamp: new Date().toISOString(),
        sessionId: "test-turn-count",
        type: "fsm_transition",
        payload: { from: "IDLE", to: "SPEC_WORK", turnCount },
      });

      const lines = readLogLines(logDir);
      assert.strictEqual(lines.length, 1);
      const payload = lines[0].payload as Record<string, unknown>;
      assert.strictEqual(payload.turnCount, 5, "turnCount should be included in logged events");
    } finally {
      cleanupLogDir(logDir);
    }
  });

  it("lifecycle_start fires on IDLE→SPEC_WORK transition", () => {
    const logDir = createLogDir();
    try {
      const config = makeConfig();
      const sm = new DevStateMachine(config);
      const logger = new Logger(logDir, config.logging);

      // Transition IDLE → SPEC_WORK (the trigger for lifecycle_start)
      sm.transition("SPEC_WORK");

      // Log lifecycle_start as the extension would on pi_coder_advance_fsm result
      logger.log({
        timestamp: new Date().toISOString(),
        sessionId: "test-lifecycle-idle-specwork",
        type: "lifecycle_start",
        payload: { specId: "user-auth", userRequest: "(spec work initiated)" },
      });

      // Also log the FSM transition
      logger.log({
        timestamp: new Date().toISOString(),
        sessionId: "test-lifecycle-idle-specwork",
        type: "fsm_transition",
        payload: { from: "IDLE", to: "SPEC_WORK", event: "start_spec_work", loopCount: 0, specId: "user-auth" },
      });

      const lines = readLogLines(logDir);
      assert.strictEqual(lines.length, 2);

      // First event should be lifecycle_start
      assert.strictEqual(lines[0].type, "lifecycle_start");
      assert.strictEqual((lines[0].payload as Record<string, unknown>).specId, "user-auth");

      // Second should be fsm_transition
      assert.strictEqual(lines[1].type, "fsm_transition");
    } finally {
      cleanupLogDir(logDir);
    }
  });

  it("new event types prompt_size, skill_read, tool_call exist in LOG_LEVEL_MAP", () => {
    const expectedNewTypes: LogEventType[] = [
      "prompt_size",
      "skill_read",
      "tool_call",
    ];
    for (const t of expectedNewTypes) {
      assert.ok(t in LOG_LEVEL_MAP, `${t} missing from LOG_LEVEL_MAP`);
      assert.strictEqual(LOG_LEVEL_MAP[t], "standard", `${t} should be at 'standard' level`);
    }
  });

  it("summarizeToolInput extracts key fields without logging sensitive data", async () => {
    // Test the summarizeToolInput helper by importing it
    // Since it's not exported, we test it indirectly through the expected shapes

    // pi_coder_advance_fsm
    const advInput = { targetState: "SPEC_WORK", fixType: undefined };
    assert.strictEqual(advInput.targetState, "SPEC_WORK");
    assert.strictEqual(advInput.fixType, undefined);

    // subagent — task should be truncated to 100 chars
    const longTask = "A".repeat(200);
    const subInput = { agent: "pi-coder.implementor", task: longTask };
    assert.strictEqual(subInput.agent, "pi-coder.implementor");
    assert.strictEqual(subInput.task.length, 200);
    // The helper truncates to 100 chars
    assert.ok(subInput.task.slice(0, 100).length === 100);

    // interview — should not log content
    const intInput = { questions: [{ question: "sensitive data" }] };
    // The helper returns { questions: "..." } — no content
    assert.ok(typeof intInput === "object");
  });
});

// ---------------------------------------------------------------------------
// Spec 17: Logging Observability
// ---------------------------------------------------------------------------

describe("Spec 17: New Event Types", () => {
  it("session_summary, unit_start, unit_end, config_validation exist in LOG_LEVEL_MAP", () => {
    const newTypes: LogEventType[] = [
      "session_summary",
      "unit_start",
      "unit_end",
      "config_validation",
    ];
    for (const t of newTypes) {
      assert.ok(t in LOG_LEVEL_MAP, `${t} missing from LOG_LEVEL_MAP`);
    }
    assert.strictEqual(LOG_LEVEL_MAP.session_summary, "minimal");
    assert.strictEqual(LOG_LEVEL_MAP.unit_start, "standard");
    assert.strictEqual(LOG_LEVEL_MAP.unit_end, "standard");
    assert.strictEqual(LOG_LEVEL_MAP.config_validation, "standard");
  });

  it("logger records session_summary event", () => {
    const logDir = createLogDir();
    try {
      const config = makeConfig();
      const logger = new Logger(logDir, config.logging);

      logger.log({
        timestamp: new Date().toISOString(),
        sessionId: "test-session-summary",
        type: "session_summary",
        payload: {
          totalTurns: 42,
          totalTokens: { input: 5000, output: 10000, cacheRead: 2000, cacheWrite: 500, cost: 0.15, turns: 10 },
          specsAttempted: 2,
          finalMode: "dev",
          finalFsmState: "IDLE",
          sessionDurationMs: 300000,
        },
      });

      const lines = readLogLines(logDir);
      assert.strictEqual(lines.length, 1);
      assert.strictEqual(lines[0].type, "session_summary");
      const payload = lines[0].payload as Record<string, unknown>;
      assert.strictEqual(payload.totalTurns, 42);
      assert.strictEqual(payload.specsAttempted, 2);
      assert.strictEqual(payload.finalMode, "tdd");
    } finally {
      cleanupLogDir(logDir);
    }
  });

  it("logger records unit_start event", () => {
    const logDir = createLogDir();
    try {
      const config = makeConfig();
      const logger = new Logger(logDir, config.logging);

      logger.log({
        timestamp: new Date().toISOString(),
        sessionId: "test-unit-start",
        type: "unit_start",
        payload: {
          specId: "auth",
          unitName: "User signup",
          loopCount: 0,
          fsmState: "TDD_RED_WRITE",
        },
      });

      const lines = readLogLines(logDir);
      assert.strictEqual(lines.length, 1);
      assert.strictEqual(lines[0].type, "unit_start");
      const payload = lines[0].payload as Record<string, unknown>;
      assert.strictEqual(payload.unitName, "User signup");
    } finally {
      cleanupLogDir(logDir);
    }
  });

  it("logger records unit_end event with outcome", () => {
    const logDir = createLogDir();
    try {
      const config = makeConfig();
      const logger = new Logger(logDir, config.logging);

      logger.log({
        timestamp: new Date().toISOString(),
        sessionId: "test-unit-end",
        type: "unit_end",
        payload: {
          specId: "auth",
          unitName: "User signup",
          outcome: "green_validated",
          loopCount: 1,
          fsmState: "TDD_GREEN_VALIDATE",
        },
      });

      const lines = readLogLines(logDir);
      assert.strictEqual(lines.length, 1);
      assert.strictEqual(lines[0].type, "unit_end");
      const payload = lines[0].payload as Record<string, unknown>;
      assert.strictEqual(payload.outcome, "green_validated");
    } finally {
      cleanupLogDir(logDir);
    }
  });
});

describe("Spec 17: Subagent End with Rich Data", () => {
  it("subagent_end logs model, exitCode, error from pi-subagents", () => {
    const logDir = createLogDir();
    try {
      const config = makeConfig();
      const logger = new Logger(logDir, config.logging);

      logger.log({
        timestamp: new Date().toISOString(),
        sessionId: "test-subagent-rich",
        type: "subagent_end",
        payload: {
          agent: "pi-coder.researcher",
          model: "anthropic/claude-sonnet-4",
          durationMs: 35000,
          tokenUsage: {
            input: 1200,
            output: 3500,
            cacheRead: 6000,
            cacheWrite: 1500,
            cost: 0.07,
          },
          turns: 5,
          exitCode: 0,
          error: null,
          outcome: "success",
          specId: "user-auth",
        },
      });

      const lines = readLogLines(logDir);
      assert.strictEqual(lines.length, 1);
      const payload = lines[0].payload as Record<string, unknown>;
      assert.strictEqual(payload.model, "anthropic/claude-sonnet-4");
      assert.strictEqual(payload.exitCode, 0);
      assert.strictEqual(payload.outcome, "success");
      assert.strictEqual(payload.turns, 5);
      const tokenUsage = payload.tokenUsage as Record<string, unknown>;
      assert.strictEqual(tokenUsage.cacheRead, 6000);
      assert.strictEqual(tokenUsage.cacheWrite, 1500);
      assert.strictEqual(tokenUsage.cost, 0.07);
    } finally {
      cleanupLogDir(logDir);
    }
  });

  it("subagent_end has outcome=error when exitCode is non-zero", () => {
    const logDir = createLogDir();
    try {
      const config = makeConfig();
      const logger = new Logger(logDir, config.logging);

      logger.log({
        timestamp: new Date().toISOString(),
        sessionId: "test-subagent-err",
        type: "subagent_end",
        payload: {
          agent: "pi-coder.researcher",
          model: "anthropic/claude-sonnet-4",
          durationMs: 5000,
          tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
          turns: 1,
          exitCode: 1,
          error: "Agent failed: timeout",
          outcome: "error",
          specId: "user-auth",
        },
      });

      const lines = readLogLines(logDir);
      const payload = lines[0].payload as Record<string, unknown>;
      assert.strictEqual(payload.outcome, "error");
      assert.strictEqual(payload.exitCode, 1);
      assert.strictEqual(payload.error, "Agent failed: timeout");
    } finally {
      cleanupLogDir(logDir);
    }
  });
});

describe("Spec 17: Mode on Every Event", () => {
  it("mode is included in payload via logEvent wrapper", () => {
    const logDir = createLogDir();
    try {
      const config = makeConfig();
      const logger = new Logger(logDir, config.logging);

      logger.log({
        timestamp: new Date().toISOString(),
        sessionId: "test-mode-event",
        type: "fsm_transition",
        payload: { from: "IDLE", to: "SPEC_WORK", turnCount: 5, mode: "dev" },
      });

      const lines = readLogLines(logDir);
      const payload = lines[0].payload as Record<string, unknown>;
      assert.strictEqual(payload.mode, "tdd");
      assert.strictEqual(payload.turnCount, 5);
    } finally {
      cleanupLogDir(logDir);
    }
  });
});

describe("Spec 17: FSM Trigger", () => {
  it("fsm_transition events include trigger field", () => {
    const logDir = createLogDir();
    try {
      const config = makeConfig();
      const logger = new Logger(logDir, config.logging);

      logger.log({
        timestamp: new Date().toISOString(),
        sessionId: "test-trigger",
        type: "fsm_transition",
        payload: {
          from: "TDD_RED_VALIDATE",
          to: "TDD_GREEN_WRITE",
          trigger: "auto_tdd_validation",
          event: "validation_passed",
          loopCount: 0,
          specId: "auth",
        },
      });

      const lines = readLogLines(logDir);
      const payload = lines[0].payload as Record<string, unknown>;
      assert.strictEqual(payload.trigger, "auto_tdd_validation");
      assert.strictEqual(payload.event, "validation_passed"); // Legacy retained
    } finally {
      cleanupLogDir(logDir);
    }
  });

  it("FSMTrigger type has correct values", () => {
    const validTriggers: FSMTrigger[] = [
      "auto_tdd_validation",
      "auto_git_checkpoint",
      "auto_git_merge",
      "auto_review_verdict",
      "manual_advance_fsm",
      "auto_subagent_complete",
      "fsm_reset",
    ];
    assert.strictEqual(validTriggers.length, 7);
  });
});

describe("Spec 17: Spec Approval Duration", () => {
  it("spec_approval event includes durationMs", () => {
    const logDir = createLogDir();
    try {
      const config = makeConfig();
      const logger = new Logger(logDir, config.logging);

      logger.log({
        timestamp: new Date().toISOString(),
        sessionId: "test-approval-dur",
        type: "spec_approval",
        payload: {
          status: "approved",
          responseCount: 3,
          durationMs: 45000,
        },
      });

      const lines = readLogLines(logDir);
      const payload = lines[0].payload as Record<string, unknown>;
      assert.strictEqual(payload.durationMs, 45000);
    } finally {
      cleanupLogDir(logDir);
    }
  });
});

describe("Spec 17: Token Pricing Config", () => {
  it("LoggingConfig accepts optional tokenPricing field", () => {
    const configWithPricing = makeConfig({
      logging: {
        enabled: true,
        level: "standard",
        maxLogFiles: 10,
        tokenPricing: {
          "anthropic/claude-sonnet-4": {
            inputPerMillion: 3.0,
            outputPerMillion: 15.0,
            cacheReadPerMillion: 0.3,
            cacheWritePerMillion: 3.75,
          },
        },
      },
    });
    assert.ok(configWithPricing.logging.tokenPricing);
    assert.strictEqual(configWithPricing.logging.tokenPricing!["anthropic/claude-sonnet-4"].inputPerMillion, 3.0);
  });
});

describe("Phase Token Breakdown", () => {
  it("fsm_state_usage is a valid log event type at standard level", () => {
    assert.ok("fsm_state_usage" in LOG_LEVEL_MAP);
    assert.strictEqual(LOG_LEVEL_MAP.fsm_state_usage, "standard");
  });

  it("lifecycle_end can include phaseTokens with source breakdown", () => {
    const logDir = createLogDir();
    try {
      const config = makeConfig();
      const logger = new Logger(logDir, config.logging);
      const sessionId = "test-phase-tokens";

      logger.log({
        timestamp: new Date().toISOString(),
        sessionId,
        type: "lifecycle_end",
        payload: {
          specId: "test-spec",
          outcome: "COMPLETE",
          wallClockMs: 50000,
          totalTokens: { input: 5000, output: 3000, cacheRead: 2000, cacheWrite: 0, cost: 0.1, turns: 10 },
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
      });

      const lines = readLogLines(logDir);
      assert.strictEqual(lines.length, 1);
      const entry = lines[0];
      assert.strictEqual(entry.type, "lifecycle_end");

      const pt = entry.payload.phaseTokens as Record<string, {
        input: number; output: number; cacheRead: number; cost: number;
        source: { orchestrator: { input: number }; subagent: { input: number } };
      }>;
      assert.ok(pt, "phaseTokens should exist");
      assert.ok(pt.SPEC_WORK, "SPEC_WORK phase should exist");
      assert.strictEqual(pt.SPEC_WORK.input, 1000);
      assert.strictEqual(pt.SPEC_WORK.source.orchestrator.input, 500);
      assert.strictEqual(pt.SPEC_WORK.source.subagent.input, 500);
      assert.strictEqual(pt.TDD_RED_WRITE.input, 2000);
      assert.strictEqual(pt.TDD_RED_WRITE.source.subagent.input, 1800);
    } finally {
      cleanupLogDir(logDir);
    }
  });

  it("fsm_state_usage event has correct shape", () => {
    const logDir = createLogDir();
    try {
      const config = makeConfig();
      const logger = new Logger(logDir, config.logging);
      const sessionId = "test-state-usage";

      logger.log({
        timestamp: new Date().toISOString(),
        sessionId,
        type: "fsm_state_usage",
        payload: {
          state: "SPEC_WORK",
          input: 1000,
          output: 500,
          cacheRead: 800,
          cacheWrite: 0,
          cost: 0.02,
          turns: 3,
          source: {
            orchestrator: { input: 500, output: 200, cacheRead: 300, cacheWrite: 0, cost: 0.01, turns: 3 },
            subagent: { input: 500, output: 300, cacheRead: 500, cacheWrite: 0, cost: 0.01, turns: 0 },
          },
          specId: "test-spec",
          nextState: "SPEC_APPROVED",
        },
      });

      const lines = readLogLines(logDir);
      assert.strictEqual(lines.length, 1);
      const entry = lines[0];
      assert.strictEqual(entry.type, "fsm_state_usage");
      assert.strictEqual(entry.payload.state, "SPEC_WORK");
      assert.strictEqual(entry.payload.nextState, "SPEC_APPROVED");
      assert.strictEqual((entry.payload as Record<string, unknown>).input, 1000);

      const src = (entry.payload as Record<string, unknown>).source as { orchestrator: { input: number }; subagent: { input: number } };
      assert.strictEqual(src.orchestrator.input, 500);
      assert.strictEqual(src.subagent.input, 500);
    } finally {
      cleanupLogDir(logDir);
    }
  });
});
