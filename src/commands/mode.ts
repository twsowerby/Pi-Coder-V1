/**
 * Pi Coder V1 — Mode Switch Command Handler
 *
 * Extracted from extensions/index.ts (Phase 4, Step 4.1).
 * Switches pi-coder mode (plan/light/tdd/off).
 */

import type { PiCoderMode, FSMState } from "../types.ts";
import { StateMachine } from "../state-machine.ts";
import { LightStateMachine } from "../light-state-machine.ts";
import { DevStateMachine } from "../dev-state-machine.ts";
import { MODE_TOOL_SETS } from "../../extensions/constants.ts";
import type { HandlerContext } from "../handlers/types.ts";

/** Register the /pi-coder mode switch command. */
export function registerModeCommand(ctx: HandlerContext): void {
  ctx.pi.registerCommand("pi-coder", {
    description: "Switch pi-coder mode",
    handler: async (_args, cmdCtx) => {
      // Build the mode labels with current state indicators
      const current = ctx.piCoderMode;
      const modes = [
        { value: "plan", label: `Plan Mode (investigation & discussion)${current === "plan" ? "  ◀" : ""}` },
        { value: "light", label: `Light Mode (spec → implement → review)${current === "light" ? "  ◀" : ""}` },
        { value: "dev", label: `Dev Mode (spec → per-unit TDD/verify/skip → review)${current === "dev" ? "  ◀" : ""}` },
        { value: "tdd", label: `TDD Mode (full RED/GREEN lifecycle)${current === "tdd" ? "  ◀" : ""}` },
        { value: "off", label: `Off (normal Pi)${current === "off" ? "  ◀" : ""}` },
      ];

      const choice = await cmdCtx.ui.select(
        "Pi Coder Mode",
        modes.map(m => m.label),
      );

      if (choice === undefined) return; // Cancelled

      // choice is the selected label string — find the matching mode
      const selectedMode = modes.find(m => m.label === choice)?.value as PiCoderMode | undefined;
      if (!selectedMode || selectedMode === current) return; // No change

      // If switching to any active mode, check pi-subagents availability
      if (selectedMode !== "off" && !ctx.subagentsAvailable) {
        cmdCtx.ui.notify(
          "Pi Coder requires the pi-subagents package. Install with: `pi install npm:pi-subagents`",
          "error",
        );
        ctx.logEvent("command", { command: "mode_select", result: "blocked_no_subagents" });
        return;
      }

      // Handle mode switch FSM logic
      if (selectedMode !== current) {
        // When leaving plan mode, log summary
        if (current === "plan") {
          const planTokens = ctx.tokenTracker.snapshotLifecycleTokens();
          ctx.logEvent("plan_mode_summary", {
            totalTokens: planTokens,
            phaseTokens: ctx.tokenTracker.snapshotPhaseTokens(),
            durationMs: ctx.tokenTracker.lifecycleStartTime !== null ? Date.now() - ctx.tokenTracker.lifecycleStartTime : null,
            specId: ctx.activeSpecId,
          });
          // Reset lifecycle tracking for TDD/light
          ctx.tokenTracker.resetLifecycleTracking();
        }

        // When leaving a mode with an active FSM, pause the spec
        if (ctx.stateMachine && ctx.stateMachine!.currentState !== "IDLE") {
          ctx.logEvent("mode_switch", {
            from: current,
            to: selectedMode,
            fsmState: ctx.stateMachine?.currentState ?? "N/A",
            specId: ctx.activeSpecId,
          });
          // Per-spec state.json on disk is NOT deleted — user can switch back
          // Send notification about paused spec
          if (ctx.activeSpecId) {
            cmdCtx.ui.notify(`Active spec '${ctx.activeSpecId}' paused. Switch back to ${current} mode to resume.`, "info");
          }
        }

        // When entering a mode with a FSM, create the appropriate instance
        if (selectedMode === "tdd") {
          if (!ctx.stateMachine || !(ctx.stateMachine instanceof StateMachine)) {
            ctx.stateMachine = new StateMachine(ctx.config);
          }
        } else if (selectedMode === "dev") {
          if (!ctx.stateMachine || !(ctx.stateMachine instanceof DevStateMachine)) {
            ctx.stateMachine = new DevStateMachine(ctx.config);
          }
        } else if (selectedMode === "light") {
          if (!ctx.stateMachine || !(ctx.stateMachine instanceof LightStateMachine)) {
            ctx.stateMachine = new LightStateMachine(ctx.config);
          }
        } else {
          // Plan or Off — no FSM
          ctx.stateMachine = null;
        }
      }

      // Set mode first so downstream code uses the new value
      ctx.piCoderMode = selectedMode;

      // When entering plan mode, initialize lifecycle tracking
      if (selectedMode === "plan") {
        ctx.tokenTracker.lifecycleStartTime = Date.now();
        ctx.tokenTracker.resetLifecycleTracking();
        ctx.tokenTracker.setAccrualState("PLAN" as FSMState);
      }

      // Reset session state on mode switch
      ctx.tokenTracker.sessionTurnCount = 0;

      // Update active tools based on mode
      ctx.pi.setActiveTools(MODE_TOOL_SETS[ctx.piCoderMode]);
      ctx.refreshUI();

      // Notify user of mode change
      const modeLabels: Record<PiCoderMode, string> = {
        plan: "Plan Mode — Investigation and discussion only",
        tdd: "TDD Mode — Full lifecycle with spec, RED/GREEN, and review",
        light: "Light Mode — Spec, implementation, and review (no TDD)",
        dev: "Dev Mode — Full lifecycle with per-unit test strategy (tdd/verify/skip)",
        off: "Off — Normal Pi mode",
      };
      cmdCtx.ui.notify(`Pi Coder: ${modeLabels[ctx.piCoderMode]}`, "info");
      ctx.logEvent("command", { command: "mode_select", result: ctx.piCoderMode });

      // Send a steer message so the LLM knows the mode changed immediately
      if (ctx.piCoderMode !== "off") {
        const modeDescriptions: Record<PiCoderMode, string> = {
          plan: "Plan mode — Investigation and discussion only. Delegate to pi-coder.researcher. No specs, no git, no FSM.",
          tdd: "TDD mode — Full lifecycle with FSM, spec approval, RED/GREEN phases, and review. Follow the FSM state machine. Use pi_coder_advance_fsm to advance states.",
          light: "Light mode — Spec, implement, and review lifecycle with FSM. No RED/GREEN TDD phases. Follow the FSM state machine.",
          dev: "Dev mode — Full lifecycle with FSM, per-unit test strategy (tdd/verify/skip). Follow the FSM state machine. Use pi_coder_advance_fsm to advance states.",
          off: "",
        };
        ctx.pi.sendMessage(
          {
            customType: "pi-coder-mode-change",
            content: `🔄 Pi Coder mode changed to: ${ctx.piCoderMode.toUpperCase()}. ${modeDescriptions[ctx.piCoderMode]}`,
            display: true,
          },
          { deliverAs: "nextTurn" },
        );
      }

      // Persist mode state
      await ctx.persistState();
    },
  });
}
