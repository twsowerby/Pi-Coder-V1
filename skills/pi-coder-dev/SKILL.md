---
name: pi-coder-dev
description: Dev mode per-unit test strategy lifecycle — classifying units as tdd/verify/skip and following the appropriate path. Load this skill ONLY when in Dev mode.
---

# Pi Coder — Dev Mode Procedures

This skill contains procedures specific to Dev mode. For shared procedures (spec work, review, delegation templates, recovery), load `pi-coder-core`.

## Dev Cycle — Per-Unit Implementation

The dev cycle operates **one implementation unit at a time**. Each unit is classified with a test strategy (`tdd`, `verify`, or `skip`) that determines the FSM path. For each unit in the implementation plan:

### TDD Units (testStrategy: "tdd")

When your FSM is in TDD_RED_WRITE or TDD_GREEN_WRITE for a tdd unit:
- Follow the standard RED/GREEN cycle (same as TDD mode)
- After GREEN passes, advance to TDD_RED_WRITE (next tdd unit), IMPLEMENTING (next verify/skip unit), or REVIEWING (all done)

#### RED Phase (per tdd unit)

When your FSM is in TDD_RED_WRITE for a tdd unit:

1. Delegate to the implementor for **one unit only**:
   - Use `subagent` with agent `pi-coder.implementor`, context `fresh`
   - Specify **RED phase** and the **unit name**
   - Include only the ACs for this unit (not the whole spec)
   - Include only the key files for this unit
   - See the **Delegation Templates** section in pi-coder-core for the exact format

   You can also delegate to `pi-coder.researcher` in TDD_RED_WRITE if you need to investigate something during the RED phase (e.g., clarify a pattern, find a dependency).

2. After the implementor completes, advance the FSM to TDD_RED_VALIDATE:
   - Use `pi_coder_advance_fsm` with targetState `TDD_RED_VALIDATE`

3. Run tests with `pi_coder_run_tests` — defaults to unit tests; use `{ suite: "all" }` to include E2E
   - Tests **must fail** — this validates that the tests are not tautological

4. Interpret the test result:
   - **Tests fail** → FSM auto-transitions to TDD_GREEN_WRITE. The tool result will include an AUTO-TRANSITION notice — read it! Do NOT call `pi_coder_advance_fsm` when auto-transitions happen.
   - **Tests pass** (RED tautology) → See RED Tautology Handling below.

#### GREEN Phase (per tdd unit)

When your FSM is in TDD_GREEN_WRITE for a tdd unit:

1. Delegate to the implementor for **the same unit**:
   - Specify **GREEN phase** and the **unit name**
   - Include only the ACs and key files for this unit
   - Include the pre-implementation git ref so the implementor can see what tests were written

   You can also delegate to `pi-coder.researcher` in TDD_GREEN_WRITE if you need to investigate something during the GREEN phase.

2. After the implementor completes, advance the FSM to TDD_GREEN_VALIDATE:
   - Use `pi_coder_advance_fsm` with targetState `TDD_GREEN_VALIDATE`

3. Run tests with `pi_coder_run_tests` — defaults to unit tests; use `{ suite: "all" }` to include E2E
   - Tests **must pass**

4. Interpret the test result:
   - **Tests pass** → Decide: more units or all done?
     - **Next unit is tdd** → Use `pi_coder_advance_fsm` with targetState `TDD_RED_WRITE`
     - **Next unit is verify/skip** → Use `pi_coder_advance_fsm` with targetState `IMPLEMENTING`
     - **All units done** → Use `pi_coder_advance_fsm` with targetState `REVIEWING`
   - **Tests fail** → FSM auto-transitions back to TDD_GREEN_WRITE. The tool result will include an AUTO-TRANSITION notice. Re-delegate for the same unit with failure output. Do NOT call `pi_coder_advance_fsm` when auto-transitions happen.

### Verify Units (testStrategy: "verify")

When your FSM is in IMPLEMENTING for a verify unit:
1. Delegate to pi-coder.implementor with implementation brief (same ACs, constraints, key files). Specify **IMPLEMENT mode**.
2. After implementor completes, run `pi_coder_run_tests`
3. If tests pass: advance with `pi_coder_advance_fsm` to TDD_RED_WRITE (next tdd unit), IMPLEMENTING (next verify/skip unit), or REVIEWING (all done)
4. If tests fail: the FSM auto-transitions back to IMPLEMENTING. Re-delegate implementor to fix failures. Retry escalation applies.

### Skip Units (testStrategy: "skip")

When your FSM is in IMPLEMENTING for a skip unit:
1. Delegate to pi-coder.implementor with implementation brief. Specify **IMPLEMENT mode**.
2. After implementor completes, advance with `pi_coder_advance_fsm` to TDD_RED_WRITE (next tdd unit), IMPLEMENTING (next verify/skip unit), or REVIEWING (all done)
3. No test gate — skip units have no testable behavior

## Test Strategy Classification

Each implementation unit must be classified during spec planning. The classification determines the FSM path:

| Strategy | FSM Path | Test Gate | Rationale Required? |
|----------|----------|-----------|---------------------|
| `tdd` | TDD_RED_WRITE → RED_VALIDATE → GREEN_WRITE → GREEN_VALIDATE | Yes (RED must fail, GREEN must pass) | No (default) |
| `verify` | IMPLEMENTING (with test gate on exit) | Yes (tests must pass before advancing) | Yes |
| `skip` | IMPLEMENTING (no test gate) | No | Yes |

**Classification rubric:**
- Does this unit change production behavior? If NO → `skip` (config, docs, CSS, renames)
- Can you write a failing test BEFORE implementing? If YES → `tdd`
- Can you write a test AFTER implementing? If YES → `verify` (integration points, API surfaces, data transforms where the "test first" step isn't useful but verification IS)

**Common misclassifications to avoid:**
- DON'T use `verify` when `tdd` applies. If you CAN write the test first, write it first.
- DON'T use `skip` for business logic, data transformations, or error handling — these are testable.
- DO use `skip` for CSS-only changes, config files, documentation, and pure component assembly (composing library components).

## Important: Auto-transitions vs manual advances

The FSM uses both **auto-transitions** (triggered by tool results) and **manual advances** (via `pi_coder_advance_fsm`):

| Transition | Type | Trigger |
|---|---|---|
| GIT_CHECKPOINT → TDD_RED_WRITE | Auto | Git checkpoint success; first unit is tdd |
| GIT_CHECKPOINT → IMPLEMENTING | Auto | Git checkpoint success; first unit is verify/skip |
| GIT_CHECKPOINT → REVIEWING | Auto | Git checkpoint success; empty implementation plan |
| TDD_RED_VALIDATE → TDD_GREEN_WRITE | Auto | RED test result (tests fail as expected) |
| TDD_RED_VALIDATE → TDD_GREEN_WRITE | Guided | RED tautology acknowledged — tests passed but coverage is valid |
| TDD_RED_VALIDATE → BLOCKED | Guided | RED tautology — tests passing is genuinely problematic |
| TDD_GREEN_VALIDATE → TDD_GREEN_WRITE | Auto | GREEN test result (tests still fail) |
| IMPLEMENTING → IMPLEMENTING | Auto | Verify unit test result (tests still fail — retry) |
| TDD_RED_WRITE → TDD_RED_VALIDATE | Manual | After implementor completes RED delegation |
| TDD_GREEN_WRITE → TDD_GREEN_VALIDATE | Manual | After implementor completes GREEN delegation |
| TDD_GREEN_VALIDATE → TDD_RED_WRITE | Manual | Next unit is tdd |
| TDD_GREEN_VALIDATE → IMPLEMENTING | Manual | Next unit is verify/skip |
| TDD_GREEN_VALIDATE → REVIEWING | Manual | All units complete |
| IMPLEMENTING → TDD_RED_WRITE | Manual | Next unit is tdd |
| IMPLEMENTING → IMPLEMENTING | Manual | Next unit is verify/skip |
| IMPLEMENTING → REVIEWING | Manual | All units complete |

**Rule**: When a tool result includes an AUTO-TRANSITION notice, do NOT call `pi_coder_advance_fsm`. The FSM has already moved. Read the notice — it tells you what state you're in and what to do next.

## RED Tautology Handling

When RED tests pass unexpectedly (RED tautology), you have three options:

1. **Re-delegate to write tests first** — Stay in TDD_RED_WRITE. Re-delegate with explicit instructions to write ONLY failing test files. Default correct response.

2. **Reclassify as skip strategy** — If this unit genuinely doesn't benefit from test-first development (CSS/styling, config, docs), re-save the spec with `testStrategy: "skip"`, then advance to IMPLEMENTING. This records the decision explicitly.

3. **Acknowledge and proceed** (`pi_coder_advance_fsm TDD_GREEN_WRITE`) — Only valid when new tests WERE written that test real new behavior, but they pass because the feature was already partially implemented.

**Most RED tautologies indicate the implementor did not write tests first.** Option 1 (re-delegate) is the default correct response. Option 2 is for genuinely non-behavioral units. Option 3 is ONLY for legitimately pre-existing behavior being newly tested — not for untested new code.

Do NOT acknowledge a tautology just because the existing test suite happens to pass. If no new tests exist for the new code, the tautology means there is no test coverage — re-delegate the implementor.

## Verify Retry Escalation

When a verify unit's tests fail in IMPLEMENTING, the FSM auto-transitions back to IMPLEMENTING for a retry. The `impl_retries` counter tracks consecutive failures. Escalation mirrors the GREEN retry pattern:

| impl_retries | Behavior |
|-------------|----------|
| < enrichedSteerThreshold | Standard steer: "Fix the implementation and try again" |
| >= enrichedSteerThreshold | Enriched steer: specific failing test names |
| >= replanThreshold | Strategy intervention steer: "Re-read + analyze + reformulate the approach" |
| >= maxRetries | Auto-transition to BLOCKED (`IMPLEMENTING → BLOCKED`) — hard stop, notify user |

### Next-Unit Transitions

The FSM does not track which unit you're on — you do. After each unit passes validation, check your implementation plan:
- If the next unit is tdd → use `pi_coder_advance_fsm TDD_RED_WRITE` 
- If the next unit is verify/skip → use `pi_coder_advance_fsm IMPLEMENTING`
- If all units are complete → use `pi_coder_advance_fsm REVIEWING`

Always pass `unitName` to `pi_coder_advance_fsm` when advancing to TDD_RED_WRITE or IMPLEMENTING so the FSM can track the active unit.

The `loopCount` increments on every review cycle (both NEEDS_CHANGES → implementation states and NEEDS_CHANGES → REVIEWING), not on unit-to-unit advances.
