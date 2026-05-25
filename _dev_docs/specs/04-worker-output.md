# Spec 04: Git Abstraction — Worker Output

## Status: ✅ COMPLETE

All 4 phases implemented and verified. 30 tests passing.

---

## Phase 1: Execution Layer ✅

### Files Created
- `src/git.ts` — `GitOperations` class with `execGit()` private method
- `src/git.test.ts` — Phase 1 tests

### Key Decisions
- `GitOperations` constructor takes `(PiCoderConfig, ExecFn)` where `ExecFn` is the `pi.exec` signature — this allows easy mocking in tests and avoids a hard dependency on pi at test time
- `execGit(args)` is the single execution chokepoint — all public methods delegate through it
- Failed git commands return `{ success: false, error }` rather than throwing — the FSM layer handles errors by result shape
- Args are always passed as arrays to `pi.exec("git", args)`, never string-interpolated

### Acceptance Criteria Met
- ✅ All git commands execute via `pi.exec("git", argsArray)` with array args
- ✅ Failed commands return structured `GitCheckpointResult` with `success: false`
- ✅ Every operation returns `GitCheckpointResult` with consistent shape

---

## Phase 2: Branch Operations ✅

### Implementation
- `checkoutBranch(branch, baseBranch?)` prepends `config.branchPrefix` automatically
- Branch name validation: lowercase alphanumeric + hyphens + forward slashes, must start with letter/digit
- If `baseBranch` is provided, it's passed as the fourth arg to `git checkout -b`
- Returns full branch name and commit SHA on success

### Acceptance Criteria Met
- ✅ New branches are always prefixed with `branchPrefix`
- ✅ Invalid branch names are rejected before any git command runs
- ✅ Base branch can be specified or omitted (uses current HEAD)

---

## Phase 3: Checkpoint & Rollback ✅

### Implementation
- `checkpoint(message)` runs `git add -A` then `git commit --allow-empty -m {message}`
- Commit SHA is extracted from git's output format (`[branch abc1234] message`) via regex
- `rollback(ref)` runs `git reset --hard {ref}` and logs a `console.warn` before executing
- `getCurrentRef()` uses `git rev-parse --short HEAD`
- `hasUncommittedChanges()` uses `git status --porcelain` (empty output = clean tree)

### Acceptance Criteria Met
- ✅ Checkpoints capture all staged and unstaged changes
- ✅ Empty checkpoints are allowed via `--allow-empty`
- ✅ Rollback is destructive and logs a warning before executing
- ✅ `getCurrentRef()` returns short-form SHA
- ✅ `hasUncommittedChanges()` returns boolean

---

## Phase 4: Merge & Strategy ✅

### Implementation
- `merge(branch, targetBranch?)` checks out target, merges feature branch
- Target branch auto-detected via `git rev-parse --abbrev-ref origin/HEAD`, falling back to checking if `main`/`master` exists, then defaulting to `main`
- When `config.gitStrategy === "squash"`, uses `git merge --squash` followed by a separate commit
- `getCurrentBranch()` uses `git rev-parse --abbrev-ref HEAD`

### Acceptance Criteria Met
- ✅ Merge supports both normal and squash strategies based on config
- ✅ Target branch is auto-detected when not specified
- ✅ Result includes merge commit SHA and target branch name

---

## Test Results

**30 tests across 4 phases, 0 failures.**

```
Phase 1: Execution Layer — 4 tests ✔
Phase 2: Branch Operations — 8 tests ✔
Phase 3: Checkpoint & Rollback — 9 tests ✔
Phase 4: Merge & Strategy — 8 tests ✔ (includes error tests)
Phase 4: Error handling — 1 test ✔
```

## Files Changed
- `src/git.ts` — new file (218 lines)
- `src/git.test.ts` — new file (421 lines)

## Risks & Notes
- The mock-based test strategy uses key-matching that may need adaptation if git args change format
- `detectDefaultBranch()` makes 1-3 git calls to find the default branch — could be cached for repeated merge operations in the same session
- `hasUncommittedChanges()` returns `false` if `git status --porcelain` fails (safer default assumption)
