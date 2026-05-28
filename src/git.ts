/**
 * Structured Git API for the Pi Coder TDD harness.
 *
 * All git operations go through this module. Raw `git` CLI access is blocked
 * for the orchestrator and subagents. This module provides a safe, structured
 * API that operates via `pi.exec("git", [...])` with arguments passed as arrays
 * (never string-interpolated) to prevent injection.
 */

import type { PiCoderConfig, GitCheckpointResult } from "./types.ts";

/**
 * Type signature for `pi.exec` — allows easy mocking in tests.
 */
export type ExecFn = (
  command: string,
  args: string[],
  options?: { signal?: AbortSignal; timeout?: number },
) => Promise<{ stdout: string; stderr: string; code: number; killed?: boolean }>;

/**
 * Validates a branch name for pi-coder usage.
 * Must consist only of lowercase alphanumeric, hyphens, and forward slashes.
 */
function isValidBranchName(name: string): boolean {
  return /^[a-z0-9][a-z0-9\-/]*[a-z0-9]$/.test(name) || /^[a-z0-9]$/.test(name);
}

/**
 * Attempts to detect the project's default branch name.
 * Tries: git remote show, then falls back to "main".
 */
async function detectDefaultBranch(exec: ExecFn): Promise<string> {
  // Try to detect from remote HEAD reference
  try {
    const { stdout, code } = await exec("git", ["rev-parse", "--abbrev-ref", "origin/HEAD"]);
    if (code === 0 && stdout.trim()) {
      // origin/HEAD -> origin/main => extract "main"
      const ref = stdout.trim();
      const branch = ref.replace(/^origin\//, "");
      if (branch && branch !== "HEAD") {
        return branch;
      }
    }
  } catch {
    // Fall through
  }

  // Try checking if 'main' exists
  try {
    const { code } = await exec("git", ["rev-parse", "--verify", "main"]);
    if (code === 0) return "main";
  } catch {
    // Fall through
  }

  // Try checking if 'master' exists
  try {
    const { code } = await exec("git", ["rev-parse", "--verify", "master"]);
    if (code === 0) return "master";
  } catch {
    // Fall through
  }

  return "main";
}

/**
 * Extracts a short commit SHA from git commit output.
 * Git outputs lines like: [main abc1234] message
 */
function extractCommitRef(output: string): string | undefined {
  const match = output.match(/\[[^\s]+ ([a-f0-9]{7,})\]/);
  return match?.[1];
}

/**
 * Structured Git API that replaces raw `git` CLI access.
 * All operations go through `pi.exec("git", [...])` with array-based args.
 */
export class GitOperations {
  private readonly config: PiCoderConfig;
  private readonly exec: ExecFn;

  constructor(config: PiCoderConfig, exec: ExecFn) {
    this.config = config;
    this.exec = exec;
  }

  /**
   * Execute a git command with structured result.
   * All public methods delegate here — never construct commands via string concatenation.
   */
  private async execGit(args: string[]): Promise<GitCheckpointResult> {
    try {
      const result = await this.exec("git", args);

      if (result.code === 0) {
        return {
          success: true,
          message: result.stdout.trim() || undefined,
        };
      } else {
        return {
          success: false,
          error: result.stderr.trim() || result.stdout.trim() || `git ${args.join(" ")} failed with code ${result.code}`,
        };
      }
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Branch Operations
  // ---------------------------------------------------------------------------

  /**
   * Create and checkout a new branch with the configured prefix.
   * The prefix is prepended automatically, so the caller provides just the
   * branch stem (e.g., "user-auth" → "pi-coder/user-auth").
   */
  async checkoutBranch(branch: string, baseBranch?: string): Promise<GitCheckpointResult> {
    // Validate branch name (before prefix — the raw stem must be valid)
    if (!isValidBranchName(branch)) {
      return {
        success: false,
        error: `Invalid branch name: "${branch}". Must consist only of lowercase alphanumeric, hyphens, and forward slashes.`,
      };
    }

    const fullBranchName = `${this.config.branchPrefix}${branch}`;

    const args = ["checkout", "-b", fullBranchName];
    if (baseBranch) {
      args.push(baseBranch);
    }

    const result = await this.execGit(args);
    if (!result.success) {
      return result;
    }

    // Get the commit SHA at the new branch head
    const refResult = await this.getCurrentRef();
    return {
      success: true,
      branch: fullBranchName,
      ref: refResult.success ? refResult.ref : undefined,
      message: `Created and checked out branch ${fullBranchName}`,
    };
  }

  // ---------------------------------------------------------------------------
  // Checkpoint & Rollback
  // ---------------------------------------------------------------------------

  /**
   * Create a checkpoint — stage all changes and commit.
   * Uses --allow-empty so pre-implementation checkpoints work
   * even when no files have changed.
   */
  async checkpoint(message: string): Promise<GitCheckpointResult> {
    // Stage all changes
    const addResult = await this.execGit(["add", "-A"]);
    if (!addResult.success) {
      return addResult;
    }

    // Commit with --allow-empty
    const commitResult = await this.execGit(["commit", "--allow-empty", "-m", message]);
    if (!commitResult.success) {
      return commitResult;
    }

    // Extract the commit SHA from the output
    const ref = extractCommitRef(commitResult.message ?? "");

    return {
      success: true,
      ref,
      message: commitResult.message,
    };
  }

  /**
   * Destructive rollback — git reset --hard to the given ref.
   * Logs a warning before executing since this discards uncommitted changes.
   */
  async rollback(ref: string): Promise<GitCheckpointResult> {
    // Destructive operation — log warning
    console.warn(`[pi-coder] Destructive rollback to ref: ${ref}`);

    const result = await this.execGit(["reset", "--hard", ref]);
    if (!result.success) {
      return result;
    }

    // Get the new HEAD SHA
    const refResult = await this.getCurrentRef();
    return {
      success: true,
      ref: refResult.success ? refResult.ref : ref,
      message: `Rollback: reset to ${ref}`,
    };
  }

  /**
   * Get the short-form HEAD commit SHA.
   */
  async getCurrentRef(): Promise<GitCheckpointResult> {
    const result = await this.execGit(["rev-parse", "--short", "HEAD"]);
    if (!result.success) {
      return result;
    }
    return {
      success: true,
      ref: result.message?.trim(),
    };
  }

  /**
   * Check whether the working tree has uncommitted changes.
   * Returns true if there are staged or unstaged changes.
   */
  async hasUncommittedChanges(): Promise<boolean> {
    const result = await this.execGit(["status", "--porcelain"]);
    if (!result.success) {
      // If we can't check status, assume no changes (safer default)
      return false;
    }
    // --porcelain output: one line per changed file
    return (result.message?.trim().length ?? 0) > 0;
  }

  /**
   * Get the list of files with uncommitted changes.
   * Returns the file paths from `git status --porcelain`, stripping the
   * status prefix (first 3 characters: XY + space).
   */
  async getUncommittedFiles(): Promise<string[]> {
    const result = await this.execGit(["status", "--porcelain"]);
    if (!result.success) {
      // If we can't check status, assume no changes (safer default)
      return [];
    }
    const lines = result.message?.trim().split("\n") ?? [];
    return lines
      .filter((line) => line.length > 0)
      .map((line) => line.slice(3)); // Strip "XY " prefix
  }

  // ---------------------------------------------------------------------------
  // Merge & Strategy
  // ---------------------------------------------------------------------------

  /**
   * Merge the feature branch back to the target branch.
   * Supports normal merge and squash merge based on config.
   *
   * Dirty-tree detection: Before discarding .pi-coder/ changes, checks
   * for non-.pi-coder/ uncommitted changes. If found, returns a result
   * with dirtyTree=true and uncommittedFiles listing the offending files.
   * The caller (tools.ts) is responsible for prompting the user or
   * auto-committing.
   */
  async merge(branch: string, targetBranch?: string): Promise<GitCheckpointResult> {
    const target = targetBranch ?? await detectDefaultBranch(this.exec);

    // Dirty-tree check BEFORE discarding .pi-coder/ changes.
    // This detects non-.pi-coder/ uncommitted changes that would silently
    // ride along to the target branch.
    const allDirtyFiles = await this.getUncommittedFiles();
    const nonPiCoderDirtyFiles = allDirtyFiles.filter(
      (f) => !f.startsWith(".pi-coder/"),
    );
    if (nonPiCoderDirtyFiles.length > 0) {
      return {
        success: false,
        error: `Uncommitted changes detected in ${nonPiCoderDirtyFiles.length} file(s). Commit or stash them before merging, or approve auto-commit.`,
        dirtyTree: true,
        uncommittedFiles: nonPiCoderDirtyFiles,
      };
    }

    // Before switching branches or merging, discard any uncommitted .pi-coder/
    // changes (state.json, logs). These are workspace-local metadata that
    // can change between the last checkpoint and the merge (e.g., FSM state
    // persistence, interaction logging). If they're tracked in git (e.g.,
    // .pi-coder/.gitignore wasn't set up), they'll dirty the working tree
    // and block the merge. If they're not tracked, this is a no-op.
    await this.execGit(["checkout", "--", ".pi-coder/"]);

    // Checkout the target branch
    const checkoutResult = await this.execGit(["checkout", target]);
    if (!checkoutResult.success) {
      return {
        success: false,
        error: `Failed to checkout target branch "${target}": ${checkoutResult.error}`,
      };
    }

    // Merge the feature branch
    const mergeArgs = ["merge", branch];
    if (this.config.mergeBranch === "squash") {
      mergeArgs.push("--squash");
    } else {
      // Normal merge: use --no-ff to ensure a merge commit always exists
      mergeArgs.push("--no-ff");
    }

    const mergeResult = await this.execGit(mergeArgs);
    if (!mergeResult.success) {
      return {
        success: false,
        error: `Merge failed: ${mergeResult.error}`,
      };
    }

    // For squash merge, we need an additional commit step
    if (this.config.mergeBranch === "squash") {
      const commitResult = await this.execGit(["commit", "-m", `Squash merge ${branch}`]);
      if (!commitResult.success) {
        return {
          success: false,
          error: `Squash commit failed: ${commitResult.error}`,
        };
      }
    }

    // Get the merge commit SHA
    const refResult = await this.getCurrentRef();
    return {
      success: true,
      ref: refResult.success ? refResult.ref : undefined,
      branch: target,
      message: `Merged ${branch} into ${target}`,
    };
  }

  /**
   * Get the current branch name.
   */
  async getCurrentBranch(): Promise<GitCheckpointResult> {
    const result = await this.execGit(["rev-parse", "--abbrev-ref", "HEAD"]);
    if (!result.success) {
      return result;
    }
    return {
      success: true,
      branch: result.message?.trim(),
    };
  }
}
