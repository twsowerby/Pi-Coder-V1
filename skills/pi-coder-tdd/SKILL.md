---
name: pi-coder-tdd
description: TDD mode RED/GREEN lifecycle — test-driven development phases, per-unit cycles, and validation gates. Load this skill ONLY when in TDD mode.
---

# Pi Coder — TDD Mode Procedures

This skill contains procedures specific to TDD mode. For shared procedures (spec work, review, delegation templates, recovery), load `pi-coder-core`.

## TDD Cycle — Per-Unit Implementation

The TDD cycle operates **one implementation unit at a time**. For each unit in the implementation plan:

### RED Phase (per unit)

When your FSM is in TDD_RED_WRITE for a unit:

1. Delegate to the implementor for **one unit only**:
   - Use `subagent` with agent `pi-coder.implementor`, context `fresh`
   - Specify **RED phase** and the **unit name**
   - Include only the ACs for this unit (not the whole spec)
   - Include only the key files for this unit
   - See the **Delegation Templates** section in pi-coder-core for the exact format

2. After the implementor completes, advance the FSM to TDD_RED_VALIDATE:
   - Use `pi_coder_advance_fsm` with targetState `TDD_RED_VALIDATE`

3. Run tests with `pi_coder_run_tests` — defaults to unit tests; use `{ suite: "all" }` to include E2E
   - Tests **must fail** — this validates that the tests are not tautological

4. Interpret the test result:
   - **Tests fail** → FSM auto-transitions to TDD_GREEN_WRITE. The tool result will include an AUTO-TRANSITION notice — read it! Do NOT call `pi_coder_advance_fsm` when auto-transitions happen.
   - **Tests pass** (RED tautology) → The tool result includes guidance with two options:
     - **Acknowledge and proceed**: Use `pi_coder_advance_fsm TDD_GREEN_WRITE` — appropriate when adding assertions to existing passing tests, or when the implementor applied code+test simultaneously but coverage is valid.
     - **Block**: Use `pi_coder_advance_fsm BLOCKED` — appropriate when the test suite is genuinely wrong or coverage is incomplete.

### GREEN Phase (per unit)

When your FSM is in TDD_GREEN_WRITE for a unit:

1. Delegate to the implementor for **the same unit**:
   - Specify **GREEN phase** and the **unit name**
   - Include only the ACs and key files for this unit
   - Include the pre-implementation git ref so the implementor can see what tests were written

2. After the implementor completes, advance the FSM to TDD_GREEN_VALIDATE:
   - Use `pi_coder_advance_fsm` with targetState `TDD_GREEN_VALIDATE`

3. Run tests with `pi_coder_run_tests` — defaults to unit tests; use `{ suite: "all" }` to include E2E
   - Tests **must pass**

4. Interpret the test result:
   - **Tests pass** → Decide: more units or all done?
     - **More units** → Use `pi_coder_advance_fsm` with targetState `TDD_RED_WRITE` to start the next unit
     - **All units done** → Use `pi_coder_advance_fsm` with targetState `REVIEWING`
   - **Tests fail** → FSM auto-transitions back to TDD_GREEN_WRITE. The tool result will include an AUTO-TRANSITION notice. Re-delegate for the same unit with failure output. Do NOT call `pi_coder_advance_fsm` when auto-transitions happen.

### Important: Auto-transitions vs manual advances

The FSM uses both **auto-transitions** (triggered by tool results) and **manual advances** (via `pi_coder_advance_fsm`):

| Transition | Type | Trigger |
|---|---|---|
| GIT_CHECKPOINT → TDD_RED_WRITE | Auto | Git checkpoint success |
| TDD_RED_VALIDATE → TDD_GREEN_WRITE | Auto | RED test result (tests fail as expected) |
| TDD_RED_VALIDATE → TDD_GREEN_WRITE | Guided | RED tautology acknowledged — tests passed but coverage is valid |
| TDD_RED_VALIDATE → BLOCKED | Guided | RED tautology — tests passing is genuinely problematic |
| TDD_GREEN_VALIDATE → TDD_GREEN_WRITE | Auto | GREEN test result (tests still fail) |
| TDD_RED_WRITE → TDD_RED_VALIDATE | Manual | After implementor completes RED delegation |
| TDD_GREEN_WRITE → TDD_GREEN_VALIDATE | Manual | After implementor completes GREEN delegation |
| TDD_GREEN_VALIDATE → TDD_RED_WRITE | Manual | Next implementation unit |
| TDD_GREEN_VALIDATE → REVIEWING | Manual | All units complete |

**Rule**: When a tool result includes an AUTO-TRANSITION notice, do NOT call `pi_coder_advance_fsm`. The FSM has already moved. Read the notice — it tells you what state you're in and what to do next.

### RED Tautology Handling

When RED tests pass unexpectedly (RED tautology), you have two options:

1. **Acknowledge and proceed** (`pi_coder_advance_fsm TDD_GREEN_WRITE`) — The test coverage is valid even though tests passed immediately. This is the most common case:
   - Adding assertions to existing passing tests (verification, not TDD)
   - The implementor applied code+test simultaneously but coverage is valid
   - The feature already partially exists and you're extending coverage

2. **Block and recover** (`pi_coder_advance_fsm BLOCKED`) — The tests passing is genuinely problematic. This is rare:
   - The tests are tautological (they assert nothing meaningful)
   - The test suite is fundamentally wrong

**Most RED tautologies are benign.** If you added a test assertion for behavior that already exists, the test is valid — acknowledge and proceed. Only block if the test is wrong, not if the code is right.

### Next-Unit Transitions

The FSM does not track which unit you're on — you do. After each unit passes GREEN validation, check your implementation plan:
- If units remain, use `pi_coder_advance_fsm TDD_RED_WRITE` to advance to the next unit's RED phase
- If all units are complete, use `pi_coder_advance_fsm REVIEWING` to proceed to code review

The `loopCount` increments on every review cycle (both NEEDS_CHANGES → TDD_RED_WRITE and NEEDS_CHANGES → REVIEWING), not on unit-to-unit advances.
