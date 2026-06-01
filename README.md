# Pi Coder v1

A multi-mode orchestrator/worker harness for [pi](https://github.com/earendil-works/pi-coding-agent) — structured coding with test-driven development, lightweight implementation, or investigation-only workflows.

Pi Coder replaces the default "you're a coding assistant" mode with a structured orchestrator that delegates all implementation to specialized subagents. It offers three modes: **TDD mode** enforces a strict Red→Green→Review lifecycle with a state machine; **Light mode** provides a spec→implement→review lifecycle without TDD phases; **Plan mode** restricts you to investigation and discussion only. The orchestrator cannot edit files, read file contents, or run arbitrary commands — it can only delegate, observe, and decide.

## Table of Contents

- [Philosophy](#philosophy)
- [Recommended Extensions](#recommended-extensions)
- [How It Works](#how-it-works)
- [Quick Start](#quick-start)
- [Modes](#modes)
- [Usage Tips](#usage-tips)
- [Specs](#specs)
- [State Persistence](#state-persistence)
- [Transition Guards & Evidence Flags](#transition-guards--evidence-flags)
- [Commands](#commands)
- [Damage Control](#damage-control)
- [Configuration](#configuration)
  - [logging](#logging)
  - [referenceProjects (Experimental)](#referenceprojects-experimental)
  - [notifications](#notifications)
- [Customization](#customization)
  - [MCP Server Access for Subagents](#mcp-server-access-for-subagents)
  - [Per-Agent Model Selection](#per-agent-model-selection)
- [The TDD Lifecycle](#the-tdd-lifecycle)
- [The Light Mode Lifecycle](#the-light-mode-lifecycle)
- [Extension Events](#extension-events)
- [Project Structure](#project-structure)
- [Architecture](#architecture)
- [Development](#development)
- [License](#license)

## Philosophy

**Fat prompts, thin harness.** All the intelligence lives in the subagent system prompts. The extension is minimal plumbing — a state machine, tool guards, and auto-transitions. If the LLM can skip a step, it will, so the FSM enforces the non-negotiables (spec approval before implementation, TDD discipline, review before merge). Everything else is guidance, not gates.

**The orchestrator is a manager, not an engineer.** It cannot edit files, read source code, or run arbitrary commands. It delegates, observes results, and makes decisions. This isn't a limitation — it's the point. A manager who can't do the work themselves is forced to communicate clearly, and clear communication produces better specs, better reviews, and better code.

**Deterministic where it matters, LLM-driven where it doesn't.** Test results auto-advance the FSM. Review verdicts auto-transition. But the orchestrator decides what to research, how to break work into units, and when to ask the user for clarification. The machine handles the bookkeeping; the LLM handles the judgment.

## Recommended Extensions

Pi Coder works on its own, but two pi packages make it significantly more effective:

### [pi-interview](https://www.npmjs.com/package/pi-interview) — Structured User Input

Provides the `interview` tool that Pi Coder uses for spec approval. The orchestrator presents a multi-question form — scope, acceptance criteria, constraints, key files — and you review and approve in one structured interaction instead of back-and-forth chat. Without it, spec approval falls back to a simple conversation, which works but is less rigorous and more prone to miscommunication.

```bash
pi install npm:pi-interview
```

### [pi-intercom](https://www.npmjs.com/package/pi-intercom) — Session Coordination

Provides the `intercom` tool that Pi Coder exposes to the orchestrator. Without it, the orchestrator can still coordinate subagents, but `intercom`-based session-to-session messaging won't be available.

```bash
pi install npm:pi-intercom
```

### [pi-web-access](https://www.npmjs.com/package/pi-web-access) — Web Research & Documentation Lookup

Gives the researcher subagent the ability to search the web and fetch documentation. Without it, the researcher is limited to local codebase exploration — no Stack Overflow, no library docs, no API references. For any project that depends on external libraries or APIs, this is essential.

```bash
pi install npm:pi-web-access
```

Install all three for the full experience:

```bash
pi install npm:pi-interview npm:pi-intercom npm:pi-web-access
```

## How It Works

Pi Coder adds an **orchestrator mode** to pi. When active, your pi session transforms:

- The system prompt is replaced with the orchestrator identity
- Tool access is restricted to delegation and observation tools only
- In **TDD mode**: a finite state machine (FSM) tracks the lifecycle, subagent calls are validated against FSM state, test results and review verdicts auto-advance the machine
- In **Light mode**: a simplified FSM enforces spec→implement→review→merge with no TDD phases
- In **Plan mode**: no FSM, researcher delegation only — investigation and discussion
- State and mode are persisted to disk — cycles survive crashes and session restarts

In TDD mode, the orchestrator follows this lifecycle:

```
IDLE → SPEC_WORK → SPEC_APPROVED →
GIT_CHECKPOINT → TDD_RED_WRITE → TDD_RED_VALIDATE →
TDD_GREEN_WRITE → TDD_GREEN_VALIDATE → REVIEWING | (next_unit) TDD_RED_WRITE →
(APPROVED → FINAL_APPROVAL → MERGING → COMPLETE) |
(NEEDS_CHANGES → TDD_RED_WRITE | REVIEWING) |
(TDD_RED_VALIDATE → TDD_GREEN_WRITE | BLOCKED) → user intervention
(GREEN retry limit: TDD_GREEN_WRITE → BLOCKED) → user intervention
```

In Light mode, the FSM is simpler — IMPLEMENTING replaces all four TDD states:

```
IDLE → SPEC_WORK → SPEC_APPROVED →
GIT_CHECKPOINT → IMPLEMENTING → REVIEWING →
(APPROVED → FINAL_APPROVAL → MERGING → COMPLETE) |
(NEEDS_CHANGES → IMPLEMENTING | REVIEWING) |
BLOCKED → user intervention
```

### Three Subagents

| Agent | Role | Tools |
|---|---|---|
| **Researcher** | Investigates codebase, checks knowledge files, produces structured research reports | `read`, `bash`, `grep`, `find`, `ls` |
| **Implementor** | Writes code in exclusive RED (tests only) or GREEN (implementation only) mode | `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls` |
| **Reviewer** | Independent adversarial review — checks test alignment, bugs, security, correctness | `read`, `bash`, `grep`, `find`, `ls` |

### Key Invariant

The orchestrator can **never** put the FSM into an invalid state. Tool calls are validated against the current state. Invalid delegations are blocked. Deterministic events (test results, subagent completions) auto-transition the FSM. The LLM decides *what* to do; the extension guards *whether* it can.

In Light mode, the FSM is simpler but still enforces the same non-negotiables: spec approval before implementation, review before merge. In Plan mode, there is no FSM — the extension restricts you to researcher delegation only.

## Quick Start

### 1. Install

```bash
pi install git:github.com/twsowerby/Pi-Coder-V1
```

Pi Coder requires [pi-subagents](https://www.npmjs.com/package/pi-subagents) as a peer dependency. Install it first if you haven't:

```bash
pi install npm:pi-subagents
```

### 2. Initialize your project

```
/pi-coder-init
```

This creates:
- `.pi-coder/knowledge/` — persisted project learnings
- `.pi-coder/knowledge/design_system.md` — starter template for UI patterns and component library
- `.pi-coder/specs/` — spec files for each feature
- `.pi-coder/config.json` — configuration (auto-detects your test runner)
- `.pi-coder/damage-control.json` — destructive command protection rules (sensible defaults)
- `.pi/agents/pi-coder-*.md` — agent definition files (copied from package defaults)
- `.pi/settings.json` — disables built-in subagents so only `pi-coder.*` agents are visible

**For team projects:** After init, edit `.pi-coder/config.json` and set `"mergeBranch": false` so pi-coder leaves the branch for you to merge or PR manually:

```json
{
  "createBranch": true,
  "mergeBranch": false
}
```

### 3. Choose your mode

```
/pi-coder
```

Shows a mode selection menu:

| Mode | Description | Best For |
|------|-------------|----------|
| **TDD** | Full lifecycle with spec, RED/GREEN phases, review | New features, bug fixes |
| **Light** | Spec→implement→review without TDD phases | Spot fixes, infrastructure work, existing projects |
| **Plan** | Investigation and discussion only | Research, requirements gathering, exploration |
| **Off** | Normal Pi — unrestricted | Quick questions, anything outside pi-coder |

You'll see the current mode in the status bar: `● TDD`, `⚡ Light`, `🔍 Plan`, or nothing (off). Mode switches don't trigger an LLM turn — the mode indicator is injected into the system prompt on the next turn and a notification is queued for delivery.

### 4. Make a request

Just describe what you want built. The orchestrator will:
1. Delegate to the **researcher** to investigate the codebase
2. Prune the research into an actionable **spec** with acceptance criteria
3. Present the spec for your approval
4. Create a git checkpoint and begin implementation

**In TDD mode:** Alternate RED (write tests) → GREEN (make tests pass) per unit → **Review** → merge

**In Light mode:** Delegate to implementor → run tests → **Review** → merge (no RED/GREEN phases)

**In Plan mode:** Only investigation and discussion — no spec, no git, no implementation. Switch to TDD or Light mode when you're ready to act.

## Modes

Pi Coder has four modes, selected via `/pi-coder`:

### TDD Mode

Full lifecycle enforcement. The orchestrator must follow the FSM: research → spec → approval → implementation (RED/GREEN) → review → merge. The state machine tracks progress, evidence flags enforce invariants, and the nudge system pushes the orchestrator forward if it stalls.

**When to use:** New features with clear acceptance criteria, bug fixes that need structured verification, any task where you want the discipline of test-first development.

**FSM lifecycle:**
```
IDLE → SPEC_WORK → SPEC_APPROVED → GIT_CHECKPOINT → TDD_RED_WRITE ↔ TDD_RED_VALIDATE →
TDD_GREEN_WRITE ↔ TDD_GREEN_VALIDATE → REVIEWING →
APPROVED → FINAL_APPROVAL → MERGING → COMPLETE
NEEDS_CHANGES → TDD_RED_WRITE | REVIEWING
```

**Available tools:** `ls`, `find`, `grep`, `subagent`, `pi_coder_git`, `pi_coder_run_tests`, `upsert_knowledge`, `pi_coder_save_spec`, `pi_coder_read_spec`, `pi_coder_advance_fsm`, `interview`, `intercom`

### Light Mode

A simplified FSM that enforces spec → implement → review → merge without TDD RED/GREEN phases. The orchestrator writes a spec, gets your approval, delegates to the implementor, and sends the result to the reviewer. There's one implementation state (IMPLEMENTING) instead of four TDD states.

**When to use:** Spot fixes, infrastructure changes, existing projects where RED/GREEN phases feel heavy, tasks that benefit from structured delegation but don't need test-first discipline.

**Key differences from TDD mode:**
- IMPLEMENTING replaces TDD_RED_WRITE / TDD_RED_VALIDATE / TDD_GREEN_WRITE / TDD_GREEN_VALIDATE
- `pi_coder_run_tests` is advisory — it doesn't gate FSM transitions (no auto-transitions based on pass/fail)
- No per-unit cycle — the implementor does all the work in one delegation
- Reviewer classifies fixes as functional or non-functional; non-functional fixes shortcut back to REVIEWING without re-implementation
- Spec workflow is the same: save → approve → checkpoint → implement → review → merge

**FSM lifecycle:**
```
IDLE → SPEC_WORK → SPEC_APPROVED → GIT_CHECKPOINT → IMPLEMENTING → REVIEWING →
APPROVED → FINAL_APPROVAL → MERGING → COMPLETE
NEEDS_CHANGES → IMPLEMENTING | REVIEWING
```

**Available tools:** `ls`, `find`, `grep`, `subagent`, `pi_coder_run_tests`, `pi_coder_git`, `upsert_knowledge`, `pi_coder_save_spec`, `pi_coder_read_spec`, `pi_coder_advance_fsm`, `interview`, `intercom`

### Plan Mode

Investigation and discussion only. No FSM, no spec workflow, no git, no tests. The orchestrator can only delegate to `pi-coder.researcher` — the implementor and reviewer are not available.

**When to use:** Requirements gathering, codebase exploration, architecture discussions, debugging investigations, understanding how something works before committing to implementation.

**Available tools:** `ls`, `find`, `grep`, `subagent`, `upsert_knowledge`, `interview`, `intercom`

**Not available in Plan mode:** `pi_coder_git`, `pi_coder_run_tests`, `pi_coder_save_spec`, `pi_coder_read_spec`, `pi_coder_advance_fsm`

**Typical workflow:**
1. Investigate — delegate to researcher to explore the codebase
2. Discuss — present findings and tradeoffs
3. Gather requirements — use `interview` for structured requirements
4. Persist findings — use `upsert_knowledge` to save cross-cutting gotchas
5. Switch to Light or TDD mode — use `/pi-coder` when you're ready to implement

### Off

Normal Pi. Full tool access, no orchestrator identity, no subagent scoping, no knowledge system.

**When to use:** Quick questions, tasks that don't need delegation, anything where you want unstructured access to Pi's full capabilities.

**Mode switching:** Switch modes at any time with `/pi-coder`. The mode change takes effect immediately — no LLM turn is triggered. The system prompt is rebuilt with the new mode's identity and tools on the next turn, and a `[MODE: ...]` indicator is prepended so the LLM always knows its current mode (even after mid-conversation switches).

**Cross-mode spec restore:** A spec started in one mode cannot be resumed in a different mode. If you started a TDD spec and switch to Light mode mid-cycle, you'll be warned that the on-disk state is incompatible. Start a fresh spec in the new mode, or switch back to the original mode to resume.

## Usage Tips

### Let the task decide the mode, not the project

The right mode depends on what you're asking the orchestrator to do:

- **TDD mode** when you want to *build* something — a new feature, a new module, a bug fix that needs structured verification. The spec approval catches misunderstandings early, RED/GREEN ensures tests exist before code, and the reviewer catches issues before they reach main.
- **Light mode** when you want to *do* something — fix a bug, update a dependency, refactor a module. These tasks benefit from delegation (researcher → implementor → reviewer) but don't need the test-first RED/GREEN cycle.
- **Plan mode** when you want to *understand* something — investigate a bug, explore a codebase, gather requirements, discuss architecture. No code changes happen — you get research and discussion only.
- **Off** for quick questions that don't need delegation at all ("what does this function do?").

### Switch modes mid-conversation

You can switch at any time with `/pi-coder`. Common patterns:

- **Start in Plan → switch to TDD or Light** when investigation is done and you're ready to implement. The researcher's findings and any knowledge saved in Plan mode carry forward.
- **Start in TDD → switch to Light** when the task turns out to be simpler than expected ("actually just fix that one test"). The FSM will be in whatever state it was in — switch back when you want to continue the formal lifecycle.
- **Start in Light → switch to TDD** when a spot fix reveals a bigger task. You'll need to start a new TDD cycle from IDLE.
- **Switch to Off** for quick questions that don't need delegation. Switch back when you're ready to work.

### Running tests is always available

`pi_coder_run_tests` works in **any FSM state** and in **both TDD and Light modes**. Only in TDD mode's validation states (`TDD_RED_VALIDATE`, `TDD_GREEN_VALIDATE`) do test results trigger auto-transitions. In Light mode and all other TDD states, you just get the results back — no FSM side-effects.

This means you can run tests at any time to check your bearings — in IDLE, during SPEC_WORK, after a review — without the FSM advancing unexpectedly.

### Configure your test commands in config.json

The `pi_coder_run_tests` tool supports a `suite` parameter: `"unit"`, `"e2e"`, or `"all"`. This only works if you've configured `testCommands` in `.pi-coder/config.json`:

```json
{
  "testCommands": {
    "unit": "npx vitest run",
    "e2e": "npx playwright test"
  }
}
```

Without `testCommands`, the tool falls back to the single `testCommand` and the `suite` parameter is ignored.

### If the orchestrator feels stuck, switch modes

If you find yourself in a TDD cycle where the orchestrator keeps going in circles (reviewing → changes → reviewing → changes), it's often because the spec is ambiguous or the acceptance criteria don't match what the code actually needs. Options:

1. **Switch to Light mode** — let the orchestrator work without FSM constraints
2. **Abort the cycle** — use `pi_coder_advance_fsm` to go to IDLE and start fresh
3. **Refine the spec manually** — edit `.pi-coder/specs/{id}/spec.md` yourself, then re-approve

### Don't force non-TDD tasks through the TDD lifecycle

The TDD lifecycle is for building things. If you just want to:
- **Explore or investigate** → Plan mode — delegate to the researcher
- **Run tests** → Light mode and ask the orchestrator to run them, or switch to Off
- **Investigate a bug** → Plan mode first, then Light mode to fix it
- **Make a quick change** → Light mode — delegate to the implementor, run tests to verify
- **Ask a question** → Off — just ask normally

The TDD FSM will block you if you try to use it for these tasks. That's by design — it's enforcing a process that doesn't apply.

### Fill in design_system.md for UI projects

If your project has a UI, fill in `.pi-coder/knowledge/design_system.md` (created by `/pi-coder-init`). The orchestrator checks for this file when a spec involves UI work. Without it, the implementor has no guidance on spacing, components, colors, or interaction patterns — and will invent its own.

Even a minimal design system file ("use these components", "spacing is 4px grid", "colors are in theme.ts") prevents the implementor from freestyling UI decisions.

## Specs

A **spec** is the single source of truth for a TDD cycle. It's a markdown file that captures the what, why, and how of a feature before implementation starts. Specs live in `.pi-coder/specs/{id}/` where `{id}` is a timestamped slug like `2026-05-25-1430-user-authentication`.

### What's in a spec

Every spec has these sections:

| Section | What it contains | Example |
|---|---|---|
| **Acceptance Criteria** | Specific, testable statements of what "done" looks like | `User can log in with email and password` |
| **Constraints** | Hard boundaries the implementation must respect | `Must use existing auth middleware` |
| **Key Files** | Files the implementor needs to know about | `src/auth/middleware.ts` |
| **Implementation Plan** | Atomic units of work, each mapping to specific ACs | `Auth API [AC1, AC2] → Session management [AC3]` |
| **Pruned Context** | Condensed research findings relevant to this spec | Explanation of the existing auth flow |

The **implementation plan** is critical — it breaks the spec into atomic units that the implementor tackles one at a time. Each unit references specific acceptance criteria so the implementor knows exactly what to test and implement. Units can have dependencies ("do X before Y") so the implementor works in the right order.

### Spec lifecycle

1. **SPEC_WORK** — The orchestrator delegates to the researcher, who investigates the codebase. The orchestrator synthesizes findings into a spec with ACs, constraints, key files, and an implementation plan. It saves the spec with `pi_coder_save_spec`.
2. **Approval** — The orchestrator presents the spec via `interview` with focused questions on scope, ACs, constraints, and the implementation plan. You review, modify, and approve (or reject and request changes).
3. **Implementation** —
   - **TDD mode:** The orchestrator delegates each unit to the implementor, one at a time, reading the spec fresh before each delegation. RED (write failing tests) → GREEN (make tests pass), per unit.
   - **Light mode:** The orchestrator delegates the full implementation to the implementor in one go. No per-unit cycle, no RED/GREEN phases.
4. **Review** — An independent reviewer checks the full implementation against the spec's ACs and constraints.
5. **Complete** — On approval, the branch is merged (or left for you to handle). The spec is archived in `.pi-coder/specs/`.

### Spec directory structure

Each spec is a directory containing two files:

```
.pi-coder/specs/2026-05-25-1430-user-authentication/
├── spec.md       ← The spec (markdown with YAML frontmatter)
└── state.json    ← FSM state, evidence flags, git ref
```

- **spec.md** — The structured spec. Created when `pi_coder_save_spec` is called (not before — no stale empty directories). You can read or edit this file directly if you want to adjust the plan before or during implementation.
- **state.json** — Machine-readable state for resuming cycles across sessions.

### Editing specs manually

Specs are just markdown files. If the orchestrator's plan doesn't match your intent, edit `.pi-coder/specs/{id}/spec.md` directly. The orchestrator reads the spec fresh before each delegation, so your changes take effect immediately — no restart needed.

## State Persistence

Pi Coder persists its mode and FSM state to disk. This means **your TDD cycles survive session restarts, context clears, and crashes**.

### What's stored

**Global state** (`.pi-coder/state.json`) — slim pointer:

```json
{
  "version": 1,
  "piCoderMode": "tdd",
  "activeSpecId": "2026-05-25-1430-user-authentication",
  "updatedAt": "2026-05-25T14:30:00.000Z"
}
```

`piCoderMode` can be `"tdd"`, `"light"`, `"plan"`, or `"off"`. When set to `"plan"` or `"off"`, there is no active FSM.

**Per-spec state** (`.pi-coder/specs/{id}/state.json`) — FSM + evidence:

```json
{
  "version": 1,
  "currentState": "TDD_GREEN_WRITE",
  "loopCount": 1,
  "gitRef": "a1b2c3d4",
  "evidence": ["spec_saved", "spec_user_approved", "test_run_this_state"],
  "createdAt": "2026-05-25T14:30:00.000Z",
  "updatedAt": "2026-05-25T14:45:00.000Z"
}
```
- Project learnings → `.pi-coder/knowledge/`
- Cycle history → `.pi-coder/logs/` (JSONL)
- Code changes → git (the branch and checkpoint are preserved)

See [Specs](#specs) for spec file structure and contents.

### On session start

When the extension initializes, it reads `state.json` and runs an integrity check:

1. **No file found** → fresh start at IDLE (normal first-run behavior)
2. **Valid state found** → restore the FSM, resume the cycle where it left off
3. **Integrity failure** → e.g. spec file referenced but deleted — the extension warns the user and resets to IDLE rather than restoring a broken state
4. **Terminal state** (IDLE or COMPLETE) → restore the toggle, clean up the file, no cycle to resume

Writes are **atomic** (write to `.tmp`, then rename) so a crash mid-write leaves the previous state intact.

### When to resume vs. restart

- **Resume**: If you close your terminal, start a new session, or run `/pi-coder` again — the orchestrator picks up where it left off
- **Restart**: Use `/pi-coder-reset-agents` to reset agent files, or manually delete `.pi-coder/state.json` (and the relevant `.pi-coder/specs/{id}/state.json`) to force a fresh cycle

## Transition Guards & Evidence Flags

The FSM **enforces invariants**, not just the orchestrator prompt. Before allowing a transition, the state machine checks that required evidence is present. If evidence is missing, the transition is blocked with a clear error message.

### Evidence Flags

| Flag | Set by | Cleared by | Purpose |
|---|---|---|---|
| `spec_saved` | `pi_coder_save_spec` | IDLE reset | Spec file exists on disk |
| `spec_user_approved` | `interview` tool_result in SPEC_WORK | IDLE reset | User saw and approved the spec |
| `test_run_this_state` | `pi_coder_run_tests` | Any state transition | Tests were actually run in this validation state |
| `non_functional_classified` | Reviewer verdict extraction (needs `fixType: non-functional`) | IDLE reset | Fix was classified as non-functional by the reviewer |

### Guarded Transitions

| Transition | Evidence required | Why |
|---|---|---|
| SPEC_WORK → SPEC_APPROVED | `spec_saved` + `spec_user_approved` | Cannot implement without a saved, user-approved spec |
| TDD_RED_VALIDATE → TDD_GREEN_WRITE | `test_run_this_state` | Cannot skip RED validation — must actually run tests |
| TDD_GREEN_VALIDATE → exits | `test_run_this_state` | Cannot skip GREEN validation — must actually run tests |
| TDD_GREEN_WRITE → BLOCKED | (automatic on retry limit) | GREEN retry escalation prevents infinite loops |
| NEEDS_CHANGES → REVIEWING (non-functional) | `non_functional_classified` | Cannot shortcut to re-review without reviewer classification |

This prevents the LLM from shortcutting through validation states without executing tests, or advancing to implementation without user spec approval, or claiming a fix is non-functional without the reviewer's independent classification. The FSM is the single source of truth for process invariants.

### RED Tautology Handling

When tests pass during the RED phase (RED tautology), the FSM no longer auto-transitions to BLOCKED. Instead, the extension appends guidance to the test result with two options:

1. **Acknowledge and proceed** (`pi_coder_advance_fsm TDD_GREEN_WRITE`) — the test coverage is valid even though tests passed immediately. This is the common case for:
   - Adding assertions to existing passing tests (verification, not TDD)
   - Implementor applied code+test simultaneously but coverage is valid
   - Extending test coverage for behavior that already exists

2. **Block and recover** (`pi_coder_advance_fsm BLOCKED`) — the tests passing is genuinely problematic (tests are tautological or wrong). In BLOCKED, the orchestrator presents recovery options.

The key insight: the invariant is "all behavior is tested," NOT "every test must fail before it passes." A verification test that passes immediately is still a valid test.

### GREEN Retry Escalation

When tests fail during GREEN validation (`TDD_GREEN_VALIDATE`), the FSM auto-transitions back to `TDD_GREEN_WRITE` so the implementor can try again. Previously, this loop could continue indefinitely with the same vague steer ("Tests still failing. Delegate again with clearer instructions."). Now, the retry counter triggers escalating intervention:

1. **Standard** (retries 1–3) — Normal steer: delegate again with clearer instructions.
2. **Enriched** (retries 4+) — Specific guidance: include failing test names and assertion errors from the output, focus on ONE test at a time, don't repeat failed approaches.
3. **REPLAN** (retries 7+) — Forces strategic analysis: the orchestrator must READ the code, ANALYZE the gap, and FORMULATE a fresh approach before retrying. Blind iteration is explicitly blocked.
4. **Hard block** (retries 10+) — FSM transitions to `BLOCKED`. Human intervention is required.

Test output is now **always included** in validation responses — both the verdict (e.g. `GREEN validation: FAILED`) and the raw test output showing what specifically failed. Previously, the validation branch suppressed the raw output, leaving the implementor blind to what actually went wrong.

## Commands

| Command | Description |
|---|---|
| `/pi-coder` | Switch mode (TDD / Light / Plan / Off) via selection menu |
| `/pi-coder-init` | Initialize `.pi-coder/` structure and config |
| `/pi-coder-reset-agents` | Reset agent `.md` files to package defaults (requires confirmation) |
| `/pi-coder-close` | Close an active spec (CANCELLED status, deletes state.json, keeps spec.md as audit trail) |
| `/pi-coder-logs` | Show interaction log statistics (supports session/spec filtering) |

## Damage Control

Pi Coder ships with a **damage-control extension** that guards against destructive operations — in both the orchestrator session and subagent sessions (researcher, implementor, reviewer). It applies to every session in the project because it's loaded at the package level.

When a destructive operation is blocked, the extension returns **actionable feedback** instead of just "no" — telling the agent what went wrong and how to adapt, so it can find another path in the same turn instead of retrying.

### What's blocked by default

**Bash commands:**

| Pattern | Why |
|---|---|
| `rm -rf` / `rm --recursive` | Recursive delete is destructive — use targeted removal |
| `sudo` | Requires host-level access — ask the user to run it |
| `git push --force` | Rewrites shared history — use a new commit instead |
| `git push --delete` | Deleting remote branches is destructive |
| `git reset --hard` | Discards uncommitted changes — use pi_coder_git rollback |
| `git clean -` | Removes untracked files — clarify what needs removing |
| `chmod 777` | Security risk — use minimum permissions |
| `truncate` | Truncating files is destructive — write new content instead |
| `mkfs` / `dd if=` | Can destroy filesystems |

**Protected paths:**

| Category | Paths | Effect |
|---|---|---|
| Zero-access | `.env`, `.env.local`, `.env.production`, `~/.ssh/`, `~/.gnupg/` | No read, write, or bash reference |
| Read-only | `.git/config` | Can read, cannot write or edit |
| No-delete | `.git/`, `node_modules/` | Cannot rm or mv |

**Why .env files are zero-access:** Pi does not redact secret values — if the `read` tool opens an `.env` file, API keys and secrets go straight into the LLM's context. By making `.env` files zero-access, the agent cannot read them at all and must assume the values it needs are present. If the agent genuinely needs a non-secret env value (like a `DATABASE_URL`), add it to `readOnlyPaths` in your `damage-control.json`.

### Configuring rules

Rules are loaded from `.pi-coder/damage-control.json` (created by `/pi-coder-init` with full defaults). When the file doesn't exist, the same defaults are used internally.

The scaffolded file contains all the defaults above so you can see exactly what's configured and edit it in place. Add, remove, or modify rules as needed for your project.

To add a project-specific rule, just append to the relevant array:

```json
{
  "rules": {
    "bashToolPatterns": [
      { "pattern": "\\bdropdb\\b", "reason": "Don't drop databases programmatically" }
    ],
    "zeroAccessPaths": [".env", ".env.local", ".env.production", "~/.ssh/", "~/.gnupg/", "secrets/"],
    "readOnlyPaths": [".git/config"],
    "noDeletePaths": [".git/", "node_modules/"]
  }
}
```

To disable damage-control entirely, set `"enabled": false`.

**Adjusting .env access:** By default, `.env`, `.env.local`, and `.env.production` are zero-access (no read at all). If the agent needs to read a non-secret env value, move the file from `zeroAccessPaths` to `readOnlyPaths` — it can then verify values exist while still preventing writes.

```json
{
  "rules": {
    "zeroAccessPaths": [".env.local", ".env.production", "~/.ssh/", "~/.gnupg/"],
    "readOnlyPaths": [".env", ".git/config"]
  }
}
```

This moves `.env` from zero-access to read-only, allowing the agent to check for keys while still preventing writes.

## Configuration

All configuration lives in `.pi-coder/config.json` (created by `/pi-coder-init`):

```json
{
  "testCommand": "npx vitest run",
  "testCommands": {
    "unit": "npx vitest run",
    "e2e": "npx playwright test"
  },
  "maxLoops": 3,
  "retryEscalation": {
    "maxRetries": 10,
    "enrichedSteerThreshold": 4,
    "replanThreshold": 7
  },
  "createBranch": true,
  "mergeBranch": "merge",
  "branchPrefix": "pi-coder/",
  "interviewTimeout": 0,
  "nudge": {
    "enabled": true,
    "defaults": {
      "turnsBeforeNudge": 1,
      "escalationLevels": 3
    },
    "states": {
      "SPEC_WORK": { "turnsBeforeNudge": 3 },
      "BLOCKED": { "turnsBeforeNudge": 2 },
      "IDLE": { "enabled": false },
      "SPEC_APPROVED": { "enabled": false },
      "FINAL_APPROVAL": { "enabled": false },
      "COMPLETE": { "enabled": false }
    }
  },
  "logging": {
    "enabled": false,
    "level": "standard",
    "maxLogFiles": 10,
    "tokenPricing": {
      "anthropic/claude-sonnet-4": {
        "inputPerMillion": 3.0,
        "outputPerMillion": 15.0,
        "cacheReadPerMillion": 0.3,
        "cacheWritePerMillion": 3.75
      }
    },
    "timezone": "America/New_York",
    "sessionIdPrefix": "myapp"
  }
}
```

### `testCommand` (legacy)

The command used to run the project test suite. Auto-detected from `package.json` scripts during init (checks for `vitest` → `jest` → `test`). Examples:

- `"npm test"`
- `"npx vitest run"`
- `"npx jest"`

### `testCommands` (recommended)

Structured test commands — separate `unit` and optional `e2e` suites. The `pi_coder_run_tests` tool supports a `suite` parameter that uses these:

```json
{
  "testCommands": {
    "unit": "npx vitest run",
    "e2e": "npx playwright test"
  }
}
```

When `testCommands` is present, it's used instead of `testCommand`. The `suite` parameter defaults to `"unit"`. Auto-detected during init based on `package.json` dependencies (Playwright, Cypress).

### `dbCommands`

Database stack configuration — when configured, the orchestrator tells the researcher and implementor to inspect the actual database rather than relying solely on migration files or ORM types. The agents already know SQL and know how to use each stack's CLI tools — they just need to know *which* stack to use.

```json
{
  "dbCommands": {
    "stack": "supabase"
  }
}
```

**Fields:**

| Field | Type | Required | Description |
|---|---|---|---|
| `stack` | `string` | Yes | DB stack identifier. Known values: `supabase`, `prisma`, `drizzle`, `raw-pg`, `raw-mysql`, `raw-sqlite`. Custom strings allowed for unsupported stacks. |

**When `dbCommands` is null or absent**, no DB inspection instructions are injected — agents work from code and migrations only.

**Auto-detection:** `/pi-coder-init` detects the DB stack from `package.json` dependencies (`@supabase/supabase-js`, `@prisma/client`, `drizzle-orm`, `pg`, `mysql2`, `better-sqlite3`) and sets `dbCommands.stack` automatically. The generated `.pi-coder/knowledge/database.md` also documents the stack.

**Effect on agents:** When configured, the researcher inspects actual schema and sample data before reporting, and the implementor verifies assumptions against the live database before writing tests or code. This catches schema drift and missing constraints that migration files alone won't reveal. Agents use targeted queries (e.g. `supabase db query`, `psql -c`) — never full schema dumps like `supabase db dump` or `pg_dump`.

### `maxLoops`

Maximum number of review cycles before the circuit breaker halts the spec. Both functional (NEEDS_CHANGES → TDD_RED_WRITE) and non-functional (NEEDS_CHANGES → REVIEWING) fix cycles count toward the limit. When tripped, the orchestrator pauses and presents options to the user. Default: `3`.

### `retryEscalation`

Per-state retry counters with escalating intervention for the GREEN phase. When tests keep failing during `TDD_GREEN_VALIDATE`, the counter tracks how many times the FSM loops back to `TDD_GREEN_WRITE`. At each threshold, the steering message becomes progressively more forceful:

| Retry Count | Intervention | Behavior |
|---|---|---|
| 1–3 | **Standard** | Current behavior — tells the orchestrator to delegate again with clearer instructions |
| 4–6 | **Enriched steer** | Includes specific guidance: focus on ONE failing test, include assertion errors, don't repeat the same approach |
| 7–9 | **REPLAN** | Forces strategic analysis — the orchestrator must READ the code, ANALYZE the gap, and FORMULATE a fresh strategy before retrying |
| ≥ 10 | **Hard block** | Transitions to `BLOCKED` — requires human intervention |

```json
{
  "retryEscalation": {
    "maxRetries": 10,
    "enrichedSteerThreshold": 4,
    "replanThreshold": 7
  }
}
```

- **`maxRetries`** — Maximum GREEN retries before hard-blocking (FSM → BLOCKED). Default: `10`.
- **`enrichedSteerThreshold`** — Retry count at which enriched steers begin. Default: `4`.
- **`replanThreshold`** — Retry count at which REPLAN intervention begins. Default: `7`.

Thresholds must be ordered: `enrichedSteerThreshold < replanThreshold < maxRetries`. Invalid values are silently rejected and the defaults are used. Partial overrides work — only specify the keys you want to change:

```json
{
  "retryEscalation": { "maxRetries": 15 }
}
```

All retry escalation events are logged (`green_retry`, `green_retry_enriched`, `green_retry_replan`, `green_retry_blocked`) so you can analyze retry patterns across runs.

### `createBranch`

Whether to create a feature branch at the start of each TDD cycle.

- `true` (default) — pi-coder creates `{branchPrefix}{spec-id}` and checks it out during `GIT_CHECKPOINT`. At the end, the branch is merged or pushed.
- `false` — all work happens on the current branch. No branch is created. Use this when you want to manage branching yourself or work directly on main.

When `false`, `pi_coder_git checkout_branch` returns an error explaining that branch creation is disabled. The orchestrator falls back to committing directly on the current branch.

### `mergeBranch`

What happens when the TDD cycle completes and the code is approved:

| Value | Behavior |
|---|---|
| `"merge"` (default) | Standard `git merge` — feature branch merges back into the target branch |
| `"squash"` | `git merge --squash` + separate commit — squashes all feature commits into one |
| `false` | No merge — the cycle ends on the feature branch. You handle the merge or PR yourself |

When `mergeBranch` is `false`, the `pi_coder_git merge` action tells the orchestrator that the branch is ready and the user should merge or create a PR manually. No automatic push or merge happens — you stay in control.

**Example team workflow:**

```json
{
  "createBranch": true,
  "mergeBranch": false
}
```

Pi-coder creates a feature branch, does all the work, and stops. You merge or create a PR when you're ready.

**Example no-branch workflow:**

```json
{
  "createBranch": false,
  "mergeBranch": false
}
```

All work commits directly to the current branch. No branching, no merging. Use this for experimental prototyping where ceremony is overkill.

### Legacy `gitStrategy`

The older `gitStrategy` field (`"branch-and-merge"` | `"squash"`) is still supported — it migrates automatically to `createBranch: true` + `mergeBranch: "merge"` or `mergeBranch: "squash"` on load. You can safely remove it from your config and use the new fields.

### `branchPrefix`

Prefix prepended to all pi-coder branches. Branches are created as `{branchPrefix}{spec-id}` (e.g. `pi-coder/2026-05-25-1430-user-authentication`). Spec IDs use the format `YYYY-MM-DD-HHmm-slug` — a timestamp prefix that prevents duplicate names and gives natural chronological ordering.

### `interviewTimeout`

Timeout in seconds for the `interview` tool. The interview tool presents forms for spec approval and user decisions. Default: `0` (no timeout — wait indefinitely).

Pi's default interview timeout is 10 minutes, after which the interview auto-accepts the default options. This is dangerous for spec approval — you might not want the defaults. Setting `0` means the interview stays open until you respond, no matter how long you're away from the keyboard.

Set a specific number of seconds if you prefer a timeout:

```json
{
  "interviewTimeout": 3600
}
```

### `nudge`

The per-state nudge system prevents the orchestrator from stalling. When the orchestrator spends too many turns in a state without taking the expected action, the extension injects escalating reminders:

| Level | Behavior |
|---|---|
| 1 | Gentle reminder appended to system prompt |
| 2 | Urgent instruction appended to system prompt |
| 3 | User-visible notification |

**`nudge.enabled`** — master switch. Default: `true`.

**`nudge.defaults.turnsBeforeNudge`** — turns to wait before first nudge. Default: `1` (nudge on the 2nd turn if no action taken).

**`nudge.defaults.escalationLevels`** — maximum escalation levels (3 = reminder → urgent → user notification). Default: `3`.

**`nudge.states`** — per-state overrides. Each key is an FSM state name:

| State | Default Threshold | Notes |
|---|---|---|
| SPEC_WORK | 3 turns | Research & spec work — needs time for multiple research rounds |
| TDD_RED_WRITE, TDD_GREEN_WRITE, REVIEWING, GIT_CHECKPOINT, MERGING | 1 turn | Action states — expect immediate delegation |
| TDD_RED_VALIDATE, TDD_GREEN_VALIDATE | 1 turn | Test validation states |
| BLOCKED | 2 turns | Waiting for user intervention |
| IDLE, SPEC_APPROVED, FINAL_APPROVAL, COMPLETE | disabled | No nudge needed |

### `logging`

Structured interaction logging for process efficiency analysis and cost tracking. Logs are JSONL files in `.pi-coder/logs/`.

**`logging.enabled`** — master switch. Default: `false` (opt-in telemetry).

**`logging.level`** — controls which events are logged:

| Level | Events captured |
|---|---|
| `"minimal"` | FSM transitions, TDD validations, lifecycle start/end, circuit breaker, session summary |
| `"standard"` | All of minimal + subagent start/end (with model, tokens, cost, exit code), per-turn usage, review results, user commands, user interventions, state restore, spec approval, unit start/end, config validation |
| `"verbose"` | All of standard + nudge firings and escalations |

**`logging.maxLogFiles`** — maximum log files to retain per session directory. Oldest are deleted when exceeded. Default: `10`.

**`logging.tokenPricing`** — per-model pricing for cost estimation (optional). Keys are model identifiers (e.g., `"anthropic/claude-sonnet-4"`). When pi-subagents provides `usage.cost > 0`, that takes priority. This table is a fallback for custom providers or when cost is zero.

```json
{
  "logging": {
    "tokenPricing": {
      "anthropic/claude-sonnet-4": {
        "inputPerMillion": 3.0,
        "outputPerMillion": 15.0,
        "cacheReadPerMillion": 0.3,
        "cacheWritePerMillion": 3.75
      }
    }
  }
}
```

Each entry has `inputPerMillion` and `outputPerMillion` (required), plus optional `cacheReadPerMillion` and `cacheWritePerMillion`. When no pricing is configured, log analysis shows raw token counts with a note rather than cost estimates.

**`logging.timezone`** — IANA timezone for local timestamps (optional). When set, every log event gets a `localTimestamp` field in this timezone. When unset, uses the system's local timezone. Examples: `"America/New_York"`, `"Europe/London"`, `"Asia/Tokyo"`.

**`logging.sessionIdPrefix`** — prefix for the session log directory name (optional). When set, the session directory is named `{prefix}-{sessionId}` instead of just `{sessionId}`. Useful for identifying which project a log belongs to when multiple projects share the same log storage location. Example: `"myapp"` → `.pi-coder/logs/myapp-550e8400-e29b/2026-05-29.log`.

#### Log directory structure

Logs are organized by session — each pi session gets its own directory under `.pi-coder/logs/`:

```
.pi-coder/logs/
├── 550e8400-e29b-41d4-a716-446655440000/   ← Session 1
│   ├── 2026-05-29.log
│   └── 2026-05-30.log                        ← Cross-midnight session
├── myapp-6ba7b810-9dad-11d1-80b4-00c04fd430c8/  ← With sessionIdPrefix: "myapp"
│   └── 2026-05-29.log
└── 2026-05-25.log                            ← Legacy flat file (pre-session-scoped)
```

Each session directory contains one log file per day. Legacy flat files from older pi-coder versions are also read during log analysis for backward compatibility.

#### Log event format

Each log entry is a JSON object with dual timestamps:

```jsonl
{"timestamp":"2026-05-29T05:39:13.219Z","localTimestamp":"2026-05-29T15:39:13.000+10:00","sessionId":"550e8400-e29b","type":"fsm_transition","payload":{"from":"IDLE","to":"SPEC_WORK","trigger":"auto_subagent_complete","event":"start_research","loopCount":0,"specId":"user-auth","mode":"tdd","turnCount":3}}
{"timestamp":"2026-05-29T05:39:15.456Z","localTimestamp":"2026-05-29T15:39:15.000+10:00","sessionId":"550e8400-e29b","type":"subagent_end","payload":{"agent":"pi-coder.researcher","model":"anthropic/claude-sonnet-4","durationMs":2233,"tokenUsage":{"input":1200,"output":3500,"cacheRead":6000,"cacheWrite":1500,"cost":0.07},"turns":5,"exitCode":0,"error":null,"outcome":"success","specId":"user-auth","mode":"tdd","turnCount":4}}
{"timestamp":"2026-05-29T05:39:16.789Z","localTimestamp":"2026-05-29T15:39:16.000+10:00","sessionId":"550e8400-e29b","type":"turn_usage","payload":{"input":500,"output":800,"cacheRead":2000,"cacheWrite":500,"cost":0.02,"model":"anthropic/claude-sonnet-4","specId":"user-auth","fsmState":"SPEC_WORK","mode":"tdd","turnCount":5}}
```

- **`timestamp`** — always UTC ISO 8601
- **`localTimestamp`** — local time with timezone offset (configurable via `logging.timezone`)
- **`mode`** — included on every event payload (TDD/Light/Plan/Off)
- **`turnCount`** — included on every event payload

#### Event types reference

| Type | Level | Payload highlights |
|---|---|---|
| `lifecycle_start` | minimal | specId, fsmState |
| `lifecycle_end` | minimal | specId, outcome, wallClockMs, totalTokens {input, output, cacheRead, cacheWrite, cost, turns} |
| `fsm_transition` | minimal | from, to, **trigger** (typed), event (legacy), loopCount, specId |
| `tdd_red_validate` | minimal | specId, passed, loopCount |
| `tdd_green_validate` | minimal | specId, passed, loopCount |
| `circuit_breaker` | minimal | specId, loopCount, reason |
| `session_summary` | minimal | totalTurns, totalTokens, specsAttempted, finalMode, finalFsmState, sessionDurationMs |
| `subagent_start` | standard | agent, taskSummary, specId, fsmState |
| `subagent_end` | standard | agent, **model**, durationMs, tokenUsage {input, output, cacheRead, cacheWrite, cost}, **turns**, **exitCode**, **error**, outcome, specId |
| `turn_usage` | standard | input, output, cacheRead, cacheWrite, cost, model, specId, fsmState |
| `review_result` | standard | verdict, specId |
| `spec_approval` | standard | status, responseCount, **durationMs** |
| `unit_start` | standard | specId, unitName, loopCount, fsmState |
| `unit_end` | standard | specId, unitName, outcome, loopCount, fsmState |
| `command` | standard | command, result |
| `user_intervention` | standard | reason, specId, fsmState |
| `state_restore` | standard | specId, fsmState, fromPersisted |
| `config_validation` | standard | warnings [{field, value, fix}] |
| `tool_call` | standard | toolName, specId |
| `tool_call_blocked` | standard | toolName, reason, specId |
| `mode_switch` | standard | from, to |
| `review_override` | standard | specId, reason |
| `review_override_contradiction` | standard | specId, expected, actual |
| `verdict_extraction_failed` | standard | specId, rawContent |
| `prompt_size` | standard | promptTokens, contextWindow |
| `skill_read` | standard | skill, specId |
| `subagent_control` | standard | event, runId, agent |
| `nudge_fired` | verbose | state, level, turnsInState |
| `nudge_escalation` | verbose | state, level, turnsInState |
| `green_retry` | standard | retryCount, specId, unitName |
| `green_retry_enriched` | standard | retryCount, enrichedThreshold, specId, unitName |
| `green_retry_replan` | standard | retryCount, replanThreshold, specId, unitName |
| `green_retry_blocked` | standard | retryCount, maxRetries, specId, unitName |

**Bold** fields are new in the current version. The `trigger` field on `fsm_transition` uses typed values (`auto_tdd_validation`, `auto_git_checkpoint`, `auto_git_merge`, `auto_review_verdict`, `auto_subagent_complete`, `manual_advance_fsm`, `fsm_reset`) alongside the legacy `event` string for backward compatibility.

#### Token tracking

Pi Coder captures token usage from **both** the main orchestrator session and subagent sessions:

- **Subagent tokens** — extracted from `details.results[0].usage` when a subagent completes. Includes input, output, cacheRead, cacheWrite, cost, and turns.
- **Orchestrator tokens** — captured from `TurnEndEvent.message.usage` after each LLM turn. Logged as `turn_usage` events and accumulated into the session's `lifecycleTokens`.
- **`lifecycle_end` and `session_summary`** include the combined total from both sources in their `totalTokens` field.

#### Cost analysis

When cost data is available (from pi-subagents' `usage.cost` or user-configured `tokenPricing`), the `/pi-coder-logs` command includes a cost breakdown:

- Estimated total cost with source attribution (pi-subagents, user pricing, or unavailable)
- Per-agent cost breakdown
- Cache savings percentage
- Average cost per spec

Cost degrades gracefully: no pricing configured → shows raw token counts with a note; no model logged → no per-model breakdowns.

#### Querying logs

Use `/pi-coder-logs` to see aggregate statistics:

| Command | What it shows |
|---|---|
| `/pi-coder-logs` | Aggregate summary across all sessions |
| `/pi-coder-logs abc123` | Logs for a specific session (prefix match) |
| `/pi-coder-logs --spec=user-auth` | Events for a specific spec across all sessions |
| `/pi-coder-logs abc123 --spec=user-auth` | A specific session + spec combination |

### `subagentControl`

Monitoring of long-running or stuck subagents:

- **`subagentControl.enabled`** — when true, the extension listens for pi-subagents control events (active long-running, needs attention) and logs them for debugging. Default: `true`.

**Note:** Pi Coder automatically injects `control: { enabled: false }` into every subagent tool call. This disables pi-subagents' control event emissions at the source, preventing stale notifications from being delivered as steer messages during foreground (synchronous) subagent execution. In foreground mode, the orchestrator is blocked waiting for the result and cannot act on real-time notifications — they only arrive after the subagent completes, creating a stale feedback loop that burns LLM turns.

The `subagentControl` config in `.pi-coder/config.json` is reserved for future async delegation support. For now, it only controls whether the event bus listener is active (for diagnostic logging if events somehow still arrive).

The orchestrator can check status with `subagent({ action: "status", id: "<runId>" })` and interrupt with `subagent({ action: "interrupt", id: "<runId>" })`. These are advisory — the orchestrator's tool_call handler does not pass `control` overrides for management actions.

### `referenceProjects` (⚠️ EXPERIMENTAL)

Named reference projects that the researcher subagent can investigate during TDD cycles. Use this when your main project depends on code in a separate directory and the researcher needs to understand how something is implemented there.

```json
{
  "referenceProjects": {
    "woo-plugin": "~/projects/woo-plugin",
    "shared-lib": "../shared-lib"
  }
}
```

**Path formats:**

| Format | Example | Resolves to |
|---|---|---|
| Absolute | `/home/user/projects/woo-plugin` | As-is |
| Relative to project root | `../shared-lib` | Resolved against the primary project's root |
| Home directory | `~/projects/woo-plugin` | `~` expands to `$HOME` |

Paths are resolved and validated on load — if a directory doesn't exist, a warning is logged and that reference project is skipped.

**How it works:** When reference projects are configured, the orchestrator's prompt includes their names and paths. When investigating a reference project, the orchestrator delegates to the researcher and includes the project's absolute path in the task description. The researcher navigates to the reference project using `cd`, `grep`, `find`, and reads files with absolute paths.

**Do NOT pass `cwd` to the subagent tool** for reference project access. The researcher stays in the main project's working directory and explores the reference project via bash navigation and absolute paths. This prevents the reference project's pi configuration, extensions, and agent definitions from being loaded.

**⚠️ Known risks (experimental):**

- **Read access is fully allowed** — the researcher can inspect any file in the reference project. This is by design.
- **Write access is blocked by damage-control** — the CWD write boundary guard prevents `write`/`edit`/bash-writes to paths outside the project directory. This is a defense-in-depth measure.
- **Bash is endlessly expressive** — while damage-control catches common write patterns (redirects, `sed -i`, `tee`, `cp`, `mv`, `dd`, `install`), it cannot guarantee 100% coverage of all possible bash write patterns (e.g., `perl -e`, `python -c`, creative piping). This is a safety net, not a sandbox. Defense-in-depth: prompt constraints + damage-control + reviewer.
- **No disk-level isolation** — the researcher runs as the same OS user with the same filesystem permissions. True isolation would require containers or separate user accounts.

If these risks are unacceptable for your reference project, consider:
- Making the reference project read-only at the filesystem level (`chmod -R a-w`)
- Using a git worktree with `core.bare = true` on the reference project
- Running the reference project's test suite after pi-coder sessions to verify no changes were made

### `notifications`

Desktop notifications when the orchestrator needs your attention or finishes work. Useful when you're context-switching while pi-coder runs.

```json
{
  "notifications": {
    "enabled": true,
    "events": ["agent_end", "complete", "blocked", "spec_approval", "circuit_breaker"]
  }
}
```

**`notifications.enabled`** — master switch. Default: `false` (opt-in).

**`notifications.events`** — which events trigger a notification. If omitted, all events are enabled. Options:

| Event | When it fires |
|---|---|
| `agent_end` | Every time the orchestrator finishes processing and waits for input. This is the broadest option — it covers all the events below. |
| `complete` | FSM reaches COMPLETE state (spec finished, merged) |
| `blocked` | FSM reaches BLOCKED state (needs your intervention) |
| `spec_approval` | Spec interview is presented for your approval |
| `circuit_breaker` | Max review loops exceeded |

**How it works:** Notifications use the best available method for your environment:

| Platform | Method |
|---|---|
| macOS | `osascript` (display notification), falls back to OSC 777 |
| Linux | `notify-send` (libnotify), falls back to OSC 777 |
| Kitty | OSC 99 |
| Ghostty / iTerm2 / WezTerm | OSC 777 |
| Windows Terminal (WSL) | PowerShell toast |

No additional packages required — it uses built-in OS tools and terminal escape sequences.

**Minimal config** (notify on everything):
```json
{ "notifications": { "enabled": true } }
```

**Targeted config** (only when you need to act):
```json
{ "notifications": { "enabled": true, "events": ["blocked", "spec_approval"] } }
```

## Customization

### Agent Prompts

All four agent `.md` files are copied to `.pi/agents/` during init. Edit them to customize subagent behavior. The orchestrator system prompts live in `prompts/` (not copied to agents) — one per mode.

| File | Controls |
|---|---|
| `pi-coder-orchestrator.md` | The orchestrator's subagent definition — name, package, tools | 
| `pi-coder-researcher.md` | Researcher behavior — investigation approach, output format |
| `pi-coder-implementor.md` | Implementor behavior — RED/GREEN mode boundaries, output format |
| `pi-coder-reviewer.md` | Reviewer behavior — focus/skip areas, verdict format, severity levels |

**Mode prompts** (in `prompts/`, not copied to agents):

| File | Mode | Controls |
|---|---|---|
| `pi-coder-orchestrator.md` | TDD | Full FSM lifecycle, RED/GREEN phases, per-unit TDD cycle |
| `pi-coder-light.md` | Light | Simplified FSM, IMPLEMENTING state, reviewer fix classification |
| `pi-coder-plan.md` | Plan | Researcher delegation only, no FSM/spec/git |

**Your customizations are preserved.** Running `/pi-coder-init` again skips existing files. Running `/pi-coder-reset-agents` overwrites them back to defaults (requires confirmation).

#### Prompt template variables

All three mode prompt files (TDD, Light, Plan) contain template variables that are substituted at runtime:

| Variable | Replaced with | Used in |
|---|---|---|
| `{{fsmDiagram}}` | Compact FSM state diagram (generated from state machine) | TDD, Light |
| `{{currentState}}` | Current FSM state name (e.g. `"SPEC_WORK"`) | TDD, Light |
| `{{activeSpecId}}` | Active spec ID or `"none"` | TDD, Light |
| `{{loopCount}}` | Current review loop count | TDD, Light |
| `{{maxLoops}}` | Configured maximum loops | TDD, Light |
| `{{toolList}}` | Filtered tool list with descriptions | All |
| `{{interviewTimeout}}` | Configured interview timeout (0 = no timeout) | All |
| `{{referenceProjects}}` | Configured reference project names + paths | All |
| `{{dbCommands}}` | Database inspection commands for delegation briefs | All |

#### Project-scope overrides

The extension checks for prompt files in `prompts/` — project customization takes priority over package defaults. This means you can customize the orchestrator prompt per-project without affecting the package files. Edit the files directly in your project's `.pi-coder/prompts/` or the package's `prompts/` directory.

### MCP Server Access for Subagents

If you have [pi-mcp-adapter](https://www.npmjs.com/package/pi-mcp-adapter) installed, you can give subagents access to MCP servers by adding `mcp:server-name` entries to their `tools:` frontmatter. This is the per-agent access control — each subagent only sees the MCP servers you explicitly grant.

**Example:** Give the researcher read-only Supabase access so it can query your database schema:

Edit `.pi/agents/pi-coder-researcher.md`:

```markdown
---
name: researcher
package: pi-coder
description: Investigates codebase, knowledge base, and external sources for TDD implementation context
tools: read, bash, grep, find, ls, mcp:supabase
---
```

**Specific tools only** — use the `mcp:server-name/tool_name` format to grant access to individual tools:

```markdown
tools: read, bash, grep, find, ls, mcp:supabase/query
```

**Configuration steps:**

1. Install pi-mcp-adapter: `pi install npm:pi-mcp-adapter`
2. Configure your MCP server in `.mcp.json` (project) or `~/.config/mcp/mcp.json` (global)
3. Edit the agent `.md` file in `.pi/agents/` to add the `mcp:` entry
4. Restart Pi — the adapter caches tool metadata at startup

**Common patterns:**

| Subagent | MCP servers to consider | Why |
|---|---|---|
| Researcher | `mcp:supabase` | Query database schema, inspect tables and relations |
| Researcher | `mcp:postgres` | Direct SQL queries for schema discovery |
| Researcher | `mcp:github` | Search repos, read issues and PRs |
| Implementor | `mcp:supabase` | Generate migrations, insert seed data |
| Reviewer | *(usually none)* | Reviewer checks code, not external services |

**Note:** Global `directTools: true` in mcp.json is **not** enough for subagents — the `mcp:` entries must be in the agent frontmatter. This is a security feature: you explicitly control which subagents can reach which external services. The generic `mcp` proxy tool is still available for discovery when MCP tools aren't declared explicitly.

### Per-Agent Model Selection

Each subagent can run on a different model. There are two ways to control which model handles each role:

#### Option 1: Agent Frontmatter (agent-level default)

Edit `.pi/agents/pi-coder-reviewer.md`:

```markdown
---
name: reviewer
package: pi-coder
description: Evaluates implementation against spec brief for TDD integrity, correctness, and security
tools: read, bash, grep, find, ls
model: anthropic/claude-sonnet-4
fallbackModels: openai/gpt-5-mini, anthropic/claude-haiku-4-5
---
```

#### Option 2: settings.json Overrides (project-wide or user-global)

Create or edit `.pi/settings.json` in your project root:

```json
{
  "subagents": {
    "disableBuiltins": true,
    "agentOverrides": {
      "pi-coder.researcher": {
        "model": "anthropic/claude-haiku-4-5"
      },
      "pi-coder.implementor": {
        "model": "anthropic/claude-sonnet-4",
        "thinking": "high"
      },
      "pi-coder.reviewer": {
        "model": "anthropic/claude-sonnet-4",
        "fallbackModels": ["openai/gpt-5-mini"]
      }
    }
  }
}
```

**Available override fields** (all optional — only include what you want to change):

| Field | Type | Description |
|---|---|---|
| `model` | `string \| false` | Override the model selection. `false` explicitly unsets a lower-priority value. |
| `fallbackModels` | `string[] \| false` | Models tried in order on provider failures. |
| `thinking` | `string \| false` | Thinking budget (e.g. `"high"`). |
| `systemPromptMode` | `"append" \| "replace"` | How `systemPrompt` is applied. |
| `systemPrompt` | `string` | Append or replace the agent's system prompt. |
| `inheritProjectContext` | `boolean` | Whether the subagent inherits the parent's project context. |
| `inheritSkills` | `boolean` | Whether the subagent inherits the parent's skills. |
| `defaultContext` | `"fresh" \| "fork" \| false` | Subagent context mode — fresh session or fork from parent. |
| `disabled` | `boolean` | Hide the agent from the subagent list. |
| `completionGuard` | `boolean` | Wait for subagent completion before returning. |
| `skills` | `string[] \| false` | Skills to inject into the subagent. |
| `tools` | `string[] \| false` | Tools available to the subagent. |

**Model ID formats:**

| Format | Example | Behavior |
|---|---|---|
| Bare ID | `claude-sonnet-4` | Prefers the current provider if it offers this model, otherwise unique registry match. Ambiguous if multiple providers offer the same ID. |
| Provider/ID | `neural-watt/zai-org/GLM-5.1-FP8` | Always resolves directly. Unambiguous. |
| With thinking | `anthropic/claude-sonnet-4:high` | Appends thinking level as a suffix. |

**Fallback models** are tried in order on provider failures (rate limits, auth errors, timeouts, service unavailable). Ordinary task failures (wrong answer, syntax error) do **not** trigger fallback — only infrastructure-level failures.

**Where to set models (priority: highest wins):**

| Method | Scope | Priority |
|---|---|---|
| `subagent({ model: "..." })` per-call override | Single delegation | Highest |
| `.pi/settings.json` → `subagents.agentOverrides` | Project-wide | Medium |
| `~/.pi/agent/settings.json` → `subagents.agentOverrides` | User-global | Lower |
| Agent frontmatter `model:` field | Agent default | Lowest |
| Pi default model | Session default | Fallback |

Project overrides in `.pi/settings.json` beat user overrides in `~/.pi/agent/settings.json`.

**Common patterns:**

| Subagent | Model strategy | Why |
|---|---|---|
| Researcher | Fast, cheap model (e.g. `haiku`-class) | Research is wide but shallow — speed matters more than depth |
| Implementor | Strong coding model (e.g. `sonnet`-class) | Code generation quality directly impacts TDD cycle efficiency |
| Reviewer | Strong reasoning model, maybe with `:high` thinking | Review requires careful analysis — the extra thinking budget pays off |
| Reviewer | `fallbackModels: openai/gpt-5-mini` | Insurance against provider outages during critical review step |

**Interplay with `models.json`:** Pi's `models.json` defines which providers and models are *available*. The `model` field in frontmatter or settings is a *selector* — it picks from that registry. If you specify a model that isn't configured in `models.json`, the subagent call will fail. All models used in agent frontmatter or fallback lists must exist in your `models.json` configuration.

### The Orchestrator Skill

`skills/pi-coder/SKILL.md` is the orchestrator's detailed procedural reference — the "fat prompt" loaded on-demand during TDD cycles. It contains:

- Step-by-step procedures for each FSM state
- Delegation task templates (researcher, implementor RED/GREEN, reviewer)
- Recovery procedures (RED_TAUTOLOGY, circuit breaker)
- Knowledge consolidation guidelines

You can edit this file to adjust delegation templates, add project-specific procedures, or modify recovery behavior. Pi loads skills from the package's `skills/` directory automatically.

### Knowledge Files

The `.pi-coder/knowledge/` directory stores persisted project learnings. The orchestrator and subagents check these before working:

- The orchestrator lists `ls .pi-coder/knowledge/` to brief the researcher
- The researcher reads relevant knowledge files first, then investigates the codebase
- The implementor checks knowledge before writing code
- After spec completion, the reviewer's "knowledge extraction candidates" are persisted here via `upsert_knowledge`

Knowledge file naming rules: `.md` extension, 3-50 character stem, lowercase alphanumeric + hyphens only. Example filenames:

- `design_system.md` — **UI component library, patterns, and conventions (scaffolded by init)**
- `supabase-auth-flow.md`
- `error-handling-patterns.md`
- `api-route-conventions.md`

**What to persist:** Project conventions, gotchas, API patterns not obvious from code, architecture decisions constraining future work.

**What NOT to persist:** Task-specific decisions, temporary workarounds, anything obvious from reading code.

### Design System File

The `design_system.md` knowledge file is particularly important for projects with a UI. It documents the component library, spacing system, colors, typography, and interaction patterns so the implementor doesn't invent its own. The `/pi-coder-init` command creates a starter template with structured sections — fill it in for your project.

When a spec involves UI work, the orchestrator checks for this file:
- **If it exists** — the spec references its components and patterns as constraints the implementor must follow
- **If it's missing** — the orchestrator suggests you create one before proceeding, to prevent the implementor from freestyling UI decisions
- **If the spec has no UI surface** — the design system check is skipped entirely

## The TDD Lifecycle

> This section describes the TDD mode lifecycle. For the Light mode lifecycle, see below.

### Research & Spec

1. You make a request → orchestrator advances the FSM to SPEC_WORK (spec ID is generated immediately, but the directory is created when the spec is saved with `pi_coder_save_spec`)
2. Orchestrator delegates to researcher (can do multiple rounds)
3. Orchestrator checks for `design_system.md` in knowledge if the spec involves UI work — if missing, suggests you create one
4. Orchestrator prunes research to only what's needed: acceptance criteria, constraints, key files
5. Orchestrator creates an **implementation plan** — breaking the spec into atomic units, each with its own ACs and key files
6. Orchestrator presents the spec for approval via `interview` with **multiple focused questions** (scope, ACs, constraints, plan) — not one big dump
7. On approval: `pi_coder_advance_fsm` advances to SPEC_APPROVED (FSM guard requires `spec_saved` + `spec_user_approved` evidence), then git checkpoint creates a feature branch

### Per-Unit TDD Cycle

Implementation happens **one unit at a time**. For each unit in the implementation plan:

#### RED Phase (per unit)

1. Orchestrator delegates to implementor in **RED mode** for **one unit only** — "write tests for these ACs"
2. Implementor writes failing tests for that unit's acceptance criteria
3. `pi_coder_run_tests` validates the tests — they **must fail** (that's the point)
4. If tests pass unexpectedly → **RED_TAUTOLOGY** — the extension presents guidance with two options:
   - **Acknowledge and proceed** (`pi_coder_advance_fsm TDD_GREEN_WRITE`) — the test coverage is valid even though it passed immediately. This is common for assertion additions to existing tests, or when the implementor applied code+test simultaneously.
   - **Block** (`pi_coder_advance_fsm BLOCKED`) — the tests passing is genuinely problematic. In BLOCKED, present options to rewrite tests or abort the spec.

   **Most RED tautologies are benign.** If the test is valid, acknowledge and proceed. Only block if the test is wrong, not if the code is right.

#### GREEN Phase (per unit)

1. Orchestrator delegates to implementor in **GREEN mode** for **the same unit** — "write code to make these tests pass"
2. Implementor writes implementation code (cannot modify tests without approval)
3. `pi_coder_run_tests` validates — tests **must pass**
4. If tests still fail → loop back to GREEN for the same unit
5. If tests pass → orchestrator decides:
   - **More units?** → `pi_coder_advance_fsm TDD_RED_WRITE` to start the next unit
   - **All units done?** → `pi_coder_advance_fsm REVIEWING` to proceed to review

### Review

1. Orchestrator delegates to reviewer with acceptance criteria + git diff
2. Reviewer checks: test alignment, bugs, security, correctness (skips style, nitpicks)
3. Verdict: ✅ Approved / ⚠️ Needs Changes — this **auto-transitions** the FSM (like test results)
4. If needs changes → **functional fix**: advance to TDD_RED_WRITE (full RED/GREEN cycle); **non-functional fix** (test cleanup, comments, naming): delegate implementor directly in NEEDS_CHANGES, then advance to REVIEWING with `fixType="non-functional"` for re-review

### Delivery

1. Final approval → orchestrator presents the complete spec report
2. Your approval → merge feature branch, cleanup spec file
3. Knowledge consolidation — persist learnings from the cycle

### Circuit Breaker

If the TDD review cycle loops `maxLoops` times without converging, the circuit breaker halts the spec. The orchestrator presents the current state and asks you to intervene: refine the spec, change constraints, or abort. This applies to both TDD and Light modes — both increment `loopCount` on every NEEDS_CHANGES exit.

---

## The Light Mode Lifecycle

Light mode uses a simpler FSM with one implementation state instead of four TDD states. The spec workflow (research → spec → approval → checkpoint) and the review workflow (review → approval → merge) are the same as TDD mode. The difference is the middle:

### IMPLEMENTING state

Instead of per-unit RED/GREEN phases, the orchestrator delegates the entire implementation to the implementor in one or more delegations. `pi_coder_run_tests` can be run at any time for advisory feedback, but test results don't gate FSM transitions.

### Review & fixes

The reviewer operates the same way as in TDD mode — it runs the full test suite and gives a verdict. The key difference is how fixes work:

- **Functional fix** (production code changes) → advance to IMPLEMENTING. The implementor makes changes and the cycle continues.
- **Non-functional fix** (test cleanup, comments, naming) → the reviewer classifies the fix type, and the extension records it as a `non_functional_classified` evidence flag. The orchestrator delegates directly in NEEDS_CHANGES and advances to REVIEWING with `fixType="non-functional"` for re-review.

Both fix paths increment `loopCount` toward the circuit breaker.

### When to use Light mode instead of TDD

- You're fixing a bug and don't need test-first discipline
- The task is straightforward enough that per-unit TDD phases add overhead without value
- You want structured delegation (spec → implement → review) but not RED/GREEN enforcement
- The project already has good test coverage and you're adding to it

### When to switch from Light to TDD

- The implementation grows complex enough to benefit from per-unit test-first development
- A Light mode review keeps finding bugs that TDD would have caught earlier
- You want the safety net of RED-phase validation (tests must fail before implementation)

## Extension Events

Pi Coder hooks into pi's extension lifecycle to enforce invariants:

| Event | What the extension does |
|---|---|
| `session_start` | Load config, initialize state machine, register tools, restore persisted state from `.pi-coder/state.json` + `.pi-coder/specs/{id}/state.json` with integrity checks, emit `config_validation` if warnings found |
| `session_shutdown` | Clean up timers, persist final state, reset session counters, emit `session_summary` event |
| `before_agent_start` | Replace system prompt with mode-specific orchestrator identity, filter tools, prepend `[MODE: ...]` indicator, check nudge thresholds |
| `tool_call` | Validate tool calls against FSM state, block raw git commands, track subagent starts |
| `tool_result` | Auto-transition FSM on test results, subagent completions, and review verdicts; set evidence flags (`spec_user_approved`, `test_run_this_state`); filter subagent list output to pi-coder agents only; persist state to disk; log events |
| `turn_end` | Capture main-session token usage from `AssistantMessage.usage`, accumulate into `lifecycleTokens`, emit `turn_usage` event |

## Project Structure

```
your-project/
├── .pi-coder/
│   ├── config.json          # Configuration
│   ├── damage-control.json  # Destructive command protection rules
│   ├── state.json           # Persisted FSM state (auto-managed)
│   ├── knowledge/           # Persisted project learnings
│   ├── logs/                # Interaction telemetry (JSONL)
│   │   └── {sessionId}/     # Per-session directory
│   │       └── YYYY-MM-DD.log  # Daily log file
│   └── specs/
│       └── {spec-id}/
│           ├── request.md    # User's original request (created on SPEC_WORK entry)
│           ├── spec.md      # Human-readable spec content
│           └── state.json   # Per-spec FSM state + evidence flags
└── .pi/
    ├── agents/
    │   ├── pi-coder-orchestrator.md    # Orchestrator system prompt (from prompts/)
    │   ├── pi-coder-researcher.md      # Researcher agent definition
    │   ├── pi-coder-implementor.md     # Implementor agent definition
    │   └── pi-coder-reviewer.md        # Reviewer agent definition
    └── settings.json                   # subagents.disableBuiltins + pi settings
```

Note: Orchestrator prompts live in `prompts/` (not `agents/`) to prevent pi-subagents from discovering them as delegatable targets. There are three prompt files: `pi-coder-orchestrator.md` (TDD mode), `pi-coder-light.md` (Light mode), and `pi-coder-plan.md` (Plan mode).

## Architecture

Pi Coder follows a **"fat prompts, thin harness"** philosophy — the intelligence lives in the agent `.md` prompts and the SKILL.md procedural reference. The extension code is minimal plumbing:

- **Extension** (`extensions/index.ts`) — event hooks, tool registration, commands
- **Damage control** (`extensions/damage-control.ts`) — destructive command protection, applies to all sessions including subagents
- **Prompts** (`prompts/`) — orchestrator identity for each mode: `pi-coder-orchestrator.md` (TDD), `pi-coder-light.md` (Light), `pi-coder-plan.md` (Plan)
- **Modules** (`src/`) — state machine (TDD + Light), state persistence, spec management, git abstraction, TDD runner, knowledge system, tools, logger
- **Agent prompts** (`agents/`) — three `.md` files defining subagent behavior (researcher, implementor, reviewer)
- **Orchestrator prompts** (`prompts/`) — templates with `{{variables}}` for runtime FSM injection. One file per mode: `pi-coder-orchestrator.md` (TDD), `pi-coder-light.md` (Light), `pi-coder-plan.md` (Plan). NOT in `agents/` to prevent pi-subagents from discovering them as delegatable targets
- **Skill** (`skills/pi-coder/SKILL.md`) — orchestrator procedural reference

The orchestrator has **bounded awareness** — it can `ls`, `find`, and `grep` to write effective delegation briefs, but it cannot `read` file contents, `edit`, `write`, or run `bash`. This forces delegation and preserves the context window for orchestration decisions.

### Subagent Delegation Scoping

Three layers ensure the orchestrator only delegates to pi-coder subagents:

| Layer | Mechanism | What it does |
|---|---|---|
| **Discovery** | `.pi/settings.json` with `subagents.disableBuiltins: true` | Hides all built-in agents (researcher, reviewer, worker, scout, etc.) from `subagent list` |
| **Delegation** | `tool_call` handler — only `pi-coder.*` agents allowed | Blocks any delegation to non-pi-coder agents, including built-ins and other packages. Also blocks `pi-coder.orchestrator` (no self-delegation) |
| **Output** | `tool_result` handler — filters `subagent list` text | Defense-in-depth: if `disableBuiltins` isn't set, strips non-pi-coder agents from the list output |

This prevents the LLM from accidentally delegating to a built-in `researcher` instead of `pi-coder.researcher`, or to agents from other packages like `code-analysis.*`.

## Development

```bash
npm install          # Install dependencies
npm test             # Run test suite (868 tests)
npm run typecheck    # TypeScript strict mode check
```

## License

MIT
