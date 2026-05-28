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
import type { PiCoderConfig, PiCoderMode, SpecFile, TestRunResult } from "./types.ts";
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
  fixType: Type.Optional(Type.Union([Type.Literal("functional"), Type.Literal("non-functional")], { description: "Classification of the fix from the reviewer's verdict. In TDD mode, required when advancing from NEEDS_CHANGES → REVIEWING (non-functional fix path) if the evidence gate is not already satisfied. In Light mode, this parameter is ignored — NEEDS_CHANGES → REVIEWING has no evidence gate." })),
});

const PI_CODER_SUBMIT_REVIEW_PARAMS = Type.Object({
  verdict: StringEnum(["approved", "needs_changes"] as const, {
    description: "Review verdict. 'approved' means the implementation meets the Acceptance Criteria. 'needs_changes' means there are issues that must be fixed."
  }),
  fixType: Type.Optional(Type.Union([Type.Literal("functional"), Type.Literal("non-functional")], {
    description: "Required when verdict is 'needs_changes'. Classify the fix as 'functional' (changes production behavior — requires full implementation cycle) or 'non-functional' (no behavior change — can be applied directly). Ignored when verdict is 'approved'."
  })),
  issues: Type.Optional(Type.Array(Type.Object({
    title: Type.String({ description: "Short description of the issue" }),
    severity: StringEnum(["high", "medium", "low"] as const, { description: "Issue severity: high=critical, medium=should fix, low=nice-to-have" }),
    file: Type.Optional(Type.String({ description: "File path where the issue was found" })),
    problem: Type.String({ description: "Description of the problem" }),
    suggestedFix: Type.Optional(Type.String({ description: "Suggested fix" })),
  }), { description: "Structured list of issues found during review" })),
  summary: Type.Optional(Type.String({ description: "Brief review summary for the orchestrator log" })),
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

      // In TDD mode, validate FSM state before executing git operations.
      // In Light mode, the extension's tool_call handler validates against
      // LightStateMachine.ACTION_RULES instead — both enforce FSM state, but
      // the tool-level check provides defense-in-depth for TDD only.
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
              details: { success: false, error: "Branch creation disabled (createBranch: false)", operation: action },
              isError: true,
            };
          }
          if (!branch) {
            return {
              content: [{ type: "text" as const, text: "Error: branch parameter is required for checkout_branch action." }],
              details: { success: false, error: "branch parameter is required for checkout_branch", operation: action },
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
              details: { success: false, error: "No active spec ID — save spec before checkpointing", operation: action },
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
              details: { success: false, error: "No git ref stored for rollback", operation: action },
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
              details: { success: true, operation: action, branch: branchName },
            };
          }
          const currentBranchResult = await gitOps.getCurrentBranch();
          const featureBranch = currentBranchResult.branch ?? `${config.branchPrefix}${activeSpecIdRef.current ?? "unknown"}`;
          result = await gitOps.merge(featureBranch);

          // Handle dirty-tree detection — ask user to approve auto-commit
          if (result.dirtyTree && result.uncommittedFiles && result.uncommittedFiles.length > 0) {
            const confirmed = await _ctx.ui.confirm(
              "Pi Coder: Uncommitted Changes",
              `Uncommitted changes detected in ${result.uncommittedFiles.length} file(s):\n${result.uncommittedFiles.slice(0, 10).join("\n")}${result.uncommittedFiles.length > 10 ? `\n... and ${result.uncommittedFiles.length - 10} more` : ""}\n\nAuto-commit before merge?`,
            );

            if (confirmed) {
              // Auto-commit with generated message then retry merge
              const autoCommitMessage = `auto: commit before merge — ${activeSpecIdRef.current ?? "unknown"}`;
              const commitResult = await gitOps.checkpoint(autoCommitMessage);
              if (!commitResult.success) {
                return {
                  content: [{ type: "text" as const, text: `Auto-commit failed: ${commitResult.error}` }],
                  details: { success: false, error: "auto_commit_failed", operation: action },
                  isError: true,
                };
              }
              // Retry merge — tree should now be clean
              result = await gitOps.merge(featureBranch);
            } else {
              // User rejected auto-commit — return error with actionable guidance
              return {
                content: [{ type: "text" as const, text: "Merge cancelled — uncommitted changes detected and auto-commit was not approved. Commit or stash your changes manually, then retry the merge." }],
                details: { success: false, error: "uncommitted_changes_rejected", operation: action },
                isError: true,
              };
            }
          }
          break;
        }
        default: {
          return {
            content: [{ type: "text" as const, text: `Error: Unknown action: ${action}` }],
            details: { success: false, error: `Unknown action: ${action}`, operation: action },
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
        details: { ...result, operation: action },
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
          status: smRef.current.currentState,
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
      "NEEDS_CHANGES → TDD_RED_WRITE (TDD mode): Review requires functional fixes. Start a new RED/GREEN cycle.",
      "NEEDS_CHANGES → REVIEWING (TDD mode): Review requires non-functional fixes only (test fixes, comments, refactoring). The evidence gate is normally satisfied by the auto-transition; if not, pass fixType=\"non-functional\" to manually set the evidence flag.",
      "NEEDS_CHANGES → IMPLEMENTING (Light mode): Review requires functional fixes.",
      "NEEDS_CHANGES → REVIEWING (Light mode): Review requires fixes. No evidence gate in Light mode — advance directly after delegating implementor.",
"REVIEWING → APPROVED: Requires review_approved evidence — only set by the reviewer subagent. If auto-transition failed, re-delegate the reviewer.",
    ],
    parameters: ADVANCE_FSM_PARAMS,

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const { targetState, request, fixType } = params;
      const previousState = smRef.current.currentState;

      // No static state validation — each state machine (StateMachine, LightStateMachine)
      // validates transitions internally. The tool just calls transition() and handles
      // the result. This allows mode-specific states like IMPLEMENTING (Light) to work.
      // Per spec §7.2: "remove static enum validation from the parameter schema.
      // The transition() method itself validates."

      // No ad-hoc guards here — the StateMachine.transition() method
      // checks TRANSITION_GUARDS (evidence requirements) internally.
      // If a guard fails, it returns a TransitionGuardError.
      //
      // Exception: fixType parameter can set the non_functional_classified
      // evidence flag for the TDD-mode NEEDS_CHANGES → REVIEWING transition.
      // This serves as a manual escape hatch when the auto-transition
      // handler didn't fire (e.g., review output saved to artifact file
      // rather than inline, so extractReviewVerdict couldn't parse it).
      // Light mode does not have this gate — fixType is ignored in Light mode.
      if (fixType === "non-functional" && smRef.current.currentState === "NEEDS_CHANGES" && targetState === "REVIEWING" && deps.piCoderMode.current === "tdd") {
        smRef.current.setEvidence("non_functional_classified");
      }

      try {
        const guardError = smRef.current.transition(targetState);

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
        // Includes hints for both TDD and Light mode states
        const nextActionHints: Record<string, string> = {
          IDLE: "Cycle reset. Start a new cycle with pi_coder_advance_fsm → SPEC_WORK when ready.",
          SPEC_WORK: "Spec ID generated. Delegate to pi-coder.researcher to research. Save with pi_coder_save_spec before presenting for approval.",
          SPEC_APPROVED: config.createBranch ? "Create a feature branch with pi_coder_git checkout_branch, then checkpoint with pi_coder_git checkpoint." : "Checkpoint with pi_coder_git checkpoint (branch creation is disabled — working on current branch).",
          GIT_CHECKPOINT: "Checkpoint created. Advance to TDD_RED_WRITE (TDD) or IMPLEMENTING (Light) when ready.",
          TDD_RED_WRITE: "Delegate to pi-coder.implementor to write RED (failing) tests.",
          TDD_RED_VALIDATE: "Run tests with pi_coder_run_tests. RED validation: expect tests to FAIL.",
          TDD_GREEN_WRITE: "Delegate to pi-coder.implementor to implement code (make tests pass).",
          TDD_GREEN_VALIDATE: "Run tests with pi_coder_run_tests. GREEN validation: expect tests to PASS.",
          IMPLEMENTING: "Delegate to pi-coder.implementor to implement the spec. Run tests freely with pi_coder_run_tests to check progress.",
          REVIEWING: "Delegate to pi-coder.reviewer to review the implementation.",
          APPROVED: "Advance to MERGING (if user already approved via interview) or FINAL_APPROVAL (for separate sign-off).",
          NEEDS_CHANGES: "Delegate implementor for fix, then pi_coder_advance_fsm REVIEWING. Or pi_coder_advance_fsm to TDD_RED_WRITE (TDD) or IMPLEMENTING (Light) for full reimplementation. In TDD mode, if advancing to REVIEWING without evidence, pass fixType=\"non-functional\".",
          FINAL_APPROVAL: "Present summary to user. If approved, advance to MERGING.",
          MERGING: !config.mergeBranch ? "Merge is disabled — tell the user the feature branch is ready for a PR or manual merge." : `Merge the feature branch with pi_coder_git merge (strategy: ${config.mergeBranch}).`,
          COMPLETE: "Spec complete. All tests passing, code reviewed and merged.",
          BLOCKED: "Present recovery options to the user.",
        };
        const hint = nextActionHints[targetState];
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

  // -------------------------------------------------------------------------
  // pi_coder_submit_review
  // -------------------------------------------------------------------------
  pi.registerTool({
    name: "pi_coder_submit_review",
    label: "Submit Review",
    description:
      "Submit a structured review verdict after completing your review. " +
      "Call this AFTER writing your full review analysis — the tool handles the structured verdict, " +
      "your prose handles the detailed findings. " +
      "The verdict drives FSM auto-transition: 'approved' advances to APPROVED, " +
      "'needs_changes' advances to NEEDS_CHANGES.",
    promptSnippet: "Submit review verdict — approved or needs changes",
    promptGuidelines: [
      "Call this at the END of your review, after writing all findings in prose.",
      "verdict is REQUIRED. fixType is REQUIRED when verdict is needs_changes.",
      "Issues array is optional but recommended — it provides structured data for the orchestrator.",
      "Do NOT use this tool to replace your written review — use it to commit your verdict.",
    ],
    parameters: PI_CODER_SUBMIT_REVIEW_PARAMS,

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const sm = smRef.current;

      // Validate FSM state — submit_review only allowed in REVIEWING
      if (!sm.isActionAllowed("pi_coder_submit_review")) {
        return {
          content: [{ type: "text" as const, text: `Error: pi_coder_submit_review is not allowed in state ${sm.currentState}. Only allowed in REVIEWING state.` }],
          details: { success: false, error: `Not allowed in state ${sm.currentState}`, currentState: sm.currentState },
          isError: true,
        };
      }

      // Validate: fixType required when needs_changes
      if (params.verdict === "needs_changes" && !params.fixType) {
        return {
          content: [{ type: "text" as const, text: "Error: fixType is required when verdict is 'needs_changes'. Classify the fix as 'functional' or 'non-functional'." }],
          details: { success: false, error: "fixType_required" },
          isError: true,
        };
      }

      // Set evidence flags
      if (params.verdict === "approved") {
        sm.setEvidence("review_approved");
      }
      if (params.verdict === "needs_changes" && params.fixType === "non-functional" && deps.piCoderMode.current === "tdd") {
        sm.setEvidence("non_functional_classified");
      }

      // Transition FSM
      const target = params.verdict === "approved" ? "APPROVED" : "NEEDS_CHANGES";
      const transitionResult = sm.transition(target);

      // Check for transition guard errors (e.g., missing evidence)
      if (transitionResult && typeof transitionResult === "object" && "missingEvidence" in transitionResult) {
        return {
          content: [{ type: "text" as const, text: `FSM transition failed: ${transitionResult.message}` }],
          details: {
            success: false,
            error: "transition_failed",
            missingEvidence: transitionResult.missingEvidence,
            from: transitionResult.from,
            to: transitionResult.to,
          },
          isError: true,
        };
      }

      // Build response
      const issueCount = params.issues
        ? { high: params.issues.filter(i => i.severity === "high").length,
            medium: params.issues.filter(i => i.severity === "medium").length,
            low: params.issues.filter(i => i.severity === "low").length }
        : undefined;

      const text = params.verdict === "approved"
        ? "Review submitted: ✅ Approved. FSM advanced to APPROVED."
        : `Review submitted: ⚠️ Needs Changes (${params.fixType} fix). FSM advanced to NEEDS_CHANGES.${issueCount ? ` Issues: ${issueCount.high} high, ${issueCount.medium} medium, ${issueCount.low} low.` : ""}`;

      return {
        content: [{ type: "text" as const, text }],
        details: {
          success: true,
          verdict: params.verdict,
          fixType: params.fixType,
          issues: params.issues,
          issueCount,
          summary: params.summary,
        },
      };
    },
  });
}
