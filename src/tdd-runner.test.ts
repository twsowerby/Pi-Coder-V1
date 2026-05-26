/**
 * Tests for the TDD Runner module.
 *
 * Phase 1: Test execution (runTests with pi.exec mock)
 * Phase 2: Result parsing (vitest/jest output format extraction)
 * Phase 3: Phase validation (validateRedPhase / validateGreenPhase)
 */

import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import type { PiCoderConfig, TestRunResult } from "./types.ts";
import { TddRunner } from "./tdd-runner.ts";

// ---------------------------------------------------------------------------
// Helpers
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
      states: {},
    },
    logging: {
      enabled: false,
      level: "standard",
      maxLogFiles: 10,
    },
    ...overrides,
  };
}

/**
 * Create a mock exec function that returns predetermined results.
 */
function makeMockExec(
  results: Array<{
    stdout?: string;
    stderr?: string;
    code?: number;
    killed?: boolean;
  }>
) {
  let callIndex = 0;
  const calls: Array<{ command: string; args: string[] }> = [];
  const fn = mock.fn(
    async (_command: string, args: string[]) => {
      calls.push({ command: _command, args });
      const result = results[Math.min(callIndex, results.length - 1)];
      callIndex++;
      return {
        stdout: result?.stdout ?? "",
        stderr: result?.stderr ?? "",
        code: result?.code ?? 0,
        killed: result?.killed ?? false,
      };
    }
  );
  return { fn, calls };
}

// ---------------------------------------------------------------------------
// Phase 1: Test Execution
// ---------------------------------------------------------------------------

describe("TddRunner - Phase 1: Test Execution", () => {
  it("should execute the test command from config via pi.exec", async () => {
    const config = makeConfig({ testCommand: "npm test" });
    const { fn: execMock, calls } = makeMockExec([
      { stdout: "all tests passed", code: 0 },
    ]);

    const runner = new TddRunner(config, execMock as any);
    const result = await runner.runTests();

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].command, "npm");
    assert.deepStrictEqual(calls[0].args, ["test"]);
    assert.strictEqual(result.exitCode, 0);
  });

  it("should execute npx vitest run command correctly", async () => {
    const config = makeConfig({ testCommand: "npx vitest run" });
    const { fn: execMock, calls } = makeMockExec([
      { stdout: "Tests  5 passed", code: 0 },
    ]);

    const runner = new TddRunner(config, execMock as any);
    await runner.runTests();

    assert.strictEqual(calls[0].command, "npx");
    assert.deepStrictEqual(calls[0].args, ["vitest", "run"]);
  });

  it("should append filter to the command when provided", async () => {
    const config = makeConfig({ testCommand: "npm test" });
    const { fn: execMock, calls } = makeMockExec([
      { stdout: "ok", code: 0 },
    ]);

    const runner = new TddRunner(config, execMock as any);
    await runner.runTests("--grep auth");

    // "npm test --grep auth" → command: "npm", args: ["test", "--grep", "auth"]
    assert.strictEqual(calls[0].command, "npm");
    assert.deepStrictEqual(calls[0].args, ["test", "--grep", "auth"]);
  });

  it("should capture combined stdout and stderr in output", async () => {
    const config = makeConfig();
    const { fn: execMock } = makeMockExec([
      { stdout: "stdout content", stderr: "stderr content", code: 1 },
    ]);

    const runner = new TddRunner(config, execMock as any);
    const result = await runner.runTests();

    assert.ok(result.output.includes("stdout content"));
    assert.ok(result.output.includes("stderr content"));
  });

  it("should truncate output to 5000 characters preserving the tail", async () => {
    const config = makeConfig();
    const longOutput = "x".repeat(8000);
    const { fn: execMock } = makeMockExec([
      { stdout: longOutput, code: 0 },
    ]);

    const runner = new TddRunner(config, execMock as any);
    const result = await runner.runTests();

    assert.strictEqual(result.output.length, 5000);
    // The truncation marker should appear at the start
    assert.ok(result.output.startsWith("[truncated]"));
    // The tail should be preserved (last characters of the original)
    assert.ok(result.output.endsWith("xxx"));
  });

  it("should handle timeout by returning timedOut result", async () => {
    const config = makeConfig();
    const { fn: execMock } = makeMockExec([
      { killed: true, code: null, stdout: "", stderr: "" },
    ]);

    const runner = new TddRunner(config, execMock as any, 5000);
    const result = await runner.runTests();

    assert.strictEqual(result.timedOut, true);
    assert.strictEqual(result.exitCode, -1);
    assert.strictEqual(result.passed, null);
    assert.strictEqual(result.failed, null);
    assert.ok(result.output.includes("timed out"));
  });

  it("should return TestRunResult with correct structure", async () => {
    const config = makeConfig();
    const { fn: execMock } = makeMockExec([
      {
        stdout: "Tests  3 passed, 1 failed",
        code: 1,
      },
    ]);

    const runner = new TddRunner(config, execMock as any);
    const result = await runner.runTests();

    assert.strictEqual(result.exitCode, 1);
    assert.strictEqual(result.timedOut, false);
    assert.ok(typeof result.output === "string");
  });
});

// ---------------------------------------------------------------------------
// Phase 2: Result Parsing
// ---------------------------------------------------------------------------

describe("TddRunner - Phase 2: Result Parsing", () => {
  it("should parse vitest output format", async () => {
    const config = makeConfig();
    const { fn: execMock } = makeMockExec([
      {
        stdout: "Tests  8 passed, 2 failed",
        code: 1,
      },
    ]);

    const runner = new TddRunner(config, execMock as any);
    const result = await runner.runTests();

    assert.strictEqual(result.passed, 8);
    assert.strictEqual(result.failed, 2);
  });

  it("should parse vitest output with only passed tests", async () => {
    const config = makeConfig();
    const { fn: execMock } = makeMockExec([
      {
        stdout: "Tests  5 passed",
        code: 0,
      },
    ]);

    const runner = new TddRunner(config, execMock as any);
    const result = await runner.runTests();

    assert.strictEqual(result.passed, 5);
    assert.strictEqual(result.failed, 0);
  });

  it("should parse jest output format", async () => {
    const config = makeConfig();
    const { fn: execMock } = makeMockExec([
      {
        stdout: "Tests:  12 passed, 3 failed, 15 total",
        code: 1,
      },
    ]);

    const runner = new TddRunner(config, execMock as any);
    const result = await runner.runTests();

    assert.strictEqual(result.passed, 12);
    assert.strictEqual(result.failed, 3);
  });

  it("should parse jest output with only passed tests", async () => {
    const config = makeConfig();
    const { fn: execMock } = makeMockExec([
      {
        stdout: "Tests:  7 passed, 7 total",
        code: 0,
      },
    ]);

    const runner = new TddRunner(config, execMock as any);
    const result = await runner.runTests();

    assert.strictEqual(result.passed, 7);
    assert.strictEqual(result.failed, 0);
  });

  it("should return null counts when output cannot be parsed", async () => {
    const config = makeConfig();
    const { fn: execMock } = makeMockExec([
      {
        stdout: "Some custom runner output that doesn't match any pattern",
        code: 1,
      },
    ]);

    const runner = new TddRunner(config, execMock as any);
    const result = await runner.runTests();

    assert.strictEqual(result.passed, null);
    assert.strictEqual(result.failed, null);
  });

  it("should not throw on unparseable output — exit code is authoritative", async () => {
    const config = makeConfig();
    const { fn: execMock } = makeMockExec([
      {
        stdout: "GARBAGE OUTPUT 🎉",
        code: 1,
      },
    ]);

    const runner = new TddRunner(config, execMock as any);
    // Must not throw
    const result = await runner.runTests();

    assert.strictEqual(result.exitCode, 1);
    assert.strictEqual(result.passed, null);
    assert.strictEqual(result.failed, null);
  });
});

// ---------------------------------------------------------------------------
// Phase 3: Phase Validation
// ---------------------------------------------------------------------------

describe("TddRunner - Phase 3: Phase Validation", () => {
  describe("validateRedPhase", () => {
    it("should return valid when tests fail (exit code non-zero)", () => {
      const runner = new TddRunner(makeConfig());
      const result: TestRunResult = {
        exitCode: 1,
        output: "1 test failed",
        passed: 0,
        failed: 1,
        timedOut: false,
      };

      const validation = runner.validateRedPhase(result);
      assert.deepStrictEqual(validation, { valid: true });
    });

    it("should return invalid with RED_TAUTOLOGY when tests pass (exit code zero)", () => {
      const runner = new TddRunner(makeConfig());
      const result: TestRunResult = {
        exitCode: 0,
        output: "all tests passed",
        passed: 5,
        failed: 0,
        timedOut: false,
      };

      const validation = runner.validateRedPhase(result);
      assert.deepStrictEqual(validation, {
        valid: false,
        reason: "RED_TAUTOLOGY",
      });
    });

    it("should return valid when tests fail with exit code 2", () => {
      const runner = new TddRunner(makeConfig());
      const result: TestRunResult = {
        exitCode: 2,
        output: "test runner error",
        passed: null,
        failed: null,
        timedOut: false,
      };

      const validation = runner.validateRedPhase(result);
      assert.deepStrictEqual(validation, { valid: true });
    });

    it("should return valid when tests time out during RED phase", () => {
      const runner = new TddRunner(makeConfig());
      const result: TestRunResult = {
        exitCode: -1,
        output: "Test run timed out after 120000ms",
        passed: null,
        failed: null,
        timedOut: true,
      };

      const validation = runner.validateRedPhase(result);
      assert.deepStrictEqual(validation, { valid: true });
    });
  });

  describe("validateGreenPhase", () => {
    it("should return valid when tests pass (exit code zero)", () => {
      const runner = new TddRunner(makeConfig());
      const result: TestRunResult = {
        exitCode: 0,
        output: "all tests passed",
        passed: 5,
        failed: 0,
        timedOut: false,
      };

      const validation = runner.validateGreenPhase(result);
      assert.deepStrictEqual(validation, { valid: true });
    });

    it("should return invalid with GREEN_FAILED when tests fail (exit code non-zero)", () => {
      const runner = new TddRunner(makeConfig());
      const result: TestRunResult = {
        exitCode: 1,
        output: "1 test failed",
        passed: 4,
        failed: 1,
        timedOut: false,
      };

      const validation = runner.validateGreenPhase(result);
      assert.deepStrictEqual(validation, {
        valid: false,
        reason: "GREEN_FAILED",
      });
    });

    it("should return invalid with GREEN_FAILED when tests time out", () => {
      const runner = new TddRunner(makeConfig());
      const result: TestRunResult = {
        exitCode: -1,
        output: "Test run timed out after 120000ms",
        passed: null,
        failed: null,
        timedOut: true,
      };

      const validation = runner.validateGreenPhase(result);
      assert.deepStrictEqual(validation, {
        valid: false,
        reason: "GREEN_FAILED",
      });
    });
  });

  describe("validation methods are pure functions", () => {
    it("validateRedPhase should not modify the input result", () => {
      const runner = new TddRunner(makeConfig());
      const result: TestRunResult = {
        exitCode: 1,
        output: "1 test failed",
        passed: 0,
        failed: 1,
        timedOut: false,
      };
      const originalOutput = result.output;

      runner.validateRedPhase(result);

      assert.strictEqual(result.output, originalOutput);
      assert.strictEqual(result.exitCode, 1);
    });

    it("validateGreenPhase should not modify the input result", () => {
      const runner = new TddRunner(makeConfig());
      const result: TestRunResult = {
        exitCode: 0,
        output: "all passed",
        passed: 3,
        failed: 0,
        timedOut: false,
      };

      runner.validateGreenPhase(result);

      assert.strictEqual(result.exitCode, 0);
    });
  });
});
