# Pi Coder Tool-Call Blocking & Damage Control — Deep Analysis

## 1. How Tool Calls Are Blocked (`not_allowed_in_state` and others)

### 1.1 Two-Layer Blocking Architecture

Tool calls are blocked at **two independent layers** that both intercept `tool_call` events:

**Layer 1: Mode-based allowlist** (`tool-call.ts:32-56`)
- Determined by `MODE_TOOL_SETS[ctx.piCoderMode]` (defined in `constants.ts`)
- **Default-deny**: only tools in the current mode's list are permitted
- Modes and their tool sets:
  - `off` → `NORMAL_TOOLS` = `[read, bash, edit, write, grep, find, ls]`
  - `plan` → `PLAN_TOOLS` = `[ls, find, grep, subagent, upsert_knowledge, interview, intercom]`
  - `light` → `LIGHT_TOOLS` = `[ls, find, grep, subagent, pi_coder_run_tests, pi_coder_git, pi_coder_save_spec, pi_coder_read_spec, pi_coder_advance_fsm, upsert_knowledge, interview, intercom]`
  - `tdd` → `ORCHESTRATOR_TOOLS` = `[ls, find, grep, subagent, pi_coder_git, pi_coder_run_tests, upsert_knowledge, pi_coder_save_spec, pi_coder_read_spec, pi_coder_advance_fsm, interview, intercom]`

Blocked reason: `"not_in_allowed_tools"` — generates context-specific guidance (e.g., "You don't run commands directly — you delegate. Use the subagent tool...").

**Layer 2: FSM state-based action rules** (`tool-call.ts:62-155`)
- Only applies in `tdd` and `light` modes
- Checks `ctx.stateMachine!.isActionAllowed(toolName, targetAgent)` which queries `ActionRule<S>` entries in the state machine definition
- The `isActionAllowed` method (`base-state-machine.ts:305-332`):
  1. Always allows tools in the `_alwaysAllowed` set
  2. Iterates `actionRules` matching on `toolPattern` and optional `agents` list
  3. Returns `allowedStates.has(currentState)`
  4. Returns `false` for unknown tools (default-deny)

**Blocked reason: `"not_allowed_in_state"`** — logged at `tool-call.ts:149` with the FSM state and target agent.

### 1.2 Specific Blocking Rules

| Block Reason | When | Code Location |
|---|---|---|
| `not_in_allowed_tools` | Tool not in mode's tool set | `tool-call.ts:39-56` |
| `raw_git_blocked` | `bash` tool with `git ` prefix command | `tool-call.ts:58-64` |
| `not_allowed_in_state` (pi_coder_git) | Git tool not allowed in current FSM state | `tool-call.ts:67-78` |
| `not_allowed_in_state` (subagent) | Subagent target not allowed in current FSM state | `tool-call.ts:128-155` |
| `non_pi_coder_agent` | Subagent target doesn't start with `pi-coder.` | `tool-call.ts:92-99` |
| `self_delegation` | Subagent target is `pi-coder.orchestrator` | `tool-call.ts:104-112` |
| `non_researcher_in_plan_mode` | Non-researcher subagent in plan mode | `tool-call.ts:115-123` |
| `missing_non_functional_evidence` | TDD implementor in NEEDS_CHANGES without `non_functional_classified` evidence | `tool-call.ts:156-172` |

### 1.3 FSM State → Allowed Subagent Map

The action rules create a state-dependent subagent access control matrix. Key examples from tests:

| FSM State | pi-coder.researcher | pi-coder.implementor | pi-coder.reviewer |
|---|---|---|---|
| IDLE | ❌ | ❌ | ❌ |
| SPEC_WORK | ✅ | ❌ | ❌ |
| SPEC_APPROVED | ❌ | ✅ | ❌ |
| TDD_RED_WRITE | ✅ (research) | ✅ | ❌ |
| TDD_GREEN_WRITE | ❌ | ✅ | ❌ |
| REVIEWING | ❌ | ❌ | ✅ |
| NEEDS_CHANGES | ❌ | ✅ (with evidence) | ❌ |

### 1.4 Blocking Returns Actionable Guidance

Every `return { block: true, reason: guidance }` includes:
- Why the tool was blocked
- What the correct next step is
- A `Do not retry this exact call` instruction to prevent retry loops

---

## 2. Damage Control System

### 2.1 Architecture

`extensions/damage-control.ts` is a **separate pi extension** (loaded via pi's auto-discovery at the package level). It applies to **all sessions** including subagents.

It intercepts `tool_call` events with its own `pi.on("tool_call", ...)` handler — running **independently of** the `tool-call.ts` handler. Both can block the same call.

### 2.2 Rule Categories

**Bash command patterns** (`bashToolPatterns`):
10 default regex patterns blocking destructive commands:
- `rm -rf`, `sudo`, `git push --force`, `git push --delete`, `git reset --hard`, `git clean -`, `drop database`, `chmod 777`, `truncate`, `mkfs`/`dd`

Each rule has an optional `ask` flag — if `true`, a UI confirmation dialog is presented instead of hard-blocking.

**Zero-access paths** (`zeroAccessPaths`): `[.env, .env.local, .env.production, ~/.ssh/, ~/.gnupg/]`
- Blocked for: read, write, edit, grep, find, ls, and bash commands referencing them
- Completely invisible to the agent

**Read-only paths** (`readOnlyPaths`): `[".git/config"]`
- Read is allowed, write/edit is blocked
- Bash commands that may modify these paths are blocked (detected via `rm`/`mv`/`sed`/redirect heuristics)

**No-delete paths** (`noDeletePaths`): `[".git/", "node_modules/"]`
- Write/edit is allowed, but `rm`/`mv` commands targeting these are blocked

**CWD write boundary** (`tool-call.ts:233-260` in damage-control.ts):
- Blocks `write`/`edit` tools targeting paths outside the project CWD
- Blocks bash commands that write outside CWD (detects redirects, `sed -i`, `tee`, `dd of=`, `cp`, `install`, `mv`, `awk -i inplace`)
- Reading outside the project is allowed — only writes are blocked

### 2.3 Path Matching

- Resolves `~` to `$HOME`
- Supports directory prefix matching (pattern ends with `/`)
- Supports glob-style `*` patterns via regex conversion
- Also uses `string.includes()` as a fallback broad match

### 2.4 Feedback Style

Blocked calls receive a "continue" style message (`continueFeedback()`) with two paths:
- **Non-destructive** (read .env, list dir, check config): "Assume the data is present and correct. Skip the verification step."
- **Destructive**: "STOP. Tell the user exactly what you need and ask how they want to proceed."

This is a key design principle: **blocking with actionable alternatives**, not just rejection.

### 2.5 Configurable Rules

Rules are loaded from `.pi-coder/damage-control.json` (project-scoped). If absent, defaults are used. The file supports partial overrides — unspecified categories fall back to defaults.

---

## 3. Verdict Extraction Failures (`verdict_extraction_failed`)

### 3.1 Multi-Tier Extraction

`extractReviewVerdict()` (`review-extraction.ts:181-330`) has a 3-tier fallback:

| Tier | Mechanism | Priority |
|---|---|---|
| 0 | Structured `---VERDICT---` block | Highest |
| 1 | Emoji markers (✅/❌/⚠️) — **last occurrence wins** | Medium |
| 2 | Text patterns (`**Verdict:** approved`, `approved`, `needs_changes`) | Lowest |

### 3.2 When Extraction Fails

If all three tiers return `null`, `extractReviewVerdict` returns `null`. The tool-result handler then (`tool-result.ts:460-490`):

1. Logs `verdict_extraction_failed` with diagnostics:
   - `hasFinalOutput`: whether `details.results[0].finalOutput` existed
   - `textLength`: length of extracted text
   - `firstHundredChars`: first 100 chars for debugging
   - `intercomReceiptDetected`: whether the raw content indicates intercom delivery

2. **Intercom receipt recovery path** (`tool-result.ts:474-483`):
   - If `isIntercomReceipt(rawContent)` returns `true`, sets `review_completed` evidence
   - Appends "DEGRADED RECOVERY" guidance telling the orchestrator to read the reviewer's output and manually advance to APPROVED or NEEDS_CHANGES
   - This handles the case where the intercom delivery receipt strips `finalOutput` from the Details object

3. **No-recovery path** (`tool-result.ts:484-490`):
   - Appends guidance: "Re-delegate the reviewer with explicit instructions to use the ---VERDICT--- block format"
   - Explicitly warns: "Do NOT skip review by advancing manually — the REVIEWING → APPROVED guard requires review_completed evidence."

### 3.3 No Automatic Retry

**There is no retry logic for failed verdict extractions.** The system does not automatically re-delegate the reviewer. Instead it relies on:
- Appending instructional text to the tool result
- The LLM reading the guidance and re-delegating on its next turn
- The `review_completed` evidence gate preventing manual ADVANCE without evidence

---

## 4. Nudge Engine

### 4.1 Purpose

The nudge engine prevents the orchestrator from stalling in a FSM state. When the LLM spends too many turns without taking the expected action, escalating reminders are injected.

### 4.2 State Tracking (`nudge-engine.ts`)

`NudgeState` tracks:
- `fsmState`: current FSM state
- `turnsSinceEntry`: turns since entering the state (incremented each `before_agent_start`)
- `actionAttempted`: whether a relevant action was attempted this state
- `lastNudgeLevel`: escalation level (0 = no nudge yet)

### 4.3 Nudge Lifecycle

**Increment**: `before-agent-start.ts:108` — increments `turnsSinceEntry` each agent turn (in `tdd`/`light` modes).

**Threshold check** (`before-agent-start.ts:111-148`):
- Gets threshold per-state via `getThreshold(config, state)`:
  - Per-state override via `config.nudge.states[state].turnsBeforeNudge`
  - Falls back to `config.nudge.defaults.turnsBeforeNudge` (default: 1)
- Some states have `enabled: false` (e.g., IDLE)
- Default thresholds: SPEC_WORK=3, BLOCKED=2, all others=1

**Firing conditions** (all must be true):
1. `threshold !== undefined` (nudging is enabled for this state)
2. `!actionAttempted` (no action taken since entering state)
3. `turnsSinceEntry > threshold`
4. `lastNudgeLevel < maxEscalation` (default: 3 levels)

**Escalation levels**:
- **Level 1-2**: Appended to system prompt via `buildMessage()`:
  - Level 1: `[NUDGE] Reminder: You are in state X. The expected next action is: Y.`
  - Level 2: `[NUDGE - URGENT] You must now proceed with: Y. This is a required step.`
- **Level 3**: User-visible `ui.notify()` warning asking if they want to intervene

**Reset triggers**:
- `nudgeEngine.reset(newState)` called on any FSM transition (in `tool-result.ts` at lines 100, 259, 280, 317, 542)
- `actionAttempted = true` set when subagent/pi_coder_run_tests/pi_coder_git is called (in `tool-call.ts:238-244`)
- Reset clears `turnsSinceEntry` to 0, `actionAttempted` to false, and `lastNudgeLevel` to 0

---

## 5. Subagent Monitor

### 5.1 Purpose

`SubagentMonitor` (`subagent-monitor.ts`) tracks live subagent execution state for:
- UI widget rendering (shows which agent is running, what tool it's using, duration)
- Timing and usage metrics logged on completion

### 5.2 Tracked State

| Field | Type | Purpose |
|---|---|---|
| `running` | `boolean` | Whether a subagent is active |
| `activity` | `SubagentActivity \| null` | Live progress data |
| `startTime` | `number \| null` | `Date.now()` at delegation start |
| `lastAgent` | `string \| null` | Last invoked agent name |
| `widgetTimer` | `interval \| null` | 2-second refresh timer for UI widget |

`SubagentActivity` includes: agent name, task description, currentTool, currentPath, toolCount, turnCount, tokens, durationMs, recentTools, lastUpdatedAt.

### 5.3 Lifecycle

1. **Start**: Set on `tool_call` for `subagent` — populates activity, starts 2s UI refresh timer
2. **Update**: Updated via `tool_execution_update` events (calling `updateActivity()`)
3. **Stop**: Called on `tool_result` for `subagent` — clears all state, stops timer, refreshes widget

### 5.4 Integration Points

- `tool-call.ts:217-239`: Sets up monitor state on delegation
- `tool-result.ts:324-337`: Stops monitor, logs `subagent_end` event with token usage/duration
- Session summary notifications sent via `ctx.sessionCtx?.ui.notify()`

---

## 6. Circuit Breaker & Loop Detection

### 6.1 Loop Counting

**Loop counter** (`base-state-machine.ts:137,264`):
- Incremented when transitioning **out of** `NEEDS_CHANGES` to any state other than `IDLE` or `BLOCKED`:
  ```typescript
  if (from === "NEEDS_CHANGES" && to !== "IDLE" && to !== "BLOCKED") {
    this._loopCount++;
  }
  ```
- Reset to 0 when entering `IDLE`

This means each review-implement cycle that returns to `NEEDS_CHANGES` increments the loop. The loop count represents "how many times the reviewer said needs_changes and we tried again."

### 6.2 Circuit Breaker Trip

`circuitBreakerTripped()` (`base-state-machine.ts:285-287`):
```typescript
circuitBreakerTripped(): boolean {
  return this._loopCount >= this._config.maxLoops;
}
```

Default `maxLoops`: 3 (from `config.ts:19`).

### 6.3 Where Circuit Breaker Is Checked

Checked in `tool-result.ts` after **every** FSM transition that changes state:

1. **After TDD validation auto-transitions** (`tool-result.ts:168-186`):
   - Logs `circuit_breaker` event if tripped
   - Sends desktop notification: "🔴 Circuit Breaker — Max review loops (N) exceeded"

2. **After subagent result transitions** (`tool-result.ts:520-528`):
   - Same logging and notification

### 6.4 Circuit Breaker Override

From `tools.ts:844-849`: The `pi_coder_advance_fsm` tool has a circuit breaker override path:
- Allows transitions even when circuit breaker is tripped
- Logs `interventionType: "circuit_breaker_override"` with loop count
- This enables the orchestrator/user to manually advance past the circuit breaker

### 6.5 What Circuit Breaker Does NOT Do

The circuit breaker **does not block tool calls**. It is purely a notification/logging mechanism. It does not:
- Block any tool_call
- Force the FSM into BLOCKED state
- Prevent further subagent delegations

The actual blocking of inappropriate subagent calls in NEEDS_CHANGES is done by the `missing_non_functional_evidence` guard (`tool-call.ts:156-172`), which is separate from the circuit breaker.

---

## 7. Summary: Defense-in-Depth Layers

```
Tool Call Flow:
  ┌─────────────────────────────┐
  │ 1. Damage Control Extension  │ ← Path/bash pattern blocking (all sessions)
  │    (extensions/damage-control)│
  └──────────┬──────────────────┘
             │
  ┌──────────▼──────────────────┐
  │ 2. Mode Allowlist            │ ← MODE_TOOL_SETS[mode] check
  │    (tool-call.ts:32-56)      │    "not_in_allowed_tools"
  └──────────┬──────────────────┘
             │
  ┌──────────▼──────────────────┐
  │ 3. FSM Action Rules          │ ← isActionAllowed(tool, agent)
  │    (tool-call.ts:62-155)     │    "not_allowed_in_state"
  │    + Git safety check        │    + raw git blocking
  │    + Self-delegation block   │    + non_pi_coder_agent
  │    + Evidence gates          │    + missing_non_functional_evidence
  └──────────┬──────────────────┘
             │
  ┌──────────▼──────────────────┐
  │ 4. Tool Result Processing    │ ← Auto-transitions, verdict extraction
  │    (tool-result.ts)          │    + verdict_extraction_failed handling
  │    + Review verdict → FSM   │    + Intercom receipt recovery
  │    + Test validation → FSM  │    + Circuit breaker logging
  └──────────┬──────────────────┘
             │
  ┌──────────▼──────────────────┐
  │ 5. Nudge System             │ ← Falls through if agent stalls
  │    (before-agent-start.ts)  │    3-level escalation
  └─────────────────────────────┘
```

### Key Design Principles

1. **Default-deny at every layer**: Unknown tools → blocked; wrong state → blocked; wrong agent → blocked
2. **Actionable blocking messages**: Every block tells the LLM what to do instead, with `Do not retry this exact call`
3. **Evidence-gated transitions**: APPROVED requires `review_completed`; NEEDS_CHANGES→implementor requires `non_functional_classified`
4. **Graceful degradation on verdict failure**: Intercom-receipt-aware recovery path; manual advancement blocked without evidence
5. **No silent failures**: `verdict_extraction_failed` is logged with diagnostics; circuit breaker events are logged and notified
6. **Circuit breaker is advisory**: Logs/notifications only; does not force FSM state; human override via `pi_coder_advance_fsm` is allowed
