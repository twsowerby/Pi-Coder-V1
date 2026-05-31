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
import { LightStateMachine } from "../src/light-state-machine.ts";
import { GitOperations } from "../src/git.ts";
import { TddRunner } from "../src/tdd-runner.ts";
import { KnowledgeStore } from "../src/knowledge.ts";
import { SpecManager } from "../src/spec.ts";
import { GlobalStatePersistence, SpecStatePersistence } from "../src/state-persistence.ts";
import type { GlobalState, SpecState } from "../src/types.ts";
import { registerTools, type StateMachineRef } from "../src/tools.ts";
import type { PiCoderConfig, PiCoderMode, FSMState, EvidenceFlag, IStateMachine, NudgeStateConfig, TestCommands, ReviewVerdict } from "../src/types.ts";
import { Logger, type LogEventType } from "../src/logger.ts";
import { sendDesktopNotification } from "../src/desktop-notifier.ts";
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync } from "node:fs";
import { join, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Tools available when pi-coder TDD mode is active. Exported for Spec 10 commands. */
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

/** Tools available in Light mode — spec, implement, review, no TDD phases. */
export const LIGHT_TOOLS = [
  "ls",
  "find",
  "grep",
  "subagent",
  "pi_coder_run_tests",
  "pi_coder_git",
  "pi_coder_save_spec",
  "pi_coder_read_spec",
"pi_coder_advance_fsm",
  "upsert_knowledge",
  "interview",
  "intercom",
];

/** Tools available in Plan mode — investigation only, no spec/git/FSM tools. */
export const PLAN_TOOLS = [
  "ls",
  "find",
  "grep",
  "subagent",
  "upsert_knowledge",
  "interview",
  "intercom",
];

/** Tools available when pi-coder is off (normal pi mode). Exported for use by Spec 10 commands. */
export const NORMAL_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];



// ---------------------------------------------------------------------------
// Module-scope state
// ---------------------------------------------------------------------------

export let piCoderMode: PiCoderMode = "tdd";
export let subagentsAvailable = false;
export let stateMachine: IStateMachine | null;
export let config: PiCoderConfig;

/** Nudge tracking state. */
interface NudgeState {
  fsmState: string;
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

/** Live subagent progress data — updated via `tool_execution_update` events. */
interface SubagentActivity {
  agent: string;
  task: string;
  currentTool: string | undefined;
  currentToolArgs: string | undefined;
  currentPath: string | undefined;
  toolCount: number;
  turnCount: number | undefined;
  tokens: number;
  durationMs: number;
  recentTools: Array<{ tool: string; args: string }>;
  lastUpdatedAt: number;
}
let subagentActivity: SubagentActivity | null = null;

/** Timer that re-renders the subagent widget to update elapsed duration. */
let subagentWidgetTimer: ReturnType<typeof setInterval> | null = null;

// ---------------------------------------------------------------------------
// UI Refresh — updates widget, status line, and working indicator
// ---------------------------------------------------------------------------

/** Visual styling for each FSM state group. */
const STATE_STYLE: Record<string, { icon: string; color: "success" | "warning" | "error" | "accent" | "muted" | "dim" }> = {
  IDLE:               { icon: "○", color: "dim" },
  SPEC_WORK:          { icon: "●", color: "accent" },
  SPEC_APPROVED:      { icon: "✓", color: "success" },
  GIT_CHECKPOINT:     { icon: "⟳", color: "accent" },
  IMPLEMENTING:       { icon: "●", color: "accent" },
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
  IMPLEMENTING:       "Implementing",
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

  if (piCoderMode === "off") {
    // Pi-coder OFF — clear everything
    ctx.ui.setWidget("pi-coder-state", undefined);
    ctx.ui.setWidget("pi-coder-subagent", undefined);
    ctx.ui.setStatus("pi-coder", undefined);
    ctx.ui.setWorkingIndicator(); // restore default
    return;
  }

  // Always keep the subagent widget in sync — clear it when not running,
  // delegate to refreshSubagentWidget() when active
  if (!subagentRunning) {
    ctx.ui.setWidget("pi-coder-subagent", undefined);
  } else {
    refreshSubagentWidget();
  }

  if (piCoderMode === "plan") {
    // Plan mode — investigation only, no FSM
    const theme = ctx.ui.theme;
    let widgetLine = theme.fg("accent", "🔍 Plan");
    if (subagentRunning) {
      widgetLine += theme.fg("dim", `  `) + theme.fg("accent", "▶");
    }
    ctx.ui.setWidget("pi-coder-state", [widgetLine], { placement: "aboveEditor" });
    ctx.ui.setStatus("pi-coder", theme.fg("accent", "🔍 plan mode"));

    if (subagentRunning) {
      ctx.ui.setWorkingIndicator({
        frames: [theme.fg("accent", "⏣"), theme.fg("muted", "⏣")],
        intervalMs: 500,
      });
    } else {
      ctx.ui.setWorkingIndicator();
    }
    return;
  }

  if (piCoderMode === "light") {
    // Light mode — simplified FSM UI
    const theme = ctx.ui.theme;
    let widgetLine = theme.fg("accent", "⚡ Light");
    if (stateMachine) {
      widgetLine += theme.fg("dim", ` | `) + theme.fg("muted", stateMachine!.currentState);
    }
    if (subagentRunning) {
      widgetLine += theme.fg("dim", `  `) + theme.fg("accent", "▶");
    }
    ctx.ui.setWidget("pi-coder-state", [widgetLine], { placement: "aboveEditor" });
    ctx.ui.setStatus("pi-coder", theme.fg("accent", "⚡ light mode"));

    if (subagentRunning) {
      ctx.ui.setWorkingIndicator({
        frames: [theme.fg("accent", "⏣"), theme.fg("muted", "⏣")],
        intervalMs: 500,
      });
    } else {
      ctx.ui.setWorkingIndicator();
    }
    return;
  }

  // TDD mode — full FSM UI

  const state = stateMachine!.currentState;
  const specId = activeSpecId;
  const loopCount = stateMachine!.loopCount;
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
    widgetLine += theme.fg("dim", `  `) + theme.fg("accent", "▶");
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

// ---------------------------------------------------------------------------
// Subagent Activity Widget — live progress via tool_execution_update
// ---------------------------------------------------------------------------

/** Format duration from ms to human-readable string. */
function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  return `${mins}m${remSecs}s`;
}

/** Format token count to human-readable. */
function formatTokenCount(tokens: number): string {
  if (tokens < 1000) return `${tokens}`;
  if (tokens < 1000000) return `${(tokens / 1000).toFixed(1)}k`;
  return `${(tokens / 1000000).toFixed(1)}M`;
}

/** Refresh the pi-coder-subagent widget based on current subagentActivity. */
function refreshSubagentWidget(): void {
  if (!sessionCtx) return;
  const ctx = sessionCtx;

  if (piCoderMode === "off" || !subagentRunning || !subagentActivity) {
    // No active subagent — clear the widget
    ctx.ui.setWidget("pi-coder-subagent", undefined);
    return;
  }

  const theme = ctx.ui.theme;
  const a = subagentActivity;

  // Line 1: Agent name + spec/unit context
  const specId = activeSpecId;
  let header = theme.fg("accent", `▶ ${a.agent}`);
  if (specId) {
    header += theme.fg("dim", `  spec: `) + theme.fg("muted", specId);
  }

  // Line 2: Task brief (truncated)
  const taskLen = a.task.length;
  const maxTaskLen = 120;
  const taskPreview = taskLen <= maxTaskLen
    ? a.task
    : `${a.task.slice(0, maxTaskLen)}…`;
  const taskLine = theme.fg("dim", `  ⏴  Task: `) + theme.fg("muted", taskPreview.replace(/\n/g, " "));

  // Line 3: Current tool + stats
  let activityLine = theme.fg("dim", `  ⏴  `);
  if (a.currentTool) {
    activityLine += theme.fg("accent", a.currentTool);
    if (a.currentPath) {
      // Show just the filename, not full path
      const fileName = a.currentPath.split("/").pop() ?? a.currentPath;
      activityLine += theme.fg("dim", `: `) + theme.fg("muted", fileName);
    }
    if (a.durationMs > 0) {
      activityLine += theme.fg("dim", ` (${formatDurationMs(a.durationMs)})`);
    }
    activityLine += theme.fg("dim", ` · `);
  }
  // Stats
  const stats: string[] = [];
  if (a.toolCount > 0) stats.push(`${a.toolCount} tool${a.toolCount !== 1 ? "s" : ""}`);
  if (a.turnCount !== undefined && a.turnCount > 0) stats.push(`${a.turnCount} turn${a.turnCount !== 1 ? "s" : ""}`);
  if (a.tokens > 0) stats.push(`${formatTokenCount(a.tokens)} tok`);
  // Fallback duration from subagentStartTime if tool_execution_update isn't providing it
  const elapsed = subagentStartTime !== null ? Date.now() - subagentStartTime : 0;
  if (a.durationMs > 0) {
    // Provided by tool_execution_update — use it
  } else if (elapsed > 0) {
    stats.push(formatDurationMs(elapsed));
  }
  if (stats.length > 0) {
    activityLine += theme.fg("dim", stats.join(theme.fg("dim", ` · `)));
  } else {
    // No stats at all — show a thinking indicator
    activityLine += theme.fg("dim", "thinking…");
  }

  ctx.ui.setWidget("pi-coder-subagent", [header, taskLine, activityLine], { placement: "aboveEditor" });
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

/**
 * Session turn counter — incremented at the start of every agent turn.
 */
let sessionTurnCount = 0;

/** Track lifecycle start time for wall clock duration. */
let lifecycleStartTime: number | null = null;

/** Track session start time for session_summary duration. */
let sessionStartTime: number | null = null;

/** Track spec count attempted in this session. */
let sessionSpecCount = 0;

/** Track cumulative token usage across a spec lifecycle. */
let lifecycleTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };

/** Token breakdown by source: orchestrator turns vs subagent delegation. */
interface SourceTokens {
  /** Tokens from orchestrator (main session) turns */
  orchestrator: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; turns: number };
  /** Tokens from pi-coder subagent delegations */
  subagent: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; turns: number };
}

/** Token breakdown per FSM state. Keyed by state name (e.g. "SPEC_WORK", "TDD_RED_WRITE"). */
let phaseTokens: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; turns: number; source: SourceTokens } > = {};

/** The FSM state that is currently accruing tokens. */
let currentAccrualState: string | null = null;

/** Reset per-lifecycle tracking for a new spec. */
function resetLifecycleTracking(): void {
  lifecycleTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
  phaseTokens = {};
  currentAccrualState = null;
}

/** Ensure an accrual bucket exists for the given FSM state. */
function ensurePhaseBucket(state: string): void {
  if (!phaseTokens[state]) {
    phaseTokens[state] = {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0,
      source: {
        orchestrator: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
        subagent: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
      },
    };
  }
}

/** Set the current accrual state (called on FSM transitions and lifecycle start). */
function setAccrualState(state: string): void {
  currentAccrualState = state;
  ensurePhaseBucket(state);
}

/**
 * Emit an fsm_state_usage event for the state we're leaving and set the new accrual state.
 * Call this on every FSM transition to capture per-state token breakdown.
 *
 * @param fromState - The FSM state being exited
 * @param toState - The FSM state being entered
 * @param logger_ - The logger instance (passed to avoid circular module-level access issues)
 */
function emitStateUsageAndTransition(fromState: string, toState: string): void {
  // Emit usage for the state we're leaving
  const bucket = phaseTokens[fromState];
  if (bucket && (bucket.input > 0 || bucket.output > 0 || bucket.cacheRead > 0 || bucket.cacheWrite > 0 || bucket.cost > 0 || bucket.turns > 0)) {
    logEvent("fsm_state_usage", {
      state: fromState,
      input: bucket.input,
      output: bucket.output,
      cacheRead: bucket.cacheRead,
      cacheWrite: bucket.cacheWrite,
      cost: bucket.cost,
      turns: bucket.turns,
      source: {
        orchestrator: { ...bucket.source.orchestrator },
        subagent: { ...bucket.source.subagent },
      },
      specId: activeSpecId,
      nextState: toState,
    });
  }
  // Start accruing into the new state
  setAccrualState(toState);
}

let globalStatePersistence: GlobalStatePersistence;

/** Track spec approval interview start time for duration calculation. */
let specApprovalInterviewStartTime: number | null = null;

/** Module-level active spec ID. Set by pi_coder_save_spec, cleared on IDLE/COMPLETE. */
let activeSpecId: string | null = null;

/** Creation timestamp for the active spec's state.json. Set when spec is first saved. */
let specStateCreatedAt: string | null = null;

/** Project working directory — captured from session_start. */
let projectCwd: string = process.cwd();

/** Persist current FSM state to .pi-coder/state.json. Exported for use by commands. */
/** Tracks in-flight persistState() call to prevent concurrent tmp+rename races. */
let persistStatePromise: Promise<void> = Promise.resolve();

export async function persistState(): Promise<void> {
  // Serialize saves — each writes the full state, last one wins.
  // Wait for any in-flight save, then start ours.
  const prev = persistStatePromise.catch(() => {});
  const ourSave = prev.then(async () => {
    const now = new Date().toISOString();

    // 1. Save global state (pointer only)
    const globalState: GlobalState = {
      version: 1,
      piCoderMode,
      activeSpecId,
      updatedAt: now,
    };
    await globalStatePersistence.save(globalState);

    // 2. Save per-spec state (FSM + evidence) if a spec is active
    if (activeSpecId && stateMachine) {
      const fsmJson = stateMachine!.toJSON();
      const specState: SpecState = {
        version: 1,
        currentState: fsmJson.currentState as string,
        loopCount: fsmJson.loopCount as number,
        gitRef: fsmJson.gitRef as string | null,
        evidence: fsmJson.evidence as EvidenceFlag[],
        currentUnitName: fsmJson.currentUnitName as string | null ?? null,
        createdAt: specStateCreatedAt ?? now,
        updatedAt: now,
      };
      await SpecStatePersistence.save(
        join(projectCwd, ".pi-coder", "specs"),
        activeSpecId,
        specState,
      );
    }
  });
  persistStatePromise = ourSave;
  return ourSave;
}

/** Log a structured event. Convenience wrapper that adds sessionId, timestamp, turnCount, and mode. */
function logEvent(type: LogEventType, payload: Record<string, unknown>): void {
  if (!logger) return; // Not initialized yet — no-op
  logger.log({
    timestamp: new Date().toISOString(),
    sessionId,
    type,
    payload: { ...payload, turnCount: sessionTurnCount, mode: piCoderMode },
  });
}

// ---------------------------------------------------------------------------
// Tool Input Summary Helper — for logging tool_call events
// ---------------------------------------------------------------------------

/**
 * Summarize tool input for logging. Extracts key field names/values
 * without logging sensitive data (file contents, API keys, full interview questions).
 */
function summarizeToolInput(toolName: string, input: unknown): Record<string, unknown> {
  const inp = input as Record<string, unknown>;
  switch (toolName) {
    case "pi_coder_advance_fsm":
      return { targetState: inp.targetState, fixType: inp.fixType };
    case "pi_coder_run_tests":
      return { suite: inp.suite, filter: inp.filter };
    case "pi_coder_git":
      return { action: inp.action };
    case "pi_coder_save_spec":
      return { id: inp.id, title: inp.title };
    case "pi_coder_read_spec":
      return { id: inp.id };
    case "subagent":
      return { agent: inp.agent, task: typeof inp.task === "string" ? inp.task.slice(0, 100) : undefined };
    case "interview":
      return { questions: "..." }; // Don't log interview content
    case "upsert_knowledge":
      return { filename: inp.filename };
    default:
      return {}; // ls, find, grep — no sensitive data, but also not worth logging the pattern
  }
}

// ---------------------------------------------------------------------------
// Orchestrator System Prompt — loaded from .md file
// ---------------------------------------------------------------------------

/** Cached orchestrator prompt template loaded from .md file. */
let orchestratorPromptTemplate: string | null = null;

// FSM diagram is now built by BaseStateMachine.buildDiagram() — see Unit 1

/** Plan mode prompt template — cached for the session. */
let planModePromptTemplate: string | null = null;

/** Reset the cached plan mode prompt template. Called by reset-agents. */
export function resetPlanModePromptCache(): void {
  planModePromptTemplate = null;
}

function buildPlanModePrompt(filteredSnippets: Record<string, string>): string {
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
  sm: IStateMachine,
  filteredSnippets: Record<string, string>,
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
let lightModePromptTemplate: string | null = null;

function buildLightModePrompt(sm: IStateMachine, filteredSnippets: Record<string, string>): string {
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

/** Reset the cached light mode prompt template. */
export function resetLightModePromptCache(): void {
  lightModePromptTemplate = null;
}

// ---------------------------------------------------------------------------
// Nudge Helpers
// ---------------------------------------------------------------------------

/**
 * Get the nudge threshold for a given FSM state.
 * Returns undefined if nudging is disabled for the state.
 */
function getNudgeThreshold(state: string): number | undefined {
  if (!config.nudge.enabled) return undefined;

  const stateConfig = (config.nudge.states as Record<string, NudgeStateConfig | undefined>)[state];
  if (stateConfig?.enabled === false) return undefined;

  return stateConfig?.turnsBeforeNudge ?? config.nudge.defaults.turnsBeforeNudge;
}

/**
 * Build a nudge message for the given level.
 */
function buildNudgeMessage(state: string, level: number): string {
  const expectation = stateMachine!.canNudge();

  if (level === 1) {
    return `\n\n[NUDGE] Reminder: You are in state ${state}. The expected next action is: ${expectation.expectedAction}.`;
  }

  if (level === 2) {
    const lifecycle = piCoderMode === "light" ? "implementation" : "TDD";
    return `\n\n[NUDGE - URGENT] You must now proceed with: ${expectation.expectedAction}. This is a required step in the ${lifecycle} lifecycle. The FSM cannot advance until this action is taken.`;
  }

  // Level 3 is handled via ctx.ui.notify(), not appended to the prompt
  return "";
}

/**
 * Reset nudge state — called on FSM transition or action attempted.
 */
export function resetNudgeState(newState: string): void {
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

/**
 * Check if a notification event should fire based on config.
 * If config.notifications.events is not set, all events are enabled.
 */
function shouldNotify(event: string): boolean {
  if (!config.notifications.enabled) return false;
  const allowed = config.notifications.events;
  if (!allowed) return true; // default: all events
  return allowed.includes(event as any);
}

/**
 * Send a desktop notification if the event is configured.
 */
function notify(event: string, title: string, body: string): void {
  if (shouldNotify(event)) {
    sendDesktopNotification(title, body);
  }
}

/**
 * Format referenceProjects config into a prompt section.
 * Returns empty string if no reference projects configured.
 */
function formatReferenceProjects(referenceProjects: Record<string, string> | undefined): string {
  if (!referenceProjects || Object.keys(referenceProjects).length === 0) {
    return "";
  }
  const lines = ["**Reference Projects (EXPERIMENTAL):**"];
  for (const [name, absPath] of Object.entries(referenceProjects)) {
    lines.push(`- **${name}**: ${absPath}`);
  }
  lines.push("");
  lines.push("When investigating a reference project, delegate to pi-coder.researcher and include the");
  lines.push("project path in the task. Do NOT pass cwd to the subagent tool — the researcher accesses");
  lines.push("reference projects by navigating to them via bash (cd, grep, find) and reading files");
  lines.push("with absolute paths. Reads are allowed; writes are blocked by damage-control.");
  return lines.join("\n");
}

/**
 * Format testCommands config into a prompt section.
 * Returns empty string if no testCommands configured.
 */
function formatTestSuites(testCommands: TestCommands | undefined): string {
  if (!testCommands || Object.keys(testCommands).length === 0) {
    return "";
  }
  const lines = ["**Available Test Suites:**"];
  for (const [name, command] of Object.entries(testCommands)) {
    lines.push(`- **${name}**: \`${command}\``);
  }
  lines.push("");
  lines.push("Use pi_coder_run_tests with suite parameter to run a specific suite.");
  lines.push("Default suite is 'unit'. Use suite='all' to run every suite.");
  lines.push("When a spec unit has testSuite set, pass that suite name when running tests for that unit.");
  return lines.join("\n");
}

const DEFAULT_CONFIG: PiCoderConfig = {
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
  logging: {
    enabled: false,
    level: "standard",
    maxLogFiles: 10,
  },
  subagentControl: {
    enabled: true,
  },
  notifications: {
    enabled: false,
  },
};

/** Validate critical config values, applying fixes and emitting warnings. */
/** Result of validating a PiCoderConfig. */
interface ConfigValidationResult {
  config: PiCoderConfig;
  warnings: Array<{ field: string; value: unknown; fix: string }>;
}

function validateConfig(cfg: PiCoderConfig): ConfigValidationResult {
  const warnings: Array<{ field: string; value: unknown; fix: string }> = [];

  if (typeof cfg.maxLoops !== "number" || cfg.maxLoops < 1) {
    warnings.push({ field: "maxLoops", value: cfg.maxLoops, fix: "defaulted to 3" });
    console.warn(`⚠️ pi-coder: maxLoops must be a positive integer, got ${cfg.maxLoops} — defaulting to 3`);
    cfg = { ...cfg, maxLoops: 3 };
  }
  if (typeof cfg.testCommand !== "string" || cfg.testCommand.trim() === "") {
    warnings.push({ field: "testCommand", value: cfg.testCommand, fix: 'defaulted to "npm test"' });
    console.warn(`⚠️ pi-coder: testCommand must be a non-empty string, got ${JSON.stringify(cfg.testCommand)} — defaulting to "npm test"`);
    cfg = { ...cfg, testCommand: "npm test" };
  }
  if (cfg.testCommands) {
    const tc = cfg.testCommands;
    // Validate all values are non-empty strings (testCommands is now Record<string, string>)
    let modified = false;
    for (const [key, value] of Object.entries(tc)) {
      if (typeof value !== "string" || value.trim() === "") {
        if (key === "unit" && Object.keys(tc).length === 1) {
          // Only key and it's invalid — fall back to testCommand
          warnings.push({ field: `testCommands.${key}`, value, fix: "fell back to testCommand" });
          console.warn(`⚠️ pi-coder: testCommands.${key} must be a non-empty string, got ${JSON.stringify(value)} — falling back to testCommand`);
          tc[key] = cfg.testCommand;
          modified = true;
        } else {
          // Remove invalid entries
          warnings.push({ field: `testCommands.${key}`, value, fix: "removed" });
          console.warn(`⚠️ pi-coder: testCommands.${key} must be a non-empty string if provided, got ${JSON.stringify(value)} — removing`);
          delete tc[key];
          modified = true;
        }
      }
    }
    if (modified) {
      cfg = { ...cfg, testCommands: { ...tc } };
    }
  }
  if (typeof cfg.interviewTimeout !== "number" || cfg.interviewTimeout < 0) {
    warnings.push({ field: "interviewTimeout", value: cfg.interviewTimeout, fix: "defaulted to 0" });
    console.warn(`⚠️ pi-coder: interviewTimeout must be ≥ 0, got ${cfg.interviewTimeout} — defaulting to 0`);
    cfg = { ...cfg, interviewTimeout: 0 };
  }
  if (typeof cfg.branchPrefix !== "string" || cfg.branchPrefix.trim() === "") {
    warnings.push({ field: "branchPrefix", value: cfg.branchPrefix, fix: 'defaulted to "pi-coder/"' });
    console.warn(`⚠️ pi-coder: branchPrefix must be a non-empty string, got ${JSON.stringify(cfg.branchPrefix)} — defaulting to "pi-coder/"`);
    cfg = { ...cfg, branchPrefix: "pi-coder/" };
  }
  return { config: cfg, warnings };
}

function loadConfig(cwd: string): ConfigValidationResult {
  const configPath = join(cwd, ".pi-coder", "config.json");
  try {
    if (existsSync(configPath)) {
      const raw = readFileSync(configPath, "utf-8");
      const parsed = JSON.parse(raw);

      // Migrate legacy gitStrategy → createBranch + mergeBranch
      if ("gitStrategy" in parsed && !("createBranch" in parsed) && !("mergeBranch" in parsed)) {
        if (parsed.gitStrategy === "squash") {
          parsed.mergeBranch = "squash";
        } else {
          parsed.mergeBranch = "merge";
        }
        parsed.createBranch = true;
        delete parsed.gitStrategy;
      }

      // Resolve and validate referenceProjects paths
      if (parsed.referenceProjects && typeof parsed.referenceProjects === "object") {
        const resolved: Record<string, string> = {};
        for (const [name, rawPath] of Object.entries(parsed.referenceProjects)) {
          if (typeof rawPath !== "string") continue;
          // Expand ~ to home directory
          let expanded = rawPath.startsWith("~/")
            ? join(process.env.HOME ?? "/tmp", rawPath.slice(2))
            : rawPath.startsWith("~")
              ? join(process.env.HOME ?? "/tmp", rawPath.slice(1))
              : rawPath;
          // Resolve relative paths against project cwd
          const absolute = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
          // Validate directory exists
          if (existsSync(absolute)) {
            resolved[name] = absolute;
          } else {
            console.warn(`⚠️ pi-coder: reference project "${name}" path not found: ${absolute} — skipping`);
          }
        }
        parsed.referenceProjects = Object.keys(resolved).length > 0 ? resolved : undefined;
      }

      return validateConfig({ ...DEFAULT_CONFIG, ...parsed, nudge: { ...DEFAULT_CONFIG.nudge, ...(parsed.nudge ?? {}) }, logging: { ...DEFAULT_CONFIG.logging, ...(parsed.logging ?? {}) }, subagentControl: { ...DEFAULT_CONFIG.subagentControl, ...(parsed.subagentControl ?? {}) }, notifications: { ...DEFAULT_CONFIG.notifications, ...(parsed.notifications ?? {}) } });
    }
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    console.warn(`⚠️ pi-coder: failed to load config.json: ${message} — using defaults`);
    // Fall through to default
  }
  return validateConfig({ ...DEFAULT_CONFIG });
}

// ---------------------------------------------------------------------------
// Intercom receipt detection and review extraction diagnostics
// ---------------------------------------------------------------------------

/**
 * Detect whether the rawContent text is a pi-intercom receipt.
 * When the intercom receipt path is taken, the tool result's content is
 * replaced with a receipt string like "Delivered single subagent result via intercom."
 * and the details.results[*].finalOutput is stripped to undefined.
 *
 * Detection: look for "Delivered" + "via intercom" in the text.
 */
export function isIntercomReceipt(rawContent: unknown): boolean {
  if (!Array.isArray(rawContent)) return false;
  const textBlock = rawContent.find(
    (c: unknown) => typeof c === "object" && c !== null && (c as Record<string, unknown>).type === "text"
  );
  if (!textBlock) return false;
  const text = (textBlock as { type: string; text?: string }).text ?? "";
  return /Delivered\s+.*\s+via intercom/i.test(text);
}

/**
 * Extract diagnostic text info from details object for logging.
 * Returns actual content length and preview — not the always-0 values
 * we were logging before (which checked typeof details === "string").
 */
export function extractDetailsDiagnostics(details: unknown): {
  hasFinalOutput: boolean;
  textLength: number;
  firstHundredChars: string;
} {
  if (!details || typeof details !== "object") {
    return { hasFinalOutput: false, textLength: 0, firstHundredChars: "" };
  }
  const r = details as Record<string, unknown>;
  let text = "";
  let hasFinalOutput = false;

  if (Array.isArray(r.results)) {
    const firstResult = (r.results as Array<Record<string, unknown>>)[0];
    if (firstResult) {
      hasFinalOutput = typeof firstResult.finalOutput === "string";
      if (hasFinalOutput) {
        text = firstResult.finalOutput as string;
      }
    }
  } else if (typeof r.content === "string") {
    text = r.content;
    hasFinalOutput = false; // Not finalOutput, but there IS text
  } else if (Array.isArray(r.content)) {
    text = (r.content as Array<{ type: string; text?: string }>)
      .filter((c: { type: string }) => c.type === "text")
      .map((c: { text?: string }) => c.text ?? "")
      .join("\n");
  }

  return {
    hasFinalOutput,
    textLength: text.length,
    firstHundredChars: text.slice(0, 100).replace(/\n/g, "\\n"),
  };
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
 * Extract subagent usage data from a pi-subagents Details tool result.
 *
 * pi-subagents provides usage inside `details.results[0].usage` with shape:
 *   { input, output, cacheRead, cacheWrite, cost, turns }
 * and model/exitCode/error on `details.results[0]` itself.
 *
 * This replaces the old `extractTokenUsage()` which incorrectly read
 * `details.usage.prompt_tokens` (OpenAI shape) — a path that never exists
 * on the pi-subagents Details object.
 */
export interface SubagentUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
  model: string | null;
  exitCode: number;
  error: string | null;
}

function extractSubagentUsage(details: unknown): SubagentUsage | null {
  if (!details || typeof details !== "object") return null;
  const d = details as { results?: Array<Record<string, unknown>> };
  const firstResult = d.results?.[0];
  if (!firstResult) return null;

  const usage = firstResult.usage as {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    cost?: number;
    turns?: number;
  } | undefined;

  if (!usage) return null;
  if ((usage.input ?? 0) === 0 && (usage.output ?? 0) === 0 && (usage.cost ?? 0) === 0) return null;

  return {
    input: usage.input ?? 0,
    output: usage.output ?? 0,
    cacheRead: usage.cacheRead ?? 0,
    cacheWrite: usage.cacheWrite ?? 0,
    cost: usage.cost ?? 0,
    turns: usage.turns ?? 0,
    model: typeof firstResult.model === "string" ? firstResult.model : null,
    exitCode: typeof firstResult.exitCode === "number" ? firstResult.exitCode : 0,
    error: typeof firstResult.error === "string" ? firstResult.error : null,
  };
}

/**
 * Extract review verdict from a subagent output (reviewer agent).
 * Looks for common verdict patterns in the text output.
 *
 * Tier 0 (highest priority): Structured ---VERDICT--- block.
 * Tier 1 (fallback): Emoji verdict markers — uses LAST occurrence
 * in the text to avoid false positives from emojis in prose.
 * Tier 2 (fallback): Text-based pattern matching on full text.
 *
 * @param result - The subagent result (Details object with results array,
 *   or a content string/array).
 * @param rawContentText - Optional fallback text source. When pi-intercom
 *   receipt path strips `finalOutput` from the Details object, the
 *   verdict may still be present in the raw content. This parameter
 *   is tried when `finalOutput` is unavailable.
 */
export function extractReviewVerdict(result: unknown, rawContentText?: string): ReviewVerdict | null {
  if (!result || typeof result !== "object") return null;

  const r = result as Record<string, unknown>;

  // Extract text from the pi-subagents Details format:
  // details = { mode, results: [{ finalOutput, messages, ... }], ... }
  // Fallback: raw content blocks (for tests or non-standard formats)
  // Fallback: rawContentText parameter (when intercom receipt strips finalOutput)
  let text = "";
  if (Array.isArray(r.results)) {
    // pi-subagents Details format — use finalOutput from first result
    const firstResult = (r.results as Array<Record<string, unknown>>)[0];
    if (firstResult) {
      if (typeof firstResult.finalOutput === "string") {
        text = firstResult.finalOutput;
      }
    }
  } else if (typeof r.content === "string") {
    text = r.content;
  } else if (Array.isArray(r.content)) {
    // Tool result content is often an array of content blocks
    text = (r.content as Array<{ type: string; text?: string }>)
      .filter((c: { type: string }) => c.type === "text")
      .map((c: { text?: string }) => c.text ?? "")
      .join("\n");
  }

  // Fallback: try rawContentText when primary source yielded nothing
  // (e.g., pi-intercom receipt stripped finalOutput to undefined)
  if (!text && typeof rawContentText === "string" && rawContentText.length > 0) {
    text = rawContentText;
  }

  if (!text) return null;

  // --- Tier 0: Structured verdict block (highest priority) ---
  // Parse ---VERDICT--- blocks from the reviewer's output.
  // This is the primary mechanism; emoji/text patterns are fallback for
  // reviews that haven't adopted the block format yet.
  const verdictBlockMatch = text.match(/---VERDICT---\s*\n\s*VERDICT:\s*(approved|needs_changes)\s*\n(?:\s*FIX_TYPE:\s*(functional|non-functional|non_functional)\s*\n)?\s*---END VERDICT---[\s\S]*/i);

  if (verdictBlockMatch) {
    const blockVerdict = verdictBlockMatch[1].toLowerCase() as "approved" | "needs_changes";

    if (blockVerdict === "approved") {
      return { verdict: "approved" };
    }

    // needs_changes: extract fix type from block
    let fixType: "functional" | "non-functional" = "functional"; // Safe default
    if (verdictBlockMatch[2]) {
      const rawFixType = verdictBlockMatch[2].toLowerCase();
      fixType = rawFixType === "non_functional" || rawFixType === "non-functional" ? "non-functional" : "functional";
    }

    return {
      verdict: "needs_changes",
      fixType,
      issues: [], // Block format doesn't carry structured issues
    };
  }

  // --- Tier 1: Emoji-based verdict extraction (fallback) ---
  // Use LAST occurrence to avoid false positives from emojis in prose.
  // The reviewer's verdict appears at the END of the review.
  const approvedIndex = text.lastIndexOf("✅");
  const rejectIndex = text.lastIndexOf("❌");
  const changesIndex = text.lastIndexOf("⚠️");

  let emojiVerdict: "approved" | "needs_changes" | null = null;

  if (approvedIndex !== -1 || rejectIndex !== -1 || changesIndex !== -1) {
    // Build a list of (verdict, index) pairs for emojis that were found
    const verdicts: Array<{ verdict: "approved" | "needs_changes"; index: number }> = [];

    if (approvedIndex !== -1) {
      verdicts.push({ verdict: "approved", index: approvedIndex });
    }
    if (rejectIndex !== -1) {
      verdicts.push({ verdict: "needs_changes", index: rejectIndex });
    }
    if (changesIndex !== -1) {
      verdicts.push({ verdict: "needs_changes", index: changesIndex });
    }

    // Sort by index descending — the LAST emoji in text wins
    verdicts.sort((a, b) => b.index - a.index);
    emojiVerdict = verdicts[0].verdict;
  }

  // --- Tier 2: Text-based pattern matching (fallback) ---
  // Search the full text (no 500-char limit) for text-only verdicts.
  // Only used if Tier 1 didn't find any emoji markers.
  let textVerdict: "approved" | "needs_changes" | null = null;
  if (emojiVerdict === null) {
    if (/\*\*Verdict:\*\*\s*approved/i.test(text)) {
      textVerdict = "approved";
    } else if (/\*\*Verdict:\*\*\s*(?:request\s+changes|needs\s+changes)/i.test(text)) {
      textVerdict = "needs_changes";
    } else if (/approved/i.test(text)) {
      textVerdict = "approved";
    } else if (/needs.?changes|request.?changes/i.test(text)) {
      textVerdict = "needs_changes";
    }
  }

  const verdict = emojiVerdict ?? textVerdict;
  if (verdict === null) return null;

  // For approved verdicts, no additional data needed
  if (verdict === "approved") {
    return { verdict: "approved" };
  }

  // --- needs_changes: extract fix type and issue counts ---

  // Extract fix type classification from reviewer output
  let fixType: "functional" | "non-functional" = "functional"; // Safe default
  const fixTypeMatch = text.match(/fix.?type:\s*(functional|non-functional|non_functional)/i);
  if (fixTypeMatch) {
    fixType = fixTypeMatch[1].toLowerCase().replace("_", "-") === "non-functional" ? "non-functional" : "functional";
  }

  return {
    verdict: "needs_changes",
    fixType,
    issues: [], // Regex extraction cannot produce structured issues
  };
}

// ---------------------------------------------------------------------------
// Extension Factory
// ---------------------------------------------------------------------------

export default function piCoderExtension(pi: ExtensionAPI): void {
  // -----------------------------------------------------------------------
  // Phase 1: Extension Foundation & Toggle State
  // -----------------------------------------------------------------------

  pi.on("session_start", async (_event, ctx) => {
    // Reset session state
    sessionTurnCount = 0;
    sessionStartTime = Date.now();
    sessionSpecCount = 0;

    // --- Child Process Guard ---
    // Pi-coder state machine must only run in the orchestrator process.
    // Child subagent processes (spawned by pi-subagents) get PI_SUBAGENT_DEPTH > 0.
    // Loading pi-coder in a child creates a second FSM that races with the parent's.
    if (Number(process.env.PI_SUBAGENT_DEPTH ?? "0") > 0) {
      piCoderMode = "off";
      stateMachine = null;
      return; // Skip all further initialization
    }

    // Capture ctx for UI refresh
    sessionCtx = ctx;
    const cwd = ctx.cwd;
    projectCwd = cwd;

    // Load config
    const configResult = loadConfig(cwd);
    config = configResult.config;

    // Generate session ID and initialize logger with session-scoped directory
    sessionId = randomUUID();
    const logDir = join(cwd, ".pi-coder", "logs");
    logger = new Logger(logDir, config.logging, sessionId);

    // Emit config_validation if there were warnings
    if (configResult.warnings.length > 0) {
      logEvent("config_validation", {
        warnings: configResult.warnings,
      });
    }

    // Load prompt templates (checks for project customization via cache reset)
    resetOrchestratorPromptCache();
    resetLightModePromptCache();
    resetPlanModePromptCache();
    loadOrchestratorPrompt(cwd);

    // Initialize state machine based on mode
    // Plan and Off modes don't have a state machine
    if (piCoderMode === "tdd") {
      stateMachine = new StateMachine(config);
    } else if (piCoderMode === "light") {
      stateMachine = new LightStateMachine(config);
    } else {
      stateMachine = null;
    }

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
    const smRef: StateMachineRef = {
      get current() { return stateMachine!; },
    };

    registerTools(pi, {
      stateMachine: smRef,
      activeSpecId: { get current() { return activeSpecId; } },
      setActiveSpecId: (id: string | null) => { activeSpecId = id; },
      piCoderMode: { get current() { return piCoderMode; } },
      gitOps,
      tddRunner,
      knowledgeStore,
      specManager,
      config,
      logEvent,
      sessionTurnCount: { get current() { return sessionTurnCount; } },
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
        if (piCoderMode === "off") return;
        const event = data as {
          event?: { type: string; agent: string; runId: string; message: string; reason?: string; turns?: number; toolCount?: number; currentTool?: string; elapsedMs?: number };
          source?: string;
        };
        const ctrl = event.event;
        if (!ctrl) return;

        // Only surface events that match our config thresholds
        if (ctrl.type === "needs_attention") {
          // Suppress if pi-coder already knows the subagent completed
          if (!subagentRunning) return;
          logEvent("subagent_control", {
            type: ctrl.type,
            agent: ctrl.agent,
            runId: ctrl.runId,
            reason: ctrl.reason,
            currentTool: ctrl.currentTool,
          });
          // Don't send as steer while subagent is running in foreground —
          // the agent is blocked on the tool call and can't act on it.
          // A queued steer gets delivered AFTER tool_result, creating stale
          // notifications that burn turns. The widget already shows the
          // attention state in the UI. If the subagent completes, the result
          // will be handled by the tool_result handler. If it's truly stuck,
          // the user can manually check via /pi-coder commands.
          //
          // For async subagents (not yet supported), steer delivery would
          // be appropriate since the agent isn't blocked.
          if (!subagentRunning) return;
          // Log only — no pi.sendMessage for foreground subagents
          // pi.sendMessage(
          //   {
          //     customType: "pi-coder-subagent-attention",
          //     content: `⚠️ Subagent ${ctrl.agent} needs attention: ${ctrl.message}. Run: subagent({ action: "status", id: "${ctrl.runId}" }) to inspect.`,
          //     display: true,
          //   },
          //   { deliverAs: "steer", triggerTurn: true },
          // );
        } else if (ctrl.type === "active_long_running") {
          // Log but do NOT send as a pi.sendMessage steer.
          //
          // In foreground mode, the agent is blocked on the subagent tool
          // call and CANNOT act on this notification. Queueing it as a
          // steer means it gets delivered AFTER the tool_result — completely
          // stale by then. Worse, each stale steer triggers an LLM turn
          // (acknowledging the notification), which causes another turn,
          // creating a feedback loop that burns 10+ turns on "ignoring
          // stale notification" before the user can speak.
          //
          // The subagent widget timer already shows elapsed time in the
          // UI for real-time monitoring. This event is just logged for
          // debugging/audit purposes.
          const elapsed = ctrl.elapsedMs ? Math.floor(ctrl.elapsedMs / 1000) : "?";
          logEvent("subagent_control", {
            type: ctrl.type,
            agent: ctrl.agent,
            runId: ctrl.runId,
            elapsedSeconds: elapsed,
            currentTool: ctrl.currentTool,
          });
        }
      });
    }

    // Listen for live subagent progress updates (tool_execution_update)
    // This is the real-time firehose — fires on every onUpdate callback from
    // the subagent tool, giving us the full AgentProgress data.
    if (subagentsAvailable) {
      pi.events.on("tool_execution_update", (data: unknown) => {
        if (piCoderMode === "off") return;
        const event = data as { toolName: string; partialResult: unknown };

        if (event.toolName !== "subagent") return;

        // The partialResult is AgentToolResult<Details> from pi-subagents.
        // We extract the first progress entry for single-agent runs.
        const result = event.partialResult as {
          details?: {
            progress?: Array<{
              agent: string;
              task: string;
              status: string;
              currentTool?: string;
              currentToolArgs?: string;
              currentPath?: string;
              toolCount: number;
              turnCount?: number;
              tokens: number;
              durationMs: number;
              recentTools?: Array<{ tool: string; args: string }>;
              lastActivityAt?: number;
            }>;
            results?: Array<{
              agent: string;
              task: string;
              progress?: {
                agent: string;
                task: string;
                status: string;
                currentTool?: string;
                currentToolArgs?: string;
                currentPath?: string;
                toolCount: number;
                turnCount?: number;
                tokens: number;
                durationMs: number;
                recentTools?: Array<{ tool: string; args: string }>;
                lastActivityAt?: number;
              };
            }>;
          };
        } | null;

        if (!result?.details) return;

        // Try to get progress from the progress array first, then from results
        const progress = result.details.progress?.[0]
          ?? result.details.results?.[0]?.progress;

        if (!progress || progress.status !== "running") return;

        subagentActivity = {
          agent: progress.agent,
          task: progress.task,
          currentTool: progress.currentTool,
          currentToolArgs: progress.currentToolArgs,
          currentPath: progress.currentPath,
          toolCount: progress.toolCount,
          turnCount: progress.turnCount,
          tokens: progress.tokens,
          durationMs: progress.durationMs,
          recentTools: progress.recentTools ?? [],
          lastUpdatedAt: progress.lastActivityAt ?? Date.now(),
        };

        // Detect skill reads for logging — fast, synchronous, no latency impact
        if (progress.currentTool === "read" && progress.currentPath?.includes("SKILL.md")) {
          const pathParts = progress.currentPath.split("/").filter(Boolean);
          // Parent directory of SKILL.md is the skill name
          const skillName = pathParts.length >= 2
            ? pathParts[pathParts.length - 2]
            : "unknown";
          logEvent("skill_read", {
            skillName,
            skillPath: progress.currentPath,
            subagentAgent: progress.agent,
            fsmState: stateMachine?.currentState ?? "N/A",
            mode: piCoderMode,
          });
        }

        // Update the subagent widget
        refreshSubagentWidget();
      });

      // When a subagent tool finishes executing, immediately clear the activity widget
      pi.events.on("tool_execution_end", (data: unknown) => {
        const event = data as { toolName: string };
        if (event.toolName !== "subagent") return;
        // The subagentActivity will be fully cleared in the tool_result handler,
        // but we can clear the widget immediately for snappier UX
        subagentActivity = null;
        refreshSubagentWidget();
      });
    }

    // Initialize state persistence
    const piCoderDir = join(cwd, ".pi-coder");
    globalStatePersistence = new GlobalStatePersistence(piCoderDir);

    // Restore persisted state from .pi-coder/state.json
    const savedGlobalState = await globalStatePersistence.load();
    if (savedGlobalState) {
      // Integrity check — verify spec directory exists when specId is set
      const integrity = await globalStatePersistence.checkIntegrity(savedGlobalState);

      // Restore mode — migrate from legacy piCoderActive if needed
      if (savedGlobalState.piCoderMode) {
        piCoderMode = savedGlobalState.piCoderMode;
      } else if (savedGlobalState.piCoderActive !== undefined) {
        // Legacy migration: piCoderActive=true → "tdd", piCoderActive=false → "off"
        piCoderMode = savedGlobalState.piCoderActive ? "tdd" : "off";
      }

      // Re-align stateMachine instance with restored mode.
      // Fix: stateMachine is created at line ~1138 using the default piCoderMode="tdd",
      // but piCoderMode isn't restored from persistence until above.
      // Without this re-alignment, a Light mode session gets a TDD StateMachine.
      if (piCoderMode === "light" && !(stateMachine instanceof LightStateMachine)) {
        stateMachine = new LightStateMachine(config);
      } else if (piCoderMode === "tdd" && !(stateMachine instanceof StateMachine)) {
        stateMachine = new StateMachine(config);
      } else if (piCoderMode === "plan" || piCoderMode === "off") {
        stateMachine = null;
      }

      // Restore active spec pointer
      activeSpecId = savedGlobalState.activeSpecId;

      if (savedGlobalState.activeSpecId && integrity.valid) {
        // Load per-spec state to restore the FSM
        const specDir = join(cwd, ".pi-coder", "specs");
        const specState = await SpecStatePersistence.load(specDir, savedGlobalState.activeSpecId);

        if (specState) {
          // Restore FSM from per-spec state — instantiate the right class
          // based on the current mode. Cross-mode restore is blocked: a TDD spec
          // can't be resumed in Light mode and vice versa.
          const savedState = specState.currentState as string;
          const isTddState = savedState.startsWith("TDD_");
          const isLightOnlyState = savedState === "IMPLEMENTING";
          const modeMismatch =
            (piCoderMode === "light" && isTddState) ||
            (piCoderMode === "tdd" && isLightOnlyState);

          if (modeMismatch) {
            logEvent("state_restore", {
              status: "mode_mismatch",
              specId: savedGlobalState.activeSpecId,
              savedState,
              currentMode: piCoderMode,
              message: `Spec was created in ${isTddState ? "TDD" : "Light"} mode but current mode is ${piCoderMode}. Switch modes to resume.`,
            });
            ctx.ui.notify(
              `Active spec '${savedGlobalState.activeSpecId}' was created in ${isTddState ? "TDD" : "Light"} mode. Switch to ${isTddState ? "TDD" : "Light"} mode with /pi-coder to resume.`,
              "warning",
            );
            // Don't restore — start with a fresh FSM
            stateMachine = piCoderMode === "tdd"
              ? new StateMachine(config)
              : new LightStateMachine(config);
          } else if (piCoderMode === "tdd") {
            stateMachine = StateMachine.fromJSON({
              currentState: specState.currentState as FSMState,
              loopCount: specState.loopCount,
              gitRef: specState.gitRef,
              currentUnitName: specState.currentUnitName ?? null,
              evidence: specState.evidence,
            }, config);
          } else if (piCoderMode === "light") {
            stateMachine = LightStateMachine.fromJSON({
              currentState: specState.currentState as import("../src/types.ts").LightFSMState,
              loopCount: specState.loopCount,
              gitRef: specState.gitRef,
              currentUnitName: specState.currentUnitName ?? null,
              evidence: specState.evidence,
            }, config);
          } else {
            // Plan or Off mode — no FSM to restore
            stateMachine = null;
          }
          specStateCreatedAt = specState.createdAt;

          // Log successful restore
          if (!modeMismatch && piCoderMode !== "off" && piCoderMode !== "plan") {
            logEvent("state_restore", {
              status: "success",
              specId: savedGlobalState.activeSpecId,
              fsmState: specState.currentState,
              mode: piCoderMode,
            });
          }
        } else {
          // Spec directory exists but no state.json — corrupted
          logEvent("state_restore", {
            status: "spec_state_missing",
            specId: savedGlobalState.activeSpecId,
          });
          // Clear the pointer and start fresh
          activeSpecId = null;
          await globalStatePersistence.delete();
        }
      } else if (savedGlobalState.activeSpecId && !integrity.valid) {
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
        // Clear the pointer and delete the corrupt state file
        activeSpecId = null;
        await globalStatePersistence.delete();
      } else {
        // No active spec or terminal state — delete global state
        await globalStatePersistence.delete();
      }

      if (integrity.warnings.length > 0) {
        logEvent("state_restore", {
          status: "warnings",
          warnings: integrity.warnings,
        });
      }
    }

    // Initialize nudge state from current FSM state (null in Plan/Off modes)
    resetNudgeState(stateMachine?.currentState ?? "IDLE");

    // Activate mode if subagents are available
    if (subagentsAvailable) {
      if (piCoderMode !== "off") {
        const toolSet = piCoderMode === "tdd" ? ORCHESTRATOR_TOOLS : (piCoderMode === "light" ? LIGHT_TOOLS : PLAN_TOOLS);
        pi.setActiveTools(toolSet);
        refreshUI();
      }
    } else {
      // Subagents not available — can't activate any orchestrator mode
      piCoderMode = "off";
      ctx.ui.notify(
        "Pi Coder: Orchestrator modes require pi-subagents. Install with: `pi install npm:pi-subagents`",
        "warning",
      );
    }
  });

  // -----------------------------------------------------------------------
  // Desktop Notifications
  // -----------------------------------------------------------------------

  pi.on("agent_end", async () => {
    if (piCoderMode === "off") return;
    notify("agent_end", "Pi Coder \u00b7 Idle", "Waiting for your input");
  });

  // -----------------------------------------------------------------------
  // Main-Session Token Capture — hook turn_end for orchestrator usage
  // -----------------------------------------------------------------------

  pi.on("turn_end", async (event) => {
    if (piCoderMode === "off") return;
    // Extract usage from the assistant message in this turn
    const msg = event.message as { usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: { total: number }; totalTokens: number } };
    const usage = msg?.usage;
    if (!usage) return;

    const inVal = usage.input ?? 0;
    const outVal = usage.output ?? 0;
    const crVal = usage.cacheRead ?? 0;
    const cwVal = usage.cacheWrite ?? 0;
    const costVal = usage.cost?.total ?? 0;

    // Accumulate into lifecycle tokens (same accumulator as subagent tokens)
    lifecycleTokens.input += inVal;
    lifecycleTokens.output += outVal;
    lifecycleTokens.cacheRead += crVal;
    lifecycleTokens.cacheWrite += cwVal;
    lifecycleTokens.cost += costVal;

    // Accrue into per-FSM-state bucket (source: orchestrator)
    const fsmState = stateMachine?.currentState ?? "N/A";
    if (currentAccrualState) {
      ensurePhaseBucket(currentAccrualState);
      const bucket = phaseTokens[currentAccrualState];
      bucket.input += inVal;
      bucket.output += outVal;
      bucket.cacheRead += crVal;
      bucket.cacheWrite += cwVal;
      bucket.cost += costVal;
      bucket.source.orchestrator.input += inVal;
      bucket.source.orchestrator.output += outVal;
      bucket.source.orchestrator.cacheRead += crVal;
      bucket.source.orchestrator.cacheWrite += cwVal;
      bucket.source.orchestrator.cost += costVal;
    }

    // Log per-turn usage for granular analysis
    logEvent("turn_usage", {
      input: inVal,
      output: outVal,
      cacheRead: crVal,
      cacheWrite: cwVal,
      cost: costVal,
      model: (event.message as { model?: string }).model ?? null,
      specId: activeSpecId,
      fsmState,
    });
  });

  // -----------------------------------------------------------------------
  // Session Shutdown — cleanup timers and references
  // -----------------------------------------------------------------------

  pi.on("session_shutdown", async () => {
    // Emit session summary before cleanup — works for all modes
    logEvent("session_summary", {
      totalTurns: sessionTurnCount,
      totalTokens: { ...lifecycleTokens },
      specsAttempted: sessionSpecCount,
      finalMode: piCoderMode,
      finalFsmState: stateMachine?.currentState ?? "N/A",
      sessionDurationMs: sessionStartTime !== null ? Date.now() - sessionStartTime : null,
    });

    if (subagentWidgetTimer) {
      clearInterval(subagentWidgetTimer);
      subagentWidgetTimer = null;
    }
    subagentRunning = false;
    subagentActivity = null;
    sessionTurnCount = 0;
    sessionStartTime = null;
    sessionSpecCount = 0;
    specApprovalInterviewStartTime = null;
    // Persist final state so it survives session restarts
    if (stateMachine) {
      await persistState();
    }
  });

  // -----------------------------------------------------------------------
  // Phase 2: System Prompt Replacement
  // -----------------------------------------------------------------------

  pi.on("before_agent_start", async (event, ctx) => {
    // Increment session turn counter — every agent turn counts
    sessionTurnCount++;

    // When off or subagents not available, let pi run normally
    if (piCoderMode === "off" || !subagentsAvailable) return;

    const { systemPromptOptions } = event;

    // Determine which tools and prompt to use based on mode
    const toolSets: Record<PiCoderMode, string[]> = {
      off: NORMAL_TOOLS,
      plan: PLAN_TOOLS,
      light: LIGHT_TOOLS,
      tdd: ORCHESTRATOR_TOOLS,
    };
    const modeTools = toolSets[piCoderMode];

    // Filter to mode-appropriate tools only
    const filteredSnippets: Record<string, string> = {};
    for (const name of modeTools) {
      if (systemPromptOptions.toolSnippets?.[name]) {
        filteredSnippets[name] = systemPromptOptions.toolSnippets[name];
      }
    }

    // Build the appropriate prompt based on mode
    let orchestratorPrompt: string;
    if (piCoderMode === "tdd") {
      orchestratorPrompt = buildOrchestratorPrompt(
        stateMachine!,
        filteredSnippets,
      );
    } else if (piCoderMode === "light") {
      orchestratorPrompt = buildLightModePrompt(stateMachine!, filteredSnippets);
    } else { // plan
      orchestratorPrompt = buildPlanModePrompt(filteredSnippets);
    }

    // (Guidelines from tools are already embedded in orchestratorPrompt via filteredSnippets)

    // Build the full system prompt manually.
    // We can't use buildSystemPrompt() because it's not re-exported from the main package.
    // The customPrompt path in buildSystemPrompt is: customPrompt + appendSystemPrompt + project_context + skills + date + CWD
    let fullPrompt = orchestratorPrompt;

    // Prepend active mode indicator — this ensures the LLM always knows its current mode,
    // even after mid-conversation mode switches where the old prompt is still in context.
    const modeIndicator: Record<PiCoderMode, string> = {
      plan: "[MODE: PLAN] Investigation and discussion only. Delegate to pi-coder.researcher. No specs, no git, no FSM.",
      light: "[MODE: LIGHT] FSM is active. Follow the lifecycle: spec → implement → review → merge. No TDD phases.",
      tdd: "[MODE: TDD] FSM state machine is active. Follow the TDD lifecycle: spec → RED/GREEN → review → merge.",
      off: "", // Never reached — off mode returns early
    };
    fullPrompt = modeIndicator[piCoderMode] + "\n\n" + fullPrompt;

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

    // Filter skills to mode-relevant ones only
    const allSkills = systemPromptOptions.skills ?? [];
    const filteredSkills = allSkills.filter(skill => {
      if (skill.name === 'pi-coder-core') return true;  // Always include core
      if (piCoderMode === 'tdd' && skill.name === 'pi-coder-tdd') return true;
      if (piCoderMode === 'light' && skill.name === 'pi-coder-light') return true;
      if (piCoderMode === 'plan' && skill.name === 'pi-coder-plan') return true;
      // Include non-pi-coder skills (pi-subagents, pi-intercom, librarian, etc.)
      if (!skill.name.startsWith('pi-coder-')) return true;
      return false;
    });

    // Manually append skills since read is excluded from selectedTools
    // buildSystemPrompt only includes <available_skills> when read is in selectedTools
    if (filteredSkills.length > 0) {
      fullPrompt += formatSkillsForPrompt(filteredSkills as Skill[]);
    }

    // Append date and working directory (matches buildSystemPrompt behavior)
    const now = new Date();
    const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    fullPrompt += `\nCurrent date: ${date}`;
    fullPrompt += `\nCurrent working directory: ${systemPromptOptions.cwd?.replace(/\\/g, "/") ?? "."}`;

    // -------------------------------------------------------------------
    // Phase 4: Nudge System (TDD and Light modes — both have FSM states)
    // -------------------------------------------------------------------

    if (piCoderMode === "tdd" || piCoderMode === "light") {
    // Increment turn counter
    nudgeState.turnsSinceEntry++;

    // Check if nudging should fire
    const threshold = getNudgeThreshold(stateMachine!.currentState);
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
        fsmState: stateMachine?.currentState ?? "N/A",
        level: nudgeState.lastNudgeLevel,
        expectedAction: stateMachine!.canNudge().expectedAction,
      });

      if (nudgeState.lastNudgeLevel < maxEscalation) {
        // Levels 1-2: append to system prompt
        const nudgeMsg = buildNudgeMessage(
          stateMachine!.currentState,
          nudgeState.lastNudgeLevel,
        );
        fullPrompt += nudgeMsg;
      } else {
        // Level 3: user-visible notification
        const expectation = stateMachine!.canNudge();

        // Log nudge escalation
        logEvent("nudge_escalation", {
          fsmState: stateMachine?.currentState ?? "N/A",
          newLevel: nudgeState.lastNudgeLevel,
        });

        ctx.ui.notify(
          `Pi Coder: Orchestrator has not progressed past state ${stateMachine!.currentState} after ${nudgeState.turnsSinceEntry} turns. Expected: ${expectation.expectedAction}. Would you like to intervene?`,
          "warning",
        );
      }
    }
    } // end TDD/Light-mode nudge

    // Log prompt size before returning — measures prompt restructuring impact
    logEvent("prompt_size", {
      promptChars: fullPrompt.length,
      skillCount: filteredSkills.length,
      skillNames: filteredSkills.map(s => s.name),
      toolCount: Object.keys(filteredSnippets).length,
      contextFileCount: contextFiles.length,
      contextFileChars: contextFiles.reduce((sum, f) => sum + f.content.length, 0),
      fsmState: stateMachine?.currentState ?? "N/A",
      mode: piCoderMode,
    });

    // Return the replaced system prompt
    return { systemPrompt: fullPrompt };
  });

  // -----------------------------------------------------------------------
  // Phase 3: FSM Event Guards & Auto-Transitions
  // -----------------------------------------------------------------------

  // --- tool_call: Validate against FSM state ---

  pi.on("tool_call", async (event) => {
    if (piCoderMode === "off") return;

    const { toolName, input } = event;

    // Desktop notification on spec approval interview
    if (stateMachine && toolName === "interview" && stateMachine.currentState === "SPEC_WORK") {
      notify("spec_approval", "Pi Coder \u00b7 \uD83D\uDCCB Review", `Spec ${activeSpecId ?? "unknown"} ready for your approval`);
      specApprovalInterviewStartTime = Date.now();
    }

    // Determine which tools are allowed based on current mode
    const toolSets: Record<PiCoderMode, string[]> = {
      off: NORMAL_TOOLS,
      plan: PLAN_TOOLS,
      light: LIGHT_TOOLS,
      tdd: ORCHESTRATOR_TOOLS,
    };
    const allowedTools = toolSets[piCoderMode];

    // Default-deny: only mode-appropriate tools are allowed
    if (!allowedTools.includes(toolName)) {
      logEvent("tool_call_blocked", {
        toolName,
        mode: piCoderMode,
        fsmState: stateMachine?.currentState ?? "N/A",
        reason: "not_in_allowed_tools",
      });
      // Actionable feedback: tell the orchestrator what to do instead
      let guidance = `🛡️ "${toolName}" is not available to the orchestrator in ${piCoderMode} mode.`;
      if (toolName === "bash" || toolName === "edit" || toolName === "write" || toolName === "read") {
        guidance += ` You don't ${toolName === "bash" ? "run commands" : toolName === "read" ? "read file contents" : "edit files"} directly — you delegate. Use the "subagent" tool to delegate to pi-coder.implementor for code changes, or pi-coder.researcher to investigate the codebase.`;
      } else if (toolName === "pi_coder_advance_fsm" || toolName === "pi_coder_save_spec" || toolName === "pi_coder_read_spec") {
        guidance += ` These tools require the FSM lifecycle (Light or TDD mode). Plan mode is for investigation only — switch modes with /pi-coder to use them.`;
      } else {
        guidance += ` Available tools: ${allowedTools.join(", ")}`;
      }
      guidance += ` Do not retry this exact call.`;
      return { block: true, reason: guidance };
    }

    // Block raw git commands via bash (safety net if bash is ever re-added to tools)
    if (toolName === "bash") {
      const command = (input as { command?: string }).command ?? "";
      if (command.trimStart().startsWith("git ")) {
        return {
          block: true,
          reason: "🛡️ Raw git commands are blocked in orchestrator mode. Git operations go through pi_coder_git so the FSM can track them. Use pi_coder_git with actions: checkout_branch, checkpoint, rollback, merge.",
        };
      }
    }

    // --- FSM-based guards (TDD and Light modes) ---
    // Plan mode has no FSM, so no FSM-based guards apply
    if (piCoderMode === "tdd" || piCoderMode === "light") {
      // pi_coder_run_tests is always allowed — it's read-only
      // Auto-transitions in tool_result only fire from TDD validation states

      // Validate pi_coder_git against FSM state
      if (toolName === "pi_coder_git") {
        if (!stateMachine!.isActionAllowed("pi_coder_git")) {
          const current = stateMachine!.currentState;
          return {
            block: true,
            reason: `🛡️ pi_coder_git is not allowed in ${current}. Git operations are only allowed in: GIT_CHECKPOINT (create checkpoint), REVIEWING (checkpoint progress), MERGING (merge branch), BLOCKED/IDLE (rollback). ${current === "SPEC_WORK" ? "Save and approve the spec first, then the FSM will advance to SPEC_APPROVED → GIT_CHECKPOINT." : "Use pi_coder_advance_fsm to advance to the right state first."} Do not retry this exact call.`,
          };
        }
      }
    }

    // Validate subagent delegation (both modes)
    if (toolName === "subagent") {
      const targetAgent = extractSubagentTarget(
        input as Record<string, unknown>,
      );

      // Listing subagents (no target agent) is always allowed — it's discovery, not delegation
      if (targetAgent !== undefined) {
        // Only pi-coder subagents are allowed — block builtins and other packages
        if (!targetAgent.startsWith("pi-coder.")) {
          logEvent("tool_call_blocked", {
            toolName,
            targetAgent,
            mode: piCoderMode,
            fsmState: stateMachine?.currentState ?? "N/A",
            reason: "non_pi_coder_agent",
          });
          return {
            block: true,
            reason: `🛡️ Delegation to "${targetAgent}" is blocked — only pi-coder subagents are allowed (researcher, implementor, reviewer). Built-in agents and other packages are excluded to maintain TDD discipline. Use pi-coder.researcher to investigate, pi-coder.implementor to write code, or pi-coder.reviewer to verify. Do not retry this exact call.`,
          };
        }

        // Block delegation to self (orchestrator should never delegate to itself)
        if (targetAgent === "pi-coder.orchestrator") {
          logEvent("tool_call_blocked", {
            toolName,
            targetAgent,
            mode: piCoderMode,
            fsmState: stateMachine?.currentState ?? "N/A",
            reason: "self_delegation",
          });
          return {
            block: true,
            reason: "🛡️ The orchestrator cannot delegate to itself — you ARE the orchestrator. If you need something done, delegate to one of your subagents: pi-coder.researcher, pi-coder.implementor, or pi-coder.reviewer.",
          };
        }

        // Plan mode: only researcher is allowed — no implementor or reviewer
        if (piCoderMode === "plan" && targetAgent !== "pi-coder.researcher") {
          logEvent("tool_call_blocked", {
            toolName,
            targetAgent,
            mode: "plan",
            reason: "non_researcher_in_plan_mode",
          });
          return {
            block: true,
            reason: `Only pi-coder.researcher is available in Plan mode. "${targetAgent}" requires leaving plan mode — use /pi-coder to switch to Light or TDD mode. Do not retry this exact call.`,
          };
        }

        // In TDD or Light mode, validate subagent against FSM state
        if (piCoderMode === "tdd" || piCoderMode === "light") {
          if (
            !stateMachine!.isActionAllowed("subagent", targetAgent)
          ) {
            const current = stateMachine!.currentState;
            // Contextual guidance based on what they tried and where they are
            let guidance = `🛡️ Cannot delegate to ${targetAgent} in ${current}.`;
            if (targetAgent === "pi-coder.researcher" && current === "IDLE") {
              guidance += ` Step 1: pi_coder_advance_fsm with targetState "SPEC_WORK". Step 2: delegate to pi-coder.researcher.`;
            } else if (targetAgent === "pi-coder.implementor" && current === "SPEC_WORK") {
              guidance += ` The spec must be saved and approved first. Step 1: pi_coder_save_spec. Step 2: interview for approval. Step 3: pi_coder_advance_fsm with targetState "SPEC_APPROVED". Step 4: pi_coder_git checkpoint. Then you can delegate the implementor.`;
            } else if (targetAgent === "pi-coder.implementor" && current === "SPEC_APPROVED") {
              const nextLabel = piCoderMode === "light" ? "IMPLEMENTING" : "TDD_RED_WRITE";
              guidance += ` Checkpoint first, then the FSM auto-advances to ${nextLabel}. Step 1: pi_coder_git with action "checkpoint". Step 2: delegate to pi-coder.implementor.`;
            } else if (targetAgent === "pi-coder.reviewer" && current !== "REVIEWING") {
              guidance += ` The reviewer runs in REVIEWING state. Complete the current implementation cycle first, then pi_coder_advance_fsm with targetState "REVIEWING".`;
            } else {
              const validTargets = stateMachine!.getValidTransitions();
              guidance += ` Valid advance targets from ${current}: ${validTargets.join(", ")}. Use pi_coder_advance_fsm to advance, then delegate.`;
            }
            guidance += ` Do not retry this exact call.`;
            logEvent("tool_call_blocked", {
              toolName,
              targetAgent,
              fsmState: current,
              reason: "not_allowed_in_state",
            });
            return { block: true, reason: guidance };
          }

          // Soft gate: implementor in NEEDS_CHANGES requires non_functional_classified evidence
          // The reviewer must have classified the fix as non-functional before the
          // orchestrator can take the shortcut (skip RED/GREEN). This prevents the
          // orchestrator from self-authorizing untested code changes.
          //
          // TDD mode ONLY: In Light mode, there is no RED/GREEN cycle being bypassed,
          // so the non_functional_classified evidence gate doesn't apply. The implementor
          // can be freely delegated in NEEDS_CHANGES regardless of fix classification.
          if (
            piCoderMode === "tdd" &&
            targetAgent === "pi-coder.implementor" &&
            stateMachine!.currentState === "NEEDS_CHANGES" &&
            !stateMachine!.hasEvidence("non_functional_classified")
          ) {
            logEvent("tool_call_blocked", {
              toolName,
              targetAgent,
              fsmState: stateMachine?.currentState ?? "N/A",
              reason: "missing_non_functional_evidence",
            });
            return {
              block: true,
              reason:
                `🛡️ Cannot delegate implementor in NEEDS_CHANGES without reviewer classification. ` +
                `The reviewer must classify the fix as non-functional (include 'Fix-Type: non-functional' in its verdict) ` +
                `before the implementor can be delegated here. ` +
                `If the fix is functional (changes production behavior), advance to TDD_RED_WRITE for a full RED/GREEN cycle instead. ` +
                `Do not retry this exact call.`,
            };
          }
        }

        // Disable pi-subagents control events for foreground runs.
        // In foreground mode, the orchestrator is blocked waiting for the
        // subagent result and CANNOT act on real-time notifications.
        // These notifications get queued as steer messages and delivered
        // AFTER the tool_result — completely stale by then. Each stale
        // steer triggers an LLM turn, creating a feedback loop that burns
        // 10+ turns on "acknowledging stale notification" before the user
        // can speak. Disabling at the source prevents emissions entirely.
        (input as Record<string, unknown>).control = { enabled: false };

        // Track subagent timing
        subagentStartTime = Date.now();
        lastSubagentAgent = targetAgent;

        // Update UI to show subagent running
        subagentRunning = true;

        // Capture task from tool_call input for the subagent widget
        const taskInput = typeof (input as Record<string, unknown>).task === "string"
          ? ((input as Record<string, unknown>).task as string)
          : "";

        // Populate subagentActivity immediately from tool_call data
        subagentActivity = {
          agent: targetAgent,
          task: taskInput,
          currentTool: undefined,
          currentToolArgs: undefined,
          currentPath: undefined,
          toolCount: 0,
          turnCount: undefined,
          tokens: 0,
          durationMs: 0,
          recentTools: [],
          lastUpdatedAt: Date.now(),
        };

        refreshUI();
        refreshSubagentWidget();

        // Start a timer to update the subagent widget periodically (for elapsed duration)
        if (subagentWidgetTimer) clearInterval(subagentWidgetTimer);
        subagentWidgetTimer = setInterval(() => {
          if (subagentRunning && subagentActivity) {
            refreshSubagentWidget();
          } else {
            // Subagent ended — clean up timer
            if (subagentWidgetTimer) {
              clearInterval(subagentWidgetTimer);
              subagentWidgetTimer = null;
            }
          }
        }, 2000);

        // Log subagent delegation
        const taskStr = typeof (input as Record<string, unknown>).task === "string"
          ? ((input as Record<string, unknown>).task as string).slice(0, 200)
          : "";
        logEvent("subagent_start", {
          agent: targetAgent,
          taskSummary: taskStr,
          specId: activeSpecId,
          fsmState: stateMachine?.currentState ?? "N/A",
          mode: piCoderMode,
        });

        // Mark action as attempted (resets nudge urgency)
        nudgeState.actionAttempted = true;
      }
    }

    // Mark action attempted for pi_coder_run_tests and pi_coder_git too
    if (toolName === "pi_coder_run_tests" || toolName === "pi_coder_git") {
      nudgeState.actionAttempted = true;
    }

    // Log allowed tool call — only for validated, allowed calls
    logEvent("tool_call", {
      toolName,
      fsmState: stateMachine?.currentState ?? "N/A",
      mode: piCoderMode,
      specId: activeSpecId ?? "none",
      inputSummary: summarizeToolInput(toolName, input),
    });

    // Tool passed validation — allow
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

    if (piCoderMode === "off") return;
    if (piCoderMode === "plan") return; // No FSM, no auto-transitions

    const { details } = event;
    const currentState = stateMachine!.currentState;

    // Log lifecycle_start on IDLE → SPEC_WORK transitions (pi_coder_advance_fsm)
    // This replaces the old lifecycle_start that fired on first subagent completion (too late)
    if (toolName === "pi_coder_advance_fsm" && currentState === "SPEC_WORK" && lifecycleStartTime === null) {
      lifecycleStartTime = Date.now();
      resetLifecycleTracking();
      setAccrualState("SPEC_WORK");
      sessionSpecCount++;
      logEvent("lifecycle_start", {
        specId: activeSpecId ?? "none",
        userRequest: "(spec work initiated)",
      });
    }

    // Track all FSM transitions via pi_coder_advance_fsm
    // The tool executes the transition inside execute(), so we detect it from the result details.
    if (toolName === "pi_coder_advance_fsm") {
      const advDetails = details as { success?: boolean; previousState?: string; newState?: string; error?: string; exceptionTransition?: string; reason?: string } | undefined;
      if (advDetails?.success === true && advDetails?.previousState && advDetails?.newState && advDetails.previousState !== advDetails.newState) {
        emitStateUsageAndTransition(advDetails.previousState, advDetails.newState);
        logEvent("fsm_transition", {
          from: advDetails.previousState,
          to: advDetails.newState,
          trigger: "manual_advance_fsm",
          event: advDetails.exceptionTransition ? `exception:${advDetails.exceptionTransition}` : "advance",
          loopCount: stateMachine?.loopCount ?? 0,
          specId: activeSpecId,
          ...(advDetails.reason ? { exceptionReason: advDetails.reason } : {}),
        });

        // Log lifecycle events on terminal transitions via manual advance
        if (advDetails.newState === "COMPLETE") {
          const wallClockMs = lifecycleStartTime !== null ? Date.now() - lifecycleStartTime : null;
          logEvent("lifecycle_end", {
            specId: activeSpecId,
            outcome: "COMPLETE",
            wallClockMs,
            totalTokens: { ...lifecycleTokens },
            phaseTokens: Object.fromEntries(
              Object.entries(phaseTokens).map(([state, bucket]) => [state, {
                input: bucket.input,
                output: bucket.output,
                cacheRead: bucket.cacheRead,
                cacheWrite: bucket.cacheWrite,
                cost: bucket.cost,
                turns: bucket.turns,
                source: {
                  orchestrator: { ...bucket.source.orchestrator },
                  subagent: { ...bucket.source.subagent },
                },
              }])
            ),
          });
          notify("complete", "Pi Coder \u00b7 \u2705 Complete", `Spec ${activeSpecId ?? "unknown"} merged successfully`);
          lifecycleStartTime = null;
          resetLifecycleTracking();
        }

        // Log BLOCKED terminal state
        if (advDetails.newState === "BLOCKED") {
          const wallClockMs = lifecycleStartTime !== null ? Date.now() - lifecycleStartTime : null;
          logEvent("lifecycle_end", {
            specId: activeSpecId,
            outcome: "BLOCKED",
            wallClockMs,
            totalTokens: { ...lifecycleTokens },
            phaseTokens: Object.fromEntries(
              Object.entries(phaseTokens).map(([state, bucket]) => [state, {
                input: bucket.input,
                output: bucket.output,
                cacheRead: bucket.cacheRead,
                cacheWrite: bucket.cacheWrite,
                cost: bucket.cost,
                turns: bucket.turns,
                source: {
                  orchestrator: { ...bucket.source.orchestrator },
                  subagent: { ...bucket.source.subagent },
                },
              }])
            ),
          });
        }

        // Reset nudge state on transition via advance_fsm
        if (stateMachine) {
          resetNudgeState(stateMachine.currentState);
        }
      }
    }

    // Evidence: interview tool completion in SPEC_WORK → spec_user_approved
    // Only set when the user actually approved the spec:
    // 1. Interview status must be "completed" (not cancelled/timeout/aborted)
    // 2. ALL single-choice responses must have an option containing "Approve" (case-insensitive)
    // If any response indicates rejection, spec_user_approved is NOT set and a steer
    // message tells the orchestrator to review feedback and revise.
    if ((piCoderMode === "tdd" || piCoderMode === "light") && toolName === "interview" && currentState === "SPEC_WORK") {
      const interviewDetails = details as { status?: string; responses?: Array<{ id?: string; value?: unknown }> } | undefined;

      if (interviewDetails?.status === "completed") {
        // Check all single-choice responses for approval
        // Single-choice responses have value: { option: string; note?: string }
        const responses = interviewDetails.responses ?? [];
        const singleChoiceResponses = responses.filter((r) => {
          if (!r.value || typeof r.value !== "object") return false;
          const val = r.value as Record<string, unknown>;
          return "option" in val && typeof val.option === "string";
        });

        const allApproved = singleChoiceResponses.length > 0 && singleChoiceResponses.every((r) => {
          const choice = r.value as { option: string; note?: string };
          return choice.option.toLowerCase().includes("approve");
        });

        if (allApproved) {
          stateMachine!.setEvidence("spec_user_approved");
          const interviewDurationMs = specApprovalInterviewStartTime !== null ? Date.now() - specApprovalInterviewStartTime : null;
          specApprovalInterviewStartTime = null;
          logEvent("spec_approval", { status: "approved", responseCount: responses.length, durationMs: interviewDurationMs });
        } else {
          // User rejected or requested changes for at least one question
          const interviewDurationMs = specApprovalInterviewStartTime !== null ? Date.now() - specApprovalInterviewStartTime : null;
          specApprovalInterviewStartTime = null;
          logEvent("spec_approval", { status: "rejected", responseCount: responses.length, durationMs: interviewDurationMs });
          // Append steer message telling orchestrator to revise
          const rejectionSteer = "\n\n⚠️ Spec not approved — the user requested changes. Review the interview feedback and revise the spec. Re-run the interview after making changes.";
          if (Array.isArray(rawContent) && rawContent.length >= 1 && rawContent[0]?.type === "text") {
            const textBlock = rawContent[0] as { type: "text"; text: string };
            textBlock.text += rejectionSteer;
          }
        }
      } else {
        // Interview was cancelled, timed out, or aborted
        const status = interviewDetails?.status ?? "unknown";
        const interviewDurationMs = specApprovalInterviewStartTime !== null ? Date.now() - specApprovalInterviewStartTime : null;
        specApprovalInterviewStartTime = null;
        logEvent("spec_approval", { status: "not_completed", interviewStatus: status, durationMs: interviewDurationMs });
        const notCompletedSteer = `\n\n⚠️ Spec approval interview was not completed (status: ${status}). Re-run the interview when ready.`;
        if (Array.isArray(rawContent) && rawContent.length >= 1 && rawContent[0]?.type === "text") {
          const textBlock = rawContent[0] as { type: "text"; text: string };
          textBlock.text += notCompletedSteer;
        }
      }
    }

    // Handle pi_coder_run_tests results
    if (toolName === "pi_coder_run_tests") {
      const details2 = details as {
        testResult?: { exitCode: number; timedOut?: boolean; passed?: number | null; failed?: number | null; output?: string };
        validation?: { valid: boolean; reason?: string };
        phase?: string;
        currentState?: string;
        isTddValidation?: boolean;
      } | undefined;

      if (!details2?.isTddValidation || !details2?.validation) {
        // Not in a TDD validation state (or light mode) — return results as-is
        // No auto-transitions, no evidence
        return;
      }

      // We're in TDD mode, in a TDD validation state
      // Mark that tests were run in this state (evidence for transition guards)
      stateMachine!.setEvidence("test_run_this_state");

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
          specId: activeSpecId,
        });

        if (validation.valid) {
          // Tests failed as expected → advance to GREEN
          stateMachine!.transition("TDD_GREEN_WRITE");
          emitStateUsageAndTransition("TDD_RED_VALIDATE", "TDD_GREEN_WRITE");
          transitionSteer = "\n\n⚠️ AUTO-TRANSITION: You are now in TDD_GREEN_WRITE. Next step: delegate to pi-coder.implementor to implement the code that makes the tests pass. Do NOT call pi_coder_advance_fsm yet — first get the implementation done.";
        } else {
          // Tests passed unexpectedly during RED phase
          // This means either:
          //   - No new tests were written (the implementor wrote only production code)
          //   - New tests were written but they pass immediately (code+test simultaneously)
          //   - The test is genuinely tautological (asserts nothing meaningful)
          //
          // Don't auto-transition to BLOCKED — present guidance with three options.
          const reason = validation.reason ?? "RED_TAUTOLOGY";
          transitionSteer =
            `\n\n⚠️ Tests PASSED during RED phase (${reason}). You have three options:` +
            `\n1. **Re-delegate to write tests first**: Stay in TDD_RED_WRITE. Do NOT advance. Re-delegate to pi-coder.implementor with explicit instructions: \"Write ONLY failing test files for this unit. Do NOT modify production code.\" This is the correct TDD path when the implementor skipped the test-first step.` +
            `\n2. **Classify as approach: direct**: If this unit genuinely doesn't benefit from test-first development (config changes, documentation, non-behavioral changes), re-save the spec with approach: \"direct\" on this unit, then acknowledge the tautology with pi_coder_advance_fsm TDD_GREEN_WRITE. This records the decision explicitly.` +
            `\n3. **Acknowledge and proceed**: Use pi_coder_advance_fsm with targetState \"TDD_GREEN_WRITE\" — this skips GREEN since the code already works. Only do this if new tests WERE written and they pass because the feature already partially exists.` +
            `\n\nMost RED tautologies indicate the implementor did not write tests first. Option 1 is the default correct response. Option 2 is for genuinely non-behavioral units. Option 3 is ONLY for when new tests exist that test real new behavior but pass because the feature was already partially implemented.`; 
        }
      }

      if (currentState === "TDD_GREEN_VALIDATE") {
        // Log GREEN validation
        logEvent("tdd_green_validate", {
          valid: validation.valid,
          reason: validation.reason,
          passed: details2.testResult?.passed ?? null,
          failed: details2.testResult?.failed ?? null,
          specId: activeSpecId,
        });

        if (validation.valid) {
          // Tests pass — orchestrator decides: next unit or proceed to review
          transitionSteer = "\n\n✅ GREEN validation passed. Current FSM state: TDD_GREEN_VALIDATE. Use pi_coder_advance_fsm to advance: TDD_RED_WRITE (next implementation unit) or REVIEWING (all units complete).";

          // Log unit_end for the current unit if one is active
          if (stateMachine!.currentUnitName) {
            logEvent("unit_end", {
              specId: activeSpecId,
              unitName: stateMachine!.currentUnitName,
              outcome: "green_validated",
              loopCount: stateMachine!.loopCount,
              fsmState: stateMachine!.currentState,
            });
          }
        } else {
          // Tests still fail → loop back to GREEN
          stateMachine!.transition("TDD_GREEN_WRITE");
          emitStateUsageAndTransition("TDD_GREEN_VALIDATE", "TDD_GREEN_WRITE");
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
      if (stateMachine!.currentState !== previousState) {
        logEvent("fsm_transition", {
          from: previousState,
          to: stateMachine!.currentState,
          trigger: "auto_tdd_validation",
          event: validation.valid ? "validation_passed" : "validation_failed",
          loopCount: stateMachine!.loopCount,
          specId: activeSpecId,
        });

        // Log circuit breaker
        if (stateMachine!.circuitBreakerTripped()) {
          logEvent("circuit_breaker", {
            loopCount: stateMachine!.loopCount,
            maxLoops: config.maxLoops,
            specId: activeSpecId,
          });
          notify("circuit_breaker", "Pi Coder \u00b7 \uD83D\uDD34 Circuit Breaker", `Max review loops (${config.maxLoops}) exceeded on spec ${activeSpecId ?? "unknown"}`);

          // Log unit_end for circuit breaker
          if (stateMachine!.currentUnitName) {
            logEvent("unit_end", {
              specId: activeSpecId,
              unitName: stateMachine!.currentUnitName,
              outcome: "circuit_breaker",
              loopCount: stateMachine!.loopCount,
              fsmState: stateMachine!.currentState,
            });
          }
        }
      }

      // Reset nudge state on transition
      if (stateMachine!.currentState !== previousState) {
        resetNudgeState(stateMachine!.currentState);
      }

      // Persist state after transition
      await persistState();
    }

    // Handle pi_coder_git results (auto-transition for checkpoint & merge)"
    if (toolName === "pi_coder_git" && currentState === "GIT_CHECKPOINT") {
      // If git checkpoint succeeded in GIT_CHECKPOINT, auto-advance to next state.
      // Only fire on operation === "checkpoint" — checkout_branch in GIT_CHECKPOINT
      // should NOT trigger the checkpoint-complete auto-transition.
      const gitDetails = details as { operation?: string; success?: boolean; error?: string } | undefined;
      if (gitDetails?.success === true && gitDetails?.operation === "checkpoint") {
        const nextState = piCoderMode === "light" ? "IMPLEMENTING" : "TDD_RED_WRITE";
        stateMachine!.transition(nextState);
        emitStateUsageAndTransition("GIT_CHECKPOINT", nextState);
        logEvent("fsm_transition", {
          from: "GIT_CHECKPOINT",
          to: nextState,
          trigger: "auto_git_checkpoint",
          event: "checkpoint_complete",
          loopCount: stateMachine!.loopCount,
          specId: activeSpecId,
        });
        resetNudgeState(stateMachine!.currentState);
        await persistState();

        // Append auto-transition info to tool result
        if (Array.isArray(rawContent) && rawContent.length >= 1 && rawContent[0]?.type === "text") {
          const textBlock = rawContent[0] as { type: "text"; text: string };
          const nextStep = piCoderMode === "light"
            ? "delegate to pi-coder.implementor to implement the spec."
            : "delegate to pi-coder.implementor to write failing tests.";
          const appendedText = textBlock.text + `\n\n⚠️ AUTO-TRANSITION: Checkpoint complete. You are now in ${nextState}. Next step: ${nextStep}`;
          return { content: [{ type: "text" as const, text: appendedText }] };
        }
      }
    }

    if (toolName === "pi_coder_git" && currentState === "MERGING") {
      // If git merge succeeded in MERGING, auto-advance to COMPLETE
      const gitDetails = details as { operation?: string; success?: boolean; error?: string } | undefined;
      if (gitDetails?.success === true) {
        stateMachine!.transition("COMPLETE");
        emitStateUsageAndTransition("MERGING", "COMPLETE");
        logEvent("fsm_transition", {
          from: "MERGING",
          to: "COMPLETE",
          trigger: "auto_git_merge",
          event: "merge_complete",
          loopCount: stateMachine!.loopCount,
          specId: activeSpecId,
        });
        logEvent("lifecycle_end", {
          specId: activeSpecId,
          outcome: "COMPLETE",
          wallClockMs: lifecycleStartTime !== null ? Date.now() - lifecycleStartTime : null,
          totalTokens: { ...lifecycleTokens },
          phaseTokens: Object.fromEntries(
            Object.entries(phaseTokens).map(([state, bucket]) => [state, {
              input: bucket.input,
              output: bucket.output,
              cacheRead: bucket.cacheRead,
              cacheWrite: bucket.cacheWrite,
              cost: bucket.cost,
              turns: bucket.turns,
              source: {
                orchestrator: { ...bucket.source.orchestrator },
                subagent: { ...bucket.source.subagent },
              },
            }])
          ),
        });
        notify("complete", "Pi Coder \u00b7 \u2705 Complete", `Spec ${activeSpecId ?? "unknown"} merged successfully`);
        lifecycleStartTime = null;
        resetLifecycleTracking();
        resetNudgeState(stateMachine!.currentState);
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
      // Track what caused the FSM transition (if any) for correct trigger logging
      let transitionTrigger: import("../src/logger.ts").FSMTrigger | null = null;

      // Log subagent end with duration and expanded usage from pi-subagents
      const durationMs = subagentStartTime !== null ? Date.now() - subagentStartTime : null;
      const subUsage = extractSubagentUsage(details);

      if (subUsage) {
        lifecycleTokens.input += subUsage.input;
        lifecycleTokens.output += subUsage.output;
        lifecycleTokens.cacheRead += subUsage.cacheRead;
        lifecycleTokens.cacheWrite += subUsage.cacheWrite;
        lifecycleTokens.cost += subUsage.cost;
        lifecycleTokens.turns += subUsage.turns;

        // Accrue subagent tokens into per-FSM-state bucket (source: subagent)
        if (currentAccrualState) {
          ensurePhaseBucket(currentAccrualState);
          const bucket = phaseTokens[currentAccrualState];
          bucket.input += subUsage.input;
          bucket.output += subUsage.output;
          bucket.cacheRead += subUsage.cacheRead;
          bucket.cacheWrite += subUsage.cacheWrite;
          bucket.cost += subUsage.cost;
          bucket.turns += subUsage.turns;
          bucket.source.subagent.input += subUsage.input;
          bucket.source.subagent.output += subUsage.output;
          bucket.source.subagent.cacheRead += subUsage.cacheRead;
          bucket.source.subagent.cacheWrite += subUsage.cacheWrite;
          bucket.source.subagent.cost += subUsage.cost;
          bucket.source.subagent.turns += subUsage.turns;
        }
      }

      logEvent("subagent_end", {
        agent: lastSubagentAgent ?? "unknown",
        model: subUsage?.model ?? null,
        durationMs,
        tokenUsage: subUsage
          ? {
              input: subUsage.input,
              output: subUsage.output,
              cacheRead: subUsage.cacheRead,
              cacheWrite: subUsage.cacheWrite,
              cost: subUsage.cost,
            }
          : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
        turns: subUsage?.turns ?? 0,
        exitCode: subUsage?.exitCode ?? 0,
        error: subUsage?.error ?? null,
        outcome: (subUsage?.exitCode ?? 0) === 0 ? "success" : "error",
        specId: activeSpecId,
      });

      // Subagent timing reset
      subagentStartTime = null;
      lastSubagentAgent = null;
      subagentRunning = false;
      subagentActivity = null;
      // Stop the subagent widget timer
      if (subagentWidgetTimer) {
        clearInterval(subagentWidgetTimer);
        subagentWidgetTimer = null;
      }
      // Immediately clear the subagent widget — old content persists otherwise
      refreshSubagentWidget();

      // Show completion summary notification for subagent results
      // Extract duration and task brief from the full details
      const subDetails = details as {
        results?: Array<{
          agent: string;
          task: string;
          exitCode: number;
          usage?: { turns?: number };
          progress?: { durationMs?: number; toolCount?: number; tokens?: number; status?: string };
          progressSummary?: { durationMs?: number; toolCount?: number; tokens?: number };
        }>;
        mode?: string;
      } | null;

      if (subDetails?.results?.length) {
        for (const r of subDetails.results) {
          const prog = r.progress ?? r.progressSummary;
          const duration = prog?.durationMs ?? 0;
          const toolCount = prog?.toolCount ?? 0;
          const turns = r.usage?.turns;
          const tokens = prog?.tokens ?? 0;
          const statusIcon = r.exitCode === 0 ? "✓" : "✗";
          const taskBrief = r.task.length > 60 ? `${r.task.slice(0, 60)}…` : r.task;

          const stats: string[] = [];
          if (toolCount > 0) stats.push(`${toolCount} tool${toolCount !== 1 ? "s" : ""}`);
          if (turns) stats.push(`${turns} turn${turns !== 1 ? "s" : ""}`);
          if (tokens > 0) stats.push(`${formatTokenCount(tokens)} tok`);
          if (duration > 0) stats.push(formatDurationMs(duration));

          const summary = `${statusIcon} ${r.agent} ${stats.length > 0 ? `· ${stats.join(" · ")}` : ""} — ${taskBrief.replace(/\n/g, " ")}`;
          sessionCtx?.ui.notify(summary, r.exitCode === 0 ? "info" : "error");
        }
      }

      // Check for review result in subagent output (if we're in REVIEWING state)
      if (currentState === "REVIEWING") {
        // Extract rawContent text for fallback extraction when intercom receipt
        // strips finalOutput from details
        const rawContentText = (() => {
          if (Array.isArray(rawContent)) {
            return rawContent
              .filter((c: unknown) => typeof c === "object" && c !== null && (c as Record<string, unknown>).type === "text")
              .map((c: unknown) => (c as { type: string; text?: string }).text ?? "")
              .join("\n");
          }
          return undefined;
        })();
        const reviewVerdict = extractReviewVerdict(details, rawContentText);
        if (reviewVerdict) {
          logEvent("review_result", {
            verdict: reviewVerdict.verdict,
            issues: reviewVerdict.verdict === "needs_changes" ? reviewVerdict.issues : undefined,
            issueCount: reviewVerdict.verdict === "needs_changes" ? {
              high: reviewVerdict.issues?.filter(i => i.severity === "high").length ?? 0,
              medium: reviewVerdict.issues?.filter(i => i.severity === "medium").length ?? 0,
              low: reviewVerdict.issues?.filter(i => i.severity === "low").length ?? 0,
            } : undefined,
            highSeverityCount: reviewVerdict.verdict === "needs_changes" ? reviewVerdict.issues?.filter(i => i.severity === "high").length ?? 0 : undefined,
            fixType: reviewVerdict.verdict === "needs_changes" ? reviewVerdict.fixType : undefined,
            loopCount: stateMachine!.loopCount,
            specId: activeSpecId,
          });

          // AUTO-TRANSITION: review verdict drives next state
          // This replaces the need for manual pi_coder_advance_fsm REVIEWING → APPROVED/NEEDS_CHANGES
          const target = reviewVerdict.verdict === "approved" ? "APPROVED" : "NEEDS_CHANGES";

          // Set review_completed evidence BEFORE transitioning — the guard on
          // REVIEWING → APPROVED requires it. This is the primary path for
          // satisfying the guard; the only other path is the exception transition
          // with reason (emergency escape hatch for verdict extraction failures).
          stateMachine!.setEvidence("review_completed");
          stateMachine!.transition(target);
          emitStateUsageAndTransition("REVIEWING", target);
          transitionTrigger = "auto_review_verdict";

          // If reviewer classified fix as non-functional, set evidence
          // This gates the NEEDS_CHANGES → REVIEWING path and implementor delegation
          // TDD mode ONLY: Light mode has no RED/GREEN cycle to bypass, so the
          // non_functional_classified evidence is not needed.
          if (piCoderMode === "tdd" && reviewVerdict.verdict === "needs_changes" && reviewVerdict.fixType === "non-functional" && target === "NEEDS_CHANGES") {
            stateMachine!.setEvidence("non_functional_classified");
          }

          const nextState = piCoderMode === "light" ? "IMPLEMENTING" : "TDD_RED_WRITE";
          // Build reclassification guidance for direct units flagged by reviewer
          let reclassificationGuidance = "";
          if (piCoderMode === "tdd" && reviewVerdict.verdict === "needs_changes" && reviewVerdict.fixType === "functional") {
            reclassificationGuidance = " If the reviewer flagged a direct unit as needing TDD, re-save the spec with that unit's approach changed to 'tdd', present the change to the user via interview, and proceed with a full RED/GREEN cycle.";
          }
          const reviewSteer = reviewVerdict.verdict === "approved"
            ? "\n\n✅ AUTO-TRANSITION: Review approved. You are now in APPROVED. Advance to MERGING (if user already approved) or FINAL_APPROVAL (for separate sign-off)."
            : piCoderMode === "light" && reviewVerdict.verdict === "needs_changes"
              ? `\n\n⚠️ AUTO-TRANSITION: Review needs changes${reviewVerdict.fixType === "non-functional" ? " (non-functional fix)" : ""}. You are now in NEEDS_CHANGES. Delegate implementor to apply the fix, then advance to REVIEWING; or advance to IMPLEMENTING for a full reimplementation.`
              : reviewVerdict.verdict === "needs_changes" && reviewVerdict.fixType === "non-functional"
                ? `\n\n⚠️ AUTO-TRANSITION: Review needs changes (non-functional fix). You are now in NEEDS_CHANGES. Delegate to pi-coder.implementor to apply the fix, then advance to REVIEWING with pi_coder_advance_fsm — the evidence gate is already satisfied.`
                : `\n\n⚠️ AUTO-TRANSITION: Review needs changes. You are now in NEEDS_CHANGES. Advance to ${nextState} for a full implementation cycle.${reclassificationGuidance}`;

          // Append to tool result content
          if (Array.isArray(rawContent) && rawContent.length >= 1 && rawContent[0]?.type === "text") {
            const textBlock = rawContent[0] as { type: "text"; text: string };
            const appendedText = textBlock.text + reviewSteer;
            // Don't return here — fall through to normal persist/refresh
            (rawContent[0] as { type: "text"; text: string }).text = appendedText;
          }
        } else {
          // Verdict extraction returned null — diagnose and attempt degraded recovery
          const diagnostics = extractDetailsDiagnostics(details);
          const receiptDetected = isIntercomReceipt(rawContent);

          logEvent("verdict_extraction_failed", {
            fsmState: stateMachine?.currentState ?? "N/A",
            mode: piCoderMode,
            hasFinalOutput: diagnostics.hasFinalOutput,
            textLength: diagnostics.textLength,
            firstHundredChars: diagnostics.firstHundredChars,
            intercomReceiptDetected: receiptDetected,
          });

          // Degraded recovery: if the intercom receipt was detected, the reviewer
          // DID run (the receipt proves delivery) but its output was stripped by
          // the intercom receipt path. Set review_completed evidence so the guard
          // doesn't deadlock, and steer the orchestrator to read the review output
          // from the intercom delivery and advance manually.
          if (receiptDetected) {
            stateMachine!.setEvidence("review_completed");

            if (Array.isArray(rawContent) && rawContent.length >= 1 && rawContent[0]?.type === "text") {
              const textBlock = rawContent[0] as { type: "text"; text: string };
              textBlock.text +=
                "\n\n\u26a0\ufe0f DEGRADED RECOVERY: Verdict extraction failed because the intercom receipt path " +
                "stripped the reviewer's output (finalOutput is undefined). review_completed evidence has been " +
                "set because the reviewer DID run (the intercom receipt confirms delivery). " +
                "READ the reviewer's output above, determine the verdict yourself, and advance to " +
                "APPROVED or NEEDS_CHANGES with pi_coder_advance_fsm. This recovery is logged.";
            }
          } else {
            // No intercom receipt \u2014 the reviewer may not have actually produced
            // a recognizable verdict. Append fallback steer message.
            if (Array.isArray(rawContent) && rawContent.length >= 1 && rawContent[0]?.type === "text") {
              const textBlock = rawContent[0] as { type: "text"; text: string };
              textBlock.text +=
                "\n\n\u26a0\ufe0f AUTO-TRANSITION FAILED: Could not extract review verdict from subagent output. " +
                "Re-delegate the reviewer with explicit instructions to use the ---VERDICT--- block format. " +
                "Do NOT skip review by advancing manually \u2014 the REVIEWING \u2192 APPROVED guard requires review_completed evidence.";
            }
          }
        }
      }

      // SPEC_WORK: Researcher subagent completed — stay in SPEC_WORK
      // The orchestrator may need multiple research rounds, or may
      // advance to SPEC_APPROVED via pi_coder_advance_fsm.
      // lifecycle_start is now logged on IDLE→SPEC_WORK transition instead of
      // first subagent completion (see pi_coder_advance_fsm handler above).

      // Log FSM transition
      if (stateMachine!.currentState !== previousState) {
        logEvent("fsm_transition", {
          from: previousState,
          to: stateMachine!.currentState,
          trigger: transitionTrigger ?? "auto_subagent_complete",
          event: transitionTrigger === "auto_review_verdict" ? "review_verdict" : "subagent_completed",
          loopCount: stateMachine!.loopCount,
          specId: activeSpecId,
        });

        // Log lifecycle events on terminal transitions
        if (stateMachine!.currentState === "COMPLETE") {
          const wallClockMs = lifecycleStartTime !== null ? Date.now() - lifecycleStartTime : null;
          logEvent("lifecycle_end", {
            specId: activeSpecId,
            outcome: "COMPLETE",
            wallClockMs,
            totalTokens: { ...lifecycleTokens },
            phaseTokens: Object.fromEntries(
              Object.entries(phaseTokens).map(([state, bucket]) => [state, {
                input: bucket.input,
                output: bucket.output,
                cacheRead: bucket.cacheRead,
                cacheWrite: bucket.cacheWrite,
                cost: bucket.cost,
                turns: bucket.turns,
                source: {
                  orchestrator: { ...bucket.source.orchestrator },
                  subagent: { ...bucket.source.subagent },
                },
              }])
            ),
          });
          notify("complete", "Pi Coder \u00b7 \u2705 Complete", `Spec ${activeSpecId ?? "unknown"} merged successfully`);
          lifecycleStartTime = null;
          resetLifecycleTracking();
        }

        if (stateMachine!.currentState === "BLOCKED" && previousState === "TDD_RED_VALIDATE") {
          const wallClockMs = lifecycleStartTime !== null ? Date.now() - lifecycleStartTime : null;
          logEvent("lifecycle_end", {
            specId: activeSpecId,
            outcome: "BLOCKED",
            wallClockMs,
            totalTokens: { ...lifecycleTokens },
            phaseTokens: Object.fromEntries(
              Object.entries(phaseTokens).map(([state, bucket]) => [state, {
                input: bucket.input,
                output: bucket.output,
                cacheRead: bucket.cacheRead,
                cacheWrite: bucket.cacheWrite,
                cost: bucket.cost,
                turns: bucket.turns,
                source: {
                  orchestrator: { ...bucket.source.orchestrator },
                  subagent: { ...bucket.source.subagent },
                },
              }])
            ),
          });
        }

        // Log circuit breaker (subagent handler)
        if (stateMachine!.circuitBreakerTripped()) {
          logEvent("circuit_breaker", {
            loopCount: stateMachine!.loopCount,
            maxLoops: config.maxLoops,
            specId: activeSpecId,
          });
          notify("circuit_breaker", "Pi Coder \u00b7 \uD83D\uDD34 Circuit Breaker", `Max review loops (${config.maxLoops}) exceeded on spec ${activeSpecId ?? "unknown"}`);
        }
      }

      // Reset nudge state on transition
      if (stateMachine!.currentState !== previousState) {
        resetNudgeState(stateMachine!.currentState);
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
    description: "Switch pi-coder mode",
    handler: async (_args, ctx) => {
      // Build the mode labels with current state indicators
      const current = piCoderMode;
      const modes = [
        { value: "plan", label: `Plan Mode (investigation & discussion)${current === "plan" ? "  ◀" : ""}` },
        { value: "light", label: `Light Mode (spec → implement → review)${current === "light" ? "  ◀" : ""}` },
        { value: "tdd", label: `TDD Mode (full RED/GREEN lifecycle)${current === "tdd" ? "  ◀" : ""}` },
        { value: "off", label: `Off (normal Pi)${current === "off" ? "  ◀" : ""}` },
      ];

      const choice = await ctx.ui.select(
        "Pi Coder Mode",
        modes.map(m => m.label),
      );

      if (choice === undefined) return; // Cancelled

      // choice is the selected label string — find the matching mode
      const selectedMode = modes.find(m => m.label === choice)?.value as PiCoderMode | undefined;
      if (!selectedMode || selectedMode === current) return; // No change

      // If switching to any active mode, check pi-subagents availability
      if (selectedMode !== "off" && !subagentsAvailable) {
        ctx.ui.notify(
          "Pi Coder requires the pi-subagents package. Install with: `pi install npm:pi-subagents`",
          "error",
        );
        logEvent("command", { command: "mode_select", result: "blocked_no_subagents" });
        return;
      }

      // Handle mode switch FSM logic
      if (selectedMode !== current) {
        // When leaving a mode with an active FSM, pause the spec
        if (stateMachine && stateMachine!.currentState !== "IDLE") {
          logEvent("mode_switch", {
            from: current,
            to: selectedMode,
            fsmState: stateMachine?.currentState ?? "N/A",
            specId: activeSpecId,
          });
          // Per-spec state.json on disk is NOT deleted — user can switch back
          // Send notification about paused spec
          if (activeSpecId) {
            ctx.ui.notify(`Active spec '${activeSpecId}' paused. Switch back to ${current} mode to resume.`, "info");
          }
        }

        // When entering a mode with a FSM, create the appropriate instance
        if (selectedMode === "tdd") {
          if (!stateMachine || !(stateMachine instanceof StateMachine)) {
            stateMachine = new StateMachine(config);
          }
        } else if (selectedMode === "light") {
          if (!stateMachine || !(stateMachine instanceof LightStateMachine)) {
            stateMachine = new LightStateMachine(config);
          }
        } else {
          // Plan or Off — no FSM
          stateMachine = null;
        }
      }

      // Set mode first so downstream code uses the new value
      piCoderMode = selectedMode;

      // Reset session state on mode switch
      sessionTurnCount = 0;

      // Update active tools based on mode
      const toolSets: Record<PiCoderMode, string[]> = {
        off: NORMAL_TOOLS,
        plan: PLAN_TOOLS,
        light: LIGHT_TOOLS,
        tdd: ORCHESTRATOR_TOOLS,
      };
      pi.setActiveTools(toolSets[piCoderMode]);
      refreshUI();

      // Notify user of mode change
      const modeLabels: Record<PiCoderMode, string> = {
        plan: "Plan Mode — Investigation and discussion only",
        tdd: "TDD Mode — Full lifecycle with spec, RED/GREEN, and review",
        light: "Light Mode — Spec, implementation, and review (no TDD)",
        off: "Off — Normal Pi mode",
      };
      ctx.ui.notify(`Pi Coder: ${modeLabels[piCoderMode]}`, "info");
      logEvent("command", { command: "mode_select", result: piCoderMode });

      // Send a steer message so the LLM knows the mode changed immediately
      // This is critical for mid-conversation mode switches — the system prompt
      // will be rebuilt on the next before_agent_start, but the LLM needs to
      // know right now that the rules have changed.
      if (piCoderMode !== "off") {
        const modeDescriptions: Record<PiCoderMode, string> = {
          plan: "Plan mode — Investigation and discussion only. Delegate to pi-coder.researcher. No specs, no git, no FSM.",
          tdd: "TDD mode — Full lifecycle with FSM, spec approval, RED/GREEN phases, and review. Follow the FSM state machine. Use pi_coder_advance_fsm to advance states.",
          light: "Light mode — Spec, implement, and review lifecycle with FSM. No RED/GREEN TDD phases. Follow the FSM state machine.",
          off: "",
        };
        pi.sendMessage(
          {
            customType: "pi-coder-mode-change",
            content: `🔄 Pi Coder mode changed to: ${piCoderMode.toUpperCase()}. ${modeDescriptions[piCoderMode]}`,
            display: true,
          },
          { deliverAs: "nextTurn" },
        );
      }

      // Persist mode state
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
   * Detect structured test commands from package.json.
   * Returns a Record<string, string> mapping suite names to commands.
   * Always includes 'unit'. Detects component, integration, e2e, and
   * other test:* scripts automatically.
   */
  function detectTestCommands(cwd: string): TestCommands {
    const pkgPath = join(cwd, "package.json");
    try {
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        const scripts = pkg.scripts ?? {};
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        const result: TestCommands = {};

        // Always detect unit test command
        result.unit = scripts["test:ci"] || scripts.vitest ? "npx vitest run" : scripts.jest ? "npx jest" : scripts.test ? "npm test" : "npm test";

        // Detect component test runners (jsdom/TL)
        if (deps?.["@testing-library/react"] || scripts["test:component"] || scripts["test:ui"]) {
          result.component = scripts["test:component"] || scripts["test:ui"] || "npx vitest run --project jsdom";
        }

        // Detect E2E test runners
        if (deps?.playwright || scripts["test:e2e"]) {
          result.e2e = scripts["test:e2e"] || "npx playwright test";
        } else if (deps?.cypress || scripts["test:e2e"]) {
          result.e2e = scripts["test:e2e"] || "npx cypress run";
        }

        // Auto-detect any other test:* scripts from package.json
        for (const [name, _cmd] of Object.entries(scripts as Record<string, string>)) {
          if (name.startsWith("test:") && name !== "test:ci" && name !== "test:e2e" && name !== "test:component" && name !== "test:ui") {
            // Extract suite name from script name (e.g., "test:integration" -> "integration")
            const suiteName = name.slice(5); // Remove "test:" prefix
            if (!(suiteName in result)) {
              result[suiteName] = `npm run ${name}`;
            }
          }
        }

        return result;
      }
    } catch {
      // Fall through
    }
    return { unit: "npm test" };
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
        const detectedTestCommands = detectTestCommands(cwd);
        const defaultConfig: PiCoderConfig = {
          testCommand: detectedTestCommand,
          testCommands: detectedTestCommands,
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
          logging: {
            enabled: false,
            level: "standard",
            maxLogFiles: 10,
          },
          subagentControl: {
            enabled: true,
          },
          notifications: {
            enabled: false,
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

      // 4c. Create starter design_system.md in knowledge — skip if exists
      const designSystemPath = join(knowledgeDir, "design_system.md");
      if (!existsSync(designSystemPath)) {
        const designSystemContent = [
          "# Design System",
          "",
          "This file documents the project's UI component library, patterns, and conventions.",
          "The implementor and reviewer reference this before writing or reviewing UI code.",
          "Fill in each section for your project.",
          "",
          "## Component Library",
          "",
          "<!-- List reusable UI components and their locations. -->",
          "<!-- e.g., `components/ui/Card.tsx` — bordered card with header slot -->",
          "<!-- e.g., `components/ui/Button.tsx` — primary/secondary/ghost variants -->",
          "",
          "## Layout & Spacing",
          "",
          "<!-- Document the spacing system and layout conventions. -->",
          "<!-- e.g., 4px base grid, gap-2 (8px) between sibling elements -->",
          "<!-- e.g., max-width container with responsive breakpoints at 640/768/1024px -->",
          "",
          "## Colors & Theming",
          "",
          "<!-- Document color tokens, dark mode strategy, and theme configuration. -->",
          "<!-- e.g., CSS custom properties: --color-primary, --color-bg, --color-text -->",
          "",
          "## Typography",
          "",
          "<!-- Document font families, sizes, and heading hierarchy. -->",
          "<!-- e.g., Inter for body, heading scale: text-sm / text-base / text-lg / text-xl -->",
          "",
          "## Interaction Patterns",
          "",
          "<!-- Document common interaction patterns and conventions. -->",
          "<!-- e.g., Modal dialogs use `Dialog` component with overlay click to dismiss -->",
          "<!-- e.g., Form validation shows errors inline below each field -->",
          "<!-- e.g., Loading states use skeleton placeholders, not spinners -->",
          "",
          "## Existing Patterns to Follow",
          "",
          "<!-- When adding a new feature, what existing components/patterns should be reused? -->",
          "<!-- e.g., List pages: use DataTable with ColumnDef and server-side pagination -->",
          "<!-- e.g., Detail pages: use Card layout with header slot and action buttons -->",
          "",
        ].join("\n");
        writeFileSync(designSystemPath, designSystemContent, "utf-8");
        created.push(".pi-coder/knowledge/design_system.md (starter template — fill in for your project)");
      } else {
        skipped.push(".pi-coder/knowledge/design_system.md (already exists)");
      }

      // 4d. Create .pi-coder/damage-control.json — only if it doesn't exist
      // Scaffold the full defaults so the file is self-documenting —
      // the user can see what's configured and edit it.
      const damageControlPath = join(cwd, ".pi-coder", "damage-control.json");
      if (!existsSync(damageControlPath)) {
        const damageControlContent = JSON.stringify({
          enabled: true,
          rules: {
            bashToolPatterns: [
              { pattern: "\\brm\\s+(-rf?|--recursive|-r\\s*-f)", reason: "Recursive delete is destructive — describe what needs removing and use a targeted approach" },
              { pattern: "\\bsudo\\b", reason: "Sudo commands require host-level access — ask the user to run it" },
              { pattern: "\\bgit\\s+push\\s+.*--force", reason: "Force push rewrites shared history — use a new commit or branch" },
              { pattern: "\\bgit\\s+push\\s+.*--delete", reason: "Deleting remote branches is destructive" },
              { pattern: "\\bgit\\s+reset\\s+--hard", reason: "Hard reset discards uncommitted changes — use pi_coder_git rollback" },
              { pattern: "\\bgit\\s+clean\\s+-", reason: "Git clean removes untracked files — clarify what needs removing" },
              { pattern: "\\bchmod\\s+.*777\\b", reason: "chmod 777 is a security risk — use minimum permissions" },
              { pattern: "\\btruncate\\b", reason: "Truncating files is destructive — write new content instead" },
              { pattern: "\\b(?:mkfs|dd\\s+if=)\\b", reason: "Can destroy filesystems — do not attempt to work around this" },
            ],
            zeroAccessPaths: [".env", ".env.local", ".env.production", "~/.ssh/", "~/.gnupg/"],
            readOnlyPaths: [".git/config"],
            noDeletePaths: [".git/", "node_modules/"],
          },
        }, null, 2) + "\n";
        writeFileSync(damageControlPath, damageControlContent, "utf-8");
        created.push(".pi-coder/damage-control.json");
      } else {
        skipped.push(".pi-coder/damage-control.json (already exists)");
      }

      // 4e. Create .pi-coder/.gitignore — exclude workspace-local files
      // from version control while keeping specs, knowledge, and config tracked.
      // Without this, state.json changes between checkpoint and merge dirty
      // the working tree and block git merge.
      const piCoderGitignorePath = join(cwd, ".pi-coder", ".gitignore");
      if (!existsSync(piCoderGitignorePath)) {
        writeFileSync(piCoderGitignorePath, [
          "# Workspace-local pi-coder files — not project artifacts",
          "state.json",
          "logs/",
        ].join("\n") + "\n", "utf-8");
        created.push(".pi-coder/.gitignore");
      } else {
        skipped.push(".pi-coder/.gitignore (already exists)");
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

      // 3. Invalidate all prompt caches if any agent files were reset
      if (reset.length > 0) {
        resetOrchestratorPromptCache();
        resetLightModePromptCache();
        resetPlanModePromptCache();
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
  // Spec 16 Phase 5: Close Spec Command — /pi-coder-close
  // -----------------------------------------------------------------------

  pi.registerCommand("pi-coder-close", {
    description: "Close a spec (set CANCELLED status, delete state.json, keep spec.md as audit trail)",
    handler: async (_args, ctx) => {
      if (!specManager) {
        ctx.ui.notify("Pi Coder not initialized. Run /pi-coder-init first.", "error");
        return;
      }

      // 1. List all specs and filter to non-COMPLETE/CANCELLED
      const allSpecIds = await specManager.listSpecs();
      const openSpecs: Array<{ id: string; status: string }> = [];

      for (const specId of allSpecIds) {
        const spec = await specManager.readSpec(specId);
        if (spec && spec.status !== "COMPLETE" && spec.status !== "CANCELLED") {
          openSpecs.push({ id: specId, status: spec.status });
        }
      }

      if (openSpecs.length === 0) {
        ctx.ui.notify("No open specs to close.", "info");
        return;
      }

      // 2. Present selection UI
      const options = openSpecs.map(s => `${s.id} — ${s.status}`);
      const selected = await ctx.ui.select(
        "Close Spec",
        options,
      );

      if (selected === undefined) return; // Cancelled

      // Find the selected spec
      const selectedSpec = openSpecs.find(s => `${s.id} — ${s.status}` === selected);
      if (!selectedSpec) return;

      const previousStatus = selectedSpec.status;

      // 3. Update spec status to CANCELLED
      await specManager.updateSpec(selectedSpec.id, { status: "CANCELLED" });

      // 4. Delete state.json
      await SpecStatePersistence.delete(specManager.specsDir, selectedSpec.id);

      // 5. If this was the active spec, reset FSM and clear active pointer
      if (activeSpecId === selectedSpec.id) {
        if (stateMachine) {
          const previousState = stateMachine.currentState;
          stateMachine.reset();
          emitStateUsageAndTransition(previousState, "IDLE");
          logEvent("fsm_transition", {
            from: previousState,
            to: "IDLE",
            trigger: "fsm_reset",
            event: "reset",
            loopCount: stateMachine.loopCount,
            specId: activeSpecId,
          });
        }
        activeSpecId = null;
        resetNudgeState("IDLE");
      }

      // 6. Persist and refresh
      await persistState();
      refreshUI();

      // 7. Confirm and log
      ctx.ui.notify(`Spec '${selectedSpec.id}' closed (CANCELLED).`, "info");
      logEvent("command", { command: "close_spec", specId: selectedSpec.id, previousStatus });
    },
  });

  // -----------------------------------------------------------------------
  // Spec 14: Logs Command — /pi-coder-logs [sessionId] [--spec specId]
  // -----------------------------------------------------------------------

  pi.registerCommand("pi-coder-logs", {
    description: "Show pi-coder interaction log statistics. Options: /pi-coder-logs [sessionId] [--spec specId] [--all]",
    handler: async (args, ctx) => {
      const baseLogDir = join(ctx.cwd, ".pi-coder", "logs");

      if (!existsSync(baseLogDir)) {
        ctx.ui.notify("No logs found. Enable logging in .pi-coder/config.json to start collecting telemetry.", "info");
        return;
      }

      // Parse arguments
      const argParts = args.trim().split(/\s+/);
      let filterSessionId: string | null = null;
      let filterSpecId: string | null = null;
      let showAll = false;

      for (const part of argParts) {
        if (part === "--all") {
          showAll = true;
        } else if (part.startsWith("--spec=")) {
          filterSpecId = part.slice(7);
        } else if (part.startsWith("--spec")) {
          // --spec value (next arg handled below or value after =)
          filterSpecId = part.slice(7) || null;
        } else if (part && !part.startsWith("--")) {
          // Positional arg = session ID (or prefix)
          filterSessionId = part;
        }
      }

      // Discover session directories and log files
      const entries: Array<Record<string, unknown>> = [];
      const logDirsToRead: string[] = [];

      if (showAll || !filterSessionId) {
        // Read all session directories (or flat files for backward compat)
        const topEntries = readdirSync(baseLogDir, { withFileTypes: true });
        for (const entry of topEntries) {
          if (entry.isDirectory()) {
            // Session-scoped directory
            if (filterSessionId && !entry.name.startsWith(filterSessionId)) continue;
            logDirsToRead.push(join(baseLogDir, entry.name));
          } else if (entry.name.endsWith(".log")) {
            // Legacy flat file (pre-session-scoped)
            logDirsToRead.push(baseLogDir);
          }
        }
        if (logDirsToRead.length === 0 && topEntries.some(e => e.name.endsWith(".log"))) {
          // All .log files are in baseLogDir (legacy)
          logDirsToRead.push(baseLogDir);
        }
      } else {
        // Specific session — look for matching directory
        const topEntries = readdirSync(baseLogDir, { withFileTypes: true });
        const match = topEntries.find(e => e.isDirectory() && e.name.startsWith(filterSessionId!));
        if (match) {
          logDirsToRead.push(join(baseLogDir, match.name));
        }
        // Also check for legacy flat files
        if (topEntries.some(e => e.name.endsWith(".log"))) {
          logDirsToRead.push(baseLogDir);
        }
      }

      if (logDirsToRead.length === 0) {
        ctx.ui.notify("No log files found for the given filters.", "info");
        return;
      }

      // Read and parse log files from each directory
      const seenDirs = new Set<string>();
      for (const dir of logDirsToRead) {
        if (seenDirs.has(dir)) continue;
        seenDirs.add(dir);
        const files = readdirSync(dir).filter(f => f.endsWith(".log")).sort();
        for (const file of files) {
          const content = readFileSync(join(dir, file), "utf-8");
          for (const line of content.trim().split("\n").filter(Boolean)) {
            try {
              entries.push(JSON.parse(line));
            } catch {
              // Skip malformed lines
            }
          }
        }
      }

      if (entries.length === 0) {
        ctx.ui.notify("Log files found but contain no parseable entries.", "info");
        return;
      }

      // Filter by specId if requested
      let filteredEntries = entries;
      if (filterSpecId) {
        filteredEntries = entries.filter(e => {
          const p = (e as Record<string, unknown>).payload as Record<string, unknown> | undefined;
          return p?.specId === filterSpecId;
        });
        if (filteredEntries.length === 0) {
          ctx.ui.notify(`No log entries found for spec '${filterSpecId}'.`, "info");
          return;
        }
      }

      // Compute and display summary using analysis functions
      const { computeFullSummary, formatSummary } = await import("../src/log-analysis.ts");
      const summary = computeFullSummary(filteredEntries as any, config.logging.tokenPricing);
      const text = formatSummary(summary);

      ctx.ui.notify(text, "info");

      // Log that logs were viewed
      logEvent("command", { command: "logs", result: "success", entryCount: filteredEntries.length, filterSessionId, filterSpecId });
    },
  });
}
