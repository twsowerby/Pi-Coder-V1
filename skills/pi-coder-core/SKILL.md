---
name: pi-coder-core
description: Pi Coder shared procedures — spec writing, git checkpoint, review, final approval, delegation templates, recovery, and knowledge consolidation. Load this skill when you are in any Pi Coder mode and need step-by-step procedures.
---

# Pi Coder — Core Procedures

This skill contains shared procedures used by all Pi Coder modes (Plan, Light, Dev). Mode-specific procedures are in separate skills.

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

#### Unit Test Strategy Classification

Each implementation unit requires a `testStrategy` field:
- **`testStrategy: "tdd"`** (default when absent) — Standard RED/GREEN cycle with all guards enforced.
- **`testStrategy: "verify"`** — IMPLEMENTING with test gate. The FSM blocks advancement until tests pass. Use this for units where test-first development isn't practical but testing IS needed after implementation (integration points, API surfaces). Provide `testStrategyRationale`.
- **`testStrategy: "skip"`** — IMPLEMENTING with no test gate. Use for changes with no testable behavior (CSS/styling, config, docs, renames). Provide `testStrategyRationale`.

When saving the spec, provide `testStrategy` and `testStrategyRationale` (required for verify and skip).

When advancing to TDD_RED_WRITE or IMPLEMENTING, pass the `unitName` parameter to `pi_coder_advance_fsm` so the FSM can track the active unit.

**After NEEDS_CHANGES**: When a reviewer flags a verify/skip unit as needing functional changes, re-save the spec with that unit's testStrategy changed to `"tdd"` before advancing from NEEDS_CHANGES. The RED_VALIDATE gate will enforce the TDD requirement. If you believe the current classification is still valid (e.g., reviewer flagged a documentation typo), re-save with the original strategy before advancing.

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

Then present the spec for approval using `pi_coder_approve_spec`:
```
pi_coder_approve_spec({ specId: "your-spec-id" })
```
This tool builds the interview questions programmatically and writes them to a file. Its output tells you the exact `interview` call to make — copy it exactly and call it as your next step.

**Each approval question uses "Approve" / "Needs changes" options.** The extension inspects your interview responses and only sets `spec_user_approved` when ALL questions have "Approve" selected.

If the user selects "Needs changes" for any question, `spec_user_approved` will NOT be set — review the feedback and revise the spec, then re-run `pi_coder_approve_spec`.

When all questions are approved, use `pi_coder_advance_fsm` with targetState `SPEC_APPROVED`.

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

   - **✅ Approved** → The auto-transition handler advances to APPROVED. After advancing, check: did the review include any actionable findings (even minor ones)? If yes, loop back — advance to NEEDS_CHANGES, fix the findings, then re-review. "Approved with findings" means the implementation is not yet complete. Fixing findings after merging requires starting an entire new FSM cycle, which is wasteful. Fix them now while you're still in the implementation phase. Proceed to Final Approval only when the review has zero actionable findings.
   - **⚠️ Needs Changes** / **❌ Needs Changes** → The auto-transition handler advances to NEEDS_CHANGES. Both ⚠️ and ❌ map to the same `needs_changes` FSM state — the FSM does not distinguish severity.
     - **Non-functional fix** (test cleanup, comments, naming, assertion additions): Delegate implementor directly in NEEDS_CHANGES to apply the fix, then advance to REVIEWING via `pi_coder_advance_fsm REVIEWING`. In TDD mode, the `non_functional_classified` evidence flag was already set by the auto-transition — the evidence gate is already satisfied. In Light mode, there is no evidence gate. Loop count increments.
     - **Functional fix** (production code changes): Advance to the implementation state (TDD_RED_WRITE or IMPLEMENTING) via `pi_coder_advance_fsm`. A full implementation cycle is needed. Loop count increments.
     - **Verdict extraction failure recovery**: If you don't see an AUTO-TRANSITION notice after the reviewer completes:
        1. If you see "⚠️ DEGRADED RECOVERY" — the intercom receipt path stripped the reviewer's output, but `review_completed` evidence was set automatically. Read the reviewer's output above and advance with `pi_coder_advance_fsm` to APPROVED or NEEDS_CHANGES.
        2. If you see "⚠️ AUTO-TRANSITION FAILED" — extraction failed AND no intercom receipt was detected. Re-delegate the reviewer with instructions to use the `---VERDICT---` block format.
        3. If re-delegation still fails, use `reviewOverride` on `pi_coder_advance_fsm` with the verdict you determined from reading the output. This is audited — provide a clear justification. Example: `pi_coder_advance_fsm({ targetState: "APPROVED", reviewOverride: { verdict: "approved", justification: "Reviewer clearly approved but extraction pipeline failed." } })`

3. When looping back, **target the specific unit** that needs changes. Do not re-send the entire spec.

4. Monitor the loop count. Every NEEDS_CHANGES exit increments the counter. If it reaches the configured maximum, the circuit breaker trips (see Recovery Procedures).

5. **Unit test strategy verification**: If the reviewer finds that a verify or skip unit changed production behavior that should have been tdd, re-save the spec with the updated testStrategy before advancing. See the "Reclassifying Units" section below.

---

## Reclassifying Units after Review

If the reviewer finds that a verify or skip unit changed production behavior and should have been tdd:

1. Re-save the spec with `pi_coder_save_spec`, changing the unit's testStrategy to `"tdd"`
2. Present the reclassification to the user via `pi_coder_approve_spec` for approval
3. The NEEDS_CHANGES → TDD_RED_WRITE flow will run a full RED/GREEN cycle for the unit
4. The test_run_this_state evidence will NOT be auto-set (the spec now says "tdd"), so the RED phase gate is enforced normally

The human's original spec approval covered the OLD classification. The reclassification is a material change that requires human sign-off.

---

## Final Sign-Off & Merge

When your FSM is in APPROVED:

1. Present a sign-off dialog to the user using `pi_coder_final_signoff`:
   ```
   pi_coder_final_signoff({ specId: "your-spec-id" })
   ```
   This shows a native TUI dialog with two options: **Approve and merge** or **Needs changes**.

2. If the user approves:
   - The tool sets `user_approved_merge` evidence (required for MERGING transition)
   - Call `pi_coder_advance_fsm` to advance to MERGING
   - Then call `pi_coder_git` with action `merge` (if mergeBranch is configured)
   - The FSM will auto-transition MERGING → COMPLETE after merge

3. If the user requests changes:
   - The tool transitions FSM to NEEDS_CHANGES automatically
   - Include the user's feedback in the next implementor delegation
   - After fixes and re-review, the cycle continues

⚠️ **You MUST call `pi_coder_final_signoff` before advancing to MERGING.** The evidence guard will block APPROVED → MERGING without it. Do not skip this step.

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

{External research signals: If the user's request mentions researching, looking up, or finding out about external topics, list them here. If the request involves unfamiliar libraries, version-specific questions, or security best practices, note that external search is likely needed. If the request is purely internal (business logic, existing patterns), omit this section.}

Return a structured report with: Summary, Architecture, Key Files (with purpose), Applied Knowledge (rules found), Existing Patterns, Risks & Constraints, External References (if you searched externally), Feasibility Assessment, Recommendations.
```

Include only the knowledge filenames that are relevant to the request. If no knowledge files exist or none are relevant, omit the knowledge section entirely — do not send the researcher on a wild goose chase.

**External research signals** — When constructing the researcher task, inspect the user's original request for signals that external search is needed:
- Explicit words: "research", "look up", "find out", "what's the best way to", "how does X handle"
- Implicit signals: the request involves a library not currently in the codebase, a version upgrade/migration, or security/auth concerns
- If you detect these signals, add an **External Research** section to the task like: `External research likely needed: {specific topic}. Check official docs, changelogs, or API references.`
- If no signals are present (purely internal business logic), omit the section — do not prompt the researcher to search externally for no reason

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

### Implementor — IMPLEMENT Phase (Dev mode, per unit)

```
IMPLEMENT phase — write code and tests for a verify-strategy unit. Write the implementation first, then write tests that verify the key behavior paths.

Unit: {unit name}
Test strategy: verify

Acceptance Criteria for this unit:
- {AC item from acceptanceCriteria at the unit's acceptanceCriteriaIndices}

Constraints (apply to this unit):
- {constraints relevant to this unit's key files}

Key Files for this unit:
- {path} — {purpose}

Check .pi-coder/knowledge/ for project-specific rules before writing code.
```

For **skip-strategy** units, use the same template but change the header and omit the test instruction:

```
IMPLEMENT phase — implement this skip-strategy unit. Write implementation code only — no tests needed for this unit.

Unit: {unit name}
Test strategy: skip

Acceptance Criteria for this unit:
- {AC item from acceptanceCriteria at the unit's acceptanceCriteriaIndices}

Constraints (apply to this unit):
- {constraints relevant to this unit's key files}

Key Files for this unit:
- {path} — {purpose}

Check .pi-coder/knowledge/ for project-specific rules before writing code.
```

The task payload must NOT contain implementation code, design suggestions, or architectural recommendations. Only the ACs for the unit, relevant constraints, and the unit's key files. The implementor decides how to implement.

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
- Run the full test suite — use the suite matching the current unit's `testSuite` field (if set), or the default suite
- If the project has multiple test suites (unit, component, e2e), use `pi_coder_run_tests` with the `suite` parameter to select the right one
- If the project requires infrastructure (databases, dev servers) to run tests, start it first
- Record the test results in your review output
- Do NOT approve if tests cannot be executed or are failing
- End your review with a ---VERDICT--- block (see reviewer agent definition for format)
```

Do not include the diff itself in the task payload. The reviewer discovers the diff independently.

---

## Recovery Procedures

### RED_TAUTOLOGY — Tests Passed When They Should Fail

When RED tests pass unexpectedly, the extension presents guidance with three options:

1. **Re-delegate to write tests first** — Stay in TDD_RED_WRITE and re-delegate to the implementor with explicit instructions to write ONLY failing test files. This is the correct TDD response when the implementor wrote production code without tests. Do NOT advance the FSM.

2. **Reclassify as skip strategy** — If this unit genuinely doesn't benefit from test-first development (config changes, documentation, non-behavioral changes), re-save the spec with `testStrategy: "skip"` on this unit, then advance to IMPLEMENTING. This records the decision explicitly and the human must approve it via `pi_coder_approve_spec`.

3. **Acknowledge and proceed** (`pi_coder_advance_fsm TDD_GREEN_WRITE`) — Only valid when new tests WERE written that test real new behavior, but they pass because the feature was already partially implemented. The test coverage is valid even though tests passed immediately.

**Most RED tautologies indicate the implementor did not write tests first.** Option 1 (re-delegate) is the default correct response. Option 2 is for genuinely non-behavioral units. Option 3 is ONLY for legitimately pre-existing behavior being newly tested — not for untested new code.

Do NOT acknowledge a tautology just because the existing test suite happens to pass. If no new tests exist for the new code, the tautology means there is no test coverage — re-delegate the implementor.

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
