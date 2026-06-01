/**
 * Pi Coder V1 — Tool Result Handler
 *
 * Extracted from extensions/index.ts (Phase 4, Step 4.9).
 * Intercepts pi's tool_result to auto-transition FSM based on results,
 * handle review verdicts, extract subagent usage, and manage subagent lifecycle.
 */

import { extractSubagentUsage, extractReviewVerdict, extractDetailsDiagnostics, isIntercomReceipt } from "../review-extraction.ts";
import { notify } from "../notification-manager.ts";
import { formatTokenCount, formatDurationMs } from "../ui/formatting.ts";
import type { HandlerContext } from "../handlers/types.ts";
import type { FSMTrigger } from "../logger.ts";

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
    if (ctx.piCoderMode === "plan") return;

    const { details } = event;
    const currentState = ctx.stateMachine!.currentState;

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

          if (ctx.stateMachine!.currentUnitName) {
            ctx.logEvent("unit_end", {
              specId: ctx.activeSpecId,
              unitName: ctx.stateMachine!.currentUnitName,
              outcome: "green_validated",
              loopCount: ctx.stateMachine!.loopCount,
              fsmState: ctx.stateMachine!.currentState,
            });
          }
        } else {
          ctx.stateMachine!.transition("TDD_GREEN_WRITE");
          ctx.tokenTracker.emitStateUsageAndTransition("TDD_GREEN_VALIDATE", "TDD_GREEN_WRITE", ctx.activeSpecId);
          transitionSteer = "\n\n⚠️ AUTO-TRANSITION: Tests still failing. You are now in TDD_GREEN_WRITE. Delegate to pi-coder.implementor again with clearer instructions. Do NOT call pi_coder_advance_fsm yet.";
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

          if (ctx.stateMachine!.currentUnitName) {
            ctx.logEvent("unit_end", {
              specId: ctx.activeSpecId,
              unitName: ctx.stateMachine!.currentUnitName,
              outcome: "circuit_breaker",
              loopCount: ctx.stateMachine!.loopCount,
              fsmState: ctx.stateMachine!.currentState,
            });
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

    // Handle subagent completion results
    if (toolName === "subagent") {
      const previousState = currentState;
      let transitionTrigger: FSMTrigger | null = null;

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
        const reviewVerdict = extractReviewVerdict(details, rawContentText);
        if (reviewVerdict) {
          ctx.logEvent("review_result", {
            verdict: reviewVerdict.verdict,
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

          const nextState = ctx.piCoderMode === "light" ? "IMPLEMENTING" : "TDD_RED_WRITE";
          let reclassificationGuidance = "";
          if (ctx.piCoderMode === "tdd" && reviewVerdict.verdict === "needs_changes" && reviewVerdict.fixType === "functional") {
            reclassificationGuidance = " If the reviewer flagged a direct unit as needing TDD, re-save the spec with that unit's approach changed to 'tdd', present the change to the user via interview, and proceed with a full RED/GREEN cycle.";
          }
          const reviewSteer = reviewVerdict.verdict === "approved"
            ? "\n\n✅ AUTO-TRANSITION: Review approved. You are now in APPROVED. Advance to MERGING (if user already approved) or FINAL_APPROVAL (for separate sign-off)."
            : ctx.piCoderMode === "light" && reviewVerdict.verdict === "needs_changes"
              ? `\n\n⚠️ AUTO-TRANSITION: Review needs changes${reviewVerdict.fixType === "non-functional" ? " (non-functional fix)" : ""}. You are now in NEEDS_CHANGES. Delegate implementor to apply the fix, then advance to REVIEWING; or advance to IMPLEMENTING for a full reimplementation.`
              : reviewVerdict.verdict === "needs_changes" && reviewVerdict.fixType === "non-functional"
                ? `\n\n⚠️ AUTO-TRANSITION: Review needs changes (non-functional fix). You are now in NEEDS_CHANGES. Delegate to pi-coder.implementor to apply the fix, then advance to REVIEWING with pi_coder_advance_fsm — the evidence gate is already satisfied.`
                : `\n\n⚠️ AUTO-TRANSITION: Review needs changes. You are now in NEEDS_CHANGES. Advance to ${nextState} for a full implementation cycle.${reclassificationGuidance}`;

          if (Array.isArray(rawContent) && rawContent.length >= 1 && rawContent[0]?.type === "text") {
            const textBlock = rawContent[0] as { type: "text"; text: string };
            (rawContent[0] as { type: "text"; text: string }).text = textBlock.text + reviewSteer;
          }
        } else {
          const diagnostics = extractDetailsDiagnostics(details);
          const receiptDetected = isIntercomReceipt(rawContent);

          ctx.logEvent("verdict_extraction_failed", {
            fsmState: ctx.stateMachine?.currentState ?? "N/A",
            mode: ctx.piCoderMode,
            hasFinalOutput: diagnostics.hasFinalOutput,
            textLength: diagnostics.textLength,
            firstHundredChars: diagnostics.firstHundredChars,
            intercomReceiptDetected: receiptDetected,
          });

          if (receiptDetected) {
            ctx.stateMachine!.setEvidence("review_completed");

            if (Array.isArray(rawContent) && rawContent.length >= 1 && rawContent[0]?.type === "text") {
              const textBlock = rawContent[0] as { type: "text"; text: string };
              textBlock.text +=
                "\n\n⚠️ DEGRADED RECOVERY: Verdict extraction failed because the intercom receipt path " +
                "stripped the reviewer's output (finalOutput is undefined). review_completed evidence has been " +
                "set because the reviewer DID run (the intercom receipt confirms delivery). " +
                "READ the reviewer's output above, determine the verdict yourself, and advance to " +
                "APPROVED or NEEDS_CHANGES with pi_coder_advance_fsm. This recovery is logged.";
            }
          } else {
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

      // Log FSM transition
      if (ctx.stateMachine!.currentState !== previousState) {
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
