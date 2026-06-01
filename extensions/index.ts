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

import { StateMachine } from "../src/state-machine.ts";
import { LightStateMachine } from "../src/light-state-machine.ts";
import { GitOperations } from "../src/git.ts";
import { TddRunner } from "../src/tdd-runner.ts";
import { KnowledgeStore } from "../src/knowledge.ts";
import { SpecManager } from "../src/spec.ts";
import { GlobalStatePersistence, SpecStatePersistence } from "../src/state-persistence.ts";
import type { GlobalState, SpecState } from "../src/types.ts";
import { registerTools, type StateMachineRef } from "../src/tools.ts";
import type { PiCoderConfig, PiCoderMode, FSMState, IStateMachine } from "../src/types.ts";
import { registerResetAgentsCommand } from "../src/commands/reset-agents.ts";
import { registerCloseCommand } from "../src/commands/close.ts";
import { registerLogsCommand } from "../src/commands/logs.ts";
import { registerBeforeAgentStartHandler } from "../src/handlers/before-agent-start.ts";
import { registerToolCallHandler } from "../src/handlers/tool-call.ts";
import { registerToolResultHandler } from "../src/handlers/tool-result.ts";
import { registerModeCommand } from "../src/commands/mode.ts";
import { registerInitCommand } from "../src/commands/init.ts";

import type { HandlerContext } from "../src/handlers/types.ts";

import { Logger, type LogEventType } from "../src/logger.ts";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Constants (imported from constants.ts)
// ---------------------------------------------------------------------------

import { ORCHESTRATOR_TOOLS, LIGHT_TOOLS, PLAN_TOOLS, NORMAL_TOOLS, STATE_STYLE, STATE_LABEL, MODE_TOOL_SETS } from "./constants.ts";

// Re-export constants that were previously exported from this module
export { ORCHESTRATOR_TOOLS, LIGHT_TOOLS, PLAN_TOOLS, NORMAL_TOOLS };

// ---------------------------------------------------------------------------
// Module-scope state
// ---------------------------------------------------------------------------

export let piCoderMode: PiCoderMode = "tdd";
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
  if (subagentMonitor.running) {
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
  if (subagentMonitor.running) {
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

// UI formatting helpers — imported from src/ui/formatting.ts
import { formatDurationMs, formatTokenCount } from "../src/ui/formatting.ts";

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

    // Also persist per-spec state if a spec is active
    if (activeSpecId && stateMachine) {
      const now = new Date().toISOString();
      const specState: SpecState = {
        version: 1,
        currentState: stateMachine.currentState,
        loopCount: stateMachine.loopCount,
        gitRef: stateMachine.gitRef,
        evidence: stateMachine.getEvidence(),
        currentUnitName: stateMachine.currentUnitName,
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
import { loadOrchestratorPrompt, resetOrchestratorPromptCache, resetPlanModePromptCache, resetLightModePromptCache } from "../src/prompts/prompt-builders.ts";

// Re-export for backward compatibility with tests
export { loadOrchestratorPrompt, resetOrchestratorPromptCache, resetPlanModePromptCache, resetLightModePromptCache } from "../src/prompts/prompt-builders.ts";


// ---------------------------------------------------------------------------
// Nudge Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

// Notification helpers — imported from src/notification-manager.ts
import { notify } from "../src/notification-manager.ts";

// Config — imported from src/config.ts
import { loadConfig } from "../src/config.ts";


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

  pi.on("session_start", async (_event, ctx) => {
    // Reset session state
    tokenTracker.sessionTurnCount = 0;
    tokenTracker.sessionStartTime = Date.now();
    tokenTracker.sessionSpecCount = 0;

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
      sessionTurnCount: { get current() { return tokenTracker.sessionTurnCount; } },
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
          if (!subagentMonitor.running) return;
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
          if (!subagentMonitor.running) return;
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

        subagentMonitor.activity = {
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
        // The subagentMonitor.activity will be fully cleared in the tool_result handler,
        // but we can clear the widget immediately for snappier UX
        subagentMonitor.activity = null;
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
    nudgeEngine.reset(stateMachine?.currentState ?? "IDLE");

    // Activate mode if subagents are available
    if (subagentsAvailable) {
      if (piCoderMode !== "off") {
        pi.setActiveTools(MODE_TOOL_SETS[piCoderMode]);
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
