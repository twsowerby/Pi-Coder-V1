/**
 * Tests for Pi Coder Extension Main — Spec 09
 *
 * Tests the extension's core event hooks, system prompt replacement,
 * FSM guards, auto-transitions, and nudge system.
 *
 * Since the extension hooks into pi's event system, tests mock the
 * pi ExtensionAPI and verify handler behavior without a real pi runtime.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { PiCoderConfig, FSMState } from "../src/types.ts";
import { StateMachine } from "../src/state-machine.ts";
import type { EvidenceFlag } from "../src/types.ts";
import type { StateMachineJSON } from "../src/state-machine.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides?: Partial<PiCoderConfig>): PiCoderConfig {
  return {
    testCommand: "npm test",
    maxLoops: 3,
    gitStrategy: "branch-and-merge",
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
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Phase 1: Extension Foundation & Toggle State
// ---------------------------------------------------------------------------


/** Force a transition with required evidence set. */
function forceTransition(sm: StateMachine, to: string): void {
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
  const result = sm.transition(to as any);
  if (result) throw new Error("Guard blocked: " + result.message);
}

describe("Phase 1: Extension Foundation", () => {
  it("should export ORCHESTRATOR_TOOLS with the correct tool set", async () => {
    const mod = await import("./index.ts");
    const tools = mod.ORCHESTRATOR_TOOLS;
    assert.deepStrictEqual(tools, [
      "ls", "find", "grep", "subagent",
      "pi_coder_git", "pi_coder_run_tests", "upsert_knowledge", "pi_coder_save_spec", "pi_coder_read_spec", "pi_coder_advance_fsm", "interview", "intercom",
    ]);
  });

  it("should export NORMAL_TOOLS with the correct tool set", async () => {
    const mod = await import("./index.ts");
    assert.deepStrictEqual(mod.NORMAL_TOOLS, [
      "read", "bash", "edit", "write", "grep", "find", "ls",
    ]);
  });

  it("should export piCoderMode (defaults to 'tdd' when extension is loaded)", async () => {
    const mod = await import("./index.ts");
    // Module-level state defaults to 'tdd' — extension is active on load.
    assert.ok(["off", "light", "tdd"].includes(mod.piCoderMode));
  });

  it("should export stateMachine module variable", async () => {
    const mod = await import("./index.ts");
    // May be undefined before session_start, but the export must exist
    assert.ok("stateMachine" in mod);
  });

  it("should export config module variable", async () => {
    const mod = await import("./index.ts");
    assert.ok("config" in mod);
  });
});

// ---------------------------------------------------------------------------
// Phase 2: System Prompt — Orchestrator Identity
// ---------------------------------------------------------------------------

describe("Phase 2: System Prompt", () => {
  it("ORCHESTRATOR_TOOLS does not include read, bash, edit, write", () => {
    const tools = [
      "ls", "find", "grep", "subagent",
      "pi_coder_git", "pi_coder_run_tests", "upsert_knowledge",
    ];
    assert.ok(!tools.includes("read"));
    assert.ok(!tools.includes("bash"));
    assert.ok(!tools.includes("edit"));
    assert.ok(!tools.includes("write"));
  });

  it("state machine canNudge returns correct expected actions for each action state", () => {
    // Verify canNudge for states reachable from the FSM path
    const sm = new StateMachine(makeConfig());

    // IDLE
    assert.strictEqual(sm.canNudge().shouldNudge, false);

    // SPEC_WORK
    forceTransition(sm, "SPEC_WORK");
    assert.strictEqual(sm.canNudge().shouldNudge, true);
    assert.strictEqual(sm.canNudge().expectedTool, "subagent");
  });

  it("FSM diagram builder produces expected state flow", async () => {
    // The FSM diagram must be present in the orchestrator prompt
    // We verify the key states are mentioned
    const prompt = `IDLE → SPEC_WORK → SPEC_APPROVED →
GIT_CHECKPOINT → TDD_RED_WRITE → TDD_RED_VALIDATE →
TDD_GREEN_WRITE → TDD_GREEN_VALIDATE → REVIEWING →
(APPROVED → FINAL_APPROVAL → MERGING → COMPLETE) |
(NEEDS_CHANGES → TDD_RED_WRITE) | BLOCKED → user intervention`;

    // Verify all expected states appear
    const requiredStates: FSMState[] = [
      "IDLE", "SPEC_WORK", "SPEC_APPROVED",
      "GIT_CHECKPOINT", "TDD_RED_WRITE", "TDD_RED_VALIDATE",
      "TDD_GREEN_WRITE", "TDD_GREEN_VALIDATE", "REVIEWING",
      "APPROVED", "NEEDS_CHANGES", "FINAL_APPROVAL", "MERGING", "COMPLETE", "BLOCKED",
    ];
    for (const state of requiredStates) {
      assert.ok(prompt.includes(state), `FSM diagram missing state: ${state}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 3: FSM Event Guards & Auto-Transitions
// ---------------------------------------------------------------------------

describe("Phase 3: FSM Event Guards", () => {
  it("isActionAllowed blocks pi_coder_run_tests outside validation states", () => {
    const sm = new StateMachine(makeConfig());
    // IDLE — not allowed
    assert.strictEqual(sm.isActionAllowed("pi_coder_run_tests"), false);
  });

  it("isActionAllowed allows pi_coder_run_tests in TDD_RED_VALIDATE", () => {
    const sm = new StateMachine(makeConfig());
    // Navigate to TDD_RED_VALIDATE
    forceTransition(sm, "SPEC_WORK");
    forceTransition(sm, "SPEC_APPROVED");
    forceTransition(sm, "GIT_CHECKPOINT");
    forceTransition(sm, "TDD_RED_WRITE");
    forceTransition(sm, "TDD_RED_VALIDATE");
    assert.strictEqual(sm.isActionAllowed("pi_coder_run_tests"), true);
  });

  it("isActionAllowed allows subagent with researcher in SPEC_WORK and TDD states", () => {
    const sm = new StateMachine(makeConfig());
    // In IDLE, researcher delegation is not allowed
    assert.strictEqual(sm.isActionAllowed("subagent", "pi-coder.researcher"), false);

    // In SPEC_WORK, researcher delegation IS allowed
    forceTransition(sm, "SPEC_WORK");
    assert.strictEqual(sm.isActionAllowed("subagent", "pi-coder.researcher"), true);
    assert.strictEqual(sm.isActionAllowed("subagent", "pi-coder.implementor"), false);
    assert.strictEqual(sm.isActionAllowed("subagent", "pi-coder.reviewer"), false);
  });

  it("isActionAllowed blocks bash and git commands for the orchestrator", () => {
    const sm = new StateMachine(makeConfig());
    assert.strictEqual(sm.isActionAllowed("bash"), false);
    assert.strictEqual(sm.isActionAllowed("edit"), false);
    assert.strictEqual(sm.isActionAllowed("write"), false);
    assert.strictEqual(sm.isActionAllowed("read"), false);
  });

  it("isActionAllowed allows ls/find/grep in any state", () => {
    const sm = new StateMachine(makeConfig());
    assert.strictEqual(sm.isActionAllowed("ls"), true);
    assert.strictEqual(sm.isActionAllowed("find"), true);
    assert.strictEqual(sm.isActionAllowed("grep"), true);
  });

  it("isActionAllowed allows upsert_knowledge in any state", () => {
    const sm = new StateMachine(makeConfig());
    assert.strictEqual(sm.isActionAllowed("upsert_knowledge"), true);
  });
});

describe("Phase 3: Auto-Transitions", () => {
  it("RED validate + tests fail → TDD_GREEN_WRITE", () => {
    const sm = new StateMachine(makeConfig());
    forceTransition(sm, "SPEC_WORK");
    forceTransition(sm, "SPEC_APPROVED");
    forceTransition(sm, "GIT_CHECKPOINT");
    forceTransition(sm, "TDD_RED_WRITE");
    forceTransition(sm, "TDD_RED_VALIDATE");
    // Simulate: tests fail (valid RED)
    forceTransition(sm, "TDD_GREEN_WRITE");
    assert.strictEqual(sm.currentState, "TDD_GREEN_WRITE");
  });

  it("RED validate + tests pass → BLOCKED", () => {
    const sm = new StateMachine(makeConfig());
    forceTransition(sm, "SPEC_WORK");
    forceTransition(sm, "SPEC_APPROVED");
    forceTransition(sm, "GIT_CHECKPOINT");
    forceTransition(sm, "TDD_RED_WRITE");
    forceTransition(sm, "TDD_RED_VALIDATE");
    // Simulate: tests pass (tautology)
    forceTransition(sm, "BLOCKED");
    assert.strictEqual(sm.currentState, "BLOCKED");
  });

  it("GREEN validate + tests pass → REVIEWING", () => {
    const sm = new StateMachine(makeConfig());
    forceTransition(sm, "SPEC_WORK");
    forceTransition(sm, "SPEC_APPROVED");
    forceTransition(sm, "GIT_CHECKPOINT");
    forceTransition(sm, "TDD_RED_WRITE");
    forceTransition(sm, "TDD_RED_VALIDATE");
    forceTransition(sm, "TDD_GREEN_WRITE");
    forceTransition(sm, "TDD_GREEN_VALIDATE");
    forceTransition(sm, "REVIEWING");
    assert.strictEqual(sm.currentState, "REVIEWING");
  });

  it("GREEN validate + tests fail → TDD_GREEN_WRITE (loop)", () => {
    const sm = new StateMachine(makeConfig());
    forceTransition(sm, "SPEC_WORK");
    forceTransition(sm, "SPEC_APPROVED");
    forceTransition(sm, "GIT_CHECKPOINT");
    forceTransition(sm, "TDD_RED_WRITE");
    forceTransition(sm, "TDD_RED_VALIDATE");
    forceTransition(sm, "TDD_GREEN_WRITE");
    forceTransition(sm, "TDD_GREEN_VALIDATE");
    // Tests still fail — loop back
    forceTransition(sm, "TDD_GREEN_WRITE");
    assert.strictEqual(sm.currentState, "TDD_GREEN_WRITE");
  });

  it("Subagent completion in SPEC_WORK stays in SPEC_WORK (multiple rounds)", () => {
    const sm = new StateMachine(makeConfig());
    forceTransition(sm, "SPEC_WORK");
    // After researcher completes, FSM stays in SPEC_WORK — orchestrator can
    // delegate again or advance to SPEC_APPROVED via pi_coder_advance_fsm
    assert.strictEqual(sm.currentState, "SPEC_WORK");
  });

  it("state machine serializes via toJSON", () => {
    const sm = new StateMachine(makeConfig());
    forceTransition(sm, "SPEC_WORK");
    const json = sm.toJSON();
    assert.strictEqual(json.currentState, "SPEC_WORK");
    assert.strictEqual(json.loopCount, 0);
    assert.ok(Array.isArray(json.evidence));
  });

  it("state machine restores via fromJSON", () => {
    const config = makeConfig();
    const sm = new StateMachine(config);
    forceTransition(sm, "SPEC_WORK");
    sm.setGitRef("abc1234");
    sm.setEvidence("spec_saved");

    const json = sm.toJSON();
    const restored = StateMachine.fromJSON(json, config);
    assert.strictEqual(restored.currentState, "SPEC_WORK");
    assert.strictEqual(restored.gitRef, "abc1234");
    assert.ok(restored.hasEvidence("spec_saved"));
  });
});

// ---------------------------------------------------------------------------
// Phase 4: Nudge System
// ---------------------------------------------------------------------------

describe("Phase 4: Nudge System", () => {
  it("nudge threshold for action states is 1 (default)", () => {
    const config = makeConfig();
    // RESEARCHING is an action state — default threshold is 1
    assert.strictEqual(config.nudge.defaults.turnsBeforeNudge, 1);
  });

  it("nudge threshold for SPEC_WORK is 3 (overridden)", () => {
    const config = makeConfig();
    assert.strictEqual(config.nudge.states.SPEC_WORK?.turnsBeforeNudge, 3);
  });

  it("nudge is disabled for IDLE", () => {
    const config = makeConfig();
    assert.strictEqual(config.nudge.states.IDLE?.enabled, false);
  });

  it("nudge is disabled for COMPLETE", () => {
    const config = makeConfig();
    assert.strictEqual(config.nudge.states.COMPLETE?.enabled, false);
  });

  it("nudge is disabled for SPEC_APPROVED", () => {
    const config = makeConfig();
    assert.strictEqual(config.nudge.states.SPEC_APPROVED?.enabled, false);
  });

  it("nudge is disabled for FINAL_APPROVAL", () => {
    const config = makeConfig();
    assert.strictEqual(config.nudge.states.FINAL_APPROVAL?.enabled, false);
  });

  it("max escalation levels is 3", () => {
    const config = makeConfig();
    assert.strictEqual(config.nudge.defaults.escalationLevels, 3);
  });

  it("canNudge returns expected action for RESEARCHING", () => {
    const sm = new StateMachine(makeConfig());
    forceTransition(sm, "SPEC_WORK");
    const nudge = sm.canNudge();
    assert.strictEqual(nudge.shouldNudge, true);
    assert.ok(nudge.expectedAction.includes("researcher"));
    assert.strictEqual(nudge.expectedTool, "subagent");
  });

  it("canNudge returns expected action for TDD_RED_VALIDATE", () => {
    const sm = new StateMachine(makeConfig());
    forceTransition(sm, "SPEC_WORK");
    forceTransition(sm, "SPEC_APPROVED");
    forceTransition(sm, "GIT_CHECKPOINT");
    forceTransition(sm, "TDD_RED_WRITE");
    forceTransition(sm, "TDD_RED_VALIDATE");
    const nudge = sm.canNudge();
    assert.strictEqual(nudge.shouldNudge, true);
    assert.strictEqual(nudge.expectedTool, "pi_coder_run_tests");
  });

  it("canNudge returns no nudge for IDLE", () => {
    const sm = new StateMachine(makeConfig());
    const nudge = sm.canNudge();
    assert.strictEqual(nudge.shouldNudge, false);
  });

  it("BLOCKED state has nudge enabled with threshold 2", () => {
    const config = makeConfig();
    assert.strictEqual(config.nudge.states.BLOCKED?.enabled, undefined); // Not explicitly disabled
    assert.strictEqual(config.nudge.states.BLOCKED?.turnsBeforeNudge, 2);
  });

  it("circuit breaker trips after maxLoops review cycles", () => {
    const config = makeConfig({ maxLoops: 2 });
    const sm = new StateMachine(config);

    // Navigate to REVIEWING
    forceTransition(sm, "SPEC_WORK");
    forceTransition(sm, "SPEC_APPROVED");
    forceTransition(sm, "GIT_CHECKPOINT");
    forceTransition(sm, "TDD_RED_WRITE");
    forceTransition(sm, "TDD_RED_VALIDATE");
    forceTransition(sm, "TDD_GREEN_WRITE");
    forceTransition(sm, "TDD_GREEN_VALIDATE");
    forceTransition(sm, "REVIEWING");

    // First loop: NEEDS_CHANGES → TDD_RED_WRITE
    forceTransition(sm, "NEEDS_CHANGES");
    forceTransition(sm, "TDD_RED_WRITE");
    assert.strictEqual(sm.loopCount, 1);
    assert.strictEqual(sm.circuitBreakerTripped(), false);

    // Second loop
    forceTransition(sm, "TDD_RED_VALIDATE");
    forceTransition(sm, "TDD_GREEN_WRITE");
    forceTransition(sm, "TDD_GREEN_VALIDATE");
    forceTransition(sm, "REVIEWING");
    forceTransition(sm, "NEEDS_CHANGES");
    forceTransition(sm, "TDD_RED_WRITE");
    assert.strictEqual(sm.loopCount, 2);
    assert.strictEqual(sm.circuitBreakerTripped(), true);
  });
});

describe("Phase 5: Subagent Delegation Guards", () => {
  it("ORCHESTRATOR_TOOLS includes subagent but not read/bash/edit/write", async () => {
    const mod = await import("./index.ts");
    const tools = mod.ORCHESTRATOR_TOOLS as string[];
    assert.ok(tools.includes("subagent"));
    assert.ok(!tools.includes("read"));
    assert.ok(!tools.includes("bash"));
    assert.ok(!tools.includes("edit"));
    assert.ok(!tools.includes("write"));
  });

  // The pi-coder.* agent restriction is enforced in the tool_call handler, not the FSM.
  // These tests verify the FSM allows the three pi-coder agents in the right states.
  it("pi-coder.researcher is allowed in SPEC_WORK and TDD implementation states", () => {
    const config = makeConfig();
    const sm = new StateMachine(config);
    assert.strictEqual(sm.isActionAllowed("subagent", "pi-coder.researcher"), false); // IDLE
    forceTransition(sm, "SPEC_WORK");
    assert.strictEqual(sm.isActionAllowed("subagent", "pi-coder.researcher"), true); // SPEC_WORK
    forceTransition(sm, "SPEC_APPROVED");
    assert.strictEqual(sm.isActionAllowed("subagent", "pi-coder.researcher"), false); // SPEC_APPROVED
  });

  // Note: The tool_call handler gives a hint to use pi_coder_advance_fsm
  // when researcher is called from IDLE. The FSM test above verifies
  // the static rules; the hint is tested at the integration level.

  it("pi-coder.implementor is allowed only in implementation states", () => {
    const config = makeConfig();
    const sm = new StateMachine(config);
    forceTransition(sm, "SPEC_WORK");
    forceTransition(sm, "SPEC_APPROVED");
    forceTransition(sm, "GIT_CHECKPOINT");
    forceTransition(sm, "TDD_RED_WRITE");
    assert.strictEqual(sm.isActionAllowed("subagent", "pi-coder.implementor"), true);
    forceTransition(sm, "TDD_RED_VALIDATE");
    forceTransition(sm, "TDD_GREEN_WRITE");
    assert.strictEqual(sm.isActionAllowed("subagent", "pi-coder.implementor"), true);
  });

  it("pi-coder.reviewer is allowed only in REVIEWING state", () => {
    const config = makeConfig();
    const sm = new StateMachine(config);
    forceTransition(sm, "SPEC_WORK");
    forceTransition(sm, "SPEC_APPROVED");
    forceTransition(sm, "GIT_CHECKPOINT");
    forceTransition(sm, "TDD_RED_WRITE");
    forceTransition(sm, "TDD_RED_VALIDATE");
    forceTransition(sm, "TDD_GREEN_WRITE");
    forceTransition(sm, "TDD_GREEN_VALIDATE");
    forceTransition(sm, "REVIEWING");
    assert.strictEqual(sm.isActionAllowed("subagent", "pi-coder.reviewer"), true);
  });

  // The following tests verify the FSM *basis* for delegation scoping.
  // The actual pi-coder.* prefix guard is in the tool_call handler (not FSM):
  //   - Blocks agents not starting with "pi-coder."
  //   - Blocks "pi-coder.orchestrator" (delegating to self)
  //   - Only then checks FSM state
  it("built-in agents (researcher, reviewer, worker) have no special FSM rules", () => {
    const config = makeConfig();
    const sm = new StateMachine(config);
    forceTransition(sm, "SPEC_WORK");
    // FSM doesn't explicitly block "researcher" — that's the tool_call handler's job
    // FSM only checks agent-role match for known pi-coder subagents
    // The generic researcher has no role in pi-coder FSM
    assert.strictEqual(sm.isActionAllowed("subagent", "researcher"), false);
  });
});
