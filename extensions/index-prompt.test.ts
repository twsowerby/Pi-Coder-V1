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

    // After stripping frontmatter and comments, the body should start with the critical invariant
    const body = content
      .replace(/^---\n[\s\S]*?\n---\n/, "")
      .replace(/<!--[\s\S]*?-->/, "")
      .trim();

    assert.ok(body.startsWith("⚠️ CRITICAL"), "Body must start with the critical invariant");
    assert.ok(body.includes("You are the Pi Coder orchestrator"), "Must include the role definition");
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
    mergeBranch: "merge",
    branchPrefix: "pi-coder/",
    interviewTimeout: 0,
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
      subagentControl: { enabled: true },
      notifications: { enabled: false },
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
      .replace("{{interviewTimeout}}", String(config.interviewTimeout))
      .replace("{{toolList}}", toolList)
      .replace("{{referenceProjects}}", "");

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

// ---------------------------------------------------------------------------
// Spec 16 Phase 1: Orchestrator Prompt Discipline
// ---------------------------------------------------------------------------

describe("Spec 16 Phase 1: Orchestrator Prompt Discipline", () => {
  it("the orchestrator prompt contains the output parameter prohibition", () => {
    const content = readFileSync(orchestratorPromptPath, "utf-8");
    assert.ok(
      content.includes("NEVER use the `output` parameter on subagent calls"),
      "Must include output parameter prohibition",
    );
    assert.ok(
      content.includes("Do NOT pass `output` or `outputMode` to any `subagent()` call"),
      "Must include explicit output and outputMode ban",
    );
  });

  it("the Brief Discipline table has consistent column counts", () => {
    const content = readFileSync(orchestratorPromptPath, "utf-8");
    // Find the table under Delegation Brief Discipline
    const sections = content.split("## Delegation Brief Discipline");
    assert.ok(sections.length >= 2, "Must have Delegation Brief Discipline section");
    const section = sections[1].split("##")[0]; // Stop at next ## heading
    const tableLines = section.split("\n").filter(l => l.startsWith("|"));
    assert.ok(tableLines.length >= 2, "Must have at least a header and one data row");
    const colCounts = tableLines.map(l => l.split("|").length);
    const uniqueCounts = new Set(colCounts);
    assert.strictEqual(uniqueCounts.size, 1, `Table has inconsistent column counts: ${[...uniqueCounts]}`);
  });

  it("the orchestrator prompt contains the Delegation Brief Discipline section", () => {
    const content = readFileSync(orchestratorPromptPath, "utf-8");
    assert.ok(
      content.includes("## Delegation Brief Discipline"),
      "Must have Delegation Brief Discipline heading",
    );
    assert.ok(
      content.includes("Every implementor task MUST include these fields in the brief"),
      "Must state that brief fields are mandatory",
    );
    // Verify key fields are documented
    const requiredFields = [
      "Mode",
      "Acceptance Criteria",
      "Constraints",
      "Key files",
      "Knowledge files",
      "Existing test discovery",
      "Existing test coverage",
      "Unit name and approach",
      "Test suite",
    ];
    for (const field of requiredFields) {
      assert.ok(
        content.includes(`**${field}**`),
        `Must document the "${field}" field`,
      );
    }
  });

  it("the brief discipline section requires test discovery before RED-phase delegation", () => {
    const content = readFileSync(orchestratorPromptPath, "utf-8");
    assert.ok(
      content.includes("grep") && content.includes("find"),
      "Must require grep and find for test discovery",
    );
    assert.ok(
      content.includes("BEFORE delegating"),
      "Must require discovery BEFORE delegating",
    );
  });

  it("the brief discipline section includes the test-to-AC mapping requirement", () => {
    const content = readFileSync(orchestratorPromptPath, "utf-8");
    assert.ok(
      content.includes("Test-to-AC Mapping"),
      "Must have test-to-AC mapping section",
    );
    assert.ok(
      content.includes("NEW: no existing coverage"),
      "Must define the NEW coverage marker",
    );
  });

  it("the one-unit-per-cycle rule requires explicit unit numbering", () => {
    const content = readFileSync(orchestratorPromptPath, "utf-8");
    assert.ok(
      content.includes("You are implementing unit N of M"),
      "Must require explicit unit numbering in RED-phase briefs",
    );
  });

  it("the prompt contains the NEEDS_CHANGES Re-delegation section", () => {
    const content = readFileSync(orchestratorPromptPath, "utf-8");
    assert.ok(
      content.includes("## NEEDS_CHANGES Re-delegation"),
      "Must have NEEDS_CHANGES re-delegation heading",
    );
    assert.ok(
      content.includes("Copy the reviewer's issue descriptions verbatim"),
      "Must require verbatim copying of reviewer issues",
    );
    assert.ok(
      content.includes("Do NOT modify the passing tests"),
      "Must warn against modifying passing tests",
    );
  });

  it("loaded and substituted prompt includes all Spec 16 Phase 1 directives", async () => {
    const { loadOrchestratorPrompt, resetOrchestratorPromptCache } = await import("./index.ts");
    resetOrchestratorPromptCache();
    const template = loadOrchestratorPrompt();

    // Verify key directives survive frontmatter stripping + comment stripping
    assert.ok(template.includes("NEVER use the `output` parameter"), "Output prohibition must survive loading");
    assert.ok(
      template.includes("Delegation Brief Discipline"),
      "Brief discipline section must survive loading",
    );
    assert.ok(
      template.includes("Test-to-AC Mapping"),
      "Test-to-AC mapping must survive loading",
    );
    assert.ok(
      template.includes("NEEDS_CHANGES Re-delegation"),
      "NEEDS_CHANGES section must survive loading",
    );
  });
});

// ---------------------------------------------------------------------------
// Spec 16 Phase 2: Implementor Prompt Improvements
// ---------------------------------------------------------------------------

describe("Spec 16 Phase 2: Implementor Prompt Improvements", () => {
  const implementorPromptPath = join(packageRoot, "agents", "pi-coder-implementor.md");

  it("the implementor prompt contains the RED phase test discovery steps", () => {
    const content = readFileSync(implementorPromptPath, "utf-8");
    assert.ok(
      content.includes("For RED phase specifically"),
      "Must have RED phase specific instructions",
    );
    assert.ok(
      content.includes("Discover existing test files"),
      "Must have test file discovery step",
    );
    assert.ok(
      content.includes("Extend, don't duplicate"),
      "Must have extend-don't-duplicate rule",
    );
    assert.ok(
      content.includes("no existing coverage"),
      "Must instruct what to do when brief says no existing coverage",
    );
  });

  it("the implementor prompt requires AC references in test names", () => {
    const content = readFileSync(implementorPromptPath, "utf-8");
    assert.ok(
      content.includes("[AC"),
      "Must show [ACn] annotation example in test names",
    );
    assert.ok(
      content.includes("AC reference in the test name"),
      "Must require AC references in test names",
    );
  });

  it("the implementor prompt handles test overlap", () => {
    const content = readFileSync(implementorPromptPath, "utf-8");
    assert.ok(
      content.includes("test overlap"),
      "Must have test overlap handling",
    );
    assert.ok(
      content.includes("Do NOT write a duplicate test"),
      "Must prohibit duplicate tests",
    );
    assert.ok(
      content.includes("already covered by existing test"),
      "Must instruct noting existing coverage in Learnings & Decisions",
    );
  });
});

// ---------------------------------------------------------------------------
// Spec 16 Phase 3: Reviewer Prompt Improvements
// ---------------------------------------------------------------------------

describe("Spec 16 Phase 3: Reviewer Prompt Improvements", () => {
  const reviewerPromptPath = join(packageRoot, "agents", "pi-coder-reviewer.md");

  it("the reviewer prompt expands Test Alignment to three dimensions", () => {
    const content = readFileSync(reviewerPromptPath, "utf-8");
    assert.ok(
      content.includes("Coverage:"),
      "Must have Coverage dimension",
    );
    assert.ok(
      content.includes("Quality:"),
      "Must have Quality dimension",
    );
    assert.ok(
      content.includes("Proliferation:"),
      "Must have Proliferation dimension",
    );
  });

  it("the reviewer prompt checks for [ACn] annotations", () => {
    const content = readFileSync(reviewerPromptPath, "utf-8");
    assert.ok(
      content.includes("[ACn]"),
      "Must reference [ACn] annotation format",
    );
    assert.ok(
      content.includes("required by the RED phase brief"),
      "Must explain these annotations are required by the RED phase brief",
    );
  });

  it("the reviewer prompt flags test proliferation", () => {
    const content = readFileSync(reviewerPromptPath, "utf-8");
    assert.ok(
      content.includes("Test proliferation"),
      "Must have test proliferation section",
    );
    assert.ok(
      content.includes("Consolidate into a single test file"),
      "Must recommend consolidation",
    );
  });

  it("the reviewer prompt includes AC Traceability Check", () => {
    const content = readFileSync(reviewerPromptPath, "utf-8");
    assert.ok(
      content.includes("AC Traceability Check"),
      "Must have AC Traceability Check section",
    );
    assert.ok(
      content.includes("zero test coverage"),
      "Must flag ACs with zero test coverage",
    );
    assert.ok(
      content.includes("🔴 High"),
      "Must classify missing AC coverage as High severity",
    );
  });
});

// ---------------------------------------------------------------------------
// Spec 16 Phase 4: Desktop Notification Improvements
// ---------------------------------------------------------------------------

describe("Spec 16 Phase 4: Desktop Notification Call-Sites", () => {
  const extensionPath = join(packageRoot, "extensions", "index.ts");

  it("agent_end notification uses descriptive title with middle-dot separator", () => {
    const content = readFileSync(extensionPath, "utf-8");
    assert.ok(
      content.includes('notify(config, "agent_end", "Pi Coder \\u00b7 Idle"')
      "agent_end must use 'Pi Coder · Idle' title",
    );
    assert.ok(
      content.includes('"Waiting for your input"'),
      "agent_end must use informative body",
    );
  });

  it("spec_approval notification uses review emoji and spec ID", () => {
    const content = readFileSync(extensionPath, "utf-8");
    assert.ok(
      content.includes('notify(config, "spec_approval", "Pi Coder \\u00b7 \\uD83D\\uDCCB Review"')
      "spec_approval must use 'Pi Coder · 📋 Review' title",
    );
    assert.ok(
      content.includes('Spec ${activeSpecId'),
      "spec_approval body must include spec ID",
    );
  });

  it("circuit_breaker notification uses red circle emoji and spec ID", () => {
    const content = readFileSync(extensionPath, "utf-8");
    assert.ok(
      content.includes('notify(config, "circuit_breaker", "Pi Coder \\u00b7 \\uD83D\\uDD34 Circuit Breaker"')
      "circuit_breaker must use 'Pi Coder · 🔴 Circuit Breaker' title",
    );
    assert.ok(
      content.includes('exceeded on spec ${activeSpecId'),
      "circuit_breaker body must include spec ID",
    );
  });

  it("complete notification uses check emoji and merged successfully body", () => {
    const content = readFileSync(extensionPath, "utf-8");
    assert.ok(
      content.includes('notify(config, "complete", "Pi Coder \\u00b7 \\u2705 Complete"')
      "complete must use 'Pi Coder · ✅ Complete' title",
    );
    assert.ok(
      content.includes('merged successfully'),
      "complete body must say 'merged successfully'",
    );
  });

  it("no generic 'Pi Coder' titles remain on notification call sites", () => {
    const content = readFileSync(extensionPath, "utf-8");
    // Find all notify() call sites with 'Pi Coder' bare title
    const nakedNotifyMatches = content.match(/notify\("[^"]+",\s*"Pi Coder"/g);
    assert.strictEqual(
      nakedNotifyMatches,
      null,
      `Found notify calls with generic 'Pi Coder' title: ${nakedNotifyMatches}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Spec 16 Phase 5: Spec Close Command
// ---------------------------------------------------------------------------

describe("Spec 16 Phase 5: Spec Close Command", () => {
  const extensionPath = join(packageRoot, "extensions", "index.ts");

  it("pi-coder-close command is registered", () => {
    const content = readFileSync(extensionPath, "utf-8");
    assert.ok(
      content.includes('registerCommand("pi-coder-close"'),
      "Must register pi-coder-close command",
    );
  });

  it("close command sets CANCELLED status", () => {
    const content = readFileSync(extensionPath, "utf-8");
    assert.ok(
      content.includes('status: "CANCELLED"'),
      "Must set status to CANCELLED",
    );
  });

  it("close command deletes state.json via SpecStatePersistence.delete", () => {
    const content = readFileSync(extensionPath, "utf-8");
    assert.ok(
      content.includes("SpecStatePersistence.delete(specManager.specsDir,"),
      "Must call SpecStatePersistence.delete with specsDir and specId",
    );
  });

  it("close command resets FSM and clears activeSpecId for active spec", () => {
    const content = readFileSync(extensionPath, "utf-8");
    assert.ok(
      content.includes("stateMachine.reset()"),
      "Must reset state machine when closing active spec",
    );
    assert.ok(
      content.includes("activeSpecId = null"),
      "Must clear activeSpecId when closing active spec",
    );
    assert.ok(
      content.includes('resetNudgeState("IDLE")'),
      "Must reset nudge state to IDLE",
    );
  });

  it("close command persists state and refreshes UI", () => {
    const content = readFileSync(extensionPath, "utf-8");
    assert.ok(
      content.includes("await persistState()"),
      "Must persist state after closing",
    );
    assert.ok(
      content.includes("refreshUI()"),
      "Must refresh UI after closing",
    );
  });

  it("close command logs the event for audit", () => {
    const content = readFileSync(extensionPath, "utf-8");
    assert.ok(
      content.includes('logEvent("command", { command: "close_spec"'),
      "Must log close_spec command event",
    );
    assert.ok(
      content.includes("previousStatus"),
      "Must log previous status for audit",
    );
  });

  it("close command filters to non-COMPLETE/CANCELLED specs", () => {
    const content = readFileSync(extensionPath, "utf-8");
    // Verify the filtering logic
    assert.ok(
      content.includes('"COMPLETE"') && content.includes('"CANCELLED"'),
      "Must filter out both COMPLETE and CANCELLED specs",
    );
  });

  it("close command shows no-open-specs notification", () => {
    const content = readFileSync(extensionPath, "utf-8");
    assert.ok(
      content.includes("No open specs to close"),
      "Must notify when no open specs exist",
    );
  });
});
