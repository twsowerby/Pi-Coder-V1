# Spec 08: Agent Definition Files

## Context

These three `.md` files define the subagent roles that pi-subagents discovers in `.pi/agents/`. They're the "fat prompts" — the system prompts that tell each agent how to behave. Done well, the thin harness barely needs to instruct them beyond the task payload.

## Dependencies

None (prompt engineering, no code dependency). Can be built in parallel with Specs 02-06.

---

## Phase 1: Researcher Agent

### Acceptance Criteria

- Valid YAML frontmatter with correct `package: pi-coder` (produces runtime name `pi-coder.researcher`)
- System prompt instructs the agent to check knowledge files first, then investigate
- Output format is structured and matches what the orchestrator needs for pruning

### Tasks

1. Create `agents/pi-coder-researcher.md` with frontmatter: name `researcher`, package `pi-coder`, description, tools `read, bash, grep, find, ls`, systemPromptMode `replace`, inheritProjectContext `true`, inheritSkills `true`, defaultContext `fresh`
2. Write the system prompt body instructing: always check `.pi-coder/knowledge/` for existing project rules before investigating the codebase, then investigate thoroughly, and return a structured report
3. Define the output format with these sections: Summary (1-3 sentences), Architecture, Key Files (with purpose), Applied Knowledge (rules found), Existing Patterns, Risks & Constraints, Feasibility Assessment, Recommendations

---

## Phase 2: Implementor Agent

### Acceptance Criteria

- Valid frontmatter with correct package for dotted runtime name `pi-coder.implementor`
- System prompt clearly distinguishes RED mode (tests only) from GREEN mode (code only)
- The agent knows not to run git commands and knows to check knowledge files
- Signals that `contact_supervisor` is available for design decisions requiring orchestrator approval

### Tasks

1. Create `agents/pi-coder-implementor.md` with frontmatter: name `implementor`, package `pi-coder`, description, tools `read, bash, edit, write, grep, find, ls`, systemPromptMode `replace`, inheritProjectContext `true`, inheritSkills `true`, defaultContext `fresh`
2. Write the system prompt body that defines two exclusive modes: RED phase (write ONLY tests, no implementation) and GREEN phase (write ONLY code to pass tests, no test modification) — the mode is specified in the task payload
3. Include instructions: check `.pi-coder/knowledge/` before writing code, never run git commands, and note that `contact_supervisor` is available via pi-intercom for decisions requiring orchestrator approval
4. Define the output format: Changes Made, Files Modified/Created, Verification (test/lint results), Learnings & Decisions (why approaches were chosen), Notes (edge cases, follow-ups)

---

## Phase 3: Reviewer Agent

### Acceptance Criteria

- Valid frontmatter with correct package for dotted runtime name `pi-coder.reviewer`
- No `contact_supervisor` — reviewer is independent and adversarial
- Review focus areas and skip areas are explicit
- Output format includes severity levels and knowledge extraction candidates

### Tasks

1. Create `agents/pi-coder-reviewer.md` with frontmatter: name `reviewer`, package `pi-coder`, description, tools `read, bash, grep, find, ls`, systemPromptMode `replace`, inheritProjectContext `false`, defaultContext `fresh`
2. Write the system prompt body that defines review focus areas: test alignment against acceptance criteria (critical), bugs, security, correctness, API contracts — and explicit skip areas: style, readability, compiler errors, performance (unless egregious), nitpicks
3. Define the output format: Verdict (✅/⚠️/❌), Issues Breakdown with severity (🔴 High / 🟠 Medium / 🟡 Low per issue, each with file path, problem, suggested fix), Knowledge Extraction Candidates (mistakes worth persisting to knowledge), Approved Aspects (what's solid)
