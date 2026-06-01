/**
 * Pi Coder V1 — Session Start Handler
 *
 * Extracted from extensions/index.ts (Phase 4, Step 4.6).
 * Initializes all pi-coder state on session start: config, logger,
 * FSM, persistence, tool registration, and sub-listeners.
 */

import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { StateMachine } from "../state-machine.ts";
import { LightStateMachine } from "../light-state-machine.ts";
import { KnowledgeStore } from "../knowledge.ts";
import { SpecManager } from "../spec.ts";
import { GitOperations } from "../git.ts";
import { TddRunner } from "../tdd-runner.ts";
import { GlobalStatePersistence, SpecStatePersistence } from "../state-persistence.ts";
import { Logger } from "../logger.ts";
import { registerTools, type StateMachineRef } from "../tools.ts";
import { MODE_TOOL_SETS } from "../../extensions/constants.ts";
import { loadConfig } from "../config.ts";
import { loadOrchestratorPrompt, resetOrchestratorPromptCache, resetLightModePromptCache, resetPlanModePromptCache } from "../prompts/prompt-builders.ts";
import { registerCompactionHandler } from "../compaction.ts";
import type { HandlerContext } from "../handlers/types.ts";
import type { FSMState, LightFSMState } from "../types.ts";

/** Register the session_start event handler and its sub-listeners. */
export function registerSessionStartHandler(ctx: HandlerContext): void {
  ctx.pi.on("session_start", async (_event, cmdCtx) => {
    // Reset session state
    ctx.tokenTracker.sessionTurnCount = 0;
    ctx.tokenTracker.sessionStartTime = Date.now();
    ctx.tokenTracker.sessionSpecCount = 0;

    // --- Child Process Guard ---
    if (Number(process.env.PI_SUBAGENT_DEPTH ?? "0") > 0) {
      ctx.piCoderMode = "off";
      ctx.stateMachine = null;
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
    const logDir = join(cwd, ".pi-coder", "logs");
    ctx.logger = new Logger(logDir, ctx.config.logging, ctx.sessionId);

    // Emit config_validation if there were warnings
    if (configResult.warnings.length > 0) {
      ctx.logEvent("config_validation", {
        warnings: configResult.warnings,
      });
    }

    // Load prompt templates
    resetOrchestratorPromptCache();
    resetLightModePromptCache();
    resetPlanModePromptCache();
    loadOrchestratorPrompt(cwd);

    // Initialize state machine based on mode
    if (ctx.piCoderMode === "tdd") {
      ctx.stateMachine = new StateMachine(ctx.config);
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
          if (!ctx.subagentMonitor.running) return;
          // No pi.sendMessage for foreground subagents
        } else if (ctrl.type === "active_long_running") {
          const elapsed = ctrl.elapsedMs ? Math.floor(ctrl.elapsedMs / 1000) : "?";
          ctx.logEvent("subagent_control", {
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
        ctx.piCoderMode = savedGlobalState.piCoderActive ? "tdd" : "off";
      }

      // Re-align stateMachine instance with restored mode
      if (ctx.piCoderMode === "light" && !(ctx.stateMachine instanceof LightStateMachine)) {
        ctx.stateMachine = new LightStateMachine(ctx.config);
      } else if (ctx.piCoderMode === "tdd" && !(ctx.stateMachine instanceof StateMachine)) {
        ctx.stateMachine = new StateMachine(ctx.config);
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
          const isLightOnlyState = savedState === "IMPLEMENTING";
          const modeMismatch =
            (ctx.piCoderMode === "light" && isTddState) ||
            (ctx.piCoderMode === "tdd" && isLightOnlyState);

          if (modeMismatch) {
            ctx.logEvent("state_restore", {
              status: "mode_mismatch",
              specId: savedGlobalState.activeSpecId,
              savedState,
              currentMode: ctx.piCoderMode,
              message: `Spec was created in ${isTddState ? "TDD" : "Light"} mode but current mode is ${ctx.piCoderMode}. Switch modes to resume.`,
            });
            cmdCtx.ui.notify(
              `Active spec '${savedGlobalState.activeSpecId}' was created in ${isTddState ? "TDD" : "Light"} mode. Switch to ${isTddState ? "TDD" : "Light"} mode with /pi-coder to resume.`,
              "warning",
            );
            ctx.stateMachine = ctx.piCoderMode === "tdd"
              ? new StateMachine(ctx.config)
              : new LightStateMachine(ctx.config);
          } else if (ctx.piCoderMode === "tdd") {
            ctx.stateMachine = StateMachine.fromJSON({
              currentState: specState.currentState as FSMState,
              loopCount: specState.loopCount,
              gitRef: specState.gitRef,
              currentUnitName: specState.currentUnitName ?? null,
              evidence: specState.evidence,
            }, ctx.config);
          } else if (ctx.piCoderMode === "light") {
            ctx.stateMachine = LightStateMachine.fromJSON({
              currentState: specState.currentState as LightFSMState,
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
