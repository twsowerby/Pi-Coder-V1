/**
 * Pi Coder V1 — Session Start Handler
 *
 * Extracted from extensions/index.ts (Phase 4, Step 4.6).
 * Initializes all pi-coder state on session start: config, logger,
 * FSM, persistence, tool registration, and sub-listeners.
 */

import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { LightStateMachine } from "../light-state-machine.ts";
import { DevStateMachine } from "../dev-state-machine.ts";
import { KnowledgeStore } from "../knowledge.ts";
import { SpecManager } from "../spec.ts";
import { GitOperations } from "../git.ts";
import { TddRunner } from "../tdd-runner.ts";
import { GlobalStatePersistence, SpecStatePersistence } from "../state-persistence.ts";
import { Logger } from "../logger.ts";
import { registerTools, type StateMachineRef } from "../tools.ts";
import { MODE_TOOL_SETS } from "../../extensions/constants.ts";
import { loadConfig } from "../config.ts";
import { resetLightModePromptCache, resetPlanModePromptCache, resetDevModePromptCache } from "../prompts/prompt-builders.ts";
import { registerCompactionHandler } from "../compaction.ts";
import type { HandlerContext } from "../handlers/types.ts";
import type { LightFSMState, DevFSMState } from "../types.ts";
import { registerSubagentContextGuard } from "../handlers/subagent-context-guard.ts";

/** Register the session_start event handler and its sub-listeners. */
export function registerSessionStartHandler(ctx: HandlerContext): void {
  ctx.pi.on("session_start", async (_event, cmdCtx) => {
    // Reset session state
    ctx.tokenTracker.sessionTurnCount = 0;
    ctx.tokenTracker.sessionStartTime = Date.now();
    ctx.tokenTracker.sessionSpecCount = 0;

    // --- Child Process Guard ---
    if (Number(process.env.PI_SUBAGENT_DEPTH ?? "0") > 0) {
      // Load minimal config for guard limits
      const configResult = loadConfig(cmdCtx.cwd);
      ctx.config = configResult.config;

      // Reuse the orchestrator's session ID so guard events log to the
      // same directory as the orchestrator session — not a separate dir.
      // PI_CODER_SESSION_ID is set by the orchestrator process so child
      // processes inherit it via the environment.
      const orchestratorSessionId = process.env.PI_CODER_SESSION_ID;
      ctx.sessionId = orchestratorSessionId ?? randomUUID();
      const logDir = join(cmdCtx.cwd, ".pi-coder", "logs");
      ctx.logger = new Logger(logDir, ctx.config.logging, ctx.sessionId);
      ctx.projectCwd = cmdCtx.cwd;

      if (ctx.config.subagentContextGuard?.enabled !== false) {
        ctx.piCoderMode = "subagent-guard";
        ctx.logEvent("subagent_guard_activated", {
          childAgent: process.env.PI_SUBAGENT_CHILD_AGENT ?? "unknown",
        });
      } else {
        ctx.piCoderMode = "off";
      }
      ctx.stateMachine = null;
      registerSubagentContextGuard(ctx);

      // Register token tracking for the subagent process so usage is logged.
      // The orchestrator's turn_end/session_shutdown handlers skip subagent-guard
      // mode, so the guard must manage its own token capture.
      ctx.pi.on("turn_end", async (event) => {
        if (ctx.piCoderMode !== "subagent-guard") return;
        const msg = event.message as { usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: { total: number }; totalTokens: number } };
        const usage = msg?.usage;
        if (!usage) return;

        const inVal = usage.input ?? 0;
        const outVal = usage.output ?? 0;
        const crVal = usage.cacheRead ?? 0;
        const cwVal = usage.cacheWrite ?? 0;
        const costVal = usage.cost?.total ?? 0;

        ctx.tokenTracker.accrueOrchestrator({ input: inVal, output: outVal, cacheRead: crVal, cacheWrite: cwVal, cost: costVal });
        ctx.logEvent("turn_usage", {
          input: inVal,
          output: outVal,
          cacheRead: crVal,
          cacheWrite: cwVal,
          cost: costVal,
          model: (event.message as { model?: string }).model ?? null,
          fsmState: "N/A",
        });
      });

      ctx.pi.on("session_shutdown", async () => {
        if (ctx.piCoderMode !== "subagent-guard") return;
        ctx.logEvent("session_summary", {
          totalTurns: ctx.tokenTracker.sessionTurnCount,
          totalTokens: ctx.tokenTracker.snapshotLifecycleTokens(),
          specsAttempted: ctx.tokenTracker.sessionSpecCount,
          finalMode: "subagent-guard",
          finalFsmState: "N/A",
          sessionDurationMs: ctx.tokenTracker.sessionStartTime !== null ? Date.now() - ctx.tokenTracker.sessionStartTime : null,
        });
      });

      return;
    }

    // Capture ctx for UI refresh
    ctx.sessionCtx = cmdCtx;
    const cwd = cmdCtx.cwd;
    ctx.projectCwd = cwd;

    // Load config
    const configResult = loadConfig(cwd);
    ctx.config = configResult.config;

    // Generate session ID and initialize logger
    ctx.sessionId = randomUUID();
    // Expose session ID to child processes so subagent guard can log to
    // the same session directory (child processes inherit env vars)
    process.env.PI_CODER_SESSION_ID = ctx.sessionId;
    const logDir = join(cwd, ".pi-coder", "logs");
    ctx.logger = new Logger(logDir, ctx.config.logging, ctx.sessionId);

    // Emit config_validation if there were warnings
    if (configResult.warnings.length > 0) {
      ctx.logEvent("config_validation", {
        warnings: configResult.warnings,
      });
    }

    // Load prompt templates
    resetLightModePromptCache();
    resetPlanModePromptCache();
    resetDevModePromptCache();

    // Initialize state machine based on mode
    if (ctx.piCoderMode === "dev") {
      ctx.stateMachine = new DevStateMachine(ctx.config);
    } else if (ctx.piCoderMode === "light") {
      ctx.stateMachine = new LightStateMachine(ctx.config);
    } else {
      ctx.stateMachine = null;
    }

    // Register FSM-aware compaction handler (R1)
    registerCompactionHandler(ctx);

    // Initialize module dependencies
    const knowledgeDir = join(cwd, ".pi-coder", "knowledge");
    const specsDir = join(cwd, ".pi-coder", "specs");

    ctx.knowledgeStore = new KnowledgeStore(knowledgeDir);
    ctx.specManager = new SpecManager(specsDir);

    ctx.gitOps = new GitOperations(ctx.config, (cmd, args, opts) =>
      ctx.pi.exec(cmd, args, opts),
    );
    ctx.tddRunner = new TddRunner(ctx.config, (cmd, args, opts) =>
      ctx.pi.exec(cmd, args, opts),
    );

    // Register tools
    const smRef: StateMachineRef = {
      get current() { return ctx.stateMachine!; },
    };

    registerTools(ctx.pi, {
      stateMachine: smRef,
      activeSpecId: { get current() { return ctx.activeSpecId; } },
      setActiveSpecId: (id: string | null) => { ctx.activeSpecId = id; },
      piCoderMode: { get current() { return ctx.piCoderMode; } },
      gitOps: ctx.gitOps,
      tddRunner: ctx.tddRunner,
      knowledgeStore: ctx.knowledgeStore,
      specManager: ctx.specManager,
      config: ctx.config,
      logEvent: ctx.logEvent,
      sessionTurnCount: { get current() { return ctx.tokenTracker.sessionTurnCount; } },
      tokenTracker: ctx.tokenTracker,
    });

    // Check for pi-subagents availability
    const allTools = ctx.pi.getAllTools();
    ctx.subagentsAvailable = allTools.some((t) => t.name === "subagent");

    // Listen for subagent control events
    if (ctx.subagentsAvailable && ctx.config.subagentControl.enabled) {
      ctx.pi.events.on("subagent:control-event", (data: unknown) => {
        if (ctx.piCoderMode === "off") return;
        const event = data as {
          event?: { type: string; agent: string; runId: string; message: string; reason?: string; turns?: number; toolCount?: number; currentTool?: string; elapsedMs?: number };
          source?: string;
        };
        const ctrl = event.event;
        if (!ctrl) return;

        if (ctrl.type === "needs_attention") {
          if (!ctx.subagentMonitor.running) return;
          ctx.logEvent("subagent_control", {
            type: ctrl.type,
            agent: ctrl.agent,
            runId: ctrl.runId,
            reason: ctrl.reason,
            currentTool: ctrl.currentTool,
          });
          // Surface as user-visible notification so the user can intervene.
          // pi-subagents already injects a notice via pi.sendMessage(display:true),
          // but this adds a ctx.ui.notify() as a backup for terminals that don't
          // show inline notices prominently.
          ctx.sessionCtx?.ui.notify(
            `⚠️ ${ctrl.agent} needs attention (${ctrl.reason ?? "idle"}). Current tool: ${ctrl.currentTool ?? "unknown"}. Press Ctrl+C to intervene.`,
            "warning",
          );
        } else if (ctrl.type === "active_long_running") {
          const elapsed = ctrl.elapsedMs ? Math.floor(ctrl.elapsedMs / 1000) : "?";
          ctx.logEvent("subagent_control", {
            type: ctrl.type,
            agent: ctrl.agent,
            runId: ctrl.runId,
            elapsedSeconds: elapsed,
            currentTool: ctrl.currentTool,
          });
          ctx.sessionCtx?.ui.notify(
            `⏱️ ${ctrl.agent} has been running for ${elapsed}s. Current tool: ${ctrl.currentTool ?? "unknown"}. Consider interrupting if stuck.`,
            "info",
          );
        }
      });
    }

    // Listen for live subagent progress updates (tool_execution_update)
    if (ctx.subagentsAvailable) {
      ctx.pi.events.on("tool_execution_update", (data: unknown) => {
        if (ctx.piCoderMode === "off") return;
        const event = data as { toolName: string; partialResult: unknown };

        if (event.toolName !== "subagent") return;

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

        const progress = result.details.progress?.[0]
          ?? result.details.results?.[0]?.progress;

        if (!progress || progress.status !== "running") return;

        ctx.subagentMonitor.activity = {
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

        if (progress.currentTool === "read" && progress.currentPath?.includes("SKILL.md")) {
          const pathParts = progress.currentPath.split("/").filter(Boolean);
          const skillName = pathParts.length >= 2
            ? pathParts[pathParts.length - 2]
            : "unknown";
          ctx.logEvent("skill_read", {
            skillName,
            skillPath: progress.currentPath,
            subagentAgent: progress.agent,
            fsmState: ctx.stateMachine?.currentState ?? "N/A",
            mode: ctx.piCoderMode,
          });
        }

        ctx.refreshSubagentWidget();
      });

      ctx.pi.events.on("tool_execution_end", (data: unknown) => {
        const event = data as { toolName: string };
        if (event.toolName !== "subagent") return;
        ctx.subagentMonitor.activity = null;
        ctx.refreshSubagentWidget();
      });
    }

    // Initialize state persistence
    const piCoderDir = join(cwd, ".pi-coder");
    ctx.globalStatePersistence = new GlobalStatePersistence(piCoderDir);

    // Restore persisted state from .pi-coder/state.json
    const savedGlobalState = await ctx.globalStatePersistence.load();
    if (savedGlobalState) {
      const integrity = await ctx.globalStatePersistence.checkIntegrity(savedGlobalState);

      if (savedGlobalState.piCoderMode) {
        ctx.piCoderMode = savedGlobalState.piCoderMode;
      } else if (savedGlobalState.piCoderActive !== undefined) {
        ctx.piCoderMode = savedGlobalState.piCoderActive ? "dev" : "off";
      }

      // Re-align stateMachine instance with restored mode
      if (ctx.piCoderMode === "light" && !(ctx.stateMachine instanceof LightStateMachine)) {
        ctx.stateMachine = new LightStateMachine(ctx.config);
      } else if (ctx.piCoderMode === "dev" && !(ctx.stateMachine instanceof DevStateMachine)) {
        ctx.stateMachine = new DevStateMachine(ctx.config);
      } else if (ctx.piCoderMode === "plan" || ctx.piCoderMode === "off") {
        ctx.stateMachine = null;
      }

      ctx.activeSpecId = savedGlobalState.activeSpecId;

      if (savedGlobalState.activeSpecId && integrity.valid) {
        const specDir = join(cwd, ".pi-coder", "specs");
        const specState = await SpecStatePersistence.load(specDir, savedGlobalState.activeSpecId);

        if (specState) {
          const savedState = specState.currentState as string;
          const isTddState = savedState.startsWith("TDD_");
          const modeMismatch =
            (ctx.piCoderMode === "light" && isTddState);
          // Dev mode handles both TDD and IMPLEMENTING states — no mismatch possible

          if (modeMismatch) {
            ctx.logEvent("state_restore", {
              status: "mode_mismatch",
              specId: savedGlobalState.activeSpecId,
              savedState,
              currentMode: ctx.piCoderMode,
              message: `Spec was created in ${isTddState ? "TDD" : "Light"} mode but current mode is ${ctx.piCoderMode}. Switch modes to resume.`,
            });
            cmdCtx.ui.notify(
              `Active spec '${savedGlobalState.activeSpecId}' was created in ${isTddState ? "TDD" : "Light"} mode but current mode is ${ctx.piCoderMode}. Switch to ${isTddState ? "Dev" : "Light"} mode with /pi-coder to resume.`,
              "warning",
            );
            ctx.stateMachine = ctx.piCoderMode === "dev"
              ? new DevStateMachine(ctx.config)
              : new LightStateMachine(ctx.config);
          } else if (ctx.piCoderMode === "light") {
            ctx.stateMachine = LightStateMachine.fromJSON({
              currentState: specState.currentState as LightFSMState,
              loopCount: specState.loopCount,
              gitRef: specState.gitRef,
              currentUnitName: specState.currentUnitName ?? null,
              evidence: specState.evidence,
            }, ctx.config);
          } else if (ctx.piCoderMode === "dev") {
            ctx.stateMachine = DevStateMachine.fromJSON({
              currentState: specState.currentState as DevFSMState,
              loopCount: specState.loopCount,
              gitRef: specState.gitRef,
              currentUnitName: specState.currentUnitName ?? null,
              evidence: specState.evidence,
            }, ctx.config);
          } else {
            ctx.stateMachine = null;
          }
          ctx.specStateCreatedAt = specState.createdAt;

          if (!modeMismatch && ctx.piCoderMode !== "off" && ctx.piCoderMode !== "plan") {
            ctx.logEvent("state_restore", {
              status: "success",
              specId: savedGlobalState.activeSpecId,
              fsmState: specState.currentState,
              mode: ctx.piCoderMode,
            });

          }
        } else {
          ctx.logEvent("state_restore", {
            status: "spec_state_missing",
            specId: savedGlobalState.activeSpecId,
          });
          ctx.activeSpecId = null;
          await ctx.globalStatePersistence.delete();
        }
      } else if (savedGlobalState.activeSpecId && !integrity.valid) {
        ctx.logEvent("state_restore", {
          status: "integrity_failed",
          errors: integrity.errors,
          warnings: integrity.warnings,
        });
        ctx.pi.sendMessage(
          {
            customType: "pi-coder-state-restore",
            content: `⚠️ Pi Coder: Could not resume previous cycle. ${integrity.errors.join("; ")}`,
            display: true,
          },
          { deliverAs: "steer", triggerTurn: true },
        );
        ctx.activeSpecId = null;
        await ctx.globalStatePersistence.delete();
      } else {
        await ctx.globalStatePersistence.delete();
      }

      if (integrity.warnings.length > 0) {
        ctx.logEvent("state_restore", {
          status: "warnings",
          warnings: integrity.warnings,
        });
      }
    }

    // Initialize nudge state
    ctx.nudgeEngine.reset(ctx.stateMachine?.currentState ?? "IDLE");

    // Activate mode if subagents are available
    if (ctx.subagentsAvailable) {
      if (ctx.piCoderMode !== "off") {
        ctx.pi.setActiveTools(MODE_TOOL_SETS[ctx.piCoderMode]);
        ctx.refreshUI();
      }


    } else {
      ctx.piCoderMode = "off";
      cmdCtx.ui.notify(
        "Pi Coder: Orchestrator modes require pi-subagents. Install with: `pi install npm:pi-subagents`",
        "warning",
      );
    }
  });
}
