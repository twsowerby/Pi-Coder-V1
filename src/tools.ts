/**
 * Pi Extension Tools for Pi Coder v1.
 *
 * Registers three custom pi tools that the orchestrator uses:
 * - pi_coder_git: Structured Git operations (checkout_branch, checkpoint, rollback, merge)
 * - pi_coder_run_tests: TDD test execution and RED/GREEN phase validation
 * - upsert_knowledge: Knowledge file persistence for project learnings
 *
 * Each tool is a thin wrapper that:
 * - Validates against the FSM state machine (where applicable)
 * - Delegates to the corresponding module (GitOperations, TddRunner, KnowledgeStore)
 * - Returns structured results for the extension's tool_result handler to consume
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { FSMState, PiCoderConfig } from "./types.ts";
import { StateMachine } from "./state-machine.ts";
import { GitOperations } from "./git.ts";
import { TddRunner } from "./tdd-runner.ts";
import { KnowledgeStore } from "./knowledge.ts";

/** Dependencies injected from the extension main. */
export interface StateMachineRef {
  get current(): StateMachine;
}

export interface ToolDependencies {
  stateMachine: StateMachineRef;
  gitOps: GitOperations;
  tddRunner: TddRunner;
  knowledgeStore: KnowledgeStore;
  config: PiCoderConfig;
}

// ---------------------------------------------------------------------------
// Tool Schemas
// ---------------------------------------------------------------------------

const GIT_ACTION_ENUM = StringEnum([
  "checkout_branch",
  "checkpoint",
  "rollback",
  "merge",
] as const);

const PI_CODER_GIT_PARAMS = Type.Object({
  action: GIT_ACTION_ENUM,
  branch: Type.Optional(Type.String({ description: "Branch name for checkout_branch" })),
  message: Type.Optional(Type.String({ description: "Commit message for checkpoint" })),
});

const PI_CODER_RUN_TESTS_PARAMS = Type.Object({
  command: Type.Optional(Type.String({ description: "Override test command from config" })),
  filter: Type.Optional(Type.String({ description: "Test file/pattern filter" })),
});

const UPSERT_KNOWLEDGE_PARAMS = Type.Object({
  filename: Type.String({ description: "Knowledge filename (e.g., supabase-auth-flow.md)" }),
  content: Type.String({ description: "Markdown content with project learnings" }),
});

const ADVANCE_FSM_PARAMS = Type.Object({
  targetState: Type.String({ description: "The FSM state to advance to (e.g., SPEC_WORK, SPEC_APPROVED, GIT_CHECKPOINT, IDLE)" }),
});

// ---------------------------------------------------------------------------
// Tool Registration
// ---------------------------------------------------------------------------

/**
 * Register all pi-coder tools with the pi extension API.
 *
 * This is the single entry point called from the extension main.
 * Each tool is registered with promptSnippet and promptGuidelines
 * for system prompt inclusion.
 */
export function registerTools(pi: ExtensionAPI, deps: ToolDependencies): void {
  const { stateMachine: smRef, gitOps, tddRunner, knowledgeStore, config } = deps;

  // -------------------------------------------------------------------------
  // pi_coder_git
  // -------------------------------------------------------------------------
  pi.registerTool({
    name: "pi_coder_git",
    label: "Pi Coder Git",
    description:
      "Structured Git operations for the TDD harness. " +
      "Actions: checkout_branch, checkpoint, rollback, merge. " +
      "Use this instead of raw git commands.",
    promptSnippet: "Structured Git operations: checkout_branch, checkpoint, rollback, merge",
    promptGuidelines: [
      "Use pi_coder_git for all Git operations — raw git commands are blocked.",
      "Call pi_coder_git checkpoint after spec approval and pi_coder_git merge after final approval.",
      "Use pi_coder_git rollback to revert to the pre-implementation checkpoint if the spec is aborted.",
    ],
    parameters: PI_CODER_GIT_PARAMS,

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const { action, branch, message } = params;

      // Validate FSM state
      if (!smRef.current.isActionAllowed("pi_coder_git")) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: pi_coder_git is not allowed in state ${smRef.current.currentState}. Allowed states: GIT_CHECKPOINT, MERGING, BLOCKED, IDLE.`,
            },
          ],
          details: {
            success: false,
            error: `Not allowed in state ${smRef.current.currentState}`,
            currentState: smRef.current.currentState,
          },
          isError: true,
        };
      }

      let result;

      switch (action) {
        case "checkout_branch": {
          if (!branch) {
            return {
              content: [{ type: "text" as const, text: "Error: branch parameter is required for checkout_branch action." }],
              details: { success: false, error: "branch parameter is required for checkout_branch" },
              isError: true,
            };
          }
          result = await gitOps.checkoutBranch(branch);
          break;
        }
        case "checkpoint": {
          const msg = message ?? `wip: checkpoint-${smRef.current.activeSpecId ?? "unknown"}`;
          result = await gitOps.checkpoint(msg);
          // Store the ref in the state machine
          if (result.success && result.ref) {
            smRef.current.setActiveSpec(
              smRef.current.activeSpecId ?? "unknown",
              result.ref,
            );
          }
          break;
        }
        case "rollback": {
          const ref = smRef.current.gitRef;
          if (!ref) {
            return {
              content: [{ type: "text" as const, text: "Error: No git ref stored for rollback. Was a checkpoint created?" }],
              details: { success: false, error: "No git ref stored for rollback" },
              isError: true,
            };
          }
          result = await gitOps.rollback(ref);
          // Rollback transitions FSM to IDLE
          if (result.success) {
            try {
              smRef.current.transition("IDLE");
            } catch {
              // Transition may fail if already IDLE — that's fine
            }
          }
          break;
        }
        case "merge": {
          const currentBranchResult = await gitOps.getCurrentBranch();
          const featureBranch = currentBranchResult.branch ?? `${config.branchPrefix}${smRef.current.activeSpecId ?? "unknown"}`;
          result = await gitOps.merge(featureBranch);
          break;
        }
        default: {
          return {
            content: [{ type: "text" as const, text: `Error: Unknown action: ${action}` }],
            details: { success: false, error: `Unknown action: ${action}` },
            isError: true,
          };
        }
      }

      const isError = !result.success;
      const text = result.success
        ? `${action} succeeded: ${result.message ?? `ref=${result.ref ?? "n/a"}, branch=${result.branch ?? "n/a"}`}`
        : `${action} failed: ${result.error ?? "unknown error"}`;

      return {
        content: [{ type: "text" as const, text }],
        details: result,
        isError,
      };
    },
  });

  // -------------------------------------------------------------------------
  // pi_coder_run_tests
  // -------------------------------------------------------------------------
  pi.registerTool({
    name: "pi_coder_run_tests",
    label: "Run Tests",
    description:
      "Execute the test suite for TDD validation. " +
      "Returns structured results including exit code, pass/fail counts, and validation verdict.",
    promptSnippet: "Run test suite and validate TDD RED/GREEN phase compliance",
    promptGuidelines: [
      "Use pi_coder_run_tests only during TDD_RED_VALIDATE or TDD_GREEN_VALIDATE states.",
      "RED phase: tests MUST fail — if they pass, tests may be tautological or the feature already exists.",
      "GREEN phase: tests MUST pass — if they fail, the implementation is incomplete.",
    ],
    parameters: PI_CODER_RUN_TESTS_PARAMS,

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      // Validate FSM state
      if (!smRef.current.isActionAllowed("pi_coder_run_tests")) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: pi_coder_run_tests is not allowed in state ${smRef.current.currentState}. Allowed states: TDD_RED_VALIDATE, TDD_GREEN_VALIDATE.`,
            },
          ],
          details: {
            valid: false,
            error: `Not allowed in state ${smRef.current.currentState}`,
            currentState: smRef.current.currentState,
          },
          isError: true,
        };
      }

      // Run the tests
      const testResult = await tddRunner.runTests(params.filter);

      // Validate based on current FSM state
      const currentState = smRef.current.currentState;
      const validation =
        currentState === "TDD_RED_VALIDATE"
          ? tddRunner.validateRedPhase(testResult)
          : tddRunner.validateGreenPhase(testResult);

      const phase = currentState === "TDD_RED_VALIDATE" ? "RED" : "GREEN";
      const text = validation.valid
        ? `${phase} validation: PASSED — ${phase === "RED" ? "tests fail as expected" : "tests pass as expected"}`
        : `${phase} validation: FAILED — ${validation.reason ?? "unknown"}`;

      return {
        content: [{ type: "text" as const, text }],
        details: {
          testResult,
          validation,
          phase,
          currentState,
          exitCode: testResult.exitCode,
          passed: testResult.passed,
          failed: testResult.failed,
          timedOut: testResult.timedOut,
        },
        isError: !validation.valid,
      };
    },
  });

  // -------------------------------------------------------------------------
  // upsert_knowledge
  // -------------------------------------------------------------------------
  pi.registerTool({
    name: "upsert_knowledge",
    label: "Upsert Knowledge",
    description:
      "Write or update a knowledge file in .pi-coder/knowledge/. " +
      "These files establish project-specific rules for future agents.",
    promptSnippet: "Persist project learnings to .pi-coder/knowledge/ for future TDD cycles",
    promptGuidelines: [
      "Use upsert_knowledge to record architectural conventions, gotchas, and API patterns that future implementors should know.",
      "Do NOT persist task-specific decisions, temporary workarounds, or one-off choices.",
      "Filenames must be descriptive (e.g., supabase-auth-flow.md) and end in .md.",
    ],
    parameters: UPSERT_KNOWLEDGE_PARAMS,

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      // No FSM state check — knowledge can be updated in any state
      try {
        const path = knowledgeStore.upsert(params.filename, params.content);
        return {
          content: [{ type: "text" as const, text: `Knowledge persisted: ${params.filename}` }],
          details: { success: true, path },
        };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Error: ${error}` }],
          details: { success: false, error },
          isError: true,
        };
      }
    },
  });

  // -------------------------------------------------------------------------
  // pi_coder_advance_fsm
  // -------------------------------------------------------------------------
  pi.registerTool({
    name: "pi_coder_advance_fsm",
    label: "Advance FSM State",
    description:
      "Advance the TDD lifecycle FSM to a new state. " +
      "Use this when the orchestrator has completed its work in the current state " +
      "and is ready to proceed. The transition must be legal per the FSM. " +
      "On error, the valid target states from the current state are listed.",
    promptSnippet: "Advance the FSM when orchestrator work is complete: IDLE→SPEC_WORK, SPEC_WORK→SPEC_APPROVED, etc.",
    promptGuidelines: [
      "Use pi_coder_advance_fsm when you have finished the current state's work and are ready to move on.",
      "IDLE → SPEC_WORK: Start a new TDD cycle. You can then delegate to the researcher.",
      "SPEC_WORK → SPEC_APPROVED: Present the spec to the user for approval via interview.",
      "SPEC_APPROVED → GIT_CHECKPOINT: The user approved the spec. Time to checkpoint.",
      "TDD_GREEN_VALIDATE → TDD_RED_WRITE: Current unit passed. Advance to the next implementation unit's RED phase.",
      "TDD_GREEN_VALIDATE → REVIEWING: All units complete. Proceed to review.",
      "Any state → IDLE: Abort the current cycle. Use this to restart or unwind.",
      "NEEDS_CHANGES → TDD_RED_WRITE: Review requires functional fixes. Start a new RED/GREEN cycle.",
      "NEEDS_CHANGES → REVIEWING: Review requires non-functional fixes only (test fixes, comments, refactoring). Skip the RED/GREEN cycle and go directly back to review.",
    ],
    parameters: ADVANCE_FSM_PARAMS,

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const { targetState } = params;
      const previousState = smRef.current.currentState;

      // Validate targetState is a valid FSMState
      const validStates: Set<string> = new Set<FSMState>([
        "IDLE", "SPEC_WORK", "SPEC_APPROVED", "GIT_CHECKPOINT",
        "TDD_RED_WRITE", "TDD_RED_VALIDATE", "TDD_GREEN_WRITE", "TDD_GREEN_VALIDATE",
        "REVIEWING", "APPROVED", "NEEDS_CHANGES", "FINAL_APPROVAL", "MERGING",
        "COMPLETE", "BLOCKED",
      ]);
      if (!validStates.has(targetState)) {
        return {
          content: [{
            type: "text" as const,
            text: `Invalid state "${targetState}". Valid states: ${[...validStates].join(", ")}`,
          }],
          details: { success: false, error: `Invalid state: ${targetState}`, previousState, validTargets: smRef.current.getValidTransitions() },
          isError: true,
        };
      }

      try {
        smRef.current.transition(targetState as FSMState);
        return {
          content: [{
            type: "text" as const,
            text: `FSM advanced: ${previousState} → ${targetState}`,
          }],
          details: {
            success: true,
            previousState,
            newState: targetState,
          },
        };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        const validTargets = smRef.current.getValidTransitions();
        return {
          content: [{
            type: "text" as const,
            text: `${error}\nValid transitions from ${previousState}: ${validTargets.join(", ")}`,
          }],
          details: {
            success: false,
            error,
            previousState,
            validTargets,
          },
          isError: true,
        };
      }
    },
  });
}
