# Spec 07: Pi Extension Tools

## Context

The three custom tools — `pi_coder_git`, `pi_coder_run_tests`, and `upsert_knowledge` — are how the orchestrator interacts with git, validates tests, and persists knowledge. Each tool is a thin wrapper that validates against the FSM, delegates to the corresponding module, and returns a structured result for the extension's `tool_result` handler to consume.

## Dependencies

Spec 02 (state machine — for isActionAllowed), Spec 03 (spec manager), Spec 04 (git operations), Spec 05 (knowledge store), Spec 06 (TDD runner)

---

## Phase 1: Tool Registration Framework

### Acceptance Criteria

- A single `registerTools(pi, dependencies)` function registers all three tools
- Each tool has a `promptSnippet` (one-line description for system prompt) and `promptGuidelines` (short usage rules)
- Tools are registered with proper TypeBox parameter schemas

### Tasks

1. Define `registerTools(pi, { stateMachine, gitOps, tddRunner, knowledgeStore, config })` that calls `pi.registerTool()` for each of the three tools
2. For each tool, provide a `promptSnippet` — a one-line description that will appear in the orchestrator's system prompt tool list (e.g., "Structured Git operations: checkout_branch, checkpoint, rollback, merge" for pi_coder_git)
3. For each tool, provide `promptGuidelines` — 2-3 bullet rules for correct usage (e.g., "Only call this during TDD validation phases" for pi_coder_run_tests)

---

## Phase 2: Git Tool

### Acceptance Criteria

- Git operations are blocked when the FSM state doesn't allow them
- Checkpoint stores the ref in the state machine
- Rollback transitions the FSM to IDLE
- Failed git operations return structured errors, not exceptions

### Tasks

1. Register `pi_coder_git` with parameters: `action` (enum of checkout_branch/checkpoint/rollback/merge), optional `branch`, optional `message`
2. On invocation, validate against `stateMachine.isActionAllowed("pi_coder_git")` — return an error message if not allowed in the current state
3. Route to the appropriate `GitOperations` method based on the action parameter — `checkout_branch` also transitions the FSM to TDD_RED_WRITE, `rollback` transitions to IDLE, `checkpoint` stores the returned ref in the state machine
4. Return `GitCheckpointResult` directly as tool output — include success/error for the extension's `tool_result` handler

---

## Phase 3: Test Tool

### Acceptance Criteria

- Running tests is blocked outside RED_VALIDATE and GREEN_VALIDATE states
- The tool returns the validation verdict alongside the raw result
- The tool does NOT auto-transition the FSM — that's the extension `tool_result` handler's job

### Tasks

1. Register `pi_coder_run_tests` with parameters: optional `command` override, optional `filter`
2. On invocation, validate against `stateMachine.isActionAllowed("pi_coder_run_tests")` — return an error if not allowed
3. Call `tddRunner.runTests(params.filter)`, then call `validateRedPhase()` or `validateGreenPhase()` based on the current FSM state
4. Return both the raw `TestRunResult` and the validation verdict (`{ valid, reason }`) — the extension uses both to decide the auto-transition

---

## Phase 4: Knowledge Tool

### Acceptance Criteria

- Knowledge can be upserted in any FSM state
- Invalid filenames are rejected with a clear error message
- Success returns the file path

### Tasks

1. Register `upsert_knowledge` with parameters: `filename` (string), `content` (string)
2. Delegate to `knowledgeStore.upsert(params.filename, params.content)` — no FSM state check needed (knowledge is always allowed)
3. Return `{ success: true, path }` on success, or `{ success: false, error }` on validation failure
