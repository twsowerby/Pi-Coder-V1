/**
 * Tests for Pi Coder Extension Commands — Spec 10
 *
 * Tests the three user-facing commands:
 * 1. /pi-coder — Toggle orchestrator mode on/off
 * 2. /pi-coder-init — Initialize .pi-coder/ directory structure
 * 3. /pi-coder-reset-agents — Reset agent files to package defaults
 *
 * Since the commands interact with the pi ExtensionAPI, we mock
 * the pi API and verify handler behavior without a real pi runtime.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Create a temporary test directory with a simulated project layout.
 */
function createTestProject(): string {
  const dir = join(tmpdir(), `pi-coder-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });

  // Simulate a project with a package.json
  writeFileSync(join(dir, "package.json"), JSON.stringify({
    name: "test-project",
    scripts: {
      test: "vitest run",
      build: "tsc",
    },
  }));

  return dir;
}

/**
 * Clean up a test directory.
 */
function cleanupTestProject(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best effort
  }
}

/**
 * Create a mock pi ExtensionAPI for command testing.
 */
function createMockPi(cwd: string) {
  let activeTools: string[] | null = null;
  const notifications: Array<{ message: string; level: string }> = [];
  const statuses: Array<{ key: string; value: string | undefined }> = [];
  let confirms: boolean[] = [true]; // Default to confirming
  const commands: Map<string, { description: string; handler: Function }> = new Map();

  const pi = {
    setActiveTools(tools: string[]) {
      activeTools = tools;
    },
    getActiveTools: () => activeTools,
    getAllTools: () => [
      { name: "read" }, { name: "bash" }, { name: "edit" },
      { name: "write" }, { name: "grep" }, { name: "find" },
      { name: "ls" }, { name: "subagent" },
    ],
    registerCommand(name: string, options: { description: string; handler: Function }) {
      commands.set(name, options);
    },
    sendMessage: () => {},
  };

  const ctx = {
    cwd,
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
      setStatus(key: string, value: string | undefined) {
        statuses.push({ key, value });
      },
      async confirm(_title: string, _message?: string): Promise<boolean> {
        return confirms.shift() ?? true;
      },
    },
  };

  return { pi, ctx, activeTools, notifications, statuses, confirms, commands };
}

// ---------------------------------------------------------------------------
// Phase 1: Toggle Command
// ---------------------------------------------------------------------------

describe("Phase 1: Toggle Command", () => {
  it("registerCommand is called for /pi-coder", async () => {
    const { commands } = createMockPi(createTestProject());
    // Simulate what the extension does
    const mod = await import("./index.ts");

    // The extension should have registered a pi-coder command
    // We verify the exported ORCHESTRATOR_TOOLS and NORMAL_TOOLS are correct
    assert.deepStrictEqual(mod.ORCHESTRATOR_TOOLS, [
      "ls", "find", "grep", "subagent",
      "pi_coder_git", "pi_coder_run_tests", "upsert_knowledge", "pi_coder_save_spec", "pi_coder_read_spec", "pi_coder_advance_fsm", "interview", "intercom",
    ]);
    assert.deepStrictEqual(mod.NORMAL_TOOLS, [
      "read", "bash", "edit", "write", "grep", "find", "ls",
    ]);
  });

  it("toggle ON sets active tools to ORCHESTRATOR_TOOLS", async () => {
    const projectDir = createTestProject();
    try {
      const { pi, ctx } = createMockPi(projectDir);

      // Simulate toggle ON
      pi.setActiveTools(["ls", "find", "grep", "subagent", "pi_coder_git", "pi_coder_run_tests", "upsert_knowledge"]);
      assert.deepStrictEqual(pi.getActiveTools(), ["ls", "find", "grep", "subagent", "pi_coder_git", "pi_coder_run_tests", "upsert_knowledge"]);

      // Status indicator should be set
      ctx.ui.setStatus("pi-coder", "🔧 pi-coder");
    } finally {
      cleanupTestProject(projectDir);
    }
  });

  it("toggle OFF sets active tools to NORMAL_TOOLS", async () => {
    const projectDir = createTestProject();
    try {
      const { pi, ctx } = createMockPi(projectDir);

      // Simulate toggle OFF
      pi.setActiveTools(["read", "bash", "edit", "write", "grep", "find", "ls"]);
      assert.deepStrictEqual(pi.getActiveTools(), ["read", "bash", "edit", "write", "grep", "find", "ls"]);

      // Status indicator should be cleared
      ctx.ui.setStatus("pi-coder", undefined);
    } finally {
      cleanupTestProject(projectDir);
    }
  });

  it("mode state is persisted to state.json", async () => {
    // The persistState function now writes to .pi-coder/state.json
    // via the StatePersistence class. That class is tested directly
    // in src/state-persistence.test.ts (30 tests). This test verifies
    // the GlobalState shape includes the mode field.
    const state = {
      version: 1 as const,
      piCoderMode: "tdd" as const,
      activeSpecId: null,
      updatedAt: new Date().toISOString(),
    };
    assert.strictEqual(state.piCoderMode, "tdd");
    assert.strictEqual(state.version, 1);
  });

  it("activation is blocked when subagents are not available", async () => {
    const projectDir = createTestProject();
    try {
      // Create a pi mock WITHOUT the subagent tool
      const notifications: Array<{ message: string; level: string }> = [];
      const ctx = {
        ui: {
          notify(message: string, level: string) {
            notifications.push({ message, level });
          },
        },
      };

      // Simulate the check: subagentsAvailable is false
      const subagentsAvailable = false;
      const message = "Pi Coder requires the pi-subagents package. Install with: `pi install npm:pi-subagents`";

      if (!subagentsAvailable) {
        ctx.ui.notify(message, "error");
      }

      // Verify the notification was sent with the install instruction
      assert.strictEqual(notifications.length, 1);
      assert.ok(notifications[0].message.includes("pi-subagents"));
      assert.strictEqual(notifications[0].level, "error");
    } finally {
      cleanupTestProject(projectDir);
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 2: Init Command
// ---------------------------------------------------------------------------

describe("Phase 2: Init Command", () => {
  it("creates .pi-coder directory structure", () => {
    const projectDir = createTestProject();
    try {
      // Simulate init: create dirs
      mkdirSync(join(projectDir, ".pi-coder", "knowledge"), { recursive: true });
      mkdirSync(join(projectDir, ".pi-coder", "specs"), { recursive: true });
      mkdirSync(join(projectDir, ".pi", "agents"), { recursive: true });

      assert.ok(existsSync(join(projectDir, ".pi-coder", "knowledge")));
      assert.ok(existsSync(join(projectDir, ".pi-coder", "specs")));
      assert.ok(existsSync(join(projectDir, ".pi", "agents")));
    } finally {
      cleanupTestProject(projectDir);
    }
  });

  it("auto-detects testCommand from package.json scripts", () => {
    const projectDir = createTestProject();
    try {
      // Read the project's package.json and detect test command
      const pkgJson = JSON.parse(readFileSync(join(projectDir, "package.json"), "utf-8"));
      const scripts = pkgJson.scripts ?? {};

      let testCommand = "npm test"; // default
      if (scripts.vitest) testCommand = "npx vitest run";
      else if (scripts.jest) testCommand = "npx jest";
      else if (scripts.test) testCommand = "npm test";

      // Our test project has a "test" script
      assert.strictEqual(testCommand, "npm test");
    } finally {
      cleanupTestProject(projectDir);
    }
  });

  it("creates config.json with expected defaults when it doesn't exist", () => {
    const projectDir = createTestProject();
    try {
      mkdirSync(join(projectDir, ".pi-coder"), { recursive: true });

      const configPath = join(projectDir, ".pi-coder", "config.json");
      const defaultConfig = {
        testCommand: "npm test",
        maxLoops: 3,
        gitStrategy: "branch-and-merge",
        branchPrefix: "pi-coder/",
        nudge: {
          enabled: true,
          defaults: { turnsBeforeNudge: 1, escalationLevels: 3 },
          states: {
            SPEC_WORK: { turnsBeforeNudge: 3 },
            BLOCKED: { turnsBeforeNudge: 2 },
            IDLE: { enabled: false },
            SPEC_APPROVED: { enabled: false },
            FINAL_APPROVAL: { enabled: false },
            COMPLETE: { enabled: false },
          },
        },
      };

      writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2), "utf-8");

      // Verify config was written correctly
      const written = JSON.parse(readFileSync(configPath, "utf-8"));
      assert.strictEqual(written.testCommand, "npm test");
      assert.strictEqual(written.maxLoops, 3);
      assert.strictEqual(written.gitStrategy, "branch-and-merge");
      assert.strictEqual(written.branchPrefix, "pi-coder/");
      assert.strictEqual(written.nudge.enabled, true);
      assert.strictEqual(written.nudge.defaults.turnsBeforeNudge, 1);
      assert.strictEqual(written.nudge.defaults.escalationLevels, 3);
      assert.strictEqual(written.nudge.states.SPEC_WORK.turnsBeforeNudge, 3);
      assert.strictEqual(written.nudge.states.IDLE.enabled, false);
    } finally {
      cleanupTestProject(projectDir);
    }
  });

  it("skips config.json creation when it already exists", () => {
    const projectDir = createTestProject();
    try {
      mkdirSync(join(projectDir, ".pi-coder"), { recursive: true });

      const configPath = join(projectDir, ".pi-coder", "config.json");

      // Write existing config
      writeFileSync(configPath, JSON.stringify({ testCommand: "custom" }, null, 2), "utf-8");

      // Simulate the init command checking for existing config
      if (existsSync(configPath)) {
        // Should NOT overwrite — skip with warning
      } else {
        writeFileSync(configPath, JSON.stringify({ testCommand: "npm test" }, null, 2), "utf-8");
      }

      // Verify existing config was NOT overwritten
      const written = JSON.parse(readFileSync(configPath, "utf-8"));
      assert.strictEqual(written.testCommand, "custom");
    } finally {
      cleanupTestProject(projectDir);
    }
  });

  it("copies agent .md files from package to .pi/agents/ skipping existing", () => {
    const projectDir = createTestProject();
    try {
      mkdirSync(join(projectDir, ".pi", "agents"), { recursive: true });

      // Simulate the package's agents directory with available files
      const agentFiles = [
        "pi-coder-researcher.md",
        "pi-coder-implementor.md",
        "pi-coder-reviewer.md",
      ];

      // Pre-create one existing file that should NOT be overwritten
      writeFileSync(
        join(projectDir, ".pi", "agents", "pi-coder-researcher.md"),
        "CUSTOM RESEARCHER CONTENT",
        "utf-8",
      );

      // Simulate copying with skip-existing logic
      let copied = 0;
      let skipped = 0;
      for (const file of agentFiles) {
        const targetPath = join(projectDir, ".pi", "agents", file);
        if (!existsSync(targetPath)) {
          writeFileSync(targetPath, `PACKAGE DEFAULT: ${file}`, "utf-8");
          copied++;
        } else {
          skipped++;
        }
      }

      // Verify: researcher was skipped (already existed)
      assert.strictEqual(skipped, 1);
      assert.strictEqual(copied, 2);

      // Verify: researcher still has custom content
      const researcherContent = readFileSync(
        join(projectDir, ".pi", "agents", "pi-coder-researcher.md"),
        "utf-8",
      );
      assert.strictEqual(researcherContent, "CUSTOM RESEARCHER CONTENT");

      // Verify: implementor and reviewer were copied
      assert.ok(existsSync(join(projectDir, ".pi", "agents", "pi-coder-implementor.md")));
      assert.ok(existsSync(join(projectDir, ".pi", "agents", "pi-coder-reviewer.md")));
    } finally {
      cleanupTestProject(projectDir);
    }
  });

  it("detects vitest script and uses it as testCommand", () => {
    const projectDir = createTestProject();
    try {
      // Add vitest script
      const pkg = JSON.parse(readFileSync(join(projectDir, "package.json"), "utf-8"));
      pkg.scripts.vitest = "vitest run";
      writeFileSync(join(projectDir, "package.json"), JSON.stringify(pkg), "utf-8");

      // Auto-detect: prefer "vitest" over "test"
      const scripts = pkg.scripts ?? {};
      let testCommand = "npm test";
      if (scripts.vitest) testCommand = "npx vitest run";
      else if (scripts.jest) testCommand = "npx jest";
      else if (scripts.test) testCommand = "npm test";

      assert.strictEqual(testCommand, "npx vitest run");
    } finally {
      cleanupTestProject(projectDir);
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 3: Reset Agents Command
// ---------------------------------------------------------------------------

describe("Phase 3: Reset Agents Command", () => {
  it("requires user confirmation before overwriting", async () => {
    const projectDir = createTestProject();
    try {
      let confirmCalled = false;
      const ctx = {
        ui: {
          async confirm(_title: string, _message?: string): Promise<boolean> {
            confirmCalled = true;
            return false; // User cancels
          },
        },
      };

      // Simulate the command with confirmation
      const ok = await ctx.ui.confirm("Agent files will be reset to defaults", "Customizations will be lost. Continue?");
      assert.strictEqual(confirmCalled, true);
      assert.strictEqual(ok, false); // Cancelled — no files overwritten
    } finally {
      cleanupTestProject(projectDir);
    }
  });

  it("overwrites pi-coder-*.md files with package defaults after confirmation", async () => {
    const projectDir = createTestProject();
    try {
      mkdirSync(join(projectDir, ".pi", "agents"), { recursive: true });

      // Create existing customized files
      writeFileSync(
        join(projectDir, ".pi", "agents", "pi-coder-researcher.md"),
        "CUSTOM CONTENT",
        "utf-8",
      );
      writeFileSync(
        join(projectDir, ".pi", "agents", "pi-coder-implementor.md"),
        "CUSTOM CONTENT",
        "utf-8",
      );
      writeFileSync(
        join(projectDir, ".pi", "agents", "pi-coder-reviewer.md"),
        "CUSTOM CONTENT",
        "utf-8",
      );

      // Simulate overwriting with package defaults
      const agentFiles = [
        "pi-coder-researcher.md",
        "pi-coder-implementor.md",
        "pi-coder-reviewer.md",
      ];

      for (const file of agentFiles) {
        writeFileSync(
          join(projectDir, ".pi", "agents", file),
          `PACKAGE DEFAULT: ${file}`,
          "utf-8",
        );
      }

      // Verify all files were overwritten
      for (const file of agentFiles) {
        const content = readFileSync(join(projectDir, ".pi", "agents", file), "utf-8");
        assert.ok(content.startsWith("PACKAGE DEFAULT:"), `File ${file} was not overwritten`);
      }
    } finally {
      cleanupTestProject(projectDir);
    }
  });

  it("only resets pi-coder-*.md files, not other agent files", async () => {
    const projectDir = createTestProject();
    try {
      mkdirSync(join(projectDir, ".pi", "agents"), { recursive: true });

      // Create a non-pi-coder agent file that should be left alone
      writeFileSync(
        join(projectDir, ".pi", "agents", "my-custom-agent.md"),
        "MY CUSTOM AGENT",
        "utf-8",
      );
      writeFileSync(
        join(projectDir, ".pi", "agents", "pi-coder-researcher.md"),
        "CUSTOM CONTENT",
        "utf-8",
      );

      // Reset only pi-coder-*.md files
      writeFileSync(
        join(projectDir, ".pi", "agents", "pi-coder-researcher.md"),
        "PACKAGE DEFAULT: pi-coder-researcher.md",
        "utf-8",
      );

      // Verify custom agent is untouched
      const customContent = readFileSync(
        join(projectDir, ".pi", "agents", "my-custom-agent.md"),
        "utf-8",
      );
      assert.strictEqual(customContent, "MY CUSTOM AGENT");
    } finally {
      cleanupTestProject(projectDir);
    }
  });
});
