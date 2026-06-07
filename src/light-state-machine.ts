/**
 * FSM State Machine for the Pi Coder Light mode lifecycle.
 *
 * Drives the orchestrator through a simplified lifecycle (no TDD):
 *   IDLE → SPEC_WORK → SPEC_APPROVED → GIT_CHECKPOINT →
 *   IMPLEMENTING → REVIEWING →
 *   (APPROVED → FINAL_APPROVAL → MERGING → COMPLETE) |
 *   (NEEDS_CHANGES → IMPLEMENTING | REVIEWING) | BLOCKED
 *
 * The IMPLEMENTING state collapses the TDD RED/GREEN phases into a
 * single implementation step. There are no test-run gates — tests
 * are advisory, not mandatory.
 *
 * Implements the same IStateMachine interface as DevStateMachine so
 * the extension can use either polymorphically.
 */

import { BaseStateMachine, StateMachineDefinition } from "./base-state-machine.ts";
import type { LightFSMState, PiCoderConfig, EvidenceFlag } from "./types.ts";

// ---------------------------------------------------------------------------
// Light Mode State Machine Definition
// ---------------------------------------------------------------------------

const LIGHT_DEFINITION: StateMachineDefinition<LightFSMState> = {
  allStates: [
    "IDLE", "SPEC_WORK", "SPEC_APPROVED",
    "GIT_CHECKPOINT", "IMPLEMENTING", "REVIEWING",
    "APPROVED", "NEEDS_CHANGES", "FINAL_APPROVAL",
    "MERGING", "COMPLETE", "BLOCKED",
  ],

  legalTransitions: [
    // Spec phase — identical to TDD
    { from: "IDLE", to: "SPEC_WORK", event: "start_spec_work" },
    { from: "SPEC_WORK", to: "SPEC_APPROVED", event: "spec_approved" },
    { from: "SPEC_APPROVED", to: "GIT_CHECKPOINT", event: "checkpoint_start" },
    // Implementation — collapsed from 4 TDD states to 1
    { from: "GIT_CHECKPOINT", to: "IMPLEMENTING", event: "checkpoint_complete" },
    // Review — same structure as TDD
    { from: "IMPLEMENTING", to: "REVIEWING", event: "implementation_complete" },
    { from: "REVIEWING", to: "APPROVED", event: "review_passed" },
    { from: "REVIEWING", to: "NEEDS_CHANGES", event: "review_needs_changes" },
    // Fix paths — same structure as TDD but targeting IMPLEMENTING
    { from: "NEEDS_CHANGES", to: "IMPLEMENTING", event: "reimplement" },
    { from: "NEEDS_CHANGES", to: "REVIEWING", event: "non_functional_fix" },
    // Merge — identical to TDD
    { from: "APPROVED", to: "FINAL_APPROVAL", event: "final_approval" },
    { from: "APPROVED", to: "MERGING", event: "merge_approved" },
    { from: "APPROVED", to: "NEEDS_CHANGES", event: "user_requested_changes" },
    { from: "FINAL_APPROVAL", to: "MERGING", event: "merge_start" },
    { from: "MERGING", to: "COMPLETE", event: "merge_complete" },
  ],

  allowAnyToBlocked: true, // In light mode there's no natural BLOCKED transition

  transitionGuards: [
    {
      from: "SPEC_WORK",
      to: "SPEC_APPROVED",
      requiredEvidence: ["spec_saved", "spec_user_approved"],
      errorMessage:
        "Cannot advance to SPEC_APPROVED. Required evidence missing:\n" +
        "  - spec_saved: Save the spec with pi_coder_save_spec\n" +
        "  - spec_user_approved: Get user approval via interview\n" +
        "Both are non-negotiable. Save the spec, then present it for approval.",
    },
    // IMPLEMENTING → REVIEWING has no evidence gate — no RED/GREEN cycle to bypass in Light mode.
    // NEEDS_CHANGES → REVIEWING requires no evidence — Light mode has no TDD cycle being skipped.
    {
      from: "REVIEWING",
      to: "APPROVED",
      requiredEvidence: ["review_completed"],
      errorMessage:
        "Cannot advance to APPROVED without completing a review. " +
        "Delegate to pi-coder.reviewer first — the review must actually happen. " +
        "The auto-transition handler sets this evidence when the reviewer returns a verdict. " +
        "If the auto-transition failed, re-delegate the reviewer instead of skipping review.",
    },
    {
      from: "APPROVED",
      to: "MERGING",
      requiredEvidence: ["user_approved_merge"],
      errorMessage:
        "Cannot advance to MERGING without user approval. " +
        "Call pi_coder_final_signoff first — the user must approve the implementation before merging.",
    },
  ],

  actionRules: [
    // pi_coder_run_tests removed from actionRules — it's in alwaysAllowed
    // (the tool description says "Available in any mode and state")
    {
      toolPattern: "subagent",
      agents: ["pi-coder.researcher"],
      allowedStates: new Set(["SPEC_WORK", "IMPLEMENTING"]),
    },
    {
      toolPattern: "subagent",
      agents: ["pi-coder.implementor"],
      allowedStates: new Set(["IMPLEMENTING", "NEEDS_CHANGES"]),
    },
    {
      toolPattern: "subagent",
      agents: ["pi-coder.reviewer"],
      allowedStates: new Set(["REVIEWING"]),
    },
    {
      toolPattern: "pi_coder_git",
      allowedStates: new Set(["GIT_CHECKPOINT", "REVIEWING", "MERGING", "BLOCKED", "IDLE"]),
    },
  ],

  alwaysAllowed: [
    "upsert_knowledge", "pi_coder_save_spec", "pi_coder_read_spec",
    "intercom", "ls", "find", "grep", "pi_coder_advance_fsm", "pi_coder_run_tests", "pi_coder_final_signoff",
  ],

  persistentEvidence: ["spec_saved", "spec_user_approved", "review_completed", "user_approved_merge"],

  nudgeExpectations: {
    IDLE: { shouldNudge: false, expectedAction: "", expectedTool: "" },
    SPEC_WORK: { shouldNudge: true, expectedAction: "Delegate to pi-coder.researcher or advance to SPEC_APPROVED", expectedTool: "subagent" },
    SPEC_APPROVED: { shouldNudge: false, expectedAction: "", expectedTool: "" },
    GIT_CHECKPOINT: { shouldNudge: true, expectedAction: "Create git checkpoint", expectedTool: "pi_coder_git" },
    IMPLEMENTING: { shouldNudge: true, expectedAction: "Delegate to pi-coder.implementor", expectedTool: "subagent" },
    REVIEWING: { shouldNudge: true, expectedAction: "Delegate to pi-coder.reviewer", expectedTool: "subagent" },
    APPROVED: { shouldNudge: true, expectedAction: "Present final sign-off to user", expectedTool: "pi_coder_final_signoff" },
    NEEDS_CHANGES: { shouldNudge: true, expectedAction: "Delegate implementor for fix, then advance to REVIEWING; or advance to IMPLEMENTING for full reimplementation", expectedTool: "subagent" },
    FINAL_APPROVAL: { shouldNudge: false, expectedAction: "", expectedTool: "" },
    MERGING: { shouldNudge: true, expectedAction: "Merge feature branch", expectedTool: "pi_coder_git" },
    COMPLETE: { shouldNudge: false, expectedAction: "", expectedTool: "" },
    BLOCKED: { shouldNudge: true, expectedAction: "Present recovery options to user", expectedTool: "" },
  },

};

// ---------------------------------------------------------------------------
// LightStateMachineJSON — persistence shape
// ---------------------------------------------------------------------------

export interface LightStateMachineJSON {
  currentState: LightFSMState;
  loopCount: number;
  gitRef: string | null;
  currentUnitName: string | null;
  evidence: EvidenceFlag[];
  retryCounters?: Record<string, number>;
}

// ---------------------------------------------------------------------------
// LightStateMachine Class
// ---------------------------------------------------------------------------

export class LightStateMachine extends BaseStateMachine<LightFSMState> {
  static readonly DEFINITION: StateMachineDefinition<LightFSMState> = LIGHT_DEFINITION;

  constructor(config: PiCoderConfig) {
    super(LIGHT_DEFINITION, config);
  }

  static fromJSON(data: LightStateMachineJSON, config: PiCoderConfig): LightStateMachine {
    const sm = new LightStateMachine(config);
    sm.loadFromJSON(data as unknown as Record<string, unknown>);
    return sm;
  }
}
