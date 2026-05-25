# Spec 12: Worker Output — Integration Test

## Status: ✅ COMPLETE

All 3 phases implemented and verified. 19 integration tests passing (372 total across all specs).

---

## Phase 1: Test Infrastructure ✅

### Implementation (`src/integration/lifecycle.test.ts`)

- Test fixture creates a temp directory with `.pi-coder/knowledge/`, `.pi-coder/specs/`, and `package.json`
- All components are instantiated with real instances and test fixture paths
- Mock `pi.exec` simulates git commands (returns fake SHAs) and test runs (returns configured exit codes and output)
- `StateMachine`, `SpecManager`, `GitOperations`, `TddRunner`, `KnowledgeStore` all wired together as the extension would wire them

### Tests (5)
- Temp directory has valid `.pi-coder/` structure
- All components instantiate with test fixture paths
- State machine starts in IDLE state
- Mocked git exec returns valid SHAs
- Mocked test exec returns configured results

---

## Phase 2: Happy Path Lifecycle ✅

### Tests (5)

1. **Full TDD lifecycle IDLE → COMPLETE** — walks every FSM state transition in order. Generates spec ID, creates spec file via SpecManager, advances through all states with appropriate actions at each step (git checkout+checkpoint at GIT_CHECKPOINT, failing RED tests, passing GREEN tests, reviewer approval, merge, spec file cleanup). Verifies FSM state, spec file, git ref, and knowledge at each step.

2. **Spec file preserved throughout lifecycle** — creates a spec, advances through multiple states, verifies the spec file exists at each step, then cleans up.

3. **Git ref stored at checkpoint available for reviewer** — checkpoints, stores ref in state machine, verifies ref is accessible for constructing reviewer task payload.

4. **Knowledge upsert at any lifecycle point** — tests knowledge creation in IDLE, RESEARCHING, and PRUNING states. Verifies listing and reading.

5. **Spec status tracking through lifecycle** — updates spec status at each phase, reads back to verify.

---

## Phase 3: Failure & Edge Cases ✅

### Tests (9)

1. **RED phase anomaly** — tests pass when they should fail. TddRunner.validateRedPhase returns `{ valid: false, reason: "RED_TAUTOLOGY" }`. FSM transitions to BLOCKED.

2. **Circuit breaker trips after maxLoops** — completes 3 full review cycles (NEEDS_CHANGES → TDD_RED_WRITE → ... → REVIEWING × 3). Verifies `circuitBreakerTripped()` returns true at loopCount=3.

3. **Circuit breaker prevents further loops** — after maxLoops cycles, the extension aborts to IDLE (any→IDLE is always legal). Loop count resets to 0. Note: REVIEWING→BLOCKED is not a legal FSM transition, so the abort-to-IDLE path is the correct recovery.

4. **Toggle mid-cycle preserves FSM state** — starts a TDD cycle, captures the StateMachine.toJSON() snapshot when toggled off, restores via StateMachine.fromJSON() when toggled on. Verifies all fields (currentState, activeSpecId, gitRef) are preserved and the restored machine can continue transitioning.

5. **Nudge escalation at correct turn count** — simulates the nudge counter behavior from the extension's `before_agent_start` handler. Enters RESEARCHING, counts turns without action, verifies nudge level escalates from 0 → 1 → 2 at the correct thresholds. Then simulates a `subagent` tool_call (actionAttempted = true) and verifies nudge stops escalating.

6. **Nudge disabled for IDLE and COMPLETE** — verifies canNudge() returns `shouldNudge: false` for both states.

7. **GREEN phase failure loops back** — tests fail during GREEN validation, validateGreenPhase returns `{ valid: false, reason: "GREEN_FAILED" }`, FSM transitions to TDD_GREEN_WRITE.

8. **Rollback from mid-cycle** — checkpoints, advances to TDD_GREEN_WRITE, rolls back to the stored git ref, FSM transitions to IDLE.

9. **Spec manager round-trip with complete data** — creates spec with all fields populated (3 ACs, 2 constraints, 3 key files, rich pruned context), reads back to verify all fields match, updates status through multiple lifecycle phases, finally deletes.

---

## Key Design Decisions

1. **FSM transitions simulated manually** — Since we can't run the real extension event handlers in a test, we simulate what the `tool_result` handler would do: validate test results, transition the FSM, and persist state. This tests the component integration without requiring the pi runtime.

2. **Separate TddRunner instances for RED vs GREEN** — Each phase gets its own TddRunner configured with the appropriate mock exec (failing results for RED, passing for GREEN). This matches how the real extension would see different results at different phases.

3. **Circuit breaker recovery via IDLE abort** — REVIEWING→BLOCKED is not a legal FSM transition. When the circuit breaker trips, the extension should present options to the user rather than auto-looping. The `any→IDLE` abort path is the valid way to escape a stuck cycle. This is a real finding that should be documented in the brief.

4. **Nudge counter behavior validated against config** — The test doesn't use the extension's actual nudge tracking code, but validates the same logic (threshold comparison, escalation levels, action attempted reset) that the extension implements, proving the config values produce the expected behavior.

---

## All Acceptance Criteria Met

| Phase | Criterion | Status |
|---|---|---|
| 1 | Temp project with valid .pi-coder/ structure and package.json | ✅ |
| 1 | All component instances wired together | ✅ |
| 1 | Mocked pi.exec for git commands and test runs | ✅ |
| 2 | Full lifecycle completes IDLE → COMPLETE | ✅ |
| 2 | FSM state correct at every step | ✅ |
| 2 | Spec file created during drafting, cleaned up after completion | ✅ |
| 2 | Git ref stored at checkpoint, available for reviewer briefing | ✅ |
| 2 | Knowledge can be upserted at any point | ✅ |
| 3 | RED anomaly transitions to BLOCKED with RED_TAUTOLOGY | ✅ |
| 3 | Circuit breaker halts after max cycles | ✅ |
| 3 | Toggle mid-cycle preserves FSM state | ✅ |
| 3 | Nudge escalation fires at correct turn count | ✅ |

---

## Risks & Notes

1. **REVIEWING → BLOCKED is not a legal FSM transition.** When the circuit breaker trips in REVIEWING state, the recovery path is to abort to IDLE (any→IDLE is always legal) and present options to the user. The brief should be updated to document this — the FSM diagram in §14.8 shows BLOCKED as reachable only from TDD_RED_VALIDATE, not from arbitrary states.

2. **Integration tests don't exercise the extension event handlers directly.** They simulate the same logic manually. Full extension integration would require a mock pi runtime, which is out of scope for this spec.

3. **The nudge test validates the algorithm logic but not the actual before_agent_start handler.** Testing the handler would require mocking the pi event system, which the integration test scope doesn't cover.
