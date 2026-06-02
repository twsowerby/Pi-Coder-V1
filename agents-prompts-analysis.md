# Pi-Coder Agent Definitions & Prompt Architecture — Deep-Dive Analysis

## Files Retrieved

1. `agents/pi-coder-implementor.md` (full file) — Implementor agent definition & system prompt
2. `agents/pi-coder-researcher.md` (full file) — Researcher agent definition & system prompt
3. `agents/pi-coder-reviewer.md` (full file) — Reviewer agent definition & system prompt
4. `prompts/pi-coder-orchestrator.md` (full file) — TDD orchestrator system prompt template
5. `prompts/pi-coder-light.md` (full file) — Light mode orchestration prompt
6. `prompts/pi-coder-plan.md` (full file) — Plan mode orchestration prompt
7. `src/prompts/prompt-builders.ts` (full file) — Runtime prompt assembly
8. `src/prompts/formatters.ts` (full file) — Config value → prompt section formatting
9. `src/types.ts` (full file) — FSM states, config, spec, unit types
10. `src/state-machine.ts` (full file) — TDD FSM definition & state machine
11. `src/light-state-machine.ts` (full file) — Light FSM definition
12. `src/base-state-machine.ts` (full file) — Shared FSM logic, diagram builder, action guards
13. `src/review-extraction.ts` (full file) — Verdict extraction from reviewer output

---

## 1. Agent Specialization & System Prompts

### Researcher (`agents/pi-coder-researcher.md`)

**Role:** Investigative context gatherer. Returns a structured report for the orchestrator to prune into an implementor brief.

**Tools:** `read, bash, grep, find, ls, web_search, code_search, fetch_content, get_search_content` — notably has **web/search tools** that the other agents lack.

**Key design pattern:** The researcher is a **read-only scout**. It never writes code. Its output is a structured report consumed by the orchestrator (not the implementor directly), with sections: Summary, Architecture, Key Files, Applied Knowledge, Existing Patterns, Risks & Constraints, Feasibility Assessment, Recommendations.

**Context inheritance:** `inheritProjectContext: true`, `inheritSkills: true` — gets the project's full context and skills.

**Critical instruction:** "Always check `.pi-coder/knowledge/` first" — knowledge base is the first-class source of truth before any codebase exploration.

**Limitations:** No concept of task type (logic vs UI vs wiring). The researcher investigates "for a specific feature" generically. The only UI-specific guidance is inherited from knowledge files (the implementor has explicit UI instructions, but the researcher does not).

### Implementor (`agents/pi-coder-implementor.md`)

**Role:** Code author operating under strict TDD mode constraints (RED or GREEN, never both).

**Tools:** `read, bash, edit, write, grep, find, ls` — has **write/edit tools** the researcher lacks. No web search.

**Key design pattern:** The implementor is a **stateless code writer** — it receives a single-mode task (RED or GREEN) and executes it in isolation. It cannot switch modes autonomously. It has no `contact_supervisor` — if ambiguous, it makes the best autonomous decision and documents it.

**Context inheritance:** `inheritProjectContext: true`, `inheritSkills: true` — same as researcher.

**Critical distinction from researcher:** While the researcher explores broadly and returns a report, the implementor:
- Writes code (test or implementation) — the researcher never writes
- Operates in a single tightly-scoped mode (RED or GREEN)
- Has explicit AC-traceability requirements (`[ACn]` annotations in test names)
- Has explicit test-discovery instructions (find existing test files, extend don't duplicate)
- Has explicit UI work instructions (check `design_system.md`, follow existing patterns)
- Has an autonomy protocol for ambiguous decisions (minor → note it, structural → simpler option, test conflicts → don't modify, scope → implement only your ACs)

**Autonomy rules are notable:** The implementor is explicitly designed to **never block** — it documents decisions instead of asking questions. This is because "the orchestrator cannot respond mid-task."

### Reviewer (`agents/pi-coder-reviewer.md`)

**Role:** Adversarial, independent quality gate. "Find real problems — not rubber-stamp."

**Tools:** `read, bash, grep, find, ls` — same as researcher minus web search tools. Has bash but no edit/write.

**Context inheritance:** `inheritProjectContext: false` — the reviewer deliberately operates WITHOUT project context. It judges code on its merits, not project conventions. This is intentional independence.

**No `contact_supervisor`:** The reviewer works in total isolation. "If information is missing, state it as a gap."

**Critical structural feature:** The `---VERDICT---` block at the end — the ONLY machine-parseable output. Everything before it is human-readable prose.

### Specialization Summary

| Dimension | Researcher | Implementor | Reviewer |
|---|---|---|---|
| **Core action** | Read & report | Write code | Judge code |
| **Write tools** | None | edit, write | None |
| **Search tools** | web_search, code_search | grep, find only | grep, find only |
| **Project context** | Inherited | Inherited | NOT inherited |
| **TDD mode** | None | RED or GREEN | N/A |
| **Autonomy** | Scoping | Decision-making (documented) | Independence (never asks) |
| **Output consumer** | Orchestrator (pruned) | FSM (tests/code on disk) | FSM (verdict block) |
| **UI awareness** | Via knowledge | Explicit design_system.md | No special handling |

---

## 2. Orchestrator Prompt — Task Routing & FSM Control

The orchestrator prompt (`prompts/pi-coder-orchestrator.md`) is the most complex prompt in the system. It is a **template** with runtime variable substitution.

### Template Variables

| Variable | Source | Purpose |
|---|---|---|
| `{{fsmDiagram}}` | `sm.buildDiagram()` | Compact state topology for LLM navigation |
| `{{currentState}}` | `sm.currentState` | Current FSM state — determines what to do next |
| `{{activeSpecId}}` | Runtime | Which spec is active |
| `{{loopCount}}` | `sm.loopCount` | Review loop counter for circuit breaker |
| `{{maxLoops}}` | `config.maxLoops` | Circuit breaker threshold |
| `{{toolList}}` | Filtered snippets | Available tools with descriptions |
| `{{interviewTimeout}}` | `config.interviewTimeout` | Interview timeout setting |
| `{{referenceProjects}}` | `formatReferenceProjects()` | External reference projects (experimental) |

### Task Routing Logic

The orchestrator does NOT switch agents based on task type (logic vs UI vs wiring). Routing is **FSM-state-driven**:

1. **SPEC_WORK** → delegate to `pi-coder.researcher`
2. **TDD_RED_WRITE** → delegate to `pi-coder.implementor` (RED mode)
3. **TDD_GREEN_WRITE** → delegate to `pi-coder.implementor` (GREEN mode)
4. **REVIEWING** → delegate to `pi-coder.reviewer`
5. **NEEDS_CHANGES** → re-delegate to `pi-coder.implementor` (functional → RED, non-functional → direct)

The FSM **action rules** in `state-machine.ts` enforce this at the state machine level:

```typescript
// Researcher only in SPEC_WORK, TDD_RED_WRITE, TDD_GREEN_WRITE
{ toolPattern: "subagent", agents: ["pi-coder.researcher"],
  allowedStates: new Set(["SPEC_WORK", "TDD_RED_WRITE", "TDD_GREEN_WRITE"]) }

// Implementor only in TDD_RED_WRITE, TDD_GREEN_WRITE, NEEDS_CHANGES
{ toolPattern: "subagent", agents: ["pi-coder.implementor"],
  allowedStates: new Set(["TDD_RED_WRITE", "TDD_GREEN_WRITE", "NEEDS_CHANGES"]) }

// Reviewer only in REVIEWING
{ toolPattern: "subagent", agents: ["pi-coder.reviewer"],
  allowedStates: new Set(["REVIEWING"]) }
```

### Unit-at-a-Time Constraint

The prompt explicitly enforces: "One unit per RED/GREEN cycle — never delegate multiple units at once. If the spec has 5 units, that's 5 separate RED/GREEN cycles."

### Delegation Brief Discipline

The orchestrator MUST include these fields in every implementor brief:
- **Mode** (RED/GREEN/direct)
- **Acceptance Criteria** (exact ACs)
- **Constraints** (from spec)
- **Key files**
- **Knowledge files**
- **Existing test discovery** (pre-run grep/find results)
- **Existing test coverage** (extend vs create directive)
- **Unit name and approach** (tdd vs direct)
- **Test suite** (which testCommands key to use)

The test-discovery step is done by the **orchestrator** (not the implementor) — the orchestrator runs `grep -r 'describe|it(|test(' <key-file-dirs>` and `find . -name '*.test.*'` before delegating, and includes the results in the brief.

---

## 3. Task Type Concept (Logic vs UI vs Wiring)

**There is NO task type concept in the prompts or FSM.** The system treats all tasks identically through the same TDD lifecycle. The only differentiation is:

1. **`approach: "tdd"` vs `approach: "direct"`** — on `ImplementationUnit` — determines whether the RED phase is skipped
2. **`testSuite`** — on `ImplementationUnit` — determines which test command suite to run

The **implementor** has UI-specific instructions ("For UI work specifically: Check for `design_system.md`"), but this is the implementor deciding at runtime, not the prompt/FSM dispatching based on task type.

**Gap:** There is no concept of:
- UI tasks getting a different agent or prompt
- Wiring/glue tasks getting simplified flows
- Logic tasks getting deeper assertion requirements
- Task-type-specific review criteria

The `approach: "direct"` classification is the closest thing to task typing — it's for units that don't need TDD (config changes, docs, non-behavioral edits). But it requires human approval during the spec interview.

---

## 4. TDD RED vs GREEN Behavior

The implementor prompt is **exceptionally precise** about mode separation:

### RED Mode (Write Tests Only)
- Write ONLY test code
- Do NOT write implementation code
- Tests MUST fail when run (that's the point)
- Each `it()`/`test()` MUST include an AC reference (`[ACn]`)
- Discover existing tests first → extend, don't duplicate
- If no existing coverage → create new file following project conventions

### GREEN Mode (Write Implementation Only)
- Write ONLY application code to make failing tests pass
- Do NOT modify existing tests unless explicitly approved
- Write **minimal** code — no speculative extra features
- If a test seems wrong → do NOT change it, complete GREEN and note the concern

### Mode Enforcement
- "You must never mix them"
- "If the mode is unclear, stop and report it"
- "Never switch modes on your own — the orchestrator decides when to switch"
- "Never modify tests during GREEN phase unless your task payload explicitly grants permission"

### Direct Units (Bypass RED)
The orchestrator prompt specifies: "For direct units in RED_WRITE: the implementor should implement changes directly — no RED test phase needed." The `test_run_this_state` evidence is auto-set, so the RED_VALIDATE gate passes. But GREEN_VALIDATE still requires running the full test suite — "the safety net is never bypassed."

### Need-Changes Re-entry
When reviewer returns functional issues:
- "You are re-entering RED phase. Write NEW failing tests that demonstrate the bug identified by the reviewer. Do NOT modify the passing tests — they validate existing correct behaviour."

For non-functional fixes:
- "This is a non-functional change. Modify the code directly — no new tests needed."

---

## 5. Reviewer Verdict System

### What the Reviewer Checks (Priority Order)

1. **Test Alignment (Critical):**
   - Coverage: Missing test cases for any AC? `[ACn]` annotations required.
   - Quality: Brittle/tautological tests?
   - Proliferation: Multiple test files for the same module? (🟠 Medium)

2. **Potential Bugs:** Logic errors, null handling, race conditions, boundary conditions

3. **Security:** Input validation, injection, auth gaps, data exposure

4. **Correctness:** Does code satisfy each AC? Trace through logic, don't assume.

5. **API Contracts:** Breaking changes, missing error handling, inconsistent types

6. **Direct Unit Verification:** If `approach: "direct"`, verify production behavior wasn't changed beyond AC scope. If it was → 🔴 High "should have been TDD"

### What the Reviewer Skips
- Style, readability, naming
- Compiler/build errors (TDD runner validates these)
- Performance (unless egregious)
- Nitpicks, TODOs

### Mandatory Pre-Review Step
"You MUST execute the project's test suite before giving a verdict." If tests can't be run → 🔴 High, no approval.

### Verdict Block Format (Machine-Parseable)

**Approved:**
```
---VERDICT---
VERDICT: approved
---END VERDICT---
```

**Needs Changes:**
```
---VERDICT---
VERDICT: needs_changes
FIX_TYPE: functional
---END VERDICT---
```

or `FIX_TYPE: non-functional`

**Fix type classification is critical:** It gates whether the implementor can take the non-functional shortcut (direct edit) vs. requiring a full RED/GREEN cycle. The reviewer prompt explicitly warns: "Do NOT classify a functional change as non-functional just because it's small."

### Verdict Extraction (Code)

`review-extraction.ts` implements a 3-tier extraction:

| Tier | Mechanism | Priority |
|---|---|---|
| 0 | Structured `---VERDICT---` block | Highest |
| 1 | Last emoji occurrence (✅/❌/⚠️) | Fallback |
| 2 | Text pattern matching (`**Verdict:** approved`) | Last resort |

The "last occurrence" logic for emojis is deliberate — the review body may contain emojis in prose, but the actual verdict is at the end.

### AC Traceability Check

The reviewer must verify every AC has at least one test. If `[ACn]` annotations are present, trace through them. Any AC with zero test coverage → 🔴 High.

---

## 6. Dynamic Prompt Assembly

### Architecture

`prompt-builders.ts` implements a **template-substitution** model:

1. **Load template** from `.md` file (with YAML frontmatter stripped)
2. **Cache** the template in module scope (single load per session)
3. **Substitute** `{{variable}}` placeholders with runtime values
4. **Format** config values into prompt sections via `formatters.ts`

### Template Loading — Override Mechanism

```typescript
// Check for project-scope customization at .pi/agents/pi-coder-orchestrator.md
// first, falling back to the package default
const projectOverridePath = cwd
  ? join(cwd, ".pi", "agents", "pi-coder-orchestrator.md")
  : null;
```

Projects can **override the orchestrator prompt** by placing a file at `.pi/agents/pi-coder-orchestrator.md`. This override mechanism exists for the orchestrator prompt but is NOT implemented for the light/plan prompts (they only load from the package path).

### Cache Reset

Three cache reset functions exist: `resetOrchestratorPromptCache()`, `resetPlanModePromptCache()`, `resetLightModePromptCache()`. These are called by the "reset-agents" command to pick up prompt file changes mid-session.

### Variable Substitution — `replace()` Chain

All three prompt builders use a chain of `.replace("{{var}}", value)` calls:

```typescript
return template
  .replace("{{fsmDiagram}}", sm.buildDiagram())
  .replace("{{currentState}}", sm.currentState)
  .replace("{{activeSpecId}}", activeSpecId ?? "none")
  .replace("{{loopCount}}", String(sm.loopCount))
  .replace("{{maxLoops}}", String(config.maxLoops))
  .replace("{{interviewTimeout}}", String(config.interviewTimeout))
  .replace("{{toolList}}", toolList)
  .replace("{{referenceProjects}}", formatReferenceProjects(config.referenceProjects))
  .replace("{{testSuites}}", formatTestSuites(config.testCommands));
```

**Notable:** `replace()` operates on the first occurrence only. If a template variable appears multiple times, only the first is substituted. This appears intentional (each variable appears once in the templates).

### Formatters (`formatters.ts`)

Two pure functions:
- `formatReferenceProjects()` — Formats `referenceProjects` config into a prompt section with instructions for how the researcher accesses them
- `formatTestSuites()` — Formats `testCommands` into a prompt section listing suite names and commands

Both return empty string when no config is provided, so they're fully optional.

### Room for Adaptive/Conditional Prompt Construction

**Current limitations:**
1. **No conditional sections** — The template is a flat string with variable substitution. There's no `{{#if condition}}...{{/if}}` logic. If `referenceProjects` is empty, the `{{referenceProjects}}` token is replaced with `""`, leaving no trace.
2. **No per-task-type sections** — No mechanism to inject UI-specific, logic-specific, or wiring-specific instructions based on the current unit's characteristics.
3. **No per-unit prompt tailoring** — The orchestrator prompt is assembled once per conversation turn. There's no injection of unit-specific guidance (e.g., "this unit is UI-heavy, focus on design_system.md").
4. **Override is all-or-nothing** — The `.pi/agents/` override replaces the entire orchestrator prompt. There's no mechanism to extend or patch specific sections.

**Where it could be extended:**
- Add new template variables like `{{unitApproach}}`, `{{unitHints}}` that vary per unit
- Add conditional sections using a simple `{{#if}}` processor
- Add a project-level "prompt extensions" directory (e.g., `.pi/agents/orchestrator-append.md`) that appends to the base prompt instead of replacing it
- The `buildDiagram()` method already computes different diagrams for TDD vs Light mode, proving the architecture can support mode-conditional rendering

---

## 7. Light Mode vs Full TDD vs Plan Mode

### TDD Mode (Orchestrator Prompt)

**FSM States:** 15 states (`IDLE → SPEC_WORK → SPEC_APPROVED → GIT_CHECKPOINT → TDD_RED_WRITE → TDD_RED_VALIDATE → TDD_GREEN_WRITE → TDD_GREEN_VALIDATE → REVIEWING → APPROVED/FINAL_APPROVAL → MERGING → COMPLETE`)

**Key characteristics:**
- Full TDD RED/GREEN cycle with test-gated transitions
- Evidence guards enforce test execution before state advancement
- One unit per RED/GREEN cycle
- Per-unit test suite selection
- Circuit breaker on max review loops (default: 3)
- Researcher available in SPEC_WORK, TDD_RED_WRITE, TDD_GREEN_WRITE
- Direct unit classification with human approval requirement
- RED_VALIDATE has triple exit: pass → GREEN_WRITE, fail → BLOCKED, tautology acknowledge → GREEN_WRITE

### Light Mode (`prompts/pi-coder-light.md`)

**FSM States:** 12 states (TDD_RED_WRITE/RED_VALIDATE/GREEN_WRITE/GREEN_VALIDATE collapsed into single `IMPLEMENTING` state)

**Key characteristics:**
- NO TDD phases — spec → implement → review → merge
- `pi_coder_run_tests` is advisory — "use it to check progress, but it doesn't gate FSM transitions"
- Tests are available in ANY state (all states listed in `allowedStates`)
- IMPLEMENTING can go to REVIEWING without running tests
- NEEDS_CHANGES → REVIEWING has NO evidence gate (no TDD cycle being bypassed)
- Delegate 1-2 units per implementor call (vs. 1 per TDD cycle)
- No test-discovery-before-delegation requirement in the prompt (though it's still good practice)
- `allowAnyToBlocked: true` — any state can transition to BLOCKED (emergency override), unlike TDD where BLOCKED only comes from RED_VALIDATE

### Plan Mode (`prompts/pi-coder-plan.md`)

**No FSM at all.** Pure investigation and discussion assistant.

**Key characteristics:**
- Only subagent: `pi-coder.researcher` — no implementor, no reviewer
- No specs, no git, no test running, no state machine
- Tools limited to: `ls, find, grep, subagent, upsert_knowledge, interview, intercom`
- Purpose: deep investigation, architectural discussion, requirements gathering
- Explicitly cannot implement: "If the user asks to implement something, tell them to switch modes"
- `ls/find/grep` for file discovery only — "NEVER use grep/ls/find to actually answer the research question"
- Can persist findings to knowledge for later Light/TDD sessions

### Comparison Matrix

| Dimension | TDD | Light | Plan |
|---|---|---|---|
| **FSM** | Full 15-state | Simplified 12-state | None |
| **Test gating** | Mandatory (evidence guards) | Advisory (any state) | N/A |
| **Subagents** | Researcher + Implementor + Reviewer | Researcher + Implementor + Reviewer | Researcher only |
| **RED/GREEN** | Explicit phases | Collapsed to IMPLEMENTING | N/A |
| **Git operations** | Full (checkpoint, merge) | Full (checkpoint, merge) | None |
| **Spec workflow** | Full (save, read, approve) | Full (save, read, approve) | None |
| **Output** | Merged code | Merged code | Knowledge + discussion |
| **BLOCKED transition** | RED_VALIDATE only | Any state | N/A |
| **Circuit breaker** | Yes (loop count) | Yes (loop count) | N/A |
| **Direct units** | Human-approval-gated | Human-approval-gated | N/A |

---

## Key Code

### ImplementationUnit Type (the per-unit task definition)
```typescript
interface ImplementationUnit {
  name: string;
  acceptanceCriteriaIndices: number[];  // 0-based indices into spec's AC array
  keyFiles: string[];
  dependsOn: string[];
  approach?: "tdd" | "direct";         // Only task-type classification that exists
  testSuite?: string;                   // Which testCommands key to use
}
```

### Evidence Flags (transition guards)
```typescript
type EvidenceFlag =
  | "spec_saved"
  | "spec_user_approved"
  | "test_run_this_state"
  | "non_functional_classified"
  | "review_completed";
```

### Review Verdict Type (machine-parseable output)
```typescript
type ReviewVerdict =
  | { verdict: "approved" }
  | { verdict: "needs_changes"; fixType: "functional" | "non-functional"; issues?: IssueDetail[] };
```

### Verdict Block (what the reviewer MUST output)
```
---VERDICT---
VERDICT: approved
---END VERDICT---

---VERDICT---
VERDICT: needs_changes
FIX_TYPE: functional
---END VERDICT---
```

### Verdict Extraction Tiers
```typescript
// Tier 0: Structured block (highest priority)
const verdictBlockMatch = text.match(/---VERDICT---\s*\n\s*VERDICT:\s*(approved|needs_changes)\s*\n...);

// Tier 1: Last emoji (✅/❌/⚠️) — avoids false positives from prose
const approvedIndex = text.lastIndexOf("✅");
const rejectIndex = text.lastIndexOf("❌");
const changesIndex = text.lastIndexOf("⚠️");

// Tier 2: Text pattern matching (lowest priority)
if (/\*\*Verdict:\*\*\s*approved/i.test(text)) { ... }
```

---

## Architecture

```
User Request
    │
    ▼
┌──────────────────────────────────────────────────────┐
│  Mode Selection (off/plan/light/tdd)                 │
│  - TDD: full orchestrator prompt + StateMachine      │
│  - Light: light prompt + LightStateMachine           │
│  - Plan: plan prompt, no FSM                         │
└───────────┬──────────────────────────────────────────┘
            │
            ▼
┌──────────────────────────────────────────────────────┐
│  Orchestrator (LLM with system prompt assembled by   │
│  prompt-builders.ts)                                  │
│  - Template loaded from .md file (cached)            │
│  - {{variables}} substituted at runtime               │
│  - .pi/agents/ override for orchestrator only        │
│  - FSM diagram injected for LLM state awareness      │
└────┬──────────┬───────────┬──────────────────────────┘
     │          │           │
     ▼          ▼           ▼
 Researcher  Implementor  Reviewer
 (read-only)  (RED|GREEN)  (adversarial)
     │          │           │
     │          │           │
     ▼          ▼           ▼
 Structured   Code on     ---VERDICT---
 Report       disk         block
     │          │           │
     └──────────┴───────────┘
                │
                ▼
     FSM State Advancement
     (evidence guards + auto-transitions)
```

**Data flow:**
1. Orchestrator reads spec → assembles brief → delegates to agent
2. Agent executes → returns result inline (NEVER via output file)
3. Tool result handler auto-transitions FSM or triggers orchestrator judgment
4. Verdict extraction parses `---VERDICT---` block → FSM auto-transitions
5. Circuit breaker halts if `loopCount >= maxLoops`

---

## Start Here

**Open `src/prompts/prompt-builders.ts`** — this is the junction point where all prompt assembly happens. It loads the templates, substitutes variables, and builds the three mode-specific system prompts. Understanding this file is prerequisite to any prompt architecture change.

For understanding the FSM that drives routing, open **`src/state-machine.ts`** (TDD) and **`src/light-state-machine.ts`** (Light) — the `actionRules` arrays are the authoritative routing constraints.

---

## Supervisor Coordination

No blocking decisions needed. Analysis is complete.
