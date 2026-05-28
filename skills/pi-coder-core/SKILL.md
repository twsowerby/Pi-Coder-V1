---
name: pi-coder-core
description: Pi Coder shared procedures — spec writing, git checkpoint, review, final approval, delegation templates, recovery, and knowledge consolidation. Load this skill when you are in any Pi Coder mode and need step-by-step procedures.
---

# Pi Coder — Core Procedures

This skill contains shared procedures used by all Pi Coder modes (Plan, Light, TDD). Mode-specific procedures are in separate skills.

## Spec Work

When the user makes an implementation request and your FSM is in IDLE:

1. Use `pi_coder_advance_fsm` with targetState `SPEC_WORK` to start the cycle
2. Run `ls .pi-coder/knowledge/` to see what project-specific rules already exist
3. Identify which knowledge files are relevant to the user's request based on their filenames — for example, a request about authentication is likely relevant to `supabase-auth-flow.md` but not `error-handling-patterns.md`
4. Delegate to the researcher:
   - Use `subagent` with agent `pi-coder.researcher`, context `fresh`
   - Include the user's request and the relevant knowledge filenames in the task
   - The researcher will check those knowledge files first, then investigate the codebase
   - If reference projects are configured, include the project name and absolute path in the task so the researcher can navigate there. Do NOT pass `cwd` to the subagent tool. The researcher accesses reference projects by navigating via bash and reading files with absolute paths.

Do not begin research on your own. You do not read files — you delegate.

If the user asks a question rather than requesting implementation, answer it within your tool constraints. The FSM stays in IDLE. Only implementation requests advance the FSM.

### When Not to Use the TDD/Light Lifecycle

Some user requests don't fit the lifecycle. Recognizing these early prevents frustration:

**Skip the FSM and suggest toggling off (`/pi-coder`) when the user wants to:**
- Run tests or check if tests pass (not implement anything)
- Debug an issue or investigate a failure
- Quick-examine a file or understand existing code
- Make a one-off change that doesn't warrant a full spec/TDD cycle
- Ask questions about the codebase

**The lifecycle is for building new features and fixing bugs** — requests where you need to research, plan, implement, and verify. If the user's request doesn't need that workflow, don't force it through the FSM. Say:

> "This doesn't need the full lifecycle. Toggle off with `/pi-coder` and ask in normal Pi mode — you'll get a direct answer without the FSM ceremony."

**Do NOT** create a spec just to run a subagent. The FSM is not a general-purpose delegation tool — it's a structured process enforcement mechanism.

### Design System Check

After the researcher returns, assess whether this spec involves UI work. If it does:

1. Check if `design_system.md` exists in `.pi-coder/knowledge/`
2. If it exists, reference it in the spec constraints — specify which existing components, patterns, and layout conventions the implementor must follow
3. If it doesn't exist and the spec involves UI decisions, **suggest the user create one** before proceeding

### Context Extraction

When the researcher returns findings, extract **only** these four things:

1. **Acceptance Criteria** — specific, testable statements of what "done" looks like
2. **Constraints** — hard boundaries the implementation must respect
3. **Key Files** — file paths the implementor needs to know about, with a brief note on why each matters
4. **Applied Knowledge** — project rules from `.pi-coder/knowledge/` that strictly govern this implementation

**Omit everything else.** Do not include raw code snippets or verbose analysis. The implementor gets a clean, focused brief — not a research dump.

### Implementation Plan

Before presenting the spec for approval, create an implementation plan that breaks the work into **atomic units**. Each unit maps to one or more acceptance criteria and contains everything the implementor needs for that piece — and nothing else.

Rules for decomposition:
- **One concern per unit.** If two ACs share files and are tightly coupled, group them. If they touch different files, split them.
- **Minimal dependencies.** Prefer units that can be implemented independently.
- **Scope key files per unit.** Each unit lists only the files it touches.
- **Sequential by default.** The implementor works one unit at a time. Parallel delegation is not used.

### Delegation Pacing

**Never delegate the entire spec to a single implementor call.** The implementation plan breaks work into atomic units for a reason — delegate 1-2 units per implementor call. This preserves:
- **Context window** — less code in-flight means better implementor focus
- **Focus** — the implementor can concentrate on one concern at a time
- **Checkpoint frequency** — you can git-checkpoint between delegations for finer-grained rollback

Rules:
- **Maximum 2 units per implementor delegation** — if the spec has 5 units, that's at least 3 delegations
- **Re-read the spec before each delegation** — ACs or constraints may have been adjusted after a previous delegation
- **Between delegations, optionally checkpoint** with `pi_coder_git checkpoint` for finer-grained rollback
- **On re-entry to IMPLEMENTING** (after NEEDS_CHANGES), target only the specific unit that needs fixing — do not re-delegate the entire spec
- **TDD mode**: The RED/GREEN cycle already enforces per-unit delegation. This rule reinforces it — one unit per RED/GREEN cycle.

### Spec Drafting & Structured Approval

When your research and plan are ready, **save the spec first** using `pi_coder_save_spec`:

```
pi_coder_save_spec({
  id: "user-auth",
  title: "User Authentication",
  acceptanceCriteria: ["Users can log in", "Users can log out"],
  constraints: ["Must use existing auth middleware"],
  keyFiles: ["src/auth.ts", "src/middleware/auth.ts"],
  prunedContext: "Research summary...",
  implementationPlan: [...]
})
```

This persists the spec to `.pi-coder/specs/{id}.md`. **Always save before presenting for approval.**

Then present the spec for approval using `interview` with **multiple focused questions** — not one big dump:

1. **Scope question**: "We're building [title]. Scope: [2-sentence summary]. Does this match your intent?"
2. **Acceptance criteria question**: "Acceptance criteria: [bulleted list]. Are these the right tests of 'done'?"
3. **Constraints question**: "Constraints: [bulleted list]. Anything missing or wrong?"
4. **Implementation plan question**: "Implementation plan: [unit names with AC references]. Does this decomposition look right?"

If the user rejects or requests changes, refine the spec and resubmit.

When approved, use `pi_coder_advance_fsm` with targetState `SPEC_APPROVED`.

---

## Git Checkpoint

When your FSM is in SPEC_APPROVED, advance to GIT_CHECKPOINT:

1. Use `pi_coder_advance_fsm` with targetState `GIT_CHECKPOINT`
2. Call `pi_coder_git` with action `checkout_branch` — use the spec ID as the branch name (the tool will prepend the configured prefix)
3. Call `pi_coder_git` with action `checkpoint` and message `wip: pre-implementation-{spec-id}`
4. The tool will store the pre-implementation git ref — you will need this ref when briefing the reviewer later
5. The FSM will auto-transition to the next state on checkpoint completion

You do not run raw git commands. All Git operations go through `pi_coder_git`.

---

## Review

When your FSM is in REVIEWING (all implementation units complete):

1. Delegate to the reviewer:
   - Use `subagent` with agent `pi-coder.reviewer`, context `fresh`
   - Include all acceptance criteria and the pre-implementation git ref
   - The reviewer will run `git diff {ref}` itself to see ALL changes across all units

2. Interpret the reviewer's verdict:

   - **✅ Approved** → The auto-transition handler advances to APPROVED. Proceed to Final Approval.
   - **⚠️ Needs Changes** / **❌ Needs Changes** → The auto-transition handler advances to NEEDS_CHANGES. Both ⚠️ and ❌ map to the same `needs_changes` FSM state — the FSM does not distinguish severity.
     - **Non-functional fix** (test cleanup, comments, naming, assertion additions): Delegate implementor directly in NEEDS_CHANGES to apply the fix, then advance to REVIEWING via `pi_coder_advance_fsm REVIEWING`. In TDD mode, the `non_functional_classified` evidence flag was already set by the auto-transition — the evidence gate is already satisfied. In Light mode, there is no evidence gate. Loop count increments.
     - **Functional fix** (production code changes): Advance to the implementation state (TDD_RED_WRITE or IMPLEMENTING) via `pi_coder_advance_fsm`. A full implementation cycle is needed. Loop count increments.
     - **Verdict extraction failure recovery**: If you don't see an AUTO-TRANSITION notice after the reviewer completes (and instead see "⚠️ AUTO-TRANSITION FAILED"), read the review output yourself and manually advance with `pi_coder_advance_fsm` to APPROVED or NEEDS_CHANGES based on your reading. For approved reviews, just call `pi_coder_advance_fsm APPROVED` — the `review_approved` evidence gate is satisfied automatically. In TDD mode, for non-functional fixes, pass `fixType="non-functional"` to `pi_coder_advance_fsm` — this manually sets the `non_functional_classified` evidence flag before transitioning. For functional fixes, no evidence is required for the transition to IMPLEMENTING/TDD_RED_WRITE.

3. When looping back, **target the specific unit** that needs changes. Do not re-send the entire spec.

4. Monitor the loop count. Every NEEDS_CHANGES exit increments the counter. If it reaches the configured maximum, the circuit breaker trips (see Recovery Procedures).

---

## Final Approval & Merge

When your FSM is in APPROVED:

1. Present a final report to the user using `interview`:
   - Summary of changes made
   - Test results per unit
   - Review verdict
   - Any deferred items
   - Knowledge learnings discovered during the cycle
2. If the user approves, use `pi_coder_advance_fsm` to advance to MERGING (direct path — the interview IS the multi-point approval) or through FINAL_APPROVAL → MERGING → COMPLETE
3. If the user rejects, offer a rollback — call `pi_coder_git` with action `rollback` using the stored pre-implementation ref

When in MERGING:

1. Call `pi_coder_git` with action `merge`
2. The tool will merge the feature branch and the FSM will transition to COMPLETE

When in COMPLETE:

1. Perform knowledge consolidation (see below)
2. Clean up the spec file from `.pi-coder/specs/`
3. The FSM returns to IDLE, ready for the next request

---

## Delegation Templates

**Before every delegation**, use `pi_coder_read_spec` with the active spec ID to get the exact acceptance criteria, constraints, and key files. Do NOT rely on your memory — always read the fresh spec before delegating.

### Researcher Task

```
Research the following implementation request: {user request}

Before investigating the codebase, read these knowledge files in .pi-coder/knowledge/:
{relevant filenames from ls .pi-coder/knowledge/}

Return a structured report with: Summary, Architecture, Key Files (with purpose), Applied Knowledge (rules found), Existing Patterns, Risks & Constraints, Feasibility Assessment, Recommendations.
```

Include only the knowledge filenames that are relevant to the request. If no knowledge files exist or none are relevant, omit the knowledge section entirely — do not send the researcher on a wild goose chase.

### Implementor — RED Phase (per unit)

```
RED phase — write tests only. Do NOT write implementation code.

Unit: {unit name}

Acceptance Criteria for this unit:
- {AC item from acceptanceCriteria at the unit's indices}

Constraints (apply to this unit):
- {constraints relevant to this unit's key files}

Key Files for this unit:
- {path} — {purpose}

Check .pi-coder/knowledge/ for project-specific rules before writing tests.
```

The task payload must NOT contain implementation code, design suggestions, or architectural recommendations. Only the ACs for this unit, relevant constraints, and the unit's key files. The implementor decides how to write the tests.

### Implementor — GREEN Phase (per unit)

```
GREEN phase — write code to make tests pass. Do NOT modify tests without explicit orchestrator approval.

Unit: {unit name}

Acceptance Criteria for this unit:
- {AC item}

Constraints (apply to this unit):
- {constraint}

Key Files for this unit:
- {path} — {purpose}

Tests were written against commit {pre-implementation git ref}. Run `git diff {ref}` to see the test files for this unit.

Check .pi-coder/knowledge/ for project-specific rules before writing code.
```

If you need to approve a test modification during GREEN phase, use `contact_supervisor` — the implementor can escalate to you via this channel.

### Implementor — Light Mode (1-2 units per delegation)

```
IMPLEMENTING phase — implement the following units. This is NOT TDD — write both code and tests as needed.

Units: {unit names}

{for each unit:}
Unit: {unit name}
Acceptance Criteria for this unit:
- {AC item from acceptanceCriteria at the unit's acceptanceCriteriaIndices}

Constraints (apply to this unit):
- {constraints relevant to this unit's key files}

Key Files for this unit:
- {path} — {purpose}

{end for each unit}

Check .pi-coder/knowledge/ for project-specific rules before writing code.

After completing these units, stop and return what you've done. Do NOT continue to other units in the implementation plan — each delegation is scoped to 1-2 units. The orchestrator will delegate the next batch.
```

The task payload must NOT contain implementation code, design suggestions, or architectural recommendations. Only the ACs for the specified units, relevant constraints, and the units' key files. The implementor decides how to implement.

### Reviewer Task

```
Review the implementation against the following Acceptance Criteria:
- {AC item 1}
- {AC item 2}
- ...

Implementation units completed:
- {unit 1 name}: {AC refs}
- {unit 2 name}: {AC refs}

Pre-implementation commit: {git ref}. Run `git diff {ref}` to see all changes.

Focus areas (review these):
- Test alignment — do the tests accurately cover the Acceptance Criteria?
- Potential bugs — logic errors, null/undefined handling, crash risks
- Security — vulnerabilities, input validation
- Correctness — does the code satisfy the Acceptance Criteria?
- API contracts — breaking changes, missing error handling

Skip areas (do NOT review these):
- Style, readability, naming
- Compiler or build errors
- Performance (unless egregious)
- Nitpicks and TODOs

MUST DO before giving verdict:
- Run the full test suite — both unit/integration AND any E2E tests
- If the project requires infrastructure (databases, dev servers) to run tests, start it first
- Record the test results in your review output
- Do NOT approve if tests cannot be executed or are failing
```

Do not include the diff itself in the task payload. The reviewer discovers the diff independently.

---

## Recovery Procedures

### RED_TAUTOLOGY — Tests Passed When They Should Fail

When RED tests pass unexpectedly, the extension presents guidance with two options (instead of automatically blocking):

1. **Acknowledge and proceed** (`pi_coder_advance_fsm TDD_GREEN_WRITE`) — The test coverage is valid even though tests passed immediately. This is common when:
   - Adding assertions to existing passing tests (verification, not TDD)
   - The implementor applied code+test simultaneously but coverage is valid
   - The feature already partially exists and you're extending coverage

2. **Block and recover** (`pi_coder_advance_fsm BLOCKED`) — The tests passing is genuinely problematic. This means either:
   - The tests are tautological (they assert nothing meaningful)
   - The test suite is fundamentally wrong

   In BLOCKED state, present the user with options using `interview`:
   - **Rewrite tests** — Loop back to the implementation state. In your next delegation, explicitly state what NEW behavior does not already exist in the tests.
   - **Abort spec** — Rollback to the pre-implementation checkpoint and return to IDLE. No code changes are preserved.

**Most RED tautologies are benign.** If you added a test assertion for behavior that already exists, the test is valid — acknowledge and proceed. Only block if the test is wrong, not if the code is right.

### CIRCUIT_BREAKER — Max Review Loops Reached

When the loop count reaches the configured maximum, the circuit breaker trips and the FSM enters BLOCKED.

Pause. Inform the user that the spec has gone through the maximum number of review cycles without converging. Present the current state:

- Which acceptance criteria are still failing
- What the reviewer's last findings were
- What the implementor's last output was

Ask the user for intervention. Do not automatically loop again. Options to present:

- **Refine the spec** — The acceptance criteria may be ambiguous or contradictory
- **Change constraints** — Something in the constraints may be blocking progress
- **Abort spec** — Rollback to checkpoint and return to IDLE

---

## Knowledge Consolidation

The knowledge system stores **cross-cutting project rules and gotchas** — things an agent needs to know BEFORE starting work, that are NOT discoverable from the spec or the code alone.

### Purpose of `.pi-coder/knowledge/`

Knowledge files are pre-task reference material. They tell future agents "here's what you need to know before you start" — conventions, landmines, and integration quirks.

### Persist these:

- **Project conventions** the implementor had to discover through trial and error
- **Debugging gotchas** — false paths that wasted time
- **Integration conflicts** — libraries that don't play well together
- **Architecture constraints** that aren't obvious from the code
- **Environment or tooling quirks**

### Do NOT persist these:

- **Cycle summaries** — redundant with the spec file
- **Implementation records** — in the spec and git history
- **Task-specific decisions** — only apply to the current spec
- **Anything obvious from reading the code directly**

### Co-location rule — update first, create only when genuinely new

1. Run `ls .pi-coder/knowledge/` to see existing domains
2. Read any file whose topic is related to your new learning
3. If a related file exists → **update it** with `upsert_knowledge`
4. Only create a new file if no existing file covers the topic

### How to persist:

1. Follow the co-location rule above
2. Call `upsert_knowledge` with the filename — it overwrites in place, so include the full updated content
3. Write the content as clear, actionable directives — "Always X", "Never Y"

---

## Steering Messages

If the user sends a message while a subagent is running, the message is queued and delivered to you after the current turn. You decide how to respond:

- If the message is a clarification relevant to the running subagent, you can interrupt the subagent and re-delegate with updated instructions
- If the message is unrelated to the current spec, acknowledge it and return focus to the cycle
- If the message changes the spec direction, you may need to abort the current cycle and restart

Do not forward user messages directly to subagents. You are the orchestrator — you interpret and delegate.

---

## Subagent Monitoring

Pi Coder automatically disables pi-subagents' control event emissions for all foreground subagent delegations. This prevents stale notifications from being delivered as steer messages.

Because Pi Coder uses synchronous (foreground) subagent delegation, the orchestrator cannot check on a running subagent in real-time — it's blocked waiting for the result.

**Auto-transitions are the primary mechanism for keeping the orchestrator on track.** When a tool result includes an ⚠️ AUTO-TRANSITION notice, read it carefully — it tells you the current state and what to do next.

**Advisory monitoring**: The orchestrator CAN use `subagent({ action: "status", id: "<runId>" })` and `subagent({ action: "interrupt", id: "<runId>" })` for manual inspection.

---

## Handling Detached Subagents

If a subagent returns with "Detached for intercom coordination", it paused mid-task and is waiting for a supervisor response.

**How to respond:**

1. Read the intercom message — it will contain the subagent's question or decision point
2. Use `intercom({ action: "reply", message: "..." })` to respond with your decision
3. The subagent will resume and complete its task
4. Wait for the final subagent result

**If you cannot resolve the ambiguity** (the question is unclear or you need user input):
- Respond to the subagent with a clear directive: "Make the best decision you can and document it. Choose [option]."
- Do NOT leave the subagent waiting indefinitely
