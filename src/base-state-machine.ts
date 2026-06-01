/**
 * Base state machine for Pi Coder FSM implementations.
 *
 * Extracts shared logic from StateMachine (TDD) and LightStateMachine (Light)
 * into a single generic class parameterized by a StateMachineDefinition<S>.
 *
 * Subclasses provide only mode-specific data (states, transitions, guards,
 * action rules, etc.) — all behavior lives here.
 */

/**
 * Generate a one-line explanation for why an illegal transition is blocked.
 * Helps LLM orchestrators understand the TDD reasoning, reducing retry rates.
 */
function getTransitionExplanation(from: string, to: string, validTargets: string[]): string {
  // Specific cases that cause the most retries
  if (from === "TDD_RED_WRITE" && to === "TDD_GREEN_WRITE") {
    return "You cannot skip TDD_RED_VALIDATE — tests must be run and validated before proceeding to GREEN.";
  }
  if (from === "TDD_GREEN_WRITE" && to === "REVIEWING") {
    return "You cannot skip TDD_GREEN_VALIDATE — tests must pass before proceeding to REVIEWING.";
  }
  if (from === "TDD_RED_WRITE" && to === "REVIEWING") {
    return "You must go through TDD_RED_VALIDATE and TDD_GREEN_VALIDATE before REVIEWING.";
  }
  if (from === "SPEC_WORK" && to === "TDD_RED_WRITE") {
    return "The spec must be approved and checkpointed first — go through SPEC_APPROVED → GIT_CHECKPOINT.";
  }
  // Generic fallback
  if (validTargets.length === 1) {
    return `Only ${validTargets[0]} is valid from ${from}.`;
  }
  return "";
}

import type { PiCoderConfig, EvidenceFlag, IStateMachine, TransitionGuardError as ITransitionGuardError } from "./types.ts";

// ---------------------------------------------------------------------------
// Definition Types
// ---------------------------------------------------------------------------

/** A single legal transition in the FSM. */
export interface TransitionEntry<S extends string> {
  from: S;
  to: S;
  event?: string;
}

/** Evidence guard for a specific transition. */
export interface TransitionGuard<S extends string> {
  from: S;
  to: S;
  requiredEvidence: EvidenceFlag[];
  errorMessage: string;
}

/** Action rule: tool (±agents) → allowed states. */
export interface ActionRule<S extends string> {
  toolPattern: string;
  agents?: string[];
  allowedStates: Set<S>;
}

/** Nudge expectation for a single state. */
export interface NudgeExpectation {
  shouldNudge: boolean;
  expectedAction: string;
  expectedTool: string;
}

/**
 * Complete definition of a state machine's topology and rules.
 * Subclasses provide a concrete instance — the base class does the rest.
 */
export interface StateMachineDefinition<S extends string> {
  /** All legal states in this FSM. */
  allStates: S[];
  /** All legal transitions (from → to). */
  legalTransitions: TransitionEntry<S>[];
  /** Whether to include the *→BLOCKED wildcard. TDD mode does NOT; Light does. */
  allowAnyToBlocked: boolean;
  /** Evidence guards for specific transitions. */
  transitionGuards: TransitionGuard<S>[];
  /** Action rules: which tools are allowed in which states. */
  actionRules: ActionRule<S>[];
  /** Tool names allowed in any state. */
  alwaysAllowed: string[];
  /** Evidence flags that survive transitions (cleared only on IDLE reset). */
  persistentEvidence: EvidenceFlag[];
  /** Per-state nudge expectations. Missing states default to { shouldNudge: false }. */
  nudgeExpectations: Record<string, NudgeExpectation>;
}

// ---------------------------------------------------------------------------
// Lookup Structure Builders
// ---------------------------------------------------------------------------

type TransitionKey = string;

function buildTransitionSet<S extends string>(definition: StateMachineDefinition<S>): Set<TransitionKey> {
  const set = new Set<TransitionKey>();
  for (const t of definition.legalTransitions) {
    set.add(`${t.from}→${t.to}`);
  }

  // BLOCKED → any state (user intervention)
  for (const s of definition.allStates) {
    set.add(`BLOCKED→${s}`);
  }

  // Any state → IDLE (abort)
  for (const s of definition.allStates) {
    set.add(`${s}→IDLE`);
  }

  // Any state → BLOCKED (orchestrator override) — only when enabled
  if (definition.allowAnyToBlocked) {
    for (const s of definition.allStates) {
      set.add(`${s}→BLOCKED`);
    }
  }

  return set;
}

function buildTransitionMap<S extends string>(definition: StateMachineDefinition<S>): Map<S, S[]> {
  const map = new Map<S, S[]>();
  for (const t of definition.legalTransitions) {
    const existing = map.get(t.from) ?? [];
    if (!existing.includes(t.to)) existing.push(t.to);
    map.set(t.from, existing);
  }

  // BLOCKED can go to any state
  map.set("BLOCKED" as S, [...definition.allStates]);

  // Any state can go to IDLE (abort)
  for (const s of definition.allStates) {
    const existing = map.get(s) ?? [];
    if (!existing.includes("IDLE" as S)) existing.push("IDLE" as S);
    map.set(s, existing);
  }

  // Any state → BLOCKED when enabled
  if (definition.allowAnyToBlocked) {
    for (const s of definition.allStates) {
      const existing = map.get(s) ?? [];
      if (!existing.includes("BLOCKED" as S)) existing.push("BLOCKED" as S);
      map.set(s, existing);
    }
  }

  return map;
}

// ---------------------------------------------------------------------------
// BaseStateMachine Class
// ---------------------------------------------------------------------------

export class BaseStateMachine<S extends string> implements IStateMachine {
  private _currentState: S;
  private _loopCount: number = 0;
  private _gitRef: string | null = null;
  protected _currentUnitName: string | null = null;
  private _evidence: Set<EvidenceFlag> = new Set();
  private _retryCounters: Map<string, number> = new Map();
  protected readonly _config: PiCoderConfig;

  // Pre-computed lookup structures (instance-level, from definition)
  private readonly _transitionSet: Set<TransitionKey>;
  private readonly _transitionMap: Map<S, S[]>;
  private readonly _persistentEvidence: Set<EvidenceFlag>;
  private readonly _alwaysAllowed: Set<string>;

  constructor(
    protected readonly definition: StateMachineDefinition<S>,
    config: PiCoderConfig,
  ) {
    this._config = config;
    this._currentState = "IDLE" as S;

    this._transitionSet = buildTransitionSet(definition);
    this._transitionMap = buildTransitionMap(definition);
    this._persistentEvidence = new Set(definition.persistentEvidence);
    this._alwaysAllowed = new Set(definition.alwaysAllowed);
  }

  // --- Getters ---

  get currentState(): S {
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

  get currentUnitName(): string | null {
    return this._currentUnitName;
  }

  setCurrentUnitName(name: string | null): void {
    this._currentUnitName = name;
  }

  // --- Retry Counters ---

  /** Get the retry counter for a specific transition loop key (e.g., 'green_retries'). */
  getRetryCounter(key: string): number {
    return this._retryCounters.get(key) ?? 0;
  }

  /** Increment the retry counter for a specific transition loop key. */
  incrementRetryCounter(key: string): void {
    const current = this._retryCounters.get(key) ?? 0;
    this._retryCounters.set(key, current + 1);
  }

  /** Reset a specific retry counter. */
  resetRetryCounter(key: string): void {
    this._retryCounters.delete(key);
  }

  /** Reset all retry counters. */
  resetAllRetryCounters(): void {
    this._retryCounters.clear();
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
      if (!this._persistentEvidence.has(flag)) {
        this._evidence.delete(flag);
      }
    }
  }

  // --- Core Transition ---

  transition(to: string): ITransitionGuardError | void {
    const key = `${this._currentState}→${to}`;

    // 1. Check transition topology
    if (!this._transitionSet.has(key)) {
      const validTargets = this._transitionMap.get(this._currentState) ?? [];
      const explanation = getTransitionExplanation(this._currentState, to, validTargets);
      const explanationPart = explanation ? ` ${explanation}` : "";
      throw new Error(
        `Illegal transition: ${this._currentState} → ${to}.` +
        `${explanationPart} Valid transition${validTargets.length !== 1 ? "s" : ""} from ${this._currentState}: ${validTargets.join(", ")}`,
      );
    }

    // 2. Check transition guards (evidence requirements)
    for (const guard of this.definition.transitionGuards) {
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
    this._currentState = to as S;

    // Side effects
    this.applyTransitionSideEffects(previousState, this._currentState);

    // Clear transient evidence
    this.clearTransientEvidence();

    return undefined; // success
  }

  getValidTransitions(): string[] {
    const targets = this._transitionMap.get(this._currentState);
    return targets ?? [];
  }

  // --- Side Effects ---

  private applyTransitionSideEffects(from: S, to: S): void {
    // Increment loop counter on NEEDS_CHANGES exits (BLOCKED is a user override, not a review loop)
    if (from === "NEEDS_CHANGES" && to !== "IDLE" && to !== "BLOCKED") {
      this._loopCount++;
    }

    // Clear currentUnitName on NEEDS_CHANGES entry to prevent infinite loops.
    // When a direct unit is flagged for needing TDD, re-entry to TDD_RED_WRITE
    // should NOT auto-set evidence from the stale unit name. The orchestrator
    // must re-save the spec with approach: "tdd" before re-advancing.
    if (to === "NEEDS_CHANGES") {
      this._currentUnitName = null;
    }

    // Track GREEN retry loops (GREEN_VALIDATE → GREEN_WRITE auto-transition)
    if (from === "TDD_GREEN_VALIDATE" && to === "TDD_GREEN_WRITE") {
      this.incrementRetryCounter("green_retries");
    }
    // Reset GREEN retry counter on unit transitions
    if (from === "TDD_GREEN_VALIDATE" && (to === "REVIEWING" || to === "TDD_RED_WRITE")) {
      this.resetRetryCounter("green_retries");
    }

    // Reset loop counter, evidence, currentUnitName, and retry counters on IDLE entry
    if (to === "IDLE") {
      this._loopCount = 0;
      this._evidence.clear();
      this._currentUnitName = null;
      this._retryCounters.clear();
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
    this._currentState = "IDLE" as S;
    this._loopCount = 0;
    this._gitRef = null;
    this._currentUnitName = null;
    this._evidence.clear();
    this._retryCounters.clear();
  }

  // --- Action Guards ---

  isActionAllowed(toolName: string, targetAgent?: string): boolean {
    // Always-allowed tools
    if (this._alwaysAllowed.has(toolName)) {
      return true;
    }

    // Tool-specific rules
    for (const rule of this.definition.actionRules) {
      if (rule.toolPattern !== toolName) continue;

      // If the rule has specific agents, match on agent name
      if (rule.agents && rule.agents.length > 0) {
        if (!targetAgent) return false;
        if (!rule.agents.includes(targetAgent)) continue;
      }

      return rule.allowedStates.has(this._currentState);
    }

    // Note: "subagent" without a targetAgent returns false because all action rules
    // specify agents. The extension's tool_call handler handles subagent 
    // listing/status/interrupt separately before calling isActionAllowed(). 
    // Generic subagent calls (without a specific agent) are not expected in production.
    // Unknown tool — deny
    return false;
  }

  // --- Nudge ---

  canNudge(): NudgeExpectation {
    return this.definition.nudgeExpectations[this._currentState] ?? {
      shouldNudge: false,
      expectedAction: "",
      expectedTool: "",
    };
  }

  // --- FSM Diagram ---

  /**
   * Build a compact FSM diagram string from the state machine definition.
   * Used by the system prompt so the LLM can understand the state topology.
   *
   * The diagram format differs between TDD mode (allowAnyToBlocked=false)
   * and Light mode (allowAnyToBlocked=true):
   * - TDD: RED_VALIDATE has THREE exits clearly shown
   * - Light: Any→BLOCKED wildcard is EXPLICIT — key safety difference
   */
  buildDiagram(): string {
    const def = this.definition;
    const lines: string[] = [];

    if (def.allowAnyToBlocked) {
      // Light mode diagram
      lines.push("FSM State Transitions (Light Mode):");
      lines.push("| Current State | Valid Target | When |");
      lines.push("|---|---|---|");
      lines.push("| IDLE | SPEC_WORK | Start a new cycle |");
      lines.push("| SPEC_WORK | SPEC_APPROVED | Spec saved AND user approved |");
      lines.push("| SPEC_APPROVED | GIT_CHECKPOINT | User approved → checkpoint |");
      lines.push("| GIT_CHECKPOINT | IMPLEMENTING | Auto (checkpoint complete) |");
      lines.push("| IMPLEMENTING | REVIEWING | After implementor completes, advance to REVIEWING |");
      lines.push("| REVIEWING | APPROVED | Auto (review approved) |");
      lines.push("| REVIEWING | NEEDS_CHANGES | Auto (review needs changes) |");
      lines.push("| NEEDS_CHANGES | IMPLEMENTING | Functional or comprehensive fix |");
      lines.push("| NEEDS_CHANGES | REVIEWING | Non-functional fix only |");
      lines.push("| APPROVED | MERGING or FINAL_APPROVAL | User approved merge |");
      lines.push("| Any | BLOCKED | Emergency override |");
      lines.push("| Any | IDLE | Abort cycle |");
      lines.push("");
      lines.push("⚠️ IMPORTANT: The table above is COMPLETE. No other transitions are valid.");
    } else {
      // TDD mode diagram
      lines.push("FSM State Transitions (TDD Mode):");
      lines.push("| Current State | Valid Target | When |");
      lines.push("|---|---|---|");
      lines.push("| IDLE | SPEC_WORK | Start a new cycle |");
      lines.push("| SPEC_WORK | SPEC_APPROVED | Spec saved AND user approved |");
      lines.push("| SPEC_APPROVED | GIT_CHECKPOINT | User approved → checkpoint |");
      lines.push("| GIT_CHECKPOINT | TDD_RED_WRITE | Auto (checkpoint complete) |");
      lines.push("| TDD_RED_WRITE | TDD_RED_VALIDATE | After implementor writes tests |");
      lines.push("| TDD_RED_VALIDATE | TDD_GREEN_WRITE | Auto (tests fail as expected) |");
      lines.push("| TDD_RED_VALIDATE | TDD_GREEN_WRITE | RED tautology acknowledged |");
      lines.push("| TDD_RED_VALIDATE | BLOCKED | RED tautology — genuinely problematic |");
      lines.push("| TDD_GREEN_WRITE | TDD_GREEN_VALIDATE | After implementor writes code |");
      lines.push("| TDD_GREEN_VALIDATE | REVIEWING | Auto (all tests pass) |");
      lines.push("| TDD_GREEN_VALIDATE | TDD_GREEN_WRITE | Auto (tests still fail) |");
      lines.push("| TDD_GREEN_VALIDATE | TDD_RED_WRITE | Next implementation unit |");
      lines.push("| TDD_GREEN_WRITE | BLOCKED | GREEN retry limit exceeded |");
      lines.push("| REVIEWING | APPROVED | Auto (review approved) |");
      lines.push("| REVIEWING | NEEDS_CHANGES | Auto (review needs changes) |");
      lines.push("| NEEDS_CHANGES | TDD_RED_WRITE | Functional fix needing new tests |");
      lines.push("| NEEDS_CHANGES | TDD_GREEN_WRITE | Functional fix with existing test coverage |");
      lines.push("| NEEDS_CHANGES | REVIEWING | Non-functional fix only |");
      lines.push("| APPROVED | MERGING or FINAL_APPROVAL | User approved merge |");
      lines.push("| Any | IDLE | Abort cycle |");
      lines.push("");
      lines.push("⚠️ IMPORTANT: The table above is COMPLETE. No other transitions are valid.");
      lines.push("If you try an invalid transition, pi_coder_advance_fsm will reject it. Read the error message carefully — it tells you exactly which transition IS valid.");
    }

    return lines.join("\n");
  }

  // --- Persistence ---

  toJSON(): Record<string, unknown> {
    return {
      currentState: this._currentState,
      loopCount: this._loopCount,
      gitRef: this._gitRef,
      currentUnitName: this._currentUnitName,
      evidence: [...this._evidence],
      retryCounters: Object.fromEntries(this._retryCounters),
    };
  }

  /** Load state from a JSON object. For use by subclass fromJSON methods. */
  protected loadFromJSON(data: Record<string, unknown>): void {
    this._currentState = data.currentState as S;
    this._loopCount = (data.loopCount as number) ?? 0;
    this._gitRef = (data.gitRef as string | null) ?? null;
    this._currentUnitName = (data.currentUnitName as string | null) ?? null;
    this._evidence = new Set((data.evidence as EvidenceFlag[]) ?? []);
    // Restore retry counters
    const retryCounters = data.retryCounters as Record<string, number> | undefined;
    this._retryCounters = new Map(retryCounters ? Object.entries(retryCounters) : []);
  }
}
