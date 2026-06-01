/**
 * TDD Runner — executes the project test suite and validates RED/GREEN phase compliance.
 *
 * Phase 1: Test execution via pi.exec with timeout, filter support, output truncation
 * Phase 2: Result parsing for vitest and jest output formats
 * Phase 3: Phase validation (RED must fail, GREEN must pass)
 */

import type { PiCoderConfig, TestFailure, TestRunResult } from "./types.ts";

/** Maximum output length in characters — prevents context blowup */
const MAX_OUTPUT_LENGTH = 5000;

/** Default timeout in milliseconds */
const DEFAULT_TIMEOUT = 120_000;

/**
 * Result of a pi.exec() call.
 * Matches the shape returned by the pi extension API.
 */
interface ExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
  killed: boolean;
}

/**
 * Validation result for RED/GREEN phase checks.
 */
interface PhaseValidationResult {
  valid: boolean;
  reason?: string;
}

/**
 * TddRunner executes test commands and validates whether the results
 * match the expectations of the current TDD phase.
 *
 * - In RED phase: tests MUST fail (otherwise they're tautological)
 * - In GREEN phase: tests MUST pass (otherwise implementation is incomplete)
 */
export class TddRunner {
  private readonly config: PiCoderConfig;
  private readonly execFn: (command: string, args: string[], options?: { signal?: AbortSignal; timeout?: number }) => Promise<ExecResult>;
  private readonly timeout: number;

  /**
   * @param config Project configuration (testCommand, etc.)
   * @param execFn The pi.exec function captured from the extension context
   * @param timeout Test execution timeout in milliseconds (default: 120000)
   */
  constructor(
    config: PiCoderConfig,
    execFn: (command: string, args: string[], options?: { signal?: AbortSignal; timeout?: number }) => Promise<ExecResult>,
    timeout: number = DEFAULT_TIMEOUT
  ) {
    this.config = config;
    this.execFn = execFn;
    this.timeout = timeout;
  }

  /**
   * Execute the project test suite.
   *
   * @param filter Optional test filter appended to the command (e.g., "--grep auth")
   * @returns Structured test run result
   */
  async runTests(filter?: string): Promise<TestRunResult> {
    const { command, args } = this.buildCommand(filter);

    try {
      const result = await this.execFn(command, args, { timeout: this.timeout });

      if (result.killed) {
        return {
          exitCode: -1,
          output: `Test run timed out after ${this.timeout}ms`,
          passed: null,
          failed: null,
          timedOut: true,
        };
      }

      const combinedOutput = this.combineOutput(result.stdout, result.stderr);
      const truncatedOutput = this.truncateOutput(combinedOutput);
      const { passed, failed } = this.parseTestCounts(truncatedOutput);

      return {
        exitCode: result.code ?? -1,
        output: truncatedOutput,
        passed,
        failed,
        timedOut: false,
      };
    } catch (error) {
      // If exec throws (e.g., command not found), treat as failure
      const message = error instanceof Error ? error.message : String(error);
      return {
        exitCode: -1,
        output: message,
        passed: null,
        failed: null,
        timedOut: false,
      };
    }
  }

  /**
   * Validate RED phase result — tests MUST fail.
   *
   * @param result The test run result to validate
   * @returns valid:true if tests failed (expected), valid:false with RED_TAUTOLOGY if tests passed
   */
  validateRedPhase(result: TestRunResult): PhaseValidationResult {
    if (result.exitCode !== 0) {
      return { valid: true };
    }
    return { valid: false, reason: "RED_TAUTOLOGY" };
  }

  /**
   * Validate GREEN phase result — tests MUST pass.
   *
   * @param result The test run result to validate
   * @returns valid:true if tests passed (expected), valid:false with GREEN_FAILED if tests failed
   */
  validateGreenPhase(result: TestRunResult): PhaseValidationResult {
    if (result.exitCode === 0) {
      return { valid: true };
    }
    return { valid: false, reason: "GREEN_FAILED" };
  }

  /**
   * Parse structured test failures from test output.
   *
   * Best-effort extraction for vitest and jest formats.
   * Returns empty array if no structured failures found
   * (raw output is still the source of truth).
   * Never throws — returns [] on any parsing failure.
   */
  parseFailures(output: string): TestFailure[] {
    try {
      const failures: TestFailure[] = [];

      // Vitest format: FAIL src/file.test.ts > test name
      const vitestFailRegex = /FAIL\s+(\S+\.test\.\S+)\s*>\s*(.+?)(?:\n|$)/g;
      let m: RegExpExecArray | null;
      while ((m = vitestFailRegex.exec(output)) !== null) {
        const testFile = m[1];
        const testName = m[2].trim();
        // Extract error context from the block after this FAIL line (up to 500 chars)
        const afterMatch = output.slice(m.index + m[0].length);
        const nextFail = afterMatch.search(/FAIL\s+\S+\.test\./);
        const contextEnd = nextFail > 0 ? nextFail : Math.min(afterMatch.length, 500);
        const block = afterMatch.slice(0, contextEnd);
        const errorMatch = block.match(/(?:AssertionError|Error)[\s:]*(.+?)(?:\n|$)/);
        // Look for vitest-style diff: - Expected / + Received
        const diffMatch = block.match(/-\s*Expected[\s\S]*?\+\s*Received[\s\S]*?(?=\n\n|\n[A-Z]|$)/);
        failures.push({
          testFile,
          testName,
          errorMessage: errorMatch?.[1]?.trim() ?? "Test failed",
          assertionDiff: diffMatch ? diffMatch[0].trim().slice(0, 500) : undefined,
        });
      }

      // If no vitest FAIL patterns found, try generic: lines starting with ✕ or ✗
      if (failures.length === 0) {
        const genericFailRegex = /[✕✗]\s+(.+?)(?:\s+\(\d+\s*ms\)|\s*$)/gm;
        while ((m = genericFailRegex.exec(output)) !== null) {
          failures.push({ testName: m[1].trim(), errorMessage: "Test failed" });
        }
      }

      return failures;
    } catch {
      // Best-effort — never throw
      return [];
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Parse the testCommand string into command + args array,
   * appending the filter if provided.
   */
  private buildCommand(filter?: string): { command: string; args: string[] } {
    const fullCommand = filter
      ? `${this.config.testCommand} ${filter}`
      : this.config.testCommand;

    const parts = fullCommand.split(/\s+/).filter(Boolean);
    return {
      command: parts[0],
      args: parts.slice(1),
    };
  }

  /**
   * Combine stdout and stderr into a single string.
   */
  private combineOutput(stdout: string, stderr: string): string {
    if (!stdout && !stderr) return "";
    if (!stdout) return stderr;
    if (!stderr) return stdout;
    return `${stdout}\n${stderr}`;
  }

  /**
   * Smart truncation that preserves failure-relevant lines and the tail summary.
   *
   * If output is under MAX_OUTPUT_LENGTH, returns as-is.
   * If over, identifies important lines (FAIL, Error, AssertionError, Expected,
   * Received, stack-frame headers) and preserves them plus the tail (summary)
   * and head (initial context). Truncates the MIDDLE (passing test details,
   * verbose stack traces).
   *
   * Falls back to simple tail truncation if the smart approach still
   * exceeds MAX_OUTPUT_LENGTH after combining.
   */
  private truncateOutput(output: string): string {
    if (output.length <= MAX_OUTPUT_LENGTH) {
      return output;
    }

    // Split into lines for analysis
    const lines = output.split("\n");

    // Identify failure-relevant lines (FAIL, Error, AssertionError, Expected, Received, etc.)
    const failureIndicators = /^(FAIL|Error|AssertionError|Expected|Received|●|✕|✗|\s+at\s)/i;

    // Collect important line indices
    const importantLineIndices = new Set<number>();
    for (let i = 0; i < lines.length; i++) {
      if (failureIndicators.test(lines[i])) {
        // Include this line and 3 lines of context after it
        for (let j = i; j < Math.min(i + 4, lines.length); j++) {
          importantLineIndices.add(j);
        }
      }
    }

    // Always include the first 5 lines (test file name, initial context)
    for (let i = 0; i < Math.min(5, lines.length); i++) {
      importantLineIndices.add(i);
    }

    // Always include the last 15 lines (summary)
    for (let i = Math.max(0, lines.length - 15); i < lines.length; i++) {
      importantLineIndices.add(i);
    }

    // Build output from important lines, with truncation markers for gaps
    const result: string[] = [];
    let lastIncluded = -1;
    for (const idx of [...importantLineIndices].sort((a, b) => a - b)) {
      if (lastIncluded >= 0 && idx > lastIncluded + 1) {
        result.push("..."); // Gap marker
      }
      result.push(lines[idx]);
      lastIncluded = idx;
    }

    // Final size check — if still too long, fall back to tail truncation
    const combined = result.join("\n");
    if (combined.length > MAX_OUTPUT_LENGTH) {
      const tail = combined.slice(combined.length - MAX_OUTPUT_LENGTH + "[truncated]\n".length);
      return `[truncated]\n${tail}`;
    }

    return combined;
  }

  /**
   * Parse passed/failed test counts from common test runner output formats.
   *
   * Supported formats:
   * - Vitest: "Tests  X passed, Y failed" or "Tests  X passed"
   * - Jest:   "Tests:  X passed, Y failed, Z total" or "Tests:  X passed, Z total"
   * - Node test runner: "ℹ pass X\nℹ fail Y"
   * - Playwright: "X passed (Y failed, Z flaky)" or "X passed"
   * - Generic: "X passing, Y failing"
   * - Generic: "X passed, Y failed"
   *
   * Returns null for both counts if no known pattern matches.
   * Never throws — exit code is the authoritative result.
   */
  private parseTestCounts(output: string): { passed: number | null; failed: number | null } {
    // Try vitest format: "Tests  X passed, Y failed" or "Tests  X passed"
    const vitestWithFailures = output.match(/Tests\s+(\d+)\s+passed,\s+(\d+)\s+failed/);
    if (vitestWithFailures) {
      return {
        passed: parseInt(vitestWithFailures[1], 10),
        failed: parseInt(vitestWithFailures[2], 10),
      };
    }

    const vitestPassedOnly = output.match(/Tests\s+(\d+)\s+passed/);
    if (vitestPassedOnly) {
      return {
        passed: parseInt(vitestPassedOnly[1], 10),
        failed: 0,
      };
    }

    // Try jest format: "Tests:  X passed, Y failed, Z total" or "Tests:  X passed, Z total"
    const jestWithFailures = output.match(/Tests:\s+(\d+)\s+passed,\s+(\d+)\s+failed/);
    if (jestWithFailures) {
      return {
        passed: parseInt(jestWithFailures[1], 10),
        failed: parseInt(jestWithFailures[2], 10),
      };
    }

    const jestPassedOnly = output.match(/Tests:\s+(\d+)\s+passed/);
    if (jestPassedOnly) {
      return {
        passed: parseInt(jestPassedOnly[1], 10),
        failed: 0,
      };
    }

    // Try Node built-in test runner format: "ℹ pass X\n...\nℹ fail Y"
    const nodePass = output.match(/ℹ\s+pass\s+(\d+)/);
    const nodeFail = output.match(/ℹ\s+fail\s+(\d+)/);
    if (nodePass) {
      return {
        passed: parseInt(nodePass[1], 10),
        failed: nodeFail ? parseInt(nodeFail[1], 10) : 0,
      };
    }

    // Try Playwright format: "X passed (Y failed, Z flaky)" or "X passed"
    const pwWithFailures = output.match(/(\d+)\s+passed\s+\((\d+)\s+failed/);
    if (pwWithFailures) {
      return {
        passed: parseInt(pwWithFailures[1], 10),
        failed: parseInt(pwWithFailures[2], 10),
      };
    }

    const pwPassedOnly = output.match(/(\d+)\s+passed/);
    if (pwPassedOnly) {
      return {
        passed: parseInt(pwPassedOnly[1], 10),
        failed: 0,
      };
    }

    // Try generic format: "X passing, Y failing" or "X passed, Y failed"
    const genericWithFailures = output.match(/(\d+)\s+pass(?:ed|ing),?\s+(\d+)\s+fail(?:ed|ing)/);
    if (genericWithFailures) {
      return {
        passed: parseInt(genericWithFailures[1], 10),
        failed: parseInt(genericWithFailures[2], 10),
      };
    }

    const genericPassedOnly = output.match(/(\d+)\s+pass(?:ed|ing)/);
    if (genericPassedOnly) {
      return {
        passed: parseInt(genericPassedOnly[1], 10),
        failed: 0,
      };
    }

    // No known pattern matched — degrade gracefully
    return { passed: null, failed: null };
  }
}
