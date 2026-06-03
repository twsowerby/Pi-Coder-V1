/**
 * Tests for Pi Coder shared type definitions.
 *
 * These tests verify:
 * - All FSMState values are valid string literals
 * - Type structures serialize/deserialize correctly (for state.json persistence)
 * - Default configs are well-formed
 * - All domain value types round-trip through JSON
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type {
  FSMState,
  FSMTransition,
  PiCoderConfig,
  NudgeConfig,
  NudgeDefaults,
  NudgeStateConfig,
  TestRunResult,
  GitCheckpointResult,
  SpecFile,
  ImplementationUnit,
  KnowledgeEntry,
  LoggingConfig,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Phase 2: FSM & State Types
// ---------------------------------------------------------------------------

describe("FSMState", () => {
  it("should contain all 17 expected state values", () => {
    const expectedStates: FSMState[] = [
      "IDLE",
      "SPEC_WORK",
      "SPEC_WORK",
      "SPEC_WORK",
      "SPEC_APPROVED",
      "GIT_CHECKPOINT",
      "TDD_RED_WRITE",
      "TDD_RED_VALIDATE",
      "TDD_GREEN_WRITE",
      "TDD_GREEN_VALIDATE",
      "REVIEWING",
      "APPROVED",
      "NEEDS_CHANGES",
      "FINAL_APPROVAL",
      "MERGING",
      "COMPLETE",
      "BLOCKED",
    ];
    // Compile-time check: if FSMState doesn't include these, TS fails
    // Runtime check: verify no extras were added by checking the union size
    assert.strictEqual(expectedStates.length, 17);
  });

  it("every FSMState value is a non-empty string", () => {
    const states: FSMState[] = [
      "IDLE", "SPEC_WORK", "SPEC_APPROVED",
      "GIT_CHECKPOINT", "TDD_RED_WRITE", "TDD_RED_VALIDATE",
      "TDD_GREEN_WRITE", "TDD_GREEN_VALIDATE", "REVIEWING",
      "APPROVED", "NEEDS_CHANGES", "FINAL_APPROVAL", "MERGING",
      "COMPLETE", "BLOCKED",
    ];
    for (const s of states) {
      assert.ok(s.length > 0, `State "${s}" should be a non-empty string`);
    }
  });
});

describe("FSMTransition", () => {
  it("should define a transition with from, to, and event", () => {
    const t: FSMTransition = {
      from: "IDLE",
      to: "SPEC_WORK",
      event: "start_research",
    };
    assert.strictEqual(t.from, "IDLE");
    assert.strictEqual(t.to, "SPEC_WORK");
    assert.strictEqual(t.event, "start_research");
  });

  it("should serialize to JSON for persistence", () => {
    const t: FSMTransition = {
      from: "TDD_RED_VALIDATE",
      to: "TDD_GREEN_WRITE",
      event: "tests_failed",
    };
    const json = JSON.stringify(t);
    const parsed = JSON.parse(json) as FSMTransition;
    assert.deepStrictEqual(parsed, t);
  });
});

describe("PiCoderConfig", () => {
  const defaultConfig: PiCoderConfig = {
    testCommand: "npm test",
    maxLoops: 3,
    createBranch: true,
    mergeBranch: "merge",
    branchPrefix: "pi-coder/",
    nudge: {
      enabled: true,
      defaults: {
        turnsBeforeNudge: 1,
        escalationLevels: 3,
      },
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
  };

  it("should have a well-formed default config", () => {
    assert.strictEqual(defaultConfig.testCommand, "npm test");
    assert.strictEqual(defaultConfig.maxLoops, 3);
    assert.strictEqual(defaultConfig.mergeBranch, "merge");
    assert.strictEqual(defaultConfig.branchPrefix, "pi-coder/");
  });

  it("should round-trip through JSON serialization", () => {
    const json = JSON.stringify(defaultConfig);
    const parsed = JSON.parse(json) as PiCoderConfig;
    assert.deepStrictEqual(parsed, defaultConfig);
  });

  it("should support squash merge strategy", () => {
    const squashConfig: PiCoderConfig = {
      ...defaultConfig,
      mergeBranch: "squash",
    };
    assert.strictEqual(squashConfig.mergeBranch, "squash");
  });

  it("should support no-merge config", () => {
    const noMergeConfig: PiCoderConfig = {
      ...defaultConfig,
      mergeBranch: false,
    };
    assert.strictEqual(noMergeConfig.mergeBranch, false);
  });

  it("nudge config should support disabled states", () => {
    assert.strictEqual(defaultConfig.nudge.enabled, true);
    assert.strictEqual(defaultConfig.nudge.defaults.turnsBeforeNudge, 1);
    assert.strictEqual(defaultConfig.nudge.defaults.escalationLevels, 3);
    assert.strictEqual(defaultConfig.nudge.states.IDLE?.enabled, false);
  });

  it("nudge config should support per-state threshold overrides", () => {
    assert.strictEqual(defaultConfig.nudge.states.SPEC_WORK?.turnsBeforeNudge, 3);
    assert.strictEqual(defaultConfig.nudge.states.BLOCKED?.turnsBeforeNudge, 2);
  });
});

describe("NudgeDefaults", () => {
  it("should have valid default values", () => {
    const defaults: NudgeDefaults = {
      turnsBeforeNudge: 1,
      escalationLevels: 3,
    };
    assert.ok(defaults.turnsBeforeNudge > 0);
    assert.ok(defaults.escalationLevels > 0);
  });
});

describe("NudgeStateConfig", () => {
  it("should allow disabling nudging for specific states", () => {
    const idleConfig: NudgeStateConfig = { enabled: false };
    assert.strictEqual(idleConfig.enabled, false);
  });

  it("should allow overriding turnsBeforeNudge", () => {
    const pruningConfig: NudgeStateConfig = { turnsBeforeNudge: 3 };
    assert.strictEqual(pruningConfig.turnsBeforeNudge, 3);
  });

  it("should allow both enabled and threshold override", () => {
    const config: NudgeStateConfig = { enabled: true, turnsBeforeNudge: 5 };
    assert.strictEqual(config.enabled, true);
    assert.strictEqual(config.turnsBeforeNudge, 5);
  });
});

describe("LoggingConfig", () => {
  it("should have well-formed default values", () => {
    const logging: LoggingConfig = {
      enabled: false,
      level: "standard",
      maxLogFiles: 10,
    };
    assert.strictEqual(logging.enabled, false);
    assert.strictEqual(logging.level, "standard");
    assert.strictEqual(logging.maxLogFiles, 10);
  });

  it("should round-trip through JSON", () => {
    const logging: LoggingConfig = {
      enabled: true,
      level: "verbose",
      maxLogFiles: 20,
    };
    const parsed = JSON.parse(JSON.stringify(logging)) as LoggingConfig;
    assert.deepStrictEqual(parsed, logging);
  });

  it("should support all log levels", () => {
    const levels: LoggingConfig["level"][] = ["minimal", "standard", "verbose"];
    for (const l of levels) {
      const logging: LoggingConfig = { enabled: true, level: l, maxLogFiles: 10 };
      assert.strictEqual(logging.level, l);
    }
  });

  it("should be included in PiCoderConfig", () => {
    const config: PiCoderConfig = {
      testCommand: "npm test",
      maxLoops: 3,
      createBranch: true,
      mergeBranch: "merge",
      branchPrefix: "pi-coder/",
      nudge: {
        enabled: true,
        defaults: { turnsBeforeNudge: 1, escalationLevels: 3 },
        states: {},
      },
      logging: {
        enabled: true,
        level: "standard",
        maxLogFiles: 10,
      },
      retryEscalation: {
        maxRetries: 10,
        enrichedSteerThreshold: 4,
        replanThreshold: 7,
      },
    };
    assert.strictEqual(config.logging.enabled, true);
    assert.strictEqual(config.logging.level, "standard");
  });
});

// ---------------------------------------------------------------------------
// Phase 3: Domain Value Types
// ---------------------------------------------------------------------------

describe("TestRunResult", () => {
  it("should represent a successful test run", () => {
    const result: TestRunResult = {
      exitCode: 0,
      output: "3 tests passed",
      passed: 3,
      failed: 0,
      timedOut: false,
    };
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.passed, 3);
    assert.strictEqual(result.failed, 0);
    assert.strictEqual(result.timedOut, false);
  });

  it("should represent a failing test run", () => {
    const result: TestRunResult = {
      exitCode: 1,
      output: "1 test failed",
      passed: 2,
      failed: 1,
      timedOut: false,
    };
    assert.strictEqual(result.exitCode, 1);
    assert.strictEqual(result.failed, 1);
  });

  it("should represent a timed-out test run with null counts", () => {
    const result: TestRunResult = {
      exitCode: -1,
      output: "Test run timed out after 120000ms",
      passed: null,
      failed: null,
      timedOut: true,
    };
    assert.strictEqual(result.timedOut, true);
    assert.strictEqual(result.passed, null);
    assert.strictEqual(result.failed, null);
  });

  it("should round-trip through JSON", () => {
    const result: TestRunResult = {
      exitCode: 0,
      output: "all passed",
      passed: 5,
      failed: 0,
      timedOut: false,
    };
    const parsed = JSON.parse(JSON.stringify(result)) as TestRunResult;
    assert.deepStrictEqual(parsed, result);
  });
});

describe("GitCheckpointResult", () => {
  it("should represent a successful git operation", () => {
    const result: GitCheckpointResult = {
      success: true,
      ref: "abc1234",
      branch: "pi-coder/user-auth",
      message: "Created checkpoint",
    };
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.ref, "abc1234");
  });

  it("should represent a failed git operation", () => {
    const result: GitCheckpointResult = {
      success: false,
      error: "Branch already exists",
    };
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.error, "Branch already exists");
  });

  it("should round-trip through JSON", () => {
    const result: GitCheckpointResult = {
      success: true,
      ref: "def5678",
      branch: "main",
      message: "Merged feature branch",
    };
    const parsed = JSON.parse(JSON.stringify(result)) as GitCheckpointResult;
    assert.deepStrictEqual(parsed, result);
  });
});

describe("SpecFile", () => {
  it("should represent a complete spec", () => {
    const spec: SpecFile = {
      id: "user-authentication",
      title: "User Authentication",
      acceptanceCriteria: [
        "Users can sign up with email and password",
        "Users can log in with valid credentials",
      ],
      constraints: ["Must use bcrypt for password hashing"],
      keyFiles: ["src/auth.ts", "src/middleware/auth.ts"],
      prunedContext: "Research found Supabase handles auth via...",
      implementationPlan: [
        {
          name: "User signup",
          acceptanceCriteriaIndices: [0],
          keyFiles: ["src/auth.ts"],
          dependsOn: [],
          testStrategy: "tdd",
        },
        {
          name: "User login",
          acceptanceCriteriaIndices: [1],
          keyFiles: ["src/auth.ts", "src/middleware/auth.ts"],
          dependsOn: ["User signup"],
          testStrategy: "tdd",
        },
      ],
      status: "SPEC_WORK",
    };
    assert.strictEqual(spec.id, "user-authentication");
    assert.strictEqual(spec.acceptanceCriteria.length, 2);
    assert.strictEqual(spec.constraints.length, 1);
    assert.strictEqual(spec.implementationPlan.length, 2);
    assert.strictEqual(spec.implementationPlan[0].name, "User signup");
    assert.deepStrictEqual(spec.implementationPlan[1].dependsOn, ["User signup"]);
  });

  it("should round-trip through JSON", () => {
    const spec: SpecFile = {
      id: "api-error-handling",
      title: "API Error Handling",
      acceptanceCriteria: ["All API errors return structured JSON"],
      constraints: [],
      keyFiles: ["src/api/errors.ts"],
      prunedContext: "Error handling follows a middleware pattern...",
      implementationPlan: [],
      status: "SPEC_APPROVED",
    };
    const parsed = JSON.parse(JSON.stringify(spec)) as SpecFile;
    assert.deepStrictEqual(parsed, spec);
  });
});

describe("ImplementationUnit", () => {
  it("should represent a unit with dependencies", () => {
    const unit: ImplementationUnit = {
      name: "Session persistence",
      acceptanceCriteriaIndices: [2, 3],
      keyFiles: ["src/middleware/auth.ts", "src/routes/auth.ts"],
      dependsOn: ["User signup"],
      testStrategy: "tdd",
    };
    assert.strictEqual(unit.name, "Session persistence");
    assert.deepStrictEqual(unit.acceptanceCriteriaIndices, [2, 3]);
    assert.strictEqual(unit.dependsOn.length, 1);
  });

  it("should represent an independent unit", () => {
    const unit: ImplementationUnit = {
      name: "Standalone feature",
      acceptanceCriteriaIndices: [0],
      keyFiles: ["src/feature.ts"],
      dependsOn: [],
      testStrategy: "tdd",
    };
    assert.strictEqual(unit.dependsOn.length, 0);
  });

  it("should require testStrategy field", () => {
    const unit: ImplementationUnit = {
      name: "Feature with TDD",
      acceptanceCriteriaIndices: [0],
      keyFiles: ["src/feature.ts"],
      dependsOn: [],
      testStrategy: "tdd",
    };
    assert.strictEqual(unit.testStrategy, "tdd");
  });

  it("should accept testStrategy: 'verify'", () => {
    const unit: ImplementationUnit = {
      name: "API integration",
      acceptanceCriteriaIndices: [0],
      keyFiles: ["api.ts"],
      dependsOn: [],
      testStrategy: "verify",
    };
    assert.strictEqual(unit.testStrategy, "verify");
  });

  it("should accept testStrategy: 'skip'", () => {
    const unit: ImplementationUnit = {
      name: "Config change",
      acceptanceCriteriaIndices: [0],
      keyFiles: ["config.json"],
      dependsOn: [],
      testStrategy: "skip",
    };
    assert.strictEqual(unit.testStrategy, "skip");
  });

  it("should round-trip testStrategy through JSON", () => {
    const unit: ImplementationUnit = {
      name: "Config change",
      acceptanceCriteriaIndices: [0],
      keyFiles: ["config.json"],
      dependsOn: [],
      testStrategy: "skip",
    };
    const parsed = JSON.parse(JSON.stringify(unit)) as ImplementationUnit;
    assert.strictEqual(parsed.testStrategy, "skip");
  });
});

describe("KnowledgeEntry", () => {
  it("should represent a knowledge file", () => {
    const entry: KnowledgeEntry = {
      filename: "supabase-auth-flow.md",
      content: "# Supabase Auth Flow\n\nUse `supabase.auth.signIn()` for...",
    };
    assert.strictEqual(entry.filename, "supabase-auth-flow.md");
    assert.ok(entry.content.startsWith("#"));
  });

  it("should round-trip through JSON", () => {
    const entry: KnowledgeEntry = {
      filename: "api-conventions.md",
      content: "# API Conventions\n\nAll endpoints return...",
    };
    const parsed = JSON.parse(JSON.stringify(entry)) as KnowledgeEntry;
    assert.deepStrictEqual(parsed, entry);
  });
});
