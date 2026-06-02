/**
 * Pi Coder V1 — Token Tracker
 *
 * Tracks cumulative token usage across a spec lifecycle and per-FSM-state breakdown.
 * Extracted from extensions/index.ts for testability and separation of concerns.
 *
 * Two accumulation sources:
 * - Orchestrator tokens (main session turns)
 * - Subagent tokens (delegated work)
 *
 * Both contribute to lifecycle totals and per-phase buckets.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Token breakdown by source: orchestrator turns vs subagent delegation. */
export interface SourceTokens {
  /** Tokens from orchestrator (main session) turns */
  orchestrator: TokenBucket;
  /** Tokens from pi-coder subagent delegations */
  subagent: TokenBucket;
}

/** A flat token accumulation bucket. */
export interface TokenBucket {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
}

/** A per-FSM-state bucket with source breakdown. */
export interface PhaseBucket extends TokenBucket {
  source: SourceTokens;
}

/** Minimal usage input for accrual. */
export interface UsageInput {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns?: number;
}

// ---------------------------------------------------------------------------
// Token Tracker Class
// ---------------------------------------------------------------------------

export class TokenTracker {
  /** Cumulative token usage across a spec lifecycle. */
  lifecycleTokens: TokenBucket = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };

  /** Per-visit phase buckets — reset after each fsm_state_usage emission so re-entering
   *  the same state (e.g., TDD_RED_WRITE units 1-5) starts fresh. Used for
   *  real-time per-visit emission in emitStateUsageAndTransition(). */
  phaseTokens: Record<string, PhaseBucket> = {};

  /** Lifecycle-level accumulator — accumulates across ALL visits within a spec lifecycle.
   *  Only reset by resetLifecycleTracking(). Used by snapshotPhaseTokens() so
   *  lifecycle_end events include correct per-state totals even after per-visit buckets
   *  are zeroed. */
  lifecyclePhaseAccumulator: Record<string, PhaseBucket> = {};

  /** The FSM state that is currently accruing tokens. */
  currentAccrualState: string | null = null;

  /** Track lifecycle start time for wall clock duration. */
  lifecycleStartTime: number | null = null;

  /** Track session start time for session_summary duration. */
  sessionStartTime: number | null = null;

  /** Track turn count for the current session. */
  sessionTurnCount = 0;

  /** Track spec count attempted in this session. */
  sessionSpecCount = 0;

  /** Track spec approval interview start time for duration calculation. */
  specApprovalInterviewStartTime: number | null = null;

  /** Track unit start time for unit_end duration. */
  unitStartTime: number | null = null;

  /** Track unit start output tokens for unit_end token delta. */
  unitStartOutputTokens: number = 0;

  // Callback for logging — set by the owner (avoids hard dependency on Logger)
  private _onLog?: (type: string, payload: Record<string, unknown>) => void;

  constructor(onLog?: (type: string, payload: Record<string, unknown>) => void) {
    this._onLog = onLog;
  }

  // ---------------------------------------------------------------------------
  // Reset
  // ---------------------------------------------------------------------------

  /** Reset per-lifecycle tracking for a new spec. */
  resetLifecycleTracking(): void {
    this.lifecycleTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
    this.phaseTokens = {};
    this.lifecyclePhaseAccumulator = {};
    this.currentAccrualState = null;
  }

  /** Reset session-level counters. */
  resetSessionCounters(): void {
    this.sessionTurnCount = 0;
    this.sessionStartTime = null;
    this.sessionSpecCount = 0;
    this.specApprovalInterviewStartTime = null;
  }

  // ---------------------------------------------------------------------------
  // Phase Bucket Management
  // ---------------------------------------------------------------------------

  /** Ensure an accrual bucket exists for the given FSM state. */
  ensurePhaseBucket(state: string): void {
    if (!this.phaseTokens[state]) {
      this.phaseTokens[state] = TokenTracker.createEmptyBucket();
    }
  }

  /** Create a fresh zeroed-out phase bucket. */
  static createEmptyBucket(): PhaseBucket {
    return {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0,
      source: {
        orchestrator: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
        subagent: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
      },
    };
  }

  /** Set the current accrual state (called on FSM transitions and lifecycle start). */
  setAccrualState(state: string): void {
    this.currentAccrualState = state;
    this.ensurePhaseBucket(state);
  }

  // ---------------------------------------------------------------------------
  // Accrual
  // ---------------------------------------------------------------------------

  /** Accrue orchestrator (main session) token usage. */
  accrueOrchestrator(usage: UsageInput): void {
    this.lifecycleTokens.input += usage.input;
    this.lifecycleTokens.output += usage.output;
    this.lifecycleTokens.cacheRead += usage.cacheRead;
    this.lifecycleTokens.cacheWrite += usage.cacheWrite;
    this.lifecycleTokens.cost += usage.cost;
    this.lifecycleTokens.turns += 1;

    if (this.currentAccrualState) {
      this.ensurePhaseBucket(this.currentAccrualState);
      const bucket = this.phaseTokens[this.currentAccrualState];
      bucket.input += usage.input;
      bucket.output += usage.output;
      bucket.cacheRead += usage.cacheRead;
      bucket.cacheWrite += usage.cacheWrite;
      bucket.cost += usage.cost;
      bucket.turns += 1;
      bucket.source.orchestrator.input += usage.input;
      bucket.source.orchestrator.output += usage.output;
      bucket.source.orchestrator.cacheRead += usage.cacheRead;
      bucket.source.orchestrator.cacheWrite += usage.cacheWrite;
      bucket.source.orchestrator.cost += usage.cost;
      bucket.source.orchestrator.turns += 1;
    }
  }

  /** Accrue subagent token usage. */
  accrueSubagent(usage: UsageInput): void {
    this.lifecycleTokens.input += usage.input;
    this.lifecycleTokens.output += usage.output;
    this.lifecycleTokens.cacheRead += usage.cacheRead;
    this.lifecycleTokens.cacheWrite += usage.cacheWrite;
    this.lifecycleTokens.cost += usage.cost;
    this.lifecycleTokens.turns += usage.turns ?? 0;

    if (this.currentAccrualState) {
      this.ensurePhaseBucket(this.currentAccrualState);
      const bucket = this.phaseTokens[this.currentAccrualState];
      bucket.input += usage.input;
      bucket.output += usage.output;
      bucket.cacheRead += usage.cacheRead;
      bucket.cacheWrite += usage.cacheWrite;
      bucket.cost += usage.cost;
      bucket.turns += usage.turns ?? 0;
      bucket.source.subagent.input += usage.input;
      bucket.source.subagent.output += usage.output;
      bucket.source.subagent.cacheRead += usage.cacheRead;
      bucket.source.subagent.cacheWrite += usage.cacheWrite;
      bucket.source.subagent.cost += usage.cost;
      bucket.source.subagent.turns += usage.turns ?? 0;
    }
  }

  // ---------------------------------------------------------------------------
  // State Usage Emission
  // ---------------------------------------------------------------------------

  /**
   * Emit an fsm_state_usage event for the state being exited and set the new accrual state.
   * Call this on every FSM transition to capture per-state token breakdown.
   *
   * After emitting, the exiting state's bucket is reset so that re-entering the same
   * state later (e.g., TDD_RED_WRITE for a subsequent unit) starts with a fresh bucket
   * instead of continuing to accumulate on top of prior visits.
   */
  emitStateUsageAndTransition(fromState: string, toState: string, activeSpecId: string | null): void {
    // Emit usage for the state we're leaving
    const bucket = this.phaseTokens[fromState];
    if (bucket && (bucket.input > 0 || bucket.output > 0 || bucket.cacheRead > 0 || bucket.cacheWrite > 0 || bucket.cost > 0 || bucket.turns > 0)) {
      this._onLog?.("fsm_state_usage", {
        state: fromState,
        input: bucket.input,
        output: bucket.output,
        cacheRead: bucket.cacheRead,
        cacheWrite: bucket.cacheWrite,
        cost: bucket.cost,
        turns: bucket.turns,
        source: {
          orchestrator: { ...bucket.source.orchestrator },
          subagent: { ...bucket.source.subagent },
        },
        specId: activeSpecId,
        nextState: toState,
      });
      // Accumulate into the lifecycle accumulator (never reset between visits)
      this.accumulateLifecyclePhase(fromState, bucket);
      // Reset the per-visit bucket so re-entry starts fresh — prevents cumulative stacking
      // across multiple visits to the same state (e.g., TDD_RED_WRITE units 1-5)
      this.phaseTokens[fromState] = TokenTracker.createEmptyBucket();
    }
    // Start accruing into the new state
    this.setAccrualState(toState);
  }

  // ---------------------------------------------------------------------------
  // Snapshot (deep-copy for logging / state persistence)
  // ---------------------------------------------------------------------------

  /** Add a per-visit bucket's values into the lifecycle accumulator for its state. */
  private accumulateLifecyclePhase(state: string, bucket: PhaseBucket): void {
    if (!this.lifecyclePhaseAccumulator[state]) {
      this.lifecyclePhaseAccumulator[state] = TokenTracker.createEmptyBucket();
    }
    const acc = this.lifecyclePhaseAccumulator[state];
    acc.input += bucket.input;
    acc.output += bucket.output;
    acc.cacheRead += bucket.cacheRead;
    acc.cacheWrite += bucket.cacheWrite;
    acc.cost += bucket.cost;
    acc.turns += bucket.turns;
    acc.source.orchestrator.input += bucket.source.orchestrator.input;
    acc.source.orchestrator.output += bucket.source.orchestrator.output;
    acc.source.orchestrator.cacheRead += bucket.source.orchestrator.cacheRead;
    acc.source.orchestrator.cacheWrite += bucket.source.orchestrator.cacheWrite;
    acc.source.orchestrator.cost += bucket.source.orchestrator.cost;
    acc.source.orchestrator.turns += bucket.source.orchestrator.turns;
    acc.source.subagent.input += bucket.source.subagent.input;
    acc.source.subagent.output += bucket.source.subagent.output;
    acc.source.subagent.cacheRead += bucket.source.subagent.cacheRead;
    acc.source.subagent.cacheWrite += bucket.source.subagent.cacheWrite;
    acc.source.subagent.cost += bucket.source.subagent.cost;
    acc.source.subagent.turns += bucket.source.subagent.turns;
  }

  /** Deep-copy lifecyclePhaseAccumulator for logging lifecycle_end events.
   *  Uses the lifecycle accumulator (not the per-visit phaseTokens) so the snapshot
   *  contains correct totals even after per-visit buckets are reset on emission.
   *  This method is side-effect-free — it does not mutate the accumulator. */
  snapshotPhaseTokens(): Record<string, PhaseBucket> {
    // Merge any currently-active unemitted per-visit buckets into the snapshot
    // WITHOUT mutating the accumulator (idempotent: safe to call multiple times)
    const merged: Record<string, PhaseBucket> = {};
    for (const [state, acc] of Object.entries(this.lifecyclePhaseAccumulator)) {
      merged[state] = {
        ...acc,
        source: {
          orchestrator: { ...acc.source.orchestrator },
          subagent: { ...acc.source.subagent },
        },
      };
    }
    // Add any active per-visit buckets that haven't been emitted yet
    for (const [state, bucket] of Object.entries(this.phaseTokens)) {
      if (bucket.input > 0 || bucket.output > 0 || bucket.cacheRead > 0 || bucket.cacheWrite > 0 || bucket.cost > 0 || bucket.turns > 0) {
        if (!merged[state]) {
          merged[state] = TokenTracker.createEmptyBucket();
        }
        const m = merged[state];
        m.input += bucket.input;
        m.output += bucket.output;
        m.cacheRead += bucket.cacheRead;
        m.cacheWrite += bucket.cacheWrite;
        m.cost += bucket.cost;
        m.turns += bucket.turns;
        m.source.orchestrator.input += bucket.source.orchestrator.input;
        m.source.orchestrator.output += bucket.source.orchestrator.output;
        m.source.orchestrator.cacheRead += bucket.source.orchestrator.cacheRead;
        m.source.orchestrator.cacheWrite += bucket.source.orchestrator.cacheWrite;
        m.source.orchestrator.cost += bucket.source.orchestrator.cost;
        m.source.orchestrator.turns += bucket.source.orchestrator.turns;
        m.source.subagent.input += bucket.source.subagent.input;
        m.source.subagent.output += bucket.source.subagent.output;
        m.source.subagent.cacheRead += bucket.source.subagent.cacheRead;
        m.source.subagent.cacheWrite += bucket.source.subagent.cacheWrite;
        m.source.subagent.cost += bucket.source.subagent.cost;
        m.source.subagent.turns += bucket.source.subagent.turns;
      }
    }
    return merged;
  }

  /** Shallow-copy lifecycleTokens. */
  snapshotLifecycleTokens(): TokenBucket {
    return { ...this.lifecycleTokens };
  }
}
