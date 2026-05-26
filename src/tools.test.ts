/**
 * Tests for Pi Extension Tools (Spec 07).
 *
 * Phase 1: Tool Registration Framework
 * Phase 2: pi_coder_git tool
 * Phase 3: pi_coder_run_tests tool
 * Phase 4: upsert_knowledge tool
 *
 * All dependencies are mocked — no real pi, git, or filesystem access.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { PiCoderConfig, FSMState, GitCheckpointResult, TestRunResult } from "./types.ts";
import { StateMachine } from "./state-machine.ts";
import { registerTools, type ToolDependencies } from "./tools.ts";

// ---------------------------------------------------------------------------
// Mock Infrastructure
// ---------------------------------------------------------------------------

/** Build a default config for tests. */
function makeConfig(overrides?: Partial<PiCoderConfig>): PiCoderConfig {
  return {
    testCommand: "npm test",
    maxLoops: 3,
    gitStrategy: "branch-and-merge",
    branchPrefix: "pi-coder/",
    nudge: {
      enabled: true,
      defaults: { turnsBeforeNudge: 1, escalationLevels: 3 },
      states: {},
    },
    logging: {
      enabled: false,
      level: "standard",
      maxLogFiles: 10,
    },
    ...overrides,
  };
}

/** Track registered tools. */
interface RegisteredTool {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: unknown;
  execute: (toolCallId: string, params: Record<string, unknown>, signal: unknown, onUpdate: unknown, ctx: unknown) => Promise<unknown>;
}

/** Mock ExtensionAPI that captures tool registrations. */
function createMockPi(): {
  pi: { registerTool: (def: unknown) => void };
  tools: Map<string, RegisteredTool>;
} {
  const tools = new Map<string, RegisteredTool>();

  const pi = {
    registerTool(def: Record<string, unknown>) {
      const tool = def as unknown as RegisteredTool;
      tools.set(tool.name, tool);
    },
  };

  return { pi: pi as unknown as { registerTool: (def: unknown) => void }, tools };
}

/** Mock GitOperations. */
function createMockGitOps() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  let checkoutBranchResult: GitCheckpointResult = { success: true, ref: "abc1234", branch: "pi-coder/test-branch", message: "Created branch" };
  let checkpointResult: GitCheckpointResult = { success: true, ref: "def5678", message: "Committed" };
  let rollbackResult: GitCheckpointResult = { success: true, ref: "abc1234", message: "Rolled back" };
  let mergeResult: GitCheckpointResult = { success: true, ref: "ghi9012", branch: "main", message: "Merged" };
  let currentBranchResult: GitCheckpointResult = { success: true, branch: "pi-coder/test-branch" };

  return {
    calls,
    setCheckoutBranchResult(r: GitCheckpointResult) { checkoutBranchResult = r; },
    setCheckpointResult(r: GitCheckpointResult) { checkpointResult = r; },
    setRollbackResult(r: GitCheckpointResult) { rollbackResult = r; },
    setMergeResult(r: GitCheckpointResult) { mergeResult = r; },
    setCurrentBranchResult(r: GitCheckpointResult) { currentBranchResult = r; },
    gitOps: {
      checkoutBranch(branch: string, baseBranch?: string) {
        calls.push({ method: "checkoutBranch", args: [branch, baseBranch] });
        return Promise.resolve(checkoutBranchResult);
      },
      checkpoint(message: string) {
        calls.push({ method: "checkpoint", args: [message] });
        return Promise.resolve(checkpointResult);
      },
      rollback(ref: string) {
        calls.push({ method: "rollback", args: [ref] });
        return Promise.resolve(rollbackResult);
      },
      merge(branch: string, targetBranch?: string) {
        calls.push({ method: "merge", args: [branch, targetBranch] });
        return Promise.resolve(mergeResult);
      },
      getCurrentBranch() {
        calls.push({ method: "getCurrentBranch", args: [] });
        return Promise.resolve(currentBranchResult);
      },
    },
  };
}

/** Mock TddRunner. */
function createMockTddRunner() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  let runTestsResult: TestRunResult = { exitCode: 1, output: "2 failed", passed: 3, failed: 2, timedOut: false };
  let redValidation = { valid: true };
  let greenValidation = { valid: true };

  return {
    calls,
    setRunTestsResult(r: TestRunResult) { runTestsResult = r; },
    setRedValidation(v: { valid: boolean; reason?: string }) { redValidation = v; },
    setGreenValidation(v: { valid: boolean; reason?: string }) { greenValidation = v; },
    tddRunner: {
      runTests(filter?: string) {
        calls.push({ method: "runTests", args: [filter] });
        return Promise.resolve(runTestsResult);
      },
      validateRedPhase(_result: TestRunResult) {
        return redValidation;
      },
      validateGreenPhase(_result: TestRunResult) {
        return greenValidation;
      },
    },
  };
}

/** Mock KnowledgeStore. */
function createMockKnowledgeStore() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  let upsertResult = "/path/to/knowledge/test-file.md";
  let upsertShouldThrow = false;
  let upsertError = "Invalid filename";

  return {
    calls,
    setUpsertResult(r: string) { upsertResult = r; },
    setUpsertShouldThrow(should: boolean, error?: string) {
      upsertShouldThrow = should;
      upsertError = error ?? "Invalid filename";
    },
    knowledgeStore: {
      upsert(filename: string, content: string) {
        calls.push({ method: "upsert", args: [filename, content] });
        if (upsertShouldThrow) throw new Error(upsertError);
        return upsertResult;
      },
    },
  };
}

function createMockSpecManager() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const specs = new Map<string, { id: string; title: string; acceptanceCriteria: string[]; constraints: string[]; keyFiles: string[]; prunedContext: string; implementationPlan: Array<{ name: string; acceptanceCriteriaIndices: number[]; keyFiles: string[]; dependsOn: string[] }>; status: string }>();
  let createShouldThrow = false;
  let createError = "Spec error";

  return {
    calls,
    specs,
    setCreateShouldThrow(should: boolean, error?: string) {
      createShouldThrow = should;
      createError = error ?? "Spec error";
    },
    specManager: {
      specsDir: "/tmp/test-specs",
      async createSpec(spec: { id: string; title: string; acceptanceCriteria: string[]; constraints: string[]; keyFiles: string[]; prunedContext: string; implementationPlan: Array<{ name: string; acceptanceCriteriaIndices: number[]; keyFiles: string[]; dependsOn: string[] }>; status: string }) {
        calls.push({ method: "createSpec", args: [spec] });
        if (createShouldThrow) throw new Error(createError);
        specs.set(spec.id, spec);
        return `.pi-coder/specs/${spec.id}/spec.md`;
      },
      async readSpec(id: string) {
        calls.push({ method: "readSpec", args: [id] });
        return specs.get(id) ?? null;
      },
      async listSpecs() {
        calls.push({ method: "listSpecs", args: [] });
        return [...specs.keys()];
      },
      async initSpecDir(specId: string, request: string) {
        calls.push({ method: "initSpecDir", args: [specId, request] });
        return `/tmp/test-specs/${specId}`;
      },
      isAbandoned(specId: string) {
        calls.push({ method: "isAbandoned", args: [specId] });
        return false; // Not abandoned in test
      },
      async deleteSpec(specId: string) {
        calls.push({ method: "deleteSpec", args: [specId] });
        specs.delete(specId);
      },
    },
  };
}

/** Build a full set of mock dependencies. */
function setupMocks(config?: PiCoderConfig) {
  const cfg = config ?? makeConfig();
  const sm = new StateMachine(cfg);
  const mockGit = createMockGitOps();
  const mockTdd = createMockTddRunner();
  const mockKnowledge = createMockKnowledgeStore();
  const mockSpec = createMockSpecManager();
  const { pi, tools } = createMockPi();

  let mockActiveSpecId: string | null = null;
  const deps: ToolDependencies = {
    stateMachine: { get current() { return sm; } },
    activeSpecId: { get current() { return mockActiveSpecId; } },
    setActiveSpecId: (id: string | null) => { mockActiveSpecId = id; },
    gitOps: mockGit.gitOps as unknown as import("../git.js").GitOperations,
    tddRunner: mockTdd.tddRunner as unknown as import("../tdd-runner.js").TddRunner,
    knowledgeStore: mockKnowledge.knowledgeStore as unknown as import("../knowledge.js").KnowledgeStore,
    specManager: mockSpec.specManager as unknown as import("../spec.js").SpecManager,
    config: cfg,
  };

  registerTools(pi as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI, deps);

  // Helper to set the mock active spec ID (since tools use the ref)
  const setActiveSpec = (id: string | null) => {
    mockActiveSpecId = id;
  };

  return { sm, mockGit, mockTdd, mockKnowledge, mockSpec, tools, cfg, setActiveSpec };
}

/** Helper: advance the state machine through transitions to a target state. */
function advanceToState(sm: StateMachine, target: FSMState): void {
  const path: FSMState[] = [
    "IDLE", "SPEC_WORK", "SPEC_APPROVED",
    "GIT_CHECKPOINT", "TDD_RED_WRITE", "TDD_RED_VALIDATE",
    "TDD_GREEN_WRITE", "TDD_GREEN_VALIDATE", "REVIEWING",
    "APPROVED", "FINAL_APPROVAL", "MERGING", "COMPLETE",
  ];
  const idx = path.indexOf(target);
  if (idx < 0) throw new Error(`Cannot advance to ${target} via simple path`);
  for (let i = 0; i < idx; i++) {
    const from = path[i];
    const to = path[i + 1];
    // Set required evidence before guarded transitions
    if (from === "SPEC_WORK" && to === "SPEC_APPROVED") {
      sm.setEvidence("spec_saved");
      sm.setEvidence("spec_user_approved");
    }
    if (from === "TDD_RED_VALIDATE" && to === "TDD_GREEN_WRITE") {
      sm.setEvidence("test_run_this_state");
    }
    if (from === "TDD_GREEN_VALIDATE" && (to === "TDD_RED_WRITE" || to === "REVIEWING")) {
      sm.setEvidence("test_run_this_state");
    }
    const result = sm.transition(to);
    if (result) {
      throw new Error(`Transition guard blocked: ${from} → ${to}: ${result.message}`);
    }
  }
}

/** Call a tool's execute method and return the result. */
async function executeTool(tools: Map<string, RegisteredTool>, name: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const tool = tools.get(name);
  assert.ok(tool, `Tool ${name} not registered`);
  return (await tool.execute("test-call-id", params, undefined, undefined, undefined)) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Phase 1: Tool Registration Framework
// ---------------------------------------------------------------------------

describe("Phase 1: Tool Registration Framework", () => {
  it("registers all tools", () => {
    const { tools } = setupMocks();
    assert.ok(tools.has("pi_coder_git"), "pi_coder_git not registered");
    assert.ok(tools.has("pi_coder_run_tests"), "pi_coder_run_tests not registered");
    assert.ok(tools.has("upsert_knowledge"), "upsert_knowledge not registered");
    assert.ok(tools.has("pi_coder_advance_fsm"), "pi_coder_advance_fsm not registered");
    assert.ok(tools.has("pi_coder_save_spec"), "pi_coder_save_spec not registered");
    assert.ok(tools.has("pi_coder_read_spec"), "pi_coder_read_spec not registered");
    assert.strictEqual(tools.size, 6, "Expected exactly 6 tools");
  });

  it("each tool has a promptSnippet", () => {
    const { tools } = setupMocks();
    for (const name of ["pi_coder_git", "pi_coder_run_tests", "upsert_knowledge", "pi_coder_save_spec", "pi_coder_read_spec"]) {
      const tool = tools.get(name)!;
      assert.ok(tool.promptSnippet, `${name} missing promptSnippet`);
      assert.ok(typeof tool.promptSnippet === "string", `${name} promptSnippet must be string`);
      assert.ok(tool.promptSnippet.length > 0, `${name} promptSnippet must be non-empty`);
    }
  });

  it("each tool has promptGuidelines with 2-3 bullets", () => {
    const { tools } = setupMocks();
    for (const name of ["pi_coder_git", "pi_coder_run_tests", "upsert_knowledge", "pi_coder_save_spec", "pi_coder_read_spec"]) {
      const tool = tools.get(name)!;
      assert.ok(tool.promptGuidelines, `${name} missing promptGuidelines`);
      assert.ok(Array.isArray(tool.promptGuidelines), `${name} promptGuidelines must be array`);
      assert.ok(
        tool.promptGuidelines!.length >= 2 && tool.promptGuidelines!.length <= 4,
        `${name} promptGuidelines should have 2-4 bullets, got ${tool.promptGuidelines!.length}`,
      );
    }
  });

  it("each tool has a label and description", () => {
    const { tools } = setupMocks();
    for (const name of ["pi_coder_git", "pi_coder_run_tests", "upsert_knowledge", "pi_coder_save_spec", "pi_coder_read_spec"]) {
      const tool = tools.get(name)!;
      assert.ok(tool.label, `${name} missing label`);
      assert.ok(tool.description, `${name} missing description`);
    }
  });

  it("each tool has parameter schemas", () => {
    const { tools } = setupMocks();
    for (const name of ["pi_coder_git", "pi_coder_run_tests", "upsert_knowledge", "pi_coder_save_spec", "pi_coder_read_spec"]) {
      const tool = tools.get(name)!;
      assert.ok(tool.parameters, `${name} missing parameters schema`);
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 2: pi_coder_git
// ---------------------------------------------------------------------------

describe("Phase 2: pi_coder_git", () => {
  it("blocks when FSM state doesn't allow it", async () => {
    const { tools, sm, setActiveSpec } = setupMocks();
    // IDLE allows pi_coder_git, but RESEARCHING does not
    sm.transition("SPEC_WORK");
    const result = await executeTool(tools, "pi_coder_git", { action: "checkpoint", message: "test" });
    assert.ok(result.isError, "Should be error");
    const content = (result.content as Array<{ text: string }>)[0].text;
    assert.ok(content.includes("not allowed"), `Expected blocked message, got: ${content}`);
    assert.ok(content.includes("SPEC_WORK"), `Should mention current state, got: ${content}`);
  });

  it("allows pi_coder_git in GIT_CHECKPOINT state", async () => {
    const { tools, sm, setActiveSpec } = setupMocks();
    advanceToState(sm, "GIT_CHECKPOINT");
    setActiveSpec("test-spec"); sm.setEvidence("spec_saved"); sm.setEvidence("spec_user_approved");
    const result = await executeTool(tools, "pi_coder_git", { action: "checkpoint", message: "pre-impl" });
    assert.ok(!result.isError, `Should succeed in GIT_CHECKPOINT state, got error: ${JSON.stringify(result.details)}`);
  });

  it("checkout_branch delegates to gitOps.checkoutBranch", async () => {
    const { tools, sm, mockGit, setActiveSpec } = setupMocks();
    advanceToState(sm, "GIT_CHECKPOINT");
    setActiveSpec("test-spec"); sm.setEvidence("spec_saved"); sm.setEvidence("spec_user_approved");
    const result = await executeTool(tools, "pi_coder_git", { action: "checkout_branch", branch: "test-branch" });
    assert.ok(!result.isError, "checkout_branch should succeed");
    assert.strictEqual(mockGit.calls[0].method, "checkoutBranch");
    assert.deepStrictEqual(mockGit.calls[0].args, ["test-branch", undefined]);
  });

  it("checkout_branch requires branch parameter", async () => {
    const { tools, sm, setActiveSpec } = setupMocks();
    advanceToState(sm, "GIT_CHECKPOINT");
    setActiveSpec("test-spec"); sm.setEvidence("spec_saved"); sm.setEvidence("spec_user_approved");
    const result = await executeTool(tools, "pi_coder_git", { action: "checkout_branch" });
    assert.ok(result.isError, "Should require branch param");
    const content = (result.content as Array<{ text: string }>)[0].text;
    assert.ok(content.includes("branch parameter is required"), `Expected branch required error, got: ${content}`);
  });

  it("checkpoint stores ref in state machine", async () => {
    const { tools, sm, mockGit, setActiveSpec } = setupMocks();
    advanceToState(sm, "GIT_CHECKPOINT");
    setActiveSpec("test-spec"); sm.setEvidence("spec_saved"); sm.setEvidence("spec_user_approved");
    setActiveSpec("test-spec"); sm.setEvidence("spec_saved");
    await executeTool(tools, "pi_coder_git", { action: "checkpoint", message: "pre-impl" });
    assert.strictEqual(sm.gitRef, "def5678", "Ref should be stored in state machine after checkpoint");
  });

  it("checkpoint uses default message when none provided", async () => {
    const { tools, sm, mockGit, setActiveSpec } = setupMocks();
    advanceToState(sm, "GIT_CHECKPOINT");
    setActiveSpec("test-spec"); sm.setEvidence("spec_saved"); sm.setEvidence("spec_user_approved");
    sm.setActiveSpec("my-spec");
    await executeTool(tools, "pi_coder_git", { action: "checkpoint" });
    assert.strictEqual(mockGit.calls[0].args[0], "wip: checkpoint-test-spec");
  });

  it("rollback transitions FSM to IDLE", async () => {
    const { tools, sm, mockGit, setActiveSpec } = setupMocks();
    advanceToState(sm, "GIT_CHECKPOINT");
    setActiveSpec("test-spec"); sm.setEvidence("spec_saved"); sm.setEvidence("spec_user_approved");
    sm.setActiveSpec("test-spec", "original-ref");
    const result = await executeTool(tools, "pi_coder_git", { action: "rollback" });
    assert.ok(!result.isError, "rollback should succeed");
    assert.strictEqual(sm.currentState, "IDLE", "FSM should transition to IDLE after rollback");
    assert.strictEqual(mockGit.calls[0].method, "rollback");
    assert.strictEqual(mockGit.calls[0].args[0], "original-ref", "Should rollback to stored git ref");
  });

  it("rollback fails when no git ref stored", async () => {
    const { tools, sm, setActiveSpec } = setupMocks();
    advanceToState(sm, "GIT_CHECKPOINT");
    setActiveSpec("test-spec"); sm.setEvidence("spec_saved"); sm.setEvidence("spec_user_approved");
    setActiveSpec("test-spec"); sm.setEvidence("spec_saved"); // No gitRef provided
    const result = await executeTool(tools, "pi_coder_git", { action: "rollback" });
    assert.ok(result.isError, "Should fail without stored ref");
    const content = (result.content as Array<{ text: string }>)[0].text;
    assert.ok(content.includes("No git ref stored"), `Expected no-ref error, got: ${content}`);
  });

  it("merge calls gitOps.merge with current branch", async () => {
    const { tools, sm, mockGit, setActiveSpec } = setupMocks();
    advanceToState(sm, "MERGING");
    setActiveSpec("test-spec"); sm.setEvidence("spec_saved"); sm.setEvidence("spec_user_approved");
    await executeTool(tools, "pi_coder_git", { action: "merge" });
    assert.strictEqual(mockGit.calls[0].method, "getCurrentBranch");
    assert.strictEqual(mockGit.calls[1].method, "merge");
  });

  it("failed git operations return structured error, not exceptions", async () => {
    const { tools, sm, mockGit, setActiveSpec } = setupMocks();
    advanceToState(sm, "GIT_CHECKPOINT");
    setActiveSpec("test-spec"); sm.setEvidence("spec_saved"); sm.setEvidence("spec_user_approved");
    mockGit.setCheckpointResult({ success: false, error: "git failed catastrophically" });
    const result = await executeTool(tools, "pi_coder_git", { action: "checkpoint", message: "test" });
    assert.ok(result.isError, "Should be error");
    const details = result.details as GitCheckpointResult;
    assert.strictEqual(details.success, false);
    assert.ok(details.error, "Should include error message");
  });

  it("returns GitCheckpointResult in details", async () => {
    const { tools, sm, mockGit, setActiveSpec } = setupMocks();
    advanceToState(sm, "GIT_CHECKPOINT");
    setActiveSpec("test-spec"); sm.setEvidence("spec_saved"); sm.setEvidence("spec_user_approved");
    const result = await executeTool(tools, "pi_coder_git", { action: "checkpoint", message: "test" });
    const details = result.details as GitCheckpointResult;
    assert.strictEqual(details.success, true);
    assert.ok(details.ref, "Should include ref");
  });
});

// ---------------------------------------------------------------------------
// Phase 3: pi_coder_run_tests
// ---------------------------------------------------------------------------

describe("Phase 3: pi_coder_run_tests", () => {
  it("blocks when FSM state is not RED_VALIDATE or GREEN_VALIDATE", async () => {
    const { tools, sm, setActiveSpec } = setupMocks();
    // IDLE state — should block
    const result = await executeTool(tools, "pi_coder_run_tests", {});
    assert.ok(result.isError, "Should be error in IDLE state");
    const content = (result.content as Array<{ text: string }>)[0].text;
    assert.ok(content.includes("not allowed"), `Expected blocked message, got: ${content}`);
  });

  it("allows in TDD_RED_VALIDATE state", async () => {
    const { tools, sm, setActiveSpec } = setupMocks();
    advanceToState(sm, "TDD_RED_VALIDATE");
    setActiveSpec("test-spec"); sm.setEvidence("spec_saved"); sm.setEvidence("spec_user_approved");
    const result = await executeTool(tools, "pi_coder_run_tests", {});
    assert.ok(!result.isError, "Should succeed in RED_VALIDATE state");
  });

  it("allows in TDD_GREEN_VALIDATE state", async () => {
    const { tools, sm, setActiveSpec } = setupMocks();
    advanceToState(sm, "TDD_GREEN_VALIDATE");
    setActiveSpec("test-spec"); sm.setEvidence("spec_saved"); sm.setEvidence("spec_user_approved");
    const result = await executeTool(tools, "pi_coder_run_tests", {});
    assert.ok(!result.isError, "Should succeed in GREEN_VALIDATE state");
  });

  it("delegates to tddRunner.runTests with filter", async () => {
    const { tools, sm, mockTdd, setActiveSpec } = setupMocks();
    advanceToState(sm, "TDD_RED_VALIDATE");
    setActiveSpec("test-spec"); sm.setEvidence("spec_saved"); sm.setEvidence("spec_user_approved");
    await executeTool(tools, "pi_coder_run_tests", { filter: "--grep auth" });
    assert.strictEqual(mockTdd.calls[0].method, "runTests");
    assert.strictEqual(mockTdd.calls[0].args[0], "--grep auth");
  });

  it("calls validateRedPhase in RED_VALIDATE state", async () => {
    const { tools, sm, setActiveSpec } = setupMocks();
    advanceToState(sm, "TDD_RED_VALIDATE");
    setActiveSpec("test-spec"); sm.setEvidence("spec_saved"); sm.setEvidence("spec_user_approved");
    const result = await executeTool(tools, "pi_coder_run_tests", {});
    const details = result.details as Record<string, unknown>;
    assert.strictEqual(details.phase, "RED");
    assert.strictEqual(details.validation?.valid, true);
  });

  it("calls validateGreenPhase in GREEN_VALIDATE state", async () => {
    const { tools, sm, setActiveSpec } = setupMocks();
    advanceToState(sm, "TDD_GREEN_VALIDATE");
    setActiveSpec("test-spec"); sm.setEvidence("spec_saved"); sm.setEvidence("spec_user_approved");
    const result = await executeTool(tools, "pi_coder_run_tests", {});
    const details = result.details as Record<string, unknown>;
    assert.strictEqual(details.phase, "GREEN");
    assert.strictEqual(details.validation?.valid, true);
  });

  it("returns both test result and validation verdict", async () => {
    const { tools, sm, setActiveSpec } = setupMocks();
    advanceToState(sm, "TDD_RED_VALIDATE");
    setActiveSpec("test-spec"); sm.setEvidence("spec_saved"); sm.setEvidence("spec_user_approved");
    const result = await executeTool(tools, "pi_coder_run_tests", {});
    const details = result.details as Record<string, unknown>;
    assert.ok(details.testResult, "Should include testResult");
    assert.ok(details.validation, "Should include validation");
    assert.ok(typeof details.exitCode === "number", "Should include exitCode");
  });

  it("returns isError true when validation fails", async () => {
    const { tools, sm, mockTdd, setActiveSpec } = setupMocks();
    advanceToState(sm, "TDD_RED_VALIDATE");
    setActiveSpec("test-spec"); sm.setEvidence("spec_saved"); sm.setEvidence("spec_user_approved");
    mockTdd.setRedValidation({ valid: false, reason: "RED_TAUTOLOGY" });
    mockTdd.setRunTestsResult({ exitCode: 0, output: "All passed", passed: 5, failed: 0, timedOut: false });
    const result = await executeTool(tools, "pi_coder_run_tests", {});
    assert.ok(result.isError, "Should be error when validation fails");
    const content = (result.content as Array<{ text: string }>)[0].text;
    assert.ok(content.includes("RED_TAUTOLOGY"), `Should include reason, got: ${content}`);
  });

  it("does NOT auto-transition the FSM", async () => {
    const { tools, sm, setActiveSpec } = setupMocks();
    advanceToState(sm, "TDD_RED_VALIDATE");
    setActiveSpec("test-spec"); sm.setEvidence("spec_saved"); sm.setEvidence("spec_user_approved");
    await executeTool(tools, "pi_coder_run_tests", {});
    assert.strictEqual(sm.currentState, "TDD_RED_VALIDATE", "State should remain unchanged after tool executes");
  });
});

// ---------------------------------------------------------------------------
// Phase 4: upsert_knowledge
// ---------------------------------------------------------------------------

describe("Phase 4: upsert_knowledge", () => {
  it("succeeds and writes file", async () => {
    const { tools, mockKnowledge } = setupMocks();
    const result = await executeTool(tools, "upsert_knowledge", {
      filename: "test-file.md",
      content: "# Test Knowledge\nSome learning here.",
    });
    assert.ok(!result.isError, "Should succeed");
    assert.strictEqual(mockKnowledge.calls[0].method, "upsert");
    assert.strictEqual(mockKnowledge.calls[0].args[0], "test-file.md");
    assert.strictEqual(mockKnowledge.calls[0].args[1], "# Test Knowledge\nSome learning here.");
  });

  it("returns success and path on success", async () => {
    const { tools } = setupMocks();
    const result = await executeTool(tools, "upsert_knowledge", {
      filename: "valid-file.md",
      content: "content",
    });
    const details = result.details as Record<string, unknown>;
    assert.strictEqual(details.success, true);
    assert.ok(details.path, "Should include file path");
  });

  it("works in any FSM state", async () => {
    const { tools, sm, setActiveSpec } = setupMocks();
    advanceToState(sm, "TDD_RED_VALIDATE"); // A restricted state for other tools
    setActiveSpec("test-spec"); sm.setEvidence("spec_saved"); sm.setEvidence("spec_user_approved");
    const result = await executeTool(tools, "upsert_knowledge", {
      filename: "any-state.md",
      content: "works everywhere",
    });
    assert.ok(!result.isError, "upsert_knowledge should work in any state");
  });

  it("rejects invalid filenames with clear error", async () => {
    const { tools, mockKnowledge } = setupMocks();
    mockKnowledge.setUpsertShouldThrow(true, 'Invalid knowledge filename "bad": knowledge files must be markdown (end in .md). Rules: must end in .md, stem must be 3-50 characters of lowercase alphanumeric and hyphens only.');
    const result = await executeTool(tools, "upsert_knowledge", {
      filename: "bad",
      content: "content",
    });
    assert.ok(result.isError, "Should be error for invalid filename");
    const details = result.details as Record<string, unknown>;
    assert.strictEqual(details.success, false);
    assert.ok(details.error, "Should include error message");
    const content = (result.content as Array<{ text: string }>)[0].text;
    assert.ok(content.includes("Invalid"), `Should mention invalid, got: ${content}`);
  });
});

// ---------------------------------------------------------------------------
// Phase 5: pi_coder_advance_fsm
// ---------------------------------------------------------------------------

describe("Phase 5: pi_coder_advance_fsm", () => {
  it("advances IDLE → SPEC_WORK", async () => {
    const { tools, sm, setActiveSpec, mockSpec } = setupMocks();
    assert.strictEqual(sm.currentState, "IDLE");
    const result = await executeTool(tools, "pi_coder_advance_fsm", {
      targetState: "SPEC_WORK",
      request: "Add drag and drop to the kanban board",
    });
    assert.ok(!result.isError, "Should succeed");
    assert.strictEqual(sm.currentState, "SPEC_WORK");
    const details = result.details as Record<string, unknown>;
    assert.strictEqual(details.previousState, "IDLE");
    assert.strictEqual(details.newState, "SPEC_WORK");
    // Verify spec directory was initialized
    assert.strictEqual(mockSpec.calls[0].method, "listSpecs");
    assert.strictEqual(mockSpec.calls[1].method, "initSpecDir");
  });

  it("advances SPEC_WORK → SPEC_APPROVED", async () => {
    const { tools, sm, setActiveSpec } = setupMocks();
    sm.transition("SPEC_WORK");
    sm.setEvidence("spec_saved");
    sm.setEvidence("spec_user_approved");
    const result = await executeTool(tools, "pi_coder_advance_fsm", {
      targetState: "SPEC_APPROVED",
    });
    assert.ok(!result.isError, "Should succeed");
    assert.strictEqual(sm.currentState, "SPEC_APPROVED");
  });

  it("blocks SPEC_WORK → SPEC_APPROVED without saved spec", async () => {
    const { tools, sm, setActiveSpec } = setupMocks();
    sm.transition("SPEC_WORK");
    // No setActiveSpec — simulates orchestrator forgetting to save
    const result = await executeTool(tools, "pi_coder_advance_fsm", {
      targetState: "SPEC_APPROVED",
    });
    assert.ok(result.isError, "Should be error");
    assert.strictEqual(sm.currentState, "SPEC_WORK", "State should not change");
    const content = (result.content as Array<{ text: string }>)[0].text;
    assert.ok(content.includes("pi_coder_save_spec"), `Should mention save_spec tool, got: ${content}`);
  });

  it("rejects illegal transition with valid options", async () => {
    const { tools, sm, setActiveSpec } = setupMocks();
    // IDLE → SPEC_APPROVED is illegal (must go through SPEC_WORK)
    const result = await executeTool(tools, "pi_coder_advance_fsm", {
      targetState: "SPEC_APPROVED",
    });
    assert.ok(result.isError, "Should be error for illegal transition");
    assert.strictEqual(sm.currentState, "IDLE", "State should not change on error");
    const details = result.details as Record<string, unknown>;
    assert.strictEqual(details.success, false);
    const validTargets = details.validTargets as string[];
    assert.ok(validTargets.includes("SPEC_WORK"), "Should list SPEC_WORK as valid target");
    const content = (result.content as Array<{ text: string }>)[0].text;
    assert.ok(content.includes("SPEC_WORK"), `Should mention valid targets, got: ${content}`);
  });

  it("rejects invalid state name", async () => {
    const { tools, sm, setActiveSpec } = setupMocks();
    const result = await executeTool(tools, "pi_coder_advance_fsm", {
      targetState: "INVALID_STATE",
    });
    assert.ok(result.isError, "Should be error for invalid state name");
    assert.strictEqual(sm.currentState, "IDLE", "State should not change on error");
    const content = (result.content as Array<{ text: string }>)[0].text;
    assert.ok(content.includes("Invalid state"), `Should mention invalid state, got: ${content}`);
  });

  it("allows abort from any state to IDLE", async () => {
    const { tools, sm, setActiveSpec } = setupMocks();
    sm.transition("SPEC_WORK");
    sm.setEvidence("spec_saved");
    sm.setEvidence("spec_user_approved");
    sm.transition("SPEC_APPROVED");
    sm.transition("GIT_CHECKPOINT");
    const result = await executeTool(tools, "pi_coder_advance_fsm", {
      targetState: "IDLE",
    });
    assert.ok(!result.isError, "Should succeed");
    assert.strictEqual(sm.currentState, "IDLE");
  });

  it("includes next-action hint in transition output", async () => {
    const { tools, sm } = setupMocks();
    const result = await executeTool(tools, "pi_coder_advance_fsm", {
      targetState: "SPEC_WORK",
      request: "Fix the login bug",
    });
    const content = (result.content as Array<{ text: string }>)[0].text;
    assert.ok(content.includes("FSM advanced: IDLE → SPEC_WORK"), `Should include transition, got: ${content}`);
    assert.ok(content.includes("Next:"), `Should include next-action hint, got: ${content}`);
    assert.ok(content.includes("researcher"), `Should mention researcher delegation, got: ${content}`);
  });

  it("includes GREEN_WRITE delegation hint", async () => {
    const { tools, sm, setActiveSpec } = setupMocks();
    sm.transition("SPEC_WORK");
    setActiveSpec("test-spec"); sm.setEvidence("spec_saved"); sm.setEvidence("spec_user_approved");
    sm.transition("SPEC_APPROVED");
    sm.transition("GIT_CHECKPOINT");
    sm.transition("TDD_RED_WRITE");
    sm.transition("TDD_RED_VALIDATE");
    sm.setEvidence("test_run_this_state"); // Simulate running tests in RED_VALIDATE
    sm.transition("TDD_GREEN_WRITE");
    // Now advance from GREEN_WRITE to GREEN_VALIDATE
    const result = await executeTool(tools, "pi_coder_advance_fsm", {
      targetState: "TDD_GREEN_VALIDATE",
    });
    const content = (result.content as Array<{ text: string }>)[0].text;
    assert.ok(content.includes("TDD_GREEN_WRITE → TDD_GREEN_VALIDATE"), `Should include transition, got: ${content}`);
    assert.ok(content.includes("GREEN validation"), `Should mention GREEN validation, got: ${content}`);
  });
});

// ---------------------------------------------------------------------------
// Phase 6: pi_coder_save_spec / pi_coder_read_spec
// ---------------------------------------------------------------------------

describe("Phase 6: Spec File Tools", () => {
  it("saves a spec and sets activeSpecId", async () => {
    const { tools, sm, mockSpec } = setupMocks();
    assert.strictEqual(sm.activeSpecId, null);
    const result = await executeTool(tools, "pi_coder_save_spec", {
      id: "user-auth",
      title: "User Authentication",
      acceptanceCriteria: ["Users can log in", "Users can log out"],
      constraints: ["Must use existing auth middleware"],
      keyFiles: ["src/auth.ts"],
      prunedContext: "Auth module uses JWT tokens",
      implementationPlan: [
        { name: "Login flow", acceptanceCriteriaIndices: [0], keyFiles: ["src/auth.ts"], dependsOn: [] },
        { name: "Logout flow", acceptanceCriteriaIndices: [1], keyFiles: ["src/auth.ts"], dependsOn: ["Login flow"] },
      ],
    });
    assert.ok(!result.isError, "Should succeed");
    const content = (result.content as Array<{ text: string }>)[0].text;
    assert.ok(content.includes("user-auth"), `Should mention spec ID, got: ${content}`);
    // Verify activeSpecId was set (via setActiveSpecId mock)
    // and evidence was set
    assert.ok(sm.hasEvidence("spec_saved"));
    // Verify specManager was called
    assert.strictEqual(mockSpec.calls.length, 1);
    assert.strictEqual(mockSpec.calls[0].method, "createSpec");
  });

  it("saves a spec without implementation plan", async () => {
    const { tools, sm, setActiveSpec } = setupMocks();
    const result = await executeTool(tools, "pi_coder_save_spec", {
      id: "simple-feature",
      title: "Simple Feature",
      acceptanceCriteria: ["Feature works"],
      constraints: [],
      keyFiles: ["src/feature.ts"],
      prunedContext: "Simple feature context",
    });
    assert.ok(!result.isError, "Should succeed");
    assert.ok(sm.hasEvidence("spec_saved"));
  });

  it("reads a spec that was saved", async () => {
    const { tools, mockSpec } = setupMocks();
    // First save
    await executeTool(tools, "pi_coder_save_spec", {
      id: "user-auth",
      title: "User Authentication",
      acceptanceCriteria: ["Users can log in"],
      constraints: ["Must use JWT"],
      keyFiles: ["src/auth.ts"],
      prunedContext: "Auth module uses JWT",
    });
    // Then read
    const result = await executeTool(tools, "pi_coder_read_spec", {
      id: "user-auth",
    });
    assert.ok(!result.isError, "Should succeed");
    const content = (result.content as Array<{ text: string }>)[0].text;
    assert.ok(content.includes("User Authentication"), `Should include title, got: ${content}`);
    assert.ok(content.includes("Users can log in"), `Should include AC, got: ${content}`);
    assert.ok(content.includes("Must use JWT"), `Should include constraint, got: ${content}`);
  });

  it("returns error when reading non-existent spec", async () => {
    const { tools } = setupMocks();
    const result = await executeTool(tools, "pi_coder_read_spec", {
      id: "does-not-exist",
    });
    assert.ok(result.isError, "Should be error for missing spec");
    const content = (result.content as Array<{ text: string }>)[0].text;
    assert.ok(content.includes("not found"), `Should say not found, got: ${content}`);
  });

  it("handles save errors gracefully", async () => {
    const { tools, mockSpec } = setupMocks();
    mockSpec.setCreateShouldThrow(true, "Disk full");
    const result = await executeTool(tools, "pi_coder_save_spec", {
      id: "broken",
      title: "Broken Spec",
      acceptanceCriteria: [],
      constraints: [],
      keyFiles: [],
      prunedContext: "",
    });
    assert.ok(result.isError, "Should be error for failed save");
    const content = (result.content as Array<{ text: string }>)[0].text;
    assert.ok(content.includes("Disk full"), `Should mention error, got: ${content}`);
  });
});
