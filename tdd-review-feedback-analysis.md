# TDD Runner, Review Extraction & Test Feedback Quality — Deep Analysis

## 1. How the TDD Runner Works

### Architecture
The `TddRunner` class (`src/tdd-runner.ts`) is a thin wrapper around `pi.exec()`:

1. **Command building** (`buildCommand`, lines 118–131): Splits `config.testCommand` into command + args array, optionally appending a `--grep`-style filter.

2. **Test execution** (`runTests`, lines 66–104): Calls `execFn(command, args, { timeout })`, then:
   - Detects timeout (`result.killed → timedOut: true`)
   - Combines stdout + stderr
   - Truncates to 5000 chars (tail-preserved: `[truncated]\n<last 4990 chars>`)
   - Parses test counts via regex

3. **Result shape** (`TestRunResult`, `types.ts:278–290`):
   ```ts
   interface TestRunResult {
     exitCode: number;        // 0 = all passed
     output: string;          // combined stdout+stderr, truncated to 5000 chars
     passed: number | null;   // parsed count, null if no pattern matches
     failed: number | null;   // parsed count, null if no pattern matches
     timedOut: boolean;       // true if killed by timeout
   }
   ```

### What the Agent Sees on Test Failure

The `pi_coder_run_tests` tool (`tools.ts:319–468`) constructs the response text differently based on context:

**In TDD validation states (TDD_RED_VALIDATE / TDD_GREEN_VALIDATE):**
- Only shows validation outcome, e.g. `RED validation: FAILED — RED_TAUTOLOGY` or `GREEN validation: PASSED`
- **Critical gap: The raw test output is NOT included in the text response** when validation is present (lines 434–440). The `if (r.validation)` branch prints only the validation result — no output block.

**In non-validation states or Light mode:**
- Shows parsed counts: `Tests failed: 5 passed, 3 failed (exit code 1)`
- Always includes the full truncated test output in a code block (lines 451–456)
- Falls back to `Tests failed (exit code X)` if counts couldn't be parsed

**The `details` object** (not visible to the LLM, consumed by the auto-transition handler) always includes the full `testResult` including `output`.

### Key Observation: Output Loss in TDD Validation
When tests fail during GREEN validation, the tool-result handler auto-transitions to `TDD_GREEN_WRITE` with a generic steer: `"⚠️ AUTO-TRANSITION: Tests still failing. You are now in TDD_GREEN_WRITE. Delegate to pi-coder.implementor again with clearer instructions."` — **but the raw test output IS present in the original `content` text** from the tool itself (the validation branch still returns output via the details, and the steer is appended). However, the RED phase validation response text does NOT include the test runner output — just `RED validation: FAILED — RED_TAUTOLOGY`. The agent has no visibility into which tests unexpectedly passed.

---

## 2. Information the Agent Receives on Test Failure

### What IS available:
| Info | In Tool Text (LLM-visible) | In Details (machine-only) |
|------|:---:|:---:|
| Pass/fail counts | ✅ (non-validation) | ✅ |
| Exit code | ✅ | ✅ |
| Raw test output (truncated to 5KB) | ✅ (non-validation only) | ✅ |
| Timeout flag | ✅ | ✅ |
| Validation result (RED_TAUTOLOGY / GREEN_FAILED) | ✅ | ✅ |
| Phase (RED/GREEN) | ✅ | ✅ |

### What is NOT available:
- **DOM state** / component tree — No mechanism exists to capture browser/DOM state. The runner only shells out to `pi.exec()` which returns stdout/stderr.
- **Structured error objects** — Error info is only available as regex'd text within the truncated output.
- **Stack traces** — Included only if they survive the 5KB tail truncation.
- **Test file names of failing tests** — Not extracted structurally; only visible if present in the truncated output.
- **Watch / filesystem state** — No before/after file diffing.
- **Specific assertion failures** — Not parsed; only available as raw text in the output.

### Truncation Risk
The 5KB tail-truncation (`MAX_OUTPUT_LENGTH = 5000`) is a real risk. Large test suites with verbose output may lose:
- The test file paths and names (often at the top of output)
- Assertion diff details
- Stack traces (which tend to be long)

The system preserves the *tail* (test summary counts), but the *head* (which tests failed, filenames, assertion details) is more useful for the agent to fix errors.

---

## 3. RED_TAUTOLOGY Detection

### Exact Mechanism
In `TddRunner.validateRedPhase()` (lines 107–113):

```ts
validateRedPhase(result: TestRunResult): PhaseValidationResult {
  if (result.exitCode !== 0) {
    return { valid: true };  // Tests failed → RED phase is valid
  }
  return { valid: false, reason: "RED_TAUTOLOGY" };  // Tests passed → tautological
}
```

The detection is purely exit-code-based: **if `exitCode === 0`, the tests passed during RED phase → RED_TAUTOLOGY**. There is no:
- Inspection of whether new test files were actually created
- Check for specific test names or assertions
- Diffing of test output to confirm the new tests are the ones that passed
- Verification that production code wasn't accidentally modified during RED

### What Happens After RED_TAUTOLOGY
The tool-result handler (`handlers/tool-result.ts:193–206`) appends a detailed steer offering three options:
1. **Re-delegate** with strict "tests only" instructions (correct TDD path)
2. **Classify as `approach: direct`** (for non-behavioral units)
3. **Acknowledge and proceed** (only if tests genuinely test new behavior but the feature was partially implemented)

The FSM DOES NOT auto-transition on RED_TAUTOLOGY — it stays in `TDD_RED_VALIDATE`, giving the orchestrator a chance to choose the correct path. This is appropriate since a tautology is a genuine error condition requiring judgment.

### False Positive Risk
If the test runner exits with 0 but some tests failed (unlikely but possible with vitest `--passWithNoTests` or force exit), the validator would incorrectly classify it as RED_TAUTOLOGY. The exit code is treated as the single source of truth.

---

## 4. Review Extraction System

### Three-Tier Verdict Extraction (`extractReviewVerdict`, `review-extraction.ts:181–317`)

**Tier 0 — Structured `---VERDICT---` block** (highest priority):
```regex
/---VERDICT---\s*\n\s*VERDICT:\s*(approved|needs_changes)\s*\n
(?:\s*FIX_TYPE:\s*(functional|non-functional|non_functional)\s*\n)?
\s*---END VERDICT---[\s\S]*/i
```
- Extracts: verdict (required), fix_type (optional, defaults to "functional")
- Issues: **Not extracted** — `issues: []` is always returned empty
- FIX_TYPE normalizes `non_functional` → `non-functional`

**Tier 1 — Emoji markers** (fallback):
- Looks for ✅ (approved), ❌ (needs_changes), ⚠️ (needs_changes)
- Uses **last occurrence** in text to avoid prose false positives
- Among found emojis, the one with the highest index (latest in text) wins
- ❌ and ⚠️ both map to `needs_changes` (no semantic distinction)

**Tier 2 — Text pattern** (fallback, only if Tier 1 found nothing):
- `**Verdict:** approved` or `**Verdict:** request changes`
- Bare `approved` or `needs.?changes` / `request.?changes`
- **Very loose** — the bare `/approved/i` will match sentences like "The implementation is approved by the auth module" — false positive risk

### Robustness Against Malformed LLM Output

| Scenario | Handling | Risk |
|----------|----------|------|
| No verdict at all (LLM forgot) | Returns `null` → auto-transition fails → generic error steer | ✅ Safe |
| Verdict in prose, no structured block | Falls through to Tier 1/2 | ⚠️ Tier 2 bare `approved` is loose |
| `---VERDICT---` with typos | Regex won't match → falls to Tier 1/2 | ⚠️ Could miss verdict |
| Mixed emojis (✅ in prose, ❌ at end) | Last-emoji-wins resolves correctly | ✅ Safe |
| `FIX_TYPE` missing from needs_changes | Defaults to "functional" (safe: forces full TDD) | ✅ Safe |
| `non_functional` vs `non-functional` | Both normalized to `non-functional` | ✅ Safe |
| Intercom receipt strips `finalOutput` | `rawContentText` fallback parameter | ✅ Has fallback |
| Multiple results in `details.results` | Iterates all, uses first with text | ⚠️ Warns but proceeds |

### Critical Gap: Issues Array is Always Empty
The `ReviewVerdict` type supports `issues?: IssueDetail[]` with structured severity, file path, problem, and suggestedFix — but `extractReviewVerdict` **never populates it**. Both Tier 0 and the fix_type regex extraction set `issues: []`. The `IssueDetail` schema (types.ts:365–379) is defined but unused. This means the FSM's review_result event logs `issueCount: { high: 0, medium: 0, low: 0 }` always.

---

## 5. Test Output Format Returned to the Agent

### The tool returns TWO channels:

**`content` (LLM-visible text):**
- In non-validation mode: human-friendly summary + full output in code block
- In TDD validation mode: only the validation result text (e.g., `GREEN validation: FAILED — GREEN_FAILED`)

**`details` (machine-consumable):**
- Always includes: `suite`, `commands`, `currentState`, `isTddValidation`, `exitCode`, `passed`, `failed`, `timedOut`
- In validation mode: adds `validation`, `phase`, and the full `testResult` object
- The auto-transition handler reads `details.validation` to decide transitions

### Structured Diagnostic Info — Partial
The `passed`/`failed` counts are structured, but:
- No per-test breakdown (test name → pass/fail/error)
- No error message extraction
- No file:line references
- No assertion diff
- No duration info per test
- The output truncation may lose critical context

---

## 6. Enrichment Recommendations to Reduce "Blind Guessing"

### A. Parse and Structure Test Failure Details
Currently the agent sees truncated raw text. A structured failure extraction would give:
```ts
interface TestFailure {
  testFile: string;
  testName: string;
  errorMessage: string;
  stackTrace?: string;    // first N frames
  assertionDiff?: string; // expected vs actual
}
```
This could be parsed from vitest/jest JSON reporters (`--reporter=json`) rather than scraping stdout. The JSON output is machine-parseable and contains full per-test details.

### B. Reverse Truncation Strategy (Head-Preserve)
Test failures are more useful than test summaries. Change `truncateOutput` to preserve the **head** (failure details) and truncate the middle, keeping the tail (summary counts). Or better: parse failures and summary separately, truncating only if total exceeds the budget.

### C. Surface Test Output in TDD Validation Responses
The current validation branch in `pi_coder_run_tests` does NOT append the raw output to the response text. The agent only sees `RED validation: FAILED — RED_TAUTOLOGY` without knowing which tests passed. Fix: always include the test output in the response, even in validation mode.

### D. Populate the Issues Array from Review Output
The `IssueDetail` type and `issues` field exist but are never populated. The `---VERDICT---` block format should be extended to carry structured issues:
```
---VERDICT---
VERDICT: needs_changes
FIX_TYPE: functional
ISSUES:
- SEVERITY: high | FILE: auth.ts | PROBLEM: token not refreshed | FIX: add refresh logic
---END VERDICT---
```
This gives the FSM and the orchestrator concrete, actionable feedback instead of a binary verdict.

### E. Add DOM/Component State for UI Tests
For component/e2e test suites, the runner could capture:
- Screenshot on failure (vitest supports `--screenshot OnFail`)
- Console error/warning log
- DOM snapshot of the failing component
These would be returned as structured fields in `TestRunResult` and surfaced in the tool response.

### F. Enrich GREEN Failure Steering
The current steer on GREEN failure is: `"⚠️ AUTO-TRANSITION: Tests still failing. You are now in TDD_GREEN_WRITE. Delegate to pi-coder.implementor again with clearer instructions."` This is generic. The steer should include:
- Which tests are still failing (from parsed failure details)
- What the errors are (assertion diffs)
- Suggestion: "Focus on X test in Y file: expected Z but got W"

### G. File Diff Capture
When tests fail in GREEN, capture a `git diff` of modified files since the checkpoint. This tells the agent exactly what was changed and what effect it had — reducing blind iteration.

### H. Test Run Timing and Flakiness Detection
Track test durations and flakiness across runs. A test that passes in RED but fails in GREEN is a flake signal. A test that takes >10s is a performance signal. This metadata helps the agent prioritize which tests to focus on.

---

## Summary of Key Findings

1. **RED_TAUTOLOGY** is purely exit-code-based — no inspection of test content or production code changes.
2. **Test output is LOST** in TDD validation responses (the text only shows pass/fail, not the raw output with error details).
3. **5KB tail truncation** preserves summary counts but loses failure details, file names, and assertion diffs.
4. **Review extraction** has solid 3-tier fallback, but `issues[]` is **always empty** — the structured issue type exists but is never populated.
5. **Tier 2 text matching** (`/approved/i`) is dangerously loose and could produce false positives.
6. **No DOM/component state** is captured — the runner only sees stdout/stderr.
7. **GREEN failure steer is generic** — no specifics about which tests failed or why.
8. **No file diffs** are captured to show what code changes were made between runs.

---

## Files Retrieved

1. `src/tdd-runner.ts` (full file, 241 lines) — TDD test execution, validation, output parsing
2. `src/review-extraction.ts` (full file, 317 lines) — verdict extraction, diagnostics, subagent usage
3. `src/tools.ts` (full file, ~940 lines) — tool registration, response formatting, FSM advance
4. `src/types.ts` (lines 270–400) — TestRunResult, ReviewVerdict, IssueDetail, ImplementationUnit
5. `src/handlers/tool-result.ts` (full file, ~550 lines) — auto-transition handler, steer messages
6. `src/state-machine.ts` (full file, ~200 lines) — FSM definition, transition guards, evidence

## Start Here
Open `src/handlers/tool-result.ts` — this is where the rubber meets the road for feedback quality. The auto-transition steer messages determine what the orchestrator knows after each test run. Then `src/tdd-runner.ts` for the parsing boundaries, and `src/review-extraction.ts` lines 230–317 for the verdict extraction gaps.
