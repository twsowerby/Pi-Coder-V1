# FSM Architecture Review

## Problem Statement

We keep adding case-specific guards and prompt directives to enforce process
discipline. Each fix addresses a symptom (LLM skips a step) rather than the
root cause (the FSM doesn't enforce invariants). The result is a growing
collection of bandaids that are fragile, incomplete, and hard to reason about.

## Root Cause

**The FSM only enforces state topology (which states can reach which states).
It does NOT enforce state preconditions (what evidence is required to enter
or leave a state).**

This means:
- An LLM can advance past SPEC_WORK without user approval (no precondition)
- An LLM can advance past TDD_RED_VALIDATE without running tests (no precondition)
- A reviewer saying "approved" doesn't automatically transition to APPROVED
- The orchestrator can manually override reviewer verdicts via advance_fsm

The prompts TRY to enforce these invariants, but LLMs take shortcuts.

##-Invariant Audit

These are the NON-NEGOTIABLE invariants the system must enforce:

### I1: Spec must be saved before advancing to SPEC_APPROVED
**Status: ✅ Enforced** (tools.ts guard on advance_fsm)
**Mechanism:** `pi_coder_advance_fsm` blocks SPEC_WORK→SPEC_APPROVED when `activeSpecId` is null.
`pi_coder_save_spec` is the only way to set `activeSpecId`.

### I2: Spec must be USER-APPROVED before implementation begins
**Status: ❌ NOT ENFORCED** — prompt-only
**Problem:** The orchestrator can advance SPEC_WORK→SPEC_APPROVED without ever running
`interview`. The FSM has no concept of "user has seen and approved the spec."
**Evidence from live test:** Step 4 — "no interview this time — the brief was clear and specific"

### I3: TDD validation states require test execution
**Status: ❌ NOT ENFORCED** — prompt-only
**Problem:** The orchestrator can advance TDD_RED_VALIDATE→TDD_GREEN_WRITE (or
TDD_GREEN_VALIDATE→REVIEWING) without ever calling `pi_coder_run_tests`.
`pi_coder_advance_fsm` allows these transitions unconditionally.
**Evidence from live test:** Steps 8-10 — implementor wrote all 5 units at once, tests passed
immediately, then orchestrator advanced through RED_VALIDATE and GREEN_VALIDATE without
running `pi_coder_run_tests` at all.

### I4: Review verdict drives APPROVED/NEEDS_CHANGES
**Status: ❌ NOT ENFORCED** — `extractReviewVerdict` logs but doesn't transition
**Problem:** The reviewer can say "approved" but the orchestrator can manually advance to
NEEDS_CHANGES instead, or the reviewer says "needs changes" and the orchestrator
advances to APPROVED.
**Evidence from live test:** Reviewer said "Approved with 2 low-severity items" but
the orchestrator advanced to NEEDS_CHANGES.

### I5: Knowledge stores cross-cutting gotchas only
**Status: ❌ NOT ENFORCED** — prompt-only
**Problem:** LLM persists cycle summaries despite explicit guidance.
**Evidence from live test:** Step 35 — "Saved cycle-5-summary.md"
**Severity: Low** — this is a prompt discipline issue, not a process integrity issue.

## Proposed Architecture: State Precondition Guards

### Core idea

Add a `StateEntryConditions` map to the StateMachine. Each state declares what
evidence must exist before the FSM can enter it. The `transition()` method checks
these conditions BEFORE allowing the transition.

This replaces the ad-hoc guards in `pi_coder_advance_fsm` with a single, uniform
mechanism in the StateMachine itself.

### Evidence tracking

The StateMachine tracks a set of "evidence flags" — boolean markers that tools
set when they complete specific work:

```typescript
type EvidenceFlag =
  | "spec_saved"        // Set by pi_coder_save_spec
  | "spec_user_approved" // Set by interview tool_result when in SPEC_WORK
  | "test_run_this_state" // Set by pi_coder_run_tests tool_result
  | "review_verdict_ready" // Set by extractReviewVerdict
  ;
```

These flags are CLEARED on every state transition (evidence from a previous
state doesn't carry over — you must re-run tests in each validation state).

### State preconditions

```typescript
const STATE_PRECONDITIONS: Record<FSMState, EvidenceFlag[]> = {
  IDLE: [],
  SPEC_WORK: [],
  SPEC_APPROVED: ["spec_saved", "spec_user_approved"],
  GIT_CHECKPOINT: ["spec_saved", "spec_user_approved"],
  TDD_RED_WRITE: ["spec_saved", "spec_user_approved"],
  TDD_RED_VALIDATE: ["spec_saved", "spec_user_approved"],
  TDD_GREEN_WRITE: ["spec_saved", "spec_user_approved"],
  TDD_GREEN_VALIDATE: ["spec_saved", "spec_user_approved"],
  REVIEWING: ["spec_saved", "spec_user_approved"],
  APPROVED: ["spec_saved", "spec_user_approved"],
  NEEDS_CHANGES: ["spec_saved", "spec_user_approved"],
  FINAL_APPROVAL: ["spec_saved", "spec_user_approved"],
  MERGING: ["spec_saved", "spec_user_approved"],
  COMPLETE: ["spec_saved", "spec_user_approved"],
  BLOCKED: [],
};
```

Wait — this isn't quite right. The preconditions should be on the TRANSITION,
not on the state. You need `spec_saved` to enter SPEC_APPROVED (the transition
SPEC_WORK→SPEC_APPROVED requires it), but you don't need `spec_user_approved`
to enter SPEC_WORK. And `test_run_this_state` is needed for transitions OUT of
validation states, not INTO them.

Let me rethink...

### Revised: Transition preconditions

Instead of state preconditions, we define **transition guards** — evidence
required for specific transitions:

```typescript
interface TransitionGuard {
  from: FSMState;
  to: FSMState;
  requiredEvidence: EvidenceFlag[];
  errorMessage: string;
}

const TRANSITION_GUARDS: TransitionGuard[] = [
  {
    from: "SPEC_WORK",
    to: "SPEC_APPROVED",
    requiredEvidence: ["spec_saved", "spec_user_approved"],
    errorMessage: "Cannot advance to SPEC_APPROVED without a saved and user-approved spec. Save with pi_coder_save_spec and get approval via interview.",
  },
  {
    from: "TDD_RED_VALIDATE",
    to: "TDD_GREEN_WRITE",
    requiredEvidence: ["test_run_this_state"],
    errorMessage: "Cannot advance past RED validation without running tests. Use pi_coder_run_tests first.",
  },
  {
    from: "TDD_GREEN_VALIDATE",
    to: "TDD_RED_WRITE",
    requiredEvidence: ["test_run_this_state"],
    errorMessage: "Cannot advance past GREEN validation without running tests. Use pi_coder_run_tests first.",
  },
  {
    from: "TDD_GREEN_VALIDATE",
    to: "REVIEWING",
    requiredEvidence: ["test_run_this_state"],
    errorMessage: "Cannot advance to REVIEWING without running GREEN validation tests. Use pi_coder_run_tests first.",
  },
];
```

This replaces:
1. The SPEC_WORK→SPEC_APPROVED guard in `pi_coder_advance_fsm` (I1 + I2)
2. The post-spec-states guard in `pi_coder_advance_fsm` (I1)
3. The need for prompt-only TDD discipline (I3)

### How evidence is set

| Flag | Set by | When | Cleared |
|---|---|---|---|
| `spec_saved` | `pi_coder_save_spec` execute | On successful spec save | On IDLE transition (new cycle) |
| `spec_user_approved` | `tool_result` handler | `interview` tool completes while in SPEC_WORK | On IDLE transition |
| `test_run_this_state` | `tool_result` handler | `pi_coder_run_tests` completes (regardless of result) | On any state transition |

### Review verdict auto-transition (I4)

This doesn't fit the evidence model — it's about the transition being
DETERMINISTIC based on tool output. Like the test result auto-transitions.

Currently, the `tool_result` handler auto-transitions for:
- `pi_coder_run_tests` → TDD_GREEN_WRITE/BLOCKED/TDD_GREEN_WRITE
- `pi_coder_git` checkpoint → TDD_RED_WRITE
- `pi_coder_git` merge → COMPLETE

It should also auto-transition for:
- `subagent` when reviewer → APPROVED or NEEDS_CHANGES

This removes the manual `pi_coder_advance_fsm REVIEWING → APPROVED/NEEDS_CHANGES`
from the orchestrator's responsibility entirely.

### Changes to `pi_coder_advance_fsm`

With transition guards in the StateMachine, the ad-hoc guards in `advance_fsm`
can be removed. The tool becomes purely a transition request, and the
StateMachine's `transition()` method enforces all preconditions.

The only role `advance_fsm` keeps: the `nextActionHints` — helpful UX, not
enforcement.

### Interview for spec approval (I2)

The `interview` tool is not a pi-coder tool — it's a built-in pi tool. So we
can't easily modify its behavior. Instead, the `tool_result` handler in the
extension should detect when `interview` completes while in SPEC_WORK, and
set the `spec_user_approved` evidence flag.

Detection heuristic:
- `toolName === "interview"` AND `currentState === "SPEC_WORK"` AND the
  tool result doesn't indicate an error/interruption

This is a reasonable heuristic — if the orchestrator runs `interview` while
in SPEC_WORK, it's almost certainly for spec approval. (If it runs `interview`
in FINAL_APPROVAL, that's a different interview — no flag set because the
transition from FINAL_APPROVAL doesn't require `spec_user_approved`).

### Summary of changes

**StateMachine (`src/state-machine.ts`):**
- Add `EvidenceFlag` type and `TRANSITION_GUARDS` table
- Add `evidence` Set to StateMachine
- Add `setEvidence(flag)` method — called by tools
- Add `clearEvidence()` method — called on state transition (for `test_run_this_state`)
- Modify `transition()` to check transition guards before allowing transition
- `activeSpecId` check merged into `spec_saved` evidence guard (remove from advance_fsm)

**Tools (`src/tools.ts`):**
- Remove SPEC_WORK→SPEC_APPROVED guard from `advance_fsm` (moved to StateMachine)
- Remove post-spec-states guard from `advance_fsm` (moved to StateMachine)
- Keep `nextActionHints` in `advance_fsm` (UX only)
- `pi_coder_save_spec` calls `smRef.current.setEvidence("spec_saved")` instead of
  just setting `activeSpecId` (which the StateMachine already does via evidence check)

**Extension (`extensions/index.ts`):**
- `tool_result` handler for `interview`: set `spec_user_approved` evidence flag
- `tool_result` handler for `pi_coder_run_tests`: set `test_run_this_state` evidence flag
- `tool_result` handler for subagent review: auto-transition REVIEWING→APPROVED/NEEDS_CHANGES
- Clear `test_run_this_state` evidence on every state transition

**Evidence flags behavior:**
- `spec_saved`: persists across states (until IDLE reset)
- `spec_user_approved`: persists across states (until IDLE reset)
- `test_run_this_state`: cleared on every state transition (must re-run in each validation state)

**Net reduction in code:**
- Remove two ad-hoc guard blocks from `pi_coder_advance_fsm`
- Remove `activeSpecId` null-coalescing from `pi_coder_git checkpoint` (already done)
- Centralize all preconditions in one place (StateMachine)
- Remove the need for REVIEWING→APPROVED/NEEDS_CHANGES manual advances

**New auto-transitions:**
- `interview` result in SPEC_WORK → sets `spec_user_approved` evidence
- `subagent` result in REVIEWING → auto-transitions to APPROVED/NEEDS_CHANGES
