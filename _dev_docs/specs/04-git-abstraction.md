# Spec 04: Git Abstraction

## Context

All git operations in pi-coder go through this module. Raw `git` CLI access is blocked for the orchestrator and for subagents. This module provides a safe, structured API that operates via `pi.exec("git", [...])` with arguments passed as arrays (never string-interpolated) to prevent injection.

## Dependencies

Spec 01 (type definitions — GitCheckpointResult, PiCoderConfig)

---

## Phase 1: Execution Layer

### Acceptance Criteria

- All git commands are executed via `pi.exec("git", argsArray)` — never via bash or string interpolation
- Failed git commands return structured error results rather than throwing
- Every operation returns `GitCheckpointResult` with consistent shape

### Tasks

1. Create a `GitOperations` class that accepts `PiCoderConfig` and holds a reference to `pi.exec`
2. Implement a private `execGit(args)` method that calls `pi.exec("git", args)`, captures stdout/stderr, and returns a `GitCheckpointResult` — `{ success: true, ref, branch, message }` on exit code 0, or `{ success: false, error }` on non-zero exit
3. Ensure all public methods delegate to `execGit` and never construct commands via string concatenation

---

## Phase 2: Branch Operations

### Acceptance Criteria

- New branches are always prefixed with the configured `branchPrefix`
- Invalid branch names are rejected before any git command runs
- Base branch is auto-detected when not specified

### Tasks

1. Implement `checkoutBranch(branch, baseBranch?)` that creates and checks out a new branch — prepends `config.branchPrefix` to the branch name, creates from `baseBranch` if specified, otherwise from current HEAD
2. Implement branch name validation: must consist only of lowercase alphanumeric, hyphens, and forward slashes, and must start with the configured prefix when created through this method
3. Return the new branch name and current commit SHA on success

---

## Phase 3: Checkpoint & Rollback

### Acceptance Criteria

- Checkpoints capture all staged and unstaged changes
- Empty checkpoints are allowed (pre-implementation checkpoint may have no changes)
- Rollback is destructive and clearly logged

### Tasks

1. Implement `checkpoint(message)` that stages all changes (`git add -A`) and commits with the provided message, using `--allow-empty` to permit checkpoints with no file changes — returns the commit SHA
2. Implement `rollback(ref)` that performs `git reset --hard {ref}` to the given commit — this is destructive so log a warning before executing, and return the new HEAD SHA
3. Add `getCurrentRef()` that returns the short-form HEAD SHA and `hasUncommittedChanges()` that returns a boolean based on working tree status

---

## Phase 4: Merge & Strategy

### Acceptance Criteria

- Merge supports both normal and squash strategies based on config
- The target branch is auto-detected when not specified
- After merge, the result includes the merge commit SHA

### Tasks

1. Implement `merge(branch, targetBranch?)` that checks out the target branch (default: auto-detect main/master), then merges the feature branch — if `config.gitStrategy === "squash"`, use squash merge
2. Return the merge commit SHA and target branch name on success
3. Implement `getCurrentBranch()` that returns the current branch name
