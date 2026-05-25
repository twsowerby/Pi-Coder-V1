# Spec 01: Worker Output

## Status: ✅ COMPLETE

All 4 phases implemented and verified.

---

## Phase 1: Package Setup ✅

### Files Created
- `package.json` — valid pi-package with `keywords: ["pi-package"]`, peer deps on `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `typebox`, and `pi` manifest declaring `extensions` + `skills`
- `tsconfig.json` — strict mode, Node16 module resolution, ES2022 target, covers `src/` and `extensions/`
- Directory structure: `src/`, `extensions/`, `agents/`, `skills/pi-coder/`

### Verification
- `npm install` ✅ (0 errors)
- `npx tsc --noEmit` ✅ (0 errors)

---

## Phase 2: FSM & State Types ✅

### Types Defined (src/types.ts)
- `FSMState` — union of 17 literal strings (IDLE, RESEARCHING, PRUNING, DRAFTING_SPEC, SPEC_APPROVED, GIT_CHECKPOINT, TDD_RED_WRITE, TDD_RED_VALIDATE, TDD_GREEN_WRITE, TDD_GREEN_VALIDATE, REVIEWING, APPROVED, NEEDS_CHANGES, FINAL_APPROVAL, MERGING, COMPLETE, BLOCKED)
- `FSMTransition` — `{ from: FSMState; to: FSMState; event: string }`
- `PiCoderConfig` — testCommand, maxLoops, gitStrategy, branchPrefix, nudge
- `NudgeConfig` — enabled, defaults (turnsBeforeNudge, escalationLevels), per-state overrides
- `NudgeDefaults` — turnsBeforeNudge, escalationLevels
- `NudgeStateConfig` — enabled?, turnsBeforeNudge? (partial override)

### Tests (6 tests)
- FSMState has all 17 values and all are non-empty strings
- FSMTransition defines from/to/event and serializes to JSON
- PiCoderConfig has well-formed defaults, round-trips JSON, supports squash strategy
- Nudge config supports disabled states and per-state threshold overrides

---

## Phase 3: Domain Value Types ✅

### Types Defined (src/types.ts)
- `TestRunResult` — exitCode, output, passed, failed, timedOut (all JSON-serializable, passed/failed nullable)
- `GitCheckpointResult` — success, ref?, branch?, message?, error?
- `SpecFile` — id, title, acceptanceCriteria, constraints, keyFiles, prunedContext, status
- `KnowledgeEntry` — filename, content

### Tests (10 tests)
- TestRunResult: success, failure, timeout with null counts, JSON round-trip
- GitCheckpointResult: success with ref/branch, failure with error, JSON round-trip
- SpecFile: complete spec, JSON round-trip
- KnowledgeEntry: basic construction, JSON round-trip

---

## Phase 4: Verification ✅

- Dummy import file successfully compiled referencing all exported types → deleted
- Monolithic `specs.md` was already removed from `_dev_docs/`
- Placeholder files created for directories that need content for pi manifest to work:
  - `extensions/index.ts` (placeholder)
  - `agents/pi-coder-*.md` (3 placeholders)
  - `skills/pi-coder/SKILL.md` (placeholder)

---

## Test Results Summary

```
24 tests, 9 suites, 0 failures
```

## All Acceptance Criteria Met

| Criterion | Status |
|---|---|
| `npm install` completes without errors | ✅ |
| pi recognizes package as valid pi-package (keywords: ["pi-package"]) | ✅ |
| TypeScript compiles with strict mode enabled | ✅ |
| All 17 FSM state names defined in FSMState union | ✅ |
| FSMTransition pairs source, target, and event | ✅ |
| PiCoderConfig matches .pi-coder/config.json schema | ✅ |
| NudgeConfig with enabled, defaults, per-state overrides | ✅ |
| TestRunResult, GitCheckpointResult, SpecFile, KnowledgeEntry all defined | ✅ |
| All types are serializable to plain JSON | ✅ |
| Types are importable from src/types.ts | ✅ |
