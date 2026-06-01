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
import { LightStateMachine } from "./light-state-machine.ts";
import type { FSMState, PiCoderConfig, EvidenceFlag } from "./types.ts";
import { makeConfig } from "./test/state-machine-helpers.ts";

/**
 * Force a transition, setting required evidence first.
 * Throws if the transition returns a guard error.
 */
function forceTransition(sm: StateMachine, to: FSMState): void {
  // Set evidence required for guarded transitions
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
  if (result) {
    throw new Error(`Transition guard blocked ${from} → ${to}: ${result.message}`);
  }
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
      { from: "TDD_RED_VALIDATE", to: "TDD_GREEN_WRITE", event: "red_tautology_acknowledge" },
      { from: "TDD_GREEN_WRITE", to: "TDD_GREEN_VALIDATE", event: "code_written" },
      { from: "TDD_GREEN_VALIDATE", to: "REVIEWING", event: "tests_pass" },
      { from: "TDD_GREEN_VALIDATE", to: "TDD_GREEN_WRITE", event: "tests_still_fail" },
      { from: "TDD_GREEN_VALIDATE", to: "TDD_RED_WRITE", event: "next_unit" },
      { from: "REVIEWING", to: "APPROVED", event: "review_approved" },
      { from: "REVIEWING", to: "NEEDS_CHANGES", event: "review_needs_changes" },
      { from: "NEEDS_CHANGES", to: "TDD_RED_WRITE", event: "reimplement" },
      { from: "NEEDS_CHANGES", to: "REVIEWING", event: "non_functional_fix" },
      { from: "APPROVED", to: "FINAL_APPROVAL", event: "final_approval" },
      { from: "APPROVED", to: "MERGING", event: "merge_approved" },
      { from: "FINAL_APPROVAL", to: "MERGING", event: "merge_start" },
      { from: "MERGING", to: "COMPLETE", event: "merge_complete" },
    ];

    for (const { from, to, event } of legalTransitions) {
      it(`should allow ${from} → ${to} (${event})`, () => {
        const sm = new StateMachine(makeConfig());
        // Walk the FSM to the 'from' state
        walkToState(sm, from);
        assert.equal(sm.currentState, from);
        forceTransition(sm, to);
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
        forceTransition(sm, target);
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
        forceTransition(sm, "IDLE");
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

    it("should list TDD_RED_WRITE, TDD_GREEN_WRITE, and REVIEWING from NEEDS_CHANGES", () => {
      const sm = new StateMachine(makeConfig());
      walkToState(sm, "NEEDS_CHANGES");
      const valid = sm.getValidTransitions();
      assert.ok(valid.includes("TDD_RED_WRITE"), "Should include TDD_RED_WRITE (functional fix needing new tests)");
      assert.ok(valid.includes("TDD_GREEN_WRITE"), "Should include TDD_GREEN_WRITE (functional fix with existing tests)");
      assert.ok(valid.includes("REVIEWING"), "Should include REVIEWING (non-functional fix)");
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
        forceTransition(sm, "COMPLETE");
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
      forceTransition(sm, "NEEDS_CHANGES");
      assert.equal(sm.loopCount, 0); // Not yet incremented; increments on the transition TO TDD_RED_WRITE
      forceTransition(sm, "TDD_RED_WRITE");
      assert.equal(sm.loopCount, 1);
    });

    it("should increment on NEEDS_CHANGES → REVIEWING (non-functional fix)", () => {
      const sm = new StateMachine(makeConfig());
      walkToState(sm, "REVIEWING");
      forceTransition(sm, "NEEDS_CHANGES");
      assert.equal(sm.loopCount, 0);
      forceTransition(sm, "REVIEWING"); // Non-functional fix — apply fix, re-review
      assert.equal(sm.loopCount, 1); // Increments — circuit breaker protects both paths
    });

    it("should increment on each review cycle", () => {
      const sm = new StateMachine(makeConfig());
      // Cycle 1
      walkToState(sm, "REVIEWING");
      forceTransition(sm, "NEEDS_CHANGES");
      forceTransition(sm, "TDD_RED_WRITE");
      assert.equal(sm.loopCount, 1);
      // Cycle 2
      forceTransition(sm, "TDD_RED_VALIDATE");
      forceTransition(sm, "TDD_GREEN_WRITE");
      forceTransition(sm, "TDD_GREEN_VALIDATE");
      forceTransition(sm, "REVIEWING");
      forceTransition(sm, "NEEDS_CHANGES");
      forceTransition(sm, "TDD_RED_WRITE");
      assert.equal(sm.loopCount, 2);
    });

    it("should reset to 0 on IDLE entry", () => {
      const sm = new StateMachine(makeConfig());
      walkToState(sm, "REVIEWING");
      forceTransition(sm, "NEEDS_CHANGES");
      forceTransition(sm, "TDD_RED_WRITE");
      assert.equal(sm.loopCount, 1);
      forceTransition(sm, "IDLE"); // abort
      assert.equal(sm.loopCount, 0);
    });

    it("should NOT increment on next_unit (TDD_GREEN_VALIDATE → TDD_RED_WRITE)", () => {
      const sm = new StateMachine(makeConfig());
      walkToState(sm, "TDD_GREEN_VALIDATE");
      assert.equal(sm.loopCount, 0);
      forceTransition(sm, "TDD_RED_WRITE"); // next unit, not a review loop
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
    it("should start with null gitRef", () => {
      const sm = new StateMachine(makeConfig());
      assert.equal(sm.gitRef, null);
    });

    it("should track gitRef after setGitRef", () => {
      const sm = new StateMachine(makeConfig());
      sm.setGitRef("abc1234");
      assert.equal(sm.gitRef, "abc1234");
    });

    it("should clear gitRef on reset()", () => {
      const sm = new StateMachine(makeConfig());
      sm.setGitRef("abc1234");
      sm.reset();
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

    // pi_coder_run_tests is in alwaysAllowed — it's allowed in ALL states
    // (the tool description says "Available in any mode and state")
    it("should be allowed in IDLE (alwaysAllowed)", () => {
      const sm = new StateMachine(makeConfig());
      assert.equal(sm.isActionAllowed("pi_coder_run_tests"), true);
    });

    it("should be allowed in TDD_RED_WRITE (alwaysAllowed)", () => {
      const sm = new StateMachine(makeConfig());
      walkToState(sm, "TDD_RED_WRITE");
      assert.equal(sm.isActionAllowed("pi_coder_run_tests"), true);
    });

    it("should be allowed in REVIEWING (alwaysAllowed)", () => {
      const sm = new StateMachine(makeConfig());
      walkToState(sm, "REVIEWING");
      assert.equal(sm.isActionAllowed("pi_coder_run_tests"), true);
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
    it("should return a plain object with currentState, loopCount, gitRef, evidence", () => {
      const sm = new StateMachine(makeConfig());
      const json = sm.toJSON();
      assert.equal(json.currentState, "IDLE");
      assert.equal(json.loopCount, 0);
      assert.equal(json.gitRef, null);
      assert.deepStrictEqual(json.evidence, []);
    });

    it("should reflect current state after transitions", () => {
      const sm = new StateMachine(makeConfig());
      sm.setGitRef("abc1234");
      walkToState(sm, "REVIEWING");
      const json = sm.toJSON();
      assert.equal(json.currentState, "REVIEWING");
      assert.equal(json.gitRef, "abc1234");
      assert.equal(json.loopCount, 0);
      assert.ok(json.evidence.includes("spec_saved"));
      assert.ok(json.evidence.includes("spec_user_approved"));
    });

    it("should reflect loop count after review cycles", () => {
      const sm = new StateMachine(makeConfig());
      fullReviewCycle(sm, 2);
      const json = sm.toJSON();
      assert.equal(json.loopCount, 2);
    });
  });

  describe("fromJSON", () => {
    it("should restore IDLE state with no gitRef", () => {
      const sm = new StateMachine(makeConfig());
      const json = sm.toJSON();
      const restored = StateMachine.fromJSON(json, makeConfig());
      assert.equal(restored.currentState, "IDLE");
      assert.equal(restored.gitRef, null);
      assert.equal(restored.loopCount, 0);
      assert.deepStrictEqual(restored.getEvidence(), []);
    });

    it("should restore a mid-lifecycle state with evidence", () => {
      const sm = new StateMachine(makeConfig());
      sm.setGitRef("deadbeef");
      walkToState(sm, "TDD_GREEN_VALIDATE");
      fullReviewCycle(sm, 1); // Get some loop count

      const json = sm.toJSON();
      const restored = StateMachine.fromJSON(json, makeConfig());
      assert.equal(restored.currentState, "TDD_GREEN_VALIDATE");
      assert.equal(restored.gitRef, "deadbeef");
      // Evidence should be preserved
      assert.ok(restored.getEvidence().includes("spec_saved"));
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
      sm.setGitRef("abc1234");
      walkToState(sm, "TDD_RED_VALIDATE");

      const json = sm.toJSON();
      const restored = StateMachine.fromJSON(json, makeConfig());
      // Evidence is preserved from the original machine
      // Need test_run_this_state to advance from RED_VALIDATE
      restored.setEvidence("test_run_this_state");
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
    forceTransition(sm, "BLOCKED");
    return;
  }
  if (target === "NEEDS_CHANGES") {
    walkToState(sm, "REVIEWING");
    forceTransition(sm, "NEEDS_CHANGES");
    return;
  }

  if (targetIdx === -1) throw new Error(`Unknown happy-path state: ${target}`);

  // Walk from current state along the happy path
  for (let i = 0; i < targetIdx; i++) {
    if (sm.currentState === happyPath[i] && sm.currentState !== target) {
      forceTransition(sm, happyPath[i + 1]);
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
    forceTransition(sm, "NEEDS_CHANGES");
    forceTransition(sm, "TDD_RED_WRITE");
    forceTransition(sm, "TDD_RED_VALIDATE");
    forceTransition(sm, "TDD_GREEN_WRITE");
    forceTransition(sm, "TDD_GREEN_VALIDATE");
    if (i < n - 1) {
      forceTransition(sm, "REVIEWING");
    }
  }
}

// ---------------------------------------------------------------------------
// Phase 5: RED Tautology Acknowledge
// ---------------------------------------------------------------------------

describe("RED tautology acknowledge", () => {
  it("allows TDD_RED_VALIDATE → TDD_GREEN_WRITE via red_tautology_acknowledge", () => {
    const sm = new StateMachine(makeConfig());
    forceTransition(sm, "SPEC_WORK");
    forceTransition(sm, "SPEC_APPROVED");
    forceTransition(sm, "GIT_CHECKPOINT");
    // GIT_CHECKPOINT → TDD_RED_WRITE is auto-transitioned, but we need to force it
    sm.transition("TDD_RED_WRITE");
    forceTransition(sm, "TDD_RED_VALIDATE");
    sm.setEvidence("test_run_this_state");
    const result = sm.transition("TDD_GREEN_WRITE");
    assert.strictEqual(result, undefined, "Transition should succeed");
    assert.strictEqual(sm.currentState, "TDD_GREEN_WRITE");
  });

  it("requires test_run_this_state evidence for red_tautology_acknowledge", () => {
    const sm = new StateMachine(makeConfig());
    forceTransition(sm, "SPEC_WORK");
    forceTransition(sm, "SPEC_APPROVED");
    forceTransition(sm, "GIT_CHECKPOINT");
    sm.transition("TDD_RED_WRITE");
    forceTransition(sm, "TDD_RED_VALIDATE");
    // No test_run_this_state evidence
    const result = sm.transition("TDD_GREEN_WRITE");
    assert.ok(result !== undefined, "Should return a guard error");
    assert.ok("missingEvidence" in result!);
    assert.ok((result as any).missingEvidence.includes("test_run_this_state"));
  });

  it("TDD_RED_VALIDATE → BLOCKED is still available for hard failures", () => {
    const sm = new StateMachine(makeConfig());
    forceTransition(sm, "SPEC_WORK");
    forceTransition(sm, "SPEC_APPROVED");
    forceTransition(sm, "GIT_CHECKPOINT");
    sm.transition("TDD_RED_WRITE");
    forceTransition(sm, "TDD_RED_VALIDATE");
    const result = sm.transition("BLOCKED");
    assert.strictEqual(result, undefined, "BLOCKED transition should succeed");
    assert.strictEqual(sm.currentState, "BLOCKED");
  });

  it("NEEDS_CHANGES allows implementor delegation and nudge reflects this", () => {
    const sm = new StateMachine(makeConfig());
    forceTransition(sm, "SPEC_WORK");
    forceTransition(sm, "SPEC_APPROVED");
    forceTransition(sm, "GIT_CHECKPOINT");
    sm.transition("TDD_RED_WRITE");
    forceTransition(sm, "TDD_RED_VALIDATE");
    sm.setEvidence("test_run_this_state");
    sm.transition("TDD_GREEN_WRITE");
    forceTransition(sm, "TDD_GREEN_VALIDATE");
    forceTransition(sm, "REVIEWING");
    forceTransition(sm, "NEEDS_CHANGES");
    // Implementor is now allowed directly in NEEDS_CHANGES for non-functional fixes
    assert.strictEqual(sm.isActionAllowed("subagent", "pi-coder.implementor"), true);
    const nudge = sm.canNudge();
    assert.strictEqual(nudge.shouldNudge, true);
    assert.strictEqual(nudge.expectedTool, "subagent");
    assert.ok(nudge.expectedAction.includes("implementor"));
  });

  it("NEEDS_CHANGES → REVIEWING requires non_functional_classified evidence", () => {
    const sm = new StateMachine(makeConfig());
    forceTransition(sm, "SPEC_WORK");
    forceTransition(sm, "SPEC_APPROVED");
    forceTransition(sm, "GIT_CHECKPOINT");
    sm.transition("TDD_RED_WRITE");
    forceTransition(sm, "TDD_RED_VALIDATE");
    sm.setEvidence("test_run_this_state");
    sm.transition("TDD_GREEN_WRITE");
    forceTransition(sm, "TDD_GREEN_VALIDATE");
    forceTransition(sm, "REVIEWING");
    forceTransition(sm, "NEEDS_CHANGES");
    // Without evidence — guard should block
    const result = sm.transition("REVIEWING");
    assert.ok(result !== undefined, "Should return guard error");
    assert.ok("missingEvidence" in result!);
    assert.ok((result as any).missingEvidence.includes("non_functional_classified"));
    assert.strictEqual(sm.currentState, "NEEDS_CHANGES", "State should not have changed");
  });

  it("NEEDS_CHANGES → REVIEWING succeeds with non_functional_classified evidence", () => {
    const sm = new StateMachine(makeConfig());
    forceTransition(sm, "SPEC_WORK");
    forceTransition(sm, "SPEC_APPROVED");
    forceTransition(sm, "GIT_CHECKPOINT");
    sm.transition("TDD_RED_WRITE");
    forceTransition(sm, "TDD_RED_VALIDATE");
    sm.setEvidence("test_run_this_state");
    sm.transition("TDD_GREEN_WRITE");
    forceTransition(sm, "TDD_GREEN_VALIDATE");
    forceTransition(sm, "REVIEWING");
    forceTransition(sm, "NEEDS_CHANGES");
    sm.setEvidence("non_functional_classified");
    const result = sm.transition("REVIEWING");
    assert.strictEqual(result, undefined, "Transition should succeed");
    assert.strictEqual(sm.currentState, "REVIEWING");
  });

  it("REVIEWING → APPROVED requires review_completed evidence", () => {
    const sm = new StateMachine(makeConfig());
    walkToState(sm, "REVIEWING");
    // Without review_completed evidence, the transition should fail
    const transitionResult = sm.transition("APPROVED");
    assert.ok(transitionResult, "Transition should fail without review_completed evidence");
    assert.strictEqual(transitionResult!.missingEvidence[0], "review_completed");
    assert.strictEqual(sm.currentState, "REVIEWING");

    // With evidence, the transition should succeed
    sm.setEvidence("review_completed");
    const transitionResult2 = sm.transition("APPROVED");
    assert.strictEqual(transitionResult2, undefined, "Transition should succeed with evidence");
    assert.strictEqual(sm.currentState, "APPROVED");
  });
});

// ---------------------------------------------------------------------------
// Unit 1: buildDiagram
// ---------------------------------------------------------------------------

describe("Unit 1: buildDiagram", () => {
  it("TDD mode diagram is a markdown table with all key transitions", () => {
    const sm = new StateMachine(makeConfig());
    const diagram = sm.buildDiagram();
    // Header row
    assert.ok(diagram.includes("| Current State | Valid Target | When |"), "Should have table header");
    // RED_VALIDATE triple exit
    assert.ok(diagram.includes("TDD_RED_VALIDATE"), "Should mention RED_VALIDATE");
    assert.ok(diagram.includes("RED tautology"), "Should mention RED tautology");
    assert.ok(diagram.includes("BLOCKED"), "Should mention BLOCKED");
    // TDD mode title
    assert.ok(diagram.includes("FSM State Transitions (TDD Mode)"), "Should have TDD mode title");
    // TDD mode should NOT have Any → BLOCKED wildcard (it has specific entries)
    assert.ok(!diagram.includes("Any | BLOCKED"), "TDD mode should not have Any→BLOCKED wildcard");
    // Completeness warning
    assert.ok(diagram.includes("COMPLETE. No other transitions are valid"), "Should have completeness warning");
    // NEEDS_CHANGES three paths
    assert.ok(diagram.includes("TDD_RED_WRITE | Functional fix needing new tests"), "Should have NEEDS_CHANGES→TDD_RED_WRITE");
    assert.ok(diagram.includes("TDD_GREEN_WRITE | Functional fix with existing test coverage"), "Should have NEEDS_CHANGES→TDD_GREEN_WRITE");
    assert.ok(diagram.includes("REVIEWING | Non-functional fix only"), "Should have NEEDS_CHANGES→REVIEWING");
  });

  it("Light mode diagram is a markdown table with Any → BLOCKED wildcard", () => {
    const sm = new LightStateMachine(makeConfig());
    const diagram = sm.buildDiagram();
    // Header row
    assert.ok(diagram.includes("| Current State | Valid Target | When |"), "Should have table header");
    assert.ok(diagram.includes("IMPLEMENTING"), "Should mention IMPLEMENTING");
    assert.ok(diagram.includes("FSM State Transitions (Light Mode)"), "Should have Light mode title");
    assert.ok(diagram.includes("Any | BLOCKED"), "Should have Any→BLOCKED wildcard");
    // Light mode should NOT have TDD references
    assert.ok(!diagram.includes("TDD_RED"), "Light mode should not have TDD_RED");
    assert.ok(!diagram.includes("RED tautology"), "Light mode should not have RED tautology");
    // Completeness warning
    assert.ok(diagram.includes("COMPLETE. No other transitions are valid"), "Should have completeness warning");
  });
});

// ---------------------------------------------------------------------------
// Unit 2: currentUnitName state tracking
// ---------------------------------------------------------------------------

describe("Unit 2: currentUnitName state tracking", () => {
  it("should start as null", () => {
    const sm = new StateMachine(makeConfig());
    assert.strictEqual(sm.currentUnitName, null);
  });

  it("should be settable via setCurrentUnitName", () => {
    const sm = new StateMachine(makeConfig());
    sm.setCurrentUnitName("Config update");
    assert.strictEqual(sm.currentUnitName, "Config update");
  });

  it("should be clearable via setCurrentUnitName(null)", () => {
    const sm = new StateMachine(makeConfig());
    sm.setCurrentUnitName("Config update");
    sm.setCurrentUnitName(null);
    assert.strictEqual(sm.currentUnitName, null);
  });

  it("should reset to null on IDLE entry", () => {
    const sm = new StateMachine(makeConfig());
    sm.setCurrentUnitName("Config update");
    forceTransition(sm, "SPEC_WORK");
    assert.strictEqual(sm.currentUnitName, "Config update", "Should persist through SPEC_WORK");
    forceTransition(sm, "IDLE");
    assert.strictEqual(sm.currentUnitName, null, "Should be null after IDLE entry");
  });

  it("should be included in toJSON output", () => {
    const sm = new StateMachine(makeConfig());
    sm.setCurrentUnitName("Config update");
    const json = sm.toJSON();
    assert.strictEqual(json.currentUnitName, "Config update");
  });

  it("should be null in toJSON when not set", () => {
    const sm = new StateMachine(makeConfig());
    const json = sm.toJSON();
    assert.strictEqual(json.currentUnitName, null);
  });

  it("should be restored from JSON via fromJSON", () => {
    const sm = new StateMachine(makeConfig());
    sm.setCurrentUnitName("Config update");
    const json = sm.toJSON();
    const restored = StateMachine.fromJSON(json, makeConfig());
    assert.strictEqual(restored.currentUnitName, "Config update");
  });

  it("should persist null currentUnitName through JSON round-trip", () => {
    const sm = new StateMachine(makeConfig());
    const json = sm.toJSON();
    const restored = StateMachine.fromJSON(json, makeConfig());
    assert.strictEqual(restored.currentUnitName, null);
  });

  it("should be cleared on reset()", () => {
    const sm = new StateMachine(makeConfig());
    sm.setCurrentUnitName("Config update");
    sm.reset();
    assert.strictEqual(sm.currentUnitName, null);
  });

  it("should be cleared on NEEDS_CHANGES entry (prevents infinite loop on direct re-entry)", () => {
    const sm = new StateMachine(makeConfig());
    sm.setCurrentUnitName("Config update");
    // Walk to REVIEWING first, then NEEDS_CHANGES is reachable
    forceTransition(sm, "SPEC_WORK");
    forceTransition(sm, "SPEC_APPROVED");
    forceTransition(sm, "GIT_CHECKPOINT");
    forceTransition(sm, "TDD_RED_WRITE");
    forceTransition(sm, "TDD_RED_VALIDATE");
    forceTransition(sm, "TDD_GREEN_WRITE");
    forceTransition(sm, "TDD_GREEN_VALIDATE");
    forceTransition(sm, "REVIEWING");
    assert.strictEqual(sm.currentUnitName, "Config update", "name should persist to REVIEWING");
    forceTransition(sm, "NEEDS_CHANGES");
    assert.strictEqual(sm.currentUnitName, null, "currentUnitName should be cleared on NEEDS_CHANGES entry");
  });

  it("LightStateMachine also supports currentUnitName", () => {
    const sm = new LightStateMachine(makeConfig());
    assert.strictEqual(sm.currentUnitName, null);
    sm.setCurrentUnitName("Config update");
    assert.strictEqual(sm.currentUnitName, "Config update");
    const json = sm.toJSON();
    assert.strictEqual(json.currentUnitName, "Config update");
    const restored = LightStateMachine.fromJSON(json, makeConfig());
    assert.strictEqual(restored.currentUnitName, "Config update");
  });
});

// ---------------------------------------------------------------------------
// Unit 3: Retry Counters
// ---------------------------------------------------------------------------

describe("Unit 3: Retry Counters", () => {
  describe("basic operations", () => {
    it("should start at 0 for any key", () => {
      const sm = new StateMachine(makeConfig());
      assert.strictEqual(sm.getRetryCounter("green_retries"), 0);
      assert.strictEqual(sm.getRetryCounter("red_retries"), 0);
      assert.strictEqual(sm.getRetryCounter("any_key"), 0);
    });

    it("should increment a retry counter", () => {
      const sm = new StateMachine(makeConfig());
      sm.incrementRetryCounter("green_retries");
      assert.strictEqual(sm.getRetryCounter("green_retries"), 1);
      sm.incrementRetryCounter("green_retries");
      assert.strictEqual(sm.getRetryCounter("green_retries"), 2);
    });

    it("should reset a specific retry counter", () => {
      const sm = new StateMachine(makeConfig());
      sm.incrementRetryCounter("green_retries");
      sm.incrementRetryCounter("green_retries");
      sm.resetRetryCounter("green_retries");
      assert.strictEqual(sm.getRetryCounter("green_retries"), 0);
    });

    it("should reset all retry counters", () => {
      const sm = new StateMachine(makeConfig());
      sm.incrementRetryCounter("green_retries");
      sm.incrementRetryCounter("red_retries");
      sm.resetAllRetryCounters();
      assert.strictEqual(sm.getRetryCounter("green_retries"), 0);
      assert.strictEqual(sm.getRetryCounter("red_retries"), 0);
    });
  });

  describe("GREEN retry counter side effects", () => {
    it("should increment green_retries on GREEN_VALIDATE → GREEN_WRITE", () => {
      const sm = new StateMachine(makeConfig());
      walkToState(sm, "TDD_GREEN_VALIDATE");
      assert.strictEqual(sm.getRetryCounter("green_retries"), 0);
      forceTransition(sm, "TDD_GREEN_WRITE");
      assert.strictEqual(sm.getRetryCounter("green_retries"), 1);
    });

    it("should increment green_retries on each GREEN loop", () => {
      const sm = new StateMachine(makeConfig());
      walkToState(sm, "TDD_GREEN_VALIDATE");
      forceTransition(sm, "TDD_GREEN_WRITE");
      assert.strictEqual(sm.getRetryCounter("green_retries"), 1);
      forceTransition(sm, "TDD_GREEN_VALIDATE");
      forceTransition(sm, "TDD_GREEN_WRITE");
      assert.strictEqual(sm.getRetryCounter("green_retries"), 2);
      forceTransition(sm, "TDD_GREEN_VALIDATE");
      forceTransition(sm, "TDD_GREEN_WRITE");
      assert.strictEqual(sm.getRetryCounter("green_retries"), 3);
    });

    it("should reset green_retries on GREEN_VALIDATE → REVIEWING (unit complete)", () => {
      const sm = new StateMachine(makeConfig());
      walkToState(sm, "TDD_GREEN_VALIDATE");
      forceTransition(sm, "TDD_GREEN_WRITE");
      forceTransition(sm, "TDD_GREEN_VALIDATE");
      assert.strictEqual(sm.getRetryCounter("green_retries"), 1, "Should have 1 retry after going around once");
      forceTransition(sm, "REVIEWING");
      assert.strictEqual(sm.getRetryCounter("green_retries"), 0, "Should reset on transition to REVIEWING");
    });

    it("should reset green_retries on GREEN_VALIDATE → TDD_RED_WRITE (next unit)", () => {
      const sm = new StateMachine(makeConfig());
      walkToState(sm, "TDD_GREEN_VALIDATE");
      forceTransition(sm, "TDD_GREEN_WRITE");
      forceTransition(sm, "TDD_GREEN_VALIDATE");
      assert.strictEqual(sm.getRetryCounter("green_retries"), 1);
      forceTransition(sm, "TDD_RED_WRITE");
      assert.strictEqual(sm.getRetryCounter("green_retries"), 0, "Should reset on next unit transition");
    });

    it("should reset all retry counters on IDLE entry", () => {
      const sm = new StateMachine(makeConfig());
      walkToState(sm, "TDD_GREEN_VALIDATE");
      forceTransition(sm, "TDD_GREEN_WRITE");
      forceTransition(sm, "TDD_GREEN_VALIDATE");
      assert.strictEqual(sm.getRetryCounter("green_retries"), 1);
      forceTransition(sm, "IDLE");
      assert.strictEqual(sm.getRetryCounter("green_retries"), 0, "Should reset on IDLE entry");
    });
  });

  describe("GREEN_VALIDATE → GREEN_WRITE → BLOCKED (hard retry limit)", () => {
    it("should allow TDD_GREEN_WRITE → BLOCKED transition", () => {
      const sm = new StateMachine(makeConfig());
      walkToState(sm, "TDD_GREEN_WRITE");
      // TDD_GREEN_WRITE → BLOCKED is in legalTransitions
      const result = sm.transition("BLOCKED");
      assert.strictEqual(result, undefined, "Transition should succeed");
      assert.strictEqual(sm.currentState, "BLOCKED");
    });
  });

  describe("persistence", () => {
    it("should include retryCounters in toJSON", () => {
      const sm = new StateMachine(makeConfig());
      sm.incrementRetryCounter("green_retries");
      sm.incrementRetryCounter("green_retries");
      sm.incrementRetryCounter("red_retries");
      const json = sm.toJSON();
      assert.deepStrictEqual(json.retryCounters, { green_retries: 2, red_retries: 1 });
    });

    it("should include empty retryCounters in toJSON when none set", () => {
      const sm = new StateMachine(makeConfig());
      const json = sm.toJSON();
      assert.deepStrictEqual(json.retryCounters, {});
    });

    it("should restore retryCounters from fromJSON", () => {
      const sm = new StateMachine(makeConfig());
      sm.incrementRetryCounter("green_retries");
      sm.incrementRetryCounter("green_retries");
      sm.incrementRetryCounter("red_retries");
      const json = sm.toJSON();
      const restored = StateMachine.fromJSON(json, makeConfig());
      assert.strictEqual(restored.getRetryCounter("green_retries"), 2);
      assert.strictEqual(restored.getRetryCounter("red_retries"), 1);
    });

    it("should round-trip retryCounters through JSON", () => {
      const sm = new StateMachine(makeConfig());
      walkToState(sm, "TDD_GREEN_VALIDATE");
      forceTransition(sm, "TDD_GREEN_WRITE");
      forceTransition(sm, "TDD_GREEN_VALIDATE");
      forceTransition(sm, "TDD_GREEN_WRITE");
      // green_retries should be 2 at this point
      assert.strictEqual(sm.getRetryCounter("green_retries"), 2);
      const json = sm.toJSON();
      const restored = StateMachine.fromJSON(json, makeConfig());
      assert.strictEqual(restored.getRetryCounter("green_retries"), 2);
      // Restored machine should continue incrementing from the restored value
      forceTransition(restored, "TDD_GREEN_VALIDATE");
      forceTransition(restored, "TDD_GREEN_WRITE");
      assert.strictEqual(restored.getRetryCounter("green_retries"), 3);
    });

    it("should clear retry counters on reset()", () => {
      const sm = new StateMachine(makeConfig());
      sm.incrementRetryCounter("green_retries");
      sm.incrementRetryCounter("green_retries");
      sm.reset();
      assert.strictEqual(sm.getRetryCounter("green_retries"), 0);
    });
  });

  describe("LightStateMachine retry counters", () => {
    it("should support retry counter operations on LightStateMachine", () => {
      const sm = new LightStateMachine(makeConfig());
      assert.strictEqual(sm.getRetryCounter("any_key"), 0);
      sm.incrementRetryCounter("any_key");
      assert.strictEqual(sm.getRetryCounter("any_key"), 1);
      sm.resetRetryCounter("any_key");
      assert.strictEqual(sm.getRetryCounter("any_key"), 0);
    });

    it("should include retryCounters in LightStateMachine toJSON", () => {
      const sm = new LightStateMachine(makeConfig());
      sm.incrementRetryCounter("test_key");
      const json = sm.toJSON();
      assert.deepStrictEqual(json.retryCounters, { test_key: 1 });
    });

    it("should restore retryCounters in LightStateMachine fromJSON", () => {
      const sm = new LightStateMachine(makeConfig());
      sm.incrementRetryCounter("test_key");
      const json = sm.toJSON();
      const restored = LightStateMachine.fromJSON(json, makeConfig());
      assert.strictEqual(restored.getRetryCounter("test_key"), 1);
    });
  });

  // --- NEEDS_CHANGES → TDD_GREEN_WRITE transition ---

  describe("NEEDS_CHANGES → TDD_GREEN_WRITE", () => {
    function walkToNeedsChanges(sm: StateMachine): void {
      forceTransition(sm, "SPEC_WORK");
      forceTransition(sm, "SPEC_APPROVED");
      forceTransition(sm, "GIT_CHECKPOINT");
      sm.transition("TDD_RED_WRITE");
      forceTransition(sm, "TDD_RED_VALIDATE");
      sm.setEvidence("test_run_this_state");
      sm.transition("TDD_GREEN_WRITE");
      forceTransition(sm, "TDD_GREEN_VALIDATE");
      forceTransition(sm, "REVIEWING");
      forceTransition(sm, "NEEDS_CHANGES");
    }

    it("requires review_completed evidence", () => {
      const sm = new StateMachine(makeConfig());
      walkToNeedsChanges(sm);
      // Without evidence — guard should block
      const result = sm.transition("TDD_GREEN_WRITE");
      assert.ok(result !== undefined, "Should return guard error");
      assert.ok("missingEvidence" in result!);
      assert.ok((result as any).missingEvidence.includes("review_completed"));
      assert.strictEqual(sm.currentState, "NEEDS_CHANGES", "State should not have changed");
    });

    it("succeeds with review_completed evidence", () => {
      const sm = new StateMachine(makeConfig());
      walkToNeedsChanges(sm);
      sm.setEvidence("review_completed");
      const result = sm.transition("TDD_GREEN_WRITE");
      assert.strictEqual(result, undefined, "Transition should succeed");
      assert.strictEqual(sm.currentState, "TDD_GREEN_WRITE");
    });

    it("does not require non_functional_classified evidence", () => {
      const sm = new StateMachine(makeConfig());
      walkToNeedsChanges(sm);
      sm.setEvidence("review_completed");
      // Should succeed WITHOUT non_functional_classified
      const result = sm.transition("TDD_GREEN_WRITE");
      assert.strictEqual(result, undefined, "Transition should succeed");
      assert.strictEqual(sm.currentState, "TDD_GREEN_WRITE");
    });

    it("loops back via GREEN_VALIDATE → GREEN_WRITE on failure and increments retries", () => {
      const sm = new StateMachine(makeConfig());
      walkToNeedsChanges(sm);
      sm.setEvidence("review_completed");
      sm.transition("TDD_GREEN_WRITE");
      assert.strictEqual(sm.currentState, "TDD_GREEN_WRITE");
      // Arrive at GREEN_VALIDATE
      forceTransition(sm, "TDD_GREEN_VALIDATE");
      assert.strictEqual(sm.currentState, "TDD_GREEN_VALIDATE");
      assert.strictEqual(sm.getRetryCounter("green_retries"), 0, "No retries yet");
      // Simulate test failure → loops back to GREEN_WRITE
      sm.setEvidence("test_run_this_state");
      sm.transition("TDD_GREEN_WRITE");
      assert.strictEqual(sm.currentState, "TDD_GREEN_WRITE", "Should loop back to GREEN_WRITE on failure");
      assert.strictEqual(sm.getRetryCounter("green_retries"), 1, "Should have incremented green_retries");
    });
  });
});
