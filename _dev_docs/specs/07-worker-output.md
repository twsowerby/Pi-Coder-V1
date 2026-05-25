# Spec 07: Worker Output

## Status: ✅ COMPLETE

All 4 phases implemented and verified. 29 tool-specific tests passing (305 total across all specs).

---

## Phase 1: Tool Registration Framework ✅

### Implementation (`src/tools.ts`)

- `registerTools(pi, deps)` function accepts `ExtensionAPI` and `ToolDependencies` (stateMachine, gitOps, tddRunner, knowledgeStore, config)
- Registers three tools: `pi_coder_git`, `pi_coder_run_tests`, `upsert_knowledge`
- Each tool has `promptSnippet` (one-line description for system prompt inclusion)
- Each tool has `promptGuidelines` (2-3 bullet usage rules)
- Each tool has TypeBox parameter schemas

### Tests (5)
- All three tools registered
- Each tool has non-empty promptSnippet
- Each tool has 2-4 promptGuidelines
- Each tool has label and description
- Each tool has parameter schemas

---

## Phase 2: Git Tool ✅

### Implementation

- Register `pi_coder_git` with action enum (checkout_branch, checkpoint, rollback, merge), optional branch, optional message
- FSM state validation: blocks when stateMachine.isActionAllowed("pi_coder_git") returns false
- checkout_branch: delegates to gitOps.checkoutBranch(branch)
- checkpoint: delegates to gitOps.checkpoint(message), stores returned ref via stateMachine.setActiveSpec()
- rollback: reads stateMachine.gitRef, delegates to gitOps.rollback(ref), transitions FSM to IDLE on success
- merge: reads current branch via gitOps.getCurrentBranch(), delegates to gitOps.merge(branch)
- Failed git operations return structured errors (isError: true) with GitCheckpointResult in details

### Tests (11)
- Blocks when FSM state doesn't allow it
- Allows in GIT_CHECKPOINT state
- checkout_branch delegates to gitOps
- checkout_branch requires branch parameter
- checkpoint stores ref in state machine
- checkpoint uses default message
- rollback transitions FSM to IDLE
- rollback fails when no git ref stored
- merge calls gitOps.merge
- Failed git operations return structured error
- Returns GitCheckpointResult in details

---

## Phase 3: Test Tool ✅

### Implementation

- Register `pi_coder_run_tests` with optional command override, optional filter
- FSM state validation: only allowed in TDD_RED_VALIDATE and TDD_GREEN_VALIDATE
- Delegates to tddRunner.runTests(filter)
- Calls validateRedPhase() or validateGreenPhase() based on current FSM state
- Returns both raw TestRunResult and validation verdict ({valid, reason})
- Does NOT auto-transition the FSM (that's the extension tool_result handler's job)

### Tests (9)
- Blocks when not in RED_VALIDATE or GREEN_VALIDATE
- Allows in TDD_RED_VALIDATE state
- Allows in TDD_GREEN_VALIDATE state
- Delegates to tddRunner.runTests with filter
- Calls validateRedPhase in RED_VALIDATE state
- Calls validateGreenPhase in GREEN_VALIDATE state
- Returns both test result and validation verdict
- Returns isError true when validation fails
- Does NOT auto-transition the FSM

---

## Phase 4: Knowledge Tool ✅

### Implementation

- Register `upsert_knowledge` with filename (string) and content (string)
- No FSM state validation — knowledge can be updated in any state
- Delegates to knowledgeStore.upsert(filename, content)
- Returns {success: true, path} or {success: false, error} with isError flag
- Invalid filenames caught from knowledgeStore validation and returned as structured errors

### Tests (4)
- Succeeds and writes file
- Returns success and path on success
- Works in any FSM state (tested in TDD_RED_VALIDATE)
- Rejects invalid filenames with clear error

---

## Files Changed

- `src/tools.ts` — new file (~290 LOC): tool registration + execute implementations
- `src/tools.test.ts` — new file (~390 LOC): 29 tests across 4 phases

## Additional Changes

- Added `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, and `typebox` as devDependencies (needed for ExtensionAPI type, Type, and StringEnum)
- Updated `tsconfig.json`: set `noEmit: true`, `allowImportingTsExtensions: true`, `declarationMap: false` — required because tools.ts uses value imports from .ts files, which tsc can only resolve with allowImportingTsExtensions (which requires noEmit)

## Verification

- `npx tsc --noEmit` — ✅ zero errors
- `node --experimental-strip-types --test 'src/**/*.test.ts'` — ✅ 305 tests, 0 failures

## Risks & Notes

1. **tsconfig changes**: Setting `noEmit: true` means `tsc` is now purely a type checker, not a compiler. Since runtime uses `--experimental-strip-types` (not compiled output), this is fine. But if downstream tooling expected `tsc` to produce output, this would need reverting.
2. **Tool execute types**: The execute callback parameters are typed loosely in tests (as `unknown`) because the pi `ExtensionAPI` type requires the full pi runtime context. In production, pi provides these correctly.
3. **pi_coder_git.merge**: Reads current branch from gitOps.getCurrentBranch() then passes it to merge(). This means two git calls per merge. Could be optimized later.
