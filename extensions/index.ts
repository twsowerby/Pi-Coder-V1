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

import type { GlobalState, SpecState } from "../src/types.ts";
import type { PiCoderConfig, PiCoderMode, IStateMachine } from "../src/types.ts";
import { ORCHESTRATOR_TOOLS, LIGHT_TOOLS, PLAN_TOOLS, NORMAL_TOOLS, STATE_STYLE, STATE_LABEL } from "./constants.ts";
import { registerResetAgentsCommand } from "../src/commands/reset-agents.ts";
import { registerCloseCommand } from "../src/commands/close.ts";
import { registerLogsCommand } from "../src/commands/logs.ts";
import { registerBeforeAgentStartHandler } from "../src/handlers/before-agent-start.ts";
import { registerToolCallHandler } from "../src/handlers/tool-call.ts";
import { registerToolResultHandler } from "../src/handlers/tool-result.ts";
import { registerSessionStartHandler } from "../src/handlers/session-start.ts";
import { registerModeCommand } from "../src/commands/mode.ts";
import { registerInitCommand } from "../src/commands/init.ts";

import type { HandlerContext } from "../src/handlers/types.ts";
import { KnowledgeStore } from "../src/knowledge.ts";
import { SpecManager } from "../src/spec.ts";
import { GitOperations } from "../src/git.ts";
import { TddRunner } from "../src/tdd-runner.ts";
import { GlobalStatePersistence, SpecStatePersistence } from "../src/state-persistence.ts";
import { Logger } from "../src/logger.ts";
import { formatDurationMs, formatTokenCount } from "../src/ui/formatting.ts";
import { notify } from "../src/notification-manager.ts";

import type { LogEventType } from "../src/logger.ts";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Constants (imported from constants.ts)
// ---------------------------------------------------------------------------


// Re-export constants that were previously exported from this module
export { ORCHESTRATOR_TOOLS, LIGHT_TOOLS, PLAN_TOOLS, NORMAL_TOOLS };

// ---------------------------------------------------------------------------
// Module-scope state
// ---------------------------------------------------------------------------

export let piCoderMode: PiCoderMode = "dev";
export let subagentsAvailable = false;
export let stateMachine: IStateMachine | null;
export let config: PiCoderConfig;

// Nudge engine — imported from src/nudge-engine.ts
import { NudgeEngine } from "../src/nudge-engine.ts";

/** Shared nudge engine instance. */
const nudgeEngine = new NudgeEngine();

// Subagent monitor — imported from src/subagent-monitor.ts
import { SubagentMonitor } from "../src/subagent-monitor.ts";

/** Shared subagent monitor instance. */
const subagentMonitor = new SubagentMonitor();


/** Captured ExtensionContext from session_start — used by refreshUI(). */
let sessionCtx: ExtensionContext | null = null;




// ---------------------------------------------------------------------------
// UI Refresh — updates widget, status line, and working indicator
// (STATE_STYLE and STATE_LABEL now imported from constants.ts)
// ---------------------------------------------------------------------------

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
  if (!subagentMonitor.running) {
    ctx.ui.setWidget("pi-coder-subagent", undefined);
  } else {
    refreshSubagentWidget();
  }

  if (piCoderMode === "plan") {
    // Plan mode — investigation only, no FSM
    const theme = ctx.ui.theme;
    let widgetLine = theme.fg("accent", "🔍 Plan");
    if (subagentMonitor.running) {
      widgetLine += theme.fg("dim", `  `) + theme.fg("accent", "▶");
    }
    ctx.ui.setWidget("pi-coder-state", [widgetLine], { placement: "aboveEditor" });
    ctx.ui.setStatus("pi-coder", theme.fg("accent", "🔍 plan mode"));

    if (subagentMonitor.running) {
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
    if (subagentMonitor.running) {
      widgetLine += theme.fg("dim", `  `) + theme.fg("accent", "▶");
    }
    ctx.ui.setWidget("pi-coder-state", [widgetLine], { placement: "aboveEditor" });
    ctx.ui.setStatus("pi-coder", theme.fg("accent", "⚡ light mode"));

    if (subagentMonitor.running) {
      ctx.ui.setWorkingIndicator({
        frames: [theme.fg("accent", "⏣"), theme.fg("muted", "⏣")],
        intervalMs: 500,
      });
    } else {
      ctx.ui.setWorkingIndicator();
    }
    return;
  }

  if (piCoderMode === "dev") {
    // Dev mode — same FSM UI as TDD but with different label
    const state = stateMachine!.currentState;
    const specId = activeSpecId;
    const loopCount = stateMachine!.loopCount;
    const style = STATE_STYLE[state] ?? { icon: "●", color: "accent" as const };
    const label = STATE_LABEL[state] ?? state;
    const theme = ctx.ui.theme;

    const isTdd = state.startsWith("TDD_");
    const showLoop = isTdd || state === "REVIEWING" || state === "NEEDS_CHANGES";

    let widgetLine = theme.fg("accent", "⬡ Dev");
    if (state !== "IDLE") {
      widgetLine += theme.fg("dim", ` | `) + theme.fg(style.color, `${style.icon} ${label}`);
    }
    if (specId) {
      widgetLine += theme.fg("dim", `  spec: `) + theme.fg("muted", specId);
    }
    if (showLoop && loopCount > 0) {
      widgetLine += theme.fg("dim", `  loop: `) + theme.fg("muted", String(loopCount)) + theme.fg("dim", `/${config.maxLoops}`);
    }
    if (subagentMonitor.running) {
      widgetLine += theme.fg("dim", `  `) + theme.fg("accent", "▶");
    }

    ctx.ui.setWidget("pi-coder-state", [widgetLine], { placement: "aboveEditor" });

    // Footer status
    let statusText: string;
    if (state === "BLOCKED") {
      statusText = theme.fg("error", "⚠ blocked");
    } else if (state === "COMPLETE") {
      statusText = theme.fg("success", "✓ complete");
    } else if (state === "IDLE") {
      statusText = theme.fg("dim", "dev idle");
    } else {
      statusText = theme.fg(style.color, `⬡ ${label}`);
      if (specId) {
        statusText += theme.fg("dim", ` · ${specId}`);
      }
    }
    ctx.ui.setStatus("pi-coder", statusText);

    // Working indicator
    if (subagentMonitor.running) {
      ctx.ui.setWorkingIndicator({
        frames: [theme.fg("accent", "⏣"), theme.fg("muted", "⏣")],
        intervalMs: 500,
      });
    } else if (state === "IDLE" || state === "COMPLETE" || state === "BLOCKED") {
      ctx.ui.setWorkingIndicator();
    } else {
      ctx.ui.setWorkingIndicator({
        frames: [theme.fg("accent", "⬡"), theme.fg("muted", "⬡")],
        intervalMs: 600,
      });
    }
    return;
  }
}

// ---------------------------------------------------------------------------
// Subagent Activity Widget — live progress via tool_execution_update
// ---------------------------------------------------------------------------

// UI formatting helpers — imported from src/ui/formatting.ts

/** Refresh the pi-coder-subagent widget based on current subagentMonitor.activity. */
function refreshSubagentWidget(): void {
  if (!sessionCtx) return;
  const ctx = sessionCtx;

  if (piCoderMode === "off" || !subagentMonitor.running || !subagentMonitor.activity) {
    // No active subagent — clear the widget
    ctx.ui.setWidget("pi-coder-subagent", undefined);
    return;
  }

  const theme = ctx.ui.theme;
  const a = subagentMonitor.activity;

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
  // Fallback duration from subagentMonitor.startTime if tool_execution_update isn't providing it
  const elapsed = subagentMonitor.startTime !== null ? Date.now() - subagentMonitor.startTime : 0;
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



/**
 * Session turn counter — incremented at the start of every agent turn.
 */
// Token tracker — imported from src/token-tracker.ts
import { TokenTracker } from "../src/token-tracker.ts";

/** Shared token tracker instance. Late-binding to logEvent (defined below). */
const tokenTracker = new TokenTracker((type, payload) => logEvent(type as LogEventType, payload));

let globalStatePersistence: GlobalStatePersistence;

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
  const prev = persistStatePromise.catch(() => {});
  const ourSave = prev.then(async () => {
    const globalState: GlobalState = {
      version: 1,
      piCoderMode,
      activeSpecId,
      updatedAt: new Date().toISOString(),
    };
    await globalStatePersistence.save(globalState);

    // Also persist per-spec state if a spec is active AND spec has been saved.
    // Fix B: Don't create spec directories (via mkdir in SpecStatePersistence.save)
    // before spec.md exists — this prevents orphaned timestamp-prefixed directories
    // when the LLM's short ID later creates a different directory.
    const hasSpecSaved = stateMachine?.getEvidence().includes("spec_saved") ?? false;
    if (activeSpecId && stateMachine && hasSpecSaved) {
      const now = new Date().toISOString();
      const specState: SpecState = {
        version: 1,
        currentState: stateMachine.currentState,
        loopCount: stateMachine.loopCount,
        gitRef: stateMachine.gitRef,
        evidence: stateMachine.getEvidence(),
        currentUnitName: stateMachine.currentUnitName,
        createdAt: specStateCreatedAt ?? now,
        specId: activeSpecId,
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
  await ourSave;
}


/** Log a structured event. Convenience wrapper that adds sessionId, timestamp, turnCount, and mode. */
function logEvent(type: LogEventType, payload: Record<string, unknown>): void {
  if (!logger) return; // Not initialized yet — no-op
  logger.log({
    timestamp: new Date().toISOString(),
    sessionId,
    type,
    payload: { ...payload, turnCount: tokenTracker.sessionTurnCount, mode: piCoderMode },
  });
}

// ---------------------------------------------------------------------------
// Tool Input Summary Helper — for logging tool_call events
// ---------------------------------------------------------------------------
// Prompt builders — imported from src/prompts/prompt-builders.ts

// Re-export for backward compatibility with tests
export { loadOrchestratorPrompt, resetOrchestratorPromptCache, resetPlanModePromptCache, resetLightModePromptCache, resetDevModePromptCache } from "../src/prompts/prompt-builders.ts";


// ---------------------------------------------------------------------------
// Nudge Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

// Notification helpers — imported from src/notification-manager.ts

// Config — imported from src/config.ts


// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Review extraction — re-exported from src/review-extraction.ts
// ---------------------------------------------------------------------------

// Re-export functions that were previously defined inline in this module
export { isIntercomReceipt, extractDetailsDiagnostics, extractReviewVerdict } from "../src/review-extraction.ts";
export type { SubagentUsage } from "../src/review-extraction.ts";

// Private imports for internal use within this module

// Extension Factory
// ---------------------------------------------------------------------------

export default function piCoderExtension(pi: ExtensionAPI): void {
  // -----------------------------------------------------------------------
  // Handler Context — shared state object for extracted handlers/commands
  // -----------------------------------------------------------------------
  const hctx: HandlerContext = {
    pi,
    get piCoderMode() { return piCoderMode; },
    set piCoderMode(m: PiCoderMode) { piCoderMode = m; },
    get stateMachine() { return stateMachine; },
    set stateMachine(sm: IStateMachine | null) { stateMachine = sm; },
    get config() { return config; },
    set config(c: PiCoderConfig) { config = c; },
    get subagentsAvailable() { return subagentsAvailable; },
    set subagentsAvailable(v: boolean) { subagentsAvailable = v; },
    get activeSpecId() { return activeSpecId; },
    set activeSpecId(id: string | null) { activeSpecId = id; },
    tokenTracker,
    nudgeEngine,
    subagentMonitor,
    get specManager() { return specManager; },
    set specManager(sm: SpecManager) { specManager = sm; },
    get sessionCtx() { return sessionCtx; },
    set sessionCtx(ctx: ExtensionContext | null) { sessionCtx = ctx; },
    get logger() { return logger; },
    set logger(l: Logger) { logger = l; },
    get sessionId() { return sessionId; },
    set sessionId(id: string) { sessionId = id; },
    get gitOps() { return gitOps; },
    set gitOps(go: GitOperations) { gitOps = go; },
    get tddRunner() { return tddRunner; },
    set tddRunner(tr: TddRunner) { tddRunner = tr; },
    get knowledgeStore() { return knowledgeStore; },
    set knowledgeStore(ks: KnowledgeStore) { knowledgeStore = ks; },
    get globalStatePersistence() { return globalStatePersistence; },
    set globalStatePersistence(gsp: GlobalStatePersistence) { globalStatePersistence = gsp; },
    get specStateCreatedAt() { return specStateCreatedAt; },
    set specStateCreatedAt(v: string | null) { specStateCreatedAt = v; },
    get projectCwd() { return projectCwd; },
    set projectCwd(cwd: string) { projectCwd = cwd; },
    logEvent,
    persistState,
    refreshUI,
    refreshSubagentWidget,
  };

  // -----------------------------------------------------------------------
  // Phase 1: Extension Foundation & Toggle State
  // -----------------------------------------------------------------------

  // session_start handler (extracted to src/handlers/session-start.ts)
  registerSessionStartHandler(hctx);

  // -----------------------------------------------------------------------
  // Desktop Notifications
  // -----------------------------------------------------------------------

  pi.on("agent_end", async () => {
    if (piCoderMode === "off") return;
    notify(config, "agent_end", "Pi Coder \u00b7 Idle", "Waiting for your input");
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

    // Accumulate into lifecycle tokens + per-FSM-state bucket (source: orchestrator)
    tokenTracker.accrueOrchestrator({ input: inVal, output: outVal, cacheRead: crVal, cacheWrite: cwVal, cost: costVal });

    // Log per-turn usage for granular analysis
    const fsmState = stateMachine?.currentState ?? "N/A";
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
      totalTurns: tokenTracker.sessionTurnCount,
      totalTokens: tokenTracker.snapshotLifecycleTokens(),
      specsAttempted: tokenTracker.sessionSpecCount,
      finalMode: piCoderMode,
      finalFsmState: stateMachine?.currentState ?? "N/A",
      sessionDurationMs: tokenTracker.sessionStartTime !== null ? Date.now() - tokenTracker.sessionStartTime : null,
    });

    if (subagentMonitor.widgetTimer) {
      clearInterval(subagentMonitor.widgetTimer);
      subagentMonitor.widgetTimer = null;
    }
    subagentMonitor.running = false;
    subagentMonitor.activity = null;
    tokenTracker.sessionTurnCount = 0;
    tokenTracker.sessionStartTime = null;
    tokenTracker.sessionSpecCount = 0;
    tokenTracker.specApprovalInterviewStartTime = null;
    // Persist final state so it survives session restarts
    if (stateMachine) {
      await persistState();
    }
  });

  // -----------------------------------------------------------------------
  // Phase 2: System Prompt Replacement
  // -----------------------------------------------------------------------

  // before_agent_start handler (extracted to src/handlers/before-agent-start.ts)
  registerBeforeAgentStartHandler(hctx);

  // -----------------------------------------------------------------------
  // Phase 3: FSM Event Guards & Auto-Transitions
  // -----------------------------------------------------------------------

  // --- tool_call: Validate against FSM state ---

  // tool_call handler (extracted to src/handlers/tool-call.ts)
  registerToolCallHandler(hctx);

  // --- tool_result: Auto-transition FSM based on results ---

  // tool_result handler (extracted to src/handlers/tool-result.ts)
  registerToolResultHandler(hctx);

  // =====================================================================
  // Spec 10: Commands
  // =====================================================================

  // Toggle Command — /pi-coder (extracted to src/commands/mode.ts)
  registerModeCommand(hctx);

  // Init Command — /pi-coder-init (extracted to src/commands/init.ts)
  registerInitCommand(hctx);

  // Reset Agents Command — /pi-coder-reset-agents (extracted to src/commands/reset-agents.ts)
  registerResetAgentsCommand(hctx);

  // Close Spec Command — /pi-coder-close (extracted to src/commands/close.ts)
  registerCloseCommand(hctx);

  // Logs Command — /pi-coder-logs (extracted to src/commands/logs.ts)
  registerLogsCommand(hctx);
}
