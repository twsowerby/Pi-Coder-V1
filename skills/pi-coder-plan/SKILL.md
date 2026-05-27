---
name: pi-coder-plan
description: Plan mode investigation — research, discussion, and when to switch to Light or TDD mode. Load this skill ONLY when in Plan mode.
---

# Pi Coder — Plan Mode Procedures

This skill contains procedures specific to Plan mode. For shared procedures (delegation templates, knowledge consolidation), load `pi-coder-core`.

## Plan Mode Investigation

In Plan mode, you investigate, discuss, and plan — but do NOT implement. There is no FSM, no spec workflow, no git, and no tests. You can only delegate to `pi-coder.researcher`.

**How to work in Plan mode:**

1. **Investigate** — Delegate to `pi-coder.researcher` to explore the codebase, understand patterns, and answer questions
2. **Discuss** — Present findings to the user and discuss tradeoffs and approaches
3. **Gather requirements** — Use `interview` for structured requirements gathering
4. **Persist findings** — Use `upsert_knowledge` to save cross-cutting gotchas for later Light/TDD sessions
5. **Move to implementation** — When ready to act, suggest switching to Light or TDD mode with `/pi-coder`

**Available tools in Plan mode:** `ls`, `find`, `grep`, `subagent`, `upsert_knowledge`, `interview`, `intercom`

**Not available in Plan mode:** `pi_coder_git`, `pi_coder_run_tests`, `pi_coder_save_spec`, `pi_coder_read_spec`, `pi_coder_advance_fsm` (these require Light or TDD mode)

## When to Stay in Plan vs. Switch to Light/TDD

**Stay in Plan mode when:**
- You're still understanding the problem space
- Architecture decisions are unresolved
- Requirements are ambiguous and need discussion
- You need to evaluate multiple approaches before committing

**Switch to Light mode when:**
- Requirements are clear enough to implement
- The task doesn't need test-first discipline
- You want a faster iteration cycle

**Switch to TDD mode when:**
- The task is complex enough to need test-first discipline
- Reliability and correctness are critical
- The implementation involves multiple interdependent units

When you're ready to move to implementation, tell the user: "Implementation requires Light or TDD mode. Use /pi-coder to switch."

## What You Cannot Do in Plan Mode

- You cannot edit files, create files, or modify the codebase
- You cannot run tests
- You cannot create git commits or branches
- You cannot save or read specs
- You cannot advance an FSM state machine

If the user asks to implement something, direct them to switch modes.
