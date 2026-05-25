# Pi Coder v1: TDD Orchestrator/Worker Harness

We are building a semi-deterministic coding harness using an orchestrator/worker pattern. The harness follows a strict process and set of directives, utilizing a "fat prompts/skills, thin harness" design philosophy.

The orchestrator (the main Pi process) cannot edit files, read full file contents, or run arbitrary terminal commands for version control. It acts as a senior technical project manager with domain expertise. Its primary responsibilities are writing specs, delegating atomic tasks, passing strict context payloads, persisting system knowledge, and submitting work for user approval. It delegates to specific subagents (using `pi-subagents`), ensuring each task is self-contained, testable, and aligned with strict Test-Driven Development (TDD) principles.

---

## 1. Architecture: Pi Package + pi-subagents

### 1.1 Core Decision: Build on pi-subagents, Not From Scratch

The `pi-subagents` npm package provides the production-grade subagent orchestration layer. It handles:

- Subagent process spawning (`--mode json -p --no-session` invocations)
- Parallel execution, chaining, and `{previous}` template variables
- Agent discovery (`.pi/agents/` directory scanning)
- Async/background run management with status, interrupt, resume
- Intercom bridge for child→parent escalation
- Custom TUI rendering for subagent results (collapsible, expandable views)
- Worktree isolation for parallel writers
- Context modes: `fresh` (isolated) vs `fork` (branched from parent session)
- Control/attention tracking with `needs_attention` signals
- Agent/chains management actions (`create`, `update`, `delete`, `list`, `get`, `doctor`)

### 1.2 Subagent Mapping

| Brief Subagent | pi-subagents Builtin Equivalent | Mapping Details |
|---|---|---|
| Researcher | `researcher` + `scout` | `researcher` for external docs/ecosystem; `scout` for local codebase recon. Custom agent file extends builtin with TDD-specific output format. |
| Implementor | `worker` | Fresh-context single-writer implementation. Custom agent file adds TDD Red/Green phase constraints. |
| Reviewer | `reviewer` | Fresh-context adversarial review. Custom agent file adds brief-specific review focus areas and output format. |

### 1.3 What We Must Build (the "Thin Harness")

- The **state machine** that drives the TDD lifecycle
- The **Git abstraction** (`git.ts` — safe structured API)
- The **Knowledge system** (`upsert_knowledge` tool)
- The **Spec management** (`.pi-coder/specs/` lifecycle)
- The **Context pruning** logic (orchestrator trims raw research into actionable briefs)
- The **TDD validation harness** (run tests, assert failure/pass)
- The **Approval flow** (spec approval, final report)
- The **Circuit breaker** (max loop threshold)
- The **System prompt replacement** (orchestrator identity + FSM state injection)
- The **Tool restriction layer** (setActiveTools + tool_call interception)
- The **Toggle command** (pi-coder on/off)
- The **Init command** (scaffold directories + copy agent files)

### 1.4 What We Get for Free from pi-subagents

| Feature | From pi-subagents | Notes |
|---|---|---|
| Subagent spawning | ✅ `subagent()` tool | Single, parallel, chain modes |
| Fresh vs forked context | ✅ `context: "fresh"` | Reviewer uses fresh, implementor uses fresh |
| Context isolation | ✅ Each child is a separate `pi` process | No context pollution between agents |
| Async management | ✅ `async: true`, `status`, `interrupt`, `resume` | Non-blocking orchestration |
| Intercom escalation | ✅ `contact_supervisor` | Implementor can ask for clarification |
| TUI rendering | ✅ Collapsible, expandable result views | Rich display of subagent output |
| Agent file discovery | ✅ `.pi/agents/*.md` scanning | Custom agent definitions picked up automatically |
| Tool scoping per agent | ✅ Per-agent `tools` in frontmatter | Implementor gets its own tool set |
| Worktree isolation | ✅ `worktree: true` | For parallel reviewer runs |
| Chain template variables | ✅ `{task}`, `{previous}`, `{chain_dir}` | For passing context between sequential agents |

---

## 2. Package Structure

```
pi-coder-v1/
├── package.json              # pi-package, declares extension + skills + prompts
├── extensions/
│   └── index.ts              # Main extension: state machine, tools, events, system prompt
├── agents/
│   ├── pi-coder-researcher.md    # Custom researcher agent definition
│   ├── pi-coder-implementor.md   # Custom implementor agent definition
│   └── pi-coder-reviewer.md      # Custom reviewer agent definition
├── skills/
│   └── pi-coder/
│       └── SKILL.md          # Skill loaded into orchestrator context
├── prompts/
│   ├── tdd-red.md            # Prompt template for Red phase delegation
│   ├── tdd-green.md          # Prompt template for Green phase delegation
│   └── spec-approval.md      # Prompt template for spec review/approval
└── src/
    ├── state-machine.ts      # FSM types, transitions, persistence
    ├── git.ts                # Structured Git API (checkout_branch, checkpoint, rollback, merge)
    ├── knowledge.ts          # .pi-coder/knowledge/ read/write utilities
    ├── spec.ts               # .pi-coder/specs/ lifecycle management
    ├── tdd-runner.ts         # Test execution + Red/Green validation
    └── tools.ts              # Tool definitions (upsert_knowledge, pi_coder_git, pi_coder_run_tests)
```

### package.json

```json
{
  "name": "pi-coder-v1",
  "keywords": ["pi-package"],
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-ai": "*",
    "typebox": "*"
  },
  "dependencies": {},
  "pi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"],
    "prompts": ["./prompts"]
  }
}
```

**Note:** The `pi` manifest in `package.json` does NOT support an `agents` key. Pi packages can declare `extensions`, `skills`, `prompts`, and `themes` — but not agents. Agent files must be physically present in `.pi/agents/` or `~/.pi/agent/agents/` for pi-subagents to discover them. We solve this with the init command (see §8).

---

## 3. State Machine & TDD Lifecycle

The harness utilizes a state machine to track the current spec, its approval status, and the implementation phases.

### 3.1 States

```
IDLE → RESEARCHING → PRUNING → DRAFTING_SPEC → SPEC_APPROVED → 
  GIT_CHECKPOINT → TDD_RED_WRITE → TDD_RED_VALIDATE → 
  TDD_GREEN_WRITE → TDD_GREEN_VALIDATE → REVIEWING → 
  (APPROVED | NEEDS_CHANGES → back to TDD_RED_WRITE) → 
  FINAL_APPROVAL → MERGING → COMPLETE | BLOCKED
```

### 3.2 Lifecycle Steps

1. **Intake & Research:** User requests work. The Orchestrator parses the request and briefs the Researcher(s). The Researcher scans the `.pi-coder/knowledge/` directory alongside the codebase to ensure historical context is maintained.
2. **Context Pruning:** Researcher returns findings. The Orchestrator ingests the full report but extracts *only* the specific Acceptance Criteria, Constraints, Applied Knowledge, and Key Files needed for implementation.
3. **Spec Drafting & Approval:** Orchestrator drafts the brief based on the pruned context and submits it to the user for approval via `interview` tool. If rejected, the brief is refined and resubmitted.
4. **Git Checkpoint (Pre-Implementation):** Once the brief is approved, the harness automatically invokes the structured Git tool (`pi_coder_git`) to create a new branch (based on config) and log a clean Git commit (`wip: pre-implementation-[spec-id]`).
5. **Strict TDD Implementation Loop:**
   - **Step 5a (Red Phase - Tests):** Implementor is briefed to write *only* the tests required to satisfy the Acceptance Criteria.
   - **Step 5b (Red Phase - Validation):** The harness executes the test suite via `pi_coder_run_tests`. **Execution must fail.** If it passes, the state machine halts and alerts the Orchestrator that the tests are tautological or the feature already exists.
   - **Step 5c (Green Phase - Code):** Implementor is briefed to write the application code required to make the failing tests pass.
   - **Step 5d (Green Phase - Validation):** The harness executes the test suite via `pi_coder_run_tests`. **Execution must pass.**
6. **Review & Refinement Cycle:**
   - The Reviewer analyzes the diff against the Acceptance Criteria and Test Alignment.
   - If issues are found, the cycle repeats (Rebrief → Implement → Review).
   - **Circuit Breaker:** A Max Loop Threshold (e.g., 3 cycles) is enforced. If hit, the spec state is marked `BLOCKED`, and the Orchestrator pauses to ask the user for intervention.
7. **Approval & Teardown:** User is presented with a final report (changes, test results, deferred items, and potential knowledge learnings).
   - **Approved:** The harness invokes the Git tool to merge the branch (based on config) and temporary files in `.pi-coder/specs` are cleaned up.
   - **Rejected/Critical Failure:** User can trigger a rollback. The harness invokes the Git tool to `git reset --hard` to the pre-implementation checkpoint, clearing the contaminated context for a fresh attempt.
8. **Knowledge Consolidation:** The Orchestrator reviews the Implementor's decisions and the Reviewer's corrections. If there are notable architectural learnings, the Orchestrator uses the `upsert_knowledge` tool to record them before closing out the spec.

### 3.3 Persistence via `pi.appendEntry`

The pi extension API provides `pi.appendEntry(customType, data)` for state that survives restarts without polluting LLM context. This is the mechanism for:
- Current FSM state + spec ID
- Loop counter (circuit breaker)
- Pre-implementation Git ref (for rollback)
- Pruned context summary
- Pi-coder active/inactive toggle state

```typescript
pi.appendEntry("pi-coder-state", {
  active: true,
  state: "TDD_RED_VALIDATE",
  specId: "auth-flow-001",
  loopCount: 1,
  maxLoops: 3,
  gitRef: "abc1234",
  prunedContext: { acceptanceCriteria: [...], constraints: [...], keyFiles: [...] }
});
```

Restored on `session_start` by scanning entries for `customType === "pi-coder-state"`.

### 3.4 Compaction Safety

Long TDD cycles may trigger auto-compaction. The FSM state is persisted in `appendEntry` (not LLM context), so it survives compaction. However, research summaries and spec text could be lost from context. **Mitigation:** Persist all critical context in `.pi-coder/specs/{id}.md` files and re-read them (via subagent delegation) when needed after compaction.

---

## 4. System Prompt Strategy

### 4.1 Decision: Replace the Default System Prompt

The default pi system prompt begins: *"You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files."*

This is the exact opposite of what our orchestrator should believe about itself. If we only append or inject messages, the model is grounded in the identity of a general-purpose coding assistant that edits files. We'd be fighting the base identity on every turn. The orchestrator must not edit files and must delegate. The system prompt must establish that identity from the first token.

### 4.2 Mechanism: `before_agent_start` + `buildSystemPrompt`

The `before_agent_start` event provides:

```typescript
event.systemPromptOptions: {
  customPrompt,        // from .pi/SYSTEM.md or --system-prompt
  appendSystemPrompt,  // from --append-system-prompt or .pi/APPEND_SYSTEM.md
  selectedTools,       // currently active tool names
  toolSnippets,        // { toolName: oneLineDescription } — from each tool's promptSnippet
  promptGuidelines,    // aggregated guidelines from all active tools' promptGuidelines arrays
  cwd,
  contextFiles,        // AGENTS.md content array
  skills,              // loaded skills array
}
```

We use `systemPromptOptions` to construct our custom system prompt by calling pi's own `buildSystemPrompt()` function with our overwritten values:

```typescript
import { buildSystemPrompt } from "@earendil-works/pi-coding-agent";

pi.on("before_agent_start", async (event, ctx) => {
  if (!piCoderActive) return; // Let pi run normally when toggled off

  const { systemPromptOptions } = event;
  const { toolSnippets, promptGuidelines, contextFiles, skills, cwd } = systemPromptOptions;

  // 1. Filter to orchestrator-allowed tools only
  const allowedTools = ORCHESTRATOR_TOOLS;
  const filteredSnippets = {};
  const filteredGuidelines = [];
  for (const name of allowedTools) {
    if (toolSnippets[name]) filteredSnippets[name] = toolSnippets[name];
  }
  for (const g of promptGuidelines) filteredGuidelines.push(g);

  // 2. Build our custom identity prompt
  const orchestratorPrompt = `You are the Pi Coder orchestrator — a senior technical project manager with domain expertise. You do NOT edit files, read full file contents, or run arbitrary commands. You delegate all implementation to subagents.

Your role:
- Parse user requests and brief the researcher
- Prune research into actionable specs
- Delegate to subagents via the subagent tool
- Manage the TDD state machine
- Approve/reject specs and final reports
- Persist knowledge learnings

Current FSM state: ${stateMachine.currentState}
Active spec: ${stateMachine.activeSpecId ?? "none"}
Loop count: ${stateMachine.loopCount}/${stateMachine.maxLoops}

Available tools:
${allowedTools.map(name => `- ${name}: ${filteredSnippets[name] ?? '(see description)'}`).join('\n')}

Guidelines:
${filteredGuidelines.map(g => `- ${g}`).join('\n')}
- NEVER use edit or write tools — delegate to the implementor subagent
- NEVER read full file contents — delegate to the researcher subagent
- Use ls/find/grep for file discovery to write effective briefs
- Use the subagent tool to delegate: pi-coder.researcher, pi-coder.implementor, pi-coder.reviewer`;

  // 3. Let buildSystemPrompt handle context files + skills + date + CWD
  const fullPrompt = buildSystemPrompt({
    ...systemPromptOptions,
    customPrompt: orchestratorPrompt,
    selectedTools: allowedTools,
    toolSnippets: filteredSnippets,
    promptGuidelines: filteredGuidelines,
  });

  return { systemPrompt: fullPrompt };
});
```

### 4.3 Why This Approach Works

When `buildSystemPrompt` receives a `customPrompt`, it:
- Uses it as the base (replacing the default "expert coding assistant" identity)
- Appends `appendSystemPrompt` (if any)
- Appends `<project_context>` (AGENTS.md files) ✅
- Appends `<available_skills>` (if `read` is in selectedTools)
- Appends date + CWD ✅

**Skills inclusion problem:** `buildSystemPrompt` only includes `<available_skills>` when `read` is in `selectedTools`. Since we remove `read` from the orchestrator, skills won't be auto-appended. **Solution:** Manually format and append the skills section by importing `formatSkillsForPrompt` from pi-coding-agent and calling it in our custom prompt construction. This gives skills visibility without the `read` tool.

### 4.4 Dynamic vs Static Portions

The system prompt has two types of content:

- **Static** (every turn): Orchestrator role definition, tool restrictions, delegation rules
- **Dynamic** (per FSM state): Current state, active spec, loop count, allowed transitions

Both are handled in the single `before_agent_start` handler. The dynamic portions are small — just the current FSM state and a few variables — so they don't bloat context.

---

## 5. Orchestrator Tool Restrictions

### 5.1 Design Rationale

The purpose of removing the orchestrator's ability to edit, write, and read full file contents is to **force delegation**. This preserves the context window of the main pi orchestrator, increasing the longevity of uninterrupted context. Every time the orchestrator reads a file, that file's content enters its context window. In a TDD cycle, the orchestrator might be tempted to "just check" the implementation by reading the source — and suddenly it's carrying the entire codebase in its context. Forcing delegation to a subagent (which has a fresh context window) is the right pattern.

### 5.2 Allowed and Blocked Tools

| Tool | Allowed? | Rationale |
|---|---|---|
| `ls` | ✅ | Directory listing — tiny context cost, essential for briefing subagents |
| `find` | ✅ | File discovery by pattern — small output, essential for targeting |
| `grep` | ✅ | Pattern search — bounded output, essential for targeting |
| `read` | ❌ | Full file content — the biggest context polluter, forces delegation |
| `bash` | ❌ | Can do anything including reading files, but we need allowlisted safe commands for diagnostics |
| `edit` | ❌ | Orchestrator must not modify files |
| `write` | ❌ | Orchestrator must not modify files |
| `subagent` | ✅ | Core delegation mechanism |
| `pi_coder_git` | ✅ | Structured Git operations |
| `pi_coder_run_tests` | ✅ | TDD validation |
| `upsert_knowledge` | ✅ | Knowledge persistence |

### 5.3 Implementation: Dual-Layer Restriction

**Layer 1 — `pi.setActiveTools()` (whitelist):**

This is the primary mechanism. It removes `edit`, `write`, `read`, and `bash` entirely from the orchestrator's tool palette. Pi automatically rebuilds the system prompt with only the tool snippets and guidelines for the active tools.

```typescript
const ORCHESTRATOR_TOOLS = [
  "ls", "find", "grep",          // Bounded filesystem awareness
  "subagent",                     // Delegation
  "pi_coder_git",                 // Structured Git
  "pi_coder_run_tests",           // TDD validation
  "upsert_knowledge",             // Knowledge persistence
];

const NORMAL_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
```

**Layer 2 — `pi.on("tool_call")` interception (bash allowlist):**

If `bash` needs to be available for specific diagnostic commands (e.g., `node --version`, `which npm`), we add it back with an interception layer that only allows safe, read-only bash commands and blocks raw `git`:

```typescript
pi.on("tool_call", async (event) => {
  if (!piCoderActive) return;

  // Block raw git commands even if bash were available
  if (event.toolName === "bash") {
    const command = (event.input.command as string) || "";
    if (command.trimStart().startsWith("git ")) {
      return { block: true, reason: "Use pi_coder_git for Git operations." };
    }
    if (!isSafeCommand(command)) {
      return { block: true, reason: "Command not allowlisted in orchestrator mode. Delegate to a subagent." };
    }
  }
});
```

The `isSafeCommand` function follows the plan-mode example pattern — allowlisting safe commands like `ls`, `cat`, `head`, `tail`, `grep`, `find`, `wc`, `which`, `node --version`, etc.

**Current decision:** `bash` is NOT in the ORCHESTRATOR_TOOLS list. The `pi_coder_run_tests` tool handles test execution internally via `pi.exec()`. If we later find the orchestrator needs specific bash commands, we add them via Layer 2.

### 5.4 Tool Restriction Does NOT Leak to Subagents

When the orchestrator delegates to a subagent, the subagent runs in its own `pi` process with its own tool set. The orchestrator's `setActiveTools` restrictions only affect the orchestrator's session. Subagent tool sets are defined by their `.pi/agents/*.md` frontmatter `tools:` field.

---

## 6. Toggle Command

### 6.1 Design

The `/pi-coder` command toggles pi-coder orchestrator mode on and off. When off, pi runs as a normal coding assistant with full tool access.

### 6.2 Implementation

```typescript
let piCoderActive = false;

pi.registerCommand("pi-coder", {
  description: "Toggle pi-coder orchestrator mode on/off",
  handler: async (_args, ctx) => {
    piCoderActive = !piCoderActive;

    if (piCoderActive) {
      pi.setActiveTools(ORCHESTRATOR_TOOLS);
      ctx.ui.notify("Pi Coder: ON — Orchestrator mode active", "info");
      ctx.ui.setStatus("pi-coder", "🔧 pi-coder");
    } else {
      pi.setActiveTools(NORMAL_TOOLS);
      ctx.ui.notify("Pi Coder: OFF — Normal Pi mode", "info");
      ctx.ui.setStatus("pi-coder", undefined);
    }

    // Persist toggle state
    pi.appendEntry("pi-coder-state", { active: piCoderActive, ... });
  },
});
```

### 6.3 Toggle Mid-Cycle

If the user toggles off mid-TDD-cycle, the state machine pauses but does not reset. All FSM state persists in `appendEntry`. When the user toggles back on:
- The `before_agent_start` handler re-injects the orchestrator prompt
- The FSM resumes from its last state
- `setActiveTools` re-applies the orchestrator tool restrictions

### 6.4 System Prompt When Toggled Off

When `piCoderActive` is `false`, the `before_agent_start` handler returns nothing — pi uses its default system prompt. The user has a standard conversation with pi.

---

## 7. Custom Tools

### 7.1 `pi_coder_git` — Structured Git API

Agents are prohibited from running raw `git` CLI commands. This tool exposes safe, validated Git operations. Internally calls `pi.exec("git", [...])`.

```typescript
pi.registerTool({
  name: "pi_coder_git",
  label: "Pi Coder Git",
  description: "Structured Git operations for the TDD harness. Actions: checkout_branch, checkpoint, rollback, merge",
  parameters: Type.Object({
    action: StringEnum(["checkout_branch", "checkpoint", "rollback", "merge"]),
    branch: Type.Optional(Type.String({ description: "Branch name for checkout_branch" })),
    message: Type.Optional(Type.String({ description: "Commit message for checkpoint" })),
  }),
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    // Validate state machine allows this action at the current state
    // Execute git command via pi.exec("git", [...])
    // Return structured result
  }
});
```

**Actions:**
- `checkout_branch`: Create and checkout a new branch (configurable prefix, e.g., `pi-coder/`)
- `checkpoint`: Commit current state with structured message
- `rollback`: `git reset --hard` to the stored pre-implementation ref
- `merge`: Merge the working branch back to the base branch

### 7.2 `upsert_knowledge` — Knowledge System

```typescript
pi.registerTool({
  name: "upsert_knowledge",
  label: "Upsert Knowledge",
  description: "Write or update a knowledge file in .pi-coder/knowledge/. These files establish project-specific rules for future agents.",
  parameters: Type.Object({
    filename: Type.String({ description: "e.g., supabase-auth-flow.md" }),
    content: Type.String({ description: "Markdown content with directives" }),
  }),
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    // Write to .pi-coder/knowledge/{params.filename}
    // Create directory if needed
  }
});
```

### 7.3 `pi_coder_run_tests` — TDD Validation

```typescript
pi.registerTool({
  name: "pi_coder_run_tests",
  label: "Run Tests",
  description: "Execute the test suite for TDD validation. Returns structured results including exit code, pass/fail counts, and output.",
  parameters: Type.Object({
    command: Type.Optional(Type.String({ description: "Override test command from config" })),
    filter: Type.Optional(Type.String({ description: "Test file/pattern filter" })),
  }),
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    // Read test command from .pi-coder/config.json or params
    // Execute via pi.exec()
    // Parse exit code, output
    // Return { passed, failed, output, exitCode }
  }
});
```

**TDD Validation Logic:**
- `TDD_RED_VALIDATE`: Exit code must be non-zero (tests must fail). If tests pass, the state machine halts — tests are tautological or the feature already exists. Alert orchestrator.
- `TDD_GREEN_VALIDATE`: Exit code must be zero (tests must pass). If tests fail, return to `TDD_GREEN_WRITE`.

---

## 8. Init Command & Agent File Management

### 8.1 The Pi Package Agents Problem

The `pi` manifest in `package.json` supports `extensions`, `skills`, `prompts`, and `themes` — but **NOT** `agents`. Pi-subagents discovers agent files from:
- `~/.pi/agent/agents/**/*.md` (user scope)
- `.pi/agents/**/*.md` (project scope)

Agent files must physically exist in one of these directories. The package cannot magically inject them. We solve this with init commands.

### 8.2 `/pi-coder-init` Command

Creates the pi-coder directory structure and copies agent definition files into the project.

**Steps:**
1. Create `.pi-coder/` directory structure:
   - `.pi-coder/config.json` (with defaults)
   - `.pi-coder/knowledge/`
   - `.pi-coder/specs/`
2. Create `.pi/agents/` if it doesn't exist
3. Copy agent .md files from package to `.pi/agents/`:
   - `pi-coder-researcher.md`
   - `pi-coder-implementor.md`
   - `pi-coder-reviewer.md`
4. If files already exist in `.pi/agents/`, warn and skip (don't overwrite customizations)
5. Prompt for project-specific config:
   - Test command (heuristic default: detect from `package.json` scripts)
   - Max loops (default: 3)
   - Git strategy (default: branch-and-merge)
   - Branch prefix (default: `pi-coder/`)
6. Verify pi-subagents is installed (check if `subagent` tool is registered)

**Finding package's own agent files:** The extension resolves paths using `import.meta.url` / `__dirname` to locate the package's `agents/` directory, then copies via `node:fs`.

### 8.3 `/pi-coder-reset-agents` Command

Resets agent .md files back to package defaults. Allows users to customize agent system prompts within a project while always having the option to revert.

**Steps:**
1. Warn that customizations will be lost; confirm with `ctx.ui.confirm()`
2. Overwrite `.pi/agents/pi-coder-*.md` with package defaults
3. Notify user of completion

### 8.4 Default `.pi-coder/config.json`

```json
{
  "testCommand": "npm test",
  "maxLoops": 3,
  "gitStrategy": "branch-and-merge",
  "branchPrefix": "pi-coder/"
}
```

The `testCommand` is auto-detected from `package.json` scripts during init, falling back to `npm test`.

---

## 9. Subagent Definitions — Agent .md Files

These are pi-subagents agent definition files. They use frontmatter to configure tool sets, context mode, and system prompt behavior. They are placed in `.pi/agents/` (project scope) by the init command.

### 9.1 Agent Naming Strategy

Agents use the `package: pi-coder` frontmatter field. This registers them with dotted runtime names (`pi-coder.researcher`, `pi-coder.implementor`, `pi-coder.reviewer`), avoiding collisions with pi-subagents builtins of the same name.

### 9.2 `pi-coder-researcher.md`

```markdown
---
name: researcher
package: pi-coder
description: Investigates codebase, knowledge base, and external sources for TDD implementation context
tools: read, bash, grep, find, ls
systemPromptMode: replace
inheritProjectContext: true
inheritSkills: true
defaultContext: fresh
---

You are the Pi Coder Researcher. You investigate the codebase, the `.pi-coder/knowledge/` directory, external libraries, and best practices. You return a comprehensive, structured report.

Before investigating, always check `.pi-coder/knowledge/` for existing project-specific rules that govern the implementation.

Output Format:
- **Summary:** 1-3 sentence overview.
- **Architecture:** Structure of relevant codebase sections.
- **Key Files:** `path/to/file.ts` — purpose and relevance.
- **Applied Knowledge:** Summary of existing project rules found in `.pi-coder/knowledge/` that strictly govern the implementation.
- **Existing Patterns:** Conventions the new code must match.
- **Risks & Constraints:** Coupling, edge cases, and blockers.
- **Feasibility Assessment:** Estimated complexity and blockers.
- **Recommendations:** Specific implementation approach.
```

### 9.3 `pi-coder-implementor.md`

```markdown
---
name: implementor
package: pi-coder
description: TDD implementor that writes tests first (RED), then code to pass them (GREEN)
tools: read, bash, edit, write, grep, find, ls
systemPromptMode: replace
inheritProjectContext: true
inheritSkills: true
defaultContext: fresh
---

You are the Pi Coder Implementor. You execute development tasks strictly governed by the TDD state machine.

You operate in two distinct modes:

**RED phase:** Write ONLY the tests required to satisfy the Acceptance Criteria. Do NOT write implementation code.
**GREEN phase:** Write ONLY the application code needed to make failing tests pass. Do NOT modify tests without orchestrator approval.

You do NOT run git commands. The harness manages Git operations.

When working, always check `.pi-coder/knowledge/` for project-specific rules before writing code.

Output Format (Post-Implementation):
- **Changes Made:** Summary of implementation.
- **Files Modified/Created:** List of paths.
- **Verification:** Test/lint commands run and their results.
- **Learnings & Decisions:** Explanations for why specific approaches or workarounds were chosen over others to make tests pass.
- **Notes:** Edge cases, risks, or out-of-scope follow-ups.
```

### 9.4 `pi-coder-reviewer.md`

```markdown
---
name: reviewer
package: pi-coder
description: Evaluates implementation against spec brief for TDD integrity, correctness, and security
tools: read, bash, grep, find, ls
systemPromptMode: replace
inheritProjectContext: false
defaultContext: fresh
---

You are the Pi Coder Reviewer. You evaluate the Implementor's output against the Orchestrator's brief.

Review Focus Areas (DO review):
- **Test Alignment (Critical):** Ensure tests accurately cover the Acceptance Criteria. Flag brittle or tautological tests.
- **Potential Bugs:** Logic errors, null/undefined handling, crash risks.
- **Security:** Vulnerabilities, input validation.
- **Correctness:** Does the code satisfy the brief?
- **API Contracts:** Breaking changes, missing error handling.

Areas to SKIP:
- Style, readability, naming preferences.
- Compiler/build errors (deterministic harness tools handle these).
- Performance (unless egregious).
- Nitpicks and TODOs.

Output Format:
- **Verdict:** ✅ Approved / ⚠️ Needs Changes / ❌ Request Changes
- **Issues found:** [count] (by severity)
- **Issues Breakdown:**
  - 🔴/🟠/🟡 [Issue Title]
  - Severity: 🔴 High / 🟠 Medium / 🟡 Low
  - File: `path/to/file.ts` (line X-Y)
  - Problem: What's wrong (max 2 sentences)
  - Suggested Fix: Specific change to make
- **Knowledge Extraction Candidates:** Specific mistakes or project-specific requirements missed by the Implementor that should be persisted to `.pi-coder/knowledge/`.
- **Approved Aspects:** Brief note on what is solid.
```

### 9.5 Context Mode Choices

| Agent | Context | Rationale |
|---|---|---|
| `pi-coder.researcher` | `fresh` | Clean slate for unbiased investigation. Researcher reads files itself. |
| `pi-coder.implementor` | `fresh` | Clean slate prevents context drift. Implementor receives only the pruned brief. |
| `pi-coder.reviewer` | `fresh` | Adversarial review requires independent perspective. Reviewer should not see the implementor's reasoning. |

All three use `fresh` context because they should work from the files and brief they're given, not from inherited conversation history.

---

## 10. TDD Lifecycle Flow (Subagent Orchestration)

The orchestrator (main Pi process with pi-coder extension) drives the lifecycle. It never edits files itself.

```
1. Intake
   → subagent({ agent: "pi-coder.researcher", task: "Research: [user request]", context: "fresh" })

2. Pruning
   → Orchestrator extracts only AC, constraints, key files from researcher report
   → Saves pruned context to .pi-coder/specs/{spec-id}.md

3. Spec Approval
   → interview() presents spec to user
   → If rejected → refine and resubmit

4. Git Checkpoint
   → pi_coder_git({ action: "checkout_branch", branch: "pi-coder/spec-id" })
   → pi_coder_git({ action: "checkpoint", message: "wip: pre-implementation-{spec-id}" })

5a. RED phase — delegate
   → subagent({ agent: "pi-coder.implementor", task: "RED phase: Write tests for [AC]. Do NOT write implementation code.", context: "fresh" })

5b. RED validate
   → pi_coder_run_tests() — MUST fail (exit code ≠ 0)
   → If passes → HALT, alert orchestrator (tautological tests or feature exists)

5c. GREEN phase — delegate
   → subagent({ agent: "pi-coder.implementor", task: "GREEN phase: Write code to make tests pass. [pruned context]", context: "fresh" })

5d. GREEN validate
   → pi_coder_run_tests() — MUST pass (exit code = 0)
   → If fails → return to 5c

6. Review
   → subagent({ agent: "pi-coder.reviewer", task: "Review the diff against [AC]. [pruned context]", context: "fresh" })
   → If issues found AND loopCount < maxLoops → goto 5a
   → If loopCount >= maxLoops → BLOCKED, ask user for intervention

7. Final Approval
   → interview() presents final report (changes, test results, deferred items, knowledge learnings)
   → Approved → continue to 8
   → Rejected → user can trigger rollback

8. Merge
   → pi_coder_git({ action: "merge" })
   → Clean up .pi-coder/specs/{spec-id}.md

9. Knowledge Consolidation
   → upsert_knowledge() for learnings extracted by reviewer
   → Transition to IDLE
```

### 10.1 Subagent Task Payloads

The orchestrator passes only the specific inputs required for the current state — not raw chat history. This is the "payload management" requirement from the brief:

- **Researcher:** User request + `.pi-coder/knowledge/` reference
- **Implementor (RED):** Acceptance Criteria + Constraints + Key Files + "write tests only"
- **Implementor (GREEN):** Acceptance Criteria + same context + "make tests pass"
- **Reviewer:** Acceptance Criteria + diff summary + Test Alignment focus areas

### 10.2 Async Orchestration

Per pi-subagents best practices, subagent launches should default to `async: true`. The orchestrator can continue independent work (status updates, preparation) while subagents execute. However, the TDD lifecycle is inherently sequential — each step depends on the previous step's result — so async is primarily for keeping the main chat unblocked, not for parallel execution of dependent steps.

---

## 11. Extension Event Strategy

| Brief Requirement | pi Extension Event / API | Implementation |
|---|---|---|
| Orchestrator cannot edit files | `pi.setActiveTools()` + `pi.on("tool_call")` | Whitelist removes `edit`/`write`; interception blocks unsafe `bash` and raw `git` |
| Orchestrator cannot read full files | `pi.setActiveTools()` | Remove `read` from active tools list |
| Git abstraction | `pi.registerTool("pi_coder_git")` + `tool_call` interception | Block raw `git` commands; redirect to structured tool |
| System prompt replacement | `pi.on("before_agent_start")` | Replace system prompt with orchestrator identity + FSM state |
| User approval for specs | `interview` tool or `ctx.ui.confirm()` | Present spec to user; branch on approval |
| TDD validation | `pi.registerTool("pi_coder_run_tests")` | Execute test command; parse exit code; drive FSM transition |
| Knowledge persistence | `pi.registerTool("upsert_knowledge")` | Write/update `.pi-coder/knowledge/*.md` |
| Context pruning | Subagent `context: "fresh"` + structured task payloads | Fresh context ensures no context pollution; task contains only pruned data |
| Circuit breaker | State machine loop counter | When `loopCount >= maxLoops` → `BLOCKED`, notify user |
| Spec file cleanup | State machine teardown in COMPLETE state | `node:fs.unlink()` or `rm` for `.pi-coder/specs/{spec-id}.md` |
| Progress visibility | `ctx.ui.setStatus()`, `ctx.ui.setWidget()` | Show current phase, loop count, spec status |
| Toggle orchestrator mode | `/pi-coder` command | Switch between restricted orchestrator mode and normal Pi mode |
| Session state persistence | `pi.appendEntry()` | FSM state, toggle state, spec ID survive restarts/compaction |

---

## 12. Configuration — `.pi-coder/`

```
.pi-coder/
├── config.json           # Test command, max loops, git strategy, branch prefix
├── knowledge/
│   └── *.md              # Persistent learnings (e.g., supabase-auth-flow.md)
└── specs/
    └── {spec-id}.md      # Active specs (cleaned up on completion)
```

### Default `config.json`

```json
{
  "testCommand": "npm test",
  "maxLoops": 3,
  "gitStrategy": "branch-and-merge",
  "branchPrefix": "pi-coder/"
}
```

The `testCommand` is auto-detected from `package.json` scripts during init, falling back to `npm test`.

---

## 13. Estimated Scope

| Component | Estimated LOC | Complexity |
|---|---|---|
| State machine (`state-machine.ts`) | ~200 | Medium — finite state transitions, persistence |
| Git abstraction (`git.ts`) | ~150 | Low — wrappers around `pi.exec("git", [...])` |
| Knowledge system (`knowledge.ts`) | ~80 | Low — file read/write |
| Spec management (`spec.ts`) | ~100 | Low — file lifecycle |
| TDD runner (`tdd-runner.ts`) | ~120 | Low — exec test command, parse exit code |
| Tool definitions (`tools.ts`) | ~200 | Low — `registerTool` for each |
| Extension main (`extensions/index.ts`) | ~400 | Medium — event wiring, system prompt, state machine driver |
| Agent .md files | ~150 | Medium — prompt engineering is the hard part |
| Skill (`SKILL.md`) | ~100 | Low — description + usage instructions |
| Prompt templates | ~150 | Low — TDD phase templates |
| **Total** | **~1,650** | Genuinely thin, as the brief requires |

---

## 14. Resolved Design Decisions

### 14.1 Who Drives the FSM? — LLM Drives, Extension Guards

**Decision:** The LLM decides *what* to do. The extension validates, auto-transitions on deterministic events, and nudges when the LLM stalls.

**Why this paradigm:** "Semi-deterministic" means some parts require LLM judgment (how to brief a subagent, how to prune context) and some parts are deterministic (test results drive state transitions). The deterministic parts must not be left to LLM discretion — that would make the harness unreliable. But the LLM must retain agency over judgment calls.

**Extension responsibilities (deterministic):**
- Validate tool calls against FSM state — block `pi_coder_run_tests` unless state is `TDD_RED_VALIDATE` or `TDD_GREEN_VALIDATE`
- Block `subagent` to implementor unless state is `TDD_RED_WRITE` or `TDD_GREEN_WRITE`
- Auto-transition FSM on `tool_result` for `pi_coder_run_tests`: RED_VALIDATE → GREEN_WRITE on test failure, GREEN_VALIDATE → REVIEWING on test pass
- Auto-transition FSM on `tool_result` for `subagent`: RESEARCHING → PRUNING when researcher returns, etc.
- Nudge: if the LLM finishes a turn and the FSM expects action (e.g., state is `RESEARCHING` but no subagent call was made), inject a steering message via `pi.sendMessage`

**LLM responsibilities (judgment):**
- Decide what to tell subagents (brief content, context pruning)
- Decide when to call `subagent()` for the next step
- Handle non-deterministic decisions (spec content, how to respond to review findings)
- Handle user conversations that don't require FSM transitions

**Key invariant:** The LLM can never put the FSM into an invalid state because the extension blocks invalid tool calls.

**Implementation pattern:**
```typescript
pi.on("tool_call", async (event) => {
  if (!piCoderActive) return;
  const state = stateMachine.currentState;

  // Validate pi_coder_run_tests against allowed states
  if (event.toolName === "pi_coder_run_tests") {
    if (!["TDD_RED_VALIDATE", "TDD_GREEN_VALIDATE"].includes(state)) {
      return { block: true, reason: `Cannot run tests in state ${state}. Current state requires delegation.` };
    }
  }

  // Validate subagent delegation against allowed states and agents
  if (event.toolName === "subagent") {
    const targetAgent = // parse from event.input
    if (targetAgent?.includes("implementor") && !["TDD_RED_WRITE", "TDD_GREEN_WRITE"].includes(state)) {
      return { block: true, reason: `Cannot delegate to implementor in state ${state}.` };
    }
  }
});

pi.on("tool_result", async (event) => {
  if (!piCoderActive) return;
  const state = stateMachine.currentState;

  // Auto-transition on deterministic test results
  if (event.toolName === "pi_coder_run_tests") {
    const result = parseTestResult(event);
    if (state === "TDD_RED_VALIDATE") {
      if (result.exitCode !== 0) {
        stateMachine.transition("TDD_GREEN_WRITE"); // Tests fail — expected
      } else {
        stateMachine.transition("BLOCKED"); // Tests pass — tautology or feature exists
        // Inject steering message to alert orchestrator
        pi.sendMessage({ customType: "pi-coder-fsm-alert", content: "RED validation passed (tests should fail). Transitioned to BLOCKED." }, { triggerTurn: true });
      }
    }
    if (state === "TDD_GREEN_VALIDATE") {
      if (result.exitCode === 0) {
        stateMachine.transition("REVIEWING"); // Tests pass — expected
      } else {
        stateMachine.transition("TDD_GREEN_WRITE"); // Tests fail — back to implementation
      }
    }
  }

  // Auto-transition on subagent completions
  if (event.toolName === "subagent") {
    if (state === "RESEARCHING") stateMachine.transition("PRUNING");
    // etc.
  }
});
```

### 14.2 Config-Driven Per-State Nudge System

**Decision:** A configurable, per-state turn-count nudge system with escalation. When the orchestrator spends too many turns in a state without taking the expected action, the extension injects increasingly assertive reminders into the system prompt.

**Why not a heuristic detector:** Detecting whether the LLM has "stalled" via heuristics (did it read a file? did it type a certain pattern?) is fragile. Turn counting is deterministic, predictable, and cheap. The LLM can't game it, and the user can tune it.

**Why per-state thresholds:** Not all states should have the same patience. In RESEARCHING, the orchestrator should delegate immediately (1 turn). In PRUNING, it's doing its own synthesis work (3 turns). A single threshold would be either too aggressive for orchestrator-work states or too patient for action states.

#### Two Categories of State

**Action states** — the orchestrator should trigger something immediately (1 turn default patience):

| State | Expected Action | Default Threshold |
|---|---|---|
| RESEARCHING | Delegate to `pi-coder.researcher` | 1 |
| GIT_CHECKPOINT | Call `pi_coder_git` | 1 |
| TDD_RED_WRITE | Delegate to `pi-coder.implementor` | 1 |
| TDD_RED_VALIDATE | Call `pi_coder_run_tests` | 1 |
| TDD_GREEN_WRITE | Delegate to `pi-coder.implementor` | 1 |
| TDD_GREEN_VALIDATE | Call `pi_coder_run_tests` | 1 |
| REVIEWING | Delegate to `pi-coder.reviewer` | 1 |

**Orchestrator-work states** — the LLM is doing its own thinking (higher patience):

| State | Expected Action | Default Threshold |
|---|---|---|
| PRUNING | Complete pruning, advance to DRAFTING_SPEC | 3 |
| DRAFTING_SPEC | Draft spec, present to user | 2 |
| BLOCKED | Present options to user | 2 |

**No-nudge states** — user-facing or idle:

IDLE, SPEC_APPROVED, FINAL_APPROVAL, COMPLETE — no nudge configured.

#### Escalation Levels

Nudges are not merely repeated — they escalate in assertiveness:

1. **Level 1 (turn N, threshold reached):** Gentle reminder in system prompt — *"Reminder: You are in state TDD_RED_WRITE. The expected next action is to delegate to pi-coder.implementor for the RED phase."*
2. **Level 2 (turn N+1):** Direct instruction — *"You must now delegate to pi-coder.implementor. This is a required step in the TDD lifecycle. The FSM cannot advance until this action is taken."*
3. **Level 3 (turn N+2):** Escalate to user — inject a user-visible message: *"Pi Coder: The orchestrator has not progressed past state TDD_RED_WRITE after 3 turns. Would you like to intervene, skip this step, or abort the spec?"*

After level 3, no further nudges — the ball is in the user's court. This prevents infinite nudge loops.

#### Counter Mechanics

- **Increment** on each `before_agent_start` (each LLM turn) while in the same FSM state
- **Reset** on FSM state transition (entering a new state starts fresh)
- **Reset** when the expected action is detected via `tool_call` — the LLM *tried* to take action, even if it hasn't completed yet. Attempt counts. This prevents nudging the LLM after it's already called the subagent but is waiting for the result.
- **Count all turns equally** — including turns where the user asked a question and the orchestrator just answered. If the orchestrator is having an extended conversation in RESEARCHING state instead of delegating, the nudge should fire. That's exactly the scenario it's designed for.

#### Why Not Auto-Advance Instead of Nudge?

Because the extension doesn't know *what* to say to the subagent. The LLM's judgment about brief content, context pruning, and task framing is the value-add. Auto-advancing would mean the extension calls `subagent()` on its own — but with what task payload? A generic one? That defeats the "fat prompts" philosophy where the LLM's intelligence is the driver.

The nudge preserves the LLM's agency while ensuring it doesn't stall. Auto-advance would run the process; nudging makes the LLM run the process.

#### Why Not Just Use the FSM Guards from §14.1?

The FSM guards (tool_call validation) prevent the LLM from taking *wrong* actions. The nudge system ensures the LLM takes the *right* action. They're complementary:
- **Guards** = "you can't do that here"
- **Nudges** = "you should do this next"

The FSM without nudges is a restriction engine. The FSM with nudges is a guidance engine. Both are needed for semi-deterministic orchestration.

#### Config Structure

```json
{
  "nudge": {
    "enabled": true,
    "defaults": {
      "turnsBeforeNudge": 1,
      "escalationLevels": 3
    },
    "states": {
      "PRUNING": { "turnsBeforeNudge": 3 },
      "DRAFTING_SPEC": { "turnsBeforeNudge": 2 },
      "BLOCKED": { "turnsBeforeNudge": 2 },
      "IDLE": { "enabled": false },
      "SPEC_APPROVED": { "enabled": false },
      "FINAL_APPROVAL": { "enabled": false },
      "COMPLETE": { "enabled": false }
    }
  }
}
```

States not explicitly listed inherit from `defaults` (1 turn, 3 escalation levels). This means the action states (RESEARCHING, TDD_RED_WRITE, etc.) get the default 1-turn threshold without needing explicit config entries — which is correct because they should act immediately.

The `nudge` key is optional in `config.json`. If absent, the defaults are used. If present, values override defaults for specified states.

#### Implementation Pattern

```typescript
// Track state in memory (persisted via appendEntry on state transitions)
interface NudgeState {
  fsmState: string;
  turnsSinceEntry: number;
  actionAttempted: boolean;
  lastNudgeLevel: number;
}

// In before_agent_start:
pi.on("before_agent_start", async (event, ctx) => {
  if (!piCoderActive) return;

  const nudgeState = getNudgeState();
  const config = getNudgeConfig();
  const stateConfig = config.states[nudgeState.fsmState];

  // Check if nudging is enabled for this state
  if (stateConfig?.enabled === false) return;

  const threshold = stateConfig?.turnsBeforeNudge ?? config.defaults.turnsBeforeNudge;
  const maxLevel = config.defaults.escalationLevels;

  // Increment turn counter
  nudgeState.turnsSinceEntry++;

  // Check if nudge is needed
  if (!nudgeState.actionAttempted && nudgeState.turnsSinceEntry > threshold && nudgeState.lastNudgeLevel < maxLevel) {
    nudgeState.lastNudgeLevel++;
    const nudgeMessage = buildNudgeMessage(nudgeState.fsmState, nudgeState.lastNudgeLevel);

    if (nudgeState.lastNudgeLevel >= maxLevel) {
      // Escalate to user via injected message
      ctx.ui.notify(nudgeMessage, "warning");
    } else {
      // Inject as system prompt append
      event.systemPromptOptions.appendSystemPrompt =
        (event.systemPromptOptions.appendSystemPrompt ?? "") + "\n\n" + nudgeMessage;
    }
  }
});

// In tool_call handler — detect expected actions:
pi.on("tool_call", async (event) => {
  if (!piCoderActive) return;
  const nudgeState = getNudgeState();
  const expectedAction = getExpectedActionForState(nudgeState.fsmState);

  if (event.toolName === expectedAction?.tool) {
    nudgeState.actionAttempted = true;
  }
});

// On FSM state transition — reset nudge state:
function onStateTransition(newState: string) {
  setNudgeState({
    fsmState: newState,
    turnsSinceEntry: 0,
    actionAttempted: false,
    lastNudgeLevel: 0,
  });
}
```

### 14.3 How Does the User Start a Spec? — First Prompt After Toggle-On

**Decision:** When pi-coder is toggled on, the first user prompt naturally begins intake. The orchestrator's system prompt instructs it to assess whether the input is an implementation request or a question.

- **Implementation request** → LLM calls `subagent({ agent: "pi-coder.researcher" })`, extension transitions IDLE → RESEARCHING
- **Question/conversation** → LLM answers normally within orchestrator constraints, FSM stays IDLE

**Why not a `/pi-coder-start` command:** It adds friction for no real benefit. The orchestrator is intelligent enough to distinguish "implement auth" from "what files are in this directory?" Adding a command means the user has to remember a special syntax for something that should feel natural.

**Subsequent prompts during mid-cycle:** Handled by pi's built-in message queue. Steering messages are delivered after the current assistant turn, follow-ups after all tool calls complete. They go to the orchestrator, NOT to running subagents.

### 14.4 Spec ID Generation — Slug with Counter

**Decision:** Generate spec IDs from the user's request text — slugified, sanitized, with a counter suffix on collision.

Examples: `user-authentication`, `user-authentication-2`, `api-error-handling`

**Why:** Git branches and spec files need to be meaningful to humans. UUIDs are opaque. Pure counters are meaningless when you have 15 branches and need to remember which one was the auth work.

**Implementation:**
```typescript
function generateSpecId(userRequest: string, existingSpecs: string[]): string {
  const base = userRequest
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  if (!existingSpecs.includes(base)) return base;
  let counter = 2;
  while (existingSpecs.includes(`${base}-${counter}`)) counter++;
  return `${base}-${counter}`;
}
```

### 14.5 How Does the Reviewer See the Diff? — Self-Discovery via Bash

**Decision:** The orchestrator passes the pre-implementation git ref in the task payload. The reviewer runs `git diff` itself.

**Task payload example:** "Review the diff against commit `abc1234`. Run `git diff abc1234` to see changes. Review against these Acceptance Criteria: [...]"

**Why not embed the diff in the payload:**
- Large diffs bloat the task payload and the reviewer's context
- The reviewer can scan selectively — `git diff abc1234 -- src/auth/` for a specific area
- The reviewer has `bash` in its tool set already

**This applies to the implementor too:** For the GREEN phase, the implementor should run `git diff` to see what was written in the RED phase rather than having the orchestrator copy the test content into the task payload. The implementor's task says: "GREEN phase: Write code to make the tests pass. The tests were written against commit `abc1234`. Run `git diff abc1234` to see the test files."

### 14.6 Red Phase Anomaly Recovery — BLOCKED with Three Options

**Decision:** When tests pass during RED validation (they should fail), transition to `BLOCKED` with `reason: "RED_TAUTOLOGY"`. Present the user with three options via `interview`:

1. **Continue anyway** — Tests already cover existing behavior. Skip to `TDD_GREEN_WRITE` and write only the new code.
2. **Rewrite tests** — Go back to `TDD_RED_WRITE` with instruction: write tests for only the NEW behavior that doesn't exist yet.
3. **Abort spec** — Rollback to pre-implementation checkpoint, transition to IDLE.

**Why three options (not just halt):** The "tests pass during RED" scenario has multiple legitimate causes:
- The feature partially exists and tests cover existing behavior (option 1 is appropriate)
- The tests are genuinely tautological (option 2 is appropriate)
- The user changed their mind about the spec (option 3 is appropriate)

**Implementation:** The extension detects the anomaly in `tool_result`, transitions to BLOCKED, and injects a message telling the orchestrator to present the choice to the user.

### 14.7 Steering Messages Mid-Cycle — Embrace Pi's Message Queue

**Decision:** Use pi's built-in message queue as-is. Steering messages go to the orchestrator, not to running subagents.

- If the orchestrator is idle between subagent launches, the steering message is received on the next turn
- If an async subagent is running, the steering message is queued and delivered after the current orchestrator turn
- If the steering message changes the spec direction, the orchestrator can choose to interrupt the subagent via `subagent({ action: "interrupt" })` and adjust

**No special handling needed.** Pi's steering/follow-up mechanics already provide the right behavior. Document this as expected behavior in the skill.

### 14.8 Does the LLM Know the Full FSM? — Yes, Compact Reference in System Prompt

**Decision:** Include a compact FSM diagram in the system prompt (always present, ~10 lines).

**Why:** The LLM can't follow a process it can't see. A compact FSM reference prevents the LLM from attempting invalid sequences. This is analogous to how the `subagent` tool description includes its execution modes — procedural knowledge embedded where the LLM can see it.

**What the system prompt includes (static portion of §4.2):**
```
FSM States & Transitions:
IDLE → RESEARCHING → PRUNING → DRAFTING_SPEC → SPEC_APPROVED →
GIT_CHECKPOINT → TDD_RED_WRITE → TDD_RED_VALIDATE →
TDD_GREEN_WRITE → TDD_GREEN_VALIDATE → REVIEWING →
(APPROVED → FINAL_APPROVAL → MERGING → COMPLETE) |
(NEEDS_CHANGES → TDD_RED_WRITE) | (BLOCKED → user intervention)

Current state: {dynamic}
Active spec: {dynamic}
Loop count: {dynamic}/{maxLoops}
```

The dynamic portion (current state, active spec, loop count) is injected per-turn via `before_agent_start` as defined in §4.2.

### 14.9 SKILL.md Content — Orchestrator's Detailed Reference Manual

**Decision:** The SKILL.md is the orchestrator's procedural reference, loaded on-demand. The system prompt contains identity + FSM summary + tool restrictions (compact, always in context). The skill contains detailed procedures the orchestrator reads when it needs them.

**SKILL.md contents:**
- **TDD lifecycle steps** in detail (what to do at each FSM state)
- **How to brief each subagent** (task payload format per agent, per phase)
- **Context pruning guidelines** (what to extract from research, what to omit)
- **FSM transition rules per state** (valid actions, expected outcomes)
- **Recovery procedures** for BLOCKED state (RED_TAUTOLOGY, CIRCUIT_BREAKER)
- **Review synthesis** (how to interpret reviewer verdict and decide next action)
- **Knowledge consolidation** criteria (when to persist learnings, what's worth persisting)
- **Knowledge base discovery** (list `.pi-coder/knowledge/` with `ls`, include relevant filenames in researcher briefing)

This is the "fat prompt" philosophy — detailed instructions that the LLM loads on-demand rather than keeping always in context. The orchestrator loads the skill when it starts a cycle and follows its instructions.

### 14.10 Prompt Templates — Deferred to v2

**Decision:** Skip prompt templates for v1. The orchestrator constructs task payloads directly based on its system prompt + skill instructions. Prompt templates (`/tdd-red`, `/tdd-green`, `/spec-approval`) would be user-facing shortcuts to manually trigger or restart phases — that's a UX convenience, not a core requirement.

**Remove from package structure:** The `prompts/` directory and `"prompts": ["./prompts"]` in `package.json` can be added later. The orchestrator already knows what to do from the FSM state + skill.

### 14.11 Intercom / `contact_supervisor` — Implementor Only

**Decision:** Enable escalation for the implementor only. Disable for the researcher and reviewer.

- **Implementor**: Yes. Mid-GREEN-phase, the implementor may need clarification: "The acceptance criteria say 'validate input' — should I sanitize HTML or just check types?" Or: "I need to modify a test during GREEN phase — is this approved?" This mirrors real TDD where the developer asks the PM.
- **Reviewer**: No. Asking the orchestrator during adversarial review defeats the purpose. The reviewer should be independent and report findings, not seek approval mid-review.
- **Researcher**: No. Its job is to investigate and report. If it can't find something, it reports that as a gap in its findings.

**Implementation:** pi-subagents with pi-intercom makes this available automatically when the intercom bridge is active. The implementor's agent .md should mention that `contact_supervisor` is available for decisions that require orchestrator approval. No special configuration needed — just prompt-level guidance in the agent .md.

### 14.12 pi-subagents Dependency — Graceful Degradation

**Decision:** If pi-subagents isn't installed, block FSM activation but still allow init and config commands.

**Degradation behavior:**
1. `/pi-coder-init` runs normally but warns: "pi-subagents not detected. Delegation features will not work until installed: `pi install npm:pi-subagents`"
2. `/pi-coder` toggle blocks activation and shows: "Pi Coder requires the pi-subagents package. Install with: `pi install npm:pi-subagents`"
3. `/pi-coder-reset-agents` works regardless (it's just file operations)
4. The extension's `session_start` handler checks `pi.getAllTools()` for the `subagent` tool and sets a `subagentsAvailable` flag
5. When `subagentsAvailable` is false, the `before_agent_start` handler does NOT replace the system prompt (pi runs normally) and the toggle command does NOT activate orchestrator mode

**Why not hard-require:** Init creates directory structure and agent files — both useful even without pi-subagents. The user might install it later. Hard-requiring would prevent setup from completing.

### 14.13 Knowledge Base Discovery — Orchestrator Lists, Researcher Reads

**Decision:** The orchestrator uses `ls` on `.pi-coder/knowledge/` and includes relevant filenames in the researcher's task payload. The researcher reads only those files.

**Why no manifest/index:** Filenames in `.pi-coder/knowledge/` are descriptive (convention enforced by the `upsert_knowledge` tool description). The filenames themselves serve as the index — `supabase-auth-flow.md`, `error-handling-patterns.md`, `api-conventions.md` are self-documenting.

**Workflow:**
1. Orchestrator receives user request (e.g., "implement user authentication with Supabase")
2. Orchestrator: `ls .pi-coder/knowledge/` → `supabase-auth-flow.md`, `error-handling-patterns.md`, `api-conventions.md`
3. Orchestrator includes in researcher task: "Relevant knowledge files: `.pi-coder/knowledge/supabase-auth-flow.md`, `.pi-coder/knowledge/api-conventions.md`"
4. Researcher reads only the listed files

This is the most context-efficient approach. No redundant manifest to maintain. No reading all knowledge files when only two are relevant.

---

## 15. Remaining Risk Areas

1. **Bash availability in orchestrator:** Current decision is to NOT include `bash` in `ORCHESTRATOR_TOOLS`. The `pi_coder_run_tests` tool handles test execution internally. If we later find the orchestrator needs specific bash commands, we add them via the `tool_call` interception allowlist.

2. **Compaction safety:** Long TDD cycles may trigger auto-compaction. FSM state persists via `appendEntry` (survives compaction). Spec text and research summaries are persisted to `.pi-coder/specs/` files, so they can be re-read by subagents after compaction. However, the orchestrator's own working memory of the cycle (what happened in previous turns) will be lost. The skill should instruct the orchestrator to re-read the spec file via subagent delegation if compaction occurs mid-cycle.

3. **Session interruption:** If the user Ctrl+C's mid-cycle, the state machine should resume cleanly. The `session_start` handler restores state from `appendEntry` + spec files.

4. **Config auto-creation:** Should `.pi-coder/config.json` be auto-created on first run or require the init command? **Current decision:** Require the init command. Explicit is better than implicit.

5. **Subagent tool availability for `read`:** The orchestrator doesn't have `read`, but subagent agents (researcher, implementor, reviewer) all have `read` in their `tools:` frontmatter. This is correct — subagents run in their own processes with their own tool sets.

6. **Skills discovery without `read`:** Since we remove `read` from the orchestrator's tools, `buildSystemPrompt` won't auto-include the `<available_skills>` section. We must manually format and append it using `formatSkillsForPrompt` from pi-coding-agent. This ensures the orchestrator knows about available skills for delegation purposes.

---

## 16. Updated Package Structure

```
pi-coder-v1/
├── package.json              # pi-package, declares extension + skills
├── extensions/
│   └── index.ts              # Main extension: state machine, tools, events, system prompt
├── agents/
│   ├── pi-coder-researcher.md    # Custom researcher agent definition
│   ├── pi-coder-implementor.md   # Custom implementor agent definition
│   └── pi-coder-reviewer.md      # Custom reviewer agent definition
├── skills/
│   └── pi-coder/
│       └── SKILL.md          # Orchestrator's detailed procedural reference
└── src/
    ├── state-machine.ts      # FSM types, transitions, persistence, guard logic
    ├── git.ts                # Structured Git API (checkout_branch, checkpoint, rollback, merge)
    ├── knowledge.ts          # .pi-coder/knowledge/ read/write utilities
    ├── spec.ts               # .pi-coder/specs/ lifecycle management
    ├── tdd-runner.ts         # Test execution + Red/Green validation
    └── tools.ts              # Tool definitions (upsert_knowledge, pi_coder_git, pi_coder_run_tests)
```

**Removed:** `prompts/` directory — deferred to v2 per §14.9.

### Updated package.json

```json
{
  "name": "pi-coder-v1",
  "keywords": ["pi-package"],
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-ai": "*",
    "typebox": "*"
  },
  "dependencies": {},
  "pi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"]
  }
}
```

---

## 17. Updated Estimated Scope

| Component | Estimated LOC | Complexity |
|---|---|---|
| State machine (`state-machine.ts`) | ~250 | Medium — transitions, persistence, guard validation logic |
| Git abstraction (`git.ts`) | ~150 | Low — wrappers around `pi.exec("git", [...])` |
| Knowledge system (`knowledge.ts`) | ~80 | Low — file read/write |
| Spec management (`spec.ts`) | ~120 | Low — file lifecycle, spec ID generation |
| TDD runner (`tdd-runner.ts`) | ~120 | Low — exec test command, parse exit code |
| Tool definitions (`tools.ts`) | ~200 | Low — `registerTool` for each |
| Extension main (`extensions/index.ts`) | ~500 | Medium — event wiring, system prompt, FSM guards, auto-transitions, nudges, toggle, init, reset, dependency check |
| Agent .md files | ~200 | Medium — prompt engineering is the hard part |
| Skill (`SKILL.md`) | ~200 | Medium — detailed procedural instructions |
| **Total** | **~1,820** | Genuinely thin, as the brief requires |

---

## 18. Updated Implementation Order

1. **`package.json` + directory structure** — Scaffold the package (without `prompts/`)
2. **`state-machine.ts`** — Core FSM types, transitions, persistence, guard validation logic
3. **`spec.ts`** — Spec ID generation, spec file lifecycle
4. **`git.ts`** — Structured Git API (simplest, most self-contained)
5. **`tools.ts`** — Tool definitions (`pi_coder_git`, `pi_coder_run_tests`, `upsert_knowledge`)
6. **`knowledge.ts`** — Knowledge directory read/write utilities
7. **`tdd-runner.ts`** — Test execution and validation logic
8. **`extensions/index.ts`** — Extension main: register tools, hook events, implement toggle, FSM guards, auto-transitions, system prompt replacement, init command, reset command, dependency check
9. **Agent .md files** — `pi-coder-researcher.md`, `pi-coder-implementor.md`, `pi-coder-reviewer.md`
10. **Skill (`SKILL.md`)** — Orchestrator's detailed procedural reference
11. **Integration testing** — Full lifecycle smoke test
12. **Polish** — Status widgets, error recovery, compaction safety edge cases
