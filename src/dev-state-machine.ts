/**
 * FSM State Machine for the Pi Coder Dev mode lifecycle.
 *
 * Drives the orchestrator through a per-unit test strategy lifecycle:
 *   IDLE → SPEC_WORK → SPEC_APPROVED → GIT_CHECKPOINT →
 *   [tdd unit]     → TDD_RED_WRITE → TDD_RED_VALIDATE → TDD_GREEN_WRITE → TDD_GREEN_VALIDATE →
 *                        [next tdd] → TDD_RED_WRITE | [next verify/skip] → IMPLEMENTING | [done] → REVIEWING
 *   [verify/skip]  → IMPLEMENTING →
 *                        [next tdd] → TDD_RED_WRITE | [next verify/skip] → IMPLEMENTING | [done] → REVIEWING
 *   [zero units]   → REVIEWING
 *   REVIEWING → (APPROVED → FINAL_APPROVAL → MERGING → COMPLETE) |
 *                (NEEDS_CHANGES → TDD_RED_WRITE | TDD_GREEN_WRITE | IMPLEMENTING | REVIEWING) | BLOCKED
 *
 * Every implementation unit is classified with a test strategy (tdd/verify/skip)
 * during planning. The FSM routes each unit through the appropriate path.
 *
 * Implements the same IStateMachine interface as StateMachine and
 * LightStateMachine so the extension can use either polymorphically.
 */

import { BaseStateMachine, StateMachineDefinition } from "./base-state-machine.ts";
import type { DevFSMState, PiCoderConfig, EvidenceFlag } from "./types.ts";

// ---------------------------------------------------------------------------
// Dev Mode State Machine Definition
// ---------------------------------------------------------------------------

const DEV_DEFINITION: StateMachineDefinition<DevFSMState> = {
  allStates: [
    "IDLE", "SPEC_WORK", "SPEC_APPROVED",
    "GIT_CHECKPOINT", "TDD_RED_WRITE", "TDD_RED_VALIDATE", "TDD_GREEN_WRITE",
    "TDD_GREEN_VALIDATE", "IMPLEMENTING", "REVIEWING", "APPROVED", "NEEDS_CHANGES",
    "FINAL_APPROVAL", "MERGING", "COMPLETE", "BLOCKED",
  ],

  legalTransitions: [
    // Spec phase — identical to TDD
    { from: "IDLE", to: "SPEC_WORK", event: "start_spec_work" },
    { from: "SPEC_WORK", to: "SPEC_APPROVED", event: "spec_approved" },
    { from: "SPEC_APPROVED", to: "GIT_CHECKPOINT", event: "checkpoint_start" },
    // Checkpoint — routes based on first unit's test strategy
    { from: "GIT_CHECKPOINT", to: "TDD_RED_WRITE", event: "checkpoint_complete" },
    { from: "GIT_CHECKPOINT", to: "IMPLEMENTING", event: "checkpoint_complete" },
    { from: "GIT_CHECKPOINT", to: "REVIEWING", event: "checkpoint_complete_no_units" },
    // TDD RED phase
    { from: "TDD_RED_WRITE", to: "TDD_RED_VALIDATE", event: "tests_written" },
    { from: "TDD_RED_VALIDATE", to: "TDD_GREEN_WRITE", event: "tests_fail_as_expected" },
    { from: "TDD_RED_VALIDATE", to: "BLOCKED", event: "tests_pass_unexpectedly" },
    { from: "TDD_RED_VALIDATE", to: "TDD_GREEN_WRITE", event: "red_tautology_acknowledge" },
    // TDD GREEN phase
    { from: "TDD_GREEN_WRITE", to: "TDD_GREEN_VALIDATE", event: "code_written" },
    { from: "TDD_GREEN_WRITE", to: "BLOCKED", event: "green_retry_limit" },
    // TDD GREEN_VALIDATE exits — routes based on next unit's test strategy
    { from: "TDD_GREEN_VALIDATE", to: "TDD_RED_WRITE", event: "next_unit_tdd" },
    { from: "TDD_GREEN_VALIDATE", to: "IMPLEMENTING", event: "next_unit_direct" },
    { from: "TDD_GREEN_VALIDATE", to: "REVIEWING", event: "all_units_complete" },
    // IMPLEMENTING exits — routes based on next unit's test strategy
    { from: "IMPLEMENTING", to: "TDD_RED_WRITE", event: "next_unit_tdd" },
    { from: "IMPLEMENTING", to: "IMPLEMENTING", event: "next_unit_direct" },
    { from: "IMPLEMENTING", to: "REVIEWING", event: "all_units_complete" },
    { from: "IMPLEMENTING", to: "BLOCKED", event: "verify_retry_limit" },
    // Review phase
    { from: "REVIEWING", to: "APPROVED", event: "review_passed" },
    { from: "REVIEWING", to: "NEEDS_CHANGES", event: "review_needs_changes" },
    // Fix paths — strategy-dependent routing
    { from: "NEEDS_CHANGES", to: "TDD_RED_WRITE", event: "reimplement" },
    { from: "NEEDS_CHANGES", to: "TDD_GREEN_WRITE", event: "needs_changes_functional_shortcut" },
    { from: "NEEDS_CHANGES", to: "IMPLEMENTING", event: "reimplement_direct" },
    { from: "NEEDS_CHANGES", to: "REVIEWING", event: "non_functional_fix" },
    // Merge phase — identical to TDD
    { from: "APPROVED", to: "FINAL_APPROVAL", event: "final_approval" },
    { from: "APPROVED", to: "MERGING", event: "merge_approved" },
    { from: "FINAL_APPROVAL", to: "MERGING", event: "merge_start" },
    { from: "MERGING", to: "COMPLETE", event: "merge_complete" },
  ],

  allowAnyToBlocked: false, // BLOCKED only via explicit transitions

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
      to: "IMPLEMENTING",
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
        "The reviewer must classify the fix type in its verdict. If the fix is non-functional, " +
        "include 'Fix-Type: non-functional' in its output. If the fix is functional, advance to " +
        "TDD_RED_WRITE, TDD_GREEN_WRITE, or IMPLEMENTING instead.",
    },
    {
      from: "NEEDS_CHANGES",
      to: "TDD_GREEN_WRITE",
      requiredEvidence: ["review_completed"],
      errorMessage:
        "Cannot advance to TDD_GREEN_WRITE from NEEDS_CHANGES without a completed review. " +
        "This path is for functional fixes with existing test coverage. " +
        "If the fix needs new tests, advance to TDD_RED_WRITE instead.",
    },
    {
      from: "REVIEWING",
      to: "APPROVED",
      requiredEvidence: ["review_completed"],
      errorMessage:
        "Cannot advance to APPROVED without completing a review. " +
        "Delegate to pi-coder.reviewer first. " +
        "The auto-transition handler sets this evidence when the reviewer returns a verdict. " +
        "If the auto-transition failed, re-delegate the reviewer instead of skipping review.",
    },
  ],

  actionRules: [
    {
      toolPattern: "subagent",
      agents: ["pi-coder.researcher"],
      allowedStates: new Set(["SPEC_WORK", "TDD_RED_WRITE", "TDD_GREEN_WRITE", "IMPLEMENTING"]),
    },
    {
      toolPattern: "subagent",
      agents: ["pi-coder.implementor"],
      allowedStates: new Set(["TDD_RED_WRITE", "TDD_GREEN_WRITE", "IMPLEMENTING", "NEEDS_CHANGES"]),
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
    "intercom", "ls", "find", "grep", "pi_coder_advance_fsm", "pi_coder_run_tests",
  ],

  persistentEvidence: ["spec_saved", "spec_user_approved", "non_functional_classified", "review_completed"],

  nudgeExpectations: {
    IDLE: { shouldNudge: false, expectedAction: "", expectedTool: "" },
    SPEC_WORK: { shouldNudge: true, expectedAction: "Delegate to pi-coder.researcher or advance to SPEC_APPROVED", expectedTool: "subagent" },
    SPEC_APPROVED: { shouldNudge: false, expectedAction: "", expectedTool: "" },
    GIT_CHECKPOINT: { shouldNudge: true, expectedAction: "Create git checkpoint", expectedTool: "pi_coder_git" },
    TDD_RED_WRITE: { shouldNudge: true, expectedAction: "Delegate to pi-coder.implementor for RED phase", expectedTool: "subagent" },
    TDD_RED_VALIDATE: { shouldNudge: true, expectedAction: "Run tests (RED validation)", expectedTool: "pi_coder_run_tests" },
    TDD_GREEN_WRITE: { shouldNudge: true, expectedAction: "Delegate to pi-coder.implementor for GREEN phase", expectedTool: "subagent" },
    TDD_GREEN_VALIDATE: { shouldNudge: true, expectedAction: "Run tests (GREEN validation)", expectedTool: "pi_coder_run_tests" },
    IMPLEMENTING: { shouldNudge: true, expectedAction: "Delegate to pi-coder.implementor", expectedTool: "subagent" },
    REVIEWING: { shouldNudge: true, expectedAction: "Delegate to pi-coder.reviewer", expectedTool: "subagent" },
    APPROVED: { shouldNudge: false, expectedAction: "", expectedTool: "" },
    NEEDS_CHANGES: { shouldNudge: true, expectedAction: "Delegate implementor to fix, then advance based on unit strategy", expectedTool: "subagent" },
    FINAL_APPROVAL: { shouldNudge: false, expectedAction: "", expectedTool: "" },
    MERGING: { shouldNudge: true, expectedAction: "Merge feature branch", expectedTool: "pi_coder_git" },
    COMPLETE: { shouldNudge: false, expectedAction: "", expectedTool: "" },
    BLOCKED: { shouldNudge: true, expectedAction: "Present recovery options to user", expectedTool: "" },
  },

};

// ---------------------------------------------------------------------------
// DevStateMachineJSON — persistence shape
// ---------------------------------------------------------------------------

export interface DevStateMachineJSON {
  currentState: DevFSMState;
  loopCount: number;
  gitRef: string | null;
  currentUnitName: string | null;
  evidence: EvidenceFlag[];
  retryCounters?: Record<string, number>;
}

// ---------------------------------------------------------------------------
// DevStateMachine Class
// ---------------------------------------------------------------------------

export class DevStateMachine extends BaseStateMachine<DevFSMState> {
  static readonly DEFINITION: StateMachineDefinition<DevFSMState> = DEV_DEFINITION;

  constructor(config: PiCoderConfig) {
    super(DEV_DEFINITION, config);
  }

  static fromJSON(data: DevStateMachineJSON, config: PiCoderConfig): DevStateMachine {
    const sm = new DevStateMachine(config);
    sm.loadFromJSON(data as unknown as Record<string, unknown>);
    return sm;
  }

  /**
   * Build a compact FSM diagram string for Dev mode.
   * Override the base class which only handles TDD and Light mode diagrams.
   */
  buildDiagram(): string {
    const lines: string[] = [];

    lines.push("FSM State Transitions (Dev Mode):");
    lines.push("| Current State | Valid Target | When |");
    lines.push("|---|---|---|");
    lines.push("| IDLE | SPEC_WORK | Start a new cycle |");
    lines.push("| SPEC_WORK | SPEC_APPROVED | Spec saved AND user approved |");
    lines.push("| SPEC_APPROVED | GIT_CHECKPOINT | User approved → checkpoint |");
    lines.push("| GIT_CHECKPOINT | TDD_RED_WRITE | Checkpoint complete (first unit is tdd) |");
    lines.push("| GIT_CHECKPOINT | IMPLEMENTING | Checkpoint complete (first unit is verify/skip) |");
    lines.push("| GIT_CHECKPOINT | REVIEWING | Checkpoint complete (no units) |");
    lines.push("| TDD_RED_WRITE | TDD_RED_VALIDATE | After implementor writes tests |");
    lines.push("| TDD_RED_VALIDATE | TDD_GREEN_WRITE | Tests fail as expected / RED tautology acknowledged |");
    lines.push("| TDD_RED_VALIDATE | BLOCKED | Tests pass unexpectedly (RED tautology — genuinely problematic) |");
    lines.push("| TDD_GREEN_WRITE | TDD_GREEN_VALIDATE | After implementor writes code |");
    lines.push("| TDD_GREEN_WRITE | BLOCKED | GREEN retry limit exceeded |");
    lines.push("| TDD_GREEN_VALIDATE | TDD_RED_WRITE | Next unit is tdd |");
    lines.push("| TDD_GREEN_VALIDATE | IMPLEMENTING | Next unit is verify/skip |");
    lines.push("| TDD_GREEN_VALIDATE | REVIEWING | All units complete |");
    lines.push("| IMPLEMENTING | TDD_RED_WRITE | Next unit is tdd |");
    lines.push("| IMPLEMENTING | IMPLEMENTING | Next unit is verify/skip |");
    lines.push("| IMPLEMENTING | REVIEWING | All units complete |");
    lines.push("| IMPLEMENTING | BLOCKED | Verify retry limit exceeded |");
    lines.push("| REVIEWING | APPROVED | Auto (review approved) |");
    lines.push("| REVIEWING | NEEDS_CHANGES | Auto (review needs changes) |");
    lines.push("| NEEDS_CHANGES | TDD_RED_WRITE | Functional fix needing new tests (tdd unit) |");
    lines.push("| NEEDS_CHANGES | TDD_GREEN_WRITE | Functional fix with existing test coverage |");
    lines.push("| NEEDS_CHANGES | IMPLEMENTING | Functional fix (verify/skip unit) |");
    lines.push("| NEEDS_CHANGES | REVIEWING | Non-functional fix only |");
    lines.push("| APPROVED | MERGING or FINAL_APPROVAL | User approved merge |");
    if (!this._config.mergeBranch) {
      lines.push("| MERGING | COMPLETE | Merge disabled — branch ready for PR/manual merge |");
    } else {
      lines.push(`| MERGING | COMPLETE | Merge feature branch (strategy: ${this._config.mergeBranch}) |`);
    }
    lines.push("| Any | IDLE | Abort cycle |");
    lines.push("");
    lines.push("⚠️ IMPORTANT: The table above is COMPLETE. No other transitions are valid.");
    lines.push("If you try an invalid transition, pi_coder_advance_fsm will reject it. Read the error message carefully — it tells you exactly which transition IS valid.");

    return lines.join("\n");
  }
}
