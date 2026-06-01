/**
 * Pi Coder V1 — Prompt Builders
 *
 * System prompt construction for TDD (Orchestrator), Light, and Plan modes.
 * Includes template loading, caching, and variable substitution.
 *
 * Extracted from extensions/index.ts for testability.
 */

import type { PiCoderConfig, IStateMachine } from "../types.ts";
import { formatReferenceProjects, formatTestSuites } from "./formatters.ts";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Cached prompt templates
// ---------------------------------------------------------------------------

/** Cached orchestrator prompt template loaded from .md file. */
let orchestratorPromptTemplate: string | null = null;

/** Plan mode prompt template — cached for the session. */
let planModePromptTemplate: string | null = null;

/** Light mode prompt template — cached for the session. */
let lightModePromptTemplate: string | null = null;

// ---------------------------------------------------------------------------
// Cache reset functions
// ---------------------------------------------------------------------------

/** Reset the cached plan mode prompt template. Called by reset-agents. */
export function resetPlanModePromptCache(): void {
  planModePromptTemplate = null;
}

/**
 * Reset the cached orchestrator prompt template.
 * Called when the prompt file may have changed (e.g., after reset-agents).
 * Exported for use by commands and tests.
 */
export function resetOrchestratorPromptCache(): void {
  orchestratorPromptTemplate = null;
}

/** Reset the cached light mode prompt template. */
export function resetLightModePromptCache(): void {
  lightModePromptTemplate = null;
}

// ---------------------------------------------------------------------------
// Template loader
// ---------------------------------------------------------------------------

/**
 * Load the orchestrator prompt template from the .md file.
 *
 * Checks for a project-scope customization at .pi/agents/pi-coder-orchestrator.md
 * first, falling back to the package default at agents/pi-coder-orchestrator.md.
 *
 * Strips the HTML comment block (template variable documentation) from the top,
 * then caches the template string in module scope.
 */
export function loadOrchestratorPrompt(cwd?: string): string {
  if (orchestratorPromptTemplate !== null) {
    return orchestratorPromptTemplate;
  }

  // Resolve the package's own agents/ directory relative to this extension file
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const packageDefaultPath = join(thisDir, "..", "prompts", "pi-coder-orchestrator.md");

  // Check for project-scope customization
  const projectOverridePath = cwd
    ? join(cwd, ".pi", "agents", "pi-coder-orchestrator.md")
    : null;

  let filePath = packageDefaultPath;
  if (projectOverridePath && existsSync(projectOverridePath)) {
    filePath = projectOverridePath;
  }

  if (!existsSync(filePath)) {
    // Fallback: if the file doesn't exist anywhere, use a minimal inline prompt
    // (should never happen in production, but prevents crashes during testing)
    orchestratorPromptTemplate = "You are the Pi Coder orchestrator. You delegate all implementation to subagents.\n\n{{fsmDiagram}}\n\nCurrent state: {{currentState}}\nActive spec: {{activeSpecId}}\nLoop count: {{loopCount}}/{{maxLoops}}\n\nAvailable tools:\n{{toolList}}";
    return orchestratorPromptTemplate;
  }

  let content = readFileSync(filePath, "utf-8");

  // Strip YAML frontmatter (between --- delimiters)
  content = content.replace(/^---\n[\s\S]*?\n---\n/, "");

  // Strip the HTML comment block (template variable documentation)
  content = content.replace(/<!--[\s\S]*?-->/, "");

  // Clean up any leading blank lines left after stripping
  content = content.replace(/^\n+/, "");

  orchestratorPromptTemplate = content;
  return orchestratorPromptTemplate;
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

function buildPlanModePrompt(filteredSnippets: Record<string, string>, config: PiCoderConfig): string {
  if (!planModePromptTemplate) {
    const promptPath = join(dirname(fileURLToPath(import.meta.url)), "..", "prompts", "pi-coder-plan.md");
    try {
      if (existsSync(promptPath)) {
        planModePromptTemplate = readFileSync(promptPath, "utf-8");
        const stripped = planModePromptTemplate.replace(/^---\n[\s\S]*?---\n/, "");
        planModePromptTemplate = stripped.replace(/^\n+/, "");
      }
    } catch {
      // Fall through to built-in
    }

    if (!planModePromptTemplate) {
      planModePromptTemplate = `You are the Pi Coder Plan Mode assistant — an investigation and discussion assistant.

You do NOT edit files or implement anything. You investigate, discuss, and plan.
Only delegate to pi-coder.researcher for investigation — no implementor or reviewer.

Guidelines:
- Explore the codebase by delegating to pi-coder.researcher
- Discuss architectural approaches with the user
- Use interview for structured requirements gathering (timeout: {{interviewTimeout}}s)
- Save findings to knowledge files with upsert_knowledge for later Light/TDD sessions
- When you find something worth implementing, suggest switching to Light or TDD mode with /pi-coder
- No specs, no git, no FSM state machine

Available tools:
{{toolList}}`;
    }
  }

  const toolList = Object.entries(filteredSnippets)
    .map(([name, snippet]) => `- ${name}: ${snippet}`)
    .join("\n");

  return planModePromptTemplate!
    .replace("{{interviewTimeout}}", String(config.interviewTimeout))
    .replace("{{toolList}}", toolList)
    .replace("{{referenceProjects}}", formatReferenceProjects(config.referenceProjects))
    .replace("{{testSuites}}", formatTestSuites(config.testCommands));
}

/**
 * Build the orchestrator system prompt from the loaded template.
 * Substitutes template variables with dynamic values.
 * This replaces the default "expert coding assistant" identity entirely.
 */
function buildOrchestratorPrompt(
  sm: IStateMachine,
  filteredSnippets: Record<string, string>,
  config: PiCoderConfig,
  activeSpecId: string | null,
): string {
  const template = loadOrchestratorPrompt();

  const toolList = Object.entries(filteredSnippets)
    .map(([name, snippet]) => `- ${name}: ${snippet}`)
    .join("\n");

  return template
    .replace("{{fsmDiagram}}", sm.buildDiagram())
    .replace("{{currentState}}", sm.currentState)
    .replace("{{activeSpecId}}", activeSpecId ?? "none")
    .replace("{{loopCount}}", String(sm.loopCount))
    .replace("{{maxLoops}}", String(config.maxLoops))
    .replace("{{interviewTimeout}}", String(config.interviewTimeout))
    .replace("{{toolList}}", toolList)
    .replace("{{referenceProjects}}", formatReferenceProjects(config.referenceProjects))
    .replace("{{testSuites}}", formatTestSuites(config.testCommands));
}

/**
 * Build the light mode system prompt.
 * Simplified: no FSM, no spec workflow, just delegation + tests + knowledge.
 * Reads from prompts/pi-coder-light.md if available, otherwise uses a built-in fallback.
 */
function buildLightModePrompt(sm: IStateMachine, filteredSnippets: Record<string, string>, config: PiCoderConfig, activeSpecId: string | null): string {
  if (!lightModePromptTemplate) {
    // Try to load from file
    const promptPath = join(dirname(fileURLToPath(import.meta.url)), "..", "prompts", "pi-coder-light.md");
    try {
      if (existsSync(promptPath)) {
        lightModePromptTemplate = readFileSync(promptPath, "utf-8");
        // Strip YAML frontmatter if present
        const stripped = lightModePromptTemplate.replace(/^---\n[\s\S]*?---\n/, "");
        lightModePromptTemplate = stripped.replace(/^\n+/, "");
      }
    } catch {
      // Fall through to built-in
    }

    if (!lightModePromptTemplate) {
      // Built-in fallback — updated for Light FSM
      lightModePromptTemplate = `You are the Pi Coder assistant — a coding assistant that delegates implementation to specialized subagents. You are in LIGHT mode with a simplified FSM.

You do NOT edit files directly — you delegate all implementation work to subagents.

Current FSM state: {{currentState}}
Active spec: {{activeSpecId}}
Loop count: {{loopCount}}/{{maxLoops}}

Follow the FSM lifecycle: spec → implement → review → merge. There are no TDD RED/GREEN phases.

Available subagents:
- pi-coder.researcher — investigate the codebase, find information, understand patterns
- pi-coder.implementor — write code, run commands, make changes
- pi-coder.reviewer — review code, run tests, verify correctness

Guidelines:
- Run tests freely to check your progress (pi_coder_run_tests) — they're advisory, not gated
- Use pi_coder_git for version control operations
- Persist cross-cutting gotchas to knowledge (upsert_knowledge)
- Follow the FSM — don't skip spec approval or review
- If a task needs TDD discipline, suggest switching to TDD mode with /pi-coder

Available tools:
{{toolList}}`;
    }
  }

  const toolList = Object.entries(filteredSnippets)
    .map(([name, snippet]) => `- ${name}: ${snippet}`)
    .join("\n");

  return lightModePromptTemplate!
    .replace("{{fsmDiagram}}", sm.buildDiagram())
    .replace("{{currentState}}", sm.currentState)
    .replace("{{activeSpecId}}", activeSpecId ?? "none")
    .replace("{{loopCount}}", String(sm.loopCount))
    .replace("{{maxLoops}}", String(config.maxLoops))
    .replace("{{interviewTimeout}}", String(config.interviewTimeout))
    .replace("{{toolList}}", toolList)
    .replace("{{referenceProjects}}", formatReferenceProjects(config.referenceProjects))
    .replace("{{testSuites}}", formatTestSuites(config.testCommands));
}

// ---------------------------------------------------------------------------
// Re-export internal builders for use by index.ts event handlers
// ---------------------------------------------------------------------------

export { buildPlanModePrompt, buildOrchestratorPrompt, buildLightModePrompt };
