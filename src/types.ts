/**
 * Shared type definitions for Pi Coder v1.
 *
 * All types that are imported by multiple modules live here
 * to prevent circular dependencies between specs.
 */

// ---------------------------------------------------------------------------
// Phase 2: FSM & State Types
// ---------------------------------------------------------------------------

/**
 * All valid FSM states for the Pi Coder TDD lifecycle.
 *
 * Transition flow:
 *   IDLE → SPEC_WORK → SPEC_APPROVED → GIT_CHECKPOINT →
 *   TDD_RED_WRITE → TDD_RED_VALIDATE →
 *   TDD_GREEN_WRITE → TDD_GREEN_VALIDATE → REVIEWING →
 *   (APPROVED → FINAL_APPROVAL → MERGING → COMPLETE) |
 *   (NEEDS_CHANGES → TDD_RED_WRITE) | BLOCKED
 */
export type FSMState =
  | "IDLE"
  | "SPEC_WORK"
  | "SPEC_APPROVED"
  | "GIT_CHECKPOINT"
  | "TDD_RED_WRITE"
  | "TDD_RED_VALIDATE"
  | "TDD_GREEN_WRITE"
  | "TDD_GREEN_VALIDATE"
  | "REVIEWING"
  | "APPROVED"
  | "NEEDS_CHANGES"
  | "FINAL_APPROVAL"
  | "MERGING"
  | "COMPLETE"
  | "BLOCKED";

/**
 * A single legal transition in the FSM.
 */
export interface FSMTransition {
  from: FSMState;
  to: FSMState;
  event: string;
}

/**
 * Per-state nudge threshold overrides.
 * Keys are FSMState values; values override the defaults for that state.
 */
export type NudgeStateConfig = Partial<Pick<NudgeDefaults, "turnsBeforeNudge">> & {
  /** Set to false to disable nudging for this state entirely */
  enabled?: boolean;
};

/**
 * Default nudge config values applied when a state isn't explicitly listed.
 */
export interface NudgeDefaults {
  /** Turns to wait before the first nudge fires */
  turnsBeforeNudge: number;
  /** Max escalation levels before handing off to the user */
  escalationLevels: number;
}

/**
 * Configuration for the per-state nudge system.
 * When the orchestrator spends too many turns in a state without
 * taking the expected action, the extension injects escalating reminders.
 */
export interface NudgeConfig {
  /** Master switch for the nudge system */
  enabled: boolean;
  /** Default thresholds applied to states not explicitly listed */
  defaults: NudgeDefaults;
  /** Per-state overrides. Keys are FSMState strings. */
  states: Partial<Record<FSMState, NudgeStateConfig>>;
}

/**
 * Configuration for structured interaction logging.
 * Logs are written as JSONL to `.pi-coder/logs/`.
 */
export interface LoggingConfig {
  /** Master switch for logging */
  enabled: boolean;
  /** Log verbosity: minimal (lifecycle+TDD), standard (+subagent+review+user), verbose (+nudge) */
  level: "minimal" | "standard" | "verbose";
  /** Maximum number of log files to retain (oldest are rotated away) */
  maxLogFiles: number;
}

/**
 * Root configuration stored in `.pi-coder/config.json`.
 */
export interface SubagentControlConfig {
  /** Enable subagent control monitoring via the event bus. Default: true.
   * When enabled, the extension listens for subagent:control-event and surfaces
   * active_long_running and needs_attention events as steer messages.
   * Thresholds are configured in pi-subagents' own config. */
  enabled: boolean;
}

export type PiCoderMode = "off" | "light" | "tdd";

export interface TestCommands {
  /** Command to run unit/integration tests (e.g. "npx vitest run", "npm test") */
  unit: string;
  /** Command to run E2E tests (e.g. "npx playwright test"). Optional */
  e2e?: string;
}

export interface PiCoderConfig {
  /** Command to run the project test suite. Legacy — prefer testCommands */
  testCommand: string;
  /** Structured test commands: unit and optional e2e */
  testCommands?: TestCommands;
  /** Maximum review-implement loops before the circuit breaker trips */
  maxLoops: number;
  /** Git merge strategy: "branch-and-merge" or "squash" */
  gitStrategy: "branch-and-merge" | "squash";
  /** Prefix for automatically created feature branches (e.g. "pi-coder/") */
  branchPrefix: string;
  /** Per-state nudge configuration */
  nudge: NudgeConfig;
  /** Interaction logging configuration */
  logging: LoggingConfig;
  /** Subagent control/monitoring configuration */
  subagentControl: SubagentControlConfig;
}

// ---------------------------------------------------------------------------
// Phase 3: Domain Value Types
// ---------------------------------------------------------------------------

/**
 * Result of executing the project test suite.
 * Used for TDD RED/GREEN phase validation.
 */
export interface TestRunResult {
  /** Process exit code (0 = all passed, non-zero = failures) */
  exitCode: number;
  /** Combined stdout + stderr, truncated to 5000 characters */
  output: string;
  /** Number of passing tests, if parseable. Null if parsing fails. */
  passed: number | null;
  /** Number of failing tests, if parseable. Null if parsing fails. */
  failed: number | null;
  /** Whether the test run exceeded the timeout */
  timedOut: boolean;
}

/**
 * Result of a structured Git operation.
 * All git tool invocations return this shape.
 */
export interface GitCheckpointResult {
  /** Whether the operation succeeded */
  success: boolean;
  /** Short-form commit SHA (when applicable) */
  ref?: string;
  /** Branch name (when applicable) */
  branch?: string;
  /** Human-readable summary of what happened */
  message?: string;
  /** Error description when success is false */
  error?: string;
}

/**
 * A single atomic unit of implementation within a spec.
 *
 * Each unit maps to one or more acceptance criteria and contains everything
 * the implementor needs for that piece and nothing else. The orchestrator
 * delegates one unit at a time through the RED/GREEN TDD cycle.
 *
 * Units with no `dependsOn` (or an empty array) can be implemented
 * independently. Units that depend on others must be implemented sequentially
 * after their dependencies are complete.
 */
export interface ImplementationUnit {
  /** Short descriptive name (e.g. "User signup", "Session persistence") */
  name: string;
  /** Indices into the spec's acceptanceCriteria array (0-based) */
  acceptanceCriteriaIndices: number[];
  /** Files that this unit specifically touches */
  keyFiles: string[];
  /** Names of other units that must be implemented before this one */
  dependsOn: string[];
}

/**
 * A spec file — the unit of work in the Pi Coder TDD lifecycle.
 * Written to `.pi-coder/specs/{id}.md` as Markdown with YAML frontmatter.
 */
export interface SpecFile {
  /** Unique slug identifier (e.g. "user-authentication") */
  id: string;
  /** Human-readable title */
  title: string;
  /** What must be true for the spec to be considered complete */
  acceptanceCriteria: string[];
  /** Restrictions on the implementation approach */
  constraints: string[];
  /** Files that the implementor should be aware of */
  keyFiles: string[];
  /** Pruned research context — only what's needed for implementation */
  prunedContext: string;
  /** Ordered implementation units for per-unit TDD delegation */
  implementationPlan: ImplementationUnit[];
  /** Current lifecycle status of the spec */
  status: FSMState;
}

/**
 * A knowledge entry — persisted project learnings.
 * The file IS the storage format (raw markdown).
 */
export interface KnowledgeEntry {
  /** Descriptive filename ending in .md (e.g. "supabase-auth-flow.md") */
  filename: string;
  /** Raw markdown content */
  content: string;
}

// ---------------------------------------------------------------------------
// State Persistence Types
// ---------------------------------------------------------------------------

/**
 * Evidence flags that tools set when they complete specific work.
 * The StateMachine checks these before allowing transitions.
 */
export type EvidenceFlag =
  | "spec_saved"
  | "spec_user_approved"
  | "test_run_this_state";

/**
 * Per-spec state persisted to `.pi-coder/specs/{id}/state.json`.
 * Lives alongside `spec.md` in the spec directory.
 */
export interface SpecState {
  /** Schema version */
  version: 1;
  /** Current FSM state */
  currentState: FSMState;
  /** Review loop count (increments on NEEDS_CHANGES → TDD_RED_WRITE) */
  loopCount: number;
  /** Pre-implementation git ref for rollback and diff */
  gitRef: string | null;
  /** Evidence flags set by tools during this spec's lifecycle */
  evidence: EvidenceFlag[];
  /** ISO timestamp of state creation */
  createdAt: string;
  /** ISO timestamp of last state update */
  updatedAt: string;
}

/**
 * Global state persisted to `.pi-coder/state.json`.
 * Slim pointer: which spec is active and whether orchestrator mode is on.
 */
export interface GlobalState {
  /** Schema version */
  version: 1;
  /** Current pi-coder mode: off, light (no FSM), or tdd (full lifecycle) */
  piCoderMode: PiCoderMode;
  /** @deprecated Use piCoderMode instead. Kept for migration. */
  piCoderActive?: boolean;
  /** ID of the currently active spec, or null if no spec is in progress */
  activeSpecId: string | null;
  /** ISO timestamp of last write */
  updatedAt: string;
}
