/**
 * Pi Coder V1 — FSM-Aware Compaction Hook (R1)
 *
 * Registers a `session_before_compact` handler that builds a ~300-500 token
 * FSM context block and prepends it to the compaction summary. This ensures
 * the FSM state survives compaction as structured data rather than prose
 * approximation.
 *
 * Also provides the `buildFsmContext()` helper for constructing the context
 * block from the current handler context.
 */

import type { HandlerContext } from "./handlers/types.ts";

// ---------------------------------------------------------------------------
// Context Block Builder
// ---------------------------------------------------------------------------

/**
 * Build a structured FSM context block (~300-500 tokens) that captures
 * everything the FSM needs to resume correctly after compaction.
 *
 * Returns an empty string if `stateMachine` is null (plan mode / off mode).
 * Uses only synchronous state from the IStateMachine and HandlerContext —
 * no async spec reads (the compaction handler is synchronous).
 */
export function buildFsmContext(ctx: HandlerContext): string {
  const sm = ctx.stateMachine;
  if (!sm) return "";

  const lines: string[] = [];

  // --- Header ---
  lines.push("# Pi-Coder FSM State (CRITICAL — preserve this across compaction)");
  lines.push("");

  // --- Current State ---
  lines.push("## Current State");
  lines.push(`State: ${sm.currentState}`);

  if (ctx.activeSpecId) {
    lines.push(`Active spec: ${ctx.activeSpecId}`);
  }

  // Active unit progress
  if (sm.currentUnitName) {
    lines.push(`Active unit: ${sm.currentUnitName}`);
  }

  lines.push("");

  // --- Evidence Flags ---
  const evidence = sm.getEvidence();
  if (evidence.length > 0) {
    lines.push("## Evidence Flags");
    lines.push("- " + evidence.join(", "));
    lines.push("");
  }

  // --- Retry Counts ---
  const retryKeys = ["green_retries", "red_retries"] as const;
  const retryEntries = retryKeys
    .map((key) => ({ key, count: sm.getRetryCounter(key) }))
    .filter((entry) => entry.count > 0);

  if (retryEntries.length > 0) {
    lines.push("## Retry Counts");
    for (const entry of retryEntries) {
      lines.push(`- ${entry.key}: ${entry.count}`);
    }
    lines.push("");
  }

  // --- Loop Count ---
  if (sm.loopCount > 0) {
    lines.push("## Review Loops");
    lines.push(`- loop_count: ${sm.loopCount} (max: ${ctx.config.maxLoops})`);
    lines.push("");
  }

  // --- Git Ref ---
  if (sm.gitRef) {
    lines.push("## Git Ref");
    lines.push(`- ${sm.gitRef}`);
    lines.push("");
  }

  // --- Review File Pointer ---
  if (ctx.activeSpecId && evidence.includes("review_completed")) {
    lines.push("## Review");
    lines.push(`Full review: .pi-coder/specs/${ctx.activeSpecId}/review.md`);
    lines.push("");
  }

  // --- Research Report Pointer ---
  if (ctx.activeSpecId) {
    lines.push("## Research Report");
    lines.push(`Full researcher report: .pi-coder/specs/${ctx.activeSpecId}/research-output.md`);
    lines.push("");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Compaction Handler Registration
// ---------------------------------------------------------------------------

/**
 * Register the `session_before_compact` handler that prepends FSM context
 * to the compaction summary. Falls back to default compaction (returns
 * undefined) if the FSM is null (plan mode / off mode).
 */
export function registerCompactionHandler(ctx: HandlerContext): void {
  ctx.pi.on("session_before_compact", async (event) => {
    const fsmContext = buildFsmContext(ctx);

    // No FSM context — fall back to default compaction
    if (!fsmContext) return undefined;

    const { preparation } = event;
    const { previousSummary, firstKeptEntryId, tokensBefore } = preparation;

    // Prepend FSM context to previous summary (or use it alone if no previous summary)
    const combinedSummary = previousSummary
      ? `${fsmContext}\n\n${previousSummary}`
      : fsmContext;

    return {
      compaction: {
        summary: combinedSummary,
        firstKeptEntryId,
        tokensBefore,
      },
    };
  });
}
