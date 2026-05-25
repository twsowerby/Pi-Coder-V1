/**
 * Tests for Pi Coder Logger — Spec 14, Phase 1
 *
 * Tests the structured JSONL logging system:
 * - Logger creates directory and writes JSONL files
 * - No-op when disabled
 * - Log file rotation
 * - Valid JSON per line
 * - Level filtering
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { LoggingConfig } from "../src/types.ts";
import { Logger, type LogEvent, LOG_LEVEL_MAP } from "../src/logger.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeLoggingConfig(overrides?: Partial<LoggingConfig>): LoggingConfig {
  return {
    enabled: true,
    level: "standard",
    maxLogFiles: 10,
    ...overrides,
  };
}

function createLogDir(): string {
  const dir = join(tmpdir(), `pi-coder-log-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
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

function readLogLines(dir: string): string[] {
  const files = readdirSync(dir).filter(f => f.endsWith(".log")).sort();
  if (files.length === 0) return [];
  const content = readFileSync(join(dir, files[files.length - 1]), "utf-8");
  return content.trim().split("\n").filter(Boolean);
}

function makeEvent(type: string, payload: Record<string, unknown> = {}): LogEvent {
  return {
    timestamp: new Date().toISOString(),
    sessionId: "test-session-001",
    type,
    payload,
  };
}

// ---------------------------------------------------------------------------
// Phase 1: Logger Module
// ---------------------------------------------------------------------------

describe("Logger", () => {
  let logDir: string;

  beforeEach(() => {
    logDir = createLogDir();
  });

  // --- Core operations ---

  it("creates log directory on first write if missing", () => {
    const nestedDir = join(logDir, "logs");
    const logger = new Logger(nestedDir, makeLoggingConfig());
    logger.log(makeEvent("fsm_transition", { from: "IDLE", to: "SPEC_WORK" }));
    assert.ok(existsSync(nestedDir));
    cleanupLogDir(logDir);
  });

  it("writes JSONL entries to the log file", () => {
    const logger = new Logger(logDir, makeLoggingConfig());
    logger.log(makeEvent("fsm_transition", { from: "IDLE", to: "SPEC_WORK" }));
    logger.log(makeEvent("subagent_start", { agent: "pi-coder.researcher" }));

    const lines = readLogLines(logDir);
    assert.strictEqual(lines.length, 2);

    // Each line must parse as valid JSON
    const event1 = JSON.parse(lines[0]);
    assert.strictEqual(event1.type, "fsm_transition");
    assert.strictEqual(event1.sessionId, "test-session-001");
    assert.strictEqual(event1.payload.from, "IDLE");

    const event2 = JSON.parse(lines[1]);
    assert.strictEqual(event2.type, "subagent_start");
    assert.strictEqual(event2.payload.agent, "pi-coder.researcher");

    cleanupLogDir(logDir);
  });

  it("each log line is valid JSON with required fields", () => {
    const logger = new Logger(logDir, makeLoggingConfig());
    logger.log(makeEvent("lifecycle_start", { specId: "user-auth" }));

    const lines = readLogLines(logDir);
    assert.strictEqual(lines.length, 1);

    const event = JSON.parse(lines[0]);
    assert.ok(event.timestamp, "missing timestamp");
    assert.ok(event.sessionId, "missing sessionId");
    assert.ok(event.type, "missing type");
    assert.ok(event.payload, "missing payload");

    // Verify ISO 8601 timestamp format
    assert.ok(!isNaN(Date.parse(event.timestamp)), "timestamp is not valid ISO 8601");

    cleanupLogDir(logDir);
  });

  // --- No-op when disabled ---

  it("is a no-op when logging is disabled", () => {
    const logger = new Logger(logDir, makeLoggingConfig({ enabled: false }));
    logger.log(makeEvent("fsm_transition", { from: "IDLE", to: "SPEC_WORK" }));

    const files = readdirSync(logDir).filter(f => f.endsWith(".log"));
    assert.strictEqual(files.length, 0, "log file should not be created when disabled");

    cleanupLogDir(logDir);
  });

  // --- Log file naming ---

  it("names log files as pi-coder-YYYY-MM-DD.log", () => {
    const logger = new Logger(logDir, makeLoggingConfig());
    logger.log(makeEvent("fsm_transition"));

    const files = readdirSync(logDir).filter(f => f.endsWith(".log"));
    assert.strictEqual(files.length, 1);
    assert.ok(
      files[0].startsWith("pi-coder-"),
      `log file name should start with pi-coder-, got: ${files[0]}`,
    );
    assert.ok(
      /^\d{4}-\d{2}-\d{2}\.log$/.test(files[0].replace("pi-coder-", "")),
      `date portion should be YYYY-MM-DD, got: ${files[0]}`,
    );

    cleanupLogDir(logDir);
  });

  // --- File rotation ---

  it("rotates old log files when maxLogFiles is exceeded", () => {
    const config = makeLoggingConfig({ maxLogFiles: 3 });

    // Pre-create some old log files to simulate rotation
    for (let i = 1; i <= 4; i++) {
      const date = `2026-01-${String(i).padStart(2, "0")}`;
      writeFileSync(join(logDir, `pi-coder-${date}.log`), "old data\n", "utf-8");
    }

    const logger = new Logger(logDir, config);
    logger.log(makeEvent("fsm_transition"));

    // After rotation, there should be at most 3+1 files (maxLogFiles)
    // The oldest should have been deleted
    const files = readdirSync(logDir).filter(f => f.endsWith(".log")).sort();
    assert.ok(
      files.length <= 4, // maxLogFiles + 1 for the new one
      `too many files after rotation: ${files.length}`,
    );

    // The oldest file (pi-coder-2026-01-01.log) should be gone
    assert.ok(
      !files.includes("pi-coder-2026-01-01.log"),
      "oldest log file should have been rotated away",
    );

    cleanupLogDir(logDir);
  });

  it("does not rotate when file count is within maxLogFiles", () => {
    const config = makeLoggingConfig({ maxLogFiles: 10 });

    // Create 5 old files
    for (let i = 1; i <= 5; i++) {
      const date = `2026-01-${String(i).padStart(2, "0")}`;
      writeFileSync(join(logDir, `pi-coder-${date}.log`), "old data\n", "utf-8");
    }

    const logger = new Logger(logDir, config);
    logger.log(makeEvent("fsm_transition"));

    const files = readdirSync(logDir).filter(f => f.endsWith(".log")).sort();
    assert.strictEqual(files.length, 6); // 5 old + 1 new
    // All 5 old files still exist
    assert.ok(files.includes("pi-coder-2026-01-01.log"));

    cleanupLogDir(logDir);
  });

  // --- Log level filtering ---

  it("filters events based on log level — minimal excludes subagent and review events", () => {
    const config = makeLoggingConfig({ level: "minimal" });
    const logger = new Logger(logDir, config);

    // minimal: only lifecycle + TDD events
    logger.log(makeEvent("lifecycle_start")); // allowed (lifecycle)
    logger.log(makeEvent("fsm_transition")); // allowed (lifecycle)
    logger.log(makeEvent("tdd_red_validate")); // allowed (TDD)
    logger.log(makeEvent("subagent_start")); // blocked (standard+)
    logger.log(makeEvent("review_result")); // blocked (standard+)
    logger.log(makeEvent("nudge_fired")); // blocked (verbose)

    const lines = readLogLines(logDir);
    assert.strictEqual(lines.length, 3, "minimal level should only have lifecycle + TDD events");

    const types = lines.map(l => JSON.parse(l).type);
    assert.ok(types.includes("lifecycle_start"));
    assert.ok(types.includes("fsm_transition"));
    assert.ok(types.includes("tdd_red_validate"));

    cleanupLogDir(logDir);
  });

  it("filters events based on log level — standard excludes nudge events", () => {
    const config = makeLoggingConfig({ level: "standard" });
    const logger = new Logger(logDir, config);

    // standard: lifecycle + TDD + subagent + review + user + command
    logger.log(makeEvent("lifecycle_start")); // allowed
    logger.log(makeEvent("fsm_transition")); // allowed
    logger.log(makeEvent("tdd_red_validate")); // allowed
    logger.log(makeEvent("subagent_start")); // allowed
    logger.log(makeEvent("subagent_end")); // allowed
    logger.log(makeEvent("review_result")); // allowed
    logger.log(makeEvent("command")); // allowed
    logger.log(makeEvent("user_intervention")); // allowed
    logger.log(makeEvent("circuit_breaker")); // allowed (TDD)
    logger.log(makeEvent("nudge_fired")); // blocked (verbose)
    logger.log(makeEvent("nudge_escalation")); // blocked (verbose)

    const lines = readLogLines(logDir);
    assert.strictEqual(lines.length, 9, "standard level should exclude nudge events");

    const types = lines.map(l => JSON.parse(l).type);
    assert.ok(!types.includes("nudge_fired"));
    assert.ok(!types.includes("nudge_escalation"));

    cleanupLogDir(logDir);
  });

  it("verbose level logs all events", () => {
    const config = makeLoggingConfig({ level: "verbose" });
    const logger = new Logger(logDir, config);

    logger.log(makeEvent("lifecycle_start"));
    logger.log(makeEvent("fsm_transition"));
    logger.log(makeEvent("tdd_red_validate"));
    logger.log(makeEvent("subagent_start"));
    logger.log(makeEvent("nudge_fired"));
    logger.log(makeEvent("nudge_escalation"));

    const lines = readLogLines(logDir);
    assert.strictEqual(lines.length, 6, "verbose level should log all events");

    cleanupLogDir(logDir);
  });

  // --- Log level map ---

  it("LOG_LEVEL_MAP categorizes all event types correctly", () => {
    // Minimal events (lifecycle + TDD)
    const minimalEvents = ["lifecycle_start", "lifecycle_end", "fsm_transition", "tdd_red_validate", "tdd_green_validate", "circuit_breaker"];
    for (const t of minimalEvents) {
      assert.strictEqual(LOG_LEVEL_MAP[t], "minimal", `${t} should be minimal`);
    }

    // Standard events (subagent, review, user, command)
    const standardEvents = ["subagent_start", "subagent_end", "review_result", "command", "user_intervention"];
    for (const t of standardEvents) {
      assert.strictEqual(LOG_LEVEL_MAP[t], "standard", `${t} should be standard`);
    }

    // Verbose events (nudge)
    const verboseEvents = ["nudge_fired", "nudge_escalation"];
    for (const t of verboseEvents) {
      assert.strictEqual(LOG_LEVEL_MAP[t], "verbose", `${t} should be verbose`);
    }
  });

  // --- Multiple writes to same file ---

  it("appends to the same log file within a single day", () => {
    const logger = new Logger(logDir, makeLoggingConfig());
    logger.log(makeEvent("lifecycle_start"));
    logger.log(makeEvent("fsm_transition"));
    logger.log(makeEvent("subagent_start"));

    const files = readdirSync(logDir).filter(f => f.endsWith(".log"));
    assert.strictEqual(files.length, 1, "should only have one log file for the same day");

    const lines = readLogLines(logDir);
    assert.strictEqual(lines.length, 3);

    cleanupLogDir(logDir);
  });
});
