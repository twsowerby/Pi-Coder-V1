/**
 * FSM State Machine for the Pi Coder TDD lifecycle.
 *
 * Drives the orchestrator through the full lifecycle:
 *   IDLE → SPEC_WORK → SPEC_APPROVED → GIT_CHECKPOINT →
 *   TDD_RED_WRITE → TDD_RED_VALIDATE →
 *   TDD_GREEN_WRITE → TDD_GREEN_VALIDATE → REVIEWING →
 *   (APPROVED → FINAL_APPROVAL → MERGING → COMPLETE) |
 *   (NEEDS_CHANGES → TDD_RED_WRITE) | BLOCKED
 *
 * Manual advances use pi_coder_advance_fsm (orchestrator judgment).
 * Auto-transitions happen on tool_result (deterministic outcomes).
 */

import type { FSMState, PiCoderConfig } from "./types.ts";

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
  { from: "TDD_GREEN_WRITE", to: "TDD_GREEN_VALIDATE", event: "code_written" },
  { from: "TDD_GREEN_VALIDATE", to: "REVIEWING", event: "tests_pass" },
  { from: "TDD_GREEN_VALIDATE", to: "TDD_GREEN_WRITE", event: "tests_still_fail" },
  { from: "REVIEWING", to: "APPROVED", event: "review_approved" },
  { from: "REVIEWING", to: "NEEDS_CHANGES", event: "review_needs_changes" },
  { from: "NEEDS_CHANGES", to: "TDD_RED_WRITE", event: "reimplement" },
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

const TRANSITION_SET: Set<TransitionKey> = buildTransitionSet();

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
    allowedStates: new Set(["TDD_RED_WRITE", "TDD_GREEN_WRITE"]),
  },
  {
    tool: "subagent",
    agents: ["pi-coder.reviewer"],
    allowedStates: new Set(["REVIEWING"]),
  },
  {
    tool: "pi_coder_git",
    allowedStates: new Set(["GIT_CHECKPOINT", "MERGING", "BLOCKED", "IDLE"]),
  },
];

/** Tools allowed in any state. */
const ALWAYS_ALLOWED = new Set(["upsert_knowledge", "ls", "find", "grep", "pi_coder_advance_fsm"]);

// ---------------------------------------------------------------------------
// Nudge expectations
// ---------------------------------------------------------------------------

interface NudgeExpectation {
  shouldNudge: boolean;
  expectedAction: string;
  expectedTool: string;
}

const NUDE_EXPECTATIONS: Record<FSMState, NudgeExpectation> = {
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
  NEEDS_CHANGES: { shouldNudge: true, expectedAction: "Prepare revised brief and delegate to implementor", expectedTool: "subagent" },
  FINAL_APPROVAL: { shouldNudge: false, expectedAction: "", expectedTool: "" },
  MERGING: { shouldNudge: true, expectedAction: "Merge feature branch", expectedTool: "pi_coder_git" },
  COMPLETE: { shouldNudge: false, expectedAction: "", expectedTool: "" },
  BLOCKED: { shouldNudge: true, expectedAction: "Present recovery options to user", expectedTool: "" },
};

// ---------------------------------------------------------------------------
// StateMachine Class
// ---------------------------------------------------------------------------

export interface StateMachineJSON {
  currentState: FSMState;
  activeSpecId: string | null;
  loopCount: number;
  gitRef: string | null;
}

export class StateMachine {
  private _currentState: FSMState = "IDLE";
  private _activeSpecId: string | null = null;
  private _loopCount: number = 0;
  private _gitRef: string | null = null;
  private readonly _config: PiCoderConfig;

  constructor(config: PiCoderConfig) {
    this._config = config;
  }

  // --- Getters ---

  get currentState(): FSMState {
    return this._currentState;
  }

  get activeSpecId(): string | null {
    return this._activeSpecId;
  }

  get loopCount(): number {
    return this._loopCount;
  }

  get gitRef(): string | null {
    return this._gitRef;
  }

  // --- Core Transition ---

  /**
   * Transition to a new state. Validates the transition is legal.
   * Throws a descriptive error on illegal transitions.
   */
  transition(to: FSMState): void {
    const key: TransitionKey = `${this._currentState}→${to}`;

    if (!TRANSITION_SET.has(key)) {
      const validTargets = TRANSITION_MAP.get(this._currentState) ?? [];
      throw new Error(
        `Illegal transition: ${this._currentState} → ${to}. ` +
        `Valid transitions from ${this._currentState}: ${validTargets.join(", ")}`,
      );
    }

    const previousState = this._currentState;
    this._currentState = to;

    // Side effects
    this.applyTransitionSideEffects(previousState, to);
  }

  /**
   * Get the list of valid target states from the current state.
   * Used by pi_coder_advance_fsm to give clear error messages.
   */
  getValidTransitions(): FSMState[] {
    return TRANSITION_MAP.get(this._currentState) ?? [];
  }

  // --- Side Effects ---

  private applyTransitionSideEffects(from: FSMState, to: FSMState): void {
    // Increment loop counter on NEEDS_CHANGES → TDD_RED_WRITE
    if (from === "NEEDS_CHANGES" && to === "TDD_RED_WRITE") {
      this._loopCount++;
    }

    // Reset loop counter on IDLE entry
    if (to === "IDLE") {
      this._loopCount = 0;
    }
  }

  // --- Circuit Breaker ---

  circuitBreakerTripped(): boolean {
    return this._loopCount >= this._config.maxLoops;
  }

  // --- Spec & Git Tracking ---

  setActiveSpec(specId: string, gitRef?: string): void {
    this._activeSpecId = specId;
    if (gitRef !== undefined) {
      this._gitRef = gitRef;
    }
  }

  reset(): void {
    this._currentState = "IDLE";
    this._activeSpecId = null;
    this._loopCount = 0;
    this._gitRef = null;
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
    return NUDE_EXPECTATIONS[this._currentState];
  }

  // --- Persistence ---

  toJSON(): StateMachineJSON {
    return {
      currentState: this._currentState,
      activeSpecId: this._activeSpecId,
      loopCount: this._loopCount,
      gitRef: this._gitRef,
    };
  }

  static fromJSON(data: StateMachineJSON, config: PiCoderConfig): StateMachine {
    const sm = new StateMachine(config);
    sm._currentState = data.currentState;
    sm._activeSpecId = data.activeSpecId;
    sm._loopCount = data.loopCount;
    sm._gitRef = data.gitRef;
    return sm;
  }
}
