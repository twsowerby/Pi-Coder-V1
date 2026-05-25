/**
 * Pi Coder v1 — Extension Main: Core Event Hooks & System Prompt
 *
 * The heart of pi-coder. Intercepts pi's `before_agent_start`, `tool_call`,
 * and `tool_result` events to:
 * - Replace the system prompt with the orchestrator identity
 * - Guard tool calls against FSM state
 * - Auto-transition the FSM on deterministic results
 * - Implement the per-state nudge system
 *
 * Implements Spec 09 in 4 phases.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatSkillsForPrompt, type Skill } from "@earendil-works/pi-coding-agent";

import { StateMachine } from "../src/state-machine.ts";
import { GitOperations } from "../src/git.ts";
import { TddRunner } from "../src/tdd-runner.ts";
import { KnowledgeStore } from "../src/knowledge.ts";
import { SpecManager } from "../src/spec.ts";
import { StatePersistence } from "../src/state-persistence.ts";
import type { PersistedState } from "../src/state-persistence.ts";
import { registerTools } from "../src/tools.ts";
import type { PiCoderConfig, FSMState } from "../src/types.ts";
import { Logger, type LogEventType } from "../src/logger.ts";
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Tools available when pi-coder orchestrator mode is active. */
/** Tools available when pi-coder orchestrator mode is active. Exported for Spec 10 commands. */
export const ORCHESTRATOR_TOOLS = [
  "ls",
  "find",
  "grep",
  "subagent",
  "pi_coder_git",
  "pi_coder_run_tests",
  "upsert_knowledge",
  "pi_coder_save_spec",
  "pi_coder_read_spec",
  "pi_coder_advance_fsm",
  "interview",
  "intercom",
];

/** Tools available when pi-coder is toggled off (normal pi mode). Exported for use by Spec 10 commands. */
export const NORMAL_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];



// ---------------------------------------------------------------------------
// Module-scope state
// ---------------------------------------------------------------------------

export let piCoderActive = true;
export let subagentsAvailable = false;
export let stateMachine: StateMachine;
export let config: PiCoderConfig;

/** Nudge tracking state. */
interface NudgeState {
  fsmState: FSMState;
  turnsSinceEntry: number;
  actionAttempted: boolean;
  lastNudgeLevel: number;
}

export let nudgeState: NudgeState = {
  fsmState: "IDLE",
  turnsSinceEntry: 0,
  actionAttempted: false,
  lastNudgeLevel: 0,
};

/** Captured ExtensionContext from session_start — used by refreshUI(). */
let sessionCtx: ExtensionContext | null = null;

/** Whether a pi-coder subagent is currently running (for UI indicator). */
let subagentRunning = false;

// ---------------------------------------------------------------------------
// UI Refresh — updates widget, status line, and working indicator
// ---------------------------------------------------------------------------

/** Visual styling for each FSM state group. */
const STATE_STYLE: Record<string, { icon: string; color: "success" | "warning" | "error" | "accent" | "muted" | "dim" }> = {
  IDLE:               { icon: "○", color: "dim" },
  SPEC_WORK:          { icon: "●", color: "accent" },
  SPEC_APPROVED:      { icon: "✓", color: "success" },
  GIT_CHECKPOINT:     { icon: "⟳", color: "accent" },
  TDD_RED_WRITE:      { icon: "●", color: "warning" },
  TDD_RED_VALIDATE:   { icon: "●", color: "warning" },
  TDD_GREEN_WRITE:    { icon: "●", color: "accent" },
  TDD_GREEN_VALIDATE: { icon: "●", color: "accent" },
  REVIEWING:          { icon: "◎", color: "accent" },
  APPROVED:           { icon: "✓", color: "success" },
  NEEDS_CHANGES:      { icon: "✗", color: "error" },
  FINAL_APPROVAL:     { icon: "✓", color: "success" },
  MERGING:            { icon: "⟳", color: "accent" },
  COMPLETE:           { icon: "✓", color: "success" },
  BLOCKED:            { icon: "⚠", color: "error" },
};

/** Friendly labels for FSM states. */
const STATE_LABEL: Record<string, string> = {
  IDLE:               "Idle",
  SPEC_WORK:          "Spec Work",
  SPEC_APPROVED:      "Spec Approved",
  GIT_CHECKPOINT:     "Checkpoint",
  TDD_RED_WRITE:      "RED",
  TDD_RED_VALIDATE:   "RED Validate",
  TDD_GREEN_WRITE:    "GREEN",
  TDD_GREEN_VALIDATE: "GREEN Validate",
  REVIEWING:          "Reviewing",
  APPROVED:           "Approved",
  NEEDS_CHANGES:      "Needs Changes",
  FINAL_APPROVAL:     "Final Approval",
  MERGING:           "Merging",
  COMPLETE:           "Complete",
  BLOCKED:            "Blocked",
};

/** Refresh all pi-coder UI surfaces based on current state. */
function refreshUI(): void {
  if (!sessionCtx) return;
  const ctx = sessionCtx;

  if (!piCoderActive) {
    // Pi-coder OFF — clear everything
    ctx.ui.setWidget("pi-coder-state", undefined);
    ctx.ui.setStatus("pi-coder", undefined);
    ctx.ui.setWorkingIndicator(); // restore default
    return;
  }

  const state = stateMachine.currentState;
  const specId = stateMachine.activeSpecId;
  const loopCount = stateMachine.loopCount;
  const style = STATE_STYLE[state] ?? { icon: "●", color: "accent" as const };
  const label = STATE_LABEL[state] ?? state;
  const theme = ctx.ui.theme;

  // --- Widget above editor ---
  const isTdd = state.startsWith("TDD_");
  const showLoop = isTdd || state === "REVIEWING" || state === "NEEDS_CHANGES";

  // Build widget line using theme colors (string-array overload — no TUI components needed)
  let widgetLine = theme.fg(style.color, `${style.icon} ${label}`);
  if (specId) {
    widgetLine += theme.fg("dim", `  spec: `) + theme.fg("muted", specId);
  }
  if (showLoop && loopCount > 0) {
    widgetLine += theme.fg("dim", `  loop: `) + theme.fg("muted", String(loopCount)) + theme.fg("dim", `/${config.maxLoops}`);
  }
  if (subagentRunning) {
    widgetLine += theme.fg("dim", `  `) + theme.fg("accent", "▶ delegating");
  }

  ctx.ui.setWidget("pi-coder-state", [widgetLine], { placement: "aboveEditor" });

  // --- Footer status line ---
  let statusText: string;
  if (state === "BLOCKED") {
    statusText = theme.fg("error", "⚠ blocked");
  } else if (state === "COMPLETE") {
    statusText = theme.fg("success", "✓ complete");
  } else if (state === "IDLE") {
    statusText = theme.fg("dim", "idle");
  } else {
    statusText = theme.fg(style.color, `${style.icon} ${label}`);
    if (specId) {
      statusText += theme.fg("dim", ` · ${specId}`);
    }
  }
  ctx.ui.setStatus("pi-coder", statusText);

  // --- Working indicator ---
  if (subagentRunning) {
    // Pulsing dot while subagent is active
    ctx.ui.setWorkingIndicator({
      frames: [
        theme.fg("accent", "⏣"),
        theme.fg("muted", "⏣"),
      ],
      intervalMs: 500,
    });
  } else if (state === "IDLE" || state === "COMPLETE" || state === "BLOCKED") {
    // Restore default for terminal/waiting states
    ctx.ui.setWorkingIndicator();
  } else {
    // Active orchestrator — gentle breathing dot
    ctx.ui.setWorkingIndicator({
      frames: [
        theme.fg("accent", "●"),
        theme.fg("muted", "●"),
      ],
      intervalMs: 600,
    });
  }
}

// Module dependencies — set up during extension init
let gitOps: GitOperations;
let tddRunner: TddRunner;
let knowledgeStore: KnowledgeStore;
/** Spec manager instance — exported for use by Spec 10 commands. */
export let specManager: SpecManager;

/** Logger instance — initialized in session_start. */
let logger: Logger;

/** Session ID — generated once per extension initialization. */
let sessionId: string;

/** Track subagent start times for duration calculation. */
let subagentStartTime: number | null = null;

/** Track the last subagent agent name for pairing start/end events. */
let lastSubagentAgent: string | null = null;

/** Track lifecycle start time for wall clock duration. */
let lifecycleStartTime: number | null = null;

/** Track cumulative token usage across a spec lifecycle. */
let lifecycleTokens = { input: 0, output: 0, total: 0 };

/** State persistence instance — reads/writes .pi-coder/state.json. */
let statePersistence: StatePersistence;

/** Persist current FSM state to .pi-coder/state.json. Exported for use by commands. */
/** Tracks in-flight persistState() call to prevent concurrent tmp+rename races. */
let persistStatePromise: Promise<void> = Promise.resolve();

export async function persistState(): Promise<void> {
  // Serialize saves — each writes the full state, last one wins.
  // Wait for any in-flight save, then start ours.
  const prev = persistStatePromise.catch(() => {});
  const ourSave = prev.then(async () => {
    const fsmJson = stateMachine.toJSON();
    const state: PersistedState = {
      version: 1,
      piCoderActive,
      fsm: fsmJson,
      updatedAt: new Date().toISOString(),
    };
    await statePersistence.save(state);
  });
  persistStatePromise = ourSave;
  return ourSave;
}

/** Log a structured event. Convenience wrapper that adds sessionId and timestamp. */
function logEvent(type: LogEventType, payload: Record<string, unknown>): void {
  if (!logger) return; // Not initialized yet — no-op
  logger.log({
    timestamp: new Date().toISOString(),
    sessionId,
    type,
    payload,
  });
}

// ---------------------------------------------------------------------------
// Orchestrator System Prompt — loaded from .md file
// ---------------------------------------------------------------------------

/** Cached orchestrator prompt template loaded from .md file. */
let orchestratorPromptTemplate: string | null = null;

/**
 * Build the compact FSM diagram for the system prompt.
 * Generated programmatically from the state machine's transition table.
 */
function buildFSMDiagram(): string {
  return [
    "FSM States & Transitions:",
    "IDLE → SPEC_WORK → SPEC_APPROVED → GIT_CHECKPOINT →",
    "TDD_RED_WRITE → TDD_RED_VALIDATE →",
    "TDD_GREEN_WRITE → TDD_GREEN_VALIDATE → REVIEWING | (next_unit) TDD_RED_WRITE →",
    "(APPROVED → FINAL_APPROVAL → MERGING → COMPLETE) |",
    "(NEEDS_CHANGES → TDD_RED_WRITE | REVIEWING) | BLOCKED → user intervention",
    "",
    "Manual advances: Use pi_coder_advance_fsm to advance the FSM when your work in a state is complete.",
    "  IDLE → SPEC_WORK (start a new cycle)",
    "  SPEC_WORK → SPEC_APPROVED (spec ready for approval)",
    "  SPEC_APPROVED → GIT_CHECKPOINT (spec approved, time to checkpoint)",
    "  APPROVED → FINAL_APPROVAL (review passed, present for final OK)",
    "  FINAL_APPROVAL → MERGING (user gave final approval)",
    "  Any → IDLE (abort cycle)",
    "Auto-transitions: Happen on subagent/test results (deterministic).",
  ].join("\n");
}

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

/**
 * Reset the cached orchestrator prompt template.
 * Called when the prompt file may have changed (e.g., after reset-agents).
 * Exported for use by commands and tests.
 */
export function resetOrchestratorPromptCache(): void {
  orchestratorPromptTemplate = null;
}

/**
 * Build the orchestrator system prompt from the loaded template.
 * Substitutes template variables with dynamic values.
 * This replaces the default "expert coding assistant" identity entirely.
 */
function buildOrchestratorPrompt(
  sm: StateMachine,
  filteredSnippets: Record<string, string>,
): string {
  const template = loadOrchestratorPrompt();

  const toolList = Object.entries(filteredSnippets)
    .map(([name, snippet]) => `- ${name}: ${snippet}`)
    .join("\n");

  return template
    .replace("{{fsmDiagram}}", buildFSMDiagram())
    .replace("{{currentState}}", sm.currentState)
    .replace("{{activeSpecId}}", sm.activeSpecId ?? "none")
    .replace("{{loopCount}}", String(sm.loopCount))
    .replace("{{maxLoops}}", String(config.maxLoops))
    .replace("{{toolList}}", toolList);
}

// ---------------------------------------------------------------------------
// Nudge Helpers
// ---------------------------------------------------------------------------

/**
 * Get the nudge threshold for a given FSM state.
 * Returns undefined if nudging is disabled for the state.
 */
function getNudgeThreshold(state: FSMState): number | undefined {
  if (!config.nudge.enabled) return undefined;

  const stateConfig = config.nudge.states[state];
  if (stateConfig?.enabled === false) return undefined;

  return stateConfig?.turnsBeforeNudge ?? config.nudge.defaults.turnsBeforeNudge;
}

/**
 * Build a nudge message for the given level.
 */
function buildNudgeMessage(state: FSMState, level: number): string {
  const expectation = stateMachine.canNudge();

  if (level === 1) {
    return `\n\n[NUDGE] Reminder: You are in state ${state}. The expected next action is: ${expectation.expectedAction}.`;
  }

  if (level === 2) {
    return `\n\n[NUDGE - URGENT] You must now proceed with: ${expectation.expectedAction}. This is a required step in the TDD lifecycle. The FSM cannot advance until this action is taken.`;
  }

  // Level 3 is handled via ctx.ui.notify(), not appended to the prompt
  return "";
}

/**
 * Reset nudge state — called on FSM transition or action attempted.
 */
export function resetNudgeState(newState: FSMState): void {
  nudgeState = {
    fsmState: newState,
    turnsSinceEntry: 0,
    actionAttempted: false,
    lastNudgeLevel: 0,
  };
}

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: PiCoderConfig = {
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
  logging: {
    enabled: false,
    level: "standard",
    maxLogFiles: 10,
  },
  subagentControl: {
    enabled: true,
  },
};

function loadConfig(cwd: string): PiCoderConfig {
  const configPath = join(cwd, ".pi-coder", "config.json");
  try {
    if (existsSync(configPath)) {
      const raw = readFileSync(configPath, "utf-8");
      return { ...DEFAULT_CONFIG, ...JSON.parse(raw), nudge: { ...DEFAULT_CONFIG.nudge, ...(JSON.parse(raw).nudge ?? {}) }, logging: { ...DEFAULT_CONFIG.logging, ...(JSON.parse(raw).logging ?? {}) }, subagentControl: { ...DEFAULT_CONFIG.subagentControl, ...(JSON.parse(raw).subagentControl ?? {}) } };
    }
  } catch {
    // Fall through to default
  }
  return { ...DEFAULT_CONFIG };
}

// ---------------------------------------------------------------------------
// Subagent target agent extraction
// ---------------------------------------------------------------------------

/**
 * Extract the target agent name from a subagent tool call input.
 * Checks common parameter names used by pi-subagents.
 */
function extractSubagentTarget(input: Record<string, unknown>): string | undefined {
  return (input.agent as string) ?? (input.name as string) ?? undefined;
}

/**
 * Extract token usage from a subagent tool result.
 * pi-subagents may include usage metadata with prompt/completion/total tokens.
 */
function extractTokenUsage(result: unknown): { input: number; output: number; total: number } | null {
  if (!result || typeof result !== "object") return null;

  // Check common shapes: result.usage, result.metadata.usage
  const r = result as Record<string, unknown>;
  const usage = (r.usage as Record<string, unknown>) ??
    ((r.metadata as Record<string, unknown>)?.usage as Record<string, unknown>);

  if (!usage) return null;

  const input = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0;
  const output = typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0;
  const total = typeof usage.total_tokens === "number" ? usage.total_tokens : input + output;

  if (input === 0 && output === 0 && total === 0) return null;

  return { input, output, total };
}

/**
 * Extract review verdict from a subagent output (reviewer agent).
 * Looks for common verdict patterns in the text output.
 */
function extractReviewVerdict(result: unknown): {
  verdict: "approved" | "needs_changes" | "request_changes";
  issueCount: number;
  highSeverityCount: number;
} | null {
  if (!result || typeof result !== "object") return null;

  const r = result as Record<string, unknown>;

  // Try to get text content from the result
  let text = "";
  if (typeof r.content === "string") {
    text = r.content;
  } else if (Array.isArray(r.content)) {
    // Tool result content is often an array of content blocks
    text = (r.content as Array<{ type: string; text?: string }>)
      .filter((c: { type: string }) => c.type === "text")
      .map((c: { text?: string }) => c.text ?? "")
      .join("\n");
  }

  if (!text) return null;

  // Check for verdict markers used by the reviewer agent prompt
  let verdict: "approved" | "needs_changes" | "request_changes";
  if (text.includes("✅") || /approved/i.test(text.slice(0, 500))) {
    verdict = "approved";
  } else if (text.includes("❌") || /request.?changes/i.test(text.slice(0, 500))) {
    verdict = "request_changes";
  } else if (text.includes("⚠️") || /needs.?changes/i.test(text.slice(0, 500))) {
    verdict = "needs_changes";
  } else {
    return null; // Can't determine verdict
  }

  // Count issues — look for severity markers
  const highSeverity = (text.match(/🔴/g) ?? []).length;
  const medSeverity = (text.match(/🟠/g) ?? []).length;
  const lowSeverity = (text.match(/🟡/g) ?? []).length;
  const issueCount = highSeverity + medSeverity + lowSeverity;

  return { verdict, issueCount, highSeverityCount: highSeverity };
}

// ---------------------------------------------------------------------------
// Extension Factory
// ---------------------------------------------------------------------------

export default function piCoderExtension(pi: ExtensionAPI): void {
  // -----------------------------------------------------------------------
  // Phase 1: Extension Foundation & Toggle State
  // -----------------------------------------------------------------------

  pi.on("session_start", async (_event, ctx) => {
    // Capture ctx for UI refresh
    sessionCtx = ctx;
    const cwd = ctx.cwd;

    // Load config
    config = loadConfig(cwd);

    // Generate session ID and initialize logger
    sessionId = randomUUID();
    const logDir = join(cwd, ".pi-coder", "logs");
    logger = new Logger(logDir, config.logging);

    // Load orchestrator prompt template (checks for project customization)
    resetOrchestratorPromptCache();
    loadOrchestratorPrompt(cwd);

    // Initialize state machine
    stateMachine = new StateMachine(config);

    // Initialize module dependencies
    const knowledgeDir = join(cwd, ".pi-coder", "knowledge");
    const specsDir = join(cwd, ".pi-coder", "specs");

    knowledgeStore = new KnowledgeStore(knowledgeDir);
    specManager = new SpecManager(specsDir);

    // GitOps and TddRunner need pi.exec — capture from closure
    gitOps = new GitOperations(config, (cmd, args, opts) =>
      pi.exec(cmd, args, opts),
    );
    tddRunner = new TddRunner(config, (cmd, args, opts) =>
      pi.exec(cmd, args, opts),
    );

    // Register tools
    // Wrap stateMachine in a ref object so tools.ts always reads the current
    // instance even after state restore replaces the module-level variable.
    const smRef: { get current(): StateMachine } = {
      get current() { return stateMachine; },
    };

    registerTools(pi, {
      stateMachine: smRef,
      gitOps,
      tddRunner,
      knowledgeStore,
      specManager,
      config,
    });

    // Check for pi-subagents availability
    const allTools = pi.getAllTools();
    subagentsAvailable = allTools.some((t) => t.name === "subagent");

    // Listen for subagent control events (active_long_running, needs_attention)
    // NOTE: For foreground (synchronous) subagents, these steer messages are queued
    // until the subagent completes — they arrive retrospectively, not in real-time.
    // This is still useful for debugging and understanding what happened.
    // For real-time monitoring, async delegation would be needed (future work).
    if (subagentsAvailable && config.subagentControl.enabled) {
      pi.events.on("subagent:control-event", (data: unknown) => {
        if (!piCoderActive) return;
        const event = data as {
          event?: { type: string; agent: string; runId: string; message: string; reason?: string; turns?: number; toolCount?: number; currentTool?: string; elapsedMs?: number };
          source?: string;
        };
        const ctrl = event.event;
        if (!ctrl) return;

        // Only surface events that match our config thresholds
        if (ctrl.type === "needs_attention") {
          logEvent("subagent_control", {
            type: ctrl.type,
            agent: ctrl.agent,
            runId: ctrl.runId,
            reason: ctrl.reason,
            currentTool: ctrl.currentTool,
          });
          pi.sendMessage(
            {
              customType: "pi-coder-subagent-attention",
              content: `⚠️ Subagent ${ctrl.agent} needs attention: ${ctrl.message}. Run: subagent({ action: "status", id: "${ctrl.runId}" }) to inspect.`,
              display: true,
            },
            { deliverAs: "steer", triggerTurn: true },
          );
        } else if (ctrl.type === "active_long_running") {
          const elapsed = ctrl.elapsedMs ? Math.floor(ctrl.elapsedMs / 1000) : "?";
          logEvent("subagent_control", {
            type: ctrl.type,
            agent: ctrl.agent,
            runId: ctrl.runId,
            elapsedSeconds: elapsed,
            currentTool: ctrl.currentTool,
          });
          pi.sendMessage(
            {
              customType: "pi-coder-subagent-running",
              content: `⏱️ Subagent ${ctrl.agent} has been running for ${elapsed}s. Current tool: ${ctrl.currentTool ?? "unknown"}. Run: subagent({ action: "status", id: "${ctrl.runId}" }) to check progress.`,
              display: true,
            },
            { deliverAs: "steer", triggerTurn: false },
          );
        }
      });
    }

    // Initialize state persistence
    const piCoderDir = join(cwd, ".pi-coder");
    statePersistence = new StatePersistence(piCoderDir);

    // Restore persisted state from .pi-coder/state.json
    const savedState = await statePersistence.load();
    if (savedState) {
      // Integrity check — verify spec file exists when specId is set
      const integrity = await statePersistence.checkIntegrity(savedState);

      // Terminal states — no cycle to resume
      const isTerminal = savedState.fsm.currentState === "IDLE" || savedState.fsm.currentState === "COMPLETE";

      if (!isTerminal && integrity.valid) {
        // Restore FSM state
        stateMachine = StateMachine.fromJSON(savedState.fsm, config);

        // Restore toggle — honour explicit user choice
        piCoderActive = savedState.piCoderActive;
      } else if (!isTerminal && !integrity.valid) {
        // Integrity errors — log and steer, but don't restore cycle
        logEvent("state_restore", {
          status: "integrity_failed",
          errors: integrity.errors,
          warnings: integrity.warnings,
        });
        pi.sendMessage(
          {
            customType: "pi-coder-state-restore",
            content: `⚠️ Pi Coder: Could not resume previous cycle. ${integrity.errors.join("; ")}`,  
            display: true,
          },
          { deliverAs: "steer", triggerTurn: true },
        );
        // Restore toggle state even on integrity failure
        piCoderActive = savedState.piCoderActive;
        // Delete the corrupt state file so it doesn't block future inits
        await statePersistence.delete();
      } else {
        // Terminal state — keep toggle, don't restore cycle
        piCoderActive = savedState.piCoderActive;
        await statePersistence.delete();
      }

      if (integrity.warnings.length > 0) {
        logEvent("state_restore", {
          status: "warnings",
          warnings: integrity.warnings,
        });
      }
    }

    // Initialize nudge state from current FSM state
    resetNudgeState(stateMachine.currentState);

    // Activate orchestrator mode if subagents are available
    if (subagentsAvailable) {
      if (piCoderActive) {
        pi.setActiveTools(ORCHESTRATOR_TOOLS);
        refreshUI();
      }
    } else {
      // Subagents not available — can't activate orchestrator mode
      piCoderActive = false;
      ctx.ui.notify(
        "Pi Coder: Orchestrator mode requires pi-subagents. Install with: `pi install npm:pi-subagents`",
        "warning",
      );
    }
  });

  // -----------------------------------------------------------------------
  // Phase 2: System Prompt Replacement
  // -----------------------------------------------------------------------

  pi.on("before_agent_start", async (event, ctx) => {
    // When inactive or subagents not available, let pi run normally
    if (!piCoderActive || !subagentsAvailable) return;

    const { systemPromptOptions } = event;

    // Filter to orchestrator-allowed tools only
    const filteredSnippets: Record<string, string> = {};
    for (const name of ORCHESTRATOR_TOOLS) {
      if (systemPromptOptions.toolSnippets?.[name]) {
        filteredSnippets[name] = systemPromptOptions.toolSnippets[name];
      }
    }

    // Build our custom orchestrator prompt
    const orchestratorPrompt = buildOrchestratorPrompt(
      stateMachine,
      filteredSnippets,
    );

    // (Guidelines from tools are already embedded in orchestratorPrompt via filteredSnippets)

    // Build the full system prompt manually.
    // We can't use buildSystemPrompt() because it's not re-exported from the main package.
    // The customPrompt path in buildSystemPrompt is: customPrompt + appendSystemPrompt + project_context + skills + date + CWD
    let fullPrompt = orchestratorPrompt;

    // Append any user-provided append system prompt
    if (systemPromptOptions.appendSystemPrompt) {
      fullPrompt += "\n\n" + systemPromptOptions.appendSystemPrompt;
    }

    // Append project context files (<project_context>)
    const contextFiles = systemPromptOptions.contextFiles ?? [];
    if (contextFiles.length > 0) {
      fullPrompt += "\n\n<project_context>\n\n";
      fullPrompt += "Project-specific instructions and guidelines:\n\n";
      for (const { path: filePath, content } of contextFiles) {
        fullPrompt += `<project_instructions path="${filePath}">\n${content}\n</project_instructions>\n\n`;
      }
      fullPrompt += "</project_context>\n";
    }

    // Manually append skills since read is excluded from selectedTools
    // buildSystemPrompt only includes <available_skills> when read is in selectedTools
    const skills = systemPromptOptions.skills ?? [];
    if (skills.length > 0) {
      fullPrompt += formatSkillsForPrompt(skills as Skill[]);
    }

    // Append date and working directory (matches buildSystemPrompt behavior)
    const now = new Date();
    const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    fullPrompt += `\nCurrent date: ${date}`;
    fullPrompt += `\nCurrent working directory: ${systemPromptOptions.cwd?.replace(/\\/g, "/") ?? "."}`;

    // -------------------------------------------------------------------
    // Phase 4: Nudge System (part of before_agent_start)
    // -------------------------------------------------------------------

    // Increment turn counter
    nudgeState.turnsSinceEntry++;

    // Check if nudging should fire
    const threshold = getNudgeThreshold(stateMachine.currentState);
    const maxEscalation = config.nudge.defaults.escalationLevels;

    if (
      threshold !== undefined &&
      !nudgeState.actionAttempted &&
      nudgeState.turnsSinceEntry > threshold &&
      nudgeState.lastNudgeLevel < maxEscalation
    ) {
      nudgeState.lastNudgeLevel++;

      // Log nudge event
      logEvent("nudge_fired", {
        fsmState: stateMachine.currentState,
        level: nudgeState.lastNudgeLevel,
        expectedAction: stateMachine.canNudge().expectedAction,
      });

      if (nudgeState.lastNudgeLevel < maxEscalation) {
        // Levels 1-2: append to system prompt
        const nudgeMsg = buildNudgeMessage(
          stateMachine.currentState,
          nudgeState.lastNudgeLevel,
        );
        fullPrompt += nudgeMsg;
      } else {
        // Level 3: user-visible notification
        const expectation = stateMachine.canNudge();

        // Log nudge escalation
        logEvent("nudge_escalation", {
          fsmState: stateMachine.currentState,
          newLevel: nudgeState.lastNudgeLevel,
        });

        ctx.ui.notify(
          `Pi Coder: Orchestrator has not progressed past state ${stateMachine.currentState} after ${nudgeState.turnsSinceEntry} turns. Expected: ${expectation.expectedAction}. Would you like to intervene?`,
          "warning",
        );
      }
    }

    // Return the replaced system prompt
    return { systemPrompt: fullPrompt };
  });

  // -----------------------------------------------------------------------
  // Phase 3: FSM Event Guards & Auto-Transitions
  // -----------------------------------------------------------------------

  // --- tool_call: Validate against FSM state ---

  pi.on("tool_call", async (event) => {
    if (!piCoderActive) return;

    const { toolName, input } = event;

    // Default-deny: only ORCHESTRATOR_TOOLS are allowed in orchestrator mode
    if (!ORCHESTRATOR_TOOLS.includes(toolName)) {
      logEvent("tool_call_blocked", {
        toolName,
        fsmState: stateMachine.currentState,
        reason: "not_in_orchestrator_tools",
      });
      return {
        block: true,
        reason: `Tool "${toolName}" is not available in orchestrator mode. Allowed: ${ORCHESTRATOR_TOOLS.join(", ")}`,
      };
    }

    // Block raw git commands via bash (safety net if bash is ever re-added to tools)
    if (toolName === "bash") {
      const command = (input as { command?: string }).command ?? "";
      if (command.trimStart().startsWith("git ")) {
        return {
          block: true,
          reason:
            "Raw git commands are blocked in orchestrator mode. Use pi_coder_git for Git operations.",
        };
      }
    }

    // Validate pi_coder_run_tests against FSM state
    if (toolName === "pi_coder_run_tests") {
      if (!stateMachine.isActionAllowed("pi_coder_run_tests")) {
        return {
          block: true,
          reason: `pi_coder_run_tests is not allowed in state ${stateMachine.currentState}. Allowed states: TDD_RED_VALIDATE, TDD_GREEN_VALIDATE.`,
        };
      }
    }

    // Validate pi_coder_git against FSM state
    if (toolName === "pi_coder_git") {
      if (!stateMachine.isActionAllowed("pi_coder_git")) {
        return {
          block: true,
          reason: `pi_coder_git is not allowed in state ${stateMachine.currentState}. Allowed states: GIT_CHECKPOINT, REVIEWING, MERGING, BLOCKED, IDLE.`,
        };
      }
    }

    // Validate subagent delegation against FSM state
    if (toolName === "subagent") {
      const targetAgent = extractSubagentTarget(
        input as Record<string, unknown>,
      );

      // Listing subagents (no target agent) is always allowed — it's discovery, not delegation
      if (targetAgent !== undefined) {
        // Only pi-coder subagents are allowed — block builtins and other packages
        // The orchestrator must only delegate to pi-coder.researcher, pi-coder.implementor, pi-coder.reviewer
        if (!targetAgent.startsWith("pi-coder.")) {
          logEvent("tool_call_blocked", {
            toolName,
            targetAgent,
            fsmState: stateMachine.currentState,
            reason: "non_pi_coder_agent",
          });
          return {
            block: true,
            reason: `Subagent delegation to "${targetAgent}" is not allowed in orchestrator mode. Only pi-coder subagents may be used: pi-coder.researcher, pi-coder.implementor, pi-coder.reviewer`,
          };
        }

        // Block delegation to self (orchestrator should never delegate to itself)
        if (targetAgent === "pi-coder.orchestrator") {
          logEvent("tool_call_blocked", {
            toolName,
            targetAgent,
            fsmState: stateMachine.currentState,
            reason: "self_delegation",
          });
          return {
            block: true,
            reason: "The orchestrator cannot delegate to itself.",
          };
        }

        if (
          !stateMachine.isActionAllowed("subagent", targetAgent)
        ) {
          const validHint = targetAgent === "pi-coder.researcher" && stateMachine.currentState === "IDLE"
            ? " Hint: Use pi_coder_advance_fsm to advance IDLE → SPEC_WORK first."
            : "";
          logEvent("tool_call_blocked", {
            toolName,
            targetAgent,
            fsmState: stateMachine.currentState,
            reason: "not_allowed_in_state",
          });
          return {
            block: true,
            reason: `Subagent delegation to "${targetAgent}" is not allowed in state ${stateMachine.currentState}.${validHint}`,
          };
        }

        // Track subagent timing
        subagentStartTime = Date.now();
        lastSubagentAgent = targetAgent;

        // Update UI to show subagent running
        subagentRunning = true;
        refreshUI();

        // Log subagent delegation
        const taskStr = typeof (input as Record<string, unknown>).task === "string"
          ? ((input as Record<string, unknown>).task as string).slice(0, 200)
          : "";
        logEvent("subagent_start", {
          agent: targetAgent,
          taskSummary: taskStr,
          specId: stateMachine.activeSpecId,
          fsmState: stateMachine.currentState,
        });

        // Mark action as attempted (resets nudge urgency)
        nudgeState.actionAttempted = true;
      }
    }

    // Mark action attempted for pi_coder_run_tests and pi_coder_git too
    if (toolName === "pi_coder_run_tests" || toolName === "pi_coder_git") {
      nudgeState.actionAttempted = true;
    }

    // Tool is in ORCHESTRATOR_TOOLS and passed state validation — allow
    return undefined;
  });

  // --- tool_result: Auto-transition FSM based on results ---

  pi.on("tool_result", async (event) => {
    // Filter subagent list output to only show pi-coder agents (runs before active check)
    // This is a safety net: if disableBuiltins wasn't set (or was removed),
    // we still strip non-pi-coder agents from the list output.
    // Must run even when inactive so we don't leak agent info in edge cases.
    const { toolName, content: rawContent } = event;
    if (
      toolName === "subagent" &&
      Array.isArray(rawContent) &&
      rawContent.length >= 1 &&
      rawContent[0]?.type === "text" &&
      typeof (rawContent[0] as { type: string; text: string }).text === "string" &&
      (rawContent[0] as { type: string; text: string }).text.includes("Executable agents:")
    ) {
      const textBlock = rawContent[0] as { type: "text"; text: string };
      const lines = textBlock.text.split("\n");
      const filtered = lines.filter((line: string) => {
        if (!line.startsWith("- ")) return true; // Keep headers, blank lines, chains section
        // Only keep pi-coder.* agents
        const agentMatch = line.match(/^\-\s+(\S+)/);
        if (!agentMatch) return true;
        return agentMatch[1].startsWith("pi-coder.");
      });
      if (filtered.length !== lines.length) {
        return { content: [{ type: "text" as const, text: filtered.join("\n") }] };
      }
    }

    if (!piCoderActive) return;

    const { details } = event;
    const currentState = stateMachine.currentState;

    // Handle pi_coder_run_tests results
    if (toolName === "pi_coder_run_tests") {
      const details2 = details as {
        testResult?: { exitCode: number; timedOut?: boolean; passed?: number | null; failed?: number | null; output?: string };
        validation?: { valid: boolean; reason?: string };
        phase?: string;
        currentState?: string;
      } | undefined;

      if (!details2?.validation) return; // Tool was blocked or errored

      const validation = details2.validation;
      const previousState = currentState;
      let transitionSteer = ""; // Appended to tool result content for guaranteed delivery

      if (currentState === "TDD_RED_VALIDATE") {
        // Log RED validation
        logEvent("tdd_red_validate", {
          valid: validation.valid,
          reason: validation.reason,
          passed: details2.testResult?.passed ?? null,
          failed: details2.testResult?.failed ?? null,
          specId: stateMachine.activeSpecId,
        });

        if (validation.valid) {
          // Tests failed as expected → advance to GREEN
          stateMachine.transition("TDD_GREEN_WRITE");
          transitionSteer = "\n\n⚠️ AUTO-TRANSITION: You are now in TDD_GREEN_WRITE. Next step: delegate to pi-coder.implementor to implement the code that makes the tests pass. Do NOT call pi_coder_advance_fsm yet — first get the implementation done.";
        } else {
          // Tests passed unexpectedly → BLOCKED
          stateMachine.transition("BLOCKED");
          transitionSteer = `\n\n⚠️ AUTO-TRANSITION: Tests passed unexpectedly (reason: ${validation.reason ?? "RED_TAUTOLOGY"}). You are now in BLOCKED. Present recovery options to the user.`;
        }
      }

      if (currentState === "TDD_GREEN_VALIDATE") {
        // Log GREEN validation
        logEvent("tdd_green_validate", {
          valid: validation.valid,
          reason: validation.reason,
          passed: details2.testResult?.passed ?? null,
          failed: details2.testResult?.failed ?? null,
          specId: stateMachine.activeSpecId,
        });

        if (validation.valid) {
          // Tests pass — orchestrator decides: next unit or proceed to review
          transitionSteer = "\n\n✅ GREEN validation passed. Current FSM state: TDD_GREEN_VALIDATE. Use pi_coder_advance_fsm to advance: TDD_RED_WRITE (next implementation unit) or REVIEWING (all units complete).";
        } else {
          // Tests still fail → loop back to GREEN
          stateMachine.transition("TDD_GREEN_WRITE");
          transitionSteer = "\n\n⚠️ AUTO-TRANSITION: Tests still failing. You are now in TDD_GREEN_WRITE. Delegate to pi-coder.implementor again with clearer instructions. Do NOT call pi_coder_advance_fsm yet.";
        }
      }

      // Modify tool result content to include auto-transition info
      // This is more reliable than steer messages because the LLM sees it
      // directly in the tool output, before its next decision.
      if (transitionSteer && Array.isArray(rawContent) && rawContent.length >= 1 && rawContent[0]?.type === "text") {
        const textBlock = rawContent[0] as { type: "text"; text: string };
        const appendedText = textBlock.text + transitionSteer;
        return { content: [{ type: "text" as const, text: appendedText }] };
      }

      // Log FSM transition
      if (stateMachine.currentState !== previousState) {
        logEvent("fsm_transition", {
          from: previousState,
          to: stateMachine.currentState,
          event: validation.valid ? "validation_passed" : "validation_failed",
          loopCount: stateMachine.loopCount,
          specId: stateMachine.activeSpecId,
        });

        // Log lifecycle end on BLOCKED (RED tautology)
        if (stateMachine.currentState === "BLOCKED") {
          const wallClockMs = lifecycleStartTime !== null ? Date.now() - lifecycleStartTime : null;
          logEvent("lifecycle_end", {
            specId: stateMachine.activeSpecId,
            outcome: "BLOCKED",
            wallClockMs,
            totalTokens: { ...lifecycleTokens },
          });
        }

        // Log circuit breaker
        if (stateMachine.circuitBreakerTripped()) {
          logEvent("circuit_breaker", {
            loopCount: stateMachine.loopCount,
            maxLoops: config.maxLoops,
            specId: stateMachine.activeSpecId,
          });
        }
      }

      // Reset nudge state on transition
      if (stateMachine.currentState !== previousState) {
        resetNudgeState(stateMachine.currentState);
      }

      // Persist state after transition
      await persistState();
    }

    // Handle pi_coder_git results (auto-transition for checkpoint & merge)
    if (toolName === "pi_coder_git" && currentState === "GIT_CHECKPOINT") {
      // If git checkpoint succeeded in GIT_CHECKPOINT, auto-advance to TDD_RED_WRITE
      const gitDetails = details as { operation?: string; success?: boolean; error?: string } | undefined;
      if (gitDetails?.success !== false) {
        stateMachine.transition("TDD_RED_WRITE");
        logEvent("fsm_transition", {
          from: "GIT_CHECKPOINT",
          to: "TDD_RED_WRITE",
          event: "checkpoint_complete",
          loopCount: stateMachine.loopCount,
          specId: stateMachine.activeSpecId,
        });
        resetNudgeState(stateMachine.currentState);
        await persistState();

        // Append auto-transition info to tool result
        if (Array.isArray(rawContent) && rawContent.length >= 1 && rawContent[0]?.type === "text") {
          const textBlock = rawContent[0] as { type: "text"; text: string };
          const appendedText = textBlock.text + "\n\n⚠️ AUTO-TRANSITION: Checkpoint complete. You are now in TDD_RED_WRITE. Next step: delegate to pi-coder.implementor to write failing tests.";
          return { content: [{ type: "text" as const, text: appendedText }] };
        }
      }
    }

    if (toolName === "pi_coder_git" && currentState === "MERGING") {
      // If git merge succeeded in MERGING, auto-advance to COMPLETE
      const gitDetails = details as { operation?: string; success?: boolean; error?: string } | undefined;
      if (gitDetails?.success !== false) {
        stateMachine.transition("COMPLETE");
        logEvent("fsm_transition", {
          from: "MERGING",
          to: "COMPLETE",
          event: "merge_complete",
          loopCount: stateMachine.loopCount,
          specId: stateMachine.activeSpecId,
        });
        logEvent("lifecycle_end", {
          specId: stateMachine.activeSpecId,
          outcome: "COMPLETE",
          wallClockMs: lifecycleStartTime !== null ? Date.now() - lifecycleStartTime : null,
          totalTokens: { ...lifecycleTokens },
        });
        lifecycleStartTime = null;
        lifecycleTokens = { input: 0, output: 0, total: 0 };
        resetNudgeState(stateMachine.currentState);
        await persistState();

        // Append auto-transition info to tool result
        if (Array.isArray(rawContent) && rawContent.length >= 1 && rawContent[0]?.type === "text") {
          const textBlock = rawContent[0] as { type: "text"; text: string };
          const appendedText = textBlock.text + "\n\n✅ AUTO-TRANSITION: Merge complete. You are now in COMPLETE. The spec lifecycle is finished.";
          return { content: [{ type: "text" as const, text: appendedText }] };
        }
      }
    }

    // Handle subagent completion results
    if (toolName === "subagent") {
      const previousState = currentState;

      // Log subagent end with duration and token usage
      const durationMs = subagentStartTime !== null ? Date.now() - subagentStartTime : null;
      const tokenUsage = extractTokenUsage(details);

      if (tokenUsage) {
        lifecycleTokens.input += tokenUsage.input;
        lifecycleTokens.output += tokenUsage.output;
        lifecycleTokens.total += tokenUsage.total;
      }

      logEvent("subagent_end", {
        agent: lastSubagentAgent ?? "unknown",
        durationMs,
        tokenUsage: tokenUsage ?? { input: 0, output: 0, total: 0 },
        outcome: "success", // If we reach tool_result, the subagent completed
        specId: stateMachine.activeSpecId,
      });

      // Subagent timing reset
      subagentStartTime = null;
      lastSubagentAgent = null;
      subagentRunning = false;
      // Note: refreshUI() is called at the end of tool_result handler

      // Check for review result in subagent output (if we're in REVIEWING state)
      if (currentState === "REVIEWING") {
        const reviewVerdict = extractReviewVerdict(details);
        if (reviewVerdict) {
          logEvent("review_result", {
            verdict: reviewVerdict.verdict,
            issueCount: reviewVerdict.issueCount,
            highSeverityCount: reviewVerdict.highSeverityCount,
            loopCount: stateMachine.loopCount,
            specId: stateMachine.activeSpecId,
          });
        }
      }

      // SPEC_WORK: Researcher subagent completed — stay in SPEC_WORK
      // The orchestrator may need multiple research rounds, or may
      // advance to SPEC_APPROVED via pi_coder_advance_fsm.
      if (currentState === "SPEC_WORK" && lifecycleStartTime === null) {
        // Log lifecycle start on first subagent delegation in a cycle
        lifecycleStartTime = Date.now();
        lifecycleTokens = { input: 0, output: 0, total: 0 };
        logEvent("lifecycle_start", {
          specId: stateMachine.activeSpecId,
          userRequest: "",
        });
      }

      // Log FSM transition
      if (stateMachine.currentState !== previousState) {
        logEvent("fsm_transition", {
          from: previousState,
          to: stateMachine.currentState,
          event: "subagent_completed",
          loopCount: stateMachine.loopCount,
          specId: stateMachine.activeSpecId,
        });

        // Log lifecycle events on terminal transitions
        if (stateMachine.currentState === "COMPLETE") {
          const wallClockMs = lifecycleStartTime !== null ? Date.now() - lifecycleStartTime : null;
          logEvent("lifecycle_end", {
            specId: stateMachine.activeSpecId,
            outcome: "COMPLETE",
            wallClockMs,
            totalTokens: { ...lifecycleTokens },
          });
          lifecycleStartTime = null;
          lifecycleTokens = { input: 0, output: 0, total: 0 };
        }

        if (stateMachine.currentState === "BLOCKED" && previousState === "TDD_RED_VALIDATE") {
          const wallClockMs = lifecycleStartTime !== null ? Date.now() - lifecycleStartTime : null;
          logEvent("lifecycle_end", {
            specId: stateMachine.activeSpecId,
            outcome: "BLOCKED",
            wallClockMs,
            totalTokens: { ...lifecycleTokens },
          });
        }

        // Log circuit breaker
        if (stateMachine.circuitBreakerTripped()) {
          logEvent("circuit_breaker", {
            loopCount: stateMachine.loopCount,
            maxLoops: config.maxLoops,
            specId: stateMachine.activeSpecId,
          });
        }
      }

      // Reset nudge state on transition
      if (stateMachine.currentState !== previousState) {
        resetNudgeState(stateMachine.currentState);
      }

      // Persist state after transition
      await persistState();
    }

    // Catch-all persist: any tool may have transitioned the FSM
    // (pi_coder_advance_fsm transitions inside execute(), pi_coder_git rollback too)
    await persistState();

    // Refresh UI after any FSM state change
    refreshUI();

    return undefined;
  });

  // =====================================================================
  // Spec 10: Commands
  // =====================================================================

  // -----------------------------------------------------------------------
  // Phase 1: Toggle Command — /pi-coder
  // -----------------------------------------------------------------------

  pi.registerCommand("pi-coder", {
    description: "Toggle pi-coder orchestrator mode on/off",
    handler: async (_args, ctx) => {
      if (!piCoderActive) {
        // Turning ON — check pi-subagents availability
        if (!subagentsAvailable) {
          ctx.ui.notify(
            "Pi Coder requires the pi-subagents package. Install with: `pi install npm:pi-subagents`",
            "error",
          );
          logEvent("command", { command: "toggle", result: "blocked_no_subagents" });
          return;
        }

        piCoderActive = true;
        pi.setActiveTools(ORCHESTRATOR_TOOLS);
        refreshUI();
        ctx.ui.notify("Pi Coder: ON — Orchestrator mode active. Use /pi-coder to switch to normal mode.", "info");
        logEvent("command", { command: "toggle", result: "on" });
      } else {
        // Turning OFF
        piCoderActive = false;
        pi.setActiveTools(NORMAL_TOOLS);
        refreshUI();
        ctx.ui.notify("Pi Coder: OFF — Normal Pi mode. Use /pi-coder to re-activate.", "info");
        logEvent("command", { command: "toggle", result: "off" });
      }

      // Persist toggle state
      await persistState();
    },
  });

  // -----------------------------------------------------------------------
  // Phase 2: Init Command — /pi-coder-init
  // -----------------------------------------------------------------------

  /**
   * Auto-detect the test command from the project's package.json scripts.
   * Looks for "vitest", "jest", then "test" scripts, falling back to "npm test".
   */
  function detectTestCommand(cwd: string): string {
    const pkgPath = join(cwd, "package.json");
    try {
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        const scripts = pkg.scripts ?? {};
        if (scripts.vitest) return "npx vitest run";
        if (scripts.jest) return "npx jest";
        if (scripts.test) return "npm test";
      }
    } catch {
      // Fall through to default
    }
    return "npm test";
  }

  /**
   * Resolve the package's own agents/ directory path.
   * Uses import.meta.url to locate the package root relative to this extension file.
   */
  function getPackageAgentsDir(): string {
    // This file is at extensions/index.ts, so agents/ is one directory up
    const thisDir = dirname(fileURLToPath(import.meta.url));
    return join(thisDir, "..", "agents");
  }

  pi.registerCommand("pi-coder-init", {
    description: "Initialize pi-coder directory structure and config",
    handler: async (_args, ctx) => {
      const cwd = ctx.cwd;
      const created: string[] = [];
      const skipped: string[] = [];
      const warnings: string[] = [];

      // 1. Create .pi-coder/ directory structure
      const knowledgeDir = join(cwd, ".pi-coder", "knowledge");
      const specsDir = join(cwd, ".pi-coder", "specs");
      const agentsDir = join(cwd, ".pi", "agents");

      mkdirSync(knowledgeDir, { recursive: true });
      created.push(".pi-coder/knowledge/");
      mkdirSync(specsDir, { recursive: true });
      created.push(".pi-coder/specs/");

      // 2. Create .pi/agents/ if missing
      if (!existsSync(agentsDir)) {
        mkdirSync(agentsDir, { recursive: true });
        created.push(".pi/agents/");
      }

      // 3. Create .pi-coder/config.json — only if it doesn't already exist
      const configPath = join(cwd, ".pi-coder", "config.json");
      if (!existsSync(configPath)) {
        const detectedTestCommand = detectTestCommand(cwd);
        const defaultConfig: PiCoderConfig = {
          testCommand: detectedTestCommand,
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
          logging: {
            enabled: false,
            level: "standard",
            maxLogFiles: 10,
          },
          subagentControl: {
            enabled: true,
          },
        };
        writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2), "utf-8");
        created.push(".pi-coder/config.json");
      } else {
        skipped.push(".pi-coder/config.json (already exists)");
      }

      // 4. Copy agent .md files — skip existing (don't overwrite customizations)
      const packageAgentsDir = getPackageAgentsDir();
      const agentFilenames = [
        "pi-coder-researcher.md",
        "pi-coder-implementor.md",
        "pi-coder-reviewer.md",
      ];

      for (const filename of agentFilenames) {
        const source = join(packageAgentsDir, filename);
        const target = join(agentsDir, filename);

        if (!existsSync(source)) {
          warnings.push(`Agent source file not found: ${filename}`);
          continue;
        }

        if (!existsSync(target)) {
          copyFileSync(source, target);
          created.push(`.pi/agents/${filename}`);
        } else {
          skipped.push(`.pi/agents/${filename} (already exists)`);
        }
      }

      // 4b. Copy orchestrator prompt template from prompts/ — skip existing
      const packagePromptsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "prompts");
      const orchestratorSource = join(packagePromptsDir, "pi-coder-orchestrator.md");
      const orchestratorTarget = join(cwd, ".pi", "agents", "pi-coder-orchestrator.md");

      if (existsSync(orchestratorSource)) {
        if (!existsSync(orchestratorTarget)) {
          mkdirSync(dirname(orchestratorTarget), { recursive: true });
          copyFileSync(orchestratorSource, orchestratorTarget);
          created.push(".pi/agents/pi-coder-orchestrator.md (prompt template)");
        } else {
          skipped.push(".pi/agents/pi-coder-orchestrator.md (already exists)");
        }
      } else {
        warnings.push("Orchestrator prompt template not found in package");
      }

      // 5. Warn if subagent tool is not detected
      if (!subagentsAvailable) {
        warnings.push(
          "pi-subagents is not detected. Delegation features will not work until installed: `pi install npm:pi-subagents`",
        );
      }

      // 6. Disable built-in subagents that clash with pi-coder roles in project settings
      // This prevents the orchestrator from accidentally delegating to a generic
      // researcher/reviewer/worker instead of the pi-coder-specific ones.
      // 6. Disable ALL built-in subagents via project settings
      // pi-subagents respects subagents.disableBuiltins — this hides researcher, reviewer,
      // worker, scout, planner, oracle, delegate, context-builder from discovery.
      // pi-coder agents come from the package's agents/ dir, so they're unaffected.
      const settingsPath = join(cwd, ".pi", "settings.json");
      let settings: Record<string, unknown> = {};
      try {
        if (existsSync(settingsPath)) {
          settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
        }
      } catch {
        // Start fresh if corrupt
      }

      const subagentsConfig = (settings as Record<string, Record<string, unknown>>).subagents ?? {};
      const alreadyDisabled = subagentsConfig.disableBuiltins === true;
      if (!alreadyDisabled) {
        subagentsConfig.disableBuiltins = true;
        (settings as Record<string, Record<string, unknown>>).subagents = subagentsConfig;

        mkdirSync(dirname(settingsPath), { recursive: true });
        writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
        created.push(".pi/settings.json (disabled all built-in subagents — pi-coder agents only)");
      } else {
        skipped.push(".pi/settings.json (built-in subagents already disabled)");
      }

      // 7. Report summary
      const lines: string[] = ["Pi Coder Init Complete"];
      if (created.length > 0) {
        lines.push(`Created: ${created.join(", ")}`);
      }
      if (skipped.length > 0) {
        lines.push(`Skipped: ${skipped.join(", ")}`);
      }
      if (warnings.length > 0) {
        lines.push(`Warnings: ${warnings.join(", ")}`);
      }
      ctx.ui.notify(lines.join("\n"), "info");

      // Log init command
      logEvent("command", { command: "init", result: "success", created: created.length, skipped: skipped.length, warnings: warnings.length });
    },
  });

  // -----------------------------------------------------------------------
  // Phase 3: Reset Agents Command — /pi-coder-reset-agents
  // -----------------------------------------------------------------------

  pi.registerCommand("pi-coder-reset-agents", {
    description: "Reset pi-coder agent files to package defaults",
    handler: async (_args, ctx) => {
      // 1. Warn and require confirmation
      const ok = await ctx.ui.confirm(
        "Reset agent files?",
        "All customizations to pi-coder agent files will be lost. Continue?",
      );
      if (!ok) return;

      // 2. Overwrite .pi/agents/pi-coder-*.md with package defaults
      const agentsDir = join(ctx.cwd, ".pi", "agents");
      const packageAgentsDir = getPackageAgentsDir();
      const agentFilenames = [
        "pi-coder-researcher.md",
        "pi-coder-implementor.md",
        "pi-coder-reviewer.md",
      ];

      const reset: string[] = [];
      for (const filename of agentFilenames) {
        const source = join(packageAgentsDir, filename);
        const target = join(agentsDir, filename);

        if (!existsSync(source)) {
          continue; // Package source file missing — skip
        }

        copyFileSync(source, target);
        reset.push(filename);
      }

      // Reset orchestrator prompt from prompts/ directory
      const packagePromptsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "prompts");
      const orchestratorSource = join(packagePromptsDir, "pi-coder-orchestrator.md");
      if (existsSync(orchestratorSource)) {
        copyFileSync(orchestratorSource, join(agentsDir, "pi-coder-orchestrator.md"));
        reset.push("pi-coder-orchestrator.md");
      }

      // 3. Invalidate the orchestrator prompt cache if it was reset
      if (reset.includes("pi-coder-orchestrator.md")) {
        resetOrchestratorPromptCache();
      }

      // 4. Report which files were reset
      if (reset.length > 0) {
        ctx.ui.notify(`Agent files reset to defaults: ${reset.join(", ")}`, "info");
      } else {
        ctx.ui.notify("No agent files found to reset.", "info");
      }

      // Log reset command
      logEvent("command", { command: "reset_agents", result: "success", filesReset: reset.length });
    },
  });

  // -----------------------------------------------------------------------
  // Spec 14: Logs Command — /pi-coder-logs
  // -----------------------------------------------------------------------

  pi.registerCommand("pi-coder-logs", {
    description: "Show pi-coder interaction log statistics",
    handler: async (_args, ctx) => {
      const logDir = join(ctx.cwd, ".pi-coder", "logs");

      if (!existsSync(logDir)) {
        ctx.ui.notify("No logs found. Enable logging in .pi-coder/config.json to start collecting telemetry.", "info");
        return;
      }

      // Parse all log files
      const files = readdirSync(logDir).filter(f => f.endsWith(".log")).sort();
      if (files.length === 0) {
        ctx.ui.notify("Log directory exists but contains no log files.", "info");
        return;
      }

      const entries: Array<Record<string, unknown>> = [];
      for (const file of files) {
        const content = readFileSync(join(logDir, file), "utf-8");
        for (const line of content.trim().split("\n").filter(Boolean)) {
          try {
            entries.push(JSON.parse(line));
          } catch {
            // Skip malformed lines
          }
        }
      }

      if (entries.length === 0) {
        ctx.ui.notify("Log files found but contain no parseable entries.", "info");
        return;
      }

      // Compute and display summary using analysis functions
      const { computeFullSummary, formatSummary } = await import("../src/log-analysis.ts");
      const summary = computeFullSummary(entries as any);
      const text = formatSummary(summary);

      ctx.ui.notify(text, "info");

      // Log that logs were viewed
      logEvent("command", { command: "logs", result: "success", entryCount: entries.length });
    },
  });
}
