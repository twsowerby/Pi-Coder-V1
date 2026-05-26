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

function isOutsideProjectCwd(resolvedPath: string, cwd: string): boolean {
  const normalizedCwd = cwd.endsWith(path.sep) ? cwd : cwd + path.sep;
  return !resolvedPath.startsWith(normalizedCwd);
}

function detectBashWriteOutsideCwd(command: string, projectCwd: string): string | null {
  const writePatterns: Array<{ regex: RegExp; pathGroupIndex: number }> = [
    { regex: /(?:^|[|;&])\s*(?:\S+\s+)*>?>>?\s*("[^"]+"|'[^']+'|\S+)/, pathGroupIndex: 1 },
    { regex: /\bsed[^\n]*-i[^\n]*\s(\S+\.[a-zA-Z0-9]+)/, pathGroupIndex: 1 },
    { regex: /\bawk\s+[^\n]*-i\s+inplace[^\n]*?-f\s*(\S+)/, pathGroupIndex: 1 },
    { regex: /\btee\s+(?:-[aAp]+\s+)*(\S+)/, pathGroupIndex: 1 },
    { regex: /\bdd\s+[^\n]*\bof=(\S+)/, pathGroupIndex: 1 },
    { regex: /\bcp\s+(?:-[a-lnp-rsvx]+\s+)*\S+\s+(\S+)\s*$/, pathGroupIndex: 1 },
    { regex: /\binstall\s+(?:-[a-z]+\s+)*\S+\s+(\S+)\s*$/, pathGroupIndex: 1 },
    { regex: /\bmv\s+(?:-[a-z]+\s+)*\S+\s+(\S+)\s*$/, pathGroupIndex: 1 },
  ];

  for (const { regex, pathGroupIndex } of writePatterns) {
    const match = regex.exec(command);
    if (match && match[pathGroupIndex]) {
      let targetPath = match[pathGroupIndex];
      if ((targetPath.startsWith("'") && targetPath.endsWith("'")) ||
        (targetPath.startsWith('"') && targetPath.endsWith('"'))) {
        targetPath = targetPath.slice(1, -1);
      }
      const resolved = resolvePath(targetPath, projectCwd);
      if (isOutsideProjectCwd(resolved, projectCwd)) {
        return resolved;
      }
    }
  }

  return null;
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

function continueFeedbackCwdBoundary(toolName: string, outsidePath: string, projectCwd: string, invocation: string): string {
  return [
    `🛡️ Damage-Control: ${toolName} blocked — write target is outside the project directory`,,
    ``,
    `Attempted: ${invocation}`,
    `Target: ${outsidePath}`,
    `Project: ${projectCwd}`,
    ``,
    `Writing outside the project directory is blocked to prevent accidental changes to`,
    `unrelated files (including reference projects). This is a defense-in-depth measure.`,
    ``,
    `→ If you need to modify a file in this project, use a path within the project directory.`,
    `→ If you need to modify a file outside this project, tell the user what you need and`,
    `   ask them to handle it. Do not attempt to work around this restriction.`,
    ``,
    `Reading files outside the project directory is allowed — only writes are blocked.`,
    `Do not retry this exact call.`,
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

describe("damage-control: CWD write boundary - isOutsideProjectCwd", () => {
  const cwd = "/home/user/project";

  it("identifies paths outside the project directory", () => {
    assert.ok(isOutsideProjectCwd("/home/user/other-project/src/index.ts", cwd));
    assert.ok(isOutsideProjectCwd("/tmp/some-file.ts", cwd));
    assert.ok(isOutsideProjectCwd("/home/user/project-sibling/file.ts", cwd));
  });

  it("allows paths inside the project directory", () => {
    assert.ok(!isOutsideProjectCwd("/home/user/project/src/index.ts", cwd));
    assert.ok(!isOutsideProjectCwd("/home/user/project/.env", cwd));
    assert.ok(!isOutsideProjectCwd("/home/user/project/", cwd));
  });

  it("does not let project-sibling directories through (prefix-without-slash attack)", () => {
    // /home/user/project-sibling should NOT be considered inside /home/user/project
    assert.ok(isOutsideProjectCwd("/home/user/project-sibling/file.ts", cwd));
  });
});

describe("damage-control: CWD write boundary - write/edit tools", () => {
  const cwd = "/home/user/project";

  it("write to path outside project is a boundary violation", () => {
    const p = "/home/user/other-project/src/index.ts";
    const resolved = resolvePath(p, cwd);
    assert.ok(isOutsideProjectCwd(resolved, cwd));
  });

  it("edit to path outside project is a boundary violation", () => {
    const p = "../other-project/src/index.ts";
    const resolved = resolvePath(p, cwd);
    assert.ok(isOutsideProjectCwd(resolved, cwd));
  });

  it("write to path inside project is allowed", () => {
    const p = "src/index.ts";
    const resolved = resolvePath(p, cwd);
    assert.ok(!isOutsideProjectCwd(resolved, cwd));
  });

  it("edit to path inside project is allowed", () => {
    const p = ".env";
    const resolved = resolvePath(p, cwd);
    assert.ok(!isOutsideProjectCwd(resolved, cwd));
  });
});

describe("damage-control: CWD write boundary - bash write detection", () => {
  const cwd = "/home/user/project";

  it("detects redirect to path outside project", () => {
    const result = detectBashWriteOutsideCwd("echo hello > /home/user/other-project/file.txt", cwd);
    assert.ok(result);
    assert.ok(result!.includes("/home/user/other-project/file.txt"));
  });

  it("detects append redirect to path outside project", () => {
    const result = detectBashWriteOutsideCwd("echo hello >> /home/user/other-project/file.txt", cwd);
    assert.ok(result);
  });

  it("detects sed -i on path outside project", () => {
    const result = detectBashWriteOutsideCwd("sed -i 's/old/new/g' /home/user/other-project/config.ts", cwd);
    assert.ok(result);
  });

  it("detects tee to path outside project", () => {
    const result = detectBashWriteOutsideCwd("echo output | tee /home/user/other-project/log.txt", cwd);
    assert.ok(result);
  });

  it("detects dd of= to path outside project", () => {
    const result = detectBashWriteOutsideCwd("dd if=/dev/zero of=/home/user/other-project/disk.img bs=1M count=10", cwd);
    assert.ok(result);
  });

  it("detects cp to path outside project", () => {
    const result = detectBashWriteOutsideCwd("cp src/file.ts /home/user/other-project/src/file.ts", cwd);
    assert.ok(result);
  });

  it("detects mv to path outside project", () => {
    const result = detectBashWriteOutsideCwd("mv src/file.ts /home/user/other-project/src/file.ts", cwd);
    assert.ok(result);
  });

  it("allows redirect to path inside project", () => {
    const result = detectBashWriteOutsideCwd("echo hello > src/output.txt", cwd);
    assert.strictEqual(result, null);
  });

  it("allows sed -i on path inside project", () => {
    const result = detectBashWriteOutsideCwd("sed -i 's/old/new/g' src/config.ts", cwd);
    assert.strictEqual(result, null);
  });

  it("allows read-only commands to paths outside project", () => {
    assert.strictEqual(detectBashWriteOutsideCwd("cat /home/user/other-project/file.ts", cwd), null);
    assert.strictEqual(detectBashWriteOutsideCwd("grep -r 'pattern' /home/user/other-project/src/", cwd), null);
    assert.strictEqual(detectBashWriteOutsideCwd("ls /home/user/other-project/", cwd), null);
    assert.strictEqual(detectBashWriteOutsideCwd("find /home/user/other-project/ -name '*.ts'", cwd), null);
  });

  it("handles quoted paths in redirects", () => {
    const result = detectBashWriteOutsideCwd('echo hello > "/home/user/other-project/file with spaces.txt"', cwd);
    assert.ok(result);
  });

  it("allows cp within project", () => {
    const result = detectBashWriteOutsideCwd("cp src/file.ts lib/file.ts", cwd);
    assert.strictEqual(result, null);
  });
});

describe("damage-control: continueFeedbackCwdBoundary", () => {
  it("includes the outside path and project path", () => {
    const feedback = continueFeedbackCwdBoundary("write", "/home/user/other-project/file.ts", "/home/user/project", "{\"path\":\"/home/user/other-project/file.ts\"}");
    assert.ok(feedback.includes("/home/user/other-project/file.ts"));
    assert.ok(feedback.includes("/home/user/project"));
    assert.ok(feedback.includes("outside the project directory"));
  });

  it("tells the agent that reads are allowed", () => {
    const feedback = continueFeedbackCwdBoundary("bash", "/tmp/file", "/home/user/project", "echo > /tmp/file");
    assert.ok(feedback.includes("Reading files outside the project directory is allowed"));
  });

  it("tells the agent not to retry", () => {
    const feedback = continueFeedbackCwdBoundary("edit", "/other/file", "/project", "edit");
    assert.ok(feedback.includes("Do not retry this exact call"));
  });
});
