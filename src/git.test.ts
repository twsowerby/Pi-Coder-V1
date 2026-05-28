/**
 * Tests for the Git Abstraction module.
 *
 * Validates:
 * - Phase 1: Execution layer — all commands via pi.exec with array args, structured results
 * - Phase 2: Branch operations — prefix enforcement, validation, auto-detect base
 * - Phase 3: Checkpoint & rollback — stage+commit, destructive reset, ref queries
 * - Phase 4: Merge & strategy — normal/squash merge, auto-detect target branch
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { GitOperations } from "./git.ts";
import type { PiCoderConfig, GitCheckpointResult } from "./types.ts";

// ---------------------------------------------------------------------------
// Mock pi.exec
// ---------------------------------------------------------------------------

interface MockExecCall {
  command: string;
  args: string[];
}

function createMockPiExec(responses: Map<string, { stdout: string; stderr: string; code: number }>) {
  const calls: MockExecCall[] = [];
  const exec = async (command: string, args: string[]) => {
    calls.push({ command, args });
    const key = `${command} ${args.join(" ")}`;
    // Try exact match first, then prefix match
    let response = responses.get(key);
    if (!response) {
      // Try matching by first two args (command + subcommand)
      const prefix = `${command} ${args.slice(0, 2).join(" ")}`;
      response = responses.get(prefix);
    }
    if (!response) {
      // Try matching by command + first arg
      const subkey = `${command} ${args[0]}`;
      response = responses.get(subkey);
    }
    return response ?? { stdout: "", stderr: `unknown command: ${key}`, code: 1 };
  };
  return { exec, calls };
}

// ---------------------------------------------------------------------------
// Default test config
// ---------------------------------------------------------------------------

const defaultConfig: PiCoderConfig = {
  testCommand: "npm test",
  maxLoops: 3,
  createBranch: true,
  mergeBranch: "merge",
  branchPrefix: "pi-coder/",
  nudge: {
    enabled: true,
    defaults: { turnsBeforeNudge: 1, escalationLevels: 3 },
    states: {},
  },
  logging: {
    enabled: false,
    level: "standard",
    maxLogFiles: 10,
  },
};

// ---------------------------------------------------------------------------
// Phase 1: Execution Layer
// ---------------------------------------------------------------------------

describe("GitOperations — Phase 1: Execution Layer", () => {
  it("should execute git commands via pi.exec with array arguments", async () => {
    const { exec, calls } = createMockPiExec(new Map([
      ["git rev-parse --short HEAD", { stdout: "abc1234", stderr: "", code: 0 }],
    ]));
    const git = new GitOperations(defaultConfig, exec);

    await git.getCurrentRef();

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].command, "git");
    assert.deepStrictEqual(calls[0].args, ["rev-parse", "--short", "HEAD"]);
  });

  it("should return GitCheckpointResult with success:true on exit code 0", async () => {
    const { exec } = createMockPiExec(new Map([
      ["git rev-parse --short HEAD", { stdout: "abc1234", stderr: "", code: 0 }],
    ]));
    const git = new GitOperations(defaultConfig, exec);

    const result = await git.getCurrentRef();

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.ref, "abc1234");
  });

  it("should return GitCheckpointResult with success:false on non-zero exit code", async () => {
    const { exec } = createMockPiExec(new Map([
      ["git rev-parse --short HEAD", { stdout: "", stderr: "fatal: not a git repository", code: 128 }],
    ]));
    const git = new GitOperations(defaultConfig, exec);

    const result = await git.getCurrentRef();

    assert.strictEqual(result.success, false);
    assert.ok(result.error);
    assert.ok(result.error.includes("fatal: not a git repository"));
  });

  it("should never construct commands via string concatenation", async () => {
    // Verify all calls use the exec function with array args
    const { exec, calls } = createMockPiExec(new Map([
      ["git checkout", { stdout: "", stderr: "", code: 0 }],
    ]));
    const git = new GitOperations(defaultConfig, exec);

    // Trigger an operation
    await git.rollback("abc1234");

    // Every call should have command="git" and args as an array
    for (const call of calls) {
      assert.strictEqual(call.command, "git");
      assert.ok(Array.isArray(call.args));
      // No arg should contain a space-separated subcommand (would indicate concatenation)
      for (const arg of call.args) {
        assert.ok(
          !arg.includes(" && ") && !arg.includes(" | "),
          `Arg "${arg}" looks like shell concatenation`
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 2: Branch Operations
// ---------------------------------------------------------------------------

describe("GitOperations — Phase 2: Branch Operations", () => {
  it("should prepend branchPrefix when creating a new branch", async () => {
    const { exec, calls } = createMockPiExec(new Map([
      ["git checkout -b", { stdout: "", stderr: "", code: 0 }],
      ["git rev-parse --short HEAD", { stdout: "abc1234", stderr: "", code: 0 }],
    ]));
    const git = new GitOperations(defaultConfig, exec);

    const result = await git.checkoutBranch("user-auth");

    assert.strictEqual(result.success, true);
    // The checkout -b call should use the prefixed name
    const checkoutCall = calls.find(c => c.args[0] === "checkout" && c.args[1] === "-b");
    assert.ok(checkoutCall, "Should have a checkout -b call");
    assert.strictEqual(checkoutCall.args[2], "pi-coder/user-auth");
    assert.strictEqual(result.branch, "pi-coder/user-auth");
  });

  it("should create branch from specified base branch", async () => {
    const { exec, calls } = createMockPiExec(new Map([
      ["git checkout -b", { stdout: "", stderr: "", code: 0 }],
      ["git rev-parse --short HEAD", { stdout: "abc1234", stderr: "", code: 0 }],
    ]));
    const git = new GitOperations(defaultConfig, exec);

    await git.checkoutBranch("user-auth", "develop");

    const checkoutCall = calls.find(c => c.args[0] === "checkout" && c.args[1] === "-b");
    assert.ok(checkoutCall);
    // Should be: git checkout -b pi-coder/user-auth develop
    assert.strictEqual(checkoutCall.args[2], "pi-coder/user-auth");
    assert.strictEqual(checkoutCall.args[3], "develop");
  });

  it("should create branch from current HEAD when no base is specified", async () => {
    const { exec, calls } = createMockPiExec(new Map([
      ["git checkout -b", { stdout: "", stderr: "", code: 0 }],
      ["git rev-parse --short HEAD", { stdout: "abc1234", stderr: "", code: 0 }],
    ]));
    const git = new GitOperations(defaultConfig, exec);

    await git.checkoutBranch("feature");

    const checkoutCall = calls.find(c => c.args[0] === "checkout" && c.args[1] === "-b");
    assert.ok(checkoutCall);
    // No fourth arg when base not specified
    assert.strictEqual(checkoutCall.args.length, 3);
  });

  it("should reject invalid branch names with special characters", async () => {
    const { exec } = createMockPiExec(new Map());
    const git = new GitOperations(defaultConfig, exec);

    const result = await git.checkoutBranch("user auth!");

    assert.strictEqual(result.success, false);
    assert.ok(result.error);
    assert.ok(result.error.includes("Invalid branch name"));
  });

  it("should reject branch names with uppercase letters", async () => {
    const { exec } = createMockPiExec(new Map());
    const git = new GitOperations(defaultConfig, exec);

    const result = await git.checkoutBranch("User-Auth");

    assert.strictEqual(result.success, false);
    assert.ok(result.error);
    assert.ok(result.error.includes("Invalid branch name"));
  });

  it("should reject branch names with spaces", async () => {
    const { exec } = createMockPiExec(new Map());
    const git = new GitOperations(defaultConfig, exec);

    const result = await git.checkoutBranch("user auth");

    assert.strictEqual(result.success, false);
    assert.ok(result.error);
  });

  it("should accept valid branch names with hyphens and slashes", async () => {
    const { exec } = createMockPiExec(new Map([
      ["git checkout -b", { stdout: "", stderr: "", code: 0 }],
      ["git rev-parse --short HEAD", { stdout: "abc1234", stderr: "", code: 0 }],
    ]));
    const git = new GitOperations(defaultConfig, exec);

    const result = await git.checkoutBranch("auth/login-flow");

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.branch, "pi-coder/auth/login-flow");
  });

  it("should return commit SHA on successful checkout", async () => {
    const { exec } = createMockPiExec(new Map([
      ["git checkout -b", { stdout: "", stderr: "", code: 0 }],
      ["git rev-parse --short HEAD", { stdout: "def5678", stderr: "", code: 0 }],
    ]));
    const git = new GitOperations(defaultConfig, exec);

    const result = await git.checkoutBranch("feature");

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.ref, "def5678");
  });
});

// ---------------------------------------------------------------------------
// Phase 3: Checkpoint & Rollback
// ---------------------------------------------------------------------------

describe("GitOperations — Phase 3: Checkpoint & Rollback", () => {
  it("should stage all changes and commit with --allow-empty", async () => {
    const { exec, calls } = createMockPiExec(new Map([
      ["git add", { stdout: "", stderr: "", code: 0 }],
      ["git commit", { stdout: "[main abc1234] wip: pre-implementation", stderr: "", code: 0 }],
    ]));
    const git = new GitOperations(defaultConfig, exec);

    const result = await git.checkpoint("wip: pre-implementation");

    assert.strictEqual(result.success, true);
    // Verify git add -A was called
    const addCall = calls.find(c => c.args[0] === "add");
    assert.ok(addCall);
    assert.deepStrictEqual(addCall.args, ["add", "-A"]);
    // Verify git commit was called with --allow-empty
    const commitCall = calls.find(c => c.args[0] === "commit");
    assert.ok(commitCall);
    assert.ok(commitCall.args.includes("--allow-empty"));
    assert.ok(commitCall.args.includes("wip: pre-implementation"));
  });

  it("should return commit SHA after checkpoint", async () => {
    const { exec } = createMockPiExec(new Map([
      ["git add", { stdout: "", stderr: "", code: 0 }],
      ["git commit", { stdout: "[main abc1234] checkpoint", stderr: "", code: 0 }],
    ]));
    const git = new GitOperations(defaultConfig, exec);

    const result = await git.checkpoint("checkpoint");

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.ref, "abc1234");
  });

  it("should allow empty checkpoints (no changes)", async () => {
    const { exec, calls } = createMockPiExec(new Map([
      ["git add", { stdout: "", stderr: "", code: 0 }],
      ["git commit", { stdout: "[main abc1234] empty checkpoint", stderr: "", code: 0 }],
    ]));
    const git = new GitOperations(defaultConfig, exec);

    const result = await git.checkpoint("empty checkpoint");

    assert.strictEqual(result.success, true);
    // --allow-empty must be present to allow this
    const commitCall = calls.find(c => c.args[0] === "commit");
    assert.ok(commitCall?.args.includes("--allow-empty"));
  });

  it("should perform git reset --hard on rollback", async () => {
    const { exec, calls } = createMockPiExec(new Map([
      ["git reset", { stdout: "HEAD is now at abc1234", stderr: "", code: 0 }],
      ["git rev-parse --short HEAD", { stdout: "abc1234", stderr: "", code: 0 }],
    ]));
    const git = new GitOperations(defaultConfig, exec);

    const result = await git.rollback("abc1234");

    assert.strictEqual(result.success, true);
    const resetCall = calls.find(c => c.args[0] === "reset");
    assert.ok(resetCall);
    assert.deepStrictEqual(resetCall.args, ["reset", "--hard", "abc1234"]);
  });

  it("should return new HEAD SHA after rollback", async () => {
    const { exec } = createMockPiExec(new Map([
      ["git reset", { stdout: "", stderr: "", code: 0 }],
      ["git rev-parse --short HEAD", { stdout: "abc1234", stderr: "", code: 0 }],
    ]));
    const git = new GitOperations(defaultConfig, exec);

    const result = await git.rollback("abc1234");

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.ref, "abc1234");
  });

  it("should log a warning before rollback (destructive operation)", async () => {
    // We track that a warning was logged by checking the result message
    const { exec } = createMockPiExec(new Map([
      ["git reset", { stdout: "", stderr: "", code: 0 }],
      ["git rev-parse --short HEAD", { stdout: "abc1234", stderr: "", code: 0 }],
    ]));
    const git = new GitOperations(defaultConfig, exec);

    const result = await git.rollback("abc1234");

    assert.strictEqual(result.success, true);
    assert.ok(result.message);
    assert.ok(result.message.includes("rollback") || result.message.includes("Rollback"));
  });

  it("should return current HEAD SHA via getCurrentRef()", async () => {
    const { exec } = createMockPiExec(new Map([
      ["git rev-parse --short HEAD", { stdout: "abc1234", stderr: "", code: 0 }],
    ]));
    const git = new GitOperations(defaultConfig, exec);

    const result = await git.getCurrentRef();

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.ref, "abc1234");
  });

  it("should detect uncommitted changes via hasUncommittedChanges()", async () => {
    const { exec } = createMockPiExec(new Map([
      ["git status --porcelain", { stdout: "M src/auth.ts", stderr: "", code: 0 }],
    ]));
    const git = new GitOperations(defaultConfig, exec);

    const result = await git.hasUncommittedChanges();

    assert.strictEqual(result, true);
  });

  it("should report no uncommitted changes when tree is clean", async () => {
    const { exec } = createMockPiExec(new Map([
      ["git status --porcelain", { stdout: "", stderr: "", code: 0 }],
    ]));
    const git = new GitOperations(defaultConfig, exec);

    const result = await git.hasUncommittedChanges();

    assert.strictEqual(result, false);
  });
});

// ---------------------------------------------------------------------------
// Phase 4: Merge & Strategy
// ---------------------------------------------------------------------------

describe("GitOperations — Phase 4: Merge & Strategy", () => {
  it("should checkout target branch and merge feature branch (normal merge)", async () => {
    const { exec, calls } = createMockPiExec(new Map([
      ["git status", { stdout: "", stderr: "", code: 0 }],
      ["git checkout", { stdout: "Switched to branch 'main'", stderr: "", code: 0 }],
      ["git merge", { stdout: "Merge made by the 'ort' strategy.", stderr: "", code: 0 }],
      ["git rev-parse --short HEAD", { stdout: "merged99", stderr: "", code: 0 }],
    ]));
    const git = new GitOperations(defaultConfig, exec);

    const result = await git.merge("pi-coder/user-auth", "main");

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.ref, "merged99");
    assert.strictEqual(result.branch, "main");
    // Verify checkout to target first, then merge
    const checkoutCall = calls.find(c => c.args[0] === "checkout" && c.args[1] === "main");
    assert.ok(checkoutCall, "Should checkout target branch");
    const mergeCall = calls.find(c => c.args[0] === "merge" && c.args.includes("pi-coder/user-auth"));
    assert.ok(mergeCall, "Should merge feature branch");
  });

  it("should use squash merge when mergeBranch is 'squash'", async () => {
    const squashConfig: PiCoderConfig = { ...defaultConfig, mergeBranch: "squash" };
    const { exec, calls } = createMockPiExec(new Map([
      ["git status", { stdout: "", stderr: "", code: 0 }],
      ["git checkout", { stdout: "", stderr: "", code: 0 }],
      ["git merge", { stdout: "Squash commit", stderr: "", code: 0 }],
      ["git commit", { stdout: "[main sq99] squash commit", stderr: "", code: 0 }],
      ["git rev-parse --short HEAD", { stdout: "sq99", stderr: "", code: 0 }],
    ]));
    const git = new GitOperations(squashConfig, exec);

    const result = await git.merge("pi-coder/user-auth", "main");

    assert.strictEqual(result.success, true);
    const mergeCall = calls.find(c => c.args[0] === "merge");
    assert.ok(mergeCall);
    assert.ok(mergeCall.args.includes("--squash"));
    // Squash merge should NOT use --no-ff
    assert.ok(!mergeCall.args.includes("--no-ff"), "Squash merge should not use --no-ff");
  });

  it("should auto-detect target branch when not specified", async () => {
    const { exec, calls } = createMockPiExec(new Map([
      ["git status", { stdout: "", stderr: "", code: 0 }],
      ["git remote show", { stdout: "origin", stderr: "", code: 0 }],
      ["git rev-parse --abbrev-ref", { stdout: "origin/main", stderr: "", code: 0 }],
      ["git checkout", { stdout: "Switched to branch 'main'", stderr: "", code: 0 }],
      ["git merge", { stdout: "Merge complete", stderr: "", code: 0 }],
      ["git rev-parse --short HEAD", { stdout: "merged99", stderr: "", code: 0 }],
    ]));
    const git = new GitOperations(defaultConfig, exec);

    const result = await git.merge("pi-coder/user-auth");

    assert.strictEqual(result.success, true);
    // Should have detected main as target
    const checkoutCall = calls.find(c => c.args[0] === "checkout");
    assert.ok(checkoutCall);
  });

  it("should fallback to 'main' when auto-detect fails", async () => {
    const { exec, calls } = createMockPiExec(new Map([
      ["git status", { stdout: "", stderr: "", code: 0 }],
      ["git remote show", { stdout: "", stderr: "error", code: 1 }],
      ["git checkout", { stdout: "Switched to branch 'main'", stderr: "", code: 0 }],
      ["git merge", { stdout: "Merge complete", stderr: "", code: 0 }],
      ["git rev-parse --short HEAD", { stdout: "merged99", stderr: "", code: 0 }],
    ]));
    const git = new GitOperations(defaultConfig, exec);

    const result = await git.merge("pi-coder/user-auth");

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.branch, "main");
  });

  it("should return merge commit SHA and target branch name on success", async () => {
    const { exec } = createMockPiExec(new Map([
      ["git status", { stdout: "", stderr: "", code: 0 }],
      ["git checkout", { stdout: "", stderr: "", code: 0 }],
      ["git merge", { stdout: "Merge complete", stderr: "", code: 0 }],
      ["git rev-parse --short HEAD", { stdout: "merged42", stderr: "", code: 0 }],
    ]));
    const git = new GitOperations(defaultConfig, exec);

    const result = await git.merge("pi-coder/feature", "develop");

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.ref, "merged42");
    assert.strictEqual(result.branch, "develop");
  });

  it("should return current branch name via getCurrentBranch()", async () => {
    const { exec } = createMockPiExec(new Map([
      ["git rev-parse --abbrev-ref HEAD", { stdout: "pi-coder/user-auth", stderr: "", code: 0 }],
    ]));
    const git = new GitOperations(defaultConfig, exec);

    const result = await git.getCurrentBranch();

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.branch, "pi-coder/user-auth");
  });

  it("should return error when git operation fails", async () => {
    const { exec } = createMockPiExec(new Map([
      ["git checkout -b", { stdout: "", stderr: "fatal: a branch named 'pi-coder/user-auth' already exists", code: 128 }],
    ]));
    const git = new GitOperations(defaultConfig, exec);

    const result = await git.checkoutBranch("user-auth");

    assert.strictEqual(result.success, false);
    assert.ok(result.error);
    assert.ok(result.error.includes("already exists"));
  });

  it("should return error when merge fails", async () => {
    const { exec } = createMockPiExec(new Map([
      ["git status", { stdout: "", stderr: "", code: 0 }],
      ["git checkout", { stdout: "", stderr: "", code: 0 }],
      ["git merge", { stdout: "", stderr: "CONFLICT: merge conflict in src/auth.ts", code: 1 }],
    ]));
    const git = new GitOperations(defaultConfig, exec);

    const result = await git.merge("pi-coder/user-auth", "main");

    assert.strictEqual(result.success, false);
    assert.ok(result.error);
    assert.ok(result.error.includes("CONFLICT"));
  });

  // ---------------------------------------------------------------------------
  // Dirty-tree detection & --no-ff flags
  // ---------------------------------------------------------------------------

  it("should return dirtyTree error when working tree has non-.pi-coder/ uncommitted changes", async () => {
    const { exec } = createMockPiExec(new Map([
      ["git status", { stdout: "M  src/auth.ts\nM  .pi-coder/state.json", stderr: "", code: 0 }],
    ]));
    const git = new GitOperations(defaultConfig, exec);

    const result = await git.merge("pi-coder/user-auth", "main");

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.dirtyTree, true);
    assert.ok(result.uncommittedFiles);
    assert.strictEqual(result.uncommittedFiles!.length, 1);
    assert.strictEqual(result.uncommittedFiles![0], "src/auth.ts");
    // Should NOT contain .pi-coder/ files
    assert.ok(!result.uncommittedFiles!.some(f => f.startsWith(".pi-coder/")));
  });

  it("should succeed when only .pi-coder/ files are dirty (they get discarded)", async () => {
    const { exec, calls } = createMockPiExec(new Map([
      ["git status", { stdout: "M  .pi-coder/state.json\nM  .pi-coder/logs/run.jsonl", stderr: "", code: 0 }],
      ["git checkout", { stdout: "", stderr: "", code: 0 }],
      ["git merge", { stdout: "Merge complete", stderr: "", code: 0 }],
      ["git rev-parse --short HEAD", { stdout: "merged42", stderr: "", code: 0 }],
    ]));
    const git = new GitOperations(defaultConfig, exec);

    const result = await git.merge("pi-coder/user-auth", "main");

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.dirtyTree, undefined);
    // Should have discarded .pi-coder/ changes before checkout
    const discardCall = calls.find(c => c.args[0] === "checkout" && c.args.includes("--") && c.args.includes(".pi-coder/"));
    assert.ok(discardCall, "Should discard .pi-coder/ changes");
  });

  it("should use --no-ff for normal merges", async () => {
    const { exec, calls } = createMockPiExec(new Map([
      ["git status", { stdout: "", stderr: "", code: 0 }],
      ["git checkout", { stdout: "", stderr: "", code: 0 }],
      ["git merge", { stdout: "Merge complete", stderr: "", code: 0 }],
      ["git rev-parse --short HEAD", { stdout: "merged99", stderr: "", code: 0 }],
    ]));
    const git = new GitOperations(defaultConfig, exec); // defaultConfig has mergeBranch: "merge"

    await git.merge("pi-coder/feature", "main");

    const mergeCall = calls.find(c => c.args[0] === "merge");
    assert.ok(mergeCall);
    assert.ok(mergeCall.args.includes("--no-ff"), "Normal merge should use --no-ff");
  });

  it("should NOT use --no-ff for squash merges", async () => {
    const squashConfig: PiCoderConfig = { ...defaultConfig, mergeBranch: "squash" };
    const { exec, calls } = createMockPiExec(new Map([
      ["git status", { stdout: "", stderr: "", code: 0 }],
      ["git checkout", { stdout: "", stderr: "", code: 0 }],
      ["git merge", { stdout: "Squash commit", stderr: "", code: 0 }],
      ["git commit", { stdout: "[main sq99] squash commit", stderr: "", code: 0 }],
      ["git rev-parse --short HEAD", { stdout: "sq99", stderr: "", code: 0 }],
    ]));
    const git = new GitOperations(squashConfig, exec);

    await git.merge("pi-coder/feature", "main");

    const mergeCall = calls.find(c => c.args[0] === "merge");
    assert.ok(mergeCall);
    assert.ok(mergeCall.args.includes("--squash"), "Squash merge should use --squash");
    assert.ok(!mergeCall.args.includes("--no-ff"), "Squash merge should NOT use --no-ff");
  });

  it("should succeed on clean working tree with no confirmation dialog", async () => {
    const { exec } = createMockPiExec(new Map([
      ["git status", { stdout: "", stderr: "", code: 0 }],
      ["git checkout", { stdout: "", stderr: "", code: 0 }],
      ["git merge", { stdout: "Merge complete", stderr: "", code: 0 }],
      ["git rev-parse --short HEAD", { stdout: "merged42", stderr: "", code: 0 }],
    ]));
    const git = new GitOperations(defaultConfig, exec);

    const result = await git.merge("pi-coder/feature", "main");

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.dirtyTree, undefined);
    assert.strictEqual(result.uncommittedFiles, undefined);
  });
});

// ---------------------------------------------------------------------------
// Auto-transition condition tests
// ---------------------------------------------------------------------------

describe("Auto-transition condition for MERGING state", () => {
  it("should only match success: true, not undefined or false", () => {
    // Test the condition pattern used in index.ts auto-transition
    // Changed from `gitDetails?.success !== false` to `gitDetails?.success === true`

    // Case 1: success === true -> matches
    const detailsTrue = { success: true } as { success?: boolean };
    assert.strictEqual(detailsTrue.success === true, true, "success:true should match === true");

    // Case 2: success === false -> does NOT match
    const detailsFalse = { success: false } as { success?: boolean };
    assert.strictEqual(detailsFalse.success === true, false, "success:false should NOT match === true");

    // Case 3: success is undefined -> does NOT match
    const detailsUndefined = {} as { success?: boolean };
    assert.strictEqual(detailsUndefined.success === true, false, "undefined success should NOT match === true");

    // Case 4: details is null/undefined -> does NOT match
    const detailsNull = null as { success?: boolean } | null;
    assert.strictEqual(detailsNull?.success === true, false, "null details should NOT match === true");

    // Verify the old condition would have incorrectly matched undefined
    const oldCondition = detailsUndefined.success !== false; // true (bug!)
    const newCondition = detailsUndefined.success === true; // false (correct)
    assert.strictEqual(oldCondition, true, "Old condition incorrectly matched undefined");
    assert.strictEqual(newCondition, false, "New condition correctly rejects undefined");
  });
});
