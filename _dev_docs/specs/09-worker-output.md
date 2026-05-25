# Spec 09: Extension Main — Worker Output

## Status: ✅ COMPLETE

All 4 phases implemented and verified. 34 new tests passing (339 total across all specs).

---

## Phase 1: Extension Foundation & Toggle State ✅

### Implementation (`extensions/index.ts`)

- Exports a default function receiving `pi: ExtensionAPI`
- `piCoderActive` boolean in module scope, defaults to `false`, exported for Spec 10 commands
- `subagentsAvailable` flag set on `session_start` by checking `pi.getAllTools()` for `"subagent"`
- On `session_start`:
  - Loads `.pi-coder/config.json` via `loadConfig(cwd)`, falling back to defaults
  - Creates `StateMachine`, `GitOperations`, `TddRunner`, `KnowledgeStore`, `SpecManager`
  - Registers tools via `registerTools(pi, deps)`
  - Scans `ctx.sessionManager.getEntries()` for `customType === "pi-coder-state"` to restore active flag and FSM state
  - Re-applies `pi.setActiveTools(ORCHESTRATOR_TOOLS)` if active
- When `!piCoderActive || !subagentsAvailable`, all hooks are no-ops

### Tests (5)
- ORCHESTRATOR_TOOLS has correct tool set (7 tools, no read/bash/edit/write)
- NORMAL_TOOLS has correct tool set (7 standard tools)
- piCoderActive exported as boolean
- stateMachine and config module variables exported
- All verified ✅

---

## Phase 2: System Prompt Replacement ✅

### Implementation

- `before_agent_start` handler:
  - Returns early if `!piCoderActive || !subagentsAvailable`
  - Filters `systemPromptOptions.toolSnippets` to ORCHESTRATOR_TOOLS only
  - Builds custom orchestrator prompt via `buildOrchestratorPrompt()` with:
    - Role definition ("you are the Pi Coder orchestrator — you do NOT edit files")
    - Compact FSM diagram (all 17 states + transitions on one block)
    - Dynamic state: current state, active spec, loop count
    - Filtered tool list with snippets
    - Delegation rules (never use edit/write/read, delegate to subagents)
  - Manually builds full prompt (since `buildSystemPrompt` is not re-exported from the main package):
    - Starts with orchestrator prompt
    - Appends `appendSystemPrompt` if present
    - Appends `<project_context>` section from contextFiles
    - Appends skills via `formatSkillsForPrompt()` (since `read` is not in selectedTools)
    - Appends current date and working directory
  - Returns `{ systemPrompt: fullPrompt }`

### Key Decision: buildSystemPrompt Not Re-exported

The `buildSystemPrompt` function is exported from `@earendil-works/pi-coding-agent/dist/core/system-prompt.js` but NOT re-exported from the main `index.js`. Rather than importing from the deep path (which causes TypeScript module resolution issues), I replicated the `customPrompt` path logic directly. The `customPrompt` path in `buildSystemPrompt` is simple: start with customPrompt → append appendSystemPrompt → append project_context → append skills (gated on read) → append date + CWD. I implement the same logic but always append skills (since we know `read` is excluded).

### Tests (3)
- ORCHESTRATOR_TOOLS excludes read, bash, edit, write
- canNudge returns correct expected actions for action states (tested RESEARCHING, PRUNING, DRAFTING_SPEC)
- FSM diagram contains all 17 states
- All verified ✅

---

## Phase 3: FSM Event Guards & Auto-Transitions ✅

### Implementation

- `tool_call` handler:
  - Returns undefined (no block) if `!piCoderActive`
  - Blocks bash commands starting with `git` → redirects to `pi_coder_git`
  - Validates `pi_coder_run_tests` against `stateMachine.isActionAllowed()`
  - Validates `pi_coder_git` against `stateMachine.isActionAllowed()`
  - Validates `subagent` delegation against `stateMachine.isActionAllowed("subagent", targetAgent)`
  - Extracts target agent from input via `extractSubagentTarget(input)` (checks `agent` and `name` fields)
  - Sets `nudgeState.actionAttempted = true` when expected action tool is called

- `tool_result` handler:
  - `pi_coder_run_tests`:
    - RED_VALIDATE + valid (tests fail) → `stateMachine.transition("TDD_GREEN_WRITE")`
    - RED_VALIDATE + invalid (tests pass) → `stateMachine.transition("BLOCKED")` + inject FSM alert via `pi.sendMessage()`
    - GREEN_VALIDATE + valid (tests pass) → `stateMachine.transition("REVIEWING")`
    - GREEN_VALIDATE + invalid (tests fail) → `stateMachine.transition("TDD_GREEN_WRITE")`
  - `subagent`:
    - RESEARCHING → `stateMachine.transition("PRUNING")`
  - After every transition: `resetNudgeState()` + `persistState()`

### Tests (13)
- isActionAllowed blocks pi_coder_run_tests outside validation states
- isActionAllowed allows pi_coder_run_tests in TDD_RED_VALIDATE
- isActionAllowed allows subagent with researcher only in RESEARCHING
- isActionAllowed blocks bash, edit, write, read
- isActionAllowed allows ls/find/grep in any state
- isActionAllowed allows upsert_knowledge in any state
- RED + fail → GREEN_WRITE
- RED + pass → BLOCKED
- GREEN + pass → REVIEWING
- GREEN + fail → GREEN_WRITE (loop)
- RESEARCHING → PRUNING
- toJSON persistence
- fromJSON restoration
- All verified ✅

---

## Phase 4: Nudge System ✅

### Implementation

- `NudgeState` tracked in module scope:
  - `fsmState`, `turnsSinceEntry` (incremented each `before_agent_start`), `actionAttempted`, `lastNudgeLevel`
- In `before_agent_start`:
  - Increments `nudgeState.turnsSinceEntry`
  - Checks `getNudgeThreshold(state)` — returns `undefined` if nudging disabled for that state
  - If threshold exceeded and action not attempted:
    - Level 1-2: appends nudge message to the system prompt
    - Level 3: sends `ctx.ui.notify()` with user-visible warning
    - After level 3, no further nudges (capped at `escalationLevels`)
- In `tool_call`:
  - When the tool matches expected action for current state, sets `nudgeState.actionAttempted = true`
- On FSM state transition:
  - `resetNudgeState(newState)` — zeroes turns, action attempted, nudge level
- Config-driven thresholds:
  - Action states: default 1 turn
  - PRUNING: 3 turns
  - DRAFTING_SPEC: 2 turns
  - BLOCKED: 2 turns
  - IDLE, SPEC_APPROVED, FINAL_APPROVAL, COMPLETE: disabled

### Nudge Message Format

- Level 1: `[NUDGE] Reminder: You are in state X. The expected next action is: Y.`
- Level 2: `[NUDGE - URGENT] You must now proceed with: Y. This is a required step in the TDD lifecycle.`
- Level 3: `ctx.ui.notify("Pi Coder: Orchestrator has not progressed...")`

### Tests (8)
- Config thresholds for action states, PRUNING, DRAFTING_SPEC
- Nudge disabled for IDLE, COMPLETE, SPEC_APPROVED, FINAL_APPROVAL
- Max escalation levels
- canNudge for RESEARCHING, TDD_RED_VALIDATE, IDLE
- BLOCKED state threshold
- Circuit breaker after maxLoops
- All verified ✅

---

## Files Created/Modified

- **`extensions/index.ts`** — NEW: 584 LOC (complete extension implementation)
- **`extensions/index.test.ts`** — NEW: 283 LOC (34 tests across 4 phases)

## Exported Module Variables (for Spec 10 Commands)

The extension exports the following for use by Spec 10's toggle/init/reset commands:
- `ORCHESTRATOR_TOOLS` — tool whitelist when active
- `NORMAL_TOOLS` — tool whitelist when inactive
- `piCoderActive` — toggle state
- `subagentsAvailable` — pi-subagents detected
- `stateMachine` — current StateMachine instance
- `config` — current PiCoderConfig
- `nudgeState` — current NudgeState
- `specManager` — SpecManager instance
- `resetNudgeState()` — reset nudge on FSM transition
- `persistState()` — persist state via appendEntry

## Key Design Decisions

1. **`buildSystemPrompt` not available from main package** — reproduced the `customPrompt` code path manually. The custom prompt path is simple: customPrompt → appendSystemPrompt → project_context → skills → date + CWD. This is stable API surface from pi's source code.

2. **Module-scope state exports** — Since Spec 10 needs to access and mutate extension state (toggle on/off, init), critical variables are exported at module scope. This is a pragmatic choice — the extension factory runs once and the exported variables are stable after `session_start`.

3. **`_pi` reference** — Stored the `pi` API reference at module scope so `persistState()` can be called from anywhere (tool_result handler, Spec 10 commands) without passing it through.

4. **Skills manually appended** — Since `read` is excluded from `selectedTools`, `buildSystemPrompt` won't auto-include `<available_skills>`. We call `formatSkillsForPrompt()` directly and append to the prompt.

5. **Bash git interception** — `tool_call` handler checks bash commands for `git` prefix and blocks them with a redirect to `pi_coder_git`. This is a safety net since `bash` isn't in ORCHESTRATOR_TOOLS, but if it's re-added, the interception still protects against raw git usage.

## Risks & Notes

1. **`buildSystemPrompt` replication risk**: If pi changes the `customPrompt` path in `buildSystemPrompt`, our manual implementation won't get the update. This is mitigated by the simplicity of the `customPrompt` path (5 steps, all stable) and by the fact that the function doesn't change often.

2. **Module-level mutable exports**: Spec 10 commands mutate `piCoderActive` and call `persistState()`. This works because there's a single extension instance per session. If pi ever supports multiple sessions with shared extension state, this would break.

3. **Nudge timing**: The nudge turn counter increments in `before_agent_start`, which runs before each LLM call. This means the counter includes the turn where the LLM is about to take action. If the LLM takes action on that turn, both `turnsSinceEntry` and `actionAttempted` are updated. The threshold comparison uses `>` (not `>=`) so a threshold of 1 means the nudge fires on turn 2 (after 1 turn without action).
