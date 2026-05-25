# Spec 08: Worker Output

## Status: ✅ COMPLETE

All 3 phases implemented and verified.

---

## Phase 1: Researcher Agent ✅

### File
- `agents/pi-coder-researcher.md`

### Frontmatter
- name: `researcher`
- package: `pi-coder` (runtime name: `pi-coder.researcher`)
- tools: `read, bash, grep, find, ls`
- systemPromptMode: `replace`
- inheritProjectContext: `true`
- inheritSkills: `true`
- defaultContext: `fresh`

### System Prompt Highlights
- Knowledge-first: instructed to check `.pi-coder/knowledge/` before investigating codebase
- Structured investigation approach: knowledge → locate → read → identify patterns → check for existing features → assess dependencies
- Output format with all required sections: Summary, Architecture, Key Files, Applied Knowledge, Existing Patterns, Risks & Constraints, Feasibility Assessment, Recommendations

---

## Phase 2: Implementor Agent ✅

### File
- `agents/pi-coder-implementor.md`

### Frontmatter
- name: `implementor`
- package: `pi-coder` (runtime name: `pi-coder.implementor`)
- tools: `read, bash, edit, write, grep, find, ls`
- systemPromptMode: `replace`
- inheritProjectContext: `true`
- inheritSkills: `true`
- defaultContext: `fresh`

### System Prompt Highlights
- Two exclusive modes clearly defined: RED (tests only, no implementation) and GREEN (implementation only, no test modification)
- Knowledge-first: check `.pi-coder/knowledge/` before writing code
- Never run git commands — harness manages Git
- `contact_supervisor` available for design decisions requiring orchestrator approval (via pi-intercom bridge)
- Rules section reinforces mode boundaries and pattern-following
- Output format: Changes Made, Files Modified/Created, Verification, Learnings & Decisions, Notes

---

## Phase 3: Reviewer Agent ✅

### File
- `agents/pi-coder-reviewer.md`

### Frontmatter
- name: `reviewer`
- package: `pi-coder` (runtime name: `pi-coder.reviewer`)
- tools: `read, bash, grep, find, ls`
- systemPromptMode: `replace`
- inheritProjectContext: `false`
- defaultContext: `fresh`

### System Prompt Highlights
- Independent, adversarial role — explicitly no `contact_supervisor` access
- Review focus areas (ordered by importance): Test Alignment (critical), Potential Bugs, Security, Correctness, API Contracts
- Explicit skip areas: Style, compiler errors, performance (unless egregious), nitpicks
- Verdict format: ✅ Approved / ⚠️ Needs Changes / ❌ Request Changes
- Issues with severity levels: 🔴 High / 🟠 Medium / 🟡 Low (each with file, problem, suggested fix)
- Knowledge Extraction Candidates: mistakes worth persisting to `.pi-coder/knowledge/`
- Approved Aspects: what's solid

---

## Validation

- All three files have valid YAML frontmatter (extracted and parsed programmatically)
- All three dotted runtime names resolve correctly: `pi-coder.researcher`, `pi-coder.implementor`, `pi-coder.reviewer`
- All output format sections present in all three files
- All spec acceptance criteria verified ✅

## Key Design Decisions

1. **Researcher** — Started with knowledge-first as a standalone section with numbered steps, not just a mention. This makes it unambiguous that knowledge comes before codebase investigation.
2. **Implementor** — RED/GREEN modes defined as separate headed sections with explicit boundaries. Added a "Rules You Must Follow" section to reinforce the highest-stakes constraints (no git, no mode switching, no test modification in GREEN).
3. **Reviewer** — Explicitly stated "you do not have access to contact_supervisor" to prevent the reviewer from attempting escalation. Added "Your Independence" section to reinforce adversarial stance without being hostile.
