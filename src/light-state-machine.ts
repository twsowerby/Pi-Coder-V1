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
 * Implements the same IStateMachine interface as StateMachine so
 * the extension can use either polymorphically.
 */

import type { LightFSMState, PiCoderConfig, EvidenceFlag, IStateMachine, TransitionGuardError as ITransitionGuardError } from "./types.ts";

// ---------------------------------------------------------------------------
// Transition Table
// ---------------------------------------------------------------------------

interface TransitionEntry {
  from: LightFSMState;
  to: LightFSMState;
  event: string;
}

/** All legal FSM transitions for Light mode. */
const LEGAL_TRANSITIONS: TransitionEntry[] = [
  // Spec phase — identical to TDD
  { from: "IDLE", to: "SPEC_WORK", event: "start_spec_work" },
  { from: "SPEC_WORK", to: "SPEC_APPROVED", event: "spec_approved" },
  { from: "SPEC_APPROVED", to: "GIT_CHECKPOINT", event: "checkpoint_start" },
  // Implementation — collapsed from 4 TDD states to 1
  { from: "GIT_CHECKPOINT", to: "IMPLEMENTING", event: "checkpoint_complete" },
  // Review — same structure as TDD
  { from: "IMPLEMENTING", to: "REVIEWING", event: "implementation_complete" },
  { from: "REVIEWING", to: "APPROVED", event: "review_approved" },
  { from: "REVIEWING", to: "NEEDS_CHANGES", event: "review_needs_changes" },
  // Fix paths — same structure as TDD but targeting IMPLEMENTING
  { from: "NEEDS_CHANGES", to: "IMPLEMENTING", event: "reimplement" },
  { from: "NEEDS_CHANGES", to: "REVIEWING", event: "non_functional_fix" },
  // Merge — identical to TDD
  { from: "APPROVED", to: "FINAL_APPROVAL", event: "final_approval" },
  { from: "FINAL_APPROVAL", to: "MERGING", event: "merge_start" },
  { from: "MERGING", to: "COMPLETE", event: "merge_complete" },
];

// ---------------------------------------------------------------------------
// Lookup Structure
// ---------------------------------------------------------------------------

function buildTransitionSet(): Set<string> {
  const set = new Set<string>();
  for (const t of LEGAL_TRANSITIONS) {
    set.add(`${t.from}→${t.to}`);
  }

  const allStates: LightFSMState[] = [
    "IDLE", "SPEC_WORK", "SPEC_APPROVED",
    "GIT_CHECKPOINT", "IMPLEMENTING", "REVIEWING",
    "APPROVED", "NEEDS_CHANGES", "FINAL_APPROVAL",
    "MERGING", "COMPLETE", "BLOCKED",
  ];

  // BLOCKED → any state (user intervention)
  for (const s of allStates) {
    set.add(`BLOCKED→${s}`);
  }

  // any state → IDLE (abort)
  for (const s of allStates) {
    set.add(`${s}→IDLE`);
  }

  // any state → BLOCKED (orchestrator can override to BLOCKED)
  // In light mode there's no natural BLOCKED transition (no RED tautology),
  // but the orchestrator can still advance to BLOCKED for unrecoverable errors.
  for (const s of allStates) {
    set.add(`${s}→BLOCKED`);
  }

  return set;
}

const TRANSITION_SET: Set<string> = buildTransitionSet();

function buildTransitionMap(): Map<LightFSMState, LightFSMState[]> {
  const map = new Map<LightFSMState, LightFSMState[]>();
  for (const t of LEGAL_TRANSITIONS) {
    const existing = map.get(t.from) ?? [];
    if (!existing.includes(t.to)) existing.push(t.to);
    map.set(t.from, existing);
  }
  // BLOCKED can go to any state
  const allStates: LightFSMState[] = [
    "IDLE", "SPEC_WORK", "SPEC_APPROVED",
    "GIT_CHECKPOINT", "IMPLEMENTING", "REVIEWING",
    "APPROVED", "NEEDS_CHANGES", "FINAL_APPROVAL",
    "MERGING", "COMPLETE", "BLOCKED",
  ];
  map.set("BLOCKED", [...allStates]);
  // Any state can go to IDLE (abort)
  for (const s of allStates) {
    const existing = map.get(s) ?? [];
    if (!existing.includes("IDLE")) existing.push("IDLE");
    // Also add BLOCKED as a valid target from any state
    if (!existing.includes("BLOCKED")) existing.push("BLOCKED");
    map.set(s, existing);
  }
  return map;
}

const TRANSITION_MAP: Map<LightFSMState, LightFSMState[]> = buildTransitionMap();

// ---------------------------------------------------------------------------
// Transition Guards — evidence required for specific transitions
// ---------------------------------------------------------------------------

interface TransitionGuard {
  from: LightFSMState;
  to: LightFSMState;
  requiredEvidence: EvidenceFlag[];
  errorMessage: string;
}

/**
 * Evidence required before specific transitions can proceed.
 *
 * Light mode has the same spec approval gate as TDD mode.
 * The non-functional fix gate is also the same.
 *
 * No test_run_this_state guards — tests are advisory in light mode.
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
    from: "NEEDS_CHANGES",
    to: "REVIEWING",
    requiredEvidence: ["non_functional_classified"],
    errorMessage:
      "Cannot advance to REVIEWING for non-functional fix without reviewer classification. " +
      "The reviewer must classify the fix type in its verdict. If the fix is non-functional " +
      "(test cleanup, comments, naming, assertions), the reviewer should include " +
      "'Fix-Type: non-functional' in its output. If the fix is functional (production code " +
      "changes), advance to IMPLEMENTING for a full implementation cycle instead.",
  },
];

// ---------------------------------------------------------------------------
// Action Guards - which tools are allowed in which states
// ---------------------------------------------------------------------------

const ACTION_RULES: Array<{
  tool: string;
  agents?: string[];
  allowedStates: Set<LightFSMState>;
}> = [
  {
    tool: "pi_coder_run_tests",
    // Tests available in ANY state — advisory, no gates
    allowedStates: new Set([
      "IDLE", "SPEC_WORK", "SPEC_APPROVED", "GIT_CHECKPOINT",
      "IMPLEMENTING", "REVIEWING", "APPROVED", "NEEDS_CHANGES",
      "FINAL_APPROVAL", "MERGING", "COMPLETE", "BLOCKED",
    ]),
  },
  {
    tool: "subagent",
    agents: ["pi-coder.researcher"],
    allowedStates: new Set(["SPEC_WORK", "IMPLEMENTING"]),
  },
  {
    tool: "subagent",
    agents: ["pi-coder.implementor"],
    allowedStates: new Set(["IMPLEMENTING", "NEEDS_CHANGES"]),
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
const ALWAYS_ALLOWED = new Set([
  "upsert_knowledge", "pi_coder_save_spec", "pi_coder_read_spec",
  "intercom", "ls", "find", "grep", "pi_coder_advance_fsm",
]);

// ---------------------------------------------------------------------------
// Nudge expectations
// ---------------------------------------------------------------------------

interface NudgeExpectation {
  shouldNudge: boolean;
  expectedAction: string;
  expectedTool: string;
}

const NUDGE_EXPECTATIONS: Record<LightFSMState, NudgeExpectation> = {
  IDLE: { shouldNudge: false, expectedAction: "", expectedTool: "" },
  SPEC_WORK: { shouldNudge: true, expectedAction: "Delegate to pi-coder.researcher or advance to SPEC_APPROVED", expectedTool: "subagent" },
  SPEC_APPROVED: { shouldNudge: false, expectedAction: "", expectedTool: "" },
  GIT_CHECKPOINT: { shouldNudge: true, expectedAction: "Create git checkpoint", expectedTool: "pi_coder_git" },
  IMPLEMENTING: { shouldNudge: true, expectedAction: "Delegate to pi-coder.implementor", expectedTool: "subagent" },
  REVIEWING: { shouldNudge: true, expectedAction: "Delegate to pi-coder.reviewer", expectedTool: "subagent" },
  APPROVED: { shouldNudge: false, expectedAction: "", expectedTool: "" },
  NEEDS_CHANGES: { shouldNudge: true, expectedAction: "Delegate implementor for non-functional fix, then advance to REVIEWING; or advance to IMPLEMENTING for functional fix", expectedTool: "subagent" },
  FINAL_APPROVAL: { shouldNudge: false, expectedAction: "", expectedTool: "" },
  MERGING: { shouldNudge: true, expectedAction: "Merge feature branch", expectedTool: "pi_coder_git" },
  COMPLETE: { shouldNudge: false, expectedAction: "", expectedTool: "" },
  BLOCKED: { shouldNudge: true, expectedAction: "Present recovery options to user", expectedTool: "" },
};

// ---------------------------------------------------------------------------
// Evidence flags that persist across state transitions
// ---------------------------------------------------------------------------

/** Evidence flags that survive transitions (cleared only on IDLE reset). */
const PERSISTENT_EVIDENCE: Set<EvidenceFlag> = new Set([
  "spec_saved", "spec_user_approved", "non_functional_classified",
]);

// ---------------------------------------------------------------------------
// LightStateMachineJSON — persistence shape
// ---------------------------------------------------------------------------

export interface LightStateMachineJSON {
  currentState: LightFSMState;
  loopCount: number;
  gitRef: string | null;
  evidence: EvidenceFlag[];
}

// ---------------------------------------------------------------------------
// LightStateMachine Class
// ---------------------------------------------------------------------------

export class LightStateMachine implements IStateMachine {
  private _currentState: LightFSMState = "IDLE";
  private _loopCount: number = 0;
  private _gitRef: string | null = null;
  private _evidence: Set<EvidenceFlag> = new Set();
  private readonly _config: PiCoderConfig;

  constructor(config: PiCoderConfig) {
    this._config = config;
  }

  // --- Getters ---

  get currentState(): LightFSMState {
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

  setEvidence(flag: EvidenceFlag): void {
    this._evidence.add(flag);
  }

  hasEvidence(flag: EvidenceFlag): boolean {
    return this._evidence.has(flag);
  }

  getEvidence(): EvidenceFlag[] {
    return [...this._evidence];
  }

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
    const key = `${this._currentState}→${to}`;

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
    this._currentState = to as LightFSMState;

    // Side effects
    this.applyTransitionSideEffects(previousState, this._currentState);

    // Clear transient evidence
    this.clearTransientEvidence();

    return undefined; // success
  }

  getValidTransitions(): string[] {
    return TRANSITION_MAP.get(this._currentState) ?? [];
  }

  // --- Side Effects ---

  private applyTransitionSideEffects(from: LightFSMState, to: LightFSMState): void {
    // Increment loop counter on NEEDS_CHANGES exits
    // Both functional (→ IMPLEMENTING) and non-functional (→ REVIEWING) fix
    // cycles count toward the circuit breaker — any infinite loop is a problem
    if (from === "NEEDS_CHANGES" && (to === "IMPLEMENTING" || to === "REVIEWING")) {
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
   * If the tool delegates to a specific agent, the agent name is validated too.
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
        if (!targetAgent) return false;
        if (!rule.agents.includes(targetAgent)) continue;
      }

      return rule.allowedStates.has(this._currentState as LightFSMState);
    }

    // Default: subagent without a recognized agent — block unless in a state
    // where some subagent delegation is expected
    if (toolName === "subagent" && !targetAgent) {
      const subagentStates = new Set<LightFSMState>([
        "SPEC_WORK", "IMPLEMENTING", "REVIEWING",
      ]);
      return subagentStates.has(this._currentState);
    }

    // Unknown tool — deny
    return false;
  }

  // --- Nudge ---

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

  static fromJSON(data: LightStateMachineJSON, config: PiCoderConfig): LightStateMachine {
    const sm = new LightStateMachine(config);
    sm._currentState = data.currentState;
    sm._loopCount = data.loopCount;
    sm._gitRef = data.gitRef;
    sm._evidence = new Set(data.evidence ?? []);
    return sm;
  }
}
