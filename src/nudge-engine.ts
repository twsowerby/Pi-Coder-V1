/**
 * Pi Coder V1 — Nudge Engine
 *
 * Tracks nudge state and builds nudge messages when the orchestrator
 * is idle too long in a given FSM state.
 *
 * Extracted from extensions/index.ts for testability.
 */

import type { PiCoderConfig, NudgeStateConfig, IStateMachine, PiCoderMode } from "./types.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Nudge tracking state. */
export interface NudgeState {
  fsmState: string;
  turnsSinceEntry: number;
  actionAttempted: boolean;
  lastNudgeLevel: number;
}

// ---------------------------------------------------------------------------
// Nudge Engine Class
// ---------------------------------------------------------------------------

export class NudgeEngine {
  state: NudgeState = {
    fsmState: "IDLE",
    turnsSinceEntry: 0,
    actionAttempted: false,
    lastNudgeLevel: 0,
  };

  /**
   * Get the nudge threshold for a given FSM state.
   * Returns undefined if nudging is disabled for the state.
   */
  getThreshold(config: PiCoderConfig, state: string): number | undefined {
    if (!config.nudge.enabled) return undefined;

    const stateConfig = (config.nudge.states as Record<string, NudgeStateConfig | undefined>)[state];
    if (stateConfig?.enabled === false) return undefined;

    return stateConfig?.turnsBeforeNudge ?? config.nudge.defaults.turnsBeforeNudge;
  }

  /**
   * Build a nudge message for the given level.
   */
  buildMessage(stateMachine: IStateMachine, piCoderMode: PiCoderMode, state: string, level: number): string {
    const expectation = stateMachine.canNudge();

    if (level === 1) {
      return `\n\n[NUDGE] Reminder: You are in state ${state}. The expected next action is: ${expectation.expectedAction}.`;
    }

    if (level === 2) {
      const lifecycle = piCoderMode === "light" ? "implementation" : piCoderMode === "dev" ? "dev" : "TDD";
      return `\n\n[NUDGE - URGENT] You must now proceed with: ${expectation.expectedAction}. This is a required step in the ${lifecycle} lifecycle. The FSM cannot advance until this action is taken.`;
    }

    // Level 3 is handled via ctx.ui.notify(), not appended to the prompt
    return "";
  }

  /**
   * Reset nudge state — called on FSM transition or action attempted.
   */
  reset(newState: string): void {
    this.state = {
      fsmState: newState,
      turnsSinceEntry: 0,
      actionAttempted: false,
      lastNudgeLevel: 0,
    };
  }
}
