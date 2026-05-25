# Spec 09: Extension Main — Core Event Hooks & System Prompt

## Context

This is the heart of pi-coder. The extension intercepts pi's `before_agent_start`, `tool_call`, and `tool_result` events to: replace the system prompt with the orchestrator identity, guard tool calls against FSM state, auto-transition the FSM on deterministic results, and implement the per-state nudge system.

## Dependencies

Spec 02 (state machine), Spec 07 (tools — must be registered before events fire), Spec 08 (agent files — system prompt references agent names)

---

## Phase 1: Extension Foundation & Toggle State

### Acceptance Criteria

- The extension is a valid pi extension that pi can load
- Active/inactive state persists across session restarts via `appendEntry`
- When inactive, all extension hooks are no-ops — pi runs normally
- pi-subagents availability is checked and toggling is blocked if missing

### Tasks

1. Create `extensions/index.ts` that exports a default function receiving `pi`, which calls `registerTools()` and sets up all event handlers
2. Maintain a `piCoderActive` boolean in module scope, defaulting to `false`
3. On `session_start`, scan `appendEntry` entries for `customType === "pi-coder-state"` and restore the active flag and FSM state
4. On `session_start`, check `pi.getAllTools()` for the `subagent` tool and set a `subagentsAvailable` flag — if false, block toggle activation with a user-facing message

---

## Phase 2: System Prompt Replacement

### Acceptance Criteria

- When active, the default pi system prompt is entirely replaced — no "expert coding assistant" identity
- The replacement prompt includes: orchestrator identity, FSM diagram, current state/spec/loop count, tool list with descriptions, and delegation rules
- Project context (AGENTS.md) and skills are preserved even though `read` is excluded from active tools
- When inactive, the default prompt is used unchanged

### Tasks

1. In `before_agent_start`, if `!piCoderActive` or `!subagentsAvailable`, return without modifying the prompt
2. Filter `systemPromptOptions.toolSnippets` to only `ORCHESTRATOR_TOOLS` (ls, find, grep, subagent, pi_coder_git, pi_coder_run_tests, upsert_knowledge) and construct the filter for `selectedTools`
3. Build the custom orchestrator prompt with: role definition ("you are the Pi Coder orchestrator — you do NOT edit files"), the compact FSM diagram (state flow on one line), the current dynamic state (currentState, activeSpecId, loopCount), the filtered tool list with snippets, and the delegation rules (never use edit/write/read, delegate to subagents)
4. Call `buildSystemPrompt()` with `customPrompt` set to the orchestrator prompt, filtered tool snippets, and filtered selected tools — this preserves `appendSystemPrompt`, `<project_context>`, date, and CWD
5. Manually call `formatSkillsForPrompt(skills)` and append the result to the prompt, since `buildSystemPrompt` only auto-includes `<available_skills>` when `read` is in `selectedTools`

---

## Phase 3: FSM Event Guards & Auto-Transitions

### Acceptance Criteria

- The orchestrator cannot call tools that are invalid for the current FSM state
- Test results automatically drive FSM transitions (RED pass→BLOCKED, RED fail→GREEN, GREEN pass→REVIEWING, GREEN fail→GREEN_WRITE)
- Subagent completions advance the FSM (researcher done→PRUNING)
- All transitions are persisted to `appendEntry` immediately

### Tasks

1. In `tool_call`, if `!piCoderActive` return — otherwise validate `pi_coder_run_tests` (only in RED_VALIDATE/GREEN_VALIDATE), validate `subagent` target agents (researcher→RESEARCHING, implementor→RED_WRITE/GREEN_WRITE, reviewer→REVIEWING), validate `pi_coder_git` (GIT_CHECKPOINT/MERGING/BLOCKED/IDLE) — block invalid calls with `{ block: true, reason }`
2. In `tool_call`, intercept `bash` commands starting with `git` and redirect to `pi_coder_git` with a block message
3. In `tool_result` for `pi_coder_run_tests`: RED_VALIDATE + tests fail → transition to TDD_GREEN_WRITE, RED_VALIDATE + tests pass → transition to BLOCKED and inject an FSM alert message, GREEN_VALIDATE + tests pass → transition to REVIEWING, GREEN_VALIDATE + tests fail → transition to TDD_GREEN_WRITE
4. In `tool_result` for `subagent`: RESEARCHING → transition to PRUNING, other completions as appropriate per the FSM
5. After every FSM transition, persist the full state via `appendEntry("pi-coder-state", stateMachine.toJSON())`

---

## Phase 4: Nudge System

### Acceptance Criteria

- Turn counting is deterministic and per-state — different states have different patience thresholds
- Nudges escalate through 3 levels: gentle reminder → direct instruction → user-visible notification
- Counters reset on state transition or when the expected action is attempted
- After max escalation, no further nudges — the user decides

### Tasks

1. Track `NudgeState` in module scope: current FSM state, turns since entering that state (incremented on each `before_agent_start`), whether the expected action has been attempted, and the last nudge level sent
2. In `before_agent_start`, after the system prompt is built: check if nudging is enabled for the current state (not IDLE/SPEC_APPROVED/FINAL_APPROVAL/COMPLETE), check if the turn count exceeds the configured threshold for this state (1 turn for action states, 2-3 for orchestrator-work states), and if the action hasn't been attempted — increment the nudge level
3. Level 1-2 nudges are appended to `systemPromptOptions.appendSystemPrompt`; level 3 nudges are sent as a user-visible notification via `ctx.ui.notify()` — after level 3, no further nudges for this state
4. In `tool_call`, when the tool matches the expected action for the current state, set `actionAttempted = true` — this resets the nudge urgency (the LLM tried, even if the result isn't back yet)
5. On FSM state transition (from `tool_result` or command), reset the entire `NudgeState` — new state, zero turns, no action attempted, nudge level 0
