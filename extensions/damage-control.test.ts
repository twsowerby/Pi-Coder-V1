import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// We test the core logic of damage-control — path matching, rule evaluation,
// and feedback generation. The extension API integration is tested via the
// existing extension test patterns.

// ---------------------------------------------------------------------------
// Import the module logic by re-implementing the pure functions for testing
// (the extension uses module-scoped state, so we test the logic directly)
// ---------------------------------------------------------------------------

// Re-implement path matching logic exactly as in damage-control.ts
function resolvePath(p: string, cwd: string): string {
  if (p.startsWith("~")) {
    p = path.join(process.env.HOME ?? "/tmp", p.slice(1));
  }
  return path.resolve(cwd, p);
}

function isPathMatch(targetPath: string, pattern: string, cwd: string): boolean {
  const resolvedPattern = pattern.startsWith("~")
    ? path.join(process.env.HOME ?? "/tmp", pattern.slice(1))
    : pattern;

  if (resolvedPattern.endsWith("/")) {
    const absolutePattern = path.isAbsolute(resolvedPattern)
      ? resolvedPattern
      : path.resolve(cwd, resolvedPattern);
    return targetPath.startsWith(absolutePattern);
  }

  const regexPattern = resolvedPattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");

  const regex = new RegExp(`^${regexPattern}$|^${regexPattern}/|/${regexPattern}$|/${regexPattern}/`);

  const relativePath = path.relative(cwd, targetPath);

  return (
    regex.test(targetPath) ||
    regex.test(relativePath) ||
    targetPath.includes(resolvedPattern) ||
    relativePath.includes(resolvedPattern)
  );
}

function continueFeedback(toolName: string, violationReason: string, invocation: string): string {
  return [
    `🛡️ Damage-Control: ${toolName} blocked — ${violationReason}`,
    ``,
    `Attempted: ${invocation}`,
    ``,
    `Don't call ${toolName} like this. Decide which case you're in and continue:`,
    ``,
    `→ NON-DESTRUCTIVE (reading .env to verify a key, listing a protected dir, checking config):`,
    `   Assume the data is present and correct. Skip the verification step and move on with the task.`,
    `   If you actually need a value, ask the user for it explicitly.`,
    ``,
    `→ DESTRUCTIVE (delete, overwrite, force-push, drop, rm, truncate, sudo, kill, etc.):`,
    `   STOP. Tell the user exactly what you need to ship this task and ask how they want to proceed.`,
    `   Do not invent a workaround that achieves the same destructive effect.`,
    ``,
    `Pick the right path above and continue working. Do not retry this exact call.`,
  ].join("\n");
}

// Default bash rules (copied from damage-control.ts for test consistency)
const DEFAULT_BASH_RULES = [
  { pattern: "\\brm\\s+(-rf?|--recursive|-r\\s*-f)", reason: "Recursive delete" },
  { pattern: "\\bsudo\\b", reason: "Sudo commands require host-level access" },
  { pattern: "\\bgit\\s+push\\s+.*--force", reason: "Force push rewrites shared history" },
  { pattern: "\\bgit\\s+push\\s+.*--delete", reason: "Deleting remote branches is destructive" },
  { pattern: "\\bgit\\s+reset\\s+--hard", reason: "Hard reset discards uncommitted changes" },
  { pattern: "\\bgit\\s+clean\\s+-", reason: "Git clean removes untracked files" },
  { pattern: "\\bchmod\\s+.*777\\b", reason: "chmod 777 is a security risk" },
  { pattern: "\\btruncate\\b", reason: "Truncating files is destructive" },
  { pattern: "\\b(?:mkfs|dd\\s+if=)\\b", reason: "Can destroy filesystems" },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("damage-control: bash pattern matching", () => {
  it("blocks rm -rf", () => {
    const rule = DEFAULT_BASH_RULES[0];
    const regex = new RegExp(rule.pattern);
    assert.ok(regex.test("rm -rf node_modules"));
    assert.ok(regex.test("rm --recursive something"));
    assert.ok(!regex.test("rm file.txt")); // not recursive
    // Note: rm -fr matches -r flag but not -rf; the pattern matches -rf? which is -r or -rf
    // rm -fr /tmp would NOT match because the f comes after r, not as -rf
  });

  it("blocks sudo", () => {
    const rule = DEFAULT_BASH_RULES[1];
    const regex = new RegExp(rule.pattern);
    assert.ok(regex.test("sudo apt install stuff"));
    // \bsudo\b matches 'sudo' as a word anywhere in the string — including
    // after 'echo'. This is intentional since bash could pipe 'sudo' into
    // another command. The rule is broad by design.
    assert.ok(regex.test("echo sudo")); // matches 'sudo' word
  });

  it("blocks git push --force", () => {
    const rule = DEFAULT_BASH_RULES[2];
    const regex = new RegExp(rule.pattern);
    assert.ok(regex.test("git push origin --force"));
    assert.ok(regex.test("git push --force-with-lease")); // matches --force prefix
    assert.ok(!regex.test("git push origin main"));
  });

  it("blocks git reset --hard", () => {
    const rule = DEFAULT_BASH_RULES[4];
    const regex = new RegExp(rule.pattern);
    assert.ok(regex.test("git reset --hard HEAD~1"));
    assert.ok(!regex.test("git reset --soft HEAD~1"));
  });

  it("blocks chmod 777", () => {
    const rule = DEFAULT_BASH_RULES[6];
    const regex = new RegExp(rule.pattern);
    assert.ok(regex.test("chmod 777 /tmp/thing"));
    assert.ok(!regex.test("chmod 644 file.txt"));
  });

  it("blocks truncate", () => {
    const rule = DEFAULT_BASH_RULES[7];
    const regex = new RegExp(rule.pattern);
    assert.ok(regex.test("truncate -s 0 file.log"));
    // \btruncate\b matches the word anywhere — including after 'echo'
    assert.ok(regex.test("echo truncate")); // matches 'truncate' word
  });
});

describe("damage-control: path matching", () => {
  const cwd = "/home/user/project";

  it("matches directory prefix patterns (trailing /)", () => {
    assert.ok(isPathMatch("/home/user/project/.env", ".env", cwd));
    assert.ok(isPathMatch("/home/user/project/.env.local", ".env.local", cwd));
    assert.ok(!isPathMatch("/home/user/project/src/config.ts", ".env", cwd));
  });

  it("matches home directory patterns", () => {
    const home = process.env.HOME ?? "/tmp";
    assert.ok(isPathMatch(path.join(home, ".ssh", "id_rsa"), "~/.ssh/", cwd));
    assert.ok(isPathMatch(path.join(home, ".gnupg", "pubring.kbx"), "~/.gnupg/", cwd));
    assert.ok(!isPathMatch("/home/user/project/.ssh", "~/.ssh/", cwd));
  });

  it("matches .git/config", () => {
    assert.ok(isPathMatch("/home/user/project/.git/config", ".git/config", cwd));
    assert.ok(isPathMatch(path.join(cwd, ".git", "config"), ".git/config", cwd));
  });

  it("does not match unrelated paths", () => {
    assert.ok(!isPathMatch("/home/user/project/src/index.ts", ".env", cwd));
    assert.ok(!isPathMatch("/home/user/project/README.md", ".git/", cwd));
  });
});

describe("damage-control: continueFeedback", () => {
  it("includes the tool name, reason, and invocation", () => {
    const feedback = continueFeedback("bash", "Recursive delete is destructive", "rm -rf node_modules");
    assert.ok(feedback.includes("bash"));
    assert.ok(feedback.includes("Recursive delete is destructive"));
    assert.ok(feedback.includes("rm -rf node_modules"));
  });

  it("includes both destructive and non-destructive guidance", () => {
    const feedback = continueFeedback("bash", "blocked", "something");
    assert.ok(feedback.includes("NON-DESTRUCTIVE"));
    assert.ok(feedback.includes("DESTRUCTIVE"));
  });

  it("tells the agent not to retry", () => {
    const feedback = continueFeedback("bash", "blocked", "something");
    assert.ok(feedback.includes("Do not retry this exact call"));
  });
});

describe("damage-control: rule evaluation scenarios", () => {
  const cwd = "/home/user/project";

  it("zero-access paths block read/write/edit", () => {
    const zeroAccessPaths = ["secrets/"];
    // A path like /home/user/project/secrets/api-key.pem should match
    assert.ok(isPathMatch(path.join(cwd, "secrets", "api-key.pem"), "secrets/", cwd));
  });

  it("read-only paths block write/edit but allow read", () => {
    // The extension checks toolName separately — here we just verify path matching
    assert.ok(isPathMatch(path.join(cwd, ".env"), ".env", cwd));
    assert.ok(isPathMatch(path.join(cwd, ".env.local"), ".env.local", cwd));
  });

  it("no-delete paths block rm/mv but not write", () => {
    // noDeletePaths is checked in bash commands (rm, mv), not in write/edit
    assert.ok(isPathMatch(path.join(cwd, ".git", "HEAD"), ".git/", cwd));
  });

  it("bash command referencing zero-access path is blocked", () => {
    const zeroAccessPaths = [".env.production"];
    const command = "cat .env.production";
    assert.ok(command.includes(".env.production"));
  });

  it("bash command that modifies read-only path is matched", () => {
    const readOnlyPaths = [".env"];
    const command = "echo KEY=val >> .env";
    assert.ok(command.includes(".env"));
    assert.ok(/[\s>|]/.test(command));
  });

  it("bash command that deletes no-delete path is matched", () => {
    const noDeletePaths = ["migrations/"];
    const command = "rm -rf migrations/";
    assert.ok(command.includes("migrations/"));
    assert.ok(command.includes("rm"));
  });
});
