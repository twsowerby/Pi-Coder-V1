/**
 * Pi Coder V1 — Tool Call Handler
 *
 * Extracted from extensions/index.ts (Phase 4, Step 4.8).
 * Intercepts pi's tool_call to validate against FSM state,
 * block disallowed tools, and track subagent delegation.
 */

import { MODE_TOOL_SETS } from "../../extensions/constants.ts";
import { summarizeToolInput } from "../tools.ts";
import { extractSubagentTarget } from "../review-extraction.ts";
import { notify } from "../notification-manager.ts";
import type { HandlerContext } from "../handlers/types.ts";

/** Register the tool_call event handler. */
export function registerToolCallHandler(ctx: HandlerContext): void {
  ctx.pi.on("tool_call", async (event) => {
    if (ctx.piCoderMode === "off") return;

    const { toolName, input } = event;

    // Desktop notification on spec approval interview
    if (ctx.stateMachine && toolName === "interview" && ctx.stateMachine.currentState === "SPEC_WORK") {
      notify(ctx.config, "spec_approval", "Pi Coder · 📋 Review", `Spec ${ctx.activeSpecId ?? "unknown"} ready for your approval`);
      ctx.tokenTracker.specApprovalInterviewStartTime = Date.now();
    }

    // Determine which tools are allowed based on current mode
    const allowedTools = MODE_TOOL_SETS[ctx.piCoderMode];

    // Default-deny: only mode-appropriate tools are allowed
    if (!allowedTools.includes(toolName)) {
      ctx.logEvent("tool_call_blocked", {
        toolName,
        mode: ctx.piCoderMode,
        fsmState: ctx.stateMachine?.currentState ?? "N/A",
        reason: "not_in_allowed_tools",
      });
      let guidance = `🛡️ "${toolName}" is not available to the orchestrator in ${ctx.piCoderMode} mode.`;
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

    // Block raw git commands via bash (safety net)
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
    if (ctx.piCoderMode === "tdd" || ctx.piCoderMode === "light") {
      if (toolName === "pi_coder_git") {
        if (!ctx.stateMachine!.isActionAllowed("pi_coder_git")) {
          const current = ctx.stateMachine!.currentState;
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

      if (targetAgent !== undefined) {
        // Only pi-coder subagents are allowed
        if (!targetAgent.startsWith("pi-coder.")) {
          ctx.logEvent("tool_call_blocked", {
            toolName,
            targetAgent,
            mode: ctx.piCoderMode,
            fsmState: ctx.stateMachine?.currentState ?? "N/A",
            reason: "non_pi_coder_agent",
          });
          return {
            block: true,
            reason: `🛡️ Delegation to "${targetAgent}" is blocked — only pi-coder subagents are allowed (researcher, implementor, reviewer). Built-in agents and other packages are excluded to maintain TDD discipline. Use pi-coder.researcher to investigate, pi-coder.implementor to write code, or pi-coder.reviewer to verify. Do not retry this exact call.`,
          };
        }

        // Block delegation to self
        if (targetAgent === "pi-coder.orchestrator") {
          ctx.logEvent("tool_call_blocked", {
            toolName,
            targetAgent,
            mode: ctx.piCoderMode,
            fsmState: ctx.stateMachine?.currentState ?? "N/A",
            reason: "self_delegation",
          });
          return {
            block: true,
            reason: "🛡️ The orchestrator cannot delegate to itself — you ARE the orchestrator. If you need something done, delegate to one of your subagents: pi-coder.researcher, pi-coder.implementor, or pi-coder.reviewer.",
          };
        }

        // Plan mode: only researcher is allowed
        if (ctx.piCoderMode === "plan" && targetAgent !== "pi-coder.researcher") {
          ctx.logEvent("tool_call_blocked", {
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
        if (ctx.piCoderMode === "tdd" || ctx.piCoderMode === "light") {
          if (!ctx.stateMachine!.isActionAllowed("subagent", targetAgent)) {
            const current = ctx.stateMachine!.currentState;
            let guidance = `🛡️ Cannot delegate to ${targetAgent} in ${current}.`;
            if (targetAgent === "pi-coder.researcher" && current === "IDLE") {
              guidance += ` Step 1: pi_coder_advance_fsm with targetState "SPEC_WORK". Step 2: delegate to pi-coder.researcher.`;
            } else if (targetAgent === "pi-coder.implementor" && current === "SPEC_WORK") {
              guidance += ` The spec must be saved and approved first. Step 1: pi_coder_save_spec. Step 2: interview for approval. Step 3: pi_coder_advance_fsm with targetState "SPEC_APPROVED". Step 4: pi_coder_git checkpoint. Then you can delegate the implementor.`;
            } else if (targetAgent === "pi-coder.implementor" && current === "SPEC_APPROVED") {
              const nextLabel = ctx.piCoderMode === "light" ? "IMPLEMENTING" : "TDD_RED_WRITE";
              guidance += ` Checkpoint first, then the FSM auto-advances to ${nextLabel}. Step 1: pi_coder_git with action "checkpoint". Step 2: delegate to pi-coder.implementor.`;
            } else if (targetAgent === "pi-coder.reviewer" && current !== "REVIEWING") {
              guidance += ` The reviewer runs in REVIEWING state. Complete the current implementation cycle first, then pi_coder_advance_fsm with targetState "REVIEWING".`;
            } else {
              const validTargets = ctx.stateMachine!.getValidTransitions();
              guidance += ` Valid advance targets from ${current}: ${validTargets.join(", ")}. Use pi_coder_advance_fsm to advance, then delegate.`;
            }
            guidance += ` Do not retry this exact call.`;
            ctx.logEvent("tool_call_blocked", {
              toolName,
              targetAgent,
              fsmState: current,
              reason: "not_allowed_in_state",
            });
            return { block: true, reason: guidance };
          }

          // NOTE: The implementor dispatch guard for NEEDS_CHANGES has been removed.
          // Previously, implementor could only be dispatched in NEEDS_CHANGES if
          // the reviewer classified the fix as non-functional (non_functional_classified
          // evidence). This blocked functional fixes from using a shortcut path.
          // The classification is now enforced at the FSM transition level:
          // NEEDS_CHANGES → REVIEWING requires non_functional_classified.
          // NEEDS_CHANGES → TDD_GREEN_WRITE requires review_completed.
          // NEEDS_CHANGES → TDD_RED_WRITE has no evidence gate.
        }

        // Disable pi-subagents control events for foreground runs
        (input as Record<string, unknown>).control = { enabled: false };

        // Track subagent timing
        ctx.subagentMonitor.startTime = Date.now();
        ctx.subagentMonitor.lastAgent = targetAgent;

        // Update UI to show subagent running
        ctx.subagentMonitor.running = true;

        // Capture task from tool_call input for the subagent widget
        const taskInput = typeof (input as Record<string, unknown>).task === "string"
          ? ((input as Record<string, unknown>).task as string)
          : "";

        // Populate subagentMonitor.activity immediately from tool_call data
        ctx.subagentMonitor.activity = {
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

        ctx.refreshUI();
        ctx.refreshSubagentWidget();

        // Start a timer to update the subagent widget periodically
        if (ctx.subagentMonitor.widgetTimer) clearInterval(ctx.subagentMonitor.widgetTimer);
        ctx.subagentMonitor.widgetTimer = setInterval(() => {
          if (ctx.subagentMonitor.running && ctx.subagentMonitor.activity) {
            ctx.refreshSubagentWidget();
          } else {
            if (ctx.subagentMonitor.widgetTimer) {
              clearInterval(ctx.subagentMonitor.widgetTimer);
              ctx.subagentMonitor.widgetTimer = null;
            }
          }
        }, 2000);

        // Log subagent delegation
        const taskStr = typeof (input as Record<string, unknown>).task === "string"
          ? ((input as Record<string, unknown>).task as string).slice(0, 200)
          : "";
        ctx.logEvent("subagent_start", {
          agent: targetAgent,
          taskSummary: taskStr,
          specId: ctx.activeSpecId,
          fsmState: ctx.stateMachine?.currentState ?? "N/A",
          mode: ctx.piCoderMode,
        });

        // Mark action as attempted (resets nudge urgency)
        ctx.nudgeEngine.state.actionAttempted = true;
      }
    }

    // Mark action attempted for pi_coder_run_tests and pi_coder_git too
    if (toolName === "pi_coder_run_tests" || toolName === "pi_coder_git") {
      ctx.nudgeEngine.state.actionAttempted = true;
    }

    // Log allowed tool call
    ctx.logEvent("tool_call", {
      toolName,
      fsmState: ctx.stateMachine?.currentState ?? "N/A",
      mode: ctx.piCoderMode,
      specId: ctx.activeSpecId ?? "none",
      inputSummary: summarizeToolInput(toolName, input),
    });

    // Tool passed validation — allow
    return undefined;
  });
}
