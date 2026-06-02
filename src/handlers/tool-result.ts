/**
 * Pi Coder V1 — Tool Result Handler
 *
 * Extracted from extensions/index.ts (Phase 4, Step 4.9).
 * Intercepts pi's tool_result to auto-transition FSM based on results,
 * handle review verdicts, extract subagent usage, and manage subagent lifecycle.
 */

import { extractSubagentUsage, extractReviewVerdict, extractDetailsDiagnostics, isIntercomReceipt } from "../review-extraction.ts";
import type { IssueDetail, ReviewVerdict } from "../types.ts";
import { notify } from "../notification-manager.ts";
import { formatTokenCount, formatDurationMs } from "../ui/formatting.ts";
import type { HandlerContext } from "../handlers/types.ts";
import type { FSMTrigger } from "../logger.ts";
import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/** Maximum consecutive verdict extraction failures before forced re-delegation. */
const MAX_VERDICT_EXTRACTION_RETRIES = 3;

/** Token threshold for proactive compaction at FSM boundaries (R4).
 *  Set to 80K — with KV-cached providers, each compaction invalidates the prompt
 *  cache (~35K re-read cost). Compacting at 50K was too aggressive, causing 5
 *  compactions per spec with 3–4 barely exceeding the threshold. 80K allows
 *  ~3 unit cycles of cache continuity before compaction, reducing cache busting
 *  by ~3x while still preventing context from growing unboundedly. */
const PROACTIVE_COMPACTION_THRESHOLD_TOKENS = 80_000;

/**
 * Proactive Compaction at FSM Boundaries (R4).
 *
 * After each TDD unit completion (GREEN_VALIDATE transition), check context
 * token usage and compact if above threshold. This is a natural compaction
 * boundary — the FSm has just completed a unit and is about to start a new
 * one, making it safe to compress old context.
 *
 * Only triggers in TDD or Light mode (not plan/off mode), and only after
 * GREEN_VALIDATE transitions (unit completion = natural boundary).
 */
function checkProactiveCompaction(ctx: HandlerContext, afterState: string, previousState: string): void {
  // Only trigger in active FSM modes
  if (ctx.piCoderMode === "off" || ctx.piCoderMode === "plan") return;

  // Only trigger after GREEN_VALIDATE completions (unit completion = natural boundary)
  // This guard checks the ACTUAL previous state, not just the destination,
  // making it safe even if called from a different code path.
  if (previousState !== "TDD_GREEN_VALIDATE") return;

  // Check token usage
  const usage = ctx.sessionCtx?.getContextUsage();
  if (!usage || usage.tokens === null) return;

  if (usage.tokens <= PROACTIVE_COMPACTION_THRESHOLD_TOKENS) return;

  // Don't compact during an active subagent run
  if (ctx.subagentMonitor.running) return;

  ctx.logEvent("proactive_compaction_initiated", {
    tokensBefore: usage.tokens,
    threshold: PROACTIVE_COMPACTION_THRESHOLD_TOKENS,
    previousState,
    afterState,
    specId: ctx.activeSpecId,
  });

  ctx.sessionCtx?.compact({
    customInstructions: "Preserve FSM state, spec progress, and recent subagent results. The Pi-Coder FSM State block at the top of the summary is CRITICAL — do not discard or abbreviate it.",
    onComplete: () => {
      ctx.logEvent("proactive_compaction_completed", { afterState, specId: ctx.activeSpecId });
      // Auto-resume: compact() aborts the current agent turn. Without this,
      // the session stalls until the user manually sends a message.
      // pi.sendUserMessage always triggers a new turn, so the orchestrator
      // picks up where it left off using FSM context in the compaction summary.
      //
      // IMPORTANT: Do NOT tell the orchestrator to advance the FSM — the FSM
      // is already in the correct state after the transition. Telling it to
      // "use pi_coder_advance_fsm" causes a redundant advance that creates
      // duplicate unit_start events.
      const resumeMessage = `Continue with the current task. You are in ${afterState}. Proceed with the next step for this state.`;
      try {
        ctx.pi.sendUserMessage(resumeMessage);
        ctx.logEvent("proactive_compaction_resume", { afterState, specId: ctx.activeSpecId });
      } catch (err: unknown) {
        ctx.logEvent("proactive_compaction_resume_failed", { error: err instanceof Error ? err.message : String(err), afterState, specId: ctx.activeSpecId });
      }
    },
    onError: (error: Error) => {
      ctx.logEvent("proactive_compaction_error", { error: error.message, afterState, specId: ctx.activeSpecId });
      // Attempt resume even on compaction error — the session may still be usable
      // Same fix as onComplete: don't tell orchestrator to advance the FSM
      try {
        const resumeMessage = `Continue with the current task. You are in ${afterState}. Proceed with the next step for this state.`;
        ctx.pi.sendUserMessage(resumeMessage);
        ctx.logEvent("proactive_compaction_resume", { afterState, specId: ctx.activeSpecId, afterError: true });
      } catch (err: unknown) {
        ctx.logEvent("proactive_compaction_resume_failed", { error: err instanceof Error ? err.message : String(err), afterState, specId: ctx.activeSpecId, afterError: true });
      }
    },
  });
}

/**
 * Read the reviewer output file produced by pi-subagents' `output` parameter.
 *
 * When the orchestrator calls the reviewer subagent, pi-coder injects an
 * `output` parameter pointing to `.pi-coder/specs/{specId}/review-output.md`.
 * Pi-subagents writes the full output to this file — this happens inside the
 * subagent executor, AFTER the agent completes but BEFORE intercom strips
 * finalOutput from the in-memory details. The file is always written
 * regardless of intercom bridge state, making it a reliable extraction source.
 *
 * With `outputMode: "file-only"`, the in-memory result contains only a
 * compact file reference ("Output saved to: ..."), so reading from the
 * file is the PRIMARY extraction path, not a fallback.
 *
 * Returns the file content if it exists and is non-empty, else undefined.
 */
function readReviewOutputFile(cwd: string, specId: string | null, loopCount?: number): string | undefined {
  if (!specId) return undefined;
  // Try the loop-counted path first (current format: review-output-0.md, review-output-1.md)
  // Fall back to the original unversioned path for backward compatibility
  const candidates = loopCount !== undefined
    ? [
        resolve(cwd, ".pi-coder", "specs", specId, `review-output-${loopCount}.md`),
        resolve(cwd, ".pi-coder", "specs", specId, "review-output.md"), // legacy
      ]
    : [
        resolve(cwd, ".pi-coder", "specs", specId, "review-output.md"),
      ];
  for (const filePath of candidates) {
    try {
      if (existsSync(filePath)) {
        const content = readFileSync(filePath, "utf-8");
        if (content.length > 0) return content;
      }
    } catch {
      // continue to next candidate
    }
  }
  return undefined;
}

/** Save the full review text to `.pi-coder/specs/{activeSpecId}/review.md`. */
async function saveReviewToFile(ctx: HandlerContext, reviewText: string): Promise<void> {
  const specId = ctx.activeSpecId;
  if (!specId) return;

  const specsDir = resolve(ctx.projectCwd, ".pi-coder", "specs", specId);
  const filePath = resolve(specsDir, "review.md");

  try {
    await mkdir(specsDir, { recursive: true });
    await writeFile(filePath, reviewText, "utf-8");
    ctx.logEvent("review_saved_to_file", {
      specId,
      path: filePath,
      textLength: reviewText.length,
    });
  } catch (err: unknown) {
    ctx.logEvent("review_save_failed", {
      specId,
      path: filePath,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Build a structured summary from the extracted review verdict (for orchestrator context). */
function buildReviewSummary(verdict: ReviewVerdict, ctx: HandlerContext): string {
  const lines: string[] = [];

  if (verdict.verdict === "approved") {
    lines.push("## REVIEW RESULT");
    lines.push("Verdict: approved");
  } else {
    lines.push("## REVIEW RESULT");
    lines.push(`Verdict: needs_changes | Fix type: ${verdict.fixType}`);

    if (verdict.issues && verdict.issues.length > 0) {
      lines.push(`### Issues (${verdict.issues.length})`);
      for (const issue of verdict.issues.slice(0, 10)) { // Cap at 10 for summary
        const icon = issue.severity === "high" ? "🔴" : issue.severity === "medium" ? "🟠" : "🟢";
        const fileRef = issue.file ? `${issue.file} —` : "";
        const fixHint = issue.suggestedFix ? ` → fix: ${issue.suggestedFix}` : "";
        lines.push(`- ${icon} ${issue.severity.toUpperCase()}: ${fileRef} ${issue.problem}${fixHint}`);
      }
      if (verdict.issues.length > 10) {
        lines.push(`... and ${verdict.issues.length - 10} more`);
      }
    }
  }

  const specId = ctx.activeSpecId;
  if (specId) {
    lines.push(`Full review: .pi-coder/specs/${specId}/review.md`);
  }

  return lines.join("\n");
}

/** Format issues into a steer string for the NEEDS_CHANGES auto-transition. */
function formatIssuesSteer(issues?: IssueDetail[]): string {
  if (!issues || issues.length === 0) return "";

  const lines: string[] = [];
  lines.push(` Review found ${issues.length} issue${issues.length !== 1 ? "s" : ""}:`);
  for (const issue of issues.slice(0, 5)) { // Cap at 5 to avoid steer bloat
    const icon = issue.severity === "high" ? "🔴" : issue.severity === "medium" ? "🟠" : "🟡";
    const fileRef = issue.file ? ` ${issue.file} —` : "";
    const fixHint = issue.suggestedFix ? ` (fix: ${issue.suggestedFix})` : "";
    lines.push(`${icon} ${issue.severity.toUpperCase()}:${fileRef} ${issue.problem}${fixHint}`);
  }
  if (issues.length > 5) {
    lines.push(`... and ${issues.length - 5} more`);
  }
  return lines.join("\n");
}

/** Track consecutive verdict extraction failures per spec. */
const verdictExtractionFailures = new Map<string, number>();

/** Register the tool_result event handler. */
export function registerToolResultHandler(ctx: HandlerContext): void {
  ctx.pi.on("tool_result", async (event) => {
    // Filter subagent list output to only show pi-coder agents
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
        if (!line.startsWith("- ")) return true;
        const agentMatch = line.match(/^\-\s+(\S+)/);
        if (!agentMatch) return true;
        return agentMatch[1].startsWith("pi-coder.");
      });
      if (filtered.length !== lines.length) {
        return { content: [{ type: "text" as const, text: filtered.join("\n") }] };
      }
    }

    if (ctx.piCoderMode === "off") return;
    const isPlanMode = ctx.piCoderMode === "plan";

    const { details } = event;
    // In plan mode, stateMachine may be null. Capture current state only if available.
    const currentState = ctx.stateMachine?.currentState ?? "IDLE";

    // --- Universal processing (all modes including plan) ---

    // Subagent end logging, usage accrual, and monitor reset should ALWAYS run,
    // even in plan mode. Previously, the plan-mode early return skipped these,
    // producing missing subagent_end events, token accrual gaps, and stale monitors.
    if (toolName === "subagent") {
      const durationMs = ctx.subagentMonitor.startTime !== null ? Date.now() - ctx.subagentMonitor.startTime : null;
      const subUsage = extractSubagentUsage(details);

      if (subUsage) {
        ctx.tokenTracker.accrueSubagent(subUsage);
      }

      ctx.logEvent("subagent_end", {
        agent: ctx.subagentMonitor.lastAgent ?? "unknown",
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
        specId: ctx.activeSpecId,
      });

      ctx.subagentMonitor.startTime = null;
      ctx.subagentMonitor.lastAgent = null;
      ctx.subagentMonitor.running = false;
      ctx.subagentMonitor.activity = null;
      if (ctx.subagentMonitor.widgetTimer) {
        clearInterval(ctx.subagentMonitor.widgetTimer);
        ctx.subagentMonitor.widgetTimer = null;
      }
      ctx.refreshSubagentWidget();

      // Show completion summary notification
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
          ctx.sessionCtx?.ui.notify(summary, r.exitCode === 0 ? "info" : "error");
        }
      }

      // --- FSM-specific subagent processing continues below after plan-mode check ---
    }

    // --- Plan-mode exit: skip all FSM-specific processing ---
    // Universal subagent processing (end logging, usage accrual, monitor reset) has already run above.
    if (isPlanMode) {
      await ctx.persistState();
      ctx.refreshUI();
      return undefined;
    }

    // --- FSM-specific processing (TDD and Light modes only) ---
    // All code below is FSM-specific and should NOT run in plan mode.

    // Log lifecycle_start on IDLE → SPEC_WORK transitions
    if (toolName === "pi_coder_advance_fsm" && currentState === "SPEC_WORK" && ctx.tokenTracker.lifecycleStartTime === null) {
      ctx.tokenTracker.lifecycleStartTime = Date.now();
      ctx.tokenTracker.resetLifecycleTracking();
      ctx.tokenTracker.setAccrualState("SPEC_WORK");
      ctx.tokenTracker.sessionSpecCount++;
      ctx.logEvent("lifecycle_start", {
        specId: ctx.activeSpecId ?? "none",
        userRequest: "(spec work initiated)",
      });
    }

    // Track all FSM transitions via pi_coder_advance_fsm
    if (toolName === "pi_coder_advance_fsm") {
      const advDetails = details as { success?: boolean; previousState?: string; newState?: string; error?: string; exceptionTransition?: string; reason?: string } | undefined;
      if (advDetails?.success === true && advDetails?.previousState && advDetails?.newState && advDetails.previousState !== advDetails.newState) {
        ctx.tokenTracker.emitStateUsageAndTransition(advDetails.previousState, advDetails.newState, ctx.activeSpecId);
        ctx.logEvent("fsm_transition", {
          from: advDetails.previousState,
          to: advDetails.newState,
          trigger: "manual_advance_fsm",
          event: advDetails.exceptionTransition ? `exception:${advDetails.exceptionTransition}` : "advance",
          loopCount: ctx.stateMachine?.loopCount ?? 0,
          specId: ctx.activeSpecId,
          ...(advDetails.reason ? { exceptionReason: advDetails.reason } : {}),
        });

        if (advDetails.newState === "COMPLETE") {
          const wallClockMs = ctx.tokenTracker.lifecycleStartTime !== null ? Date.now() - ctx.tokenTracker.lifecycleStartTime : null;
          ctx.logEvent("lifecycle_end", {
            specId: ctx.activeSpecId,
            outcome: "COMPLETE",
            wallClockMs,
            totalTokens: ctx.tokenTracker.snapshotLifecycleTokens(),
            phaseTokens: ctx.tokenTracker.snapshotPhaseTokens(),
          });
          notify(ctx.config, "complete", "Pi Coder · ✅ Complete", `Spec ${ctx.activeSpecId ?? "unknown"} merged successfully`);
          ctx.tokenTracker.lifecycleStartTime = null;
          ctx.tokenTracker.resetLifecycleTracking();
        }

        if (advDetails.newState === "BLOCKED") {
          const wallClockMs = ctx.tokenTracker.lifecycleStartTime !== null ? Date.now() - ctx.tokenTracker.lifecycleStartTime : null;
          ctx.logEvent("lifecycle_end", {
            specId: ctx.activeSpecId,
            outcome: "BLOCKED",
            wallClockMs,
            totalTokens: ctx.tokenTracker.snapshotLifecycleTokens(),
            phaseTokens: ctx.tokenTracker.snapshotPhaseTokens(),
          });
        }

        if (ctx.stateMachine) {
          ctx.nudgeEngine.reset(ctx.stateMachine.currentState);
        }

        // R4: Proactive compaction after GREEN_VALIDATE completions
        // Pass both previous and new state so the function can verify
        // it was actually triggered by a GREEN_VALIDATE transition.
        if (
          advDetails.previousState === "TDD_GREEN_VALIDATE" &&
          (advDetails.newState === "REVIEWING" || advDetails.newState === "TDD_RED_WRITE")
        ) {
          checkProactiveCompaction(ctx, advDetails.newState, advDetails.previousState!);
        }
      }
    }

    // Evidence: interview tool completion in SPEC_WORK
    if ((ctx.piCoderMode === "tdd" || ctx.piCoderMode === "light") && toolName === "interview" && currentState === "SPEC_WORK") {
      const interviewDetails = details as { status?: string; responses?: Array<{ id?: string; value?: unknown }> } | undefined;

      if (interviewDetails?.status === "completed") {
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
          ctx.stateMachine!.setEvidence("spec_user_approved");
          const interviewDurationMs = ctx.tokenTracker.specApprovalInterviewStartTime !== null ? Date.now() - ctx.tokenTracker.specApprovalInterviewStartTime : null;
          ctx.tokenTracker.specApprovalInterviewStartTime = null;
          ctx.logEvent("spec_approval", { status: "approved", responseCount: responses.length, durationMs: interviewDurationMs });
        } else {
          const interviewDurationMs = ctx.tokenTracker.specApprovalInterviewStartTime !== null ? Date.now() - ctx.tokenTracker.specApprovalInterviewStartTime : null;
          ctx.tokenTracker.specApprovalInterviewStartTime = null;
          ctx.logEvent("spec_approval", { status: "rejected", responseCount: responses.length, durationMs: interviewDurationMs });
          const rejectionSteer = "\n\n⚠️ Spec not approved — the user requested changes. Review the interview feedback and revise the spec. Re-run the interview after making changes.";
          if (Array.isArray(rawContent) && rawContent.length >= 1 && rawContent[0]?.type === "text") {
            const textBlock = rawContent[0] as { type: "text"; text: string };
            textBlock.text += rejectionSteer;
          }
        }
      } else {
        const status = interviewDetails?.status ?? "unknown";
        const interviewDurationMs = ctx.tokenTracker.specApprovalInterviewStartTime !== null ? Date.now() - ctx.tokenTracker.specApprovalInterviewStartTime : null;
        ctx.tokenTracker.specApprovalInterviewStartTime = null;
        ctx.logEvent("spec_approval", { status: "not_completed", interviewStatus: status, durationMs: interviewDurationMs });
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
        return;
      }

      ctx.stateMachine!.setEvidence("test_run_this_state");

      const validation = details2.validation;
      const previousState = currentState;
      let transitionSteer = "";

      if (currentState === "TDD_RED_VALIDATE") {
        ctx.logEvent("tdd_red_validate", {
          valid: validation.valid,
          reason: validation.reason,
          passed: details2.testResult?.passed ?? null,
          failed: details2.testResult?.failed ?? null,
          specId: ctx.activeSpecId,
        });

        if (validation.valid) {
          ctx.stateMachine!.transition("TDD_GREEN_WRITE");
          ctx.tokenTracker.emitStateUsageAndTransition("TDD_RED_VALIDATE", "TDD_GREEN_WRITE", ctx.activeSpecId);
          transitionSteer = "\n\n⚠️ AUTO-TRANSITION: You are now in TDD_GREEN_WRITE. Next step: delegate to pi-coder.implementor to implement the code that makes the tests pass. Do NOT call pi_coder_advance_fsm yet — first get the implementation done.";
        } else {
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
        ctx.logEvent("tdd_green_validate", {
          valid: validation.valid,
          reason: validation.reason,
          passed: details2.testResult?.passed ?? null,
          failed: details2.testResult?.failed ?? null,
          specId: ctx.activeSpecId,
        });

        if (validation.valid) {
          transitionSteer = "\n\n✅ GREEN validation passed. Current FSM state: TDD_GREEN_VALIDATE. Use pi_coder_advance_fsm to advance: TDD_RED_WRITE (next implementation unit) or REVIEWING (all units complete).";

          // BUG-8 fix: Only emit unit_end if unitStartTime is set (not already emitted).
          // The orchestrator may run pi_coder_run_tests multiple times in GREEN_VALIDATE
          // (e.g., a focused test then a full suite). Without this guard, each valid=true
          // pass emits a duplicate unit_end — the second with durationMs=None.
          if (ctx.stateMachine!.currentUnitName && ctx.tokenTracker.unitStartTime !== null) {
            const durationMs = Date.now() - ctx.tokenTracker.unitStartTime;
            const outputTokens = ctx.tokenTracker.lifecycleTokens.output - ctx.tokenTracker.unitStartOutputTokens;
            ctx.logEvent("unit_end", {
              specId: ctx.activeSpecId,
              unitName: ctx.stateMachine!.currentUnitName,
              outcome: "green_validated",
              loopCount: ctx.stateMachine!.loopCount,
              fsmState: ctx.stateMachine!.currentState,
              outputTokens,
              durationMs,
            });
            ctx.tokenTracker.unitStartTime = null;
            ctx.tokenTracker.unitStartOutputTokens = 0;
          }
        } else {
          ctx.stateMachine!.transition("TDD_GREEN_WRITE");
          const greenRetries = ctx.stateMachine!.getRetryCounter("green_retries");
          ctx.tokenTracker.emitStateUsageAndTransition("TDD_GREEN_VALIDATE", "TDD_GREEN_WRITE", ctx.activeSpecId);

          ctx.logEvent("green_retry", {
            retryCount: greenRetries,
            specId: ctx.activeSpecId,
            unitName: ctx.stateMachine!.currentUnitName,
          });

          const maxRetries = ctx.config.retryEscalation.maxRetries;
          const enrichedThreshold = ctx.config.retryEscalation.enrichedSteerThreshold;
          const replanThreshold = ctx.config.retryEscalation.replanThreshold;

          // Hard block at max retries — force user intervention
          if (greenRetries >= maxRetries) {
            ctx.stateMachine!.transition("BLOCKED");
            ctx.tokenTracker.emitStateUsageAndTransition("TDD_GREEN_WRITE", "BLOCKED", ctx.activeSpecId);
            ctx.logEvent("green_retry_blocked", {
              retryCount: greenRetries,
              maxRetries,
              specId: ctx.activeSpecId,
              unitName: ctx.stateMachine!.currentUnitName,
            });
            notify(ctx.config, "blocked", "Pi Coder · 🔴 GREEN Retry Limit", `Max GREEN retries (${maxRetries}) exceeded on spec ${ctx.activeSpecId ?? "unknown"} — user intervention required`);
            transitionSteer = `\n\n🔴 HARD BLOCK: GREEN retry limit reached (${greenRetries} attempts of ${maxRetries} max). The FSM is now in BLOCKED state. The implementor has been unable to make the tests pass after ${greenRetries} attempts. This requires human intervention — review the implementation and test failures, then decide how to proceed.`;
          } else if (greenRetries >= replanThreshold) {
            // REPLAN intervention — force strategic analysis
            ctx.logEvent("green_retry_replan", {
              retryCount: greenRetries,
              replanThreshold,
              specId: ctx.activeSpecId,
              unitName: ctx.stateMachine!.currentUnitName,
            });
            transitionSteer = `\n\n⚠️ AUTO-TRANSITION: Tests still failing (attempt ${greenRetries + 1} of ${maxRetries}). STRATEGY INTERVENTION REQUIRED.\n\nYou have attempted GREEN implementation ${greenRetries + 1} times without success. Blind iteration is not working. BEFORE delegating to pi-coder.implementor again, you MUST:\n\n1. READ the full implementation file(s) and test file(s) related to this unit\n2. ANALYZE why the tests are still failing — articulate the specific gap between the implementation and the test expectations\n3. FORMULATE a fresh strategy — consider whether the approach is fundamentally wrong (e.g., wrong state management pattern, missing hook, incorrect data flow)\n4. ONLY THEN delegate to pi-coder.implementor with the new strategy clearly explained in the brief\n\nDo NOT simply re-delegate with 'clearer instructions' — that has not worked ${greenRetries} times. Change the approach fundamentally.`;
          } else if (greenRetries >= enrichedThreshold) {
            // Enriched steer — include failure context
            ctx.logEvent("green_retry_enriched", {
              retryCount: greenRetries,
              enrichedThreshold,
              specId: ctx.activeSpecId,
              unitName: ctx.stateMachine!.currentUnitName,
            });
            transitionSteer = `\n\n⚠️ AUTO-TRANSITION: Tests still failing (attempt ${greenRetries + 1} of ${maxRetries}). You are now in TDD_GREEN_WRITE.\n\nPrevious attempts have not resolved the failures. When delegating to pi-coder.implementor:\n- Include the SPECIFIC failing test names and assertion errors from the test output above\n- Focus the implementor on ONE failing test at a time\n- If DOM/UI tests are failing, emphasize checking the component tree and data flow before rendering\n- Do NOT repeat the same approach that failed previously`;
          } else {
            // Standard steer (current behavior)
            transitionSteer = "\n\n⚠️ AUTO-TRANSITION: Tests still failing. You are now in TDD_GREEN_WRITE. Delegate to pi-coder.implementor again with clearer instructions. Do NOT call pi_coder_advance_fsm yet.";
          }
        }
      }

      if (transitionSteer && Array.isArray(rawContent) && rawContent.length >= 1 && rawContent[0]?.type === "text") {
        const textBlock = rawContent[0] as { type: "text"; text: string };
        const appendedText = textBlock.text + transitionSteer;
        return { content: [{ type: "text" as const, text: appendedText }] };
      }

      if (ctx.stateMachine!.currentState !== previousState) {
        ctx.logEvent("fsm_transition", {
          from: previousState,
          to: ctx.stateMachine!.currentState,
          trigger: "auto_tdd_validation",
          event: validation.valid ? "validation_passed" : "validation_failed",
          loopCount: ctx.stateMachine!.loopCount,
          specId: ctx.activeSpecId,
        });

        if (ctx.stateMachine!.circuitBreakerTripped()) {
          ctx.logEvent("circuit_breaker", {
            loopCount: ctx.stateMachine!.loopCount,
            maxLoops: ctx.config.maxLoops,
            specId: ctx.activeSpecId,
          });
          notify(ctx.config, "circuit_breaker", "Pi Coder · 🔴 Circuit Breaker", `Max review loops (${ctx.config.maxLoops}) exceeded on spec ${ctx.activeSpecId ?? "unknown"}`);

          if (ctx.stateMachine!.currentUnitName && ctx.tokenTracker.unitStartTime !== null) {
            const durationMs = Date.now() - ctx.tokenTracker.unitStartTime;
            const outputTokens = ctx.tokenTracker.lifecycleTokens.output - ctx.tokenTracker.unitStartOutputTokens;
            ctx.logEvent("unit_end", {
              specId: ctx.activeSpecId,
              unitName: ctx.stateMachine!.currentUnitName,
              outcome: "circuit_breaker",
              loopCount: ctx.stateMachine!.loopCount,
              fsmState: ctx.stateMachine!.currentState,
              outputTokens,
              durationMs,
            });
            ctx.tokenTracker.unitStartTime = null;
            ctx.tokenTracker.unitStartOutputTokens = 0;
          }
        }
      }

      if (ctx.stateMachine!.currentState !== previousState) {
        ctx.nudgeEngine.reset(ctx.stateMachine!.currentState);
      }

      await ctx.persistState();
    }

    // Handle pi_coder_git results (auto-transition for checkpoint & merge)
    if (toolName === "pi_coder_git" && currentState === "GIT_CHECKPOINT") {
      const gitDetails = details as { operation?: string; success?: boolean; error?: string } | undefined;
      if (gitDetails?.success === true && gitDetails?.operation === "checkpoint") {
        const nextState = ctx.piCoderMode === "light" ? "IMPLEMENTING" : "TDD_RED_WRITE";
        ctx.stateMachine!.transition(nextState);
        ctx.tokenTracker.emitStateUsageAndTransition("GIT_CHECKPOINT", nextState, ctx.activeSpecId);
        ctx.logEvent("fsm_transition", {
          from: "GIT_CHECKPOINT",
          to: nextState,
          trigger: "auto_git_checkpoint",
          event: "checkpoint_complete",
          loopCount: ctx.stateMachine!.loopCount,
          specId: ctx.activeSpecId,
        });
        ctx.nudgeEngine.reset(ctx.stateMachine!.currentState);
        await ctx.persistState();

        if (Array.isArray(rawContent) && rawContent.length >= 1 && rawContent[0]?.type === "text") {
          const textBlock = rawContent[0] as { type: "text"; text: string };
          const nextStep = ctx.piCoderMode === "light"
            ? "delegate to pi-coder.implementor to implement the spec."
            : "delegate to pi-coder.implementor to write failing tests.";
          const appendedText = textBlock.text + `\n\n⚠️ AUTO-TRANSITION: Checkpoint complete. You are now in ${nextState}. Next step: ${nextStep}`;
          return { content: [{ type: "text" as const, text: appendedText }] };
        }
      }
    }

    if (toolName === "pi_coder_git" && currentState === "MERGING") {
      const gitDetails = details as { operation?: string; success?: boolean; error?: string } | undefined;
      if (gitDetails?.success === true) {
        ctx.stateMachine!.transition("COMPLETE");
        ctx.tokenTracker.emitStateUsageAndTransition("MERGING", "COMPLETE", ctx.activeSpecId);
        ctx.logEvent("fsm_transition", {
          from: "MERGING",
          to: "COMPLETE",
          trigger: "auto_git_merge",
          event: "merge_complete",
          loopCount: ctx.stateMachine!.loopCount,
          specId: ctx.activeSpecId,
        });
        ctx.logEvent("lifecycle_end", {
          specId: ctx.activeSpecId,
          outcome: "COMPLETE",
          wallClockMs: ctx.tokenTracker.lifecycleStartTime !== null ? Date.now() - ctx.tokenTracker.lifecycleStartTime : null,
          totalTokens: ctx.tokenTracker.snapshotLifecycleTokens(),
          phaseTokens: ctx.tokenTracker.snapshotPhaseTokens(),
        });
        notify(ctx.config, "complete", "Pi Coder · ✅ Complete", `Spec ${ctx.activeSpecId ?? "unknown"} merged successfully`);
        ctx.tokenTracker.lifecycleStartTime = null;
        ctx.tokenTracker.resetLifecycleTracking();
        ctx.nudgeEngine.reset(ctx.stateMachine!.currentState);
        await ctx.persistState();

        if (Array.isArray(rawContent) && rawContent.length >= 1 && rawContent[0]?.type === "text") {
          const textBlock = rawContent[0] as { type: "text"; text: string };
          const appendedText = textBlock.text + "\n\n✅ AUTO-TRANSITION: Merge complete. You are now in COMPLETE. The spec lifecycle is finished.";
          return { content: [{ type: "text" as const, text: appendedText }] };
        }
      }
    }

    // Handle subagent completion results (FSM-specific processing)
    // Universal subagent processing (end logging, usage accrual, monitor reset, completion notification)
    // is handled above in the universal processing block, BEFORE the plan-mode exit.
    // This block contains ONLY FSM-specific processing (auto-advance, review verdict extraction, etc.)
    if (toolName === "subagent") {
      const previousState = currentState;
      let transitionTrigger: FSMTrigger | null = null;
      let autoAdvanced = false;

      // Re-extract subagent details for FSM-specific use
      // (these were extracted in the universal block above but are out of scope here)
      const subUsage = extractSubagentUsage(details);
      const subDetails = details as {
        results?: Array<{
          agent: string;
          task: string;
          exitCode: number;
          usage?: { turns?: number };
          progress?: { durationMs?: number; toolCount?: number; tokens?: number; status?: string };
          progressSummary?: { durationMs?: number; toolCount?: number; tokens?: number };
          finalOutput?: string;
          messages?: Array<{ role: string; content: string | Array<unknown> }>;
        }>;
        mode?: string;
      } | null;

      // Auto-advance: TDD_RED_WRITE → TDD_RED_VALIDATE after implementor completes successfully.
      // The only valid transition from TDD_RED_WRITE is TDD_RED_VALIDATE, so there's no ambiguity.
      // This eliminates the manual advance step where LLMs most commonly make FSM errors.
      const subAgentName = subDetails?.results?.[0]?.agent ?? "";
      if (
        ctx.piCoderMode === "tdd" &&
        previousState === "TDD_RED_WRITE" &&
        subAgentName.includes("implementor") &&
        (subUsage?.exitCode ?? 0) === 0
      ) {
        ctx.stateMachine!.transition("TDD_RED_VALIDATE");
        ctx.tokenTracker.emitStateUsageAndTransition("TDD_RED_WRITE", "TDD_RED_VALIDATE", ctx.activeSpecId);
        transitionTrigger = "auto_implementor_complete";
        autoAdvanced = true;
        ctx.logEvent("fsm_transition", {
          from: "TDD_RED_WRITE",
          to: "TDD_RED_VALIDATE",
          trigger: "auto_implementor_complete",
          event: "tests_written",
          loopCount: ctx.stateMachine!.loopCount,
          specId: ctx.activeSpecId,
        });
        ctx.nudgeEngine.reset(ctx.stateMachine!.currentState);
        await ctx.persistState();

        if (Array.isArray(rawContent) && rawContent.length >= 1 && rawContent[0]?.type === "text") {
          const textBlock = rawContent[0] as { type: "text"; text: string };
          textBlock.text += "\n\n✅ AUTO-TRANSITION: Implementor completed RED phase. You are now in TDD_RED_VALIDATE. Run tests with pi_coder_run_tests to validate (expect tests to FAIL).";
        }
      }

      // Auto-advance: TDD_GREEN_WRITE after implementor completes (from NEEDS_CHANGES shortcut or regular GREEN phase)
      // Only auto-advance if the implementor was dispatched from NEEDS_CHANGES → TDD_GREEN_WRITE.
      // The regular TDD_GREEN_WRITE → TDD_GREEN_VALIDATE path auto-advances on test results, not on implementor completion.
      // NOTE: We do NOT auto-advance here for regular GREEN because the implementor may run tests
      // as part of its work and the test result handler already manages GREEN_VALIDATE transitions.
      // For the NEEDS_CHANGES shortcut, the implementor was dispatched while in TDD_GREEN_WRITE,
      // so we auto-advance to TDD_GREEN_VALIDATE so the orchestrator runs validation.

      // Review result in REVIEWING state
      if (currentState === "REVIEWING") {
        const rawContentText = (() => {
          if (Array.isArray(rawContent)) {
            return rawContent
              .filter((c: unknown) => typeof c === "object" && c !== null && (c as Record<string, unknown>).type === "text")
              .map((c: unknown) => (c as { type: string; text?: string }).text ?? "")
              .join("\n");
          }
          return undefined;
        })();

        // Read the reviewer output file — the PRIMARY extraction source.
        // When pi-coder dispatches the reviewer, it injects `output` and `outputMode: "file-only"`
        // into the subagent call. Pi-subagents writes the full output to this file inside
        // the executor, AFTER the agent completes but BEFORE intercom strips finalOutput
        // from the in-memory details. The file is always written regardless of intercom state.
        const outputFileText = readReviewOutputFile(ctx.projectCwd, ctx.activeSpecId, ctx.stateMachine?.loopCount);

        // Try extraction with the output file first (most reliable), then details, then rawContent
        let reviewVerdict: ReviewVerdict | null = null;
        let extractionSource = "none";

        if (outputFileText) {
          reviewVerdict = extractReviewVerdict({ mode: "single", results: [{ finalOutput: outputFileText }] });
          if (reviewVerdict) extractionSource = "output_file";
        }

        if (!reviewVerdict) {
          reviewVerdict = extractReviewVerdict(details, rawContentText);
          if (reviewVerdict) extractionSource = extractionSource || "details_rawContent";
        }

        if (reviewVerdict && extractionSource !== "none") {
          ctx.logEvent("verdict_extraction_source", {
            source: extractionSource,
            specId: ctx.activeSpecId,
            verdict: reviewVerdict.verdict,
          });
        }

        if (reviewVerdict) {
          // Reset verdict extraction failure counter on success
          const specKey = ctx.activeSpecId ?? "_global";
          verdictExtractionFailures.delete(specKey);

          ctx.logEvent("review_result", {
            verdict: reviewVerdict.verdict,
            extractedFrom: extractionSource,
            issues: reviewVerdict.verdict === "needs_changes" ? reviewVerdict.issues : undefined,
            issueCount: reviewVerdict.verdict === "needs_changes" ? {
              high: reviewVerdict.issues?.filter(i => i.severity === "high").length ?? 0,
              medium: reviewVerdict.issues?.filter(i => i.severity === "medium").length ?? 0,
              low: reviewVerdict.issues?.filter(i => i.severity === "low").length ?? 0,
            } : undefined,
            highSeverityCount: reviewVerdict.verdict === "needs_changes" ? reviewVerdict.issues?.filter(i => i.severity === "high").length ?? 0 : undefined,
            fixType: reviewVerdict.verdict === "needs_changes" ? reviewVerdict.fixType : undefined,
            loopCount: ctx.stateMachine!.loopCount,
            specId: ctx.activeSpecId,
          });

          const target = reviewVerdict.verdict === "approved" ? "APPROVED" : "NEEDS_CHANGES";
          ctx.stateMachine!.setEvidence("review_completed");
          ctx.stateMachine!.transition(target);
          ctx.tokenTracker.emitStateUsageAndTransition("REVIEWING", target, ctx.activeSpecId);
          transitionTrigger = "auto_review_verdict";

          if (ctx.piCoderMode === "tdd" && reviewVerdict.verdict === "needs_changes" && reviewVerdict.fixType === "non-functional" && target === "NEEDS_CHANGES") {
            ctx.stateMachine!.setEvidence("non_functional_classified");
          }

          let reclassificationGuidance = "";
          if (ctx.piCoderMode === "tdd" && reviewVerdict.verdict === "needs_changes" && reviewVerdict.fixType === "functional") {
            reclassificationGuidance = " If the reviewer flagged a direct unit as needing TDD, re-save the spec with that unit's approach changed to 'tdd', present the change to the user via interview, and proceed with a full RED/GREEN cycle.";
          }
          const reviewSteer = reviewVerdict.verdict === "approved"
            ? "\n\n✅ AUTO-TRANSITION: Review approved. You are now in APPROVED. Advance to MERGING (if user already approved) or FINAL_APPROVAL (for separate sign-off)."
            : ctx.piCoderMode === "light" && reviewVerdict.verdict === "needs_changes"
              ? `\n\n⚠️ AUTO-TRANSITION: Review needs changes${reviewVerdict.fixType === "non-functional" ? " (non-functional fix)" : ""}.${formatIssuesSteer(reviewVerdict.issues)} You are now in NEEDS_CHANGES. Delegate implementor to apply the fix, then advance to REVIEWING; or advance to IMPLEMENTING for a full reimplementation.`
              : reviewVerdict.verdict === "needs_changes" && reviewVerdict.fixType === "non-functional"
                ? `\n\n⚠️ AUTO-TRANSITION: Review needs changes (non-functional fix).${formatIssuesSteer(reviewVerdict.issues)} You are now in NEEDS_CHANGES. Delegate to pi-coder.implementor to apply the fix, then advance to REVIEWING with pi_coder_advance_fsm — the evidence gate is already satisfied.`
                : `\n\n⚠️ AUTO-TRANSITION: Review needs changes.${formatIssuesSteer(reviewVerdict.issues)} You are now in NEEDS_CHANGES. Three paths: (1) Non-functional fix → advance to REVIEWING. (2) Functional fix with existing test coverage → advance to TDD_GREEN_WRITE. (3) Functional fix needing new tests → advance to TDD_RED_WRITE.${reclassificationGuidance}`;

          // --- R2: Subagent Working Docs — Reviewer Phase ---
          // Save full review to file and replace content with structured summary
          // when we have a valid verdict and an active spec ID.
          const hasActiveSpecId = ctx.activeSpecId !== null;
          if (hasActiveSpecId) {
            // Save the full review text to file
            const fullReviewText = (() => {
              // Prefer output file — always written by pi-subagents executor
              if (outputFileText) {
                return outputFileText;
              }
              // Fallback: finalOutput from subagent details (may be stripped by intercom)
              if (subDetails?.results?.[0]?.finalOutput && typeof subDetails.results[0].finalOutput === "string") {
                return subDetails.results[0].finalOutput as string;
              }
              // Fallback: rawContent text (intercom receipt or file-only reference)
              if (Array.isArray(rawContent) && rawContent.length >= 1 && rawContent[0]?.type === "text") {
                return (rawContent[0] as { type: string; text: string }).text;
              }
              return "";
            })();
            await saveReviewToFile(ctx, fullReviewText);

            // Build structured summary and replace rawContent with it
            const summary = buildReviewSummary(reviewVerdict, ctx);
            if (Array.isArray(rawContent) && rawContent.length >= 1 && rawContent[0]?.type === "text") {
              (rawContent[0] as { type: "text"; text: string }).text = summary + reviewSteer;
            }
          } else {
            // No active spec ID — keep existing behavior (append steer to full output)
            if (Array.isArray(rawContent) && rawContent.length >= 1 && rawContent[0]?.type === "text") {
              const textBlock = rawContent[0] as { type: "text"; text: string };
              (rawContent[0] as { type: "text"; text: string }).text = textBlock.text + reviewSteer;
            }
          }
        } else {
          const diagnostics = extractDetailsDiagnostics(details);
          const receiptDetected = isIntercomReceipt(rawContent);
          const specKey = ctx.activeSpecId ?? "_global";
          const failCount = (verdictExtractionFailures.get(specKey) ?? 0) + 1;
          verdictExtractionFailures.set(specKey, failCount);

          // Diagnostic: log the full details.results[0] shape on the intercom
          // receipt path. This helps determine whether the `messages` array is
          // available as a fallback extraction source when finalOutput is stripped.
          const intercomDebugMeta = receiptDetected ? (() => {
            const r0 = (details as { results?: Array<Record<string, unknown>> })?.results?.[0];
            return {
              resultKeys: r0 ? Object.keys(r0) : [],
              hasMessages: Array.isArray(r0?.messages),
              messagesLength: Array.isArray(r0?.messages) ? (r0!.messages as unknown[]).length : 0,
              hasFinalOutput: typeof r0?.finalOutput === "string",
              hasProgress: !!r0?.progress,
              hasUsage: !!r0?.usage,
              exitCode: typeof r0?.exitCode === "number" ? r0.exitCode : null,
              error: typeof r0?.error === "string" ? r0.error : null,
            };
          })() : undefined;

          ctx.logEvent("verdict_extraction_failed", {
            fsmState: ctx.stateMachine?.currentState ?? "N/A",
            mode: ctx.piCoderMode,
            hasFinalOutput: diagnostics.hasFinalOutput,
            textLength: diagnostics.textLength,
            firstHundredChars: diagnostics.firstHundredChars,
            intercomReceiptDetected: receiptDetected,
            hasOutputFile: outputFileText !== undefined,
            outputFileLength: outputFileText?.length ?? 0,
            consecutiveFailures: failCount,
            maxRetries: MAX_VERDICT_EXTRACTION_RETRIES,
            specId: ctx.activeSpecId,
            // Additional diagnostic for intercom receipt path
            intercomDebug: intercomDebugMeta,
          });

          if (receiptDetected) {
            // 4F: Do NOT set review_completed evidence here — the verdict is unknown.
            // The intercom receipt confirms delivery but not the verdict content.
            // Setting review_completed without a valid verdict would allow the
            // REVIEWING → APPROVED guard to be satisfied without a real review.
            // Instead, the orchestrator must determine the verdict and advance explicitly.

            // After MAX_VERDICT_EXTRACTION_RETRIES, set degraded evidence to prevent deadloop
            if (failCount >= MAX_VERDICT_EXTRACTION_RETRIES) {
              verdictExtractionFailures.delete(specKey);
              ctx.stateMachine!.setEvidence("review_completed");

              ctx.logEvent("verdict_extraction_degraded", {
                consecutiveFailures: failCount,
                maxRetries: MAX_VERDICT_EXTRACTION_RETRIES,
                specId: ctx.activeSpecId,
                receiptPath: true,
                message: "Max extraction retries reached (receipt path) — setting degraded review_completed",
              });

              if (Array.isArray(rawContent) && rawContent.length >= 1 && rawContent[0]?.type === "text") {
                const textBlock = rawContent[0] as { type: "text"; text: string };
                textBlock.text +=
                  `\n\n🔴 DEGRADED VERDICT: Verdict extraction has failed ${failCount} consecutive times (receipt path). ` +
                  "The review_completed evidence has been set as a degraded fallback. " +
                  "READ the reviewer's output above carefully, determine the verdict yourself, and " +
                  "call pi_coder_advance_fsm with APPROVED or NEEDS_CHANGES. This is logged for audit.";
              }
            } else if (Array.isArray(rawContent) && rawContent.length >= 1 && rawContent[0]?.type === "text") {
              const textBlock = rawContent[0] as { type: "text"; text: string };
              textBlock.text +=
                "\n\n⚠️ DEGRADED RECOVERY: Verdict extraction failed because the intercom receipt path " +
                "stripped the reviewer's output (finalOutput is undefined). " +
                "READ the reviewer's output above, determine the verdict yourself, and call " +
                "pi_coder_advance_fsm with APPROVED or NEEDS_CHANGES (include the reviewOverride parameter " +
                "with your determined verdict and justification). Do NOT skip review.";
            }
          } else {
            // 4E: Auto-retry with 3-turn counter
            if (failCount >= MAX_VERDICT_EXTRACTION_RETRIES) {
              // Max retries reached — set degraded evidence and log
              verdictExtractionFailures.delete(specKey);
              ctx.stateMachine!.setEvidence("review_completed");

              ctx.logEvent("verdict_extraction_degraded", {
                consecutiveFailures: failCount,
                maxRetries: MAX_VERDICT_EXTRACTION_RETRIES,
                specId: ctx.activeSpecId,
                message: "Max extraction retries reached — setting degraded review_completed",
              });

              if (Array.isArray(rawContent) && rawContent.length >= 1 && rawContent[0]?.type === "text") {
                const textBlock = rawContent[0] as { type: "text"; text: string };
                textBlock.text +=
                  `\n\n🔴 DEGRADED VERDICT: Verdict extraction has failed ${failCount} consecutive times. ` +
                  "The review_completed evidence has been set as a degraded fallback. " +
                  "READ the reviewer's output above carefully, determine the verdict yourself, and " +
                  "advance to APPROVED or NEEDS_CHANGES with pi_coder_advance_fsm. This is logged for audit.";
              }
            } else if (failCount >= 2) {
              // 2nd failure — stronger prompt telling the reviewer to use the block format
              if (Array.isArray(rawContent) && rawContent.length >= 1 && rawContent[0]?.type === "text") {
                const textBlock = rawContent[0] as { type: "text"; text: string };
                textBlock.text +=
                  `\n\n⚠️ VERDICT EXTRACTION FAILED (attempt ${failCount} of ${MAX_VERDICT_EXTRACTION_RETRIES}): ` +
                  "Could not extract review verdict from subagent output. " +
                  "Re-delegate the reviewer with EXPLICIT instructions: 'You MUST end your output with a " +
                  "---VERDICT--- block using exactly this format:\n" +
                  "---VERDICT---\nVERDICT: approved OR needs_changes\nFIX_TYPE: functional OR non-functional\n" +
                  "---END VERDICT---\n' " +
                  "Do NOT skip review by advancing manually.";
              }
            } else {
              // 1st failure — standard guidance
              if (Array.isArray(rawContent) && rawContent.length >= 1 && rawContent[0]?.type === "text") {
                const textBlock = rawContent[0] as { type: "text"; text: string };
                textBlock.text +=
                  "\n\n⚠️ AUTO-TRANSITION FAILED: Could not extract review verdict from subagent output. " +
                  "Re-delegate the reviewer with explicit instructions to use the ---VERDICT--- block format. " +
                  "Do NOT skip review by advancing manually — the REVIEWING → APPROVED guard requires review_completed evidence.";
              }
            }
          }
        }
      }

      // Log FSM transition (skip if auto-advance already logged to avoid duplicate)
      if (!autoAdvanced && ctx.stateMachine!.currentState !== previousState) {
        ctx.logEvent("fsm_transition", {
          from: previousState,
          to: ctx.stateMachine!.currentState,
          trigger: transitionTrigger ?? "auto_subagent_complete",
          event: transitionTrigger === "auto_review_verdict" ? "review_verdict" : "subagent_completed",
          loopCount: ctx.stateMachine!.loopCount,
          specId: ctx.activeSpecId,
        });

        if (ctx.stateMachine!.currentState === "COMPLETE") {
          const wallClockMs = ctx.tokenTracker.lifecycleStartTime !== null ? Date.now() - ctx.tokenTracker.lifecycleStartTime : null;
          ctx.logEvent("lifecycle_end", {
            specId: ctx.activeSpecId,
            outcome: "COMPLETE",
            wallClockMs,
            totalTokens: ctx.tokenTracker.snapshotLifecycleTokens(),
            phaseTokens: ctx.tokenTracker.snapshotPhaseTokens(),
          });
          notify(ctx.config, "complete", "Pi Coder · ✅ Complete", `Spec ${ctx.activeSpecId ?? "unknown"} merged successfully`);
          ctx.tokenTracker.lifecycleStartTime = null;
          ctx.tokenTracker.resetLifecycleTracking();
        }

        if (ctx.stateMachine!.currentState === "BLOCKED" && previousState === "TDD_RED_VALIDATE") {
          const wallClockMs = ctx.tokenTracker.lifecycleStartTime !== null ? Date.now() - ctx.tokenTracker.lifecycleStartTime : null;
          ctx.logEvent("lifecycle_end", {
            specId: ctx.activeSpecId,
            outcome: "BLOCKED",
            wallClockMs,
            totalTokens: ctx.tokenTracker.snapshotLifecycleTokens(),
            phaseTokens: ctx.tokenTracker.snapshotPhaseTokens(),
          });
        }

        if (ctx.stateMachine!.circuitBreakerTripped()) {
          ctx.logEvent("circuit_breaker", {
            loopCount: ctx.stateMachine!.loopCount,
            maxLoops: ctx.config.maxLoops,
            specId: ctx.activeSpecId,
          });
          notify(ctx.config, "circuit_breaker", "Pi Coder · 🔴 Circuit Breaker", `Max review loops (${ctx.config.maxLoops}) exceeded on spec ${ctx.activeSpecId ?? "unknown"}`);
        }
      }

      if (ctx.stateMachine!.currentState !== previousState) {
        ctx.nudgeEngine.reset(ctx.stateMachine!.currentState);
      }

      await ctx.persistState();
    }

    // Catch-all persist + refresh
    await ctx.persistState();
    ctx.refreshUI();

    return undefined;
  });
}
