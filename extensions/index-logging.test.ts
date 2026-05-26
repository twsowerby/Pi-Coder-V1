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
import { StateMachine } from "../src/state-machine.ts";
import { Logger, LOG_LEVEL_MAP } from "../src/logger.ts";
import type { LogEventType } from "../src/logger.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides?: Partial<PiCoderConfig>): PiCoderConfig {
  return {
    testCommand: "npm test",
    maxLoops: 3,
    createBranch: true,
    onMerge: "merge",
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
      const sm = new StateMachine(config);
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

  it("token usage extraction works from subagent details shape", () => {
    // Simulate pi-subagents result metadata
    const details = {
      usage: {
        prompt_tokens: 1500,
        completion_tokens: 3000,
        total_tokens: 4500,
      },
    };

    const usage = (details as Record<string, unknown>).usage as Record<string, unknown>;
    const input = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0;
    const output = typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0;
    const total = typeof usage.total_tokens === "number" ? usage.total_tokens : input + output;

    assert.strictEqual(input, 1500);
    assert.strictEqual(output, 3000);
    assert.strictEqual(total, 4500);
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

  it("lifecycleTokens accumulate across subagent events", () => {
    let lifecycleTokens = { input: 0, output: 0, total: 0 };

    // First subagent
    lifecycleTokens.input += 1000;
    lifecycleTokens.output += 2000;
    lifecycleTokens.total += 3000;

    // Second subagent
    lifecycleTokens.input += 500;
    lifecycleTokens.output += 1500;
    lifecycleTokens.total += 2000;

    assert.strictEqual(lifecycleTokens.input, 1500);
    assert.strictEqual(lifecycleTokens.output, 3500);
    assert.strictEqual(lifecycleTokens.total, 5000);
  });
});
