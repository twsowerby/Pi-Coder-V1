# Pi Coder v1

A TDD orchestrator/worker harness for [pi](https://github.com/earendil-works/pi-coding-agent) — semi-deterministic coding with strict test-driven development.

Pi Coder replaces the default "you're a coding assistant" mode with a structured orchestrator that delegates all implementation to specialized subagents. It offers two modes: **TDD mode** enforces a strict Red→Green→Review lifecycle with a state machine; **Light mode** gives you the same delegation model without the ceremony. The orchestrator cannot edit files, read file contents, or run arbitrary commands — it can only delegate, observe, and decide.

## How It Works

Pi Coder adds an **orchestrator mode** to pi. When active, your pi session transforms:

- The system prompt is replaced with the orchestrator identity
- Tool access is restricted to delegation and observation tools only
- In **TDD mode**: a finite state machine (FSM) tracks the lifecycle, subagent calls are validated against FSM state, test results and review verdicts auto-advance the machine
- In **Light mode**: no FSM — delegate any subagent at any time, run tests freely
- State and mode are persisted to disk — cycles survive crashes and session restarts

In TDD mode, the orchestrator follows this lifecycle:

```
IDLE → SPEC_WORK → SPEC_APPROVED →
GIT_CHECKPOINT → TDD_RED_WRITE → TDD_RED_VALIDATE →
TDD_GREEN_WRITE → TDD_GREEN_VALIDATE → REVIEWING | (next_unit) TDD_RED_WRITE →
(APPROVED → FINAL_APPROVAL → MERGING → COMPLETE) |
(NEEDS_CHANGES → TDD_RED_WRITE | REVIEWING) | BLOCKED
```

### Three Subagents

| Agent | Role | Tools |
|---|---|---|
| **Researcher** | Investigates codebase, checks knowledge files, produces structured research reports | `read`, `bash`, `grep`, `find`, `ls` |
| **Implementor** | Writes code in exclusive RED (tests only) or GREEN (implementation only) mode | `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls` |
| **Reviewer** | Independent adversarial review — checks test alignment, bugs, security, correctness | `read`, `bash`, `grep`, `find`, `ls` |

### Key Invariant (TDD Mode)

The orchestrator can **never** put the FSM into an invalid state. Tool calls are validated against the current state. Invalid delegations are blocked. Deterministic events (test results, subagent completions) auto-transition the FSM. The LLM decides *what* to do; the extension guards *whether* it can.

In Light mode, there is no FSM — the extension trusts the orchestrator's judgment. Subagent delegation and test running are available at any time.

## Quick Start

### 1. Install

```bash
pi install npm:pi-coder-v1
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
- `.pi/agents/pi-coder-*.md` — agent definition files (copied from package defaults)
- `.pi/settings.json` — disables built-in subagents so only `pi-coder.*` agents are visible

### 3. Choose your mode

```
/pi-coder
```

Shows a mode selection menu:

| Mode | Description | Best For |
|------|-------------|----------|
| **TDD** | Full lifecycle with spec, RED/GREEN phases, review | New features, bug fixes |
| **Light** | Delegation + tests, no FSM ceremony | Spot fixes, existing projects, infrastructure work |
| **Off** | Normal Pi — unrestricted | Quick questions, anything outside pi-coder |

You'll see the current mode in the status bar: `● TDD`, `⚡ Light`, or nothing (off). Mode switches don't trigger an LLM turn — the mode indicator is injected into the system prompt on the next turn and a notification is queued for delivery.

### 4. Make a request

Just describe what you want built. The orchestrator will:
1. Delegate to the **researcher** to investigate the codebase
2. Prune the research into an actionable **spec** with acceptance criteria
3. Present the spec for your approval
4. Create a git checkpoint and begin the **TDD cycle**
5. Alternate RED (write tests) → GREEN (make tests pass) → **Review**
6. Merge on approval, persist knowledge learnings

In **Light mode**, there's no formal spec or TDD cycle — the orchestrator uses its judgment to pick the right subagent for the task and runs tests freely.

## Modes

Pi Coder has three modes, selected via `/pi-coder`:

### TDD Mode

Full lifecycle enforcement. The orchestrator must follow the FSM: research → spec → approval → implementation (RED/GREEN) → review → merge. The state machine tracks progress, evidence flags enforce invariants, and the nudge system pushes the orchestrator forward if it stalls.

**When to use:** New features with clear acceptance criteria, bug fixes that need structured verification, any task where you want the discipline of test-first development.

**Available tools:** `ls`, `find`, `grep`, `subagent`, `pi_coder_git`, `pi_coder_run_tests`, `upsert_knowledge`, `pi_coder_save_spec`, `pi_coder_read_spec`, `pi_coder_advance_fsm`, `interview`, `intercom`

### Light Mode

Delegation without ceremony. Same subagents (researcher, implementor, reviewer), same tools (git, tests, knowledge), but no FSM, no spec files, no evidence flags. The orchestrator picks the right subagent for the task and runs tests freely.

**When to use:** Spot fixes, infrastructure changes, existing projects where the full TDD lifecycle feels heavy, requests that don't fit a spec-first workflow ("rebuild the test setup", "debug why auth is broken").

**Key differences from TDD mode:**
- No `pi_coder_advance_fsm` — there's no FSM to advance
- No `pi_coder_save_spec` / `pi_coder_read_spec` — no spec files
- Subagent delegation available at any time — no FSM state gating
- `pi_coder_run_tests` returns plain results — no auto-transitions
- Prompt is simplified — no FSM diagram, no state tracking

**Available tools:** `ls`, `find`, `grep`, `subagent`, `pi_coder_run_tests`, `pi_coder_git`, `upsert_knowledge`, `interview`, `intercom`

### Off

Normal Pi. Full tool access, no orchestrator identity, no subagent scoping, no knowledge system.

**When to use:** Quick questions, tasks that don't need delegation, anything where you want unstructured access to Pi's full capabilities.

**Mode switching:** Switch modes at any time with `/pi-coder`. The mode change takes effect immediately — no LLM turn is triggered. The system prompt is rebuilt with the new mode's identity and tools on the next turn, and a `[MODE: ...]` indicator is prepended so the LLM always knows its current mode (even after mid-conversation switches).

## Usage Tips

### Let the task decide the mode, not the project

TDD mode isn't just for greenfield projects and Light mode isn't just for existing ones. The right mode depends on what you're asking the orchestrator to do:

- **TDD mode** when you want to *build* something — a new feature, a new module, a bug fix that needs structured verification. The spec approval catches misunderstandings early, RED/GREEN ensures tests exist before code, and the reviewer catches issues before they reach main.
- **Light mode** when you want to *do* something — investigate a bug, fix a failing test, refactor a module, update a dependency. These tasks benefit from delegation (researcher to investigate, implementor to make changes) but don't need a spec-first workflow.

You'll naturally switch between them as your session evolves — TDD mode for the feature, Light mode for the incidental work it uncovers.

### Switch modes mid-conversation

You can switch at any time with `/pi-coder`. Common patterns:

- **Start in TDD → switch to Light** when the task turns out to be simpler than expected ("actually just fix that one test"). The FSM will be in whatever state it was in — switch back when you want to continue the formal lifecycle.
- **Start in Light → switch to TDD** when a spot fix reveals a bigger task. You'll need to start a new TDD cycle from IDLE.
- **Switch to Off** for quick questions that don't need delegation ("what does this function do?"). Switch back when you're ready to work.

### Running tests is always available

`pi_coder_run_tests` works in **any FSM state** and in **both TDD and Light modes**. Only in TDD mode's validation states (`TDD_RED_VALIDATE`, `TDD_GREEN_VALIDATE`) do test results trigger auto-transitions. In all other cases, you just get the results back.

This means you can run tests at any time to check your bearings — in IDLE, during SPEC_WORK, after a review — without the FSM side-effecting your workflow.

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
- **Run tests** → Switch to Light mode and ask the orchestrator to run them, or switch to Off and run them yourself
- **Investigate a bug** → Light mode — delegate to the researcher
- **Make a quick change** → Light mode — delegate to the implementor, run tests to verify
- **Ask a question** → Off — just ask normally

The FSM will block you if you try to use TDD mode for these tasks. That's by design — it's enforcing a process that doesn't apply.

### Fill in design_system.md for UI projects

If your project has a UI, fill in `.pi-coder/knowledge/design_system.md` (created by `/pi-coder-init`). The orchestrator checks for this file when a spec involves UI work. Without it, the implementor has no guidance on spacing, components, colors, or interaction patterns — and will invent its own.

Even a minimal design system file ("use these components", "spacing is 4px grid", "colors are in theme.ts") prevents the implementor from freestyling UI decisions.

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
- Spec content → `.pi-coder/specs/{id}/spec.md`
- User's original request → `.pi-coder/specs/{id}/request.md`
- Project learnings → `.pi-coder/knowledge/`
- Cycle history → `.pi-coder/logs/` (JSONL)
- Code changes → git (the branch and checkpoint are preserved)

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

### Guarded Transitions

| Transition | Evidence required | Why |
|---|---|---|
| SPEC_WORK → SPEC_APPROVED | `spec_saved` + `spec_user_approved` | Cannot implement without a saved, user-approved spec |
| TDD_RED_VALIDATE → TDD_GREEN_WRITE | `test_run_this_state` | Cannot skip RED validation — must actually run tests |
| TDD_GREEN_VALIDATE → exits | `test_run_this_state` | Cannot skip GREEN validation — must actually run tests |

This prevents the LLM from shortcutting through validation states without executing tests, or advancing to implementation without user spec approval. The FSM is the single source of truth for process invariants.

## Commands

| Command | Description |
|---|---|
| `/pi-coder` | Switch mode (TDD / Light / Off) |
| `/pi-coder-init` | Initialize `.pi-coder/` structure and config |
| `/pi-coder-reset-agents` | Reset agent `.md` files to package defaults (requires confirmation) |
| `/pi-coder-logs` | Show interaction log statistics |

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
  "gitStrategy": "branch-and-merge",
  "branchPrefix": "pi-coder/",
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
    "maxLogFiles": 10
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

### `maxLoops`

Maximum number of NEEDS_CHANGES → TDD_RED_WRITE review cycles before the circuit breaker halts the spec. When tripped, the orchestrator pauses and presents options to the user. Default: `3`.

### `gitStrategy`

How feature branches are merged back after approval:

- `"branch-and-merge"` — standard `git merge`
- `"squash"` — `git merge --squash` + separate commit

### `branchPrefix`

Prefix prepended to all pi-coder branches. Branches are created as `{branchPrefix}{spec-id}` (e.g. `pi-coder/2026-05-25-1430-user-authentication`). Spec IDs use the format `YYYY-MM-DD-HHmm-slug` — a timestamp prefix that prevents duplicate names and gives natural chronological ordering.

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

Structured interaction logging for harness improvement. Logs are JSONL files in `.pi-coder/logs/`.

**`logging.enabled`** — master switch. Default: `false` (opt-in telemetry).

**`logging.level`** — controls which events are logged:

| Level | Events captured |
|---|---|
| `"minimal"` | FSM transitions, TDD validations, lifecycle start/end, circuit breaker |
| `"standard"` | All of minimal + subagent start/end, review results, user commands, user interventions, state restore events |
| `"verbose"` | All of standard + nudge firings and escalations |

**`logging.maxLogFiles`** — maximum log files to retain. Oldest are deleted when exceeded. Default: `10`.

### `subagentControl`

Monitoring of long-running or stuck subagents:

- **`subagentControl.enabled`** — when true, the extension listens for pi-subagents control events (active long-running, needs attention) and surfaces them as steer messages to the orchestrator. Default: `true`.

The extension listens on the `subagent:control-event` event bus channel and surfaces:
- **⏱️ Active long-running** — subagent has been running for 2+ minutes. Informational; the subagent is making progress.
- **⚠️ Needs attention** — subagent has been inactive for 60+ seconds or has repeated tool failures. May need intervention.

The orchestrator can check status with `subagent({ action: "status", id: "<runId>" })` and interrupt with `subagent({ action: "interrupt", id: "<runId>" })`.

Thresholds (60s/240s) are configured via pi-subagents' own config, not Pi Coder's config.

Log file naming: `pi-coder-YYYY-MM-DD.log` (one file per calendar day).

Each log entry is a JSON object:

```jsonl
{"timestamp":"2026-05-25T10:15:30.123Z","sessionId":"a1b2c3d4","type":"fsm_transition","payload":{"from":"IDLE","to":"SPEC_WORK","event":"start_research","loopCount":0,"specId":"user-auth"}}
{"timestamp":"2026-05-25T10:15:45.456Z","sessionId":"a1b2c3d4","type":"subagent_start","payload":{"agent":"pi-coder.researcher","taskSummary":"Research the codebase for user authentication...","specId":"user-auth","fsmState":"SPEC_WORK"}}
{"timestamp":"2026-05-25T10:16:22.789Z","sessionId":"a1b2c3d4","type":"subagent_end","payload":{"agent":"pi-coder.researcher","durationMs":37333,"tokenUsage":{"input":1200,"output":3500,"total":4700},"outcome":"success","specId":"user-auth"}}
```

Use `/pi-coder-logs` to see aggregate statistics from your logs.

## Customization

### Agent Prompts

All four agent `.md` files are copied to `.pi/agents/` during init. Edit them to customize behavior:

| File | Controls |
|---|---|
| `pi-coder-orchestrator.md` | The orchestrator's system prompt — role, delegation rules, FSM context |
| `pi-coder-researcher.md` | Researcher behavior — investigation approach, output format |
| `pi-coder-implementor.md` | Implementor behavior — RED/GREEN mode boundaries, output format |
| `pi-coder-reviewer.md` | Reviewer behavior — focus/skip areas, verdict format, severity levels |

**Your customizations are preserved.** Running `/pi-coder-init` again skips existing files. Running `/pi-coder-reset-agents` overwrites them back to defaults (requires confirmation).

#### Orchestrator prompt template variables

The orchestrator `.md` file contains template variables that are substituted at runtime:

| Variable | Replaced with |
|---|---|
| `{{fsmDiagram}}` | Compact FSM state diagram (generated from transition table) |
| `{{currentState}}` | Current FSM state name (e.g. `"SPEC_WORK"`) |
| `{{activeSpecId}}` | Active spec ID or `"none"` |
| `{{loopCount}}` | Current TDD review loop count |
| `{{maxLoops}}` | Configured maximum loops |
| `{{toolList}}` | Filtered tool list with descriptions |

#### Project-scope overrides

The extension checks for `.pi/agents/pi-coder-orchestrator.md` first (project customization), falling back to the package default. This means you can customize the orchestrator prompt per-project without affecting the package files.

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

### Research & Spec

1. You make a request → orchestrator advances the FSM to SPEC_WORK (this creates the spec directory with `request.md` for crash recovery)
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
4. If tests pass unexpectedly → **RED_TAUTOLOGY** — the harness enters BLOCKED and presents three options:
   - **Continue anyway** — skip to GREEN for new behavior
   - **Rewrite tests** — loop back to RED with instruction to test only new behavior
   - **Abort spec** — rollback to checkpoint, return to IDLE

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
4. If needs changes → **functional fix**: loop back to RED (up to `maxLoops`); **non-functional fix** (test cleanup, comments): advance directly to REVIEWING

### Delivery

1. Final approval → orchestrator presents the complete spec report
2. Your approval → merge feature branch, cleanup spec file
3. Knowledge consolidation — persist learnings from the cycle

### Circuit Breaker

If the TDD review cycle loops `maxLoops` times without converging, the circuit breaker halts the spec. The orchestrator presents the current state and asks you to intervene: refine the spec, change constraints, or abort.

## Extension Events

Pi Coder hooks into pi's extension lifecycle to enforce invariants:

| Event | What the extension does |
|---|---|
| `session_start` | Load config, initialize state machine, register tools, restore persisted state from `.pi-coder/state.json` + `.pi-coder/specs/{id}/state.json` with integrity checks |
| `before_agent_start` | Replace system prompt with orchestrator identity, filter tools, check nudge thresholds |
| `tool_call` | Validate tool calls against FSM state, block raw git commands, track subagent starts |
| `tool_result` | Auto-transition FSM on test results, subagent completions, and review verdicts; set evidence flags (`spec_user_approved`, `test_run_this_state`); filter subagent list output to pi-coder agents only; persist state to disk; log events |

## Project Structure

```
your-project/
├── .pi-coder/
│   ├── config.json          # Configuration
│   ├── state.json           # Persisted FSM state (auto-managed)
│   ├── knowledge/           # Persisted project learnings
│   ├── logs/                # Interaction telemetry (JSONL)
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

## Architecture

Pi Coder follows a **"fat prompts, thin harness"** philosophy — the intelligence lives in the agent `.md` prompts and the SKILL.md procedural reference. The extension code is minimal plumbing:

- **Extension** (`extensions/index.ts`) — event hooks, tool registration, commands
- **Modules** (`src/`) — state machine, state persistence, spec management, git abstraction, TDD runner, knowledge system, tools, logger
- **Agent prompts** (`agents/`) — three `.md` files defining subagent behavior (researcher, implementor, reviewer)
- **Orchestrator prompt** (`prompts/`) — template with `{{variables}}` for runtime FSM injection (not in `agents/` to prevent pi-subagents from discovering it as a delegatable target)
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
npm test             # Run test suite (466 tests)
npm run typecheck    # TypeScript strict mode check
```

## License

MIT
