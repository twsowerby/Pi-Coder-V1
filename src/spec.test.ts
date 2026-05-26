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
import { mkdtempSync, rmSync } from "node:fs";
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
