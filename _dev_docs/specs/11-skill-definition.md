# Spec 11: Skill Definition

## Context

The SKILL.md is the orchestrator's detailed procedural reference — the "fat prompt" that the LLM loads on-demand when it needs guidance. The system prompt contains the compact identity and FSM diagram (always in context). The skill contains the detailed instructions for what to actually do at each step. Written as direct instructions to the orchestrator, not documentation about the system.

## Dependencies

All prior specs (the skill documents the complete system's procedures)

---

## Phase 1: Lifecycle Procedures

### Acceptance Criteria

- Every FSM state has a clear procedural instruction for what the orchestrator should do
- Instructions are ordered to match the lifecycle flow
- The orchestrator can follow these instructions step-by-step without ambiguity

### Tasks

1. Write procedures for intake and research: when in IDLE and the user makes an implementation request, list `.pi-coder/knowledge/` for relevant files, then delegate to `pi-coder.researcher` with the request and relevant knowledge filenames
2. Write procedures for pruning and spec drafting: when research returns, extract only acceptance criteria, constraints, key files, and applied knowledge — omit raw code, verbose analysis, and tangential findings. Write the pruned spec to `.pi-coder/specs/` and present it to the user for approval via `interview`
3. Write procedures for the TDD cycle: after spec approval, call `pi_coder_git` to checkpoint, then alternate between delegating to `pi-coder.implementor` (specifying RED or GREEN mode in the task) and calling `pi_coder_run_tests` for validation — continue until both phases pass
4. Write procedures for review: delegate to `pi-coder.reviewer` with acceptance criteria and the pre-implementation git ref, interpret the verdict, and loop back or advance accordingly

---

## Phase 2: Delegation Templates

### Acceptance Criteria

- Each agent has a clear task payload format
- Templates include what to include and what NOT to include
- The difference between RED and GREEN payloads for the implementor is explicit

### Tasks

1. Define the researcher task template: user request + topic-relevant knowledge filenames (from `ls .pi-coder/knowledge/`) + instruction to check those knowledge files first
2. Define the implementor RED task template: phase indicator ("RED phase — write tests only") + acceptance criteria + constraints + key files + instruction to NOT write implementation code
3. Define the implementor GREEN task template: phase indicator ("GREEN phase — write code to pass tests") + same acceptance criteria and context + pre-implementation git ref + instruction to run `git diff {ref}` to see the test files + instruction to NOT modify tests without orchestrator approval
4. Define the reviewer task template: acceptance criteria + pre-implementation git ref + instruction to run `git diff {ref}` to see changes + focus areas (test alignment, bugs, security, correctness) + skip areas

---

## Phase 3: Recovery & Consolidation

### Acceptance Criteria

- The BLOCKED state has clear recovery procedures for both anomaly types
- Knowledge consolidation is described with concrete criteria
- The orchestrator knows when to persist learnings and when not to

### Tasks

1. Write recovery procedure for RED_TAUTOLOGY anomaly: tests passed when they should have failed — present the user three options via `interview`: continue anyway (skip to GREEN for new behavior only), rewrite tests (loop back to RED with instruction to test only new behavior), or abort spec (rollback to checkpoint and return to IDLE)
2. Write recovery procedure for CIRCUIT_BREAKER: max review loops reached — pause, inform the user, and ask for intervention — do not automatically loop again
3. Write knowledge consolidation instructions: after a spec completes, review whether the implementor's learnings or reviewer's corrections represent project-wide conventions that future agents should know — persist these via `upsert_knowledge` with descriptive filenames. Do NOT persist task-specific decisions, temporary workarounds, or one-off choices
