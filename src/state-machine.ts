/**
 * FSM State Machine for the Pi Coder TDD lifecycle.
 *
 * Drives the orchestrator through the full lifecycle:
 *   IDLE → SPEC_WORK → SPEC_APPROVED → GIT_CHECKPOINT →
 *   TDD_RED_WRITE → TDD_RED_VALIDATE →
 *   TDD_GREEN_WRITE → TDD_GREEN_VALIDATE → REVIEWING →
 *   (APPROVED → FINAL_APPROVAL → MERGING → COMPLETE) |
 *   (TDD_GREEN_VALIDATE → TDD_RED_WRITE via next_unit) |
 *   (NEEDS_CHANGES → TDD_RED_WRITE | REVIEWING) | BLOCKED
 *
 * Manual advances use pi_coder_advance_fsm (orchestrator judgment).
 * Auto-transitions happen on tool_result (deterministic outcomes).
 *
 * Transition guards enforce that required work has been done before
 * advancing (e.g., spec saved, user approved, tests run).
 */

import { BaseStateMachine, StateMachineDefinition } from "./base-state-machine.ts";
import type { FSMState, PiCoderConfig, EvidenceFlag } from "./types.ts";

// ---------------------------------------------------------------------------
// TDD State Machine Definition
// ---------------------------------------------------------------------------

const TDD_DEFINITION: StateMachineDefinition<FSMState> = {
  allStates: [
    "IDLE", "SPEC_WORK", "SPEC_APPROVED",
    "GIT_CHECKPOINT", "TDD_RED_WRITE", "TDD_RED_VALIDATE", "TDD_GREEN_WRITE",
    "TDD_GREEN_VALIDATE", "REVIEWING", "APPROVED", "NEEDS_CHANGES",
    "FINAL_APPROVAL", "MERGING", "COMPLETE", "BLOCKED",
  ],

  legalTransitions: [
    { from: "IDLE", to: "SPEC_WORK", event: "start_spec_work" },
    { from: "SPEC_WORK", to: "SPEC_APPROVED", event: "spec_approved" },
    { from: "SPEC_APPROVED", to: "GIT_CHECKPOINT", event: "checkpoint_start" },
    { from: "GIT_CHECKPOINT", to: "TDD_RED_WRITE", event: "checkpoint_complete" },
    { from: "TDD_RED_WRITE", to: "TDD_RED_VALIDATE", event: "tests_written" },
    { from: "TDD_RED_VALIDATE", to: "TDD_GREEN_WRITE", event: "tests_fail_as_expected" },
    { from: "TDD_RED_VALIDATE", to: "BLOCKED", event: "tests_pass_unexpectedly" },
    { from: "TDD_RED_VALIDATE", to: "TDD_GREEN_WRITE", event: "red_tautology_acknowledge" },
    { from: "TDD_GREEN_WRITE", to: "TDD_GREEN_VALIDATE", event: "code_written" },
    { from: "TDD_GREEN_VALIDATE", to: "REVIEWING", event: "tests_pass" },
    { from: "TDD_GREEN_VALIDATE", to: "TDD_GREEN_WRITE", event: "tests_still_fail" },
    { from: "TDD_GREEN_VALIDATE", to: "TDD_RED_WRITE", event: "next_unit" },
    { from: "REVIEWING", to: "APPROVED", event: "review_passed" },
    { from: "REVIEWING", to: "NEEDS_CHANGES", event: "review_needs_changes" },
    { from: "NEEDS_CHANGES", to: "TDD_RED_WRITE", event: "reimplement" },
    { from: "NEEDS_CHANGES", to: "REVIEWING", event: "non_functional_fix" },
    { from: "APPROVED", to: "FINAL_APPROVAL", event: "final_approval" },
    { from: "APPROVED", to: "MERGING", event: "merge_approved" },
    { from: "FINAL_APPROVAL", to: "MERGING", event: "merge_start" },
    { from: "MERGING", to: "COMPLETE", event: "merge_complete" },
  ],

  allowAnyToBlocked: false, // BLOCKED only via RED_VALIDATE

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
    {
      from: "TDD_RED_VALIDATE",
      to: "TDD_GREEN_WRITE",
      requiredEvidence: ["test_run_this_state"],
      errorMessage:
        "Cannot advance past RED validation without running tests. " +
        "Use pi_coder_run_tests to validate the RED phase first.",
    },
    {
      from: "TDD_GREEN_VALIDATE",
      to: "TDD_RED_WRITE",
      requiredEvidence: ["test_run_this_state"],
      errorMessage:
        "Cannot advance past GREEN validation without running tests. " +
        "Use pi_coder_run_tests to validate the GREEN phase first.",
    },
    {
      from: "TDD_GREEN_VALIDATE",
      to: "REVIEWING",
      requiredEvidence: ["test_run_this_state"],
      errorMessage:
        "Cannot advance to REVIEWING without running GREEN validation tests. " +
        "Use pi_coder_run_tests to validate the GREEN phase first.",
    },
    {
      from: "NEEDS_CHANGES",
      to: "REVIEWING",
      requiredEvidence: ["non_functional_classified"],
      errorMessage:
        "Cannot advance to REVIEWING for non-functional fix without reviewer classification. " +
        "The reviewer must classify the fix type in its verdict. If the fix is non-functional " +
        "(test cleanup, comments, naming, assertions), the reviewer should include " +
        "'Fix-Type: non-functional' in its output. If the fix is functional (production code " +
        "changes), advance to TDD_RED_WRITE for a full RED/GREEN cycle instead.",
    },
  ],

  actionRules: [
    {
      toolPattern: "pi_coder_run_tests",
      allowedStates: new Set(["TDD_RED_VALIDATE", "TDD_GREEN_VALIDATE"]),
    },
    {
      toolPattern: "subagent",
      agents: ["pi-coder.researcher"],
      allowedStates: new Set(["SPEC_WORK", "TDD_RED_WRITE", "TDD_GREEN_WRITE"]),
    },
    {
      toolPattern: "subagent",
      agents: ["pi-coder.implementor"],
      allowedStates: new Set(["TDD_RED_WRITE", "TDD_GREEN_WRITE", "NEEDS_CHANGES"]),
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

  alwaysAllowed: ["upsert_knowledge", "pi_coder_save_spec", "pi_coder_read_spec", "intercom", "ls", "find", "grep", "pi_coder_advance_fsm"],

  persistentEvidence: ["spec_saved", "spec_user_approved", "non_functional_classified"],

  nudgeExpectations: {
    IDLE: { shouldNudge: false, expectedAction: "", expectedTool: "" },
    SPEC_WORK: { shouldNudge: true, expectedAction: "Delegate to pi-coder.researcher or advance to SPEC_APPROVED", expectedTool: "subagent" },
    SPEC_APPROVED: { shouldNudge: false, expectedAction: "", expectedTool: "" },
    GIT_CHECKPOINT: { shouldNudge: true, expectedAction: "Create git checkpoint", expectedTool: "pi_coder_git" },
    TDD_RED_WRITE: { shouldNudge: true, expectedAction: "Delegate to pi-coder.implementor for RED phase", expectedTool: "subagent" },
    TDD_RED_VALIDATE: { shouldNudge: true, expectedAction: "Run tests (RED validation)", expectedTool: "pi_coder_run_tests" },
    TDD_GREEN_WRITE: { shouldNudge: true, expectedAction: "Delegate to pi-coder.implementor for GREEN phase", expectedTool: "subagent" },
    TDD_GREEN_VALIDATE: { shouldNudge: true, expectedAction: "Run tests (GREEN validation)", expectedTool: "pi_coder_run_tests" },
    REVIEWING: { shouldNudge: true, expectedAction: "Delegate to pi-coder.reviewer", expectedTool: "subagent" },
    APPROVED: { shouldNudge: false, expectedAction: "", expectedTool: "" },
    NEEDS_CHANGES: { shouldNudge: true, expectedAction: "Delegate implementor for non-functional fix, then advance to REVIEWING; or advance to TDD_RED_WRITE for functional fix", expectedTool: "subagent" },
    FINAL_APPROVAL: { shouldNudge: false, expectedAction: "", expectedTool: "" },
    MERGING: { shouldNudge: true, expectedAction: "Merge feature branch", expectedTool: "pi_coder_git" },
    COMPLETE: { shouldNudge: false, expectedAction: "", expectedTool: "" },
    BLOCKED: { shouldNudge: true, expectedAction: "Present recovery options to user", expectedTool: "" },
  },

};

// ---------------------------------------------------------------------------
// StateMachine Class
// ---------------------------------------------------------------------------

export interface StateMachineJSON {
  currentState: FSMState;
  loopCount: number;
  gitRef: string | null;
  currentUnitName: string | null;
  evidence: EvidenceFlag[];
}

export class StateMachine extends BaseStateMachine<FSMState> {
  static readonly DEFINITION: StateMachineDefinition<FSMState> = TDD_DEFINITION;

  constructor(config: PiCoderConfig) {
    super(TDD_DEFINITION, config);
  }

  static fromJSON(data: StateMachineJSON, config: PiCoderConfig): StateMachine {
    const sm = new StateMachine(config);
    sm.loadFromJSON(data as unknown as Record<string, unknown>);
    return sm;
  }
}
