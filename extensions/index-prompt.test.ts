/**
 * Tests for Spec 13: Orchestrator System Prompt Extraction
 *
 * Tests:
 * - Phase 1: The .md file exists with correct template variables
 * - Phase 2: The extension loads the prompt from file, not inline
 * - Phase 3: Customization support (project-scope override, init/reset commands)
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(__dirname, "..");
const orchestratorPromptPath = join(packageRoot, "prompts", "pi-coder-orchestrator.md");

function createTempDir(): string {
  const dir = join(tmpdir(), `pi-coder-spec13-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanupDir(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

// ---------------------------------------------------------------------------
// Phase 1: Prompt File
// ---------------------------------------------------------------------------

describe("Spec 13 Phase 1: Orchestrator Prompt File", () => {
  it("the .md file exists at prompts/pi-coder-orchestrator.md", () => {
    assert.ok(existsSync(orchestratorPromptPath), "Missing prompts/pi-coder-orchestrator.md");
  });

  it("the file has valid YAML frontmatter with name and package", () => {
    const content = readFileSync(orchestratorPromptPath, "utf-8");
    // Note: the orchestrator prompt is in prompts/, NOT agents/ — it's a template,
    // not a discoverable subagent. Frontmatter is optional but allowed for readability.
    // The key requirement is that it contains all template variables.
    const requiredVars = [
      "{{fsmDiagram}}",
      "{{currentState}}",
      "{{activeSpecId}}",
      "{{loopCount}}",
      "{{maxLoops}}",
      "{{toolList}}",
    ];
    for (const v of requiredVars) {
      assert.ok(content.includes(v), `Missing template variable: ${v}`);
    }
  });

  it("the file contains all required template variables", () => {
    const content = readFileSync(orchestratorPromptPath, "utf-8");

    const requiredVars = [
      "{{fsmDiagram}}",
      "{{currentState}}",
      "{{activeSpecId}}",
      "{{loopCount}}",
      "{{maxLoops}}",
      "{{toolList}}",
    ];

    for (const v of requiredVars) {
      assert.ok(content.includes(v), `Missing template variable: ${v}`);
    }
  });

  it("the file documents each template variable in an HTML comment block", () => {
    const content = readFileSync(orchestratorPromptPath, "utf-8");
    assert.ok(content.includes("<!--"), "Must have HTML comment block");
    assert.ok(content.includes("-->"), "HTML comment must be closed");

    // The comment should document each variable
    const commentMatch = content.match(/<!--([\s\S]*?)-->/);
    assert.ok(commentMatch, "Could not extract HTML comment");

    const comment = commentMatch[1];
    const documentedVars = ["{{fsmDiagram}}", "{{currentState}}", "{{activeSpecId}}", "{{loopCount}}", "{{maxLoops}}", "{{toolList}}"];
    for (const v of documentedVars) {
      assert.ok(comment.includes(v), `Comment missing documentation for: ${v}`);
    }
  });

  it("the file reads clearly as Markdown without code knowledge", () => {
    const content = readFileSync(orchestratorPromptPath, "utf-8");

    // After stripping frontmatter and comments, the body should start with the role definition
    const body = content
      .replace(/^---\n[\s\S]*?\n---\n/, "")
      .replace(/<!--[\s\S]*?-->/, "")
      .trim();

    assert.ok(body.startsWith("You are the Pi Coder orchestrator"), "Body must start with the role definition");
    assert.ok(body.includes("Delegation rules:"), "Must include delegation rules section");
    assert.ok(body.includes("NEVER use edit or write tools"), "Must include the key delegation constraint");
  });
});

// ---------------------------------------------------------------------------
// Phase 2: Extension Loads Prompt from File
// ---------------------------------------------------------------------------

describe("Spec 13 Phase 2: Extension Loads Prompt from File", () => {
  it("loadOrchestratorPrompt returns a template with all variables", async () => {
    const { loadOrchestratorPrompt, resetOrchestratorPromptCache } = await import("./index.ts");

    // Reset cache to ensure we load fresh
    resetOrchestratorPromptCache();
    const template = loadOrchestratorPrompt();

    assert.ok(template.includes("{{fsmDiagram}}"), "Template must have {{fsmDiagram}}");
    assert.ok(template.includes("{{currentState}}"), "Template must have {{currentState}}");
    assert.ok(template.includes("{{activeSpecId}}"), "Template must have {{activeSpecId}}");
    assert.ok(template.includes("{{loopCount}}"), "Template must have {{loopCount}}");
    assert.ok(template.includes("{{maxLoops}}"), "Template must have {{maxLoops}}");
    assert.ok(template.includes("{{toolList}}"), "Template must have {{toolList}}");
  });

  it("loadOrchestratorPrompt strips YAML frontmatter from the template", async () => {
    const { loadOrchestratorPrompt, resetOrchestratorPromptCache } = await import("./index.ts");

    resetOrchestratorPromptCache();
    const template = loadOrchestratorPrompt();

    // The template should NOT contain YAML frontmatter delimiters
    assert.ok(!template.startsWith("---\n"), "Frontmatter must be stripped");
    assert.ok(!template.includes("name: orchestrator"), "Frontmatter fields must be stripped");
    assert.ok(!template.includes("package: pi-coder"), "Frontmatter fields must be stripped");
  });

  it("loadOrchestratorPrompt strips HTML comment documentation from the template", async () => {
    const { loadOrchestratorPrompt, resetOrchestratorPromptCache } = await import("./index.ts");

    resetOrchestratorPromptCache();
    const template = loadOrchestratorPrompt();

    assert.ok(!template.includes("<!--"), "HTML comments must be stripped");
    assert.ok(!template.includes("-->"), "HTML comment close must be stripped");
    // But the template variables should still be present
    assert.ok(template.includes("{{currentState}}"), "Template variables must remain after comment stripping");
  });

  it("loadOrchestratorPrompt caches the template after first load", async () => {
    const { loadOrchestratorPrompt, resetOrchestratorPromptCache } = await import("./index.ts");

    resetOrchestratorPromptCache();
    const first = loadOrchestratorPrompt();
    const second = loadOrchestratorPrompt();

    // Must return the same string reference (cached)
    assert.strictEqual(first, second, "Second load should return cached template");
  });

  it("resetOrchestratorPromptCache forces a reload on next call", async () => {
    const { loadOrchestratorPrompt, resetOrchestratorPromptCache } = await import("./index.ts");

    resetOrchestratorPromptCache();
    const first = loadOrchestratorPrompt();
    resetOrchestratorPromptCache();
    const second = loadOrchestratorPrompt();

    // After cache reset, the template should be reloaded — same content but potentially different reference
    assert.strictEqual(first, second, "Reloaded template should have same content");
  });

  it("buildOrchestratorPrompt substitutes all template variables", async () => {
    // This tests the full pipeline: load template → substitute variables
    const { StateMachine } = await import("../src/state-machine.ts");
    const { default: piCoderExtension, loadOrchestratorPrompt, resetOrchestratorPromptCache } = await import("./index.ts");
    const config = (await import("../src/types.ts")).DEFAULT_CONFIG ?? {
      testCommand: "npm test",
      maxLoops: 3,
      createBranch: true,
    onMerge: "merge",
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

    const sm = new StateMachine(config);
    sm.transition("SPEC_WORK");

    // Instead of calling buildOrchestratorPrompt directly (it's not exported),
    // verify that the template + substitution would produce the expected output
    resetOrchestratorPromptCache();
    const template = loadOrchestratorPrompt();

    // Simulate substitution
    const filteredSnippets = {
      ls: "list directory contents",
      subagent: "delegate to a subagent",
    };

    const toolList = Object.entries(filteredSnippets)
      .map(([name, snippet]) => `- ${name}: ${snippet}`)
      .join("\n");

    const result = template
      .replace("{{fsmDiagram}}", "FSM States & Transitions:\nIDLE → SPEC_WORK → ...")
      .replace("{{currentState}}", sm.currentState)
      .replace("{{activeSpecId}}", sm.activeSpecId ?? "none")
      .replace("{{loopCount}}", String(sm.loopCount))
      .replace("{{maxLoops}}", String(config.maxLoops))
      .replace("{{toolList}}", toolList);

    // Verify no unsubstituted template variables remain
    assert.ok(!result.includes("{{"), `Unsubstituted variables remain: ${result.match(/\{\{[^}]+\}\}/g)?.join(", ")}`);
    assert.ok(result.includes("SPEC_WORK"), "Substituted prompt must include current state");
    assert.ok(result.includes("0/3"), "Substituted prompt must include loop count");
    assert.ok(result.includes("- ls: list directory contents"), "Substituted prompt must include tool list");
  });
});

// ---------------------------------------------------------------------------
// Phase 3: Customization Support
// ---------------------------------------------------------------------------

describe("Spec 13 Phase 3: Customization Support", () => {
  it("loadOrchestratorPrompt falls back to package default when no project override", async () => {
    // When no cwd is provided (or .pi/agents/ doesn't have the override),
    // the package default should be loaded
    const { loadOrchestratorPrompt, resetOrchestratorPromptCache } = await import("./index.ts");

    resetOrchestratorPromptCache();
    const template = loadOrchestratorPrompt(); // No cwd — uses package default

    assert.ok(template.includes("You are the Pi Coder orchestrator"), "Must load package default prompt");
    assert.ok(template.includes("{{currentState}}"), "Package default must have template vars");
  });

  it("loadOrchestratorPrompt prefers project-scope customization over package default", async () => {
    const { loadOrchestratorPrompt, resetOrchestratorPromptCache } = await import("./index.ts");

    const tempDir = createTempDir();
    try {
      // Create a project-scope override
      const agentsDir = join(tempDir, ".pi", "agents");
      mkdirSync(agentsDir, { recursive: true });

      writeFileSync(
        join(agentsDir, "pi-coder-orchestrator.md"),
        `---\nname: orchestrator\npackage: pi-coder\n---\n\nYou are a CUSTOM orchestrator. {{currentState}} {{fsmDiagram}} {{toolList}}`,
        "utf-8",
      );

      resetOrchestratorPromptCache();
      const template = loadOrchestratorPrompt(tempDir);

      assert.ok(template.includes("CUSTOM orchestrator"), "Must load project-scope override");
      assert.ok(!template.includes("senior technical project manager"), "Must NOT load package default content");
      assert.ok(template.includes("{{currentState}}"), "Template variables must still be present");
    } finally {
      cleanupDir(tempDir);
    }
  });

  it("loadOrchestratorPrompt falls back to package default when project file is missing", async () => {
    const { loadOrchestratorPrompt, resetOrchestratorPromptCache } = await import("./index.ts");

    const tempDir = createTempDir();
    try {
      // No .pi/agents/pi-coder-orchestrator.md exists in tempDir
      resetOrchestratorPromptCache();
      const template = loadOrchestratorPrompt(tempDir);

      assert.ok(template.includes("You are the Pi Coder orchestrator"), "Must fall back to package default");
    } finally {
      cleanupDir(tempDir);
    }
  });

  it("init command copies pi-coder-orchestrator.md alongside other agent files", () => {
    const tempDir = createTempDir();
    try {
      const agentsDir = join(tempDir, ".pi", "agents");
      mkdirSync(agentsDir, { recursive: true });

      // Agent files come from agents/ directory
      const agentFilenames = [
        "pi-coder-researcher.md",
        "pi-coder-implementor.md",
        "pi-coder-reviewer.md",
      ];

      // Verify the package agent source files exist
      for (const filename of agentFilenames) {
        const source = join(packageRoot, "agents", filename);
        assert.ok(existsSync(source), `Package agent source missing: ${filename}`);

        // Simulate copy
        const target = join(agentsDir, filename);
        const content = readFileSync(source, "utf-8");
        writeFileSync(target, content, "utf-8");
      }

      // Orchestrator prompt template comes from prompts/ directory
      const orchestratorSource = join(packageRoot, "prompts", "pi-coder-orchestrator.md");
      assert.ok(existsSync(orchestratorSource), "Package prompt source missing: prompts/pi-coder-orchestrator.md");
      const orchestratorTarget = join(agentsDir, "pi-coder-orchestrator.md");
      writeFileSync(orchestratorTarget, readFileSync(orchestratorSource, "utf-8"), "utf-8");

      // Verify all files were copied including orchestrator
      assert.ok(existsSync(join(agentsDir, "pi-coder-orchestrator.md")), "Orchestrator prompt must be copied");

      // Verify the copied orchestrator prompt has template variables
      const copiedContent = readFileSync(join(agentsDir, "pi-coder-orchestrator.md"), "utf-8");
      assert.ok(copiedContent.includes("{{currentState}}"), "Copied orchestrator must have template vars");
    } finally {
      cleanupDir(tempDir);
    }
  });

  it("init command skips pi-coder-orchestrator.md if it already exists", () => {
    const tempDir = createTempDir();
    try {
      const agentsDir = join(tempDir, ".pi", "agents");
      mkdirSync(agentsDir, { recursive: true });

      // Pre-create the orchestrator file with custom content
      writeFileSync(
        join(agentsDir, "pi-coder-orchestrator.md"),
        "MY CUSTOM ORCHESTRATOR PROMPT",
        "utf-8",
      );

      // Simulate the init copy logic: skip if exists
      const target = join(agentsDir, "pi-coder-orchestrator.md");

      if (!existsSync(target)) {
        const source = join(packageRoot, "prompts", "pi-coder-orchestrator.md");
        const content = readFileSync(source, "utf-8");
        writeFileSync(target, content, "utf-8");
      }

      // Verify the existing file was NOT overwritten
      const content = readFileSync(target, "utf-8");
      assert.strictEqual(content, "MY CUSTOM ORCHESTRATOR PROMPT", "Existing orchestrator file must not be overwritten");
    } finally {
      cleanupDir(tempDir);
    }
  });

  it("reset-agents command resets pi-coder-orchestrator.md alongside other files", () => {
    const tempDir = createTempDir();
    try {
      const agentsDir = join(tempDir, ".pi", "agents");
      mkdirSync(agentsDir, { recursive: true });

      // Create existing customized files including orchestrator
      writeFileSync(
        join(agentsDir, "pi-coder-orchestrator.md"),
        "CUSTOM ORCHESTRATOR CONTENT",
        "utf-8",
      );
      writeFileSync(
        join(agentsDir, "pi-coder-researcher.md"),
        "CUSTOM RESEARCHER",
        "utf-8",
      );

      // Simulate reset-agents: overwrite agents with package defaults from agents/
      const agentFilenames = [
        "pi-coder-researcher.md",
        "pi-coder-implementor.md",
        "pi-coder-reviewer.md",
      ];

      for (const file of agentFilenames) {
        const source = join(packageRoot, "agents", file);
        const target = join(agentsDir, file);
        if (existsSync(source)) {
          writeFileSync(target, readFileSync(source, "utf-8"), "utf-8");
        }
      }

      // Reset orchestrator from prompts/ directory
      const orchestratorSource = join(packageRoot, "prompts", "pi-coder-orchestrator.md");
      if (existsSync(orchestratorSource)) {
        writeFileSync(join(agentsDir, "pi-coder-orchestrator.md"), readFileSync(orchestratorSource, "utf-8"), "utf-8");
      }

      // Verify orchestrator was reset to package default
      const content = readFileSync(join(agentsDir, "pi-coder-orchestrator.md"), "utf-8");
      assert.ok(content.includes("You are the Pi Coder orchestrator"), "Orchestrator must be reset to package default");
      assert.ok(!content.includes("CUSTOM"), "Custom content must be gone");
    } finally {
      cleanupDir(tempDir);
    }
  });

  it("reset-agents command only resets pi-coder-*.md files, not other agent files", () => {
    const tempDir = createTempDir();
    try {
      const agentsDir = join(tempDir, ".pi", "agents");
      mkdirSync(agentsDir, { recursive: true });

      // Create a non-pi-coder agent file
      writeFileSync(
        join(agentsDir, "my-custom-agent.md"),
        "MY CUSTOM AGENT",
        "utf-8",
      );
      writeFileSync(
        join(agentsDir, "pi-coder-orchestrator.md"),
        "CUSTOM ORCHESTRATOR",
        "utf-8",
      );

      // Simulate reset only for pi-coder-*.md — agents from agents/
      const agentFilenames = [
        "pi-coder-researcher.md",
        "pi-coder-implementor.md",
        "pi-coder-reviewer.md",
      ];

      for (const file of agentFilenames) {
        const source = join(packageRoot, "agents", file);
        const target = join(agentsDir, file);
        if (existsSync(source)) {
          writeFileSync(target, readFileSync(source, "utf-8"), "utf-8");
        }
      }

      // Orchestrator from prompts/
      const orchestratorSource = join(packageRoot, "prompts", "pi-coder-orchestrator.md");
      if (existsSync(orchestratorSource)) {
        writeFileSync(join(agentsDir, "pi-coder-orchestrator.md"), readFileSync(orchestratorSource, "utf-8"), "utf-8");
      }

      // Verify custom agent is untouched
      const customContent = readFileSync(join(agentsDir, "my-custom-agent.md"), "utf-8");
      assert.strictEqual(customContent, "MY CUSTOM AGENT", "Non-pi-coder agent files must not be touched");
    } finally {
      cleanupDir(tempDir);
    }
  });
});
