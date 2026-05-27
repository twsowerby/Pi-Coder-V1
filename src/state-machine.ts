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

import type { FSMState, PiCoderConfig, EvidenceFlag, IStateMachine, TransitionGuardError as ITransitionGuardError } from "./types.ts";

// ---------------------------------------------------------------------------
// Transition Table
// ---------------------------------------------------------------------------

interface TransitionEntry {
  from: FSMState;
  to: FSMState;
  event: string;
}

/** All legal FSM transitions. */
const LEGAL_TRANSITIONS: TransitionEntry[] = [
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
  { from: "REVIEWING", to: "APPROVED", event: "review_approved" },
  { from: "REVIEWING", to: "NEEDS_CHANGES", event: "review_needs_changes" },
  { from: "NEEDS_CHANGES", to: "TDD_RED_WRITE", event: "reimplement" },
  { from: "NEEDS_CHANGES", to: "REVIEWING", event: "non_functional_fix" },
  { from: "APPROVED", to: "FINAL_APPROVAL", event: "final_approval" },
  { from: "FINAL_APPROVAL", to: "MERGING", event: "merge_start" },
  { from: "MERGING", to: "COMPLETE", event: "merge_complete" },
];

// ---------------------------------------------------------------------------
// Lookup Structure
// ---------------------------------------------------------------------------

/**
 * Build a Set of "from→to" keys for O(1) lookup.
 * Also includes special wildcard transitions: BLOCKED→* and *→IDLE.
 */
type TransitionKey = `${FSMState}→${FSMState}`;

function buildTransitionSet(): Set<TransitionKey> {
  const set = new Set<TransitionKey>();
  for (const t of LEGAL_TRANSITIONS) {
    set.add(`${t.from}→${t.to}`);
  }

  const allStates: FSMState[] = [
    "IDLE", "SPEC_WORK", "SPEC_APPROVED",
    "GIT_CHECKPOINT", "TDD_RED_WRITE", "TDD_RED_VALIDATE", "TDD_GREEN_WRITE",
    "TDD_GREEN_VALIDATE", "REVIEWING", "APPROVED", "NEEDS_CHANGES",
    "FINAL_APPROVAL", "MERGING", "COMPLETE", "BLOCKED",
  ];

  // BLOCKED → any state (user intervention)
  for (const s of allStates) {
    set.add(`BLOCKED→${s}`);
  }

  // any state → IDLE (abort)
  for (const s of allStates) {
    set.add(`${s}→IDLE`);
  }

  return set;
}

const TRANSITION_SET: Set<string> = buildTransitionSet() as Set<string>;

/**
 * Build a map from each state to its valid target states.
 * Used for error messages in pi_coder_advance_fsm.
 */
function buildTransitionMap(): Map<FSMState, FSMState[]> {
  const map = new Map<FSMState, FSMState[]>();
  for (const t of LEGAL_TRANSITIONS) {
    const existing = map.get(t.from) ?? [];
    if (!existing.includes(t.to)) existing.push(t.to);
    map.set(t.from, existing);
  }
  // BLOCKED can go to any state
  const allStates: FSMState[] = [
    "IDLE", "SPEC_WORK", "SPEC_APPROVED",
    "GIT_CHECKPOINT", "TDD_RED_WRITE", "TDD_RED_VALIDATE", "TDD_GREEN_WRITE",
    "TDD_GREEN_VALIDATE", "REVIEWING", "APPROVED", "NEEDS_CHANGES",
    "FINAL_APPROVAL", "MERGING", "COMPLETE", "BLOCKED",
  ];
  map.set("BLOCKED", [...allStates]);
  // Any state can go to IDLE (abort) — but don't duplicate if already listed
  for (const s of allStates) {
    const existing = map.get(s) ?? [];
    if (!existing.includes("IDLE")) existing.push("IDLE");
    map.set(s, existing);
  }
  return map;
}

const TRANSITION_MAP: Map<FSMState, FSMState[]> = buildTransitionMap();

// ---------------------------------------------------------------------------
// Transition Guards — evidence required for specific transitions
// ---------------------------------------------------------------------------

interface TransitionGuard {
  from: FSMState;
  to: FSMState;
  requiredEvidence: EvidenceFlag[];
  errorMessage: string;
}

/**
 * Evidence required before specific transitions can proceed.
 *
 * This is the SINGLE source of truth for process invariants.
 * If a guard exists here, the FSM enforces it — prompts guide but don't guard.
 *
 * Invariants enforced:
 * - SPEC_WORK → SPEC_APPROVED: spec must be saved AND user-approved
 * - TDD validation exits: tests must have been run in the current state
 *
 * Transitions NOT listed here have no evidence requirements — they're
 * either manual (orchestrator judgment) or auto-transitions from
 * deterministic tool results.
 */
const TRANSITION_GUARDS: TransitionGuard[] = [
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
];

// ---------------------------------------------------------------------------
// Action Guards - which tools are allowed in which states
// ---------------------------------------------------------------------------

/** Map from (toolName, optional agentName) → allowed FSM states. */
const ACTION_RULES: Array<{
  tool: string;
  agents?: string[];
  allowedStates: Set<FSMState>;
}> = [
  {
    tool: "pi_coder_run_tests",
    allowedStates: new Set(["TDD_RED_VALIDATE", "TDD_GREEN_VALIDATE"]),
  },
  {
    tool: "subagent",
    agents: ["pi-coder.researcher"],
    allowedStates: new Set(["SPEC_WORK", "TDD_RED_WRITE", "TDD_GREEN_WRITE"]),
  },
  {
    tool: "subagent",
    agents: ["pi-coder.implementor"],
    allowedStates: new Set(["TDD_RED_WRITE", "TDD_GREEN_WRITE", "NEEDS_CHANGES"]),
  },
  {
    tool: "subagent",
    agents: ["pi-coder.reviewer"],
    allowedStates: new Set(["REVIEWING"]),
  },
  {
    tool: "pi_coder_git",
    allowedStates: new Set(["GIT_CHECKPOINT", "REVIEWING", "MERGING", "BLOCKED", "IDLE"]),
  },
];

/** Tools allowed in any state. */
const ALWAYS_ALLOWED = new Set(["upsert_knowledge", "pi_coder_save_spec", "pi_coder_read_spec", "intercom", "ls", "find", "grep", "pi_coder_advance_fsm"]);

// ---------------------------------------------------------------------------
// Nudge expectations
// ---------------------------------------------------------------------------

interface NudgeExpectation {
  shouldNudge: boolean;
  expectedAction: string;
  expectedTool: string;
}

const NUDGE_EXPECTATIONS: Record<FSMState, NudgeExpectation> = {
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
};

// ---------------------------------------------------------------------------
// Evidence flags that persist across state transitions
// ---------------------------------------------------------------------------

/** Evidence flags that survive transitions (cleared only on IDLE reset). */
const PERSISTENT_EVIDENCE: Set<EvidenceFlag> = new Set(["spec_saved", "spec_user_approved", "non_functional_classified"]);

// ---------------------------------------------------------------------------
// StateMachine Class
// ---------------------------------------------------------------------------

export interface StateMachineJSON {
  currentState: FSMState;
  loopCount: number;
  gitRef: string | null;
  evidence: EvidenceFlag[];
}

export class StateMachine implements IStateMachine {
  private _currentState: FSMState = "IDLE";
  private _loopCount: number = 0;
  private _gitRef: string | null = null;
  private _evidence: Set<EvidenceFlag> = new Set();
  private readonly _config: PiCoderConfig;

  constructor(config: PiCoderConfig) {
    this._config = config;
  }

  // --- Getters ---

  get currentState(): FSMState {
    return this._currentState;
  }

  get loopCount(): number {
    return this._loopCount;
  }

  set loopCount(value: number) {
    this._loopCount = value;
  }

  get gitRef(): string | null {
    return this._gitRef;
  }

  // --- Evidence Management ---

  /** Set an evidence flag. Tools call this when they complete work. */
  setEvidence(flag: EvidenceFlag): void {
    this._evidence.add(flag);
  }

  /** Check whether an evidence flag is set. */
  hasEvidence(flag: EvidenceFlag): boolean {
    return this._evidence.has(flag);
  }

  /** Get all current evidence flags. */
  getEvidence(): EvidenceFlag[] {
    return [...this._evidence];
  }

  /** Clear evidence flags that don't persist across state transitions. */
  private clearTransientEvidence(): void {
    for (const flag of this._evidence) {
      if (!PERSISTENT_EVIDENCE.has(flag)) {
        this._evidence.delete(flag);
      }
    }
  }

  // --- Core Transition ---

  /**
   * Transition to a new state. Validates the transition is legal
   * AND that all required evidence is present.
   *
   * Returns a TransitionGuardError if evidence is missing.
   * Throws on illegal transitions (topology violations).
   */
  transition(to: string): ITransitionGuardError | void {
    const key = `${this._currentState}→${to}` as string;

    // 1. Check transition topology
    if (!TRANSITION_SET.has(key)) {
      const validTargets = TRANSITION_MAP.get(this._currentState) ?? [];
      throw new Error(
        `Illegal transition: ${this._currentState} → ${to}. ` +
        `Valid transitions from ${this._currentState}: ${validTargets.join(", ")}`,
      );
    }

    // 2. Check transition guards (evidence requirements)
    for (const guard of TRANSITION_GUARDS) {
      if (guard.from === this._currentState && guard.to === to) {
        const missing = guard.requiredEvidence.filter(
          (flag) => !this._evidence.has(flag),
        );
        if (missing.length > 0) {
          return {
            from: this._currentState,
            to,
            missingEvidence: missing,
            message: guard.errorMessage,
          };
        }
      }
    }

    // 3. Apply transition
    const previousState = this._currentState;
    this._currentState = to as FSMState;

    // Side effects
    this.applyTransitionSideEffects(previousState, to as FSMState);

    // Clear transient evidence (e.g., test_run_this_state)
    this.clearTransientEvidence();

    return undefined; // success
  }

  /**
   * Get the list of valid target states from the current state.
   * Used by pi_coder_advance_fsm to give clear error messages.
   */
  getValidTransitions(): string[] {
    return TRANSITION_MAP.get(this._currentState) ?? [];
  }

  // --- Side Effects ---

  private applyTransitionSideEffects(from: FSMState, to: FSMState): void {
    // Increment loop counter on NEEDS_CHANGES exits
    // Both functional (→ TDD_RED_WRITE) and non-functional (→ REVIEWING) fix
    // cycles count toward the circuit breaker — any infinite loop is a problem
    if (from === "NEEDS_CHANGES" && (to === "TDD_RED_WRITE" || to === "REVIEWING")) {
      this._loopCount++;
    }

    // Reset loop counter and persistent evidence on IDLE entry
    if (to === "IDLE") {
      this._loopCount = 0;
      this._evidence.clear();
    }
  }

  // --- Circuit Breaker ---

  circuitBreakerTripped(): boolean {
    return this._loopCount >= this._config.maxLoops;
  }

  // --- Git Tracking ---

  /** Set the git ref independently (used after checkpoint). */
  setGitRef(ref: string): void {
    this._gitRef = ref;
  }

  reset(): void {
    this._currentState = "IDLE";
    this._loopCount = 0;
    this._gitRef = null;
    this._evidence.clear();
  }

  // --- Action Guards ---

  /**
   * Check whether a tool call is allowed in the current FSM state.
   * If the tool delegates to a specific agent (e.g., "subagent" with
   * "pi-coder.implementor"), the agent name is validated too.
   *
   * Pure read — does not modify state or counters.
   */
  isActionAllowed(toolName: string, targetAgent?: string): boolean {
    // Always-allowed tools
    if (ALWAYS_ALLOWED.has(toolName)) {
      return true;
    }

    // Tool-specific rules
    for (const rule of ACTION_RULES) {
      if (rule.tool !== toolName) continue;

      // If the rule has specific agents, match on agent name
      if (rule.agents && rule.agents.length > 0) {
        if (!targetAgent) return false; // Need agent specificity but none given
        if (!rule.agents.includes(targetAgent)) continue;
      }

      return rule.allowedStates.has(this._currentState);
    }

    // Default: subagent without a recognized agent — block unless in a state
    // where some subagent delegation is expected
    if (toolName === "subagent" && !targetAgent) {
      const subagentStates = new Set<FSMState>([
        "SPEC_WORK", "TDD_RED_WRITE", "TDD_GREEN_WRITE", "REVIEWING",
      ]);
      return subagentStates.has(this._currentState);
    }

    // Unknown tool — deny
    return false;
  }

  // --- Nudge ---

  /**
   * Return whether nudging should occur for the current state,
   * and what the expected action and tool are.
   *
   * Pure read — does not modify state or counters.
   */
  canNudge(): NudgeExpectation {
    return NUDGE_EXPECTATIONS[this._currentState];
  }

  // --- Persistence ---

  toJSON(): Record<string, unknown> {
    return {
      currentState: this._currentState,
      loopCount: this._loopCount,
      gitRef: this._gitRef,
      evidence: [...this._evidence],
    } as Record<string, unknown>;
  }

  static fromJSON(data: StateMachineJSON, config: PiCoderConfig): StateMachine {
    const sm = new StateMachine(config);
    sm._currentState = data.currentState;
    sm._loopCount = data.loopCount;
    sm._gitRef = data.gitRef;
    sm._evidence = new Set(data.evidence ?? []);
    return sm;
  }
}
