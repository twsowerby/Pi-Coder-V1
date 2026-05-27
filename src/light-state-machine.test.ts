/**
 * Tests for Pi Coder Light Mode FSM State Machine.
 *
 * Mirrors the structure of state-machine.test.ts but tests the
 * simplified lifecycle (no TDD RED/GREEN phases).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LightStateMachine } from "./light-state-machine.ts";
import type { LightFSMState, PiCoderConfig, EvidenceFlag } from "./types.ts";
import { makeConfig } from "./test/state-machine-helpers.ts";

/**
 * Force a transition, setting required evidence first.
 * Throws if the transition returns a guard error.
 */
function forceTransition(sm: LightStateMachine, to: LightFSMState): void {
  const from = sm.currentState;
  if (from === "SPEC_WORK" && to === "SPEC_APPROVED") {
    sm.setEvidence("spec_saved");
    sm.setEvidence("spec_user_approved");
  }
  if (from === "NEEDS_CHANGES" && to === "REVIEWING") {
    sm.setEvidence("non_functional_classified");
  }
  const result = sm.transition(to);
  if (result) {
    throw new Error(`Transition guard blocked ${from} → ${to}: ${result.message}`);
  }
}

// ---------------------------------------------------------------------------
// State & Transition Table
// ---------------------------------------------------------------------------

describe("LightStateMachine: State & Transition Table", () => {
  describe("transition - legal transitions", () => {
    const legalTransitions: Array<{ from: LightFSMState; to: LightFSMState; event: string }> = [
      { from: "IDLE", to: "SPEC_WORK", event: "start_spec_work" },
      { from: "SPEC_WORK", to: "SPEC_APPROVED", event: "spec_approved" },
      { from: "SPEC_APPROVED", to: "GIT_CHECKPOINT", event: "checkpoint_start" },
      { from: "GIT_CHECKPOINT", to: "IMPLEMENTING", event: "checkpoint_complete" },
      { from: "IMPLEMENTING", to: "REVIEWING", event: "implementation_complete" },
      { from: "REVIEWING", to: "APPROVED", event: "review_approved" },
      { from: "REVIEWING", to: "NEEDS_CHANGES", event: "review_needs_changes" },
      { from: "NEEDS_CHANGES", to: "IMPLEMENTING", event: "reimplement" },
      { from: "NEEDS_CHANGES", to: "REVIEWING", event: "non_functional_fix" },
      { from: "APPROVED", to: "FINAL_APPROVAL", event: "final_approval" },
      { from: "FINAL_APPROVAL", to: "MERGING", event: "merge_start" },
      { from: "MERGING", to: "COMPLETE", event: "merge_complete" },
    ];

    for (const { from, to, event } of legalTransitions) {
      it(`should allow ${from} → ${to} (${event})`, () => {
        const sm = new LightStateMachine(makeConfig());
        walkToState(sm, from);
        assert.equal(sm.currentState, from);
        forceTransition(sm, to);
        assert.equal(sm.currentState, to);
      });
    }

    it("should allow BLOCKED → any other state (user intervention)", () => {
      const states: LightFSMState[] = [
        "IDLE", "SPEC_WORK", "SPEC_APPROVED",
        "GIT_CHECKPOINT", "IMPLEMENTING", "REVIEWING",
        "APPROVED", "NEEDS_CHANGES", "FINAL_APPROVAL",
        "MERGING", "COMPLETE", "BLOCKED",
      ];
      for (const target of states) {
        const sm = new LightStateMachine(makeConfig());
        walkToState(sm, "BLOCKED");
        assert.equal(sm.currentState, "BLOCKED");
        forceTransition(sm, target);
        assert.equal(sm.currentState, target);
      }
    });

    it("should allow any state → IDLE (abort)", () => {
      const states: LightFSMState[] = [
        "SPEC_WORK", "SPEC_APPROVED",
        "GIT_CHECKPOINT", "IMPLEMENTING", "REVIEWING",
        "APPROVED", "NEEDS_CHANGES", "FINAL_APPROVAL", "MERGING",
        "BLOCKED",
      ];
      for (const from of states) {
        const sm = new LightStateMachine(makeConfig());
        walkToState(sm, from);
        forceTransition(sm, "IDLE");
        assert.equal(sm.currentState, "IDLE");
      }
    });
  });

  describe("getValidTransitions", () => {
    it("should list IMPLEMENTING and REVIEWING from NEEDS_CHANGES", () => {
      const sm = new LightStateMachine(makeConfig());
      walkToState(sm, "NEEDS_CHANGES");
      const valid = sm.getValidTransitions();
      assert.ok(valid.includes("IMPLEMENTING"), "Should include IMPLEMENTING (functional fix)");
      assert.ok(valid.includes("REVIEWING"), "Should include REVIEWING (non-functional fix)");
      assert.ok(valid.includes("IDLE"), "Should include IDLE (abort)");
    });

    it("should list REVIEWING from IMPLEMENTING", () => {
      const sm = new LightStateMachine(makeConfig());
      walkToState(sm, "IMPLEMENTING");
      const valid = sm.getValidTransitions();
      assert.ok(valid.includes("REVIEWING"), "Should include REVIEWING");
      assert.ok(valid.includes("IDLE"), "Should include IDLE (abort)");
    });
  });

  describe("transition - illegal transitions", () => {
    it("should throw on IDLE → IMPLEMENTING (skip spec)", () => {
      const sm = new LightStateMachine(makeConfig());
      assert.throws(
        () => sm.transition("IMPLEMENTING"),
        /illegal transition/i,
      );
    });

    it("should throw on IDLE → COMPLETE (skip everything)", () => {
      const sm = new LightStateMachine(makeConfig());
      assert.throws(
        () => sm.transition("COMPLETE"),
        /illegal transition/i,
      );
    });

    it("should throw on SPEC_WORK → IMPLEMENTING (skip approval)", () => {
      const sm = new LightStateMachine(makeConfig());
      walkToState(sm, "SPEC_WORK");
      assert.throws(
        () => sm.transition("IMPLEMENTING"),
        /illegal transition/i,
      );
    });

    it("should throw on IMPLEMENTING → APPROVED (skip review)", () => {
      const sm = new LightStateMachine(makeConfig());
      walkToState(sm, "IMPLEMENTING");
      assert.throws(
        () => sm.transition("APPROVED"),
        /illegal transition/i,
      );
    });

    it("should throw on REVIEWING → IMPLEMENTING (missing verdict)", () => {
      const sm = new LightStateMachine(makeConfig());
      walkToState(sm, "REVIEWING");
      assert.throws(
        () => sm.transition("IMPLEMENTING"),
        /illegal transition/i,
      );
    });

    it("should include the from/to states in the error message", () => {
      const sm = new LightStateMachine(makeConfig());
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

  describe("TDD states are rejected", () => {
    const tddStates: string[] = [
      "TDD_RED_WRITE", "TDD_RED_VALIDATE",
      "TDD_GREEN_WRITE", "TDD_GREEN_VALIDATE",
    ];

    for (const state of tddStates) {
      it(`should throw on transition to TDD-only state ${state}`, () => {
        const sm = new LightStateMachine(makeConfig());
        walkToState(sm, "IMPLEMENTING");
        assert.throws(
          () => sm.transition(state),
          /illegal transition/i,
        );
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Transition Side Effects
// ---------------------------------------------------------------------------

describe("LightStateMachine: Transition Side Effects", () => {
  describe("loop counter", () => {
    it("should start at 0", () => {
      const sm = new LightStateMachine(makeConfig());
      assert.equal(sm.loopCount, 0);
    });

    it("should increment on NEEDS_CHANGES → IMPLEMENTING", () => {
      const sm = new LightStateMachine(makeConfig());
      walkToState(sm, "REVIEWING");
      forceTransition(sm, "NEEDS_CHANGES");
      assert.equal(sm.loopCount, 0); // Not yet incremented
      forceTransition(sm, "IMPLEMENTING");
      assert.equal(sm.loopCount, 1);
    });

    it("should increment on NEEDS_CHANGES → REVIEWING (non-functional fix)", () => {
      const sm = new LightStateMachine(makeConfig());
      walkToState(sm, "REVIEWING");
      forceTransition(sm, "NEEDS_CHANGES");
      assert.equal(sm.loopCount, 0);
      forceTransition(sm, "REVIEWING"); // Non-functional fix
      assert.equal(sm.loopCount, 1);
    });

    it("should increment on each review cycle", () => {
      const sm = new LightStateMachine(makeConfig());
      // Cycle 1
      walkToState(sm, "REVIEWING");
      forceTransition(sm, "NEEDS_CHANGES");
      forceTransition(sm, "IMPLEMENTING");
      assert.equal(sm.loopCount, 1);
      // Cycle 2
      forceTransition(sm, "REVIEWING");
      forceTransition(sm, "NEEDS_CHANGES");
      forceTransition(sm, "IMPLEMENTING");
      assert.equal(sm.loopCount, 2);
    });

    it("should reset to 0 on IDLE entry", () => {
      const sm = new LightStateMachine(makeConfig());
      walkToState(sm, "REVIEWING");
      forceTransition(sm, "NEEDS_CHANGES");
      forceTransition(sm, "IMPLEMENTING");
      assert.equal(sm.loopCount, 1);
      forceTransition(sm, "IDLE"); // abort
      assert.equal(sm.loopCount, 0);
    });
  });

  describe("circuit breaker", () => {
    it("should not be tripped initially", () => {
      const sm = new LightStateMachine(makeConfig());
      assert.equal(sm.circuitBreakerTripped(), false);
    });

    it("should not be tripped after maxLoops - 1 cycles", () => {
      const sm = new LightStateMachine(makeConfig({ maxLoops: 3 }));
      fullReviewCycle(sm, 2);
      assert.equal(sm.loopCount, 2);
      assert.equal(sm.circuitBreakerTripped(), false);
    });

    it("should be tripped when loopCount reaches maxLoops", () => {
      const sm = new LightStateMachine(makeConfig({ maxLoops: 3 }));
      fullReviewCycle(sm, 3);
      assert.equal(sm.loopCount, 3);
      assert.equal(sm.circuitBreakerTripped(), true);
    });

    it("should be tripped after 1 cycle when maxLoops is 1", () => {
      const sm = new LightStateMachine(makeConfig({ maxLoops: 1 }));
      fullReviewCycle(sm, 1);
      assert.equal(sm.circuitBreakerTripped(), true);
    });
  });

  describe("gitRef", () => {
    it("should start as null", () => {
      const sm = new LightStateMachine(makeConfig());
      assert.equal(sm.gitRef, null);
    });

    it("should track gitRef after setGitRef", () => {
      const sm = new LightStateMachine(makeConfig());
      sm.setGitRef("abc1234");
      assert.equal(sm.gitRef, "abc1234");
    });

    it("should clear on reset()", () => {
      const sm = new LightStateMachine(makeConfig());
      sm.setGitRef("abc1234");
      sm.reset();
      assert.equal(sm.gitRef, null);
      assert.equal(sm.currentState, "IDLE");
      assert.equal(sm.loopCount, 0);
    });
  });
});

// ---------------------------------------------------------------------------
// Action Guards
// ---------------------------------------------------------------------------

describe("LightStateMachine: Action Guards", () => {
  describe("isActionAllowed - pi_coder_run_tests", () => {
    const allStates: LightFSMState[] = [
      "IDLE", "SPEC_WORK", "SPEC_APPROVED", "GIT_CHECKPOINT",
      "IMPLEMENTING", "REVIEWING", "APPROVED", "NEEDS_CHANGES",
      "FINAL_APPROVAL", "MERGING", "COMPLETE", "BLOCKED",
    ];

    for (const state of allStates) {
      it(`should allow pi_coder_run_tests in ${state} (advisory, no gates)`, () => {
        const sm = new LightStateMachine(makeConfig());
        walkToState(sm, state);
        assert.equal(sm.isActionAllowed("pi_coder_run_tests"), true);
      });
    }
  });

  describe("isActionAllowed - subagent with target agents", () => {
    it("should allow subagent+researcher in SPEC_WORK", () => {
      const sm = new LightStateMachine(makeConfig());
      walkToState(sm, "SPEC_WORK");
      assert.equal(sm.isActionAllowed("subagent", "pi-coder.researcher"), true);
    });

    it("should allow subagent+researcher in IMPLEMENTING", () => {
      const sm = new LightStateMachine(makeConfig());
      walkToState(sm, "IMPLEMENTING");
      assert.equal(sm.isActionAllowed("subagent", "pi-coder.researcher"), true);
    });

    it("should NOT allow subagent+researcher in IDLE", () => {
      const sm = new LightStateMachine(makeConfig());
      assert.equal(sm.isActionAllowed("subagent", "pi-coder.researcher"), false);
    });

    it("should allow subagent+implementor in IMPLEMENTING", () => {
      const sm = new LightStateMachine(makeConfig());
      walkToState(sm, "IMPLEMENTING");
      assert.equal(sm.isActionAllowed("subagent", "pi-coder.implementor"), true);
    });

    it("should allow subagent+implementor in NEEDS_CHANGES", () => {
      const sm = new LightStateMachine(makeConfig());
      walkToState(sm, "NEEDS_CHANGES");
      assert.equal(sm.isActionAllowed("subagent", "pi-coder.implementor"), true);
    });

    it("should NOT allow subagent+implementor in SPEC_WORK", () => {
      const sm = new LightStateMachine(makeConfig());
      walkToState(sm, "SPEC_WORK");
      assert.equal(sm.isActionAllowed("subagent", "pi-coder.implementor"), false);
    });

    it("should allow subagent+reviewer in REVIEWING", () => {
      const sm = new LightStateMachine(makeConfig());
      walkToState(sm, "REVIEWING");
      assert.equal(sm.isActionAllowed("subagent", "pi-coder.reviewer"), true);
    });

    it("should NOT allow subagent+reviewer in IMPLEMENTING", () => {
      const sm = new LightStateMachine(makeConfig());
      walkToState(sm, "IMPLEMENTING");
      assert.equal(sm.isActionAllowed("subagent", "pi-coder.reviewer"), false);
    });

    it("should NOT allow subagent without a target agent in IDLE", () => {
      const sm = new LightStateMachine(makeConfig());
      assert.equal(sm.isActionAllowed("subagent"), false);
    });
  });

  describe("isActionAllowed - pi_coder_git", () => {
    const allowedStates: LightFSMState[] = ["GIT_CHECKPOINT", "REVIEWING", "MERGING", "BLOCKED", "IDLE"];
    const blockedStates: LightFSMState[] = [
      "SPEC_WORK", "SPEC_APPROVED",
      "IMPLEMENTING", "APPROVED", "NEEDS_CHANGES", "FINAL_APPROVAL",
    ];

    for (const state of allowedStates) {
      it(`should allow pi_coder_git in ${state}`, () => {
        const sm = new LightStateMachine(makeConfig());
        walkToState(sm, state);
        assert.equal(sm.isActionAllowed("pi_coder_git"), true);
      });
    }

    for (const state of blockedStates) {
      it(`should NOT allow pi_coder_git in ${state}`, () => {
        const sm = new LightStateMachine(makeConfig());
        walkToState(sm, state);
        assert.equal(sm.isActionAllowed("pi_coder_git"), false);
      });
    }
  });

  describe("isActionAllowed - always-allowed tools", () => {
    const alwaysAllowed = ["upsert_knowledge", "ls", "find", "grep"];
    const states: LightFSMState[] = [
      "IDLE", "SPEC_WORK", "SPEC_APPROVED",
      "GIT_CHECKPOINT", "IMPLEMENTING", "REVIEWING",
    ];

    for (const tool of alwaysAllowed) {
      for (const state of states) {
        it(`should allow ${tool} in ${state}`, () => {
          const sm = new LightStateMachine(makeConfig());
          walkToState(sm, state);
          assert.equal(sm.isActionAllowed(tool), true);
        });
      }
    }
  });

  describe("canNudge", () => {
    it("should nudge in SPEC_WORK — expected: delegate to researcher", () => {
      const sm = new LightStateMachine(makeConfig());
      walkToState(sm, "SPEC_WORK");
      const result = sm.canNudge();
      assert.equal(result.shouldNudge, true);
      assert.equal(result.expectedTool, "subagent");
      assert.ok(result.expectedAction.includes("researcher"));
    });

    it("should nudge in GIT_CHECKPOINT — expected: git checkpoint", () => {
      const sm = new LightStateMachine(makeConfig());
      walkToState(sm, "GIT_CHECKPOINT");
      const result = sm.canNudge();
      assert.equal(result.shouldNudge, true);
      assert.equal(result.expectedTool, "pi_coder_git");
    });

    it("should nudge in IMPLEMENTING — expected: delegate to implementor", () => {
      const sm = new LightStateMachine(makeConfig());
      walkToState(sm, "IMPLEMENTING");
      const result = sm.canNudge();
      assert.equal(result.shouldNudge, true);
      assert.equal(result.expectedTool, "subagent");
      assert.ok(result.expectedAction.includes("implementor"));
    });

    it("should nudge in REVIEWING — expected: delegate to reviewer", () => {
      const sm = new LightStateMachine(makeConfig());
      walkToState(sm, "REVIEWING");
      const result = sm.canNudge();
      assert.equal(result.shouldNudge, true);
      assert.equal(result.expectedTool, "subagent");
      assert.ok(result.expectedAction.includes("reviewer"));
    });

    it("should nudge in NEEDS_CHANGES — expected: implementor or advance", () => {
      const sm = new LightStateMachine(makeConfig());
      walkToState(sm, "NEEDS_CHANGES");
      const result = sm.canNudge();
      assert.equal(result.shouldNudge, true);
      assert.equal(result.expectedTool, "subagent");
      assert.ok(result.expectedAction.includes("IMPLEMENTING"));
    });

    it("should NOT nudge in IDLE", () => {
      const sm = new LightStateMachine(makeConfig());
      assert.equal(sm.canNudge().shouldNudge, false);
    });

    it("should NOT nudge in SPEC_APPROVED", () => {
      const sm = new LightStateMachine(makeConfig());
      walkToState(sm, "SPEC_APPROVED");
      assert.equal(sm.canNudge().shouldNudge, false);
    });

    it("should NOT nudge in FINAL_APPROVAL", () => {
      const sm = new LightStateMachine(makeConfig());
      walkToState(sm, "FINAL_APPROVAL");
      assert.equal(sm.canNudge().shouldNudge, false);
    });

    it("should NOT nudge in COMPLETE", () => {
      const sm = new LightStateMachine(makeConfig());
      walkToState(sm, "COMPLETE");
      assert.equal(sm.canNudge().shouldNudge, false);
    });
  });

  describe("guard methods are pure reads", () => {
    it("isActionAllowed should not change state", () => {
      const sm = new LightStateMachine(makeConfig());
      walkToState(sm, "IMPLEMENTING");
      const stateBefore = sm.currentState;
      sm.isActionAllowed("pi_coder_run_tests");
      assert.equal(sm.currentState, stateBefore);
    });

    it("isActionAllowed should not change loopCount", () => {
      const sm = new LightStateMachine(makeConfig());
      fullReviewCycle(sm, 2);
      const countBefore = sm.loopCount;
      sm.isActionAllowed("pi_coder_run_tests");
      assert.equal(sm.loopCount, countBefore);
    });

    it("canNudge should not change state", () => {
      const sm = new LightStateMachine(makeConfig());
      walkToState(sm, "SPEC_WORK");
      const stateBefore = sm.currentState;
      sm.canNudge();
      assert.equal(sm.currentState, stateBefore);
    });
  });
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

describe("LightStateMachine: Persistence", () => {
  describe("toJSON", () => {
    it("should return a plain object with currentState, loopCount, gitRef, evidence", () => {
      const sm = new LightStateMachine(makeConfig());
      const json = sm.toJSON();
      assert.equal(json.currentState, "IDLE");
      assert.equal(json.loopCount, 0);
      assert.equal(json.gitRef, null);
      assert.deepStrictEqual(json.evidence, []);
    });

    it("should reflect current state after transitions", () => {
      const sm = new LightStateMachine(makeConfig());
      sm.setGitRef("abc1234");
      walkToState(sm, "REVIEWING");
      const json = sm.toJSON();
      assert.equal(json.currentState, "REVIEWING");
      assert.equal(json.gitRef, "abc1234");
      assert.equal(json.loopCount, 0);
      assert.ok(json.evidence.includes("spec_saved" as EvidenceFlag));
      assert.ok(json.evidence.includes("spec_user_approved" as EvidenceFlag));
    });

    it("should reflect loop count after review cycles", () => {
      const sm = new LightStateMachine(makeConfig());
      fullReviewCycle(sm, 2);
      const json = sm.toJSON();
      assert.equal(json.loopCount, 2);
    });
  });

  describe("fromJSON", () => {
    it("should restore IDLE state with no gitRef", () => {
      const sm = new LightStateMachine(makeConfig());
      const json = sm.toJSON();
      const restored = LightStateMachine.fromJSON(json, makeConfig());
      assert.equal(restored.currentState, "IDLE");
      assert.equal(restored.gitRef, null);
      assert.equal(restored.loopCount, 0);
      assert.deepStrictEqual(restored.getEvidence(), []);
    });

    it("should restore a mid-lifecycle state with evidence", () => {
      const sm = new LightStateMachine(makeConfig());
      sm.setGitRef("deadbeef");
      walkToState(sm, "IMPLEMENTING");

      const json = sm.toJSON();
      const restored = LightStateMachine.fromJSON(json, makeConfig());
      assert.equal(restored.currentState, "IMPLEMENTING");
      assert.equal(restored.gitRef, "deadbeef");
      assert.ok(restored.getEvidence().includes("spec_saved"));
      assert.equal(restored.loopCount, json.loopCount);
    });

    it("should restore loop count", () => {
      const sm = new LightStateMachine(makeConfig());
      fullReviewCycle(sm, 2);
      const json = sm.toJSON();
      const restored = LightStateMachine.fromJSON(json, makeConfig());
      assert.equal(restored.loopCount, 2);
    });

    it("should produce a machine that can continue transitioning", () => {
      const sm = new LightStateMachine(makeConfig());
      sm.setGitRef("abc1234");
      walkToState(sm, "IMPLEMENTING");

      const json = sm.toJSON();
      const restored = LightStateMachine.fromJSON(json, makeConfig());
      restored.transition("REVIEWING");
      assert.equal(restored.currentState, "REVIEWING");
    });
  });

  describe("round-trip integrity", () => {
    const states: LightFSMState[] = [
      "IDLE", "SPEC_WORK", "SPEC_APPROVED",
      "GIT_CHECKPOINT", "IMPLEMENTING", "REVIEWING",
    ];

    for (const state of states) {
      it(`should round-trip through JSON for state ${state}`, () => {
        const sm = new LightStateMachine(makeConfig());
        walkToState(sm, state);
        const json = sm.toJSON();
        const restored = LightStateMachine.fromJSON(json, makeConfig());
        assert.equal(restored.currentState, state);
        assert.equal(restored.gitRef, sm.gitRef);
        assert.equal(restored.loopCount, sm.loopCount);
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Evidence & Guard Tests
// ---------------------------------------------------------------------------

describe("LightStateMachine: Evidence & Transition Guards", () => {
  it("SPEC_WORK → SPEC_APPROVED requires spec_saved AND spec_user_approved", () => {
    const sm = new LightStateMachine(makeConfig());
    walkToState(sm, "SPEC_WORK");

    // No evidence — should fail
    let result = sm.transition("SPEC_APPROVED");
    assert.ok(result !== undefined, "Should return guard error without evidence");
    assert.ok("missingEvidence" in result!);

    // Partial evidence — should still fail
    sm.setEvidence("spec_saved");
    result = sm.transition("SPEC_APPROVED");
    assert.ok(result !== undefined, "Should fail with only spec_saved");
    assert.ok((result as any).missingEvidence.includes("spec_user_approved"));

    // All evidence — should succeed
    sm.setEvidence("spec_user_approved");
    result = sm.transition("SPEC_APPROVED");
    assert.strictEqual(result, undefined, "Should succeed with all evidence");
    assert.strictEqual(sm.currentState, "SPEC_APPROVED");
  });

  it("NEEDS_CHANGES → REVIEWING requires non_functional_classified evidence", () => {
    const sm = new LightStateMachine(makeConfig());
    walkToState(sm, "NEEDS_CHANGES");

    // Without evidence — guard should block
    const result = sm.transition("REVIEWING");
    assert.ok(result !== undefined, "Should return guard error");
    assert.ok("missingEvidence" in result!);
    assert.ok((result as any).missingEvidence.includes("non_functional_classified"));
    assert.strictEqual(sm.currentState, "NEEDS_CHANGES", "State should not have changed");
  });

  it("NEEDS_CHANGES → REVIEWING succeeds with non_functional_classified evidence", () => {
    const sm = new LightStateMachine(makeConfig());
    walkToState(sm, "NEEDS_CHANGES");
    sm.setEvidence("non_functional_classified");
    const result = sm.transition("REVIEWING");
    assert.strictEqual(result, undefined, "Transition should succeed");
    assert.strictEqual(sm.currentState, "REVIEWING");
  });

  it("NEEDS_CHANGES → IMPLEMENTING does NOT require evidence (functional fix)", () => {
    const sm = new LightStateMachine(makeConfig());
    walkToState(sm, "NEEDS_CHANGES");
    // No evidence needed for the functional fix path
    const result = sm.transition("IMPLEMENTING");
    assert.strictEqual(result, undefined, "Should succeed without evidence");
    assert.strictEqual(sm.currentState, "IMPLEMENTING");
  });

  it("test_run_this_state evidence is never required (no TDD gates)", () => {
    const sm = new LightStateMachine(makeConfig());
    walkToState(sm, "IMPLEMENTING");
    // Can transition to REVIEWING without any test_run_this_state evidence
    const result = sm.transition("REVIEWING");
    assert.strictEqual(result, undefined, "No test evidence required in light mode");
    assert.strictEqual(sm.currentState, "REVIEWING");
  });

  it("persistent evidence survives transitions", () => {
    const sm = new LightStateMachine(makeConfig());
    sm.setEvidence("spec_saved");
    sm.setEvidence("spec_user_approved");
    walkToState(sm, "SPEC_WORK");
    forceTransition(sm, "SPEC_APPROVED");
    // spec_saved and spec_user_approved are persistent — should still be there
    assert.equal(sm.hasEvidence("spec_saved"), true);
    assert.equal(sm.hasEvidence("spec_user_approved"), true);
  });

  it("persistent evidence cleared on IDLE reset", () => {
    const sm = new LightStateMachine(makeConfig());
    sm.setEvidence("spec_saved");
    sm.setEvidence("spec_user_approved");
    walkToState(sm, "SPEC_WORK");
    forceTransition(sm, "SPEC_APPROVED");
    forceTransition(sm, "IDLE");
    assert.equal(sm.hasEvidence("spec_saved"), false);
    assert.equal(sm.hasEvidence("spec_user_approved"), false);
  });
});

// ---------------------------------------------------------------------------
// IStateMachine interface compliance
// ---------------------------------------------------------------------------

describe("LightStateMachine: IStateMachine interface", () => {
  it("implements all IStateMachine methods", () => {
    const sm: import("./types.ts").IStateMachine = new LightStateMachine(makeConfig());
    // Verify the interface methods exist and work
    assert.equal(typeof sm.currentState, "string");
    assert.equal(typeof sm.loopCount, "number");
    assert.equal(typeof sm.gitRef, "object"); // null
    assert.equal(typeof sm.setEvidence, "function");
    assert.equal(typeof sm.hasEvidence, "function");
    assert.equal(typeof sm.getEvidence, "function");
    assert.equal(typeof sm.transition, "function");
    assert.equal(typeof sm.isActionAllowed, "function");
    assert.equal(typeof sm.getValidTransitions, "function");
    assert.equal(typeof sm.circuitBreakerTripped, "function");
    assert.equal(typeof sm.canNudge, "function");
    assert.equal(typeof sm.setGitRef, "function");
    assert.equal(typeof sm.reset, "function");
    assert.equal(typeof sm.toJSON, "function");
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Walk the Light FSM from IDLE to the given target state via the happy path.
 */
function walkToState(sm: LightStateMachine, target: LightFSMState): void {
  const happyPath: LightFSMState[] = [
    "IDLE",
    "SPEC_WORK",
    "SPEC_APPROVED",
    "GIT_CHECKPOINT",
    "IMPLEMENTING",
    "REVIEWING",
    "APPROVED",
    "FINAL_APPROVAL",
    "MERGING",
    "COMPLETE",
  ];

  const targetIdx = happyPath.indexOf(target);

  // Handle states not on the main happy path
  if (target === "BLOCKED") {
    // BLOCKED is reachable from any state via wildcard transition.
    // Just walk to any state and directly transition.
    walkToState(sm, "SPEC_WORK");
    sm.transition("BLOCKED");
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
 * Each cycle: REVIEWING → NEEDS_CHANGES → IMPLEMENTING → REVIEWING
 */
function fullReviewCycle(sm: LightStateMachine, n: number): void {
  if (sm.currentState !== "REVIEWING") {
    walkToState(sm, "REVIEWING");
  }

  for (let i = 0; i < n; i++) {
    forceTransition(sm, "NEEDS_CHANGES");
    forceTransition(sm, "IMPLEMENTING");
    if (i < n - 1) {
      forceTransition(sm, "REVIEWING");
    }
  }
}
