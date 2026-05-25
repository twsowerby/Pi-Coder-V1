# Spec 02: Worker Output

## Status: ✅ COMPLETE

All 4 phases implemented and verified. 146 tests passing (105 new state machine tests + 41 from prior parallel workers).

---

## Files Created

- **`src/state-machine.ts`** — `StateMachine` class (280 LOC)
- **`src/state-machine.test.ts`** — Full test suite (490 LOC)

---

## Phase 1: State & Transition Table ✅

### Implementation

- Defined 18 base legal transitions as `(from, to, event)` tuples covering the full TDD lifecycle
- Added wildcard transitions: BLOCKED→any (user intervention) and any→IDLE (abort)
- Built an O(1) lookup via `Set<TransitionKey>` where keys are `${from}→${to}` template literals
- `transition(to)` validates against the lookup set and throws a descriptive `Error` on illegal attempts, including both the from and to state names in the message

### Tests

- 20 legal transition tests (18 base + BLOCKED→any + any→IDLE)
- 6 illegal transition tests (skip steps, nonsense transitions)
- Error message includes from/to states

---

## Phase 2: Transition Side Effects ✅

### Implementation

- Loop counter (`_loopCount`) auto-increments on NEEDS_CHANGES→TDD_RED_WRITE transition
- Loop counter resets to 0 on IDLE entry
- `circuitBreakerTripped()` returns `loopCount >= config.maxLoops`
- `activeSpecId` and `gitRef` tracked via `setActiveSpec(id, gitRef?)` — both nullable, cleared on `reset()`
- `reset()` returns machine to IDLE with all properties cleared

### Tests

- Loop counter: starts at 0, increments on review cycles, resets on IDLE entry
- Circuit breaker: not tripped initially, not tripped at maxLoops-1, tripped at maxLoops, tripped at 1 when maxLoops is 1
- Spec/git tracking: start null, set via setActiveSpec, cleared on reset

---

## Phase 3: Action Guards ✅

### Implementation

- `isActionAllowed(toolName, targetAgent?)` — rule-based validation:
  - `pi_coder_run_tests` → only in TDD_RED_VALIDATE, TDD_GREEN_VALIDATE
  - `subagent` + `pi-coder.researcher` → only in RESEARCHING
  - `subagent` + `pi-coder.implementor` → only in TDD_RED_WRITE, TDD_GREEN_WRITE
  - `subagent` + `pi-coder.reviewer` → only in REVIEWING
  - `pi_coder_git` → only in GIT_CHECKPOINT, MERGING, BLOCKED, IDLE
  - `upsert_knowledge`, `ls`, `find`, `grep` → any state
  - `subagent` without targetAgent → allowed in subagent-expected states (RESEARCHING, RED_WRITE, GREEN_WRITE, REVIEWING)
  - Unknown tools → denied (returns false, does not throw)
- `canNudge()` — returns `{ shouldNudge, expectedAction, expectedTool }` per state lookup table
  - Action states (7): return shouldNudge=true with specific action and tool
  - Orchestrator-work states (3): return shouldNudge=true with action description
  - No-nudge states (4): IDLE, SPEC_APPROVED, FINAL_APPROVAL, COMPLETE
- Both methods verified as **pure reads** — they do not modify state or counters

### Tests

- pi_coder_run_tests: 5 tests (2 allowed states + 3 blocked states)
- subagent with agents: 8 tests (researcher, implementor, reviewer combinations)
- pi_coder_git: 16 tests (4 allowed + 12 blocked states)
- Always-allowed tools: 44 tests (4 tools × 11 states)
- canNudge: 14 tests (7 action + 3 orchestrator-work + 4 no-nudge states)
- Pure reads: 3 tests (no side effects)

---

## Phase 4: Persistence ✅

### Implementation

- `toJSON()` returns `StateMachineJSON` with currentState, activeSpecId, loopCount, gitRef
- `static fromJSON(data, config)` constructs a new StateMachine and restores all fields from the snapshot
- Restored machines can continue transitioning normally

### Tests

- toJSON: 3 tests (empty state, mid-lifecycle, with loop count)
- fromJSON: 4 tests (restore IDLE, mid-lifecycle, loop count, continued transitions)
- Round-trip integrity: 11 tests (one per main-path state)

---

## Typecheck

`npx tsc --noEmit` passes with zero errors.
