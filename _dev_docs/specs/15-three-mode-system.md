# Spec 15: Three-Mode System (Plan / Light / TDD)

## Problem

Current light mode has no FSM — it relies on the LLM's "judgment" for process
discipline, which means specs get skipped, review gets skipped, and the
implementor gate is the only enforcement mechanism. Meanwhile, there's no mode
for pure investigation/discussion — the current light mode tries to be that AND
a lightweight implementation mode, doing neither well.

## Solution

Split into three distinct modes with clear separation of concerns:

| Mode | FSM | Spec | TDD | Subagents | Use case |
|------|-----|------|-----|-----------|----------|
| **Plan** | ❌ | ❌ | ❌ | Researcher only | "Let me think this through" |
| **Light** | ✅ Simplified | ✅ | ❌ | Researcher, Implementor, Reviewer | "Build it, don't TDD it" |
| **TDD** | ✅ Full | ✅ | ✅ RED/GREEN | Researcher, Implementor, Reviewer | "Full discipline" |

**Zero regressions to TDD mode.** The existing `StateMachine`, transitions,
evidence guards, action rules, nudge system, and auto-transitions are
untouched. The only change to TDD-mode code paths is the addition of
`piCoderMode === "tdd"` checks where they already exist or replacing
bare `else` branches (currently meaning "light mode") with explicit
mode checks.

---

## 1. Type Changes

### 1.1 `PiCoderMode` (src/types.ts)

```typescript
// Before
export type PiCoderMode = "off" | "light" | "tdd";

// After
export type PiCoderMode = "off" | "plan" | "light" | "tdd";
```

### 1.2 `LightFSMState` (src/types.ts) — NEW

```typescript
/**
 * FSM states for Light mode — same lifecycle as TDD but with the
 * RED/GREEN phases collapsed into a single IMPLEMENTING state.
 *
 * Flow:
 *   IDLE → SPEC_WORK → SPEC_APPROVED → GIT_CHECKPOINT →
 *   IMPLEMENTING → REVIEWING →
 *   (APPROVED → FINAL_APPROVAL → MERGING → COMPLETE) |
 *   (NEEDS_CHANGES → IMPLEMENTING | REVIEWING) | BLOCKED
 */
export type LightFSMState =
  | "IDLE"
  | "SPEC_WORK"
  | "SPEC_APPROVED"
  | "GIT_CHECKPOINT"
  | "IMPLEMENTING"
  | "REVIEWING"
  | "APPROVED"
  | "NEEDS_CHANGES"
  | "FINAL_APPROVAL"
  | "MERGING"
  | "COMPLETE"
  | "BLOCKED";
```

### 1.3 `FSMState` (src/types.ts) — UNCHANGED

The existing `FSMState` type keeps all 15 states including the TDD-specific
ones (`TDD_RED_WRITE`, `TDD_RED_VALIDATE`, `TDD_GREEN_WRITE`,
`TDD_GREEN_VALIDATE`). It is only used by the TDD `StateMachine`.

### 1.4 `EvidenceFlag` (src/types.ts) — UNCHANGED

`test_run_this_state` remains in the union. It's used by TDD transition
guards and simply never set in light mode. No change needed.

### 1.5 `IStateMachine` interface (src/types.ts) — NEW

```typescript
/**
 * Shared interface for all FSM implementations.
 * The extension holds a single `stateMachine` variable typed as this,
 * allowing mode switches to swap implementations.
 */
export interface IStateMachine {
  /** Current FSM state (type depends on implementation) */
  readonly currentState: string;
  /** Review loop counter */
  loopCount: number;
  /** Attempt a state transition. Throws TransitionGuardError if guard fails. */
  transition(targetState: string, event?: string): void;
  /** Set an evidence flag */
  setEvidence(flag: EvidenceFlag): void;
  /** Check if an evidence flag is set */
  hasEvidence(flag: EvidenceFlag): boolean;
  /** Clear an evidence flag */
  clearEvidence(flag: EvidenceFlag): void;
  /** Check if a tool/agent action is allowed in the current state */
  isActionAllowed(tool: string, agent?: string): boolean;
  /** Get valid transition targets from the current state */
  getValidTransitions(): string[];
  /** Whether the circuit breaker has tripped */
  circuitBreakerTripped(): boolean;
  /** Whether the current state should trigger nudges */
  canNudge(): { shouldNudge: boolean; expectedAction: string; expectedTool: string };
  /** Serialize to JSON for persistence */
  toJSON(): Record<string, unknown>;
  /** Deserialize from JSON (static factory) */
  // fromJSON is a static method, not on the interface
}
```

### 1.6 `GlobalState` (src/types.ts) — UPDATED

```typescript
export interface GlobalState {
  version: 1;
  /** Current pi-coder mode: off, plan (investigation only), light (FSM, no TDD), or tdd (full lifecycle) */
  piCoderMode: PiCoderMode;
  /** @deprecated Use piCoderMode instead. Kept for migration. */
  piCoderActive?: boolean;
  activeSpecId: string | null;
  updatedAt: string;
}
```

Comment change only. Shape is identical.

---

## 2. LightStateMachine (NEW CLASS)

### 2.1 Location

`src/light-state-machine.ts` — parallel to `src/state-machine.ts`.

### 2.2 Design

Same structure as `StateMachine` but with:
- State type is `LightFSMState` (not `FSMState`)
- Transition table omits all TDD states
- `IMPLEMENTING` replaces `TDD_RED_WRITE` + `TDD_RED_VALIDATE` + `TDD_GREEN_WRITE` + `TDD_GREEN_VALIDATE`
- Implements `IStateMachine`

### 2.3 Transition Table

```typescript
const LEGAL_TRANSITIONS: TransitionEntry[] = [
  // Spec phase — identical to TDD
  { from: "IDLE", to: "SPEC_WORK", event: "start_spec_work" },
  { from: "SPEC_WORK", to: "SPEC_APPROVED", event: "spec_approved" },
  { from: "SPEC_APPROVED", to: "GIT_CHECKPOINT", event: "checkpoint_start" },
  // Implementation — collapsed from 4 TDD states to 1
  { from: "GIT_CHECKPOINT", to: "IMPLEMENTING", event: "checkpoint_complete" },
  // Review — identical to TDD
  { from: "IMPLEMENTING", to: "REVIEWING", event: "implementation_complete" },
  { from: "REVIEWING", to: "APPROVED", event: "review_approved" },
  { from: "REVIEWING", to: "NEEDS_CHANGES", event: "review_needs_changes" },
  // Fix paths — same structure as TDD but targeting IMPLEMENTING instead of TDD_RED_WRITE
  { from: "NEEDS_CHANGES", to: "IMPLEMENTING", event: "reimplement" },
  { from: "NEEDS_CHANGES", to: "REVIEWING", event: "non_functional_fix" },
  // Merge — identical to TDD
  { from: "APPROVED", to: "FINAL_APPROVAL", event: "final_approval" },
  { from: "FINAL_APPROVAL", to: "MERGING", event: "merge_start" },
  { from: "MERGING", to: "COMPLETE", event: "merge_complete" },
];
```

### 2.4 Transition Guards

```typescript
const TRANSITION_GUARDS: TransitionGuard[] = [
  {
    from: "SPEC_WORK",
    to: "SPEC_APPROVED",
    requiredEvidence: ["spec_saved", "spec_user_approved"],
    errorMessage:
      "Cannot advance to SPEC_APPROVED. Required evidence missing:\n" +
      "  - spec_saved: Save the spec with pi_coder_save_spec\n" +
      "  - spec_user_approved: Get user approval via interview\n" +
      "Both are non-negotiable. Save the spec, then present it for approval.",
  },
  {
    from: "NEEDS_CHANGES",
    to: "REVIEWING",
    requiredEvidence: ["non_functional_classified"],
    errorMessage:
      "Cannot advance to REVIEWING for non-functional fix without reviewer classification. " +
      "The reviewer must classify the fix type in its verdict. If the fix is non-functional " +
      "(test cleanup, comments, naming, assertions), the reviewer should include " +
      "'Fix-Type: non-functional' in its output. If the fix is functional (production code " +
      "changes), advance to IMPLEMENTING for a full implementation cycle instead.",
  },
];
```

**No `test_run_this_state` guards.** Tests are advisory in light mode.

### 2.5 Action Rules

```typescript
const ACTION_RULES: Array<{
  tool: string;
  agents?: string[];
  allowedStates: Set<LightFSMState>;
}> = [
  {
    tool: "pi_coder_run_tests",
    // Tests available in ANY state — no gates, advisory only
    allowedStates: new Set(["IDLE", "SPEC_WORK", "SPEC_APPROVED", "GIT_CHECKPOINT", "IMPLEMENTING", "REVIEWING", "APPROVED", "NEEDS_CHANGES", "FINAL_APPROVAL", "MERGING", "COMPLETE", "BLOCKED"]),
  },
  {
    tool: "subagent",
    agents: ["pi-coder.researcher"],
    allowedStates: new Set(["SPEC_WORK", "IMPLEMENTING"]),
  },
  {
    tool: "subagent",
    agents: ["pi-coder.implementor"],
    allowedStates: new Set(["IMPLEMENTING", "NEEDS_CHANGES"]),
  },
  {
    tool: "subagent",
    agents: ["pi-coder.reviewer"],
    allowedStates: new Set(["REVIEWING"]),
  },
  {
    tool: "pi_coder_git",
    allowedStates: new Set(["GIT_CHECKPOINT", "REVIEWING", "MERGING", "BLOCKED", "IDLE"]),
  },
];
```

Key differences from TDD action rules:
- `pi_coder_run_tests` allowed in ALL states (not just validation states)
- `pi-coder.researcher` allowed in `IMPLEMENTING` (may need context during implementation)
- No `NEEDS_CHANGES` non_functional evidence gate on implementor — wait, yes there is. The evidence gate is in the `tool_call` handler in the extension, not in the action rules. The action rules just say which states allow which agents. The evidence check on `NEEDS_CHANGES → implementor` stays in the extension's `tool_call` handler.

### 2.6 Nudge Expectations

```typescript
const NUDE_EXPECTATIONS: Record<LightFSMState, NudgeExpectation> = {
  IDLE: { shouldNudge: false, expectedAction: "", expectedTool: "" },
  SPEC_WORK: { shouldNudge: true, expectedAction: "Delegate to pi-coder.researcher or advance to SPEC_APPROVED", expectedTool: "subagent" },
  SPEC_APPROVED: { shouldNudge: false, expectedAction: "", expectedTool: "" },
  GIT_CHECKPOINT: { shouldNudge: true, expectedAction: "Create git checkpoint", expectedTool: "pi_coder_git" },
  IMPLEMENTING: { shouldNudge: true, expectedAction: "Delegate to pi-coder.implementor", expectedTool: "subagent" },
  REVIEWING: { shouldNudge: true, expectedAction: "Delegate to pi-coder.reviewer", expectedTool: "subagent" },
  APPROVED: { shouldNudge: false, expectedAction: "", expectedTool: "" },
  NEEDS_CHANGES: { shouldNudge: true, expectedAction: "Delegate implementor for non-functional fix, then advance to REVIEWING; or advance to IMPLEMENTING for functional fix", expectedTool: "subagent" },
  FINAL_APPROVAL: { shouldNudge: false, expectedAction: "", expectedTool: "" },
  MERGING: { shouldNudge: true, expectedAction: "Merge feature branch", expectedTool: "pi_coder_git" },
  COMPLETE: { shouldNudge: false, expectedAction: "", expectedTool: "" },
  BLOCKED: { shouldNudge: true, expectedAction: "Present recovery options to user", expectedTool: "" },
};
```

### 2.7 Evidence

```typescript
const PERSISTENT_EVIDENCE: Set<EvidenceFlag> = new Set([
  "spec_saved", "spec_user_approved", "non_functional_classified"
]);
```

Same as TDD. `test_run_this_state` remains transient — it's just never set

### 2.8 Circuit Breaker

Same logic: `loopCount >= maxLoops`. `loopCount` increments on:
- `NEEDS_CHANGES → IMPLEMENTING` (event: `reimplement`) — same as TDD's `NEEDS_CHANGES → TDD_RED_WRITE`
- `NEEDS_CHANGES → REVIEWING` (event: `non_functional_fix`) — same as TDD

### 2.9 `fromJSON` / `toJSON`

Same pattern as `StateMachine.fromJSON`. Serializes `currentState` (as

---

## 3. Mode-Specific Tool Lists

### 3.1 Plan Mode Tools — NEW

```typescript
export const PLAN_TOOLS = [
  "ls",
  "find",
  "grep",
  "subagent",
  "upsert_knowledge",
  "interview",
  "intercom",
];
```

No `pi_coder_git`, `pi_coder_run_tests`, `pi_coder_save_spec`,
`pi_coder_read_spec`, or `pi_coder_advance_fsm`.

### 3.2 Light Mode Tools — UPDATED

```typescript
export const LIGHT_TOOLS = [
  "ls",
  "find",
  "grep",
  "subagent",
  "pi_coder_run_tests",
  "pi_coder_git",
  "pi_coder_save_spec",
  "pi_coder_read_spec",
  "pi_coder_advance_fsm",
  "upsert_knowledge",
  "interview",
  "intercom",
];
```

Added `pi_coder_save_spec`, `pi_coder_read_spec`, `pi_coder_advance_fsm`.
Light mode now has a FSM and spec workflow — it needs these tools.

### 3.3 TDD Mode Tools — UNCHANGED

```typescript
export const ORCHESTRATOR_TOOLS = [
  "ls",
  "find",
  "grep",
  "subagent",
  "pi_coder_git",
  "pi_coder_run_tests",
  "upsert_knowledge",
  "pi_coder_save_spec",
  "pi_coder_read_spec",
  "pi_coder_advance_fsm",
  "interview",
  "intercom",
];
```

No changes.

### 3.4 Off Mode Tools — UNCHANGED

```typescript
export const NORMAL_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
```

---

## 4. Extension (`extensions/index.ts`) Changes

### 4.1 State Machine Variable

```typescript
// Before
let stateMachine: StateMachine;

// After
import { LightStateMachine } from "../src/light-state-machine.ts";

let stateMachine: IStateMachine | null;
```

`null` when in Plan or Off mode. Set to `StateMachine` instance in TDD,
`LightStateMachine` instance in Light.

### 4.2 Mode Selection Menu (`/pi-coder` command)

```typescript
const modes = [
  { value: "plan", label: `Plan Mode (investigation & discussion)${current === "plan" ? "  ◀" : ""}` },
  { value: "light", label: `Light Mode (spec → implement → review)${current === "light" ? "  ◀" : ""}` },
  { value: "tdd", label: `TDD Mode (full RED/GREEN lifecycle)${current === "tdd" ? "  ◀" : ""}` },
  { value: "off", label: `Off (normal Pi)${current === "off" ? "  ◀" : ""}` },
];
```

### 4.3 Mode Switch Logic

When switching **to** a mode:

| Target | `stateMachine` | `setActiveTools` | Nudge | Implementor gate |
|--------|---------------|-------------------|-------|-----------------|
| `plan` | `null` | `PLAN_TOOLS` | Off | N/A |
| `light` | New `LightStateMachine` (or restore from per-spec state) | `LIGHT_TOOLS` | On | Turn-boundary gate |
| `tdd` | New `StateMachine` (or restore from per-spec state) | `ORCHESTRATOR_TOOLS` | On | FSM-only (remove turn-boundary gate) |
| `off` | `null` | `NORMAL_TOOLS` | Off | N/A |

When switching **from** a mode with an active FSM (Light or TDD):

- If `stateMachine` is not `null` and `stateMachine.currentState !== "IDLE"`:
  - Log the mode switch with current FSM state
  - Set `stateMachine = null` (abandons in-memory FSM)
  - Per-spec `state.json` on disk is NOT deleted — user can switch back and restore
  - Global `state.json` retains `activeSpecId` for potential restore
  - Send steer: `"🔄 Mode switched. Active spec '${activeSpecId}' is paused. Switch back to resume."`

When switching **from** Plan mode:
- No FSM state to worry about. Just switch.

### 4.4 `before_agent_start` — System Prompt

```typescript
// Mode indicator
const modeIndicator: Record<PiCoderMode, string> = {
  off: "",  // Never reached — off mode returns early
  plan: "[MODE: PLAN] Investigation and discussion only. Delegate to pi-coder.researcher for investigation. No implementation, no specs, no git.",
  light: "[MODE: LIGHT] FSM is active. Follow the lifecycle: spec → implement → review → merge. No TDD phases.",
  tdd: "[MODE: TDD] FSM state machine is active. Follow the TDD lifecycle: spec → RED/GREEN → review → merge.",
};

// Mode tool selection
const modeTools: Record<PiCoderMode, string[]> = {
  off: NORMAL_TOOLS,
  plan: PLAN_TOOLS,
  light: LIGHT_TOOLS,
  tdd: ORCHESTRATOR_TOOLS,
};

// Mode prompt builder
let orchestratorPrompt: string;
if (piCoderMode === "tdd") {
  orchestratorPrompt = buildOrchestratorPrompt(stateMachine!, filteredSnippets);
} else if (piCoderMode === "light") {
  orchestratorPrompt = buildLightModePrompt(stateMachine as LightStateMachine, filteredSnippets);
} else { // plan
  orchestratorPrompt = buildPlanModePrompt(filteredSnippets);
}
```

### 4.5 Nudge System

```typescript
// Nudge fires in both TDD and Light modes (both have FSM states)
if (piCoderMode === "tdd" || piCoderMode === "light") {
  // ... existing nudge logic, using stateMachine!.currentState etc.
}
```

Currently gated on `piCoderMode === "tdd"`. Expand to include `"light"`.

### 4.6 `tool_call` Handler

#### 4.6.1 Default-Deny Tool Check

```typescript
const toolSets: Record<PiCoderMode, string[]> = {
  off: NORMAL_TOOLS,
  plan: PLAN_TOOLS,
  light: LIGHT_TOOLS,
  tdd: ORCHESTRATOR_TOOLS,
};
const allowedTools = toolSets[piCoderMode];
```

Currently: `piCoderMode === "tdd" ? ORCHESTRATOR_TOOLS : LIGHT_TOOLS`.
Must now be a 4-way branch (or lookup table).

#### 4.6.2 Plan Mode Subagent Restriction

```typescript
if (piCoderMode === "plan" && targetAgent !== "pi-coder.researcher") {
  logEvent("tool_call_blocked", {
    toolName, targetAgent, mode: "plan",
    reason: "non_researcher_in_plan_mode",
  });
  return {
    block: true,
    reason: `🛡️ Only pi-coder.researcher is available in Plan mode. "${targetAgent}" requires leaving plan mode — use /pi-coder to switch to Light or TDD mode. Do not retry this exact call.`,
  };
}
```

This is the plan-mode equivalent of the FSM subagent validation — an
explicit allowlist of one agent.

#### 4.6.3 FSM-Based Subagent Validation (Light + TDD)

The existing `if (piCoderMode === "tdd") { ... }` block that validates
subagent delegation against FSM state must be expanded:

```typescript
if (piCoderMode === "tdd" || piCoderMode === "light") {
  if (!stateMachine!.isActionAllowed("subagent", targetAgent)) {
    // ... contextual guidance (same pattern, different state names for light)
  }

  // NEEDS_CHANGES evidence gate — same for both modes
  if (
    targetAgent === "pi-coder.implementor" &&
    stateMachine!.currentState === "NEEDS_CHANGES" &&
    !stateMachine!.hasEvidence("non_functional_classified")
  ) {
    // ... same block reason, but "advance to IMPLEMENTING" instead of
    // "advance to TDD_RED_WRITE" for light mode
  }
}
```

#### 4.6.4 Light Mode Implementor Gate — REMOVE

The `lightModeImplementorBlockedAtTurn` + turn-boundary gate is
**deleted entirely**. Light mode now has a FSM that enforces
"spec before code." The implementor gate was a substitute for FSM
enforcement. With a proper FSM, it's redundant — the action rules
already block implementor delegation until `IMPLEMENTING` state.

The gate was designed for the old "no FSM" light mode where nothing
prevented the orchestrator from jumping straight to implementation.
Now `SPEC_WORK → SPEC_APPROVED → GIT_CHECKPOINT → IMPLEMENTING` must
be traversed before implementor can be delegated. Same enforcement,
better mechanism.

Variables to remove:
- `lightModeImplementorBlockedAtTurn`
- The entire `if (piCoderMode === "light" && targetAgent === "pi-coder.implementor")` block in `tool_call`
- Reset logic in mode switch and session start

#### 4.6.5 `pi_coder_git` FSM Validation (Light + TDD)

Currently gated on `piCoderMode === "tdd"`. Expand:

```typescript
if (piCoderMode === "tdd" || piCoderMode === "light") {
  if (toolName === "pi_coder_git") {
    if (!stateMachine!.isActionAllowed("pi_coder_git")) {
      // ... same block reason pattern
    }
  }
}
```

Light mode's `LightStateMachine.ACTION_RULES` already has the correct
allowed states for `pi_coder_git`.

### 4.7 `tool_result` Handler

#### 4.7.1 Interview Evidence (Light + TDD)

Currently: `if (piCoderMode === "tdd" && toolName === "interview" && ...)`

```typescript
if ((piCoderMode === "tdd" || piCoderMode === "light") && toolName === "interview" && stateMachine!.currentState === "SPEC_WORK") {
  stateMachine!.setEvidence("spec_user_approved");
}
```

Both modes need `spec_user_approved` evidence for the SPEC_WORK →
SPEC_APPROVED transition guard.

#### 4.7.2 `pi_coder_run_tests` Auto-Transitions (TDD only)

The entire test-validation block (`TDD_RED_VALIDATE`, `TDD_GREEN_VALIDATE`)
fires only in TDD mode. This is already guarded by `isTddValidation`
in the tool's execute method and by `currentState === "TDD_RED_VALIDATE"`
checks. **No changes needed.**

For light mode, `pi_coder_run_tests` returns results with no
auto-transitions. The tool result is the raw test output for the
orchestrator's information.

#### 4.7.3 Git Auto-Transitions (Light + TDD)

```typescript
// GIT_CHECKPOINT → next state (auto)
if (toolName === "pi_coder_git" && stateMachine?.currentState === "GIT_CHECKPOINT") {
  if (piCoderMode === "tdd") {
    stateMachine.transition("TDD_RED_WRITE");
  } else if (piCoderMode === "light") {
    stateMachine.transition("IMPLEMENTING");
  }
  // ... log, persist, append transition steer
}
```

Similarly for `MERGING → COMPLETE` (same target in both modes).

#### 4.7.4 Review Verdict Auto-Transition (Light + TDD)

The `extractReviewVerdict` function extracts `APPROVED` or `NEEDS_CHANGES`
from reviewer output. Both modes use it.

For TDD: `NEEDS_CHANGES → TDD_RED_WRITE` or `NEEDS_CHANGES → REVIEWING`
For Light: `NEEDS_CHANGES → IMPLEMENTING` or `NEEDS_CHANGES → REVIEWING`

```typescript
if (stateMachine?.currentState === "REVIEWING") {
  const verdict = extractReviewVerdict(rawContent, details);
  if (verdict?.verdict === "APPROVED") {
    stateMachine.transition("APPROVED");
  } else if (verdict?.verdict === "NEEDS_CHANGES") {
    stateMachine.transition("NEEDS_CHANGES");
    if (verdict.fixType === "non-functional") {
      stateMachine.setEvidence("non_functional_classified");
    }
  }
}
```

Same logic, different transition targets. The `extractReviewVerdict`
function is mode-agnostic — it just extracts text from the reviewer output.

### 4.8 `refreshUI` / Status Widget

Currently: `if (piCoderMode === "light")` shows "⚡ light mode".

```typescript
if (piCoderMode === "plan") {
  // Show "🔍 plan mode" indicator, no FSM state
  ctx.ui.setStatus("pi-coder", theme.fg("accent", "🔍 plan mode"));
} else if (piCoderMode === "light") {
  // Show "⚡ light" + FSM state
  let widgetLine = theme.fg("accent", "⚡ Light");
  if (stateMachine) {
    widgetLine += ` | ${stateMachine.currentState}`;
  }
  ctx.ui.setStatus("pi-coder", widgetLine);
} else if (piCoderMode === "tdd") {
  // Existing TDD widget logic
}
```

---

## 5. State Persistence Changes

### 5.1 Global State

`GlobalState.piCoderMode` now stores `"off" | "plan" | "light" | "tdd"`.

Migration: existing `"light"` values remain valid with new semantics.
No migration needed — `"light"` meant "no FSM" before, now it means
"light FSM." The per-spec `state.json` will need to be compatible.

### 5.2 Per-Spec State

`SpecState.currentState` stores either a `FSMState` or `LightFSMState`.

The persistence layer must handle both. On restore, determine which
state machine to instantiate based on the current `piCoderMode`:

```typescript
if (piCoderMode === "tdd") {
  stateMachine = StateMachine.fromJSON(specState, config);
} else if (piCoderMode === "light") {
  stateMachine = LightStateMachine.fromJSON(specState, config);
}
```

This means: **a spec created in TDD mode cannot be resumed in Light mode**
(and vice versa), because the state values differ (`TDD_RED_WRITE` vs
`IMPLEMENTING`). This is acceptable — a spec's FSM state is tied to the
mode it was created in. If the user switches modes mid-spec, the spec
is paused (state stays on disk) and can be resumed when they switch back.

### 5.3 Validation

`GlobalStatePersistence.validate()` must accept all four mode values:

```typescript
if (typeof obj.piCoderMode !== "string" || !["off", "plan", "light", "tdd"].includes(obj.piCoderMode)) {
  return false;
}
```

Currently validates against `["off", "light", "tdd"]`. Add `"plan"`.

---

## 6. Prompt Files

### 6.1 `prompts/pi-coder-plan.md` — NEW

Frontmatter:
```yaml
---
name: plan
package: pi-coder
description: Investigation and discussion assistant — researcher delegation only
tools: ls, find, grep, subagent, upsert_knowledge, interview, intercom
systemPromptMode: replace
inheritProjectContext: false
defaultContext: fresh
---
```

Key content:
- Identifies as Pi Coder Plan Mode
- Only delegate to `pi-coder.researcher` — no implementor, no reviewer
- No specs, no git, no FSM state machine
- Purpose: deep investigation, codebase understanding, architectural discussion
- Use `interview` for structured requirements gathering
- Use `upsert_knowledge` to persist findings for later Light/TDD sessions
- When investigation reveals something worth implementing: suggest the user switch to Light or TDD mode with `/pi-coder`
- `{{interviewTimeout}}` template variable
- `{{referenceProjects}}` template variable
- No FSM diagram, no state-specific instructions, no TDD terminology

### 6.2 `prompts/pi-coder-light.md` — REWRITTEN

Frontmatter:
```yaml
---
name: light
package: pi-coder
description: Lightweight lifecycle with spec, implementation, and review — no TDD phases
tools: ls, find, grep, subagent, pi_coder_run_tests, pi_coder_git, pi_coder_save_spec, pi_coder_read_spec, pi_coder_advance_fsm, upsert_knowledge, interview, intercom
systemPromptMode: replace
inheritProjectContext: false
defaultContext: fresh
---
```

Key changes from current version:
- **Remove "No FSM" language** — light mode now has an FSM
- Include the Light mode FSM diagram (states and transitions from §2.3)
- Explain `IMPLEMENTING` state: delegate implementor, optional test runs
- Explain transition from `IMPLEMENTING → REVIEWING`: must complete then
  use `pi_coder_advance_fsm` with targetState `"REVIEWING"`
- `test_run_this_state` evidence is NEVER set in light mode (no TDD gates)
- `pi_coder_run_tests` is advisory — use it freely, but it doesn't gate transitions
- `pi_coder_save_spec` + interview approval required before implementation
- NEEDS_CHANGES fix paths: `IMPLEMENTING` (functional) or `REVIEWING` (non-functional, with evidence)
- `Fix-Type: non-functional` in reviewer verdict for non-functional shortcut
- `fixType="non-functional"` escape hatch on `pi_coder_advance_fsm`
- Template variables: `{{fsmDiagram}}`, `{{currentState}}`, `{{activeSpecId}}`,
  `{{loopCount}}`, `{{maxLoops}}`, `{{interviewTimeout}}`, `{{toolList}}`,
  `{{referenceProjects}}`
- Subagent management section (same as current)
- Knowledge co-location rules (same as current)

### 6.3 `prompts/pi-coder-orchestrator.md` — UNCHANGED

TDD mode prompt remains exactly as-is. All references to TDD states,
RED/GREEN phases, and `test_run_this_state` evidence are TDD-specific.

### 6.4 `buildLightModePrompt()` — UPDATED

Currently reads `prompts/pi-coder-light.md` and injects `{{toolList}}`
and `{{referenceProjects}}`. Updated to also inject all FSM template
variables (same as `buildOrchestratorPrompt()`):

```typescript
function buildLightModePrompt(sm: LightStateMachine, filteredSnippets: Record<string, string>): string {
  // Read template, strip frontmatter
  // Inject template variables:
  //   {{fsmDiagram}} — Light mode FSM diagram
  //   {{currentState}} — sm.currentState
  //   {{activeSpecId}} — activeSpecId ?? "none"
  //   {{loopCount}} — sm.loopCount
  //   {{maxLoops}} — config.maxLoops
  //   {{interviewTimeout}} — config.interviewTimeout
  //   {{toolList}} — filteredSnippets joined
  //   {{referenceProjects}} — formatted reference projects
  return populatedTemplate;
}
```

### 6.5 `buildPlanModePrompt()` — NEW

```typescript
function buildPlanModePrompt(filteredSnippets: Record<string, string>): string {
  // Read prompts/pi-coder-plan.md, strip frontmatter
  // Inject:
  //   {{interviewTimeout}} — config.interviewTimeout
  //   {{toolList}} — filteredSnippets joined
  //   {{referenceProjects}} — formatted reference projects
  // No FSM variables — plan mode has no state machine
  return populatedTemplate;
}
```

---

## 7. `pi_coder_advance_fsm` Tool Changes

### 7.1 Target State Validation

Currently the tool's execute function calls
`stateMachine.transition(targetState)` and catches
`TransitionGuardError`. This works for both `StateMachine` and
`LightStateMachine` since both implement `IStateMachine.transition()`.

**No changes to the tool's core logic.** The `fixType` parameter and
evidence-setting logic are mode-agnostic.

### 7.2 Parameter Schema

`targetState` currently validates against `FSMState` union values.
For light mode, valid targets are different (e.g. `"IMPLEMENTING"`
instead of `"TDD_RED_WRITE"`).

Update: remove static enum validation from the parameter schema.
The `transition()` method itself validates — if the target is not a
legal transition, it throws. Valid transitions are discoverable via
`getValidTransitions()`.

### 7.3 State-Specific Hints

The `NEXT_ACTION_HINTS` map (or equivalent) must include hints for
light-mode states:

```typescript
// Added for Light mode
IMPLEMENTING: "Delegate to pi-coder.implementor to implement the spec. When complete, advance to REVIEWING.",
```

The TDD-specific hints (`TDD_RED_WRITE`, `TDD_GREEN_WRITE`, etc.) remain
for TDD mode.

---

## 8. SKILL.md Changes

### 8.1 Mode Descriptions

Update the three-mode section:
- **Plan**: Investigation and discussion only. Delegate researcher. No spec, no FSM, no git. Use when exploring a codebase or thinking through an approach.
- **Light**: Spec → Implement → Review → Merge. No TDD RED/GREEN phases. Use when you want structured process without test-first discipline.
- **TDD**: Full lifecycle with spec, RED/GREEN phases, and review. Use for maximum discipline on complex features.

### 8.2 Delegation Section

Add plan mode rules:
- Plan mode: only `pi-coder.researcher` is available
- Light mode: all three subagents available, FSM-gated
- TDD mode: all three subagents available, FSM-gated with additional TDD evidence

---

## 9. README Changes

### 9.1 Modes Section

Rewrite with four modes (including Off). Include FSM diagrams for Light
and TDD. Plain-English description of each mode's flow.

### 9.2 Light Mode FSM Diagram

```
IDLE → SPEC_WORK → SPEC_APPROVED → GIT_CHECKPOINT → IMPLEMENTING → REVIEWING → APPROVED → FINAL_APPROVAL → MERGING → COMPLETE
                                                                      ↘ NEEDS_CHANGES ↗
                                                        NEEDS_CHANGES → IMPLEMENTING (functional fix)
                                                        NEEDS_CHANGES → REVIEWING (non-functional fix)
```

### 9.3 When to Use Each Mode

| Situation | Mode |
|-----------|------|
| "I need to understand this codebase first" | Plan |
| "I want a plan/spec before someone touches code" | Plan → then Light or TDD |
| "Build this feature, no TDD ceremony" | Light |
| "This is a complex feature requiring test-first discipline" | TDD |
| "Just a quick investigation" | Plan |
| "Small bugfix, spec feels overkill but I want review" | Light |
| "Pausing one approach to try another" | Switch modes |

### 9.4 Mode Switching

Document that:
- Switching away from Light/TDD with an active FSM pauses the spec
- Switching back resumes from the saved state
- Plan → Light/TDD carries conversation context naturally
- The orchestrator suggests `/pi-coder` when a task outgrows the current mode

---

## 10. Test Plan

### 10.1 New Test Files

| File | Tests | Description |
|------|-------|-------------|
| `src/light-state-machine.test.ts` | ~30 | Transitions, guards, evidence, action rules, circuit breaker, nudge |
| `src/types.test.ts` (extend) | ~5 | `LightFSMState` type, `PiCoderMode` includes `"plan"` |

### 10.2 Existing Tests That Need Updates

| File | Change | Risk |
|------|--------|------|
| `extensions/index.test.ts` | Mode defaults to `"tdd"`, add plan mode assertions | Low |
| `extensions/index-prompt.test.ts` | Add plan mode prompt tests | Medium |
| `extensions/index-commands.test.ts` | Mode select menu has 4 options | Low |
| `src/state-persistence.test.ts` | Validate `"plan"` mode, light FSM state restore | Low |
| `src/state-machine.test.ts` | None — TDD FSM is unchanged | None |
| `src/tools.test.ts` | `pi_coder_advance_fsm` with light states | Medium |

### 10.3 Regression Checklist

For each TDD-mode behavior, verify it's unchanged:

- [ ] Full FSM state machine transitions (all 19 LEGAL_TRANSITIONS)
- [ ] Evidence guards: `spec_saved` + `spec_user_approved` on SPEC_WORK → SPEC_APPROVED
- [ ] Evidence guards: `test_run_this_state` on TDD_RED_VALIDATE → TDD_GREEN_WRITE
- [ ] Evidence guards: `test_run_this_state` on TDD_GREEN_VALIDATE → REVIEWING
- [ ] Evidence guards: `non_functional_classified` on NEEDS_CHANGES → REVIEWING
- [ ] Action rules: implementor blocked in SPEC_WORK
- [ ] Action rules: reviewer blocked except in REVIEWING
- [ ] Action rules: pi_coder_git restricted to valid states
- [ ] Auto-transitions: GIT_CHECKPOINT → TDD_RED_WRITE on git success
- [ ] Auto-transitions: TDD_RED_VALIDATE → TDD_GREEN_WRITE on tests fail
- [ ] Auto-transitions: TDD_GREEN_VALIDATE → TDD_GREEN_WRITE on tests still fail
- [ ] Auto-transitions: MERGING → COMPLETE on merge success
- [ ] Auto-transitions: Review verdict → APPROVED or NEEDS_CHANGES
- [ ] Nudge system fires in TDD mode
- [ ] `pi_coder_advance_fsm` with `fixType="non-functional"` sets evidence
- [ ] RED tautology acknowledge transition
- [ ] Circuit breaker on max loops
- [ ] Default-deny tool call for non-ORCHESTRATOR_TOOLS
- [ ] Subagent scoping to pi-coder.* agents only
- [ ] Self-delegation blocked
- [ ] Damage-control CWD write boundary guard
- [ ] State persistence and restore
- [ ] `.pi-coder/.gitignore` creation on init
- [ ] Stale subagent notification suppression (no steer delivery)
- [ ] Desktop notifications
- [ ] Config defaults (testCommand, maxLoops, etc.)

---

## 11. Implementation Order

1. **Types** — Add `PiCoderMode` values, `LightFSMState`, `IStateMachine`
2. **`LightStateMachine`** — New file with full implementation
3. **`PLAN_TOOLS` + updated `LIGHT_TOOLS`** — Extension constants
4. **Mode selection menu** — 4 options in `/pi-coder`
5. **`buildPlanModePrompt()` + `buildLightModePrompt()` update** — Prompt builde
6. **`prompts/pi-coder-plan.md`** — New prompt file
7. **`prompts/pi-coder-light.md`** — Rewrite with FSM
8. **Extension `tool_call` handler** — Plan mode restrictions, FSM validation for light, remove implementor gate
9. **Extension `tool_result` handler** — Interview evidence for light, git auto-transitions for light, review verdict for light
10. **Extension `before_agent_start`** — 4-way mode branching, nudge for light, mode indicator
11. **State persistence** — Validate `"plan"`, light state machine restore
12. **`refreshUI`** — Plan mode indicator
13. **`pi_coder_advance_fsm` tool** — Accept light mode state names
14. **SKILL.md + README.md** — Documentation
15. **Tests** — `light-state-machine.test.ts`, existing test updates

---

## 12. Scope Boundaries

### In Scope
- `LightStateMachine` class with full transition table, guards, action rules
- `IStateMachine` interface
- Plan mode (tools, prompt, delegation restriction)
- Light mode FSM (IMPLEMENTING state, spec/implement/review flow)
- Removal of `lightModeImplementorBlockedAtTurn` turn-boundary gate
- Updated mode selection menu
- Updated state persistence
- All documentation

### Out of Scope
- Spec re-opening (separate feature)
- Async subagent support (future)
- Cross-mode spec migration (can't resume TDD spec in Light mode and vice versa)
- Any changes to the TDD `StateMachine` class internals
- Any changes to agent `.md` files (researcher, implementor, reviewer)
- Any changes to `damage-control.ts`
- Any changes to `desktop-notifier.ts`
- Any changes to `git.ts`
