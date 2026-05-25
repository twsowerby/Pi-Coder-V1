# Spec 12: Integration Test — Full TDD Lifecycle

## Context

End-to-end verification that all components work together as a system. Uses real StateMachine, SpecManager, GitOperations, TddRunner, and KnowledgeStore instances — only the `pi` API calls and `pi.exec` are mocked.

## Dependencies

All prior specs

---

## Phase 1: Test Infrastructure

### Acceptance Criteria

- A temporary test project exists with valid `.pi-coder/` structure and `package.json`
- All component instances are wired together as the extension would wire them
- Mocks for `pi.exec` and `pi` API calls are in place without testing real pi runtime

### Tasks

1. Create a test fixture: temp directory with `.pi-coder/config.json`, `.pi-coder/knowledge/`, `.pi-coder/specs/`, and a `package.json` with a test script
2. Instantiate all components with the test fixture paths: `StateMachine(config)`, `SpecManager(specsDir)`, `GitOperations(config)`, `TddRunner(config)`, `KnowledgeStore(knowledgeDir)`
3. Set up mocked `pi.exec` that simulates git commands (returns success with fake SHAs) and test runs (returns configured exit codes and output)

---

## Phase 2: Happy Path Lifecycle

### Acceptance Criteria

- The full lifecycle completes: research → prune → spec → approve → checkpoint → RED → validate → GREEN → validate → review → approve → merge → complete
- FSM state is correct at every step
- Spec file is created during drafting and cleaned up after completion
- Git ref is stored at checkpoint and available for reviewer briefing

### Tasks

1. Starting from IDLE, advance through RESEARCHING (simulated researcher result) → PRUNING (orchestrator prunes context) → DRAFTING_SPEC (create spec file via SpecManager) → SPEC_APPROVED
2. Advance through GIT_CHECKPOINT (call pi_coder_git.checkpoint, verify ref is stored in state machine) → TDD_RED_WRITE (simulated implementor RED result) → TDD_RED_VALIDATE (mock failing test run, verify FSM transitions to TDD_GREEN_WRITE)
3. Advance through TDD_GREEN_WRITE (simulated implementor GREEN result) → TDD_GREEN_VALIDATE (mock passing test run, verify FSM transitions to REVIEWING)
4. Advance through REVIEWING (simulated "Approved" verdict) → FINAL_APPROVAL → MERGING (call pi_coder_git.merge) → COMPLETE — verify spec file has been cleaned up
5. At any point, verify knowledge can be upserted and later listed

---

## Phase 3: Failure & Edge Cases

### Acceptance Criteria

- The RED phase anomaly (tests pass when they should fail) transitions to BLOCKED
- The circuit breaker halts the loop after max cycles
- Toggle mid-cycle preserves FSM state
- Nudge escalation fires at the correct turn count

### Tasks

1. Simulate RED validation with a passing test result — verify FSM transitions to BLOCKED and the reason is RED_TAUTOLOGY
2. Simulate 3 consecutive NEEDS_CHANGES → TDD_RED_WRITE cycles — verify `circuitBreakerTripped()` returns true after the third, and the fourth attempt transitions to BLOCKED
3. Start a TDD cycle, toggle pi-coder OFF, verify FSM state persists in appendEntry, toggle back ON, verify state restores to the point where it left off
4. Place the FSM in RESEARCHING state for 2 turns without a subagent call — verify nudge level escalates from 0 to 1 to 2, then simulate a `subagent` tool_call and verify `actionAttempted` resets the nudge urgency
