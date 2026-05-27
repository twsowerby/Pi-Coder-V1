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
import type { FSMState, PiCoderConfig, PiCoderMode, SpecFile, TestRunResult } from "./types.ts";
import { GitOperations } from "./git.ts";
import { TddRunner } from "./tdd-runner.ts";
import { KnowledgeStore } from "./knowledge.ts";
import { SpecManager, generateSpecId } from "./spec.ts";
import type { IStateMachine } from "./types.ts";

/** Dependencies injected from the extension main. */
export interface StateMachineRef {
  get current(): IStateMachine;
}

export interface ToolDependencies {
  stateMachine: StateMachineRef;
  /** Getter for the module-level active spec ID. */
  activeSpecId: { get current(): string | null };
  /** Setter for the module-level active spec ID. */
  setActiveSpecId: (id: string | null) => void;
  /** Getter for the current pi-coder mode. */
  piCoderMode: { get current(): PiCoderMode };
  gitOps: GitOperations;
  tddRunner: TddRunner;
  knowledgeStore: KnowledgeStore;
  specManager: SpecManager;
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
  "push",
] as const);

const PI_CODER_GIT_PARAMS = Type.Object({
  action: GIT_ACTION_ENUM,
  branch: Type.Optional(Type.String({ description: "Branch name for checkout_branch" })),
  message: Type.Optional(Type.String({ description: "Commit message for checkpoint" })),
});

const PI_CODER_RUN_TESTS_PARAMS = Type.Object({
  suite: Type.Optional(StringEnum(["unit", "e2e", "all"] as const, { description: "Which test suite to run. Defaults to 'unit'. Use 'e2e' for Playwright/Cypress, 'all' for both." })),
  command: Type.Optional(Type.String({ description: "Override test command from config" })),
  filter: Type.Optional(Type.String({ description: "Test file/pattern filter" })),
});

const UPSERT_KNOWLEDGE_PARAMS = Type.Object({
  filename: Type.String({ description: "Knowledge filename (e.g., supabase-auth-flow.md)" }),
  content: Type.String({ description: "Markdown content with project learnings" }),
});

const ADVANCE_FSM_PARAMS = Type.Object({
  targetState: Type.String({ description: "The FSM state to advance to (e.g., SPEC_WORK, SPEC_APPROVED, GIT_CHECKPOINT, IDLE)" }),
  request: Type.Optional(Type.String({ description: "The user's original request text. Required when advancing to SPEC_WORK — this is persisted to the spec directory for crash recovery and reference." })),
  fixType: Type.Optional(Type.Union([Type.Literal("functional"), Type.Literal("non-functional")], { description: "Classification of the fix from the reviewer's verdict. Required when advancing from NEEDS_CHANGES → REVIEWING (non-functional fix path). The reviewer classifies each fix as functional or non-functional in its output." })),
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
  const { stateMachine: smRef, activeSpecId: activeSpecIdRef, setActiveSpecId, gitOps, tddRunner, knowledgeStore, specManager, config } = deps;

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
      "If createBranch is enabled: create a feature branch with pi_coder_git checkout_branch, then checkpoint with pi_coder_git checkpoint.",
      "If mergeBranch is 'merge' or 'squash': call pi_coder_git merge after final approval.",
      "If mergeBranch is false: the cycle ends on the feature branch — tell the user to merge/PR manually.",
      "Use pi_coder_git rollback to revert to the pre-implementation checkpoint if the spec is aborted.",
    ],
    parameters: PI_CODER_GIT_PARAMS,

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const { action, branch, message } = params;

      // In light mode, pi_coder_git is always available — no FSM to enforce
      if (deps.piCoderMode.current === "tdd") {
        // Validate FSM state
        if (!smRef.current.isActionAllowed("pi_coder_git")) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: pi_coder_git is not allowed in state ${smRef.current.currentState}. Allowed in: GIT_CHECKPOINT, REVIEWING, MERGING, BLOCKED, IDLE.`,
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
      }

      let result;

      switch (action) {
        case "checkout_branch": {
          if (!config.createBranch) {
            return {
              content: [{ type: "text" as const, text: "Branch creation is disabled in this project's config (createBranch: false). Work will happen on the current branch. Use pi_coder_git checkpoint to save progress instead." }],
              details: { success: false, error: "Branch creation disabled (createBranch: false)" },
              isError: true,
            };
          }
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
          if (!activeSpecIdRef.current && deps.piCoderMode.current === "tdd") {
            return {
              content: [{ type: "text" as const, text: "Error: Cannot checkpoint without an active spec. Save the spec with pi_coder_save_spec first." }],
              details: { success: false, error: "No active spec ID — save spec before checkpointing" },
              isError: true,
            };
          }
          const msg = message ?? (activeSpecIdRef.current
            ? `wip: checkpoint-${activeSpecIdRef.current}`
            : `wip: checkpoint-${new Date().toISOString().replace(/[:.]/g, "-")}`)
          result = await gitOps.checkpoint(msg);
          // Store the ref in the state machine
          if (result.success && result.ref && activeSpecIdRef.current) {
            smRef.current.setGitRef(result.ref);
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
          if (!config.mergeBranch) {
            // mergeBranch is false — don't merge, just report completion
            const currentBranchResult = await gitOps.getCurrentBranch();
            const branchName = currentBranchResult.branch ?? `${config.branchPrefix}${activeSpecIdRef.current ?? "unknown"}`;
            return {
              content: [{ type: "text" as const, text: `Merge is disabled in this project's config (mergeBranch: false). The work is on branch "${branchName}". Merge or create a PR manually when ready.` }],
              details: { success: true, operation: "merge-skipped", branch: branchName },
            };
          }
          const currentBranchResult = await gitOps.getCurrentBranch();
          const featureBranch = currentBranchResult.branch ?? `${config.branchPrefix}${activeSpecIdRef.current ?? "unknown"}`;
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
      "Execute the project test suite. Available in any mode and state — running tests is always useful. " +
      "In TDD mode, results from TDD_RED_VALIDATE/TDD_GREEN_VALIDATE states trigger auto-transitions. " +
      "In other states, results are returned without FSM side effects.",
    promptSnippet: "Run test suite — unit, e2e, or both",
    promptGuidelines: [
      "Run unit tests to verify code correctness. Run e2e tests for integration verification.",
      "In TDD mode: RED phase expects tests to fail, GREEN phase expects them to pass.",
      "In Light mode: run tests freely to check progress at any time.",
    ],
    parameters: PI_CODER_RUN_TESTS_PARAMS,

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const suite = params.suite ?? "unit";

      // Resolve which test command(s) to run
      const commands: string[] = [];
      if (params.command) {
        // Explicit override
        commands.push(params.command);
      } else if (deps.config.testCommands) {
        // Structured testCommands from config
        if (suite === "unit" || suite === "all") commands.push(deps.config.testCommands.unit);
        if (suite === "e2e" && deps.config.testCommands.e2e) commands.push(deps.config.testCommands.e2e);
        if (suite === "all" && deps.config.testCommands.e2e) commands.push(deps.config.testCommands.e2e);
      } else {
        // Legacy testCommand
        commands.push(deps.config.testCommand);
      }

      if (commands.length === 0) {
        return {
          content: [{ type: "text" as const, text: `No test command configured for suite '${suite}'. Add a 'testCommands' entry to .pi-coder/config.json.` }],
          details: { valid: false, error: `No test command for suite '${suite}'`, suite },
          isError: true,
        };
      }

      // Run each command
      const results: Array<{ command: string; testResult: TestRunResult; validation?: { valid: boolean; reason?: string } }> = [];
      const currentState = smRef.current.currentState;
      const isTddValidation = currentState === "TDD_RED_VALIDATE" || currentState === "TDD_GREEN_VALIDATE";

      for (const cmd of commands) {
        // Temporarily override testCommand for TddRunner
        const savedTestCommand = deps.config.testCommand;
        deps.config.testCommand = cmd;
        const testResult = await tddRunner.runTests(params.filter);
        deps.config.testCommand = savedTestCommand;

        let validation: { valid: boolean; reason?: string } | undefined;
        if (isTddValidation) {
          validation = currentState === "TDD_RED_VALIDATE"
            ? tddRunner.validateRedPhase(testResult)
            : tddRunner.validateGreenPhase(testResult);
        }

        results.push({ command: cmd, testResult, validation });
      }

      // Build response text
      const lines: string[] = [];
      for (const r of results) {
        if (results.length > 1) lines.push(`--- ${r.command} ---`);
        if (r.validation) {
          const phase = currentState === "TDD_RED_VALIDATE" ? "RED" : "GREEN";
          lines.push(r.validation.valid
            ? `${phase} validation: PASSED — ${phase === "RED" ? "tests fail as expected" : "tests pass as expected"}`
            : `${phase} validation: FAILED — ${r.validation.reason ?? "unknown"}`);
        } else {
          const passed = r.testResult.passed;
          const failed = r.testResult.failed;
          if (passed !== null && failed !== null) {
            lines.push(r.testResult.exitCode === 0
              ? `Tests passed: ${passed} passed, ${failed} failed`
              : `Tests failed: ${passed} passed, ${failed} failed (exit code ${r.testResult.exitCode})`);
          } else {
            // Couldn't parse counts — include the raw output so the LLM can read it
            lines.push(r.testResult.exitCode === 0
              ? "Tests passed (exit code 0)"
              : `Tests failed (exit code ${r.testResult.exitCode})`);
          }
          // Always include test output — the LLM needs to see what failed
          if (r.testResult.output) {
            lines.push("");
            lines.push("```" );
            lines.push(r.testResult.output);
            lines.push("```");
          }
        }
      }
      const text = lines.join("\n");

      // For TDD validation states, include structured details for auto-transition handling
      const firstResult = results[0];
      const details: Record<string, unknown> = {
        suite,
        commands: commands,
        currentState,
        isTddValidation,
        exitCode: firstResult.testResult.exitCode,
        passed: firstResult.testResult.passed,
        failed: firstResult.testResult.failed,
        timedOut: firstResult.testResult.timedOut,
      };

      if (firstResult.validation) {
        details.validation = firstResult.validation;
        details.phase = currentState === "TDD_RED_VALIDATE" ? "RED" : "GREEN";
      }

      // Include the full test output from the first result
      if (firstResult.testResult.output) {
        details.testResult = firstResult.testResult;
      }

      return {
        content: [{ type: "text" as const, text }],
        details,
        isError: firstResult.validation ? !firstResult.validation.valid : (firstResult.testResult.exitCode !== 0),
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
  // pi_coder_save_spec
  // -------------------------------------------------------------------------
  pi.registerTool({
    name: "pi_coder_save_spec",
    label: "Save Spec",
    description:
      "Save a spec to .pi-coder/specs/{id}.md. Creates the file if it doesn't exist, updates it if it does. " +
      "The spec file persists the acceptance criteria, constraints, key files, implementation plan, and pruned context. " +
      "This is the authoritative record of what the TDD cycle is building.",
    promptSnippet: "Persist the compiled spec to .pi-coder/specs/ for reference by implementor and reviewer",
    promptGuidelines: [
      "Save the spec after synthesizing research findings and before presenting for approval.",
      "Update the spec with the implementation plan before starting the TDD cycle.",
      "The spec ID becomes the git branch name — keep it short and descriptive (e.g., user-auth).",
      "Include ALL acceptance criteria, constraints, and key files — implementor only sees what you put here.",
    ],
    parameters: Type.Object({
      id: Type.String({ description: "Spec ID — short, kebab-case identifier (e.g., user-auth). Becomes the git branch name." }),
      title: Type.String({ description: "Human-readable spec title" }),
      acceptanceCriteria: Type.Array(Type.String(), { description: "Specific, testable statements of what done looks like" }),
      constraints: Type.Array(Type.String(), { description: "Hard boundaries the implementation must respect" }),
      keyFiles: Type.Array(Type.String(), { description: "File paths relevant to this spec" }),
      prunedContext: Type.String({ description: "Research summary, architecture notes, and codebase context the implementor needs" }),
      implementationPlan: Type.Optional(Type.Array(Type.Object({
        name: Type.String({ description: "Unit name" }),
        acceptanceCriteriaIndices: Type.Array(Type.Number(), { description: "0-based indices into acceptanceCriteria array" }),
        keyFiles: Type.Array(Type.String(), { description: "File paths for this unit" }),
        dependsOn: Type.Optional(Type.Array(Type.String(), { description: "Names of units this depends on" })),
      }), { description: "Ordered list of atomic implementation units" })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        const spec: SpecFile = {
          id: params.id,
          title: params.title,
          acceptanceCriteria: params.acceptanceCriteria,
          constraints: params.constraints,
          keyFiles: params.keyFiles,
          prunedContext: params.prunedContext,
          implementationPlan: params.implementationPlan?.map((u) => ({
            name: u.name,
            acceptanceCriteriaIndices: u.acceptanceCriteriaIndices,
            keyFiles: u.keyFiles,
            dependsOn: u.dependsOn ?? [],
          })) ?? [],
          status: smRef.current.currentState as SpecFile["status"],
        };

        const path = await specManager.createSpec(spec);

        // Set the active spec ID at the module level
        if (activeSpecIdRef.current !== params.id) {
          setActiveSpecId(params.id);
        }

        // Set evidence flag — spec is saved
        smRef.current.setEvidence("spec_saved");

        return {
          content: [{ type: "text" as const, text: `Spec saved: ${params.id}\nPath: ${path}\n\nAcceptance Criteria: ${params.acceptanceCriteria.length}\nConstraints: ${params.constraints.length}\nKey Files: ${params.keyFiles.length}${params.implementationPlan ? `\nImplementation Units: ${params.implementationPlan.length}` : ""}` }],
          details: { success: true, id: params.id, path },
        };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Error saving spec: ${error}` }],
          details: { success: false, error },
          isError: true,
        };
      }
    },
  });

  // -------------------------------------------------------------------------
  // pi_coder_read_spec
  // -------------------------------------------------------------------------
  pi.registerTool({
    name: "pi_coder_read_spec",
    label: "Read Spec",
    description:
      "Read a spec file from .pi-coder/specs/{id}.md. Returns the full spec content " +
      "including acceptance criteria, constraints, key files, implementation plan, and pruned context. " +
      "Use this to refresh your memory or check the spec details during the TDD cycle.",
    promptSnippet: "Read the spec file to review acceptance criteria and implementation plan",
    promptGuidelines: [
      "Read spec before debriefing the implementor — you need the exact ACs and key files for delegation.",
      "Read spec before review — the reviewer needs to know what was specified.",
      "Only read specs you need — don't read all specs at once.",
    ],
    parameters: Type.Object({
      id: Type.String({ description: "Spec ID to read" }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        const spec = await specManager.readSpec(params.id);
        if (!spec) {
          return {
            content: [{ type: "text" as const, text: `Spec "${params.id}" not found. Use ls .pi-coder/specs/ to see available specs.` }],
            details: { success: false, error: "not_found" },
            isError: true,
          };
        }

        const lines: string[] = [
          `# ${spec.title}`,
          `ID: ${spec.id}`,
          `Status: ${spec.status}`,
          "",
          "## Acceptance Criteria",
        ];
        for (const ac of spec.acceptanceCriteria) {
          lines.push(`- [ ] ${ac}`);
        }
        lines.push("", "## Constraints");
        for (const c of spec.constraints) {
          lines.push(`- ${c}`);
        }
        lines.push("", "## Key Files");
        for (const f of spec.keyFiles) {
          lines.push(`- ${f}`);
        }
        if (spec.implementationPlan.length > 0) {
          lines.push("", "## Implementation Plan");
          for (const unit of spec.implementationPlan) {
            const acRefs = unit.acceptanceCriteriaIndices.map((i) => `AC${i + 1}`).join(", ");
            const deps = unit.dependsOn.length > 0 ? ` (depends on: ${unit.dependsOn.join(", ")})` : "";
            lines.push(`- **${unit.name}** [${acRefs}]${deps}`);
            for (const f of unit.keyFiles) {
              lines.push(`  - ${f}`);
            }
          }
        }
        lines.push("", "## Pruned Context");
        lines.push(spec.prunedContext);

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          details: { success: true, id: spec.id, title: spec.title },
        };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Error reading spec: ${error}` }],
          details: { success: false, error },
          isError: true,
        };
      }
    },
  });

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
      "IDLE → SPEC_WORK: Start a new TDD cycle. Include the user's request text in the 'request' parameter. You can then delegate to the researcher.",
      "SPEC_WORK → SPEC_APPROVED: You MUST save the spec with pi_coder_save_spec FIRST. Then present it to the user for approval via interview. Advancing without saving will be blocked.",
      "SPEC_APPROVED → GIT_CHECKPOINT: The user approved the spec. Time to checkpoint.",
      "TDD_GREEN_VALIDATE → TDD_RED_WRITE: Current unit passed. Advance to the next implementation unit's RED phase.",
      "TDD_GREEN_VALIDATE → REVIEWING: All units complete. Proceed to review.",
      "Any state → IDLE: Abort the current cycle. Use this to restart or unwind.",
      "NEEDS_CHANGES → TDD_RED_WRITE: Review requires functional fixes. Start a new RED/GREEN cycle.",
      "NEEDS_CHANGES → REVIEWING: Review requires non-functional fixes only (test fixes, comments, refactoring). Skip the RED/GREEN cycle and go directly back to review. Set fixType=\"non-functional\" to satisfy the evidence gate.",
    ],
    parameters: ADVANCE_FSM_PARAMS,

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const { targetState, request, fixType } = params;
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

      // No ad-hoc guards here — the StateMachine.transition() method
      // checks TRANSITION_GUARDS (evidence requirements) internally.
      // If a guard fails, it returns a TransitionGuardError.
      //
      // Exception: fixType parameter can set the non_functional_classified
      // evidence flag for the NEEDS_CHANGES → REVIEWING transition.
      // This serves as a manual escape hatch when the auto-transition
      // handler didn't fire (e.g., review output saved to artifact file
      // rather than inline, so extractReviewVerdict couldn't parse it).
      if (fixType === "non-functional" && smRef.current.currentState === "NEEDS_CHANGES" && targetState === "REVIEWING") {
        smRef.current.setEvidence("non_functional_classified");
      }

      try {
        const guardError = smRef.current.transition(targetState as FSMState);

        // Handle transition guard errors (missing evidence)
        if (guardError) {
          return {
            content: [{
              type: "text" as const,
              text: guardError.message,
            }],
            details: {
              success: false,
              error: `Transition guard failed: ${guardError.missingEvidence.join(", ")}`,
              missingEvidence: guardError.missingEvidence,
              previousState,
              validTargets: smRef.current.getValidTransitions(),
            },
            isError: true,
          };
        }

        // On SPEC_WORK entry: generate spec ID and set active, but delay
        // directory creation until pi_coder_save_spec (avoids stale empty dirs)
        if (targetState === "SPEC_WORK") {
          const requestText = request || "(no request text provided)";
          const existingSpecs = await specManager.listSpecs();
          const specId = generateSpecId(requestText, existingSpecs);

          setActiveSpecId(specId);
          // Directory is created when pi_coder_save_spec is called, not here.
          // This prevents directories with only request.md from cluttering .pi-coder/specs/
        }

        // On IDLE entry: clean up abandoned specs (directory with no spec.md)
        if (targetState === "IDLE" && activeSpecIdRef.current) {
          if (specManager.isAbandoned(activeSpecIdRef.current)) {
            await specManager.deleteSpec(activeSpecIdRef.current);
          }
          setActiveSpecId(null);
        }

        // Provide contextual guidance so the orchestrator knows what to do next
        const nextActionHints: Partial<Record<FSMState, string>> = {
          IDLE: "Cycle reset. Start a new cycle with pi_coder_advance_fsm → SPEC_WORK when ready.",
          SPEC_WORK: "Spec ID generated. Delegate to pi-coder.researcher to research. Save with pi_coder_save_spec before presenting for approval.",
          SPEC_APPROVED: config.createBranch ? "Create a feature branch with pi_coder_git checkout_branch, then checkpoint with pi_coder_git checkpoint." : "Checkpoint with pi_coder_git checkpoint (branch creation is disabled — working on current branch).",
          GIT_CHECKPOINT: "Checkpoint created. Advance to TDD_RED_WRITE when ready.",
          TDD_RED_WRITE: "Delegate to pi-coder.implementor to write RED (failing) tests.",
          TDD_RED_VALIDATE: "Run tests with pi_coder_run_tests. RED validation: expect tests to FAIL.",
          TDD_GREEN_WRITE: "Delegate to pi-coder.implementor to implement code (make tests pass).",
          TDD_GREEN_VALIDATE: "Run tests with pi_coder_run_tests. GREEN validation: expect tests to PASS.",
          REVIEWING: "Delegate to pi-coder.reviewer to review the implementation.",
          APPROVED: "Advance to FINAL_APPROVAL for user sign-off.",
          NEEDS_CHANGES: "Delegate to pi-coder.implementor for non-functional fixes (then advance to REVIEWING with fixType=\"non-functional\"), or advance to TDD_RED_WRITE for functional fixes.",
          FINAL_APPROVAL: "Present summary to user. If approved, advance to MERGING.",
          MERGING: !config.mergeBranch ? "Merge is disabled — tell the user the feature branch is ready for a PR or manual merge." : `Merge the feature branch with pi_coder_git merge (strategy: ${config.mergeBranch}).`,
          COMPLETE: "Spec complete. All tests passing, code reviewed and merged.",
          BLOCKED: "Present recovery options to the user.",
        };
        const hint = nextActionHints[targetState as FSMState];
        let text = hint
          ? `FSM advanced: ${previousState} → ${targetState}\n\nNext: ${hint}`
          : `FSM advanced: ${previousState} → ${targetState}`;

        // For SPEC_WORK, include the generated spec ID
        if (targetState === "SPEC_WORK" && activeSpecIdRef.current) {
          text += `\n\nSpec ID: ${activeSpecIdRef.current}`;
        }

        return {
          content: [{
            type: "text" as const,
            text,
          }],
          details: {
            success: true,
            previousState,
            newState: targetState,
            ...(targetState === "SPEC_WORK" ? { specId: activeSpecIdRef.current } : {}),
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
