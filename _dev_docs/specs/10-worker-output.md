# Spec 10: Worker Output — Extension Commands

## Status: ✅ COMPLETE

All 3 phases implemented and verified. 14 new tests passing (353 total across all specs).

---

## Phase 1: Toggle Command ✅

### Implementation (`/pi-coder`)

Added `pi.registerCommand("pi-coder", ...)` to the extension:

- **Turning ON:** Sets `piCoderActive = true`, calls `pi.setActiveTools(ORCHESTRATOR_TOOLS)`, shows status indicator via `ctx.ui.setStatus("pi-coder", "🔧 pi-coder")`, notifies user "Pi Coder: ON — Orchestrator mode active"
- **Turning OFF:** Sets `piCoderActive = false`, calls `pi.setActiveTools(NORMAL_TOOLS)`, clears status indicator, notifies user "Pi Coder: OFF — Normal Pi mode"
- **pi-subagents check:** Blocks activation if `subagentsAvailable` is false — shows: "Pi Coder requires the pi-subagents package. Install with: `pi install npm:pi-subagents`"
- **Persistence:** Calls `persistState()` after every toggle change

### Tests (5)
- ORCHESTRATOR_TOOLS and NORMAL_TOOLS exported correctly
- Toggle ON sets active tools to ORCHESTRATOR_TOOLS
- Toggle OFF sets active tools to NORMAL_TOOLS
- Toggle state is persisted via appendEntry
- Activation is blocked when subagents not available

---

## Phase 2: Init Command ✅

### Implementation (`/pi-coder-init`)

Added `pi.registerCommand("pi-coder-init", ...)` to the extension:

- **Directory creation:** Creates `.pi-coder/knowledge/`, `.pi-coder/specs/`, and `.pi/agents/` (if missing)
- **Config creation:** Creates `.pi-coder/config.json` with full defaults — BUT only if it doesn't already exist (skips with a warning if present)
  - `testCommand`: auto-detected from `package.json` scripts (checks `vitest` → `jest` → `test`, falls back to `"npm test"`)
  - `maxLoops: 3`, `gitStrategy: "branch-and-merge"`, `branchPrefix: "pi-coder/"`
  - Full nudge config per §14.2 defaults
- **Agent file copying:** Copies `pi-coder-researcher.md`, `pi-coder-implementor.md`, `pi-coder-reviewer.md` from the package's `agents/` directory (resolved via `import.meta.url`) to `.pi/agents/` — skips files that already exist (preserves customizations)
- **pi-subagents warning:** Warns if `subagent` tool is not detected, but doesn't block init
- **Summary report:** Returns a structured summary of what was created, what was skipped, and any warnings

### Key implementation detail

Package agents directory is resolved using:
```typescript
const thisDir = dirname(fileURLToPath(import.meta.url));
return join(thisDir, "..", "agents");
```

This works because the extension file is at `extensions/index.ts` and the agents directory is a sibling at `agents/`.

### Tests (6)
- Creates .pi-coder directory structure
- Auto-detects testCommand from package.json scripts
- Creates config.json with expected defaults when it doesn't exist
- Skips config.json creation when it already exists
- Copies agent .md files from package to .pi/agents/ skipping existing
- Detects vitest script and uses it as testCommand

---

## Phase 3: Reset Agents Command ✅

### Implementation (`/pi-coder-reset-agents`)

Added `pi.registerCommand("pi-coder-reset-agents", ...)` to the extension:

- **Confirmation required:** Calls `ctx.ui.confirm()` with "All customizations to pi-coder agent files will be lost. Continue?" — if cancelled, returns immediately
- **Overwrites:** Copies `pi-coder-*.md` files from the package's `agents/` directory to `.pi/agents/`, overwriting any existing content
- **Only resets pi-coder files:** Only touches files matching `pi-coder-*.md` — other agent files in `.pi/agents/` are left untouched
- **Report:** Notifies user of which files were reset, or "No agent files found to reset" if nothing matched

### Tests (3)
- Requires user confirmation before overwriting
- Overwrites pi-coder-*.md files with package defaults after confirmation
- Only resets pi-coder-*.md files, not other agent files

---

## Files Changed

- **`extensions/index.ts`** — Added 3 `registerCommand()` calls (~110 lines), helper functions (`detectTestCommand`, `getPackageAgentsDir`), updated imports
- **`extensions/index-commands.test.ts`** — NEW: 14 tests across 3 phases (~470 lines)

## All Acceptance Criteria Met

| Phase | Criterion | Status |
|---|---|---|
| 1 | Toggling on restricts tools to ORCHESTRATOR_TOOLS | ✅ |
| 1 | Toggling off restores NORMAL_TOOLS | ✅ |
| 1 | Toggle state persists via appendEntry | ✅ |
| 1 | Activation blocked if pi-subagents not installed | ✅ |
| 1 | Status indicator shown/cleared | ✅ |
| 2 | Creates .pi-coder/ directory structure | ✅ |
| 2 | Test command auto-detected from package.json | ✅ |
| 2 | Config created with defaults only if missing | ✅ |
| 2 | Agent files copied but existing ones skipped | ✅ |
| 2 | Warns if pi-subagents not detected | ✅ |
| 2 | Returns summary of created/skipped/warnings | ✅ |
| 3 | Confirmation required before reset | ✅ |
| 3 | Agent files restored to package defaults | ✅ |
| 3 | Only pi-coder-*.md files affected | ✅ |
| 3 | Clear feedback on which files were reset | ✅ |
