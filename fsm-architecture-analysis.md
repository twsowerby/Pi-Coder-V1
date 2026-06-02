# Pi Coder FSM Architecture — Deep Analysis

## 1. ALL FSM States and Transitions

### 1.1 TDD Mode (StateMachine) — 15 States

**States:** IDLE, SPEC_WORK, SPEC_APPROVED, GIT_CHECKPOINT, TDD_RED_WRITE, TDD_RED_VALIDATE, TDD_GREEN_WRITE, TDD_GREEN_VALIDATE, REVIEWING, APPROVED, NEEDS_CHANGES, FINAL_APPROVAL, MERGING, COMPLETE, BLOCKED

**Defined Legal Transitions (20 explicit):**

| From | To | Event | Type |
|------|-----|-------|------|
| IDLE | SPEC_WORK | start_spec_work | Manual |
| SPEC_WORK | SPEC_APPROVED | spec_approved | Evidence-gated |
| SPEC_APPROVED | GIT_CHECKPOINT | checkpoint_start | Manual |
| GIT_CHECKPOINT | TDD_RED_WRITE | checkpoint_complete | Auto (git success) |
| TDD_RED_WRITE | TDD_RED_VALIDATE | tests_written | Manual |
| TDD_RED_VALIDATE | TDD_GREEN_WRITE | tests_fail_as_expected | Auto (test result) |
| TDD_RED_VALIDATE | BLOCKED | tests_pass_unexpectedly | Auto (test result) |
| TDD_RED_VALIDATE | TDD_GREEN_WRITE | red_tautology_acknowledge | Manual (exception) |
| TDD_GREEN_WRITE | TDD_GREEN_VALIDATE | code_written | Manual |
| TDD_GREEN_VALIDATE | REVIEWING | tests_pass | Evidence-gated |
| TDD_GREEN_VALIDATE | TDD_GREEN_WRITE | tests_still_fail | Auto (test result) |
| TDD_GREEN_VALIDATE | TDD_RED_WRITE | next_unit | Evidence-gated |
| REVIEWING | APPROVED | review_passed | Evidence-gated (auto) |
| REVIEWING | NEEDS_CHANGES | review_needs_changes | Auto (review verdict) |
| NEEDS_CHANGES | TDD_RED_WRITE | reimplement | Manual |
| NEEDS_CHANGES | REVIEWING | non_functional_fix | Evidence-gated |
| APPROVED | FINAL_APPROVAL | final_approval | Manual |
| APPROVED | MERGING | merge_approved | Manual |
| FINAL_APPROVAL | MERGING | merge_start | Manual |
| MERGING | COMPLETE | merge_complete | Auto (git success) |

**Implicit Transitions (added by `buildTransitionSet`/`buildTransitionMap`):**

| Pattern | Rule | Applies To |
|---------|------|------------|
| Any → IDLE | Abort/cancel at any point | Both TDD & Light |
| BLOCKED → Any | User intervention override | Both TDD & Light |
| Any → BLOCKED | **Light mode ONLY** (`allowAnyToBlocked: true`) | Light only |

**Critical difference:** TDD mode has `allowAnyToBlocked: false` — the ONLY way to reach BLOCKED in TDD is via `TDD_RED_VALIDATE → BLOCKED` (tests pass unexpectedly during RED phase). Light mode has `allowAnyToBlocked: true` — any state can emergency-override to BLOCKED.

### 1.2 Light Mode (LightStateMachine) — 12 States

**States:** IDLE, SPEC_WORK, SPEC_APPROVED, GIT_CHECKPOINT, IMPLEMENTING, REVIEWING, APPROVED, NEEDS_CHANGES, FINAL_APPROVAL, MERGING, COMPLETE, BLOCKED

**Defined Legal Transitions (14 explicit):**

| From | To | Event |
|------|-----|-------|
| IDLE | SPEC_WORK | start_spec_work |
| SPEC_WORK | SPEC_APPROVED | spec_approved |
| SPEC_APPROVED | GIT_CHECKPOINT | checkpoint_start |
| GIT_CHECKPOINT | IMPLEMENTING | checkpoint_complete |
| IMPLEMENTING | REVIEWING | implementation_complete |
| REVIEWING | APPROVED | review_passed |
| REVIEWING | NEEDS_CHANGES | review_needs_changes |
| NEEDS_CHANGES | IMPLEMENTING | reimplement |
| NEEDS_CHANGES | REVIEWING | non_functional_fix |
| APPROVED | FINAL_APPROVAL | final_approval |
| APPROVED | MERGING | merge_approved |
| FINAL_APPROVAL | MERGING | merge_start |
| MERGING | COMPLETE | merge_complete |

Light mode collapses the 4 TDD states (RED_WRITE, RED_VALIDATE, GREEN_WRITE, GREEN_VALIDATE) into a single IMPLEMENTING state. There are no test-run gates — tests are advisory only.

### 1.3 Auto-Transitions (deterministic, happen in tool-result handler)

Three categories of auto-transitions fire without explicit `pi_coder_advance_fsm`:

1. **Test result transitions** (`handlers/tool-result.ts` lines ~160-230):
   - TDD_RED_VALIDATE + test results valid → TDD_GREEN_WRITE (auto)
   - TDD_RED_VALIDATE + tests pass unexpectedly → BLOCKED or steer message
   - TDD_GREEN_VALIDATE + tests still fail → TDD_GREEN_WRITE (auto)

2. **Git result transitions** (`handlers/tool-result.ts` lines ~260-320):
   - GIT_CHECKPOINT + git checkpoint success → TDD_RED_WRITE or IMPLEMENTING (auto)
   - MERGING + git merge success → COMPLETE (auto)

3. **Review result transitions** (`handlers/tool-result.ts` lines ~380-470):
   - REVIEWING + reviewer verdict "approved" → APPROVED (auto)
   - REVIEWING + reviewer verdict "needs_changes" → NEEDS_CHANGES (auto)

---

## 2. Circuit Breaker / MAX_RETRIES / Retry Limit

**Yes — there is a circuit breaker mechanism, but it is narrow in scope.**

### Implementation

- **`BaseStateMachine.circuitBreakerTripped()`** (`base-state-machine.ts:285-286`):
  ```ts
  circuitBreakerTripped(): boolean {
    return this._loopCount >= this._config.maxLoops;
  }
  ```

- **`_loopCount` increments** (`base-state-machine.ts:263-265`) — ONLY when exiting NEEDS_CHANGES to a non-IDLE, non-BLOCKED state:
  ```ts
  if (from === "NEEDS_CHANGES" && to !== "IDLE" && to !== "BLOCKED") {
    this._loopCount++;
  }
  ```

- **Default `maxLoops` is 3** (`config.ts:25`), configurable in `.pi-coder/config.json`.

- **`_loopCount` resets** to 0 on any transition to IDLE (`base-state-machine.ts:275-277`).

- **`_loopCount` is NOT reset** on transition to BLOCKED — if unblocked and cycling resumes, the counter continues.

### What the circuit breaker does

- **`circuitBreakerTripped()` is checked** in `tools.ts:844` after every manual FSM advance. When tripped, it:
  1. Logs a `user_intervention` event with `interventionType: "circuit_breaker_override"`
  2. Fires a desktop notification (`notify(ctx.config, "circuit_breaker", ...)`)
  3. **Does NOT block the transition** — it only alerts/logs. The orchestrator can still override.

- **In the auto-transition handler** (`handlers/tool-result.ts:224-241`), after auto-transitions, `circuitBreakerTripped()` is checked and if tripped:
  1. Logs a `circuit_breaker` event
  2. Sends a desktop notification
  3. Logs a `unit_end` event with `outcome: "circuit_breaker"`

### Key Gap: The circuit breaker is advisory, not enforced

The circuit breaker **does not prevent transitions** — it only detects and alerts. There is no hard block at `maxLoops`. The orchestrator LLM can continue cycling past `maxLoops`. The nudge system provides escalation, but the FSM itself does not hard-fail.

### Loop counter does NOT track GREEN→GREEN_WRITE retries

The `TDD_GREEN_VALIDATE → TDD_GREEN_WRITE` auto-transition (tests still fail) does NOT increment `_loopCount`. An implementor could loop infinitely on GREEN failures without the circuit breaker counting it. Only the REVIEWING↔NEEDS_CHANGES review loop is counted.

---

## 3. Task Type Differentiation (Logic vs UI vs Wiring)

**There is partial task type differentiation, but NOT along logic/UI/wiring lines.**

### What exists: `approach` field on `ImplementationUnit`

- **`types.ts:332-333`**: `approach?: "tdd" | "direct"` on each ImplementationUnit
- **`approach: "tdd"`** (default) — standard RED/GREEN cycle, must pass evidence gates
- **`approach: "direct"`** — skips RED phase; auto-satisfies `test_run_this_state` for RED_VALIDATE but NOT for GREEN_VALIDATE (`tools.ts:834-837`)

### How approach:direct affects the FSM

1. **RED_VALIDATE evidence auto-set** (`tools.ts:833-837`): When transitioning to TDD_RED_VALIDATE with a direct unit, `test_run_this_state` is auto-set, allowing the transition to TDD_GREEN_WRITE without actually running tests in RED.

2. **GREEN_VALIDATE is NOT auto-satisfied** — even for direct units, the test suite MUST run at GREEN_VALIDATE. This is a safety net.

3. **RED tautology handling** (`handlers/tool-result.ts:188`): When tests pass during RED_VALIDATE, the steer message offers three options:
   - Re-delegate to write tests first (TDD path)
   - Re-save spec with `approach: "direct"` (explicit classification)
   - Acknowledge and proceed (partial implementation case)

4. **After NEEDS_CHANGES, direct does NOT apply** (`tools.ts:726-727`): If the reviewer mandates functional changes on a direct unit, the unit must go through full TDD on re-entry. The orchestrator must re-save the spec with `approach: "tdd"` first.

### What does NOT exist

There is **no concept of logical/UI/wiring/integration task types** in the FSM itself. The `approach` field is binary (tdd | direct) and is about test-first methodology, not about the *nature* of the work. The spec's `ImplementationUnit` has `testSuite` and `keyFiles` fields that could differentiate, but the FSM does not branch behavior based on these.

### `testSuite` field

- `ImplementationUnit.testSuite?: string` (`types.ts:335`) — maps to a key in `config.testCommands`
- The FSM does not use this for branching — it's passed to the implementor subagent for choosing the right test runner

---

## 4. Stuck Agent / Loop Detection

### 4.1 Nudge Engine (`nudge-engine.ts`)

The **primary mechanism** for detecting stuck agents is the nudge system:

- **Tracks `turnsSinceEntry`** per FSM state — incremented each orchestrator turn
- **`getThreshold()`** returns turns before first nudge (default: 1 turn, SPEC_WORK: 3, BLOCKED: 2)
- **Escalation levels** (default: 3):
  - Level 1: `[NUDGE] Reminder: You are in state X. Expected: ...`
  - Level 2: `[NUDGE - URGENT] You must now proceed with: ...`
  - Level 3: Handled via `ctx.ui.notify()` — desktop notification
- **Reset triggers**: FSM transition OR action attempted (`NudgeEngine.reset()`)

### 4.2 Circuit Breaker (review loops only)

As detailed in §2, `loopCount` increments only on NEEDS_CHANGES exits. This catches the review↔fix loop but NOT:
- GREEN_VALIDATE → GREEN_WRITE loops (failed implementation retries)
- RED_VALIDATE → RED_WRITE loops (test writing retries)
- Any state where the orchestrator is idle without transitioning

### 4.3 What's Missing for Loop Detection

1. **No general cycle detection** — the FSM does not track transition history or detect revisited states (other than the narrow loopCount for NEEDS_CHANGES).
2. **No per-state retry counter** — GREEN_VALIDATE → GREEN_WRITE could repeat indefinitely.
3. **No timeout mechanism** — there's no wall-clock or turn-count hard limit per state.
4. **Nudge is advisory** — it injects text into the prompt but cannot force a transition.
5. **Circuit breaker is advisory** — it logs/notifications but does not block transitions.

### 4.4 Stuck Agent Recovery Paths

- **BLOCKED** state: The orchestrator is told to "present recovery options to user"
- **Any → IDLE**: Always legal — acts as abort
- **BLOCKED → Any**: Always legal — acts as manual override by user
- In TDD mode, there is NO way to get to BLOCKED except via RED_VALIDATE tautology

---

## 5. Blocked Transitions and Why

### 5.1 Topological Blocks (illegal transitions)

The `buildTransitionSet()` function builds the set of legal transition keys. Any key not in that set throws:
```
Illegal transition: X → Y. Valid transitions from X: ...
```

Notable blocks:
- **No direct IDLE → TDD_RED_WRITE**: Must go through SPEC_WORK → SPEC_APPROVED → GIT_CHECKPOINT first
- **No TDD_GREEN_WRITE → REVIEWING**: Must go through TDD_GREEN_VALIDATE (evidence gate)
- **No BLOCKED from most states in TDD** (`allowAnyToBlocked: false`): Only RED_VALIDATE → BLOCKED is legal
- **No NEEDS_CHANGES → APPROVED**: Must go through either TDD_RED_WRITE (full cycle) or REVIEWING (non-functional fix)

### 5.2 Evidence Guard Blocks

Six transition guards in TDD mode, three in Light mode:

| Transition | Required Evidence | Purpose |
|------------|-------------------|---------|
| SPEC_WORK → SPEC_APPROVED | `spec_saved`, `spec_user_approved` | Ensure spec is written AND user-approved |
| TDD_RED_VALIDATE → TDD_GREEN_WRITE | `test_run_this_state` | Prevent skipping test validation |
| TDD_GREEN_VALIDATE → TDD_RED_WRITE | `test_run_this_state` | Must validate before next unit |
| TDD_GREEN_VALIDATE → REVIEWING | `test_run_this_state` | Must pass GREEN tests before review |
| NEEDS_CHANGES → REVIEWING | `non_functional_classified` | Must classify fix as non-functional |
| REVIEWING → APPROVED | `review_completed` | Review must actually happen |

Light mode drops the RED/GREEN evidence gates and the `non_functional_classified` gate:
| Transition | Required Evidence |
|------------|-------------------|
| SPEC_WORK → SPEC_APPROVED | `spec_saved`, `spec_user_approved` |
| REVIEWING → APPROVED | `review_completed` |

### 5.3 Action Rule Blocks

Tools are restricted to specific states via `ActionRule`:

| Tool | Allowed States (TDD) | Allowed States (Light) |
|------|-----------------------|------------------------|
| `pi_coder_run_tests` | TDD_RED_VALIDATE, TDD_GREEN_VALIDATE | **All states** |
| `pi-coder.researcher` | SPEC_WORK, TDD_RED_WRITE, TDD_GREEN_WRITE | SPEC_WORK, IMPLEMENTING |
| `pi-coder.implementor` | TDD_RED_WRITE, TDD_GREEN_WRITE, NEEDS_CHANGES | IMPLEMENTING, NEEDS_CHANGES |
| `pi-coder.reviewer` | REVIEWING | REVIEWING |
| `pi_coder_git` | GIT_CHECKPOINT, REVIEWING, MERGING, BLOCKED, IDLE | Same |

**Always-allowed tools**: `upsert_knowledge`, `pi_coder_save_spec`, `pi_coder_read_spec`, `intercom`, `ls`, `find`, `grep`, `pi_coder_advance_fsm`

### 5.4 Exception Transitions (supersede evidence guards)

Two transitions can bypass evidence guards if a `reason` is provided:

| Transition Key | What It Skips |
|----------------|---------------|
| `TDD_RED_WRITE:TDD_GREEN_WRITE` | Skip RED phase entirely |
| `TDD_GREEN_VALIDATE:APPROVED` | Skip REVIEWING after GREEN |

These are logged/auditable — the `reason` string is persisted in the FSM event details.

### 5.5 Transient vs Persistent Evidence

Evidence flags are cleared on every transition EXCEPT those in `persistentEvidence`:

- **Persistent (survive transitions)**: `spec_saved`, `spec_user_approved`, `non_functional_classified`, `review_completed`
- **Transient (cleared on transition)**: `test_run_this_state`

This means `test_run_this_state` must be re-set each cycle (via `pi_coder_run_tests`), ensuring tests actually run at each validation point.

---

## 6. Hooks for Pluggable/Adaptive FSM Behavior

### 6.1 Existing Pluggability

**`StateMachineDefinition<S>` is already a pluggable architecture.** The `BaseStateMachine` generic class is parameterized by a definition object:

```ts
interface StateMachineDefinition<S extends string> {
  allStates: S[];
  legalTransitions: TransitionEntry<S>[];
  allowAnyToBlocked: boolean;
  transitionGuards: TransitionGuard<S>[];
  actionRules: ActionRule<S>[];
  alwaysAllowed: string[];
  persistentEvidence: EvidenceFlag[];
  nudgeExpectations: Record<string, NudgeExpectation>;
}
```

This is how TDD and Light modes share the same `BaseStateMachine` class — they just provide different definitions. Adding a third mode (e.g., "wiring" or "integration") would follow this pattern.

### 6.2 `IStateMachine` Interface Polymorphism

The extension holds a single `stateMachine` variable typed as `IStateMachine` (`types.ts:107`), allowing mode switches to swap implementations at runtime. This interface is stable and well-defined with 13 methods.

### 6.3 Config-Driven Adaptability

- **`maxLoops`**: Per-project circuit breaker threshold
- **`nudge.states`**: Per-state nudge threshold overrides (currently supports `turnsBeforeNudge` and `enabled`)
- **`testCommands`**: Per-suite test commands (unit, component, integration, e2e)
- **Per-unit `approach` and `testSuite`**: Spec-level override of FSM behavior

### 6.4 Extension Points That Could Be Exposed

1. **Custom states/transitions via config** — Currently hardcoded in `TDD_DEFINITION`/`LIGHT_DEFINITION`. No config mechanism to add/remove states.
2. **Custom transition guards** — Evidence flags and guards are hardcoded. No plugin API.
3. **Custom action rules** — Tool-to-state mappings are hardcoded per mode.
4. **Transition hooks/callbacks** — No `onTransition(from, to)` hook for external logic. Side effects are hardcoded in `applyTransitionSideEffects()`.
5. **Custom evidence flags** — The `EvidenceFlag` union type is fixed (`types.ts:322`): `spec_saved | spec_user_approved | test_run_this_state | non_functional_classified | review_completed`

### 6.5 Nudge System Adaptability

The nudge system is the most configurable pluggable subsystem:
- Master enable/disable switch
- Per-state `turnsBeforeNudge` and `enabled` overrides
- 3-level escalation with configurable levels
- Reset on transition or action

But it cannot add custom nudge logic (e.g., "if GREEN_VALIDATE has been entered 5 times, escalate differently").

---

## Architecture Summary

```
┌─────────────────────────────────────────────────────────────┐
│                    BaseStateMachine<S>                        │
│  (generic FSM engine — all behavior lives here)             │
│                                                              │
│  ┌──────────────────┐  ┌──────────────────────────────────┐ │
│  │ StateMachineDef  │  │ Pre-computed Lookup Structures   │ │
│  │ (pluggable def)  │  │ • _transitionSet (legal keys)    │ │
│  │                  │  │ • _transitionMap (adjacency list)│ │
│  └──────────────────┘  │ • _persistentEvidence (set)      │ │
│                        │ • _alwaysAllowed (set)            │ │
│                        └──────────────────────────────────┘ │
│                                                              │
│  Core: transition() → check topology → check guards → apply │
│  Side effects: loopCount++, clearTransientEvidence()        │
│  Circuit breaker: loopCount >= maxLoops (ADVISORY)          │
└──────────────────┬────────────────────┬─────────────────────┘
                   │                    │
        ┌──────────▼────────┐  ┌───────▼──────────┐
        │  StateMachine    │  │ LightStateMachine │
        │  (TDD mode)      │  │ (Light mode)       │
        │  TDD_DEFINITION  │  │ LIGHT_DEFINITION   │
        └──────────────────┘  └───────────────────┘
                   │                    │
                   └──────┬─────────────┘
                          │ IStateMachine
               ┌──────────▼──────────────┐
               │    Extension Runtime     │
               │  tools.ts (advance_fsm) │
               │  handlers/tool-result   │
               │  nudge-engine.ts        │
               │  handlers/tool-call.ts  │
               └─────────────────────────┘
```

**Data flow:**
1. Orchestrator calls `pi_coder_advance_fsm` → `tools.ts` validates and calls `sm.transition()`
2. Auto-transitions fire in `handlers/tool-result.ts` when tool results come back (tests, git, reviews)
3. Evidence flags are set by tools (save_spec, run_tests, interview) or auto-set by the handler
4. Nudge engine tracks turns-per-state and injects escalating reminders into the prompt
5. State is persisted to `.pi-coder/specs/{id}/state.json` after every transition

---

## Start Here

Open `base-state-machine.ts` — it contains all the core FSM logic (transition validation, evidence guards, circuit breaker, action guards, nudge expectations, side effects). The `state-machine.ts` and `light-state-machine.ts` files are thin subclasses that provide definition objects. The real runtime behavior is in `handlers/tool-result.ts` (auto-transitions) and `tools.ts` (manual FSM advance + exception transitions).
