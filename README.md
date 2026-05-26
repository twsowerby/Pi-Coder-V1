# Pi Coder v1

A TDD orchestrator/worker harness for [pi](https://github.com/earendil-works/pi-coding-agent) — semi-deterministic coding with strict test-driven development.

Pi Coder replaces the default "you're a coding assistant" mode with a structured orchestrator that delegates all implementation to specialized subagents, enforcing a strict Red→Green→Review lifecycle. The orchestrator cannot edit files, read file contents, or run arbitrary commands — it can only delegate, observe, and decide.

## How It Works

Pi Coder adds an **orchestrator mode** to pi. When toggled on, your pi session transforms:

- The system prompt is replaced with the orchestrator identity
- Tool access is restricted to delegation and observation tools only
- A finite state machine (FSM) tracks the TDD lifecycle
- Subagent calls are validated against the current FSM state
- Test results auto-advance the state machine
- State is persisted to disk — cycles survive crashes and session restarts

The orchestrator follows this lifecycle:

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

### Key Invariant

The orchestrator can **never** put the FSM into an invalid state. Tool calls are validated against the current state. Invalid delegations are blocked. Deterministic events (test results, subagent completions) auto-transition the FSM. The LLM decides *what* to do; the extension guards *whether* it can.

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
- `.pi-coder/specs/` — spec files for each feature
- `.pi-coder/config.json` — configuration (auto-detects your test runner)
- `.pi/agents/pi-coder-*.md` — agent definition files (copied from package defaults)
- `.pi/settings.json` — disables built-in subagents so only `pi-coder.*` agents are visible

### 3. Toggle orchestrator mode

```
/pi-coder
```

Activates orchestrator mode. You'll see `🔧 pi-coder` in the status bar. Type it again to return to normal Pi mode.

### 4. Make a request

Just describe what you want built. The orchestrator will:
1. Delegate to the **researcher** to investigate the codebase
2. Prune the research into an actionable **spec** with acceptance criteria
3. Present the spec for your approval
4. Create a git checkpoint and begin the **TDD cycle**
5. Alternate RED (write tests) → GREEN (make tests pass) → **Review**
6. Merge on approval, persist knowledge learnings

## State Persistence

Pi Coder persists its FSM state to `.pi-coder/state.json` on every state transition and toggle. This means **your TDD cycles survive session restarts, context clears, and crashes**.

### What's stored

```json
{
  "version": 1,
  "piCoderActive": true,
  "fsm": {
    "currentState": "TDD_GREEN_WRITE",
    "activeSpecId": "user-authentication",
    "loopCount": 1,
    "gitRef": "a1b2c3d4"
  },
  "updatedAt": "2026-05-25T14:30:00.000Z"
}
```

This is the minimum needed to restore the state machine. Everything else is already on disk:
- Spec content → `.pi-coder/specs/{id}.md`
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
| `/pi-coder` | Toggle orchestrator mode on/off |
| `/pi-coder-init` | Initialize `.pi-coder/` structure and config |
| `/pi-coder-reset-agents` | Reset agent `.md` files to package defaults (requires confirmation) |
| `/pi-coder-logs` | Show interaction log statistics |

## Configuration

All configuration lives in `.pi-coder/config.json` (created by `/pi-coder-init`):

```json
{
  "testCommand": "npx vitest run",
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

### `testCommand`

The command used to run the project test suite. Auto-detected from `package.json` scripts during init (checks for `vitest` → `jest` → `test`). Examples:

- `"npm test"`
- `"npx vitest run"`
- `"npx jest"`

### `maxLoops`

Maximum number of NEEDS_CHANGES → TDD_RED_WRITE review cycles before the circuit breaker halts the spec. When tripped, the orchestrator pauses and presents options to the user. Default: `3`.

### `gitStrategy`

How feature branches are merged back after approval:

- `"branch-and-merge"` — standard `git merge`
- `"squash"` — `git merge --squash` + separate commit

### `branchPrefix`

Prefix prepended to all pi-coder branches. Branches are created as `{branchPrefix}{spec-id}` (e.g. `pi-coder/user-authentication`).

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

- `supabase-auth-flow.md`
- `error-handling-patterns.md`
- `api-route-conventions.md`

**What to persist:** Project conventions, gotchas, API patterns not obvious from code, architecture decisions constraining future work.

**What NOT to persist:** Task-specific decisions, temporary workarounds, anything obvious from reading code.

## The TDD Lifecycle

### Research & Spec

1. You make a request → orchestrator advances the FSM to SPEC_WORK
2. Orchestrator delegates to researcher (can do multiple rounds)
3. Orchestrator prunes research to only what's needed: acceptance criteria, constraints, key files
4. Orchestrator creates an **implementation plan** — breaking the spec into atomic units, each with its own ACs and key files
5. Orchestrator presents the spec for approval via `interview` with **multiple focused questions** (scope, ACs, constraints, plan) — not one big dump
6. On approval: `pi_coder_advance_fsm` advances to SPEC_APPROVED (FSM guard requires `spec_saved` + `spec_user_approved` evidence), then git checkpoint creates a feature branch

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
npm test             # Run test suite (465 tests)
npm run typecheck    # TypeScript strict mode check
```

## License

MIT
