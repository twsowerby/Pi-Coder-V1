/**
 * Tests for Pi Coder FSM State Machine.
 *
 * Phase 1: State & Transition Table
 * Phase 2: Transition Side Effects
 * Phase 3: Action Guards
 * Phase 4: Persistence
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { StateMachine } from "./state-machine.ts";
import type { FSMState, PiCoderConfig } from "./types.ts";

/** Default config for tests. */
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
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Phase 1: State & Transition Table
// ---------------------------------------------------------------------------

describe("Phase 1: State & Transition Table", () => {
  describe("transition - legal transitions", () => {
    const legalTransitions: Array<{ from: FSMState; to: FSMState; event: string }> = [
      { from: "IDLE", to: "SPEC_WORK", event: "start_spec_work" },
      { from: "SPEC_WORK", to: "SPEC_APPROVED", event: "spec_approved" },
      { from: "SPEC_APPROVED", to: "GIT_CHECKPOINT", event: "checkpoint_start" },
      { from: "GIT_CHECKPOINT", to: "TDD_RED_WRITE", event: "checkpoint_complete" },
      { from: "TDD_RED_WRITE", to: "TDD_RED_VALIDATE", event: "tests_written" },
      { from: "TDD_RED_VALIDATE", to: "TDD_GREEN_WRITE", event: "tests_fail_as_expected" },
      { from: "TDD_RED_VALIDATE", to: "BLOCKED", event: "tests_pass_unexpectedly" },
      { from: "TDD_GREEN_WRITE", to: "TDD_GREEN_VALIDATE", event: "code_written" },
      { from: "TDD_GREEN_VALIDATE", to: "REVIEWING", event: "tests_pass" },
      { from: "TDD_GREEN_VALIDATE", to: "TDD_GREEN_WRITE", event: "tests_still_fail" },
      { from: "TDD_GREEN_VALIDATE", to: "TDD_RED_WRITE", event: "next_unit" },
      { from: "REVIEWING", to: "APPROVED", event: "review_approved" },
      { from: "REVIEWING", to: "NEEDS_CHANGES", event: "review_needs_changes" },
      { from: "NEEDS_CHANGES", to: "TDD_RED_WRITE", event: "reimplement" },
      { from: "APPROVED", to: "FINAL_APPROVAL", event: "final_approval" },
      { from: "FINAL_APPROVAL", to: "MERGING", event: "merge_start" },
      { from: "MERGING", to: "COMPLETE", event: "merge_complete" },
    ];

    for (const { from, to, event } of legalTransitions) {
      it(`should allow ${from} → ${to} (${event})`, () => {
        const sm = new StateMachine(makeConfig());
        // Walk the FSM to the 'from' state
        walkToState(sm, from);
        assert.equal(sm.currentState, from);
        sm.transition(to);
        assert.equal(sm.currentState, to);
      });
    }

    it("should allow BLOCKED → any other state (user intervention)", () => {
      const states: FSMState[] = [
        "IDLE", "SPEC_WORK", "SPEC_APPROVED",
        "GIT_CHECKPOINT", "TDD_RED_WRITE", "TDD_RED_VALIDATE", "TDD_GREEN_WRITE",
        "TDD_GREEN_VALIDATE", "REVIEWING", "APPROVED", "NEEDS_CHANGES",
        "FINAL_APPROVAL", "MERGING", "COMPLETE", "BLOCKED",
      ];
      for (const target of states) {
        const sm = new StateMachine(makeConfig());
        walkToState(sm, "BLOCKED");
        assert.equal(sm.currentState, "BLOCKED");
        sm.transition(target);
        assert.equal(sm.currentState, target);
      }
    });

    it("should allow any state → IDLE (abort)", () => {
      const states: FSMState[] = [
        "SPEC_WORK", "SPEC_APPROVED",
        "GIT_CHECKPOINT", "TDD_RED_WRITE", "TDD_RED_VALIDATE",
        "TDD_GREEN_WRITE", "TDD_GREEN_VALIDATE", "REVIEWING",
        "APPROVED", "NEEDS_CHANGES", "FINAL_APPROVAL", "MERGING",
        "BLOCKED",
      ];
      for (const from of states) {
        const sm = new StateMachine(makeConfig());
        walkToState(sm, from);
        sm.transition("IDLE");
        assert.equal(sm.currentState, "IDLE");
      }
    });
  });

  describe("getValidTransitions", () => {
    it("should list REVIEWING and TDD_RED_WRITE from TDD_GREEN_VALIDATE", () => {
      const sm = new StateMachine(makeConfig());
      walkToState(sm, "TDD_GREEN_VALIDATE");
      const valid = sm.getValidTransitions();
      assert.ok(valid.includes("REVIEWING"), "Should include REVIEWING (all units done)");
      assert.ok(valid.includes("TDD_RED_WRITE"), "Should include TDD_RED_WRITE (next unit)");
      assert.ok(valid.includes("TDD_GREEN_WRITE"), "Should include TDD_GREEN_WRITE (tests still fail)");
      assert.ok(valid.includes("IDLE"), "Should include IDLE (abort)");
    });
  });

  describe("transition - illegal transitions", () => {
    it("should throw on IDLE → TDD_RED_WRITE (skip steps)", () => {
      const sm = new StateMachine(makeConfig());
      assert.throws(
        () => sm.transition("TDD_RED_WRITE"),
        /illegal transition/i,
      );
    });

    it("should throw on IDLE → COMPLETE (skip everything)", () => {
      const sm = new StateMachine(makeConfig());
      assert.throws(
        () => sm.transition("COMPLETE"),
        /illegal transition/i,
      );
    });

    it("should throw on REVIEWING → TDD_GREEN_WRITE (missing review verdict)", () => {
      const sm = new StateMachine(makeConfig());
      walkToState(sm, "REVIEWING");
      assert.throws(
        () => sm.transition("TDD_GREEN_WRITE"),
        /illegal transition/i,
      );
    });

    it("should throw on TDD_RED_WRITE → REVIEWING (skip validation)", () => {
      const sm = new StateMachine(makeConfig());
      walkToState(sm, "TDD_RED_WRITE");
      assert.throws(
        () => sm.transition("REVIEWING"),
        /illegal transition/i,
      );
    });

    it("should throw on MERGING → RESEARCHING (nonsense)", () => {
      const sm = new StateMachine(makeConfig());
      walkToState(sm, "MERGING");
      assert.throws(
        () => sm.transition("SPEC_WORK"),
        /illegal transition/i,
      );
    });

    it("should include the from/to states in the error message", () => {
      const sm = new StateMachine(makeConfig());
      try {
        sm.transition("COMPLETE");
        assert.fail("Should have thrown");
      } catch (err) {
        const msg = (err as Error).message;
        assert.ok(msg.includes("IDLE"), `Error should mention "IDLE", got: ${msg}`);
        assert.ok(msg.includes("COMPLETE"), `Error should mention "COMPLETE", got: ${msg}`);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Phase 2: Transition Side Effects
// ---------------------------------------------------------------------------

describe("Phase 2: Transition Side Effects", () => {
  describe("loop counter", () => {
    it("should start at 0", () => {
      const sm = new StateMachine(makeConfig());
      assert.equal(sm.loopCount, 0);
    });

    it("should increment on NEEDS_CHANGES → TDD_RED_WRITE", () => {
      const sm = new StateMachine(makeConfig());
      walkToState(sm, "REVIEWING");
      sm.transition("NEEDS_CHANGES");
      assert.equal(sm.loopCount, 0); // Not yet incremented; increments on the transition TO TDD_RED_WRITE
      sm.transition("TDD_RED_WRITE");
      assert.equal(sm.loopCount, 1);
    });

    it("should increment on each review cycle", () => {
      const sm = new StateMachine(makeConfig());
      // Cycle 1
      walkToState(sm, "REVIEWING");
      sm.transition("NEEDS_CHANGES");
      sm.transition("TDD_RED_WRITE");
      assert.equal(sm.loopCount, 1);
      // Cycle 2
      sm.transition("TDD_RED_VALIDATE");
      sm.transition("TDD_GREEN_WRITE");
      sm.transition("TDD_GREEN_VALIDATE");
      sm.transition("REVIEWING");
      sm.transition("NEEDS_CHANGES");
      sm.transition("TDD_RED_WRITE");
      assert.equal(sm.loopCount, 2);
    });

    it("should reset to 0 on IDLE entry", () => {
      const sm = new StateMachine(makeConfig());
      walkToState(sm, "REVIEWING");
      sm.transition("NEEDS_CHANGES");
      sm.transition("TDD_RED_WRITE");
      assert.equal(sm.loopCount, 1);
      sm.transition("IDLE"); // abort
      assert.equal(sm.loopCount, 0);
    });

    it("should NOT increment on next_unit (TDD_GREEN_VALIDATE → TDD_RED_WRITE)", () => {
      const sm = new StateMachine(makeConfig());
      walkToState(sm, "TDD_GREEN_VALIDATE");
      assert.equal(sm.loopCount, 0);
      sm.transition("TDD_RED_WRITE"); // next unit, not a review loop
      assert.equal(sm.loopCount, 0);
    });
  });

  describe("circuit breaker", () => {
    it("should not be tripped initially", () => {
      const sm = new StateMachine(makeConfig());
      assert.equal(sm.circuitBreakerTripped(), false);
    });

    it("should not be tripped after maxLoops - 1 cycles", () => {
      const sm = new StateMachine(makeConfig({ maxLoops: 3 }));
      // 2 cycles
      fullReviewCycle(sm, 2);
      assert.equal(sm.loopCount, 2);
      assert.equal(sm.circuitBreakerTripped(), false);
    });

    it("should be tripped when loopCount reaches maxLoops", () => {
      const sm = new StateMachine(makeConfig({ maxLoops: 3 }));
      fullReviewCycle(sm, 3);
      assert.equal(sm.loopCount, 3);
      assert.equal(sm.circuitBreakerTripped(), true);
    });

    it("should be tripped after 1 cycle when maxLoops is 1", () => {
      const sm = new StateMachine(makeConfig({ maxLoops: 1 }));
      fullReviewCycle(sm, 1);
      assert.equal(sm.circuitBreakerTripped(), true);
    });
  });

  describe("activeSpecId and gitRef", () => {
    it("should start as null", () => {
      const sm = new StateMachine(makeConfig());
      assert.equal(sm.activeSpecId, null);
      assert.equal(sm.gitRef, null);
    });

    it("should track activeSpecId after setActiveSpec", () => {
      const sm = new StateMachine(makeConfig());
      sm.setActiveSpec("user-authentication");
      assert.equal(sm.activeSpecId, "user-authentication");
    });

    it("should track gitRef after setActiveSpec", () => {
      const sm = new StateMachine(makeConfig());
      sm.setActiveSpec("user-authentication", "abc1234");
      assert.equal(sm.gitRef, "abc1234");
    });

    it("should clear both on reset()", () => {
      const sm = new StateMachine(makeConfig());
      sm.setActiveSpec("user-authentication", "abc1234");
      sm.reset();
      assert.equal(sm.activeSpecId, null);
      assert.equal(sm.gitRef, null);
      assert.equal(sm.currentState, "IDLE");
      assert.equal(sm.loopCount, 0);
    });
  });
});

// ---------------------------------------------------------------------------
// Phase 3: Action Guards
// ---------------------------------------------------------------------------

describe("Phase 3: Action Guards", () => {
  describe("isActionAllowed - pi_coder_run_tests", () => {
    it("should be allowed in TDD_RED_VALIDATE", () => {
      const sm = new StateMachine(makeConfig());
      walkToState(sm, "TDD_RED_VALIDATE");
      assert.equal(sm.isActionAllowed("pi_coder_run_tests"), true);
    });

    it("should be allowed in TDD_GREEN_VALIDATE", () => {
      const sm = new StateMachine(makeConfig());
      walkToState(sm, "TDD_GREEN_VALIDATE");
      assert.equal(sm.isActionAllowed("pi_coder_run_tests"), true);
    });

    it("should NOT be allowed in IDLE", () => {
      const sm = new StateMachine(makeConfig());
      assert.equal(sm.isActionAllowed("pi_coder_run_tests"), false);
    });

    it("should NOT be allowed in TDD_RED_WRITE", () => {
      const sm = new StateMachine(makeConfig());
      walkToState(sm, "TDD_RED_WRITE");
      assert.equal(sm.isActionAllowed("pi_coder_run_tests"), false);
    });

    it("should NOT be allowed in REVIEWING", () => {
      const sm = new StateMachine(makeConfig());
      walkToState(sm, "REVIEWING");
      assert.equal(sm.isActionAllowed("pi_coder_run_tests"), false);
    });
  });

  describe("isActionAllowed - subagent with target agents", () => {
    it("should allow subagent+researcher in RESEARCHING", () => {
      const sm = new StateMachine(makeConfig());
      walkToState(sm, "SPEC_WORK");
      assert.equal(sm.isActionAllowed("subagent", "pi-coder.researcher"), true);
    });

    it("should NOT allow subagent+researcher in IDLE", () => {
      const sm = new StateMachine(makeConfig());
      assert.equal(sm.isActionAllowed("subagent", "pi-coder.researcher"), false);
    });

    it("should allow subagent+implementor in TDD_RED_WRITE", () => {
      const sm = new StateMachine(makeConfig());
      walkToState(sm, "TDD_RED_WRITE");
      assert.equal(sm.isActionAllowed("subagent", "pi-coder.implementor"), true);
    });

    it("should allow subagent+implementor in TDD_GREEN_WRITE", () => {
      const sm = new StateMachine(makeConfig());
      walkToState(sm, "TDD_GREEN_WRITE");
      assert.equal(sm.isActionAllowed("subagent", "pi-coder.implementor"), true);
    });

    it("should NOT allow subagent+implementor in RESEARCHING", () => {
      const sm = new StateMachine(makeConfig());
      walkToState(sm, "SPEC_WORK");
      assert.equal(sm.isActionAllowed("subagent", "pi-coder.implementor"), false);
    });

    it("should allow subagent+reviewer in REVIEWING", () => {
      const sm = new StateMachine(makeConfig());
      walkToState(sm, "REVIEWING");
      assert.equal(sm.isActionAllowed("subagent", "pi-coder.reviewer"), true);
    });

    it("should NOT allow subagent+reviewer in TDD_RED_WRITE", () => {
      const sm = new StateMachine(makeConfig());
      walkToState(sm, "TDD_RED_WRITE");
      assert.equal(sm.isActionAllowed("subagent", "pi-coder.reviewer"), false);
    });

    it("should NOT allow subagent without a target agent when agent-specific check is needed", () => {
      const sm = new StateMachine(makeConfig());
      // subagent without targetAgent should still have basic gating
      walkToState(sm, "IDLE");
      assert.equal(sm.isActionAllowed("subagent"), false);
    });
  });

  describe("isActionAllowed - pi_coder_git", () => {
    const allowedStates: FSMState[] = ["GIT_CHECKPOINT", "REVIEWING", "MERGING", "BLOCKED", "IDLE"];
    const blockedStates: FSMState[] = [
      "SPEC_WORK", "SPEC_APPROVED",
      "TDD_RED_WRITE", "TDD_RED_VALIDATE", "TDD_GREEN_WRITE", "TDD_GREEN_VALIDATE",
      "APPROVED", "NEEDS_CHANGES", "FINAL_APPROVAL",
    ];

    for (const state of allowedStates) {
      it(`should allow pi_coder_git in ${state}`, () => {
        const sm = new StateMachine(makeConfig());
        walkToState(sm, state);
        assert.equal(sm.isActionAllowed("pi_coder_git"), true);
      });
    }

    for (const state of blockedStates) {
      it(`should NOT allow pi_coder_git in ${state}`, () => {
        const sm = new StateMachine(makeConfig());
        walkToState(sm, state);
        assert.equal(sm.isActionAllowed("pi_coder_git"), false);
      });
    }
  });

  describe("isActionAllowed - always-allowed tools", () => {
    const alwaysAllowed = ["upsert_knowledge", "ls", "find", "grep"];
    const allStates: FSMState[] = [
      "IDLE", "SPEC_WORK", "SPEC_APPROVED",
      "GIT_CHECKPOINT", "TDD_RED_WRITE", "TDD_RED_VALIDATE", "TDD_GREEN_WRITE",
      "TDD_GREEN_VALIDATE", "REVIEWING",
    ];

    for (const tool of alwaysAllowed) {
      for (const state of allStates) {
        it(`should allow ${tool} in ${state}`, () => {
          const sm = new StateMachine(makeConfig());
          walkToState(sm, state);
          assert.equal(sm.isActionAllowed(tool), true);
        });
      }
    }
  });

  describe("canNudge", () => {
    it("should nudge in RESEARCHING — expected: delegate to researcher", () => {
      const sm = new StateMachine(makeConfig());
      walkToState(sm, "SPEC_WORK");
      const result = sm.canNudge();
      assert.equal(result.shouldNudge, true);
      assert.equal(result.expectedTool, "subagent");
      assert.ok(result.expectedAction.includes("researcher"));
    });

    it("should nudge in GIT_CHECKPOINT — expected: git checkpoint", () => {
      const sm = new StateMachine(makeConfig());
      walkToState(sm, "GIT_CHECKPOINT");
      const result = sm.canNudge();
      assert.equal(result.shouldNudge, true);
      assert.equal(result.expectedTool, "pi_coder_git");
    });

    it("should nudge in TDD_RED_WRITE — expected: delegate to implementor", () => {
      const sm = new StateMachine(makeConfig());
      walkToState(sm, "TDD_RED_WRITE");
      const result = sm.canNudge();
      assert.equal(result.shouldNudge, true);
      assert.equal(result.expectedTool, "subagent");
      assert.ok(result.expectedAction.includes("implementor"));
    });

    it("should nudge in TDD_RED_VALIDATE — expected: run tests", () => {
      const sm = new StateMachine(makeConfig());
      walkToState(sm, "TDD_RED_VALIDATE");
      const result = sm.canNudge();
      assert.equal(result.shouldNudge, true);
      assert.equal(result.expectedTool, "pi_coder_run_tests");
    });

    it("should nudge in TDD_GREEN_WRITE — expected: delegate to implementor", () => {
      const sm = new StateMachine(makeConfig());
      walkToState(sm, "TDD_GREEN_WRITE");
      const result = sm.canNudge();
      assert.equal(result.shouldNudge, true);
      assert.equal(result.expectedTool, "subagent");
      assert.ok(result.expectedAction.includes("implementor"));
    });

    it("should nudge in TDD_GREEN_VALIDATE — expected: run tests", () => {
      const sm = new StateMachine(makeConfig());
      walkToState(sm, "TDD_GREEN_VALIDATE");
      const result = sm.canNudge();
      assert.equal(result.shouldNudge, true);
      assert.equal(result.expectedTool, "pi_coder_run_tests");
    });

    it("should nudge in REVIEWING — expected: delegate to reviewer", () => {
      const sm = new StateMachine(makeConfig());
      walkToState(sm, "REVIEWING");
      const result = sm.canNudge();
      assert.equal(result.shouldNudge, true);
      assert.equal(result.expectedTool, "subagent");
      assert.ok(result.expectedAction.includes("reviewer"));
    });

    it("should nudge in SPEC_WORK — expected: delegate or advance", () => {
      const sm = new StateMachine(makeConfig());
      walkToState(sm, "SPEC_WORK");
      const result = sm.canNudge();
      assert.equal(result.shouldNudge, true);
      assert.ok(result.expectedAction.includes("researcher"));
    });

    it("should nudge in BLOCKED — expected: user intervention", () => {
      const sm = new StateMachine(makeConfig());
      walkToState(sm, "BLOCKED");
      const result = sm.canNudge();
      assert.equal(result.shouldNudge, true);
    });

    it("should NOT nudge in IDLE", () => {
      const sm = new StateMachine(makeConfig());
      assert.equal(sm.canNudge().shouldNudge, false);
    });

    it("should NOT nudge in SPEC_APPROVED", () => {
      const sm = new StateMachine(makeConfig());
      walkToState(sm, "SPEC_APPROVED");
      assert.equal(sm.canNudge().shouldNudge, false);
    });

    it("should NOT nudge in FINAL_APPROVAL", () => {
      const sm = new StateMachine(makeConfig());
      walkToState(sm, "FINAL_APPROVAL");
      assert.equal(sm.canNudge().shouldNudge, false);
    });

    it("should NOT nudge in COMPLETE", () => {
      const sm = new StateMachine(makeConfig());
      walkToState(sm, "COMPLETE");
      assert.equal(sm.canNudge().shouldNudge, false);
    });
  });

  describe("guard methods are pure reads", () => {
    it("isActionAllowed should not change state", () => {
      const sm = new StateMachine(makeConfig());
      walkToState(sm, "TDD_RED_VALIDATE");
      const stateBefore = sm.currentState;
      sm.isActionAllowed("pi_coder_run_tests");
      assert.equal(sm.currentState, stateBefore);
    });

    it("isActionAllowed should not change loopCount", () => {
      const sm = new StateMachine(makeConfig());
      fullReviewCycle(sm, 2);
      const countBefore = sm.loopCount;
      sm.isActionAllowed("pi_coder_run_tests");
      assert.equal(sm.loopCount, countBefore);
    });

    it("canNudge should not change state", () => {
      const sm = new StateMachine(makeConfig());
      walkToState(sm, "SPEC_WORK");
      const stateBefore = sm.currentState;
      sm.canNudge();
      assert.equal(sm.currentState, stateBefore);
    });
  });
});

// ---------------------------------------------------------------------------
// Phase 4: Persistence
// ---------------------------------------------------------------------------

describe("Phase 4: Persistence", () => {
  describe("toJSON", () => {
    it("should return a plain object with currentState, activeSpecId, loopCount, gitRef", () => {
      const sm = new StateMachine(makeConfig());
      const json = sm.toJSON();
      assert.equal(json.currentState, "IDLE");
      assert.equal(json.activeSpecId, null);
      assert.equal(json.loopCount, 0);
      assert.equal(json.gitRef, null);
    });

    it("should reflect current state after transitions", () => {
      const sm = new StateMachine(makeConfig());
      sm.setActiveSpec("auth-flow", "abc1234");
      walkToState(sm, "REVIEWING");
      const json = sm.toJSON();
      assert.equal(json.currentState, "REVIEWING");
      assert.equal(json.activeSpecId, "auth-flow");
      assert.equal(json.gitRef, "abc1234");
      assert.equal(json.loopCount, 0);
    });

    it("should reflect loop count after review cycles", () => {
      const sm = new StateMachine(makeConfig());
      fullReviewCycle(sm, 2);
      const json = sm.toJSON();
      assert.equal(json.loopCount, 2);
    });
  });

  describe("fromJSON", () => {
    it("should restore IDLE state with no specId/gitRef", () => {
      const sm = new StateMachine(makeConfig());
      const json = sm.toJSON();
      const restored = StateMachine.fromJSON(json, makeConfig());
      assert.equal(restored.currentState, "IDLE");
      assert.equal(restored.activeSpecId, null);
      assert.equal(restored.gitRef, null);
      assert.equal(restored.loopCount, 0);
    });

    it("should restore a mid-lifecycle state", () => {
      const sm = new StateMachine(makeConfig());
      sm.setActiveSpec("user-auth", "deadbeef");
      walkToState(sm, "TDD_GREEN_VALIDATE");
      fullReviewCycle(sm, 1); // Get some loop count

      const json = sm.toJSON();
      const restored = StateMachine.fromJSON(json, makeConfig());
      assert.equal(restored.currentState, "TDD_GREEN_VALIDATE");
      assert.equal(restored.activeSpecId, "user-auth");
      assert.equal(restored.gitRef, "deadbeef");
      // loopCount was 1 from fullReviewCycle but we walked past NEEDS_CHANGES without incrementing
      // because we went to TDD_GREEN_VALIDATE directly. Let's just check it's preserved.
      assert.equal(restored.loopCount, json.loopCount);
    });

    it("should restore loop count", () => {
      const sm = new StateMachine(makeConfig());
      fullReviewCycle(sm, 2);
      const json = sm.toJSON();
      const restored = StateMachine.fromJSON(json, makeConfig());
      assert.equal(restored.loopCount, 2);
    });

    it("should produce a machine that can continue transitioning", () => {
      const sm = new StateMachine(makeConfig());
      sm.setActiveSpec("user-auth", "abc1234");
      walkToState(sm, "TDD_RED_VALIDATE");

      const json = sm.toJSON();
      const restored = StateMachine.fromJSON(json, makeConfig());
      // Should be able to transition from RED_VALIDATE → GREEN_WRITE
      restored.transition("TDD_GREEN_WRITE");
      assert.equal(restored.currentState, "TDD_GREEN_WRITE");
    });
  });

  describe("round-trip integrity", () => {
    const states: FSMState[] = [
      "IDLE", "SPEC_WORK", "SPEC_APPROVED",
      "GIT_CHECKPOINT", "TDD_RED_WRITE", "TDD_RED_VALIDATE",
      "TDD_GREEN_WRITE", "TDD_GREEN_VALIDATE", "REVIEWING",
    ];

    for (const state of states) {
      it(`should round-trip through JSON for state ${state}`, () => {
        const sm = new StateMachine(makeConfig());
        walkToState(sm, state);
        const json = sm.toJSON();
        const restored = StateMachine.fromJSON(json, makeConfig());
        assert.equal(restored.currentState, state);
        assert.equal(restored.activeSpecId, sm.activeSpecId);
        assert.equal(restored.gitRef, sm.gitRef);
        assert.equal(restored.loopCount, sm.loopCount);
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Walk the FSM from IDLE to the given target state via the happy path.
 * This function hard-codes the legal transition sequence.
 */
function walkToState(sm: StateMachine, target: FSMState): void {
  const happyPath: FSMState[] = [
    "IDLE",
    "SPEC_WORK",
    "SPEC_APPROVED",
    "GIT_CHECKPOINT",
    "TDD_RED_WRITE",
    "TDD_RED_VALIDATE",
    "TDD_GREEN_WRITE",
    "TDD_GREEN_VALIDATE",
    "REVIEWING",
    "APPROVED",
    "FINAL_APPROVAL",
    "MERGING",
    "COMPLETE",
  ];

  const targetIdx = happyPath.indexOf(target);

  // Handle states not on the main happy path
  if (target === "BLOCKED") {
    walkToState(sm, "TDD_RED_VALIDATE");
    sm.transition("BLOCKED");
    return;
  }
  if (target === "NEEDS_CHANGES") {
    walkToState(sm, "REVIEWING");
    sm.transition("NEEDS_CHANGES");
    return;
  }

  if (targetIdx === -1) throw new Error(`Unknown happy-path state: ${target}`);

  // Walk from current state along the happy path
  for (let i = 0; i < targetIdx; i++) {
    if (sm.currentState === happyPath[i] && sm.currentState !== target) {
      sm.transition(happyPath[i + 1]);
    }
  }

  if (sm.currentState !== target) {
    throw new Error(`walkToState failed: wanted ${target}, got ${sm.currentState}`);
  }
}

/**
 * Run N full review cycles, starting from current state.
 * Assumes the FSM is at REVIEWING (or will be walked there).
 * Each cycle: REVIEWING → NEEDS_CHANGES → TDD_RED_WRITE → TDD_RED_VALIDATE
 *             → TDD_GREEN_WRITE → TDD_GREEN_VALIDATE → REVIEWING
 */
function fullReviewCycle(sm: StateMachine, n: number): void {
  // If we're not at REVIEWING yet, walk there
  if (sm.currentState !== "REVIEWING") {
    walkToState(sm, "REVIEWING");
  }

  for (let i = 0; i < n; i++) {
    sm.transition("NEEDS_CHANGES");
    sm.transition("TDD_RED_WRITE");
    sm.transition("TDD_RED_VALIDATE");
    sm.transition("TDD_GREEN_WRITE");
    sm.transition("TDD_GREEN_VALIDATE");
    if (i < n - 1) {
      sm.transition("REVIEWING");
    }
  }
}
