/**
 * Tests for Spec File Management.
 *
 * Phase 1: generateSpecId — slugify user requests into unique spec IDs
 * Phase 2: SpecManager — create, read, update, delete spec files
 * Phase 3: Round-trip integrity — create→read, update→read, delete→read
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { generateSpecId, SpecManager } from "./spec.ts";
import type { SpecFile } from "./types.ts";

// ---------------------------------------------------------------------------
// Phase 1: Spec ID Generation
// ---------------------------------------------------------------------------

/** Extract the slug portion from a timestamped spec ID. */
function extractSlug(id: string): string {
  // Format: YYYY-MM-DD-HHmm-{slug}
  // Timestamp is always 16 chars + hyphen
  const match = id.match(/^\d{4}-\d{2}-\d{2}-\d{4}-(.+)$/);
  return match ? match[1] : id; // fallback if no timestamp prefix
}

describe("generateSpecId", () => {
  it("should include timestamp prefix", () => {
    const id = generateSpecId("Implement user authentication", []);
    assert.ok(/^\d{4}-\d{2}-\d{2}-\d{4}-/.test(id), `ID "${id}" should start with timestamp`);
  });

  it("should slugify a normal request", () => {
    const id = generateSpecId("Implement user authentication", []);
    assert.strictEqual(extractSlug(id), "implement-user-authentication");
  });

  it("should lowercase everything", () => {
    const id = generateSpecId("Add API Error Handling", []);
    assert.strictEqual(extractSlug(id), "add-api-error-handling");
  });

  it("should replace non-alphanumeric runs with a single hyphen", () => {
    const id = generateSpecId("Fix the   bug in auth!!! now", []);
    assert.strictEqual(extractSlug(id), "fix-the-bug-in-auth-now");
  });

  it("should trim leading and trailing hyphens", () => {
    const id = generateSpecId("  hello world  ", []);
    assert.strictEqual(extractSlug(id), "hello-world");
  });

  it("should truncate slug to 40 characters", () => {
    const id = generateSpecId(
      "this is a very long request that exceeds the forty character limit by a good amount",
      []
    );
    assert.ok(extractSlug(id).length <= 40, `Slug "${extractSlug(id)}" should be <= 40 chars, got ${extractSlug(id).length}`);
  });

  it("should truncate at 40 chars without breaking mid-word at boundary", () => {
    const id = generateSpecId("a".repeat(50), []);
    assert.strictEqual(extractSlug(id), "a".repeat(40));
  });

  it("should default to 'spec' for empty requests", () => {
    const id = generateSpecId("", []);
    assert.strictEqual(extractSlug(id), "spec");
  });

  it("should default to 'spec' for requests with only special characters", () => {
    const id = generateSpecId("!@#$%^&*()", []);
    assert.strictEqual(extractSlug(id), "spec");
  });

  it("should default to 'spec' for whitespace-only requests", () => {
    const id = generateSpecId("   \t\n  ", []);
    assert.strictEqual(extractSlug(id), "spec");
  });

  it("should append -2 suffix on collision with existing timestamped ID", () => {
    const existing = [generateSpecId("user auth", [])];
    const id = generateSpecId("user auth", existing);
    assert.ok(id.endsWith("-2"), `ID "${id}" should end with -2`);
  });

  it("should increment counter for multiple collisions", () => {
    const first = generateSpecId("user auth", []);
    const second = generateSpecId("user auth", [first]);
    const third = generateSpecId("user auth", [first, second]);
    assert.ok(third.endsWith("-3"), `ID "${third}" should end with -3`);
  });

  it("should handle collision with spec default", () => {
    const first = generateSpecId("", []);
    const id = generateSpecId("", [first]);
    assert.ok(id.endsWith("-2"), `ID "${id}" should end with -2`);
  });

  it("should not append suffix when no collision", () => {
    const id = generateSpecId("new feature", ["2026-05-25-1430-user-auth"]);
    assert.ok(!id.endsWith("-2"), `ID "${id}" should NOT end with -2`);
  });

  it("should handle mixed alphanumeric input", () => {
    const id = generateSpecId("Add OAuth2 callback handler v3", []);
    assert.strictEqual(extractSlug(id), "add-oauth2-callback-handler-v3");
  });
});

// ---------------------------------------------------------------------------
// Phase 2: Spec File Operations
// ---------------------------------------------------------------------------

describe("SpecManager", () => {
  let tmpDir: string;
  let manager: SpecManager;

  const sampleSpec: SpecFile = {
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
      },
      {
        name: "User login",
        acceptanceCriteriaIndices: [1],
        keyFiles: ["src/auth.ts", "src/middleware/auth.ts"],
        dependsOn: ["User signup"],
      },
    ],
    status: "SPEC_WORK",
  };

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-coder-spec-test-"));
    manager = new SpecManager(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // --- createSpec ---

  describe("createSpec", () => {
    it("should write a spec file to the specs directory", async () => {
      const path = await manager.createSpec(sampleSpec);
      assert.strictEqual(path, join(tmpDir, "user-authentication", "spec.md"));
    });

    it("should create a file with YAML frontmatter", async () => {
      await manager.createSpec(sampleSpec);
      const content = await manager.readSpecRaw("user-authentication");
      assert.ok(content.startsWith("---\n"), "Should start with YAML frontmatter delimiter");
      assert.ok(content.includes("id: user-authentication"), "Should include id in frontmatter");
      assert.ok(content.includes("status: SPEC_WORK"), "Should include status in frontmatter");
      assert.ok(content.includes("created:"), "Should include created date in frontmatter");
    });

    it("should include structured body sections", async () => {
      await manager.createSpec(sampleSpec);
      const content = await manager.readSpecRaw("user-authentication");
      assert.ok(content.includes("# User Authentication"), "Should include title as heading");
      assert.ok(content.includes("## Acceptance Criteria"), "Should include Acceptance Criteria section");
      assert.ok(content.includes("## Constraints"), "Should include Constraints section");
      assert.ok(content.includes("## Key Files"), "Should include Key Files section");
      assert.ok(content.includes("## Pruned Context"), "Should include Pruned Context section");
    });
  });

  // --- readSpec ---

  describe("readSpec", () => {
    it("should return null for a missing spec", async () => {
      const spec = await manager.readSpec("nonexistent");
      assert.strictEqual(spec, null);
    });

    it("should parse a spec file back into SpecFile", async () => {
      await manager.createSpec(sampleSpec);
      const spec = await manager.readSpec("user-authentication");
      assert.ok(spec, "Should return a SpecFile");
      assert.strictEqual(spec!.id, "user-authentication");
      assert.strictEqual(spec!.title, "User Authentication");
      assert.deepStrictEqual(spec!.acceptanceCriteria, [
        "Users can sign up with email and password",
        "Users can log in with valid credentials",
      ]);
      assert.deepStrictEqual(spec!.constraints, ["Must use bcrypt for password hashing"]);
      assert.deepStrictEqual(spec!.keyFiles, ["src/auth.ts", "src/middleware/auth.ts"]);
      assert.strictEqual(spec!.prunedContext, "Research found Supabase handles auth via...");
      assert.strictEqual(spec!.status, "SPEC_WORK");
    });
  });

  // --- updateSpec ---

  describe("updateSpec", () => {
    it("should merge partial updates into existing spec", async () => {
      await manager.createSpec(sampleSpec);
      await manager.updateSpec("user-authentication", {
        status: "SPEC_APPROVED",
        constraints: ["Must use bcrypt for password hashing", "Rate limit login attempts"],
      });
      const spec = await manager.readSpec("user-authentication");
      assert.strictEqual(spec!.status, "SPEC_APPROVED");
      assert.deepStrictEqual(spec!.constraints, [
        "Must use bcrypt for password hashing",
        "Rate limit login attempts",
      ]);
      // Non-updated fields should be unchanged
      assert.strictEqual(spec!.title, "User Authentication");
      assert.deepStrictEqual(spec!.acceptanceCriteria, sampleSpec.acceptanceCriteria);
    });

    it("should throw when updating a nonexistent spec", async () => {
      await assert.rejects(
        () => manager.updateSpec("nonexistent", { status: "SPEC_APPROVED" }),
        { message: /not found/i }
      );
    });
  });

  // --- deleteSpec ---

  describe("deleteSpec", () => {
    it("should remove the spec file", async () => {
      await manager.createSpec(sampleSpec);
      await manager.deleteSpec("user-authentication");
      const spec = await manager.readSpec("user-authentication");
      assert.strictEqual(spec, null);
    });

    it("should not throw when deleting a nonexistent spec", async () => {
      // Should resolve without error
      await manager.deleteSpec("nonexistent");
    });
  });

  // --- listSpecs ---

  describe("listSpecs", () => {
    it("should return empty array for empty directory", async () => {
      const specs = await manager.listSpecs();
      assert.deepStrictEqual(specs, []);
    });

    it("should return spec IDs from filename stems", async () => {
      await manager.createSpec(sampleSpec);
      await manager.createSpec({ ...sampleSpec, id: "other-spec", title: "Other Spec" });
      const specs = await manager.listSpecs();
      specs.sort();
      assert.deepStrictEqual(specs, ["other-spec", "user-authentication"]);
    });

    it("should only list .md files", async () => {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(join(tmpDir, "not-a-spec.txt"), "ignore me");
      await manager.createSpec(sampleSpec);
      const specs = await manager.listSpecs();
      assert.deepStrictEqual(specs, ["user-authentication"]);
    });
  });
});

// ---------------------------------------------------------------------------
// Phase 3: Round-Trip Integrity
// ---------------------------------------------------------------------------

describe("Spec round-trip integrity", () => {
  let tmpDir: string;
  let manager: SpecManager;

  const fullSpec: SpecFile = {
    id: "api-error-handling",
    title: "API Error Handling",
    acceptanceCriteria: [
      "All API errors return structured JSON",
      "4xx errors include validation details",
      "5xx errors include correlation ID",
    ],
    constraints: [
      "Must follow existing error middleware pattern",
      "No stack traces in production responses",
    ],
    keyFiles: ["src/api/errors.ts", "src/middleware/error-handler.ts"],
    prunedContext: "Error handling follows a middleware pattern where errors are caught by a generic handler that formats the response. The handler is registered in app.ts.",
    implementationPlan: [],
    status: "SPEC_WORK",
  };

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-coder-roundtrip-"));
    manager = new SpecManager(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("create→read should produce identical SpecFile", async () => {
    await manager.createSpec(fullSpec);
    const read = await manager.readSpec("api-error-handling");
    assert.ok(read, "Should return a spec");
    assert.strictEqual(read!.id, fullSpec.id);
    assert.strictEqual(read!.title, fullSpec.title);
    assert.deepStrictEqual(read!.acceptanceCriteria, fullSpec.acceptanceCriteria);
    assert.deepStrictEqual(read!.constraints, fullSpec.constraints);
    assert.deepStrictEqual(read!.keyFiles, fullSpec.keyFiles);
    assert.strictEqual(read!.prunedContext, fullSpec.prunedContext);
    assert.strictEqual(read!.status, fullSpec.status);
  });

  it("create→read should preserve implementation plan", async () => {
    const specWithPlan: SpecFile = {
      ...fullSpec,
      implementationPlan: [
        {
          name: "Error response format",
          acceptanceCriteriaIndices: [0, 1],
          keyFiles: ["src/api/errors.ts"],
          dependsOn: [],
        },
        {
          name: "Correlation ID tracking",
          acceptanceCriteriaIndices: [2],
          keyFiles: ["src/middleware/error-handler.ts"],
          dependsOn: ["Error response format"],
        },
      ],
    };
    await manager.createSpec(specWithPlan);
    const read = await manager.readSpec("api-error-handling");
    assert.ok(read, "Should return a spec");
    assert.strictEqual(read!.implementationPlan.length, 2);
    assert.strictEqual(read!.implementationPlan[0].name, "Error response format");
    assert.deepStrictEqual(read!.implementationPlan[0].acceptanceCriteriaIndices, [0, 1]);
    assert.strictEqual(read!.implementationPlan[1].name, "Correlation ID tracking");
    assert.deepStrictEqual(read!.implementationPlan[1].dependsOn, ["Error response format"]);
  });

  it("update→read should show updated fields with others unchanged", async () => {
    await manager.createSpec(fullSpec);
    await manager.updateSpec("api-error-handling", {
      status: "TDD_RED_WRITE",
      acceptanceCriteria: [
        ...fullSpec.acceptanceCriteria,
        "Error logs include request path",
      ],
    });
    const read = await manager.readSpec("api-error-handling");
    assert.strictEqual(read!.status, "TDD_RED_WRITE");
    assert.deepStrictEqual(read!.acceptanceCriteria, [
      "All API errors return structured JSON",
      "4xx errors include validation details",
      "5xx errors include correlation ID",
      "Error logs include request path",
    ]);
    // Unchanged fields
    assert.strictEqual(read!.title, fullSpec.title);
    assert.deepStrictEqual(read!.constraints, fullSpec.constraints);
    assert.deepStrictEqual(read!.keyFiles, fullSpec.keyFiles);
    assert.strictEqual(read!.prunedContext, fullSpec.prunedContext);
  });

  it("delete→read should return null", async () => {
    await manager.createSpec(fullSpec);
    await manager.deleteSpec("api-error-handling");
    const read = await manager.readSpec("api-error-handling");
    assert.strictEqual(read, null);
  });

  it("create→delete→list should not include deleted spec", async () => {
    await manager.createSpec(fullSpec);
    await manager.createSpec({ ...fullSpec, id: "other-spec", title: "Other" });
    await manager.deleteSpec("api-error-handling");
    const list = await manager.listSpecs();
    assert.deepStrictEqual(list, ["other-spec"]);
  });
});

// ---------------------------------------------------------------------------
// Phase 4: Spec approach field serialization/parsing
// ---------------------------------------------------------------------------

describe("Spec approach field serialization", () => {
  let tmpDir: string;
  let manager: SpecManager;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-coder-approach-test-"));
    manager = new SpecManager(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("serializes approach: direct in markdown", async () => {
    const spec: SpecFile = {
      id: "approach-test",
      title: "Approach Test",
      acceptanceCriteria: ["Config updated", "Feature works"],
      constraints: [],
      keyFiles: ["config.json", "src/feature.ts"],
      prunedContext: "Test context",
      implementationPlan: [
        { name: "Config update", acceptanceCriteriaIndices: [0], keyFiles: ["config.json"], dependsOn: [], approach: "direct" },
        { name: "Feature", acceptanceCriteriaIndices: [1], keyFiles: ["src/feature.ts"], dependsOn: ["Config update"] },
      ],
      status: "SPEC_WORK",
    };
    await manager.createSpec(spec);
    const raw = await manager.readSpecRaw("approach-test");
    // Direct approach should be serialized
    assert.ok(raw.includes("(approach: direct)"), `Should include '(approach: direct)' in markdown, got: ${raw}`);
    // TDD approach (undefined) should NOT be serialized
    // The Feature unit has no approach, so there should be no '(approach: tdd)'
    assert.ok(!raw.includes("(approach: tdd)"), `Should NOT include '(approach: tdd)', got: ${raw}`);
  });

  it("parses approach: direct from markdown", async () => {
    const spec: SpecFile = {
      id: "approach-test",
      title: "Approach Test",
      acceptanceCriteria: ["Config updated", "Feature works"],
      constraints: [],
      keyFiles: ["config.json", "src/feature.ts"],
      prunedContext: "Test context",
      implementationPlan: [
        { name: "Config update", acceptanceCriteriaIndices: [0], keyFiles: ["config.json"], dependsOn: [], approach: "direct" },
        { name: "Feature", acceptanceCriteriaIndices: [1], keyFiles: ["src/feature.ts"], dependsOn: ["Config update"] },
      ],
      status: "SPEC_WORK",
    };
    await manager.createSpec(spec);
    const read = await manager.readSpec("approach-test");
    assert.ok(read, "Should return a spec");
    assert.strictEqual(read!.implementationPlan[0].approach, "direct");
    assert.strictEqual(read!.implementationPlan[1].approach, undefined);
  });

  it("round-trips approach: direct through serialize/parse", async () => {
    const spec: SpecFile = {
      id: "approach-test",
      title: "Approach Test",
      acceptanceCriteria: ["Config updated"],
      constraints: [],
      keyFiles: ["config.json"],
      prunedContext: "Test context",
      implementationPlan: [
        { name: "Config update", acceptanceCriteriaIndices: [0], keyFiles: ["config.json"], dependsOn: [], approach: "direct" },
      ],
      status: "SPEC_WORK",
    };
    await manager.createSpec(spec);
    const read = await manager.readSpec("approach-test");
    assert.deepStrictEqual(read!.implementationPlan, spec.implementationPlan);
  });

  it("round-trips undefined approach (default tdd) through serialize/parse", async () => {
    const spec: SpecFile = {
      id: "approach-test",
      title: "Approach Test",
      acceptanceCriteria: ["Feature works"],
      constraints: [],
      keyFiles: ["src/feature.ts"],
      prunedContext: "Test context",
      implementationPlan: [
        { name: "Feature", acceptanceCriteriaIndices: [0], keyFiles: ["src/feature.ts"], dependsOn: [] },
      ],
      status: "SPEC_WORK",
    };
    await manager.createSpec(spec);
    const read = await manager.readSpec("approach-test");
    assert.strictEqual(read!.implementationPlan[0].approach, undefined);
  });

  it("handles approach: direct with depends on", async () => {
    const spec: SpecFile = {
      id: "approach-test",
      title: "Approach Test",
      acceptanceCriteria: ["Config updated", "Feature works"],
      constraints: [],
      keyFiles: ["config.json", "src/feature.ts"],
      prunedContext: "Test context",
      implementationPlan: [
        { name: "Config update", acceptanceCriteriaIndices: [0], keyFiles: ["config.json"], dependsOn: [], approach: "direct" },
        { name: "Feature", acceptanceCriteriaIndices: [1], keyFiles: ["src/feature.ts"], dependsOn: ["Config update"], approach: "direct" },
      ],
      status: "SPEC_WORK",
    };
    await manager.createSpec(spec);
    const read = await manager.readSpec("approach-test");
    assert.strictEqual(read!.implementationPlan[0].approach, "direct");
    assert.strictEqual(read!.implementationPlan[1].approach, "direct");
    assert.deepStrictEqual(read!.implementationPlan[1].dependsOn, ["Config update"]);
  });

  it("backward compat: parses old format without approach field", async () => {
    const spec: SpecFile = {
      id: "old-format",
      title: "Old Format",
      acceptanceCriteria: ["Feature works"],
      constraints: [],
      keyFiles: ["src/feature.ts"],
      prunedContext: "Test context",
      implementationPlan: [
        { name: "Feature", acceptanceCriteriaIndices: [0], keyFiles: ["src/feature.ts"], dependsOn: ["Other Unit"] },
      ],
      status: "SPEC_WORK",
    };
    await manager.createSpec(spec);
    const read = await manager.readSpec("old-format");
    assert.strictEqual(read!.implementationPlan[0].approach, undefined, "Old format should have undefined approach (defaults to tdd)");
    assert.deepStrictEqual(read!.implementationPlan[0].dependsOn, ["Other Unit"]);
  });

  it("parses case-insensitive APPROACH: DIRECT from markdown", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-coder-spec-test-"));
    const manager = new SpecManager(dir);
    // Manually write a spec with uppercase approach
    const specDir = join(dir, "case-test");
    mkdirSync(specDir, { recursive: true });
    writeFileSync(join(specDir, "spec.md"), `---\nid: case-test\ntitle: Case Test\nstatus: SPEC_WORK\n---\n\n# Case Test\n\n## Acceptance Criteria\n\n1. Config updated\n\n## Implementation Plan\n\n- **Config update** [1] (APPROACH: DIRECT)\n`);
    const read = await manager.readSpec("case-test");
    assert.strictEqual(read!.implementationPlan[0].approach, "direct", "Should parse uppercase APPROACH: DIRECT as direct");
  });


  // --- testSuite field ---

  it("serializes suite: component in markdown", async () => {
    const spec: SpecFile = {
      id: "suite-test",
      title: "Suite Test",
      acceptanceCriteria: ["AC1"],
      constraints: [],
      keyFiles: [],
      prunedContext: "context",
      implementationPlan: [
        { name: "UI Button", acceptanceCriteriaIndices: [0], keyFiles: ["button.tsx"], dependsOn: [], testSuite: "component" },
        { name: "Helper", acceptanceCriteriaIndices: [0], keyFiles: ["helper.ts"], dependsOn: [] },
      ],
      status: "SPEC_WORK",
    };
    await manager.createSpec(spec);
    const raw = await manager.readSpecRaw("suite-test");
    assert.ok(raw.includes("(suite: component)"), `Should include '(suite: component)' in markdown, got: ${raw}`);
    assert.ok(!raw.includes("(suite:)"), `Should NOT include empty suite, got: ${raw}`);
  });

  it("parses suite: component from markdown", async () => {
    const spec: SpecFile = {
      id: "suite-test",
      title: "Suite Test",
      acceptanceCriteria: ["AC1"],
      constraints: [],
      keyFiles: [],
      prunedContext: "context",
      implementationPlan: [
        { name: "UI Button", acceptanceCriteriaIndices: [0], keyFiles: ["button.tsx"], dependsOn: [], testSuite: "component" },
      ],
      status: "SPEC_WORK",
    };
    await manager.createSpec(spec);
    const read = await manager.readSpec("suite-test");
    assert.strictEqual(read!.implementationPlan[0].testSuite, "component");
    assert.strictEqual(read!.implementationPlan[0].name, "UI Button");
  });

  it("round-trips suite field through serialize/parse", async () => {
    const spec: SpecFile = {
      id: "suite-test",
      title: "Suite Test",
      acceptanceCriteria: ["AC1"],
      constraints: [],
      keyFiles: [],
      prunedContext: "context",
      implementationPlan: [
        { name: "UI Button", acceptanceCriteriaIndices: [0], keyFiles: ["button.tsx"], dependsOn: [], testSuite: "component" },
      ],
      status: "SPEC_WORK",
    };
    await manager.createSpec(spec);
    const read = await manager.readSpec("suite-test");
    assert.strictEqual(read!.implementationPlan[0].testSuite, "component");
  });

  it("parses suite case-insensitively", async () => {
    mkdirSync(join(tmpDir, "suite-case"), { recursive: true });
    writeFileSync(join(tmpDir, "suite-case", "spec.md"), `---
id: suite-case
title: Case Test
status: SPEC_WORK
---

## Acceptance Criteria
1. The component renders

## Constraints
None

## Key Files
- \`button.tsx\`

## Implementation Plan
- **UI Button** [AC1] (Suite: Component)
  - \`button.tsx\`

## Pruned Context
context
`);

    const read = await manager.readSpec("suite-case");
    assert.strictEqual(read!.implementationPlan[0].testSuite, "component", "Should parse 'Component' as 'component'");
  });

  it("combines approach and suite in same unit", async () => {
    const spec: SpecFile = {
      id: "combo-test",
      title: "Combo Test",
      acceptanceCriteria: ["AC1"],
      constraints: [],
      keyFiles: [],
      prunedContext: "context",
      implementationPlan: [
        { name: "UI Button", acceptanceCriteriaIndices: [0], keyFiles: ["button.tsx"], dependsOn: [], approach: "direct", testSuite: "component" },
      ],
      status: "SPEC_WORK",
    };
    await manager.createSpec(spec);
    const read = await manager.readSpec("combo-test");
    assert.strictEqual(read!.implementationPlan[0].approach, "direct");
    assert.strictEqual(read!.implementationPlan[0].testSuite, "component");

    const raw = await manager.readSpecRaw("combo-test");
    assert.ok(raw.includes("(approach: direct)"), `Should include approach, got: ${raw}`);
    assert.ok(raw.includes("(suite: component)"), `Should include suite, got: ${raw}`);
  });
});

// ---------------------------------------------------------------------------
// Spec 16 Phase 5: Close Spec (CANCELLED status + state.json deletion)
// ---------------------------------------------------------------------------

describe("Spec 16 Phase 5: Close Spec", () => {
  let tmpDir: string;
  let manager: SpecManager;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-coder-spec16-"));
    manager = new SpecManager(join(tmpDir, "specs"));
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it("updateSpec sets status to CANCELLED", async () => {
    const spec: SpecFile = {
      id: "close-test",
      title: "Close Test",
      acceptanceCriteria: ["AC1"],
      constraints: [],
      keyFiles: [],
      prunedContext: "context",
      implementationPlan: [],
      status: "SPEC_WORK",
    };
    await manager.createSpec(spec);
    await manager.updateSpec("close-test", { status: "CANCELLED" });
    const updated = await manager.readSpec("close-test");
    assert.strictEqual(updated!.status, "CANCELLED");
  });

  it("CANCELLED specs are excluded from open-spec list", async () => {
    const spec1: SpecFile = {
      id: "open-spec",
      title: "Open Spec",
      acceptanceCriteria: ["AC1"],
      constraints: [],
      keyFiles: [],
      prunedContext: "context",
      implementationPlan: [],
      status: "SPEC_WORK",
    };
    const spec2: SpecFile = {
      id: "cancelled-spec",
      title: "Cancelled Spec",
      acceptanceCriteria: ["AC1"],
      constraints: [],
      keyFiles: [],
      prunedContext: "context",
      implementationPlan: [],
      status: "CANCELLED",
    };
    const spec3: SpecFile = {
      id: "complete-spec",
      title: "Complete Spec",
      acceptanceCriteria: ["AC1"],
      constraints: [],
      keyFiles: [],
      prunedContext: "context",
      implementationPlan: [],
      status: "COMPLETE",
    };
    await manager.createSpec(spec1);
    await manager.createSpec(spec2);
    await manager.createSpec(spec3);

    const allIds = await manager.listSpecs();
    const openSpecs: string[] = [];
    for (const id of allIds) {
      const s = await manager.readSpec(id);
      if (s && s.status !== "COMPLETE" && s.status !== "CANCELLED") {
        openSpecs.push(id);
      }
    }

    assert.deepEqual(openSpecs, ["open-spec"], "Only non-COMPLETE/CANCELLED specs should be listed");
  });

  it("spec.md is preserved after CANCELLED status update", async () => {
    const spec: SpecFile = {
      id: "preserve-test",
      title: "Preserve Test",
      acceptanceCriteria: ["AC1", "AC2"],
      constraints: ["No external deps"],
      keyFiles: ["src/app.ts"],
      prunedContext: "context",
      implementationPlan: [],
      status: "TDD_RED_WRITE",
    };
    await manager.createSpec(spec);
    await manager.updateSpec("preserve-test", { status: "CANCELLED" });

    // spec.md should still exist and be readable
    const read = await manager.readSpec("preserve-test");
    assert.ok(read, "spec.md must still be readable after CANCELLED");
    assert.strictEqual(read!.status, "CANCELLED");
    assert.strictEqual(read!.title, "Preserve Test");
    assert.deepEqual(read!.acceptanceCriteria, ["AC1", "AC2"]);
  });

  it("SpecStatePersistence.delete removes state.json but not spec directory", async () => {
    const { SpecStatePersistence } = await import("./state-persistence.ts");

    const spec: SpecFile = {
      id: "delete-state-test",
      title: "Delete State Test",
      acceptanceCriteria: ["AC1"],
      constraints: [],
      keyFiles: [],
      prunedContext: "context",
      implementationPlan: [],
      status: "TDD_RED_WRITE",
    };
    await manager.createSpec(spec);

    // Save some state
    await SpecStatePersistence.save(manager.specsDir, "delete-state-test", {
      version: 1,
      currentState: "TDD_RED_WRITE",
      currentUnitName: null,
      loopCount: 0,
      gitRef: null,
      evidence: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Verify state.json exists
    const stateBeforeDelete = await SpecStatePersistence.load(manager.specsDir, "delete-state-test");
    assert.ok(stateBeforeDelete, "state.json should exist before delete");

    // Delete state.json
    await SpecStatePersistence.delete(manager.specsDir, "delete-state-test");

    // Verify state.json is gone
    const stateAfterDelete = await SpecStatePersistence.load(manager.specsDir, "delete-state-test");
    assert.strictEqual(stateAfterDelete, null, "state.json should be deleted");

    // Verify spec directory and spec.md still exist
    const specAfterDelete = await manager.readSpec("delete-state-test");
    assert.ok(specAfterDelete, "spec.md should still exist after state.json deletion");
  });

  it("SpecStatePersistence.delete is a no-op when state.json is missing", async () => {
    const { SpecStatePersistence } = await import("./state-persistence.ts");

    const spec: SpecFile = {
      id: "no-state-test",
      title: "No State Test",
      acceptanceCriteria: ["AC1"],
      constraints: [],
      keyFiles: [],
      prunedContext: "context",
      implementationPlan: [],
      status: "SPEC_WORK",
    };
    await manager.createSpec(spec);

    // Should not throw even though state.json doesn't exist
    await assert.doesNotThrow(
      async () => await SpecStatePersistence.delete(manager.specsDir, "no-state-test"),
      "delete should be a no-op when state.json is missing",
    );
  });
});