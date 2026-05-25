# Spec 02: FSM State Machine

## Context

The state machine is the backbone of the TDD lifecycle. It defines what states exist, which transitions are legal, and what actions the orchestrator is allowed to take at each point. Everything else — tool guards, system prompts, nudge logic — queries this machine.

## Dependencies

Spec 01 (type definitions — FSMState, FSMTransition, PiCoderConfig, NudgeConfig)

---

## Phase 1: State & Transition Table

### Acceptance Criteria

- Every state from the FSM diagram (§14.8 of the brief) is represented
- Every legal transition from the brief is captured
- Attempting an illegal transition raises an error (does not silently fail)

### Tasks

1. Define the complete set of legal transitions as a constant array of `(from, to, event)` tuples — covering: IDLE→RESEARCHING, RESEARCHING→PRUNING, PRUNING→DRAFTING_SPEC, DRAFTING_SPEC→SPEC_APPROVED, SPEC_APPROVED→GIT_CHECKPOINT, GIT_CHECKPOINT→TDD_RED_WRITE, TDD_RED_WRITE→TDD_RED_VALIDATE, TDD_RED_VALIDATE→TDD_GREEN_WRITE, TDD_RED_VALIDATE→BLOCKED, TDD_GREEN_WRITE→TDD_GREEN_VALIDATE, TDD_GREEN_VALIDATE→REVIEWING, TDD_GREEN_VALIDATE→TDD_GREEN_WRITE, REVIEWING→APPROVED, REVIEWING→NEEDS_CHANGES, NEEDS_CHANGES→TDD_RED_WRITE, APPROVED→FINAL_APPROVAL, FINAL_APPROVAL→MERGING, MERGING→COMPLETE, BLOCKED→any, and any→IDLE
2. Build a lookup structure from the transition array that efficienty answers "can I go from X to Y?" without scanning the full list
3. Implement the `transition(to)` method that validates against the lookup and throws a descriptive error on illegal attempts

---

## Phase 2: Transition Side Effects

### Acceptance Criteria

- Loop counter increments automatically on review cycles but resets on fresh starts
- Circuit breaker trips at the configured maxLoops threshold
- Spec ID and git ref are tracked alongside the FSM state

### Tasks

1. Increment an internal loop counter every time NEEDS_CHANGES→TDD_RED_WRITE occurs, and reset it to zero whenever IDLE is entered
2. Expose a `circuitBreakerTripped()` check that returns true when loop count reaches the configured maximum
3. Track `activeSpecId` and `gitRef` as mutable properties that are set during the lifecycle and cleared on reset
4. Provide a `reset()` method that returns the machine to IDLE and clears all tracked properties

---

## Phase 3: Action Guards

### Acceptance Criteria

- Every tool call can be validated against the current FSM state
- Subagent delegation to a specific agent is validated (not just "subagent" generically)
- The nudge system can query what action is expected at the current state

### Tasks

1. Implement `isActionAllowed(toolName, targetAgent?)` that returns true/false based on the current state — pi_coder_run_tests only in RED_VALIDATE/GREEN_VALIDATE, subagent+implementor only in RED_WRITE/GREEN_WRITE, subagent+researcher only in RESEARCHING, subagent+reviewer only in REVIEWING, pi_coder_git only in GIT_CHECKPOINT/MERGING/BLOCKED/IDLE, upsert_knowledge/ls/find/grep in any state
2. Implement `canNudge()` that returns whether nudging should occur for the current state, and what the expected action and tool are — action states (RESEARCHING, GIT_CHECKPOINT, TDD_RED_WRITE, TDD_RED_VALIDATE, TDD_GREEN_WRITE, TDD_GREEN_VALIDATE, REVIEWING) return their expected action; orchestrator-work states (PRUNING, DRAFTING_SPEC, BLOCKED) return their expected action; idle states (IDLE, SPEC_APPROVED, FINAL_APPROVAL, COMPLETE) indicate no nudge
3. Ensure guard methods are pure reads — they do not modify FSM state or counters

---

## Phase 4: Persistence

### Acceptance Criteria

- The full FSM state can be serialized to a plain JSON object suitable for `pi.appendEntry`
- A StateMachine can be reconstructed from a previously serialized snapshot
- Round-trip serialization preserves all fields: currentState, activeSpecId, loopCount, gitRef

### Tasks

1. Implement `toJSON()` that returns a plain object with currentState, activeSpecId, loopCount, and gitRef
2. Implement a static `fromJSON(data, config)` that constructs a StateMachine and restores all fields from the snapshot
3. Verify round-trip integrity: `fromJSON(machine.toJSON(), config).currentState === machine.currentState` for every reachable state
