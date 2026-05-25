# Spec 13: Orchestrator System Prompt Extraction

## Context

The orchestrator's system prompt is currently a template string embedded in `extensions/index.ts` inside the `buildOrchestratorPrompt()` function. This violates the "fat prompts, thin harness" philosophy — all other agent prompts are standalone `.md` files that can be reviewed, customized, and version-controlled without touching code. The orchestrator prompt should be no different.

## Dependencies

Spec 09 (extension core hooks — the code being refactored), Spec 10 (commands — uses the extension)

---

## Phase 1: Create Orchestrator Prompt File

### Acceptance Criteria

- The orchestrator system prompt exists as a standalone `.md` file
- The file contains the full static prompt content (role, FSM diagram, delegation rules)
- Dynamic values are represented as clearly documented template variables
- The file is valid Markdown that reads naturally when viewed outside the harness

### Tasks

1. Create `agents/pi-coder-orchestrator.md` containing the full orchestrator system prompt currently embedded in `buildOrchestratorPrompt()` in `extensions/index.ts`
2. Replace dynamic values with mustache-style template variables: `{{currentState}}`, `{{activeSpecId}}`, `{{loopCount}}`, `{{maxLoops}}`, `{{toolList}}`
3. Include a comment block at the top of the file documenting each template variable and what it provides (e.g., `{{currentState}}` — the current FSM state name)
4. Verify the file reads clearly as Markdown — a prompt engineer should be able to open it and understand the orchestrator's role without understanding code

---

## Phase 2: Refactor Extension to Load the Prompt

### Acceptance Criteria

- `extensions/index.ts` no longer contains the orchestrator prompt as an inline template string
- The extension loads the `.md` file at initialization time and caches it
- Dynamic substitution happens at `before_agent_start` time, not at load time
- All existing tests continue to pass without modification
- The FSM diagram is still generated programmatically (it comes from the state machine), not hardcoded in the `.md` file

### Tasks

1. Add a `loadOrchestratorPrompt()` function that reads `agents/pi-coder-orchestrator.md` relative to the extension file location (using `import.meta.url` / `__dirname`), strips the variable documentation comment block, and caches the template string in module scope — called once during extension initialization
2. Refactor `buildOrchestratorPrompt()` to use the cached template instead of an inline string, substituting `{{currentState}}`, `{{activeSpecId}}`, `{{loopCount}}`, `{{maxLoops}}`, and `{{toolList}}` with their dynamic values
3. Remove the inline prompt string from `buildOrchestratorPrompt()` entirely — the function should only do template substitution, not prompt authoring
4. Ensure the `buildFSMDiagram()` call remains in the substitution logic — the FSM diagram is generated from the state machine's transition table, not hardcoded in the `.md` file
5. Run the full test suite and verify all 372+ tests still pass

---

## Phase 3: Customization Support

### Acceptance Criteria

- If a user creates a `.pi/agents/pi-coder-orchestrator.md` file, it takes precedence over the package default
- The init command optionally copies the orchestrator prompt alongside the other agent files
- The reset-agents command restores the orchestrator prompt alongside the other agent files

### Tasks

1. Update `loadOrchestratorPrompt()` to check for `.pi/agents/pi-coder-orchestrator.md` first (project-scope customization), falling back to the package default at `agents/pi-coder-orchestrator.md` — this mirrors how pi-subagents discovers agent files in `.pi/agents/` before checking package-level definitions
2. Update the `/pi-coder-init` command to also copy `pi-coder-orchestrator.md` to `.pi/agents/` alongside the researcher, implementor, and reviewer files — with the same skip-if-exists behavior to preserve customizations
3. Update the `/pi-coder-reset-agents` command to also reset `pi-coder-orchestrator.md` alongside the other agent files
4. Add tests for the customization precedence: project file overrides package default, and both the init and reset commands handle the orchestrator prompt file correctly
