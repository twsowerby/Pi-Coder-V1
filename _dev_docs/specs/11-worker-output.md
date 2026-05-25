# Spec 11: Worker Output — Skill Definition

## Status: ✅ COMPLETE

All 3 phases implemented and verified.

---

## Phase 1: Lifecycle Procedures ✅

### File
- `skills/pi-coder/SKILL.md` — replaced placeholder with full procedural reference

### Sections Implemented (following lifecycle order)
1. **Intake & Research** — When in IDLE, list `.pi-coder/knowledge/`, identify relevant files, delegate to `pi-coder.researcher` with request + knowledge filenames
2. **Context Pruning** — When FSM transitions to PRUNING, extract only AC/constraints/key files/applied knowledge, omit raw code/verbose analysis/tangential findings
3. **Spec Drafting & Approval** — When in DRAFTING_SPEC, compose spec, write to `.pi-coder/specs/`, present via `interview`, refine if rejected
4. **Git Checkpoint** — When in GIT_CHECKPOINT, call `pi_coder_git` for checkout_branch and checkpoint, store ref for reviewer briefing
5. **TDD Cycle — RED Phase** — When in TDD_RED_WRITE, delegate to implementor specifying RED phase, then call `pi_coder_run_tests`, interpret results (fail→GREEN, pass→BLOCKED)
6. **TDD Cycle — GREEN Phase** — When in TDD_GREEN_WRITE, delegate to implementor specifying GREEN phase with git ref, then call `pi_coder_run_tests`, interpret results (pass→REVIEWING, fail→loop back)
7. **Review** — When in REVIEWING, delegate to reviewer with AC + git ref, interpret verdict (Approved/Finals/Request Changes), customize directives when looping back
8. **Final Approval & Merge** — Present final report, handle approval/rejection/rollback, call `pi_coder_git` for merge, cleanup spec file

### All 17 FSM states explicitly referenced
All states from the FSMState type union appear in the document with procedural guidance.

---

## Phase 2: Delegation Templates ✅

### Templates Defined (inside code fences with `{placeholder}` variables)

1. **Researcher Task** — user request + topic-relevant knowledge filenames (from `ls .pi-coder/knowledge/`) + instruction to check those files first + structured report output format
2. **Implementor RED Phase Task** — phase indicator "RED phase — write tests only" + acceptance criteria + constraints + key files + instruction to NOT write implementation code + instruction to check knowledge
3. **Implementor GREEN Phase Task** — phase indicator "GREEN phase — write code to make tests pass" + same AC/constraints/key files + pre-implementation git ref + "Run `git diff {ref}`" instruction + instruction to NOT modify tests without approval + instruction to check knowledge
4. **Reviewer Task** — acceptance criteria + pre-implementation git ref + "Run `git diff {ref}`" instruction + focus areas (test alignment, bugs, security, correctness, API contracts) + skip areas (style, compiler errors, performance, nitpicks)

### Key differences between RED and GREEN templates
- RED: "write tests only, do NOT write implementation code"
- GREEN: "write code to make tests pass, do NOT modify tests without orchestrator approval", includes git ref, includes `git diff` instruction
- RED does not include the git ref — the implementor doesn't need to see what was written before during RED phase
- GREEN includes the git ref — the implementor needs to see the test files to know what to implement

---

## Phase 3: Recovery & Consolidation ✅

### Recovery Procedures

1. **RED_TAUTOLOGY** — Three user options via `interview`:
   - Continue anyway — skip to GREEN for new behavior only
   - Rewrite tests — loop back to RED with instruction to test only new behavior
   - Abort spec — rollback to checkpoint, return to IDLE
   - Explicit instruction: "Do not proceed without user input. The BLOCKED state exists to prevent the harness from making assumptions"

2. **CIRCUIT_BREAKER** — Pause, inform user, present current state (which ACs are failing, last reviewer findings, last implementor output), ask for intervention. Do not automatically loop. Options: refine spec, change constraints, abort spec.

### Knowledge Consolidation

- **Persist these:** Project conventions discovered through trial and error, gotchas the reviewer caught, API patterns not obvious from code, architecture decisions constraining future work
- **Do NOT persist:** Task-specific decisions, temporary workarounds, one-off choices, anything obvious from reading code
- **How to persist:** Call `upsert_knowledge` with descriptive filename, write as actionable directives with specific file paths
- **When to persist:** After spec completes (COMPLETE state), or mid-cycle if reviewer identifies knowledge extraction candidates

---

## Additional Section: Steering Messages

The skill also includes a **Steering Messages** section covering how to handle user messages while subagents are running — interpret and delegate, do not forward directly.

---

## Format Compliance

- Valid YAML frontmatter: `name: pi-coder`, `description: ...` (276 chars, under 1024 limit)
- Name follows rules: lowercase a-z, 0-9, hyphens, 8 chars, under 64 limit
- Written as direct instructions to the orchestrator ("When in state X, do Y"), not documentation about the system
- No source code examples — code fences contain only delegation task templates with `{placeholder}` variables
- Sections ordered to match the TDD lifecycle flow

## File Changed
- `skills/pi-coder/SKILL.md` — replaced placeholder (14,666 bytes)
