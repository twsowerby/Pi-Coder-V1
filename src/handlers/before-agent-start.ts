/**
 * Pi Coder V1 — Before Agent Start Handler
 *
 * Extracted from extensions/index.ts (Phase 4, Step 4.7).
 * Intercepts pi's before_agent_start to inject the FSM orchestrator prompt,
 * filter tools/skills, and handle the nudge system.
 */

import type { PiCoderMode } from "../types.ts";
import { MODE_TOOL_SETS } from "../../extensions/constants.ts";
import { buildOrchestratorPrompt, buildLightModePrompt, buildPlanModePrompt, buildDevModePrompt } from "../prompts/prompt-builders.ts";
import { formatSkillsForPrompt, type Skill } from "@earendil-works/pi-coding-agent";
import type { HandlerContext } from "../handlers/types.ts";

/** Register the before_agent_start event handler. */
export function registerBeforeAgentStartHandler(ctx: HandlerContext): void {
  ctx.pi.on("before_agent_start", async (event, cmdCtx) => {
    // Increment session turn counter — every agent turn counts
    ctx.tokenTracker.sessionTurnCount++;

    // When off or subagents not available, let pi run normally
    if (ctx.piCoderMode === "off" || !ctx.subagentsAvailable) return;

    const { systemPromptOptions } = event;

    // Determine which tools and prompt to use based on mode
    const modeTools = MODE_TOOL_SETS[ctx.piCoderMode];

    // Filter to mode-appropriate tools only
    const filteredSnippets: Record<string, string> = {};
    for (const name of modeTools) {
      if (systemPromptOptions.toolSnippets?.[name]) {
        filteredSnippets[name] = systemPromptOptions.toolSnippets[name];
      }
    }

    // Build the appropriate prompt based on mode
    let orchestratorPrompt: string;
    if (ctx.piCoderMode === "tdd") {
      orchestratorPrompt = buildOrchestratorPrompt(
        ctx.stateMachine!,
        filteredSnippets,
        ctx.config,
        ctx.activeSpecId,
      );
    } else if (ctx.piCoderMode === "dev") {
      orchestratorPrompt = buildDevModePrompt(ctx.stateMachine!, filteredSnippets, ctx.config, ctx.activeSpecId);
    } else if (ctx.piCoderMode === "light") {
      orchestratorPrompt = buildLightModePrompt(ctx.stateMachine!, filteredSnippets, ctx.config, ctx.activeSpecId);
    } else { // plan
      orchestratorPrompt = buildPlanModePrompt(filteredSnippets, ctx.config);
    }

    // Build the full system prompt manually
    let fullPrompt = orchestratorPrompt;

    // Prepend active mode indicator
    const modeIndicator: Record<PiCoderMode, string> = {
      plan: "[MODE: PLAN] Investigation and discussion only. Delegate to pi-coder.researcher. No specs, no git, no FSM.",
      light: "[MODE: LIGHT] FSM is active. Follow the lifecycle: spec → implement → review → merge. No TDD phases.",
      tdd: "[MODE: TDD] FSM state machine is active. Follow the TDD lifecycle: spec → RED/GREEN → review → merge.",
      dev: "[MODE: DEV] FSM is active with per-unit test strategy (tdd/verify/skip). Follow the FSM lifecycle.",
      off: "", // Never reached — off mode returns early
    };
    fullPrompt = modeIndicator[ctx.piCoderMode] + "\n\n" + fullPrompt;

    // Append any user-provided append system prompt
    if (systemPromptOptions.appendSystemPrompt) {
      fullPrompt += "\n\n" + systemPromptOptions.appendSystemPrompt;
    }

    // Append project context files
    const contextFiles = systemPromptOptions.contextFiles ?? [];
    if (contextFiles.length > 0) {
      fullPrompt += "\n\n<project_context>\n\n";
      fullPrompt += "Project-specific instructions and guidelines:\n\n";
      for (const { path: filePath, content } of contextFiles) {
        fullPrompt += `<project_instructions path="${filePath}">\n${content}\n</project_instructions>\n\n`;
      }
      fullPrompt += "</project_context>\n";
    }

    // Filter skills to mode-relevant ones only
    const allSkills = systemPromptOptions.skills ?? [];
    const filteredSkills = allSkills.filter(skill => {
      if (skill.name === 'pi-coder-core') return true;
      if (ctx.piCoderMode === 'tdd' && skill.name === 'pi-coder-tdd') return true;
      if (ctx.piCoderMode === 'dev' && skill.name === 'pi-coder-dev') return true;
      if (ctx.piCoderMode === 'light' && skill.name === 'pi-coder-light') return true;
      if (ctx.piCoderMode === 'plan' && skill.name === 'pi-coder-plan') return true;
      if (!skill.name.startsWith('pi-coder-')) return true;
      return false;
    });

    // Manually append skills
    if (filteredSkills.length > 0) {
      fullPrompt += formatSkillsForPrompt(filteredSkills as Skill[]);
    }

    // Append date and working directory
    const now = new Date();
    const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    fullPrompt += `\nCurrent date: ${date}`;
    fullPrompt += `\nCurrent working directory: ${systemPromptOptions.cwd?.replace(/\\/g, "/") ?? "."}`;

    // -------------------------------------------------------------------
    // Nudge System (TDD, Light, and Dev modes)
    // -------------------------------------------------------------------

    if (ctx.piCoderMode === "tdd" || ctx.piCoderMode === "light" || ctx.piCoderMode === "dev") {
      // Increment turn counter
      ctx.nudgeEngine.state.turnsSinceEntry++;

      // Check if nudging should fire
      const threshold = ctx.nudgeEngine.getThreshold(ctx.config, ctx.stateMachine!.currentState);
      const maxEscalation = ctx.config.nudge.defaults.escalationLevels;

      if (
        threshold !== undefined &&
        !ctx.nudgeEngine.state.actionAttempted &&
        ctx.nudgeEngine.state.turnsSinceEntry > threshold &&
        ctx.nudgeEngine.state.lastNudgeLevel < maxEscalation
      ) {
        ctx.nudgeEngine.state.lastNudgeLevel++;

        // Log nudge event
        ctx.logEvent("nudge_fired", {
          fsmState: ctx.stateMachine?.currentState ?? "N/A",
          level: ctx.nudgeEngine.state.lastNudgeLevel,
          expectedAction: ctx.stateMachine!.canNudge().expectedAction,
        });

        if (ctx.nudgeEngine.state.lastNudgeLevel < maxEscalation) {
          // Levels 1-2: append to system prompt
          const nudgeMsg = ctx.nudgeEngine.buildMessage(ctx.stateMachine!, ctx.piCoderMode,
            ctx.stateMachine!.currentState,
            ctx.nudgeEngine.state.lastNudgeLevel,
          );
          fullPrompt += nudgeMsg;
        } else {
          // Level 3: user-visible notification
          const expectation = ctx.stateMachine!.canNudge();

          ctx.logEvent("nudge_escalation", {
            fsmState: ctx.stateMachine?.currentState ?? "N/A",
            newLevel: ctx.nudgeEngine.state.lastNudgeLevel,
          });

          cmdCtx.ui.notify(
            `Pi Coder: Orchestrator has not progressed past state ${ctx.stateMachine!.currentState} after ${ctx.nudgeEngine.state.turnsSinceEntry} turns. Expected: ${expectation.expectedAction}. Would you like to intervene?`,
            "warning",
          );
        }
      }
    } // end TDD/Light/Dev-mode nudge

    // Log prompt size before returning
    ctx.logEvent("prompt_size", {
      promptChars: fullPrompt.length,
      skillCount: filteredSkills.length,
      skillNames: filteredSkills.map(s => s.name),
      toolCount: Object.keys(filteredSnippets).length,
      contextFileCount: contextFiles.length,
      contextFileChars: contextFiles.reduce((sum, f) => sum + f.content.length, 0),
      fsmState: ctx.stateMachine?.currentState ?? "N/A",
      mode: ctx.piCoderMode,
    });

    // Return the replaced system prompt
    return { systemPrompt: fullPrompt };
  });
}
