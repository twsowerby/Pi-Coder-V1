# Spec 13: Worker Output

## Status: ✅ COMPLETE

All 3 phases implemented and verified. 18 new tests passing (390 total across all specs).

---

## Phase 1: Create Orchestrator Prompt File ✅

### File Created
- `agents/pi-coder-orchestrator.md` — standalone Markdown file with full orchestrator system prompt

### Implementation
- Valid YAML frontmatter: `name: orchestrator`, `package: pi-coder`, `tools: ls, find, grep, subagent, pi_coder_git, pi_coder_run_tests, upsert_knowledge`, `systemPromptMode: replace`
- 6 template variables: `{{fsmDiagram}}`, `{{currentState}}`, `{{activeSpecId}}`, `{{loopCount}}`, `{{maxLoops}}`, `{{toolList}}`
- HTML comment block at the top documenting each variable with its purpose and format
- Reads naturally as Markdown — a prompt engineer can open it and understand the orchestrator's role without code knowledge

### Tests (5)
- `.md` file exists at correct path
- Has valid YAML frontmatter with orchestrator identity
- Contains all 6 template variables
- HTML comment documents each template variable
- Reads clearly after stripping frontmatter and comments

---

## Phase 2: Refactor Extension to Load the Prompt ✅

### Implementation (`extensions/index.ts`)

**New exports:**
- `loadOrchestratorPrompt(cwd?)` — loads orchestrator prompt template from `.md` file, with caching. Strips YAML frontmatter and HTML comment documentation. Returns the clean template with `{{variables}}` intact.
- `resetOrchestratorPromptCache()` — invalidates the cached template, forcing a reload on next `loadOrchestratorPrompt()` call.

**Refactored:**
- `buildOrchestratorPrompt()` — now does template substitution only. Calls `loadOrchestratorPrompt()` to get the cached template, then substitutes 6 variables. No inline prompt string.
- `buildFSMDiagram()` — unchanged, still programmatic (generated from state machine transitions, not hardcoded in `.md`)
- `session_start` handler — calls `resetOrchestratorPromptCache()` then `loadOrchestratorPrompt(cwd)` during initialization

**Key design decisions:**
1. YAML frontmatter is stripped at load time (not at build time). The `.md` file is the single source of truth, and the frontmatter serves as documentation and pi-subagents metadata if the file is ever discovered in `.pi/agents/`.
2. HTML comments are stripped at load time. They serve as in-file documentation for prompt engineers but should not enter the LLM context.
3. The fallback inline prompt (used only if the `.md` file is missing entirely) is minimal — just the essential template variables. This is a safety net, not a design goal.
4. Caching is lazy — the template is loaded on first call to `loadOrchestratorPrompt()` and reused. This matches how the extension's module-scope variables work.

### Tests (6)
- `loadOrchestratorPrompt` returns template with all variables
- Strips YAML frontmatter from the template
- Strips HTML comment documentation from the template
- Caches the template after first load
- `resetOrchestratorPromptCache` forces reload
- Full substitution pipeline produces correct output with no leftover variables

---

## Phase 3: Customization Support ✅

### Implementation

**loadOrchestratorPrompt(cwd) precedence:**
1. Check `{cwd}/.pi/agents/pi-coder-orchestrator.md` (project-scope customization)
2. Fall back to `{packageRoot}/agents/pi-coder-orchestrator.md` (package default)
3. Fall back to minimal inline prompt (if neither file exists)

**Init command (`/pi-coder-init`):**
- `pi-coder-orchestrator.md` added to the agent filenames list (4th item)
- Copied to `.pi/agents/` alongside researcher, implementor, reviewer
- Same skip-if-exists behavior — preserves user customizations

**Reset-agents command (`/pi-coder-reset-agents`):**
- `pi-coder-orchestrator.md` added to the agent filenames list (4th item)
- Overwritten with package default alongside the other 3 agents
- After reset, calls `resetOrchestratorPromptCache()` to force the extension to reload the template on the next `before_agent_start`

### Tests (7)
- Falls back to package default when no project override
- Prefers project-scope customization over package default
- Falls back to package default when project file is missing
- Init copies orchestrator alongside other agent files
- Init skips orchestrator if it already exists
- Reset-agents resets orchestrator alongside other files
- Reset-agents only touches pi-coder-*.md files

---

## Files Changed

| File | Change |
|---|---|
| `agents/pi-coder-orchestrator.md` | NEW — standalone orchestrator prompt with template variables |
| `extensions/index.ts` | Refactored: `buildOrchestratorPrompt()` → template substitution; added `loadOrchestratorPrompt()`, `resetOrchestratorPromptCache()`; updated init/reset commands |
| `extensions/index-prompt.test.ts` | NEW — 18 tests across 3 phases |

---

## Full Test Suite

```
390 tests, 71 suites, 0 failures
```

## All Acceptance Criteria Met

| Phase | Criterion | Status |
|---|---|---|
| 1 | Orchestrator system prompt exists as standalone .md file | ✅ |
| 1 | File contains full static prompt content | ✅ |
| 1 | Dynamic values are template variables | ✅ |
| 1 | Template variables documented in HTML comment | ✅ |
| 1 | File reads clearly as Markdown | ✅ |
| 2 | No inline prompt string in buildOrchestratorPrompt() | ✅ |
| 2 | Extension loads .md file at init, caches it | ✅ |
| 2 | Dynamic substitution at before_agent_start time | ✅ |
| 2 | All existing tests (372) pass without modification | ✅ |
| 2 | FSM diagram still generated programmatically | ✅ |
| 3 | Project-scope .md file overrides package default | ✅ |
| 3 | Init command copies orchestrator prompt | ✅ |
| 3 | Reset command restores orchestrator prompt | ✅ |
| 3 | Tests for customization precedence | ✅ |
