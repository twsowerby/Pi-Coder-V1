# Spec 06: TDD Runner

## Context

The TDD runner executes the project's test suite and validates whether the results match the expectations of the current TDD phase. In RED phase, tests must fail. In GREEN phase, tests must pass. This is the only way the orchestrator validates TDD compliance — it cannot run tests directly.

## Dependencies

Spec 01 (type definitions — TestRunResult, PiCoderConfig)

---

## Phase 1: Test Execution

### Acceptance Criteria

- The test command from config is executed via `pi.exec()`, never via bash
- Test filter arguments are appended to the command
- Timeouts kill the process and return a structured result
- Output is captured but truncated to prevent context blowup

### Tasks

1. Implement `runTests(filter?)` that reads `config.testCommand`, appends the filter if provided, and executes via `pi.exec()` with a configurable timeout (default: 120 seconds)
2. If the process exceeds the timeout, kill it and return a result with `timedOut: true`, exitCode: -1, and the timeout message as output
3. Capture combined stdout+stderr, truncate to 5000 characters if longer (preserving the tail — the summary is usually at the end)
4. Return `TestRunResult` with exitCode, truncated output, and timedOut flag

---

## Phase 2: Result Parsing

### Acceptance Criteria

- Pass/fail counts are extracted when the output matches known test runner formats
- If parsing fails, counts are null — the system degrades gracefully rather than throwing
- At minimum, vitest and jest output formats are supported

### Tasks

1. Attempt to extract `passed` and `failed` counts from the output using regex patterns for common test runners (vitest: "Tests  X passed, Y failed", jest: "Tests:  X passed, Y failed, Z total")
2. If no pattern matches, set both counts to null — never throw on parse failure, the exit code is the authoritative result
3. Return the parsed counts (or nulls) as part of the `TestRunResult`

---

## Phase 3: Phase Validation

### Acceptance Criteria

- RED phase validation correctly identifies test failure as valid and test pass as invalid
- GREEN phase validation correctly identifies test pass as valid and test failure as invalid
- The reason field distinguishes between the two anomaly types (tautological tests vs. failing implementation)

### Tasks

1. Implement `validateRedPhase(result)` — returns `{ valid: true }` when exit code is non-zero (tests fail as expected), returns `{ valid: false, reason: "RED_TAUTOLOGY" }` when exit code is zero (tests pass unexpectedly)
2. Implement `validateGreenPhase(result)` — returns `{ valid: true }` when exit code is zero (tests pass as expected), returns `{ valid: false, reason: "GREEN_FAILED" }` when exit code is non-zero (tests still fail)
3. Ensure validation methods are pure functions of the `TestRunResult` — they do not inspect or modify FSM state
