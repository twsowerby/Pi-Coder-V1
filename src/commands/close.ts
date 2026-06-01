/**
 * Pi Coder V1 — Close Spec Command Handler
 *
 * Extracted from extensions/index.ts (Phase 4, Step 4.4).
 * Closes a spec (sets CANCELLED status, deletes state.json, keeps spec.md as audit trail).
 */

import type { HandlerContext } from "../handlers/types.ts";
import { SpecStatePersistence } from "../state-persistence.ts";

/** Register the /pi-coder-close command. */
export function registerCloseCommand(ctx: HandlerContext): void {
  ctx.pi.registerCommand("pi-coder-close", {
    description: "Close a spec (set CANCELLED status, delete state.json, keep spec.md as audit trail)",
    handler: async (_args, cmdCtx) => {
      if (!ctx.specManager) {
        cmdCtx.ui.notify("Pi Coder not initialized. Run /pi-coder-init first.", "error");
        return;
      }

      // 1. List all specs and filter to non-COMPLETE/CANCELLED
      const allSpecIds = await ctx.specManager.listSpecs();
      const openSpecs: Array<{ id: string; status: string }> = [];

      for (const specId of allSpecIds) {
        const spec = await ctx.specManager.readSpec(specId);
        if (spec && spec.status !== "COMPLETE" && spec.status !== "CANCELLED") {
          openSpecs.push({ id: specId, status: spec.status });
        }
      }

      if (openSpecs.length === 0) {
        cmdCtx.ui.notify("No open specs to close.", "info");
        return;
      }

      // 2. Present selection UI
      const options = openSpecs.map(s => `${s.id} — ${s.status}`);
      const selected = await cmdCtx.ui.select(
        "Close Spec",
        options,
      );

      if (selected === undefined) return; // Cancelled

      // Find the selected spec
      const selectedSpec = openSpecs.find(s => `${s.id} — ${s.status}` === selected);
      if (!selectedSpec) return;

      const previousStatus = selectedSpec.status;

      // 3. Update spec status to CANCELLED
      await ctx.specManager.updateSpec(selectedSpec.id, { status: "CANCELLED" });

      // 4. Delete state.json
      await SpecStatePersistence.delete(ctx.specManager.specsDir, selectedSpec.id);

      // 5. If this was the active spec, reset FSM and clear active pointer
      if (ctx.activeSpecId === selectedSpec.id) {
        if (ctx.stateMachine) {
          const previousState = ctx.stateMachine.currentState;
          ctx.stateMachine.reset();
          ctx.tokenTracker.emitStateUsageAndTransition(previousState, "IDLE", ctx.activeSpecId);
          ctx.logEvent("fsm_transition", {
            from: previousState,
            to: "IDLE",
            trigger: "fsm_reset",
            event: "reset",
            loopCount: ctx.stateMachine.loopCount,
            specId: ctx.activeSpecId,
          });
        }
        ctx.activeSpecId = null;
        ctx.nudgeEngine.reset("IDLE");
      }

      // 6. Persist and refresh
      await ctx.persistState();
      ctx.refreshUI();

      // 7. Confirm and log
      cmdCtx.ui.notify(`Spec '${selectedSpec.id}' closed (CANCELLED).`, "info");
      ctx.logEvent("command", { command: "close_spec", specId: selectedSpec.id, previousStatus });
    },
  });
}
