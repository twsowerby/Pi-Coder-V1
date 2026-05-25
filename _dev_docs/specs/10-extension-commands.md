# Spec 10: Extension Main — Commands

## Context

Three commands give the user control over pi-coder: toggle orchestrator mode on/off, initialize the project's `.pi-coder/` structure, and reset agent files back to package defaults. These are the user-facing entry points.

## Dependencies

Spec 09 (extension main — toggle state and `piCoderActive` flag), Spec 05 (knowledge dir structure), Spec 08 (agent files to copy)

---

## Phase 1: Toggle Command

### Acceptance Criteria

- Toggling on restricts tools to `ORCHESTRATOR_TOOLS` and activates the orchestrator system prompt
- Toggling off restores full tool access and the default pi system prompt
- Toggle state persists across session restarts
- Activation is blocked if pi-subagents is not installed

### Tasks

1. Register `/pi-coder` command that flips `piCoderActive`, then calls `pi.setActiveTools(ORCHESTRATOR_TOOLS)` when turning on or `pi.setActiveTools(NORMAL_TOOLS)` when turning off
2. If `subagentsAvailable` is false, block activation and show: "Pi Coder requires the pi-subagents package. Install with: `pi install npm:pi-subagents`"
3. Show a status indicator when active (`ctx.ui.setStatus("pi-coder", "🔧 pi-coder")`) and clear it when inactive
4. Persist the toggle state via `appendEntry` after every change

---

## Phase 2: Init Command

### Acceptance Criteria

- Creates the full `.pi-coder/` directory structure with a sensible default config
- Test command is auto-detected from the project's `package.json`
- Agent files are copied but never overwrite existing customizations
- Running init twice doesn't destroy existing configuration

### Tasks

1. Register `/pi-coder-init` command that creates `.pi-coder/knowledge/` and `.pi-coder/specs/` directories and creates `.pi/agents/` if it doesn't exist
2. Create `.pi-coder/config.json` with defaults — but only if it doesn't already exist (skip with a warning if present): auto-detect `testCommand` by reading the project's `package.json` scripts (look for `test`, `vitest`, `jest`), falling back to `"npm test"`, and set maxLoops to 3, gitStrategy to "branch-and-merge", branchPrefix to "pi-coder/", and nudge config per §14.2 defaults
3. Copy agent `.md` files from the package's `agents/` directory to `.pi/agents/` — but skip any file that already exists (warn instead of overwriting, to preserve user customizations)
4. Warn if `subagent` tool is not detected, but don't block init — the user may install pi-subagents later
5. Return a summary of what was created, what was skipped, and any warnings

---

## Phase 3: Reset Agents Command

### Acceptance Criteria

- Agent files are restored to package defaults
- User must explicitly confirm — no accidental overwrites
- Clear feedback on which files were reset

### Tasks

1. Register `/pi-coder-reset-agents` command that warns the user customizations will be lost and requires confirmation via `ctx.ui.confirm()`
2. Overwrite all `.pi/agents/pi-coder-*.md` files with the package defaults from the `agents/` directory
3. Report which files were reset and confirm completion to the user
