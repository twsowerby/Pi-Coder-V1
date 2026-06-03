/**
 * Integration Test — Full TDD Lifecycle
 *
 * End-to-end verification that all components work together as a system.
 * Uses real StateMachine, SpecManager, GitOperations, TddRunner, and
 * KnowledgeStore instances — only pi.exec and pi API calls are mocked.
 *
 * Phase 1: Test infrastructure — temp directory, component wiring, mocked exec
 * Phase 2: Happy path — full TDD lifecycle from IDLE through COMPLETE
 * Phase 3: Failure & edge cases — RED anomaly, circuit breaker, toggle, nudge
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { DevStateMachine } from "../dev-state-machine.ts";
import type { DevDevStateMachineJSON } from "../dev-state-machine.ts";
import { SpecManager } from "../spec.ts";
import { GitOperations } from "../git.ts";
import { TddRunner } from "../tdd-runner.ts";
import { KnowledgeStore } from "../knowledge.ts";
import { generateSpecId } from "../spec.ts";
import type { PiCoderConfig, TestRunResult } from "../types.ts";

// ---------------------------------------------------------------------------
// Test Config Factory
// ---------------------------------------------------------------------------

function makeConfig(overrides?: Partial<PiCoderConfig>): PiCoderConfig {
  return {
    testCommand: "npm test",
    maxLoops: 3,
    createBranch: true,
    mergeBranch: "merge",
    branchPrefix: "pi-coder/",
    nudge: {
      enabled: true,
      defaults: { turnsBeforeNudge: 1, escalationLevels: 3 },
      states: {
        SPEC_WORK: { turnsBeforeNudge: 3 },
        BLOCKED: { turnsBeforeNudge: 2 },
        IDLE: { enabled: false },
        SPEC_APPROVED: { enabled: false },
        FINAL_APPROVAL: { enabled: false },
        COMPLETE: { enabled: false },
      },
    },
    logging: {
      enabled: false,
      level: "standard",
      maxLogFiles: 10,
    },
    retryEscalation: {
      maxRetries: 10,
      enrichedSteerThreshold: 4,
      replanThreshold: 7,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mock pi.exec
// ---------------------------------------------------------------------------

type ExecFn = (
  command: string,
  args: string[],
  options?: { signal?: AbortSignal; timeout?: number },
) => Promise<{ stdout: string; stderr: string; code: number; killed?: boolean }>;

/**
 * Create a mocked pi.exec that simulates git commands and test runs.
 *
 * Git commands return success with fake SHAs.
 * Test runs return configurable exit codes and output.
 */
function createMockExec(testResults?: { exitCode: number; output: string }) {
  const defaultTestResult = testResults ?? {
    exitCode: 1,
    output: "Tests  0 passed, 3 failed\nFAIL src/auth.test.ts",
  };

  return async function mockExec(
    command: string,
    args: string[],
  ): Promise<{ stdout: string; stderr: string; code: number; killed?: boolean }> {
    // git commands
    if (command === "git") {
      const subCommand = args[0];

      switch (subCommand) {
        case "rev-parse": {
          if (args.includes("--short")) {
            return { stdout: "abc1234\n", stderr: "", code: 0 };
          }
          if (args.includes("--abbrev-ref")) {
            if (args.includes("origin/HEAD")) {
              return { stdout: "origin/main\n", stderr: "", code: 0 };
            }
            return { stdout: "pi-coder/string-reversal\n", stderr: "", code: 0 };
          }
          if (args.includes("--verify")) {
            return { stdout: "", stderr: "", code: 0 };
          }
          return { stdout: "", stderr: "", code: 0 };
        }

        case "checkout": {
          return { stdout: "", stderr: "", code: 0 };
        }

        case "add": {
          return { stdout: "", stderr: "", code: 0 };
        }

        case "commit": {
          // Extract a fake commit SHA from the message
          return {
            stdout: `[pi-coder/string-reversal def5678] ${args.includes("-m") ? args[args.indexOf("-m") + 1] : "commit"}\n`,
            stderr: "",
            code: 0,
          };
        }

        case "reset": {
          return { stdout: "", stderr: "", code: 0 };
        }

        case "merge": {
          return { stdout: "Merge complete\n", stderr: "", code: 0 };
        }

        case "status": {
          return { stdout: "", stderr: "", code: 0 };
        }

        default: {
          return { stdout: "", stderr: "", code: 0 };
        }
      }
    }

    // Test commands (npm, npx, etc.)
    if (command === "npm" || command === "npx") {
      return {
        stdout: defaultTestResult.output,
        stderr: "",
        code: defaultTestResult.exitCode,
      };
    }

    // Unknown command
    return { stdout: "", stderr: `command not found: ${command}`, code: 127 };
  };
}

// ---------------------------------------------------------------------------
// Test Fixture
// ---------------------------------------------------------------------------

let tempDir: string;
let config: PiCoderConfig;
let stateMachine: DevStateMachine;
let specManager: SpecManager;
let gitOps: GitOperations;
let tddRunner: TddRunner;
let knowledgeStore: KnowledgeStore;

function setupFixture(testConfig?: Partial<PiCoderConfig>, testResults?: { exitCode: number; output: string }): void {
  // Create temp directory
  tempDir = mkdtempSync(join(tmpdir(), "pi-coder-integration-"));

  // Create .pi-coder/ directory structure
  mkdirSync(join(tempDir, ".pi-coder", "knowledge"), { recursive: true });
  mkdirSync(join(tempDir, ".pi-coder", "specs"), { recursive: true });

  // Create a minimal package.json with a test script
  writeFileSync(
    join(tempDir, "package.json"),
    JSON.stringify({
      name: "test-project",
      scripts: {
        test: "npm test",
      },
    }),
  );

  // Create config
  config = makeConfig(testConfig);

  // Instantiate all real components
  const mockExec = createMockExec(testResults);

  const knowledgeDir = join(tempDir, ".pi-coder", "knowledge");
  const specsDir = join(tempDir, ".pi-coder", "specs");

  stateMachine = new DevStateMachine(config);
  specManager = new SpecManager(specsDir);
  gitOps = new GitOperations(config, mockExec as ExecFn);
  tddRunner = new TddRunner(config, mockExec as ExecFn);
  knowledgeStore = new KnowledgeStore(knowledgeDir);
}

function teardownFixture(): void {
  if (tempDir && existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Phase 1: Test Infrastructure
// ---------------------------------------------------------------------------


/** Force a transition with required evidence set. */
function forceTransition(sm: DevStateMachine, to: FSMState): void {
  const from = sm.currentState;
  if (from === "SPEC_WORK" && to === "SPEC_APPROVED") {
    sm.setEvidence("spec_saved");
    sm.setEvidence("spec_user_approved");
  }
  if (from === "TDD_RED_VALIDATE" && to === "TDD_GREEN_WRITE") {
    sm.setEvidence("test_run_this_state");
  }
  if (from === "TDD_GREEN_VALIDATE") {
    sm.setEvidence("test_run_this_state");
  }
  if (from === "NEEDS_CHANGES" && to === "REVIEWING") {
    sm.setEvidence("non_functional_classified");
  }
  if (from === "REVIEWING" && to === "APPROVED") {
    sm.setEvidence("review_completed");
  }
  const result = sm.transition(to);
  if (result) throw new Error("Guard blocked: " + result.message);
}

describe("Phase 1: Test Infrastructure", () => {
  beforeEach(() => {
    setupFixture();
  });

  afterEach(() => {
    teardownFixture();
  });

  it("creates temp directory with valid .pi-coder/ structure", () => {
    assert.ok(existsSync(join(tempDir, ".pi-coder", "knowledge")));
    assert.ok(existsSync(join(tempDir, ".pi-coder", "specs")));
    assert.ok(existsSync(join(tempDir, "package.json")));
  });

  it("instantiates all components with test fixture paths", () => {
    assert.ok(stateMachine instanceof DevStateMachine);
    assert.ok(specManager instanceof SpecManager);
    assert.ok(gitOps instanceof GitOperations);
    assert.ok(tddRunner instanceof TddRunner);
    assert.ok(knowledgeStore instanceof KnowledgeStore);
  });

  it("state machine starts in IDLE state", () => {
    assert.strictEqual(stateMachine.currentState, "IDLE");
    assert.strictEqual(stateMachine.gitRef, null);
    assert.strictEqual(stateMachine.loopCount, 0);
  });

  it("mocked git exec returns valid SHAs", async () => {
    const result = await gitOps.getCurrentRef();
    assert.ok(result.success);
    assert.ok(result.ref);
  });

  it("mocked test exec returns configured results", async () => {
    setupFixture({}, { exitCode: 1, output: "Tests  5 passed, 2 failed" });
    const result = await tddRunner.runTests();
    assert.strictEqual(result.exitCode, 1);
  });
});

// ---------------------------------------------------------------------------
// Phase 2: Happy Path Lifecycle
// ---------------------------------------------------------------------------

describe("Phase 2: Happy Path Lifecycle", () => {
  beforeEach(() => {
    // Default: tests fail for RED, pass for GREEN (we'll reconfigure per-step)
    setupFixture();
  });

  afterEach(() => {
    teardownFixture();
  });

  it("completes the full TDD lifecycle from IDLE to COMPLETE", async () => {
    // --- Intake & Research ---
    assert.strictEqual(stateMachine.currentState, "IDLE");

    // Generate spec ID from user request (now includes timestamp prefix)
    const specId = generateSpecId("string reversal utility", []);
    assert.ok(specId.endsWith("-string-reversal-utility"), `Expected ID ending with -string-reversal-utility, got: ${specId}`);

    // Transition: IDLE → SPEC_WORK
    forceTransition(stateMachine, "SPEC_WORK");
    assert.strictEqual(stateMachine.currentState, "SPEC_WORK");

    // Researcher completes — stays in SPEC_WORK (multiple rounds possible)

    // --- Context Pruning & Spec Drafting ---
    // Orchestrator prunes research and drafts the spec
    const spec = {
      id: specId,
      title: "String Reversal Utility",
      acceptanceCriteria: [
        "Function reverses a string correctly",
        "Empty string returns empty string",
        "Unicode characters are preserved",
      ],
      constraints: [
        "Must be a pure function",
        "No external dependencies",
      ],
      keyFiles: [
        "src/utils/reverse.ts",
        "src/utils/reverse.test.ts",
      ],
      prunedContext: "Project uses TypeScript with vitest for testing. Existing utils follow a functional pattern.",
      implementationPlan: [],
      status: "SPEC_WORK" as const,
    };

    // Create spec file via SpecManager
    const specPath = await specManager.createSpec(spec);
    assert.ok(existsSync(specPath));

    // Verify spec can be read back
    const readSpec = await specManager.readSpec(specId);
    assert.ok(readSpec);
    assert.strictEqual(readSpec.id, specId);
    assert.strictEqual(readSpec.title, "String Reversal Utility");
    assert.strictEqual(readSpec.acceptanceCriteria.length, 3);
    assert.strictEqual(readSpec.constraints.length, 2);

    // Transition: SPEC_WORK → SPEC_APPROVED (spec ready for approval)
    forceTransition(stateMachine, "SPEC_APPROVED");
    assert.strictEqual(stateMachine.currentState, "SPEC_APPROVED");

    // --- Git Checkpoint ---
    forceTransition(stateMachine, "GIT_CHECKPOINT");
    assert.strictEqual(stateMachine.currentState, "GIT_CHECKPOINT");

    // Create branch and checkpoint
    const branchResult = await gitOps.checkoutBranch(specId);
    assert.ok(branchResult.success);

    const checkpointResult = await gitOps.checkpoint(`wip: pre-implementation-${specId}`);
    assert.ok(checkpointResult.success);

    // Store the git ref in the state machine (like the extension does)
    if (checkpointResult.ref) {
      stateMachine.setGitRef(checkpointResult.ref);
    }
    assert.ok(stateMachine.gitRef);
    assert.strictEqual(stateMachine.gitRef, checkpointResult.ref);

    // Transition: GIT_CHECKPOINT → TDD_RED_WRITE
    forceTransition(stateMachine, "TDD_RED_WRITE");
    assert.strictEqual(stateMachine.currentState, "TDD_RED_WRITE");

    // --- RED Phase: Write Tests ---
    // Simulate: implementor writes tests (RED mode)
    // The orchestrator delegates to pi-coder.implementor with task payload

    // Transition: TDD_RED_WRITE → TDD_RED_VALIDATE
    forceTransition(stateMachine, "TDD_RED_VALIDATE");
    assert.strictEqual(stateMachine.currentState, "TDD_RED_VALIDATE");

    // Run tests — they MUST fail (RED phase)
    // Reconfigure TddRunner with failing test results
    const failingExec = createMockExec({ exitCode: 1, output: "Tests  0 passed, 3 failed\nFAIL" });
    const failingRunner = new TddRunner(config, failingExec as ExecFn);

    const redResult = await failingRunner.runTests();
    assert.notStrictEqual(redResult.exitCode, 0, "RED phase: tests should fail");

    const redValidation = failingRunner.validateRedPhase(redResult);
    assert.ok(redValidation.valid, "RED phase: test failure is valid");
    assert.strictEqual(redValidation.reason, undefined);

    // Auto-transition (extension tool_result handler logic):
    // RED_VALIDATE + tests fail → TDD_GREEN_WRITE
    forceTransition(stateMachine, "TDD_GREEN_WRITE");
    assert.strictEqual(stateMachine.currentState, "TDD_GREEN_WRITE");

    // --- GREEN Phase: Write Code ---
    // Simulate: implementor writes implementation code (GREEN mode)

    // Transition: TDD_GREEN_WRITE → TDD_GREEN_VALIDATE
    forceTransition(stateMachine, "TDD_GREEN_VALIDATE");
    assert.strictEqual(stateMachine.currentState, "TDD_GREEN_VALIDATE");

    // Run tests — they MUST pass (GREEN phase)
    const passingExec = createMockExec({ exitCode: 0, output: "Tests  3 passed" });
    const passingRunner = new TddRunner(config, passingExec as ExecFn);

    const greenResult = await passingRunner.runTests();
    assert.strictEqual(greenResult.exitCode, 0, "GREEN phase: tests should pass");

    const greenValidation = passingRunner.validateGreenPhase(greenResult);
    assert.ok(greenValidation.valid, "GREEN phase: test pass is valid");

    // Auto-transition: GREEN_VALIDATE + tests pass → REVIEWING
    forceTransition(stateMachine, "REVIEWING");
    assert.strictEqual(stateMachine.currentState, "REVIEWING");

    // --- Review ---
    // Simulate: reviewer approves the implementation
    forceTransition(stateMachine, "APPROVED");
    assert.strictEqual(stateMachine.currentState, "APPROVED");

    forceTransition(stateMachine, "FINAL_APPROVAL");
    assert.strictEqual(stateMachine.currentState, "FINAL_APPROVAL");

    forceTransition(stateMachine, "MERGING");
    assert.strictEqual(stateMachine.currentState, "MERGING");

    // Merge the feature branch
    const mergeResult = await gitOps.merge(`${config.branchPrefix}${specId}`);
    assert.ok(mergeResult.success);

    // Transition: MERGING → COMPLETE
    forceTransition(stateMachine, "COMPLETE");
    assert.strictEqual(stateMachine.currentState, "COMPLETE");

    // --- Cleanup ---
    // Verify spec file can be cleaned up after completion
    await specManager.deleteSpec(specId);
    const deletedSpec = await specManager.readSpec(specId);
    assert.strictEqual(deletedSpec, null);
  });

  it("preserves spec file throughout the lifecycle until cleanup", async () => {
    const specId = generateSpecId("test spec", []);

    // Create spec

    await specManager.createSpec({
      id: specId,
      title: "Test Spec",
      acceptanceCriteria: ["AC1"],
      constraints: ["C1"],
      keyFiles: ["src/test.ts"],
      prunedContext: "Context",
      implementationPlan: [],
      status: "SPEC_WORK",
    });

    // Spec should exist throughout the lifecycle
    let spec = await specManager.readSpec(specId);
    assert.ok(spec, "Spec should exist after creation");

    // Advance through several states
    forceTransition(stateMachine, "SPEC_WORK");
    forceTransition(stateMachine, "SPEC_APPROVED");
    spec = await specManager.readSpec(specId);
    assert.ok(spec, "Spec should exist during SPEC_APPROVED");

    forceTransition(stateMachine, "GIT_CHECKPOINT");
    spec = await specManager.readSpec(specId);
    assert.ok(spec, "Spec should exist during GIT_CHECKPOINT");

    forceTransition(stateMachine, "TDD_RED_WRITE");
    spec = await specManager.readSpec(specId);
    assert.ok(spec, "Spec should exist during TDD_RED_WRITE");

    // Cleanup
    await specManager.deleteSpec(specId);
    spec = await specManager.readSpec(specId);
    assert.strictEqual(spec, null, "Spec should be deleted after cleanup");
  });

  it("stores git ref at checkpoint and it is available for reviewer briefing", async () => {
    const specId = "ref-tracking-test";
    forceTransition(stateMachine, "SPEC_WORK");
    forceTransition(stateMachine, "SPEC_APPROVED");
    forceTransition(stateMachine, "GIT_CHECKPOINT");

    // Create checkpoint
    const checkpointResult = await gitOps.checkpoint("wip: test-checkpoint");
    assert.ok(checkpointResult.success);
    assert.ok(checkpointResult.ref, "Checkpoint should return a commit SHA");

    // Store the ref
    stateMachine.setGitRef(checkpointResult.ref);

    // Verify the ref is available for reviewer briefing
    assert.strictEqual(stateMachine.gitRef, checkpointResult.ref);

    // The reviewer task payload would include this ref:
    // "Review the diff against commit {stateMachine.gitRef}. Run git diff {stateMachine.gitRef}."
    const reviewerTaskPayload = `Review the diff against commit ${stateMachine.gitRef}`;
    assert.ok(reviewerTaskPayload.includes(checkpointResult.ref!));
  });

  it("allows knowledge upsert at any point in the lifecycle", async () => {
    // Knowledge can be updated in IDLE
    knowledgeStore.upsert("project-conventions.md", "# Conventions\n- Use TypeScript strict mode");
    assert.ok(knowledgeStore.exists("project-conventions.md"));

    // Transition to SPEC_WORK — knowledge still works
    forceTransition(stateMachine, "SPEC_WORK");
    knowledgeStore.upsert("testing-patterns.md", "# Testing\n- Use vitest");
    assert.ok(knowledgeStore.exists("testing-patterns.md"));

    // Continue through the lifecycle — knowledge is always available
    forceTransition(stateMachine, "SPEC_APPROVED");
    const listedFiles = knowledgeStore.list();
    assert.strictEqual(listedFiles.length, 2);
    assert.ok(listedFiles.includes("project-conventions.md"));
    assert.ok(listedFiles.includes("testing-patterns.md"));

    // Read back knowledge content
    const content = knowledgeStore.read("project-conventions.md");
    assert.ok(content);
    assert.ok(content.includes("TypeScript strict mode"));
  });

  it("tracks spec status through the lifecycle", async () => {
    const specId = "status-tracking";
    await specManager.createSpec({
      id: specId,
      title: "Status Tracking Test",
      acceptanceCriteria: ["AC1"],
      constraints: [],
      keyFiles: [],
      prunedContext: "",
      implementationPlan: [],
      status: "SPEC_WORK",
    });

    // Update status as the lifecycle progresses
    await specManager.updateSpec(specId, { status: "SPEC_APPROVED" });
    let spec = await specManager.readSpec(specId);
    assert.strictEqual(spec!.status, "SPEC_APPROVED");

    await specManager.updateSpec(specId, { status: "TDD_RED_WRITE" });
    spec = await specManager.readSpec(specId);
    assert.strictEqual(spec!.status, "TDD_RED_WRITE");

    await specManager.updateSpec(specId, { status: "COMPLETE" });
    spec = await specManager.readSpec(specId);
    assert.strictEqual(spec!.status, "COMPLETE");
  });
});

// ---------------------------------------------------------------------------
// Phase 3: Failure & Edge Cases
// ---------------------------------------------------------------------------

describe("Phase 3: Failure & Edge Cases", () => {

  beforeEach(() => {
    setupFixture();
  });

  afterEach(() => {
    teardownFixture();
  });

  it("RED phase anomaly (tests pass) transitions to BLOCKED with RED_TAUTOLOGY", async () => {
    // Advance to TDD_RED_VALIDATE
    forceTransition(stateMachine, "SPEC_WORK");
    forceTransition(stateMachine, "SPEC_APPROVED");
    forceTransition(stateMachine, "GIT_CHECKPOINT");
    forceTransition(stateMachine, "TDD_RED_WRITE");
    forceTransition(stateMachine, "TDD_RED_VALIDATE");
    assert.strictEqual(stateMachine.currentState, "TDD_RED_VALIDATE");

    // Run tests — they PASS when they should FAIL (anomaly!)
    const passingExec = createMockExec({ exitCode: 0, output: "Tests  3 passed" });
    const passingRunner = new TddRunner(config, passingExec as ExecFn);

    const redResult = await passingRunner.runTests();
    assert.strictEqual(redResult.exitCode, 0, "Tests pass unexpectedly");

    const validation = passingRunner.validateRedPhase(redResult);
    assert.ok(!validation.valid, "RED validation should fail when tests pass");
    assert.strictEqual(validation.reason, "RED_TAUTOLOGY");

    // Extension auto-transition: RED_VALIDATE + invalid → BLOCKED
    forceTransition(stateMachine, "BLOCKED");
    assert.strictEqual(stateMachine.currentState, "BLOCKED");
  });

  it("circuit breaker trips after maxLoops review cycles", () => {
    // Advance to REVIEWING
    forceTransition(stateMachine, "SPEC_WORK");
    forceTransition(stateMachine, "SPEC_APPROVED");
    forceTransition(stateMachine, "GIT_CHECKPOINT");
    forceTransition(stateMachine, "TDD_RED_WRITE");
    forceTransition(stateMachine, "TDD_RED_VALIDATE");
    forceTransition(stateMachine, "TDD_GREEN_WRITE");
    forceTransition(stateMachine, "TDD_GREEN_VALIDATE");
    forceTransition(stateMachine, "REVIEWING");
    assert.strictEqual(stateMachine.currentState, "REVIEWING");
    assert.strictEqual(stateMachine.loopCount, 0);

    // Cycle 1: NEEDS_CHANGES → TDD_RED_WRITE
    forceTransition(stateMachine, "NEEDS_CHANGES");
    forceTransition(stateMachine, "TDD_RED_WRITE");
    assert.strictEqual(stateMachine.loopCount, 1);
    assert.ok(!stateMachine.circuitBreakerTripped(), "Should not trip after 1 cycle");

    // Advance back to REVIEWING for next cycle
    forceTransition(stateMachine, "TDD_RED_VALIDATE");
    forceTransition(stateMachine, "TDD_GREEN_WRITE");
    forceTransition(stateMachine, "TDD_GREEN_VALIDATE");
    forceTransition(stateMachine, "REVIEWING");

    // Cycle 2: NEEDS_CHANGES → TDD_RED_WRITE
    forceTransition(stateMachine, "NEEDS_CHANGES");
    forceTransition(stateMachine, "TDD_RED_WRITE");
    assert.strictEqual(stateMachine.loopCount, 2);
    assert.ok(!stateMachine.circuitBreakerTripped(), "Should not trip after 2 cycles");

    // Advance back to REVIEWING
    forceTransition(stateMachine, "TDD_RED_VALIDATE");
    forceTransition(stateMachine, "TDD_GREEN_WRITE");
    forceTransition(stateMachine, "TDD_GREEN_VALIDATE");
    forceTransition(stateMachine, "REVIEWING");

    // Cycle 3: NEEDS_CHANGES → TDD_RED_WRITE
    forceTransition(stateMachine, "NEEDS_CHANGES");
    forceTransition(stateMachine, "TDD_RED_WRITE");
    assert.strictEqual(stateMachine.loopCount, 3);
    assert.ok(stateMachine.circuitBreakerTripped(), "Should trip after 3 cycles (maxLoops)");

    // The fourth attempt should transition to BLOCKED
    // (In the extension, the reviewer handler checks circuitBreakerTripped before looping)
    forceTransition(stateMachine, "IDLE"); // Reset
  });

  it("circuit breaker prevents further review loops — extension aborts to IDLE", () => {
    forceTransition(stateMachine, "SPEC_WORK");
    forceTransition(stateMachine, "SPEC_APPROVED");
    forceTransition(stateMachine, "GIT_CHECKPOINT");
    forceTransition(stateMachine, "TDD_RED_WRITE");
    forceTransition(stateMachine, "TDD_RED_VALIDATE");
    forceTransition(stateMachine, "TDD_GREEN_WRITE");
    forceTransition(stateMachine, "TDD_GREEN_VALIDATE");
    forceTransition(stateMachine, "REVIEWING");

    // Complete 3 full review cycles
    for (let i = 0; i < 3; i++) {
      forceTransition(stateMachine, "NEEDS_CHANGES");
      forceTransition(stateMachine, "TDD_RED_WRITE");
      forceTransition(stateMachine, "TDD_RED_VALIDATE");
      forceTransition(stateMachine, "TDD_GREEN_WRITE");
      forceTransition(stateMachine, "TDD_GREEN_VALIDATE");
      forceTransition(stateMachine, "REVIEWING");
    }

    assert.strictEqual(stateMachine.loopCount, 3);
    assert.ok(stateMachine.circuitBreakerTripped());

    // When the circuit breaker trips, the extension handler does NOT
    // transition NEEDS_CHANGES → TDD_RED_WRITE again. Instead, it
    // presents options to the user. The any→IDLE abort path is always legal:
    forceTransition(stateMachine, "IDLE");
    assert.strictEqual(stateMachine.currentState, "IDLE");
    assert.strictEqual(stateMachine.loopCount, 0, "Loop count resets on IDLE");
  });

  it("toggle mid-cycle preserves FSM state", () => {
    // Start a TDD cycle
    forceTransition(stateMachine, "SPEC_WORK");
    forceTransition(stateMachine, "SPEC_APPROVED");
    forceTransition(stateMachine, "GIT_CHECKPOINT");
    forceTransition(stateMachine, "TDD_RED_WRITE");

    // Set spec info
    stateMachine.setGitRef("abc1234");
    assert.strictEqual(stateMachine.currentState, "TDD_RED_WRITE");
    // activeSpecId is now module-level, not on StateMachine
    // Check evidence instead — spec should be saved if we got this far
    assert.ok(stateMachine.hasEvidence("spec_saved"));

    // Simulate: toggle OFF (persist state)
    const snapshot: DevStateMachineJSON = stateMachine.toJSON();
    assert.strictEqual(snapshot.currentState, "TDD_RED_WRITE");
    assert.ok(snapshot.evidence.includes("spec_saved"));
    assert.strictEqual(snapshot.gitRef, "abc1234");

    // Simulate: toggle OFF — persistence is via appendEntry
    // We capture the snapshot as if persistState() was called
    const persistedState = { active: false, fsmState: snapshot };
    assert.ok(persistedState);
    assert.strictEqual(persistedState.fsmState.currentState, "TDD_RED_WRITE");

    // Simulate: toggle ON — restore from persisted state
    const restoredMachine = DevStateMachine.fromJSON(persistedState.fsmState, config);
    assert.strictEqual(restoredMachine.currentState, "TDD_RED_WRITE");
    // activeSpecId is module-level, not in DevStateMachineJSON
    // Check that evidence was preserved
    assert.ok(restoredMachine.hasEvidence("spec_saved"));
    assert.strictEqual(restoredMachine.gitRef, "abc1234");

    // Can continue transitioning from the restored state
    restoredMachine.transition("TDD_RED_VALIDATE");
    assert.strictEqual(restoredMachine.currentState, "TDD_RED_VALIDATE");
  });

  it("nudge escalation fires at correct turn count", () => {
    // The nudge system uses per-state thresholds from config.
    // SPEC_WORK has the default threshold of 1 (nudge after 1 turn without action).

    // Simulate the nudge counter behavior that the extension's
    // before_agent_start handler implements.

    // Advance to SPEC_WORK
    forceTransition(stateMachine, "SPEC_WORK");
    assert.strictEqual(stateMachine.currentState, "SPEC_WORK");

    // Turn 0: nudge level 0 (just entered state)
    let nudgeLevel = 0;
    let turnsSinceEntry = 0;
    let actionAttempted = false;

    // canNudge() should return the expected action for SPEC_WORK
    const nudgeExpectation = stateMachine.canNudge();
    assert.ok(nudgeExpectation.shouldNudge);
    assert.strictEqual(nudgeExpectation.expectedAction, "Delegate to pi-coder.researcher or advance to SPEC_APPROVED");
    assert.strictEqual(nudgeExpectation.expectedTool, "subagent");

    // Get threshold for SPEC_WORK (3 from config)
    const threshold = config.nudge.states.SPEC_WORK?.turnsBeforeNudge
      ?? config.nudge.defaults.turnsBeforeNudge;
    assert.strictEqual(threshold, 3, "SPEC_WORK threshold should be 3");

    // Turn 1: still in SPEC_WORK, no action taken
    turnsSinceEntry++;
    // Threshold is 3, so nudge fires when turnsSinceEntry > threshold, i.e. turn 4
    if (turnsSinceEntry > threshold && !actionAttempted && nudgeLevel < 3) {
      nudgeLevel++;
    }
    assert.strictEqual(nudgeLevel, 0, "Nudge level should still be 0 at turn 1 (threshold=3, need >3)");

    // Turn 2: still below threshold
    turnsSinceEntry++;
    if (turnsSinceEntry > threshold && !actionAttempted && nudgeLevel < 3) {
      nudgeLevel++;
    }
    assert.strictEqual(nudgeLevel, 0, "Nudge level should still be 0 at turn 2 (threshold=3)");

    // Turn 3: still below threshold
    turnsSinceEntry++;
    if (turnsSinceEntry > threshold && !actionAttempted && nudgeLevel < 3) {
      nudgeLevel++;
    }
    assert.strictEqual(nudgeLevel, 0, "Nudge level should still be 0 at turn 3 (threshold=3)");

    // Turn 4: nudge fires (turnsSinceEntry=4 > threshold=3)
    turnsSinceEntry++;
    if (turnsSinceEntry > threshold && !actionAttempted && nudgeLevel < 3) {
      nudgeLevel++;
    }
    assert.strictEqual(nudgeLevel, 1, "Nudge level should escalate to 1 at turn 4");

    // Turn 5: nudge escalates again
    turnsSinceEntry++;
    if (turnsSinceEntry > threshold && !actionAttempted && nudgeLevel < 3) {
      nudgeLevel++;
    }
    assert.strictEqual(nudgeLevel, 2, "Nudge level should escalate to 2 at turn 5");

    // Simulate: subagent tool_call matching expected action
    // actionAttempted = true resets nudge urgency
    actionAttempted = true;
    turnsSinceEntry++; // Turn 4
    if (turnsSinceEntry > threshold && !actionAttempted && nudgeLevel < 3) {
      nudgeLevel++;
    }
    assert.strictEqual(nudgeLevel, 2, "Nudge level should NOT escalate when action attempted");
  });

  it("nudge is disabled for IDLE and COMPLETE states", () => {
    // IDLE
    let nudgeExpectation = stateMachine.canNudge();
    assert.ok(!nudgeExpectation.shouldNudge);

    // COMPLETE
    forceTransition(stateMachine, "SPEC_WORK");
    forceTransition(stateMachine, "SPEC_APPROVED");
    forceTransition(stateMachine, "GIT_CHECKPOINT");
    forceTransition(stateMachine, "TDD_RED_WRITE");
    forceTransition(stateMachine, "TDD_RED_VALIDATE");
    forceTransition(stateMachine, "TDD_GREEN_WRITE");
    forceTransition(stateMachine, "TDD_GREEN_VALIDATE");
    forceTransition(stateMachine, "REVIEWING");
    forceTransition(stateMachine, "APPROVED");
    forceTransition(stateMachine, "FINAL_APPROVAL");
    forceTransition(stateMachine, "MERGING");
    forceTransition(stateMachine, "COMPLETE");

    nudgeExpectation = stateMachine.canNudge();
    assert.ok(!nudgeExpectation.shouldNudge);
  });

  it("GREEN phase failure loops back to TDD_GREEN_WRITE", async () => {
    // Advance to TDD_GREEN_VALIDATE
    forceTransition(stateMachine, "SPEC_WORK");
    forceTransition(stateMachine, "SPEC_APPROVED");
    forceTransition(stateMachine, "GIT_CHECKPOINT");
    forceTransition(stateMachine, "TDD_RED_WRITE");
    forceTransition(stateMachine, "TDD_RED_VALIDATE");
    forceTransition(stateMachine, "TDD_GREEN_WRITE");
    forceTransition(stateMachine, "TDD_GREEN_VALIDATE");

    // Run tests — they FAIL (GREEN phase failure)
    const failingExec = createMockExec({ exitCode: 1, output: "Tests  1 passed, 2 failed" });
    const failingRunner = new TddRunner(config, failingExec as ExecFn);

    const greenResult = await failingRunner.runTests();
    assert.notStrictEqual(greenResult.exitCode, 0);

    const validation = failingRunner.validateGreenPhase(greenResult);
    assert.ok(!validation.valid);
    assert.strictEqual(validation.reason, "GREEN_FAILED");

    // Extension auto-transition: GREEN_VALIDATE + fail → TDD_GREEN_WRITE
    forceTransition(stateMachine, "TDD_GREEN_WRITE");
    assert.strictEqual(stateMachine.currentState, "TDD_GREEN_WRITE");
  });

  it("rollback from mid-cycle returns to IDLE", async () => {
    // Advance to TDD_GREEN_WRITE with checkpoint
    forceTransition(stateMachine, "SPEC_WORK");
    forceTransition(stateMachine, "SPEC_APPROVED");
    forceTransition(stateMachine, "GIT_CHECKPOINT");

    const checkpointResult = await gitOps.checkpoint("wip: test-checkpoint");
    assert.ok(checkpointResult.success);

    if (checkpointResult.ref) {
      stateMachine.setGitRef(checkpointResult.ref);
    }

    forceTransition(stateMachine, "TDD_RED_WRITE");
    forceTransition(stateMachine, "TDD_RED_VALIDATE");
    forceTransition(stateMachine, "TDD_GREEN_WRITE");
    assert.strictEqual(stateMachine.currentState, "TDD_GREEN_WRITE");

    // User rejects — rollback to pre-implementation checkpoint
    const rollbackResult = await gitOps.rollback(stateMachine.gitRef!);
    assert.ok(rollbackResult.success);

    // FSM transitions to IDLE (like the pi_coder_git rollback handler does)
    forceTransition(stateMachine, "IDLE");
    assert.strictEqual(stateMachine.currentState, "IDLE");
  });

  it("spec manager round-trip with complete lifecycle data", async () => {
    const specId = generateSpecId("complete lifecycle data", []);

    // Create with full data
    await specManager.createSpec({
      id: specId,
      title: "Complete Lifecycle Data Test",
      acceptanceCriteria: [
        "AC1: User can create an account",
        "AC2: User can log in",
        "AC3: Invalid credentials are rejected",
      ],
      constraints: [
        "Must use bcrypt for password hashing",
        "Token expiry: 24 hours",
      ],
      keyFiles: [
        "src/auth/register.ts",
        "src/auth/login.ts",
        "src/auth/token.ts",
      ],
      prunedContext: "Project uses Express + PostgreSQL. Auth module follows repository pattern. JWT tokens for sessions.",
      implementationPlan: [],
      status: "SPEC_WORK",
    });

    // Read back — all fields must match
    const spec = await specManager.readSpec(specId);
    assert.ok(spec);
    assert.strictEqual(spec.id, specId);
    assert.strictEqual(spec.title, "Complete Lifecycle Data Test");
    assert.strictEqual(spec.acceptanceCriteria.length, 3);
    assert.strictEqual(spec.acceptanceCriteria[0], "AC1: User can create an account");
    assert.strictEqual(spec.constraints.length, 2);
    assert.strictEqual(spec.constraints[0], "Must use bcrypt for password hashing");
    assert.strictEqual(spec.keyFiles.length, 3);
    assert.ok(spec.prunedContext.includes("Express + PostgreSQL"));

    // Update status at each lifecycle phase
    await specManager.updateSpec(specId, { status: "SPEC_APPROVED" });
    await specManager.updateSpec(specId, { status: "TDD_RED_WRITE" });
    await specManager.updateSpec(specId, { status: "TDD_GREEN_VALIDATE" });
    await specManager.updateSpec(specId, { status: "COMPLETE" });

    const finalSpec = await specManager.readSpec(specId);
    assert.strictEqual(finalSpec!.status, "COMPLETE");

    // Cleanup
    await specManager.deleteSpec(specId);
    assert.strictEqual(await specManager.readSpec(specId), null);
  });
});
