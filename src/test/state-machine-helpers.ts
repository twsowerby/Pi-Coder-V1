/**
 * Shared test helpers for StateMachine and LightStateMachine.
 *
 * Common patterns extracted from both test files to reduce duplication.
 */

import type { PiCoderConfig } from "../types.ts";

/** Default config for tests. */
export function makeConfig(overrides?: Partial<PiCoderConfig>): PiCoderConfig {
  return {
    testCommand: "npm test",
    maxLoops: 3,
    createBranch: true,
    mergeBranch: "merge",
    branchPrefix: "pi-coder/",
    interviewTimeout: 0,
    nudge: {
      enabled: true,
      defaults: { turnsBeforeNudge: 1, escalationLevels: 3 },
      states: {
        SPEC_WORK: { turnsBeforeNudge: 3 },
        BLOCKED: { turnsBeforeNudge: 2 },
        IDLE: { enabled: false },
        SPEC_APPROVED: { enabled: false },
        FINAL_APPROVAL: { enabled: false },
        COMPLETE: { enabled: false },
      },
    },
    logging: {
      enabled: false,
      level: "standard",
      maxLogFiles: 10,
    },
    subagentControl: {
      enabled: true,
    },
    notifications: {
      enabled: false,
    },
    ...overrides,
  };
}
