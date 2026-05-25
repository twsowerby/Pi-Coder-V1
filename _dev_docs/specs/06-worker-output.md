# Spec 06: TDD Runner — Worker Output

## Status: ✅ COMPLETE

All 3 phases implemented and verified. 22 tests, 0 failures.

---

## Phase 1: Test Execution ✅

### Implementation (`src/tdd-runner.ts`)

- `TddRunner` class with constructor accepting `(config, execFn, timeout?)` where `execFn` is the `pi.exec` function captured from extension context
- `runTests(filter?)` parses `config.testCommand` into command + args array, appends filter if provided, executes via `execFn` with configurable timeout
- Timeout handling: when `result.killed === true`, returns `{ exitCode: -1, timedOut: true, output: "Test run timed out after {timeout}ms", passed: null, failed: null }`
- Output handling: combines stdout + stderr, truncates to 5000 chars preserving tail with `[truncated]\n` prefix
- Error handling: catches exec exceptions and returns structured failure result

### Tests (7)
- Executes `npm test` → command "npm", args ["test"]
- Executes `npx vitest run` → command "npx", args ["vitest", "run"]
- Appends filter → `npm test --grep auth` → args ["test", "--grep", "auth"]
- Captures combined stdout + stderr
- Truncates long output to 5000 chars with tail preservation
- Returns timedOut result when process is killed
- Returns correct TestRunResult structure

---

## Phase 2: Result Parsing ✅

### Implementation

- `parseTestCounts(output)` private method with regex patterns for:
  - Vitest: `"Tests  X passed, Y failed"` or `"Tests  X passed"`
  - Jest: `"Tests:  X passed, Y failed, Z total"` or `"Tests:  X passed, Z total"`
- Graceful fallback: if no pattern matches, returns `{ passed: null, failed: null }` — never throws
- Exit code remains the authoritative result regardless of parse success

### Tests (6)
- Vitest format with failures: "Tests  8 passed, 2 failed" → { passed: 8, failed: 2 }
- Vitest format passed only: "Tests  5 passed" → { passed: 5, failed: 0 }
- Jest format with failures: "Tests:  12 passed, 3 failed, 15 total" → { passed: 12, failed: 3 }
- Jest format passed only: "Tests:  7 passed, 7 total" → { passed: 7, failed: 0 }
- Unparseable output → { passed: null, failed: null }
- Unparseable output does not throw, exit code is authoritative

---

## Phase 3: Phase Validation ✅

### Implementation

- `validateRedPhase(result)`: exit code ≠ 0 → `{ valid: true }`; exit code = 0 → `{ valid: false, reason: "RED_TAUTOLOGY" }`
- `validateGreenPhase(result)`: exit code = 0 → `{ valid: true }`; exit code ≠ 0 → `{ valid: false, reason: "GREEN_FAILED" }`
- Both methods are pure functions of `TestRunResult` — no FSM access, no mutations

### Tests (9)
- validateRedPhase: valid on failure (exit code 1), valid on exit code 2, valid on timeout (exit code -1)
- validateRedPhase: invalid with RED_TAUTOLOGY on pass (exit code 0)
- validateGreenPhase: valid on pass (exit code 0)
- validateGreenPhase: invalid with GREEN_FAILED on failure (exit code 1), invalid on timeout (exit code -1)
- Purity: neither method modifies the input result

---

## Files Changed

- `src/tdd-runner.ts` — new file (~180 LOC)
- `src/tdd-runner.test.ts` — new file (~280 LOC)

## Verification

- `npx tsc --noEmit` — ✅ zero errors
- `node --test src/tdd-runner.test.ts` — ✅ 22 tests, 0 failures
