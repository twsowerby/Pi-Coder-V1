/**
 * Tests for State Persistence — two-layer model.
 *
 * GlobalStatePersistence: .pi-coder/state.json (pointer: piCoderActive, activeSpecId)
 * SpecStatePersistence: .pi-coder/specs/{id}/state.json (FSM + evidence)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  GlobalStatePersistence,
  SpecStatePersistence,
} from "./state-persistence.ts";
import type { GlobalState, SpecState, FSMState } from "./types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeGlobalState(overrides?: Partial<GlobalState>): GlobalState {
  return {
    version: 1,
    piCoderActive: true,
    activeSpecId: null,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeSpecState(overrides?: Partial<SpecState>): SpecState {
  return {
    version: 1,
    currentState: "SPEC_WORK" as FSMState,
    loopCount: 0,
    gitRef: null,
    evidence: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pi-coder-state-test-"));
}

// ---------------------------------------------------------------------------
// GlobalStatePersistence
// ---------------------------------------------------------------------------

describe("GlobalStatePersistence", () => {
  describe("save + load roundtrip", () => {
    it("saves and loads global state", async () => {
      const dir = await makeTempDir();
      try {
        const persistence = new GlobalStatePersistence(dir);
        const state = makeGlobalState({ activeSpecId: "user-auth" });
        await persistence.save(state);
        const loaded = await persistence.load();
        assert.ok(loaded, "Should load saved state");
        assert.strictEqual(loaded.piCoderActive, true);
        assert.strictEqual(loaded.activeSpecId, "user-auth");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("returns null when no state file exists", async () => {
      const dir = await makeTempDir();
      try {
        const persistence = new GlobalStatePersistence(dir);
        const loaded = await persistence.load();
        assert.strictEqual(loaded, null);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe("delete", () => {
    it("removes the state file", async () => {
      const dir = await makeTempDir();
      try {
        const persistence = new GlobalStatePersistence(dir);
        await persistence.save(makeGlobalState());
        await persistence.delete();
        const loaded = await persistence.load();
        assert.strictEqual(loaded, null);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("is a no-op when no file exists", async () => {
      const dir = await makeTempDir();
      try {
        const persistence = new GlobalStatePersistence(dir);
        await persistence.delete(); // Should not throw
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe("integrity checks", () => {
    it("reports valid when spec directory exists", async () => {
      const dir = await makeTempDir();
      try {
        const persistence = new GlobalStatePersistence(dir);
        // Create spec directory
        const specDir = join(dir, "specs", "user-auth");
        await mkdir(specDir, { recursive: true });
        await writeFile(join(specDir, "spec.md"), "# Test", "utf-8");

        const state = makeGlobalState({ activeSpecId: "user-auth" });
        const result = await persistence.checkIntegrity(state);
        assert.ok(result.valid, "Should be valid");
        assert.strictEqual(result.errors.length, 0);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("reports error when spec directory is missing", async () => {
      const dir = await makeTempDir();
      try {
        const persistence = new GlobalStatePersistence(dir);
        const state = makeGlobalState({ activeSpecId: "nonexistent-spec" });
        const result = await persistence.checkIntegrity(state);
        assert.ok(!result.valid, "Should be invalid");
        assert.ok(result.errors.length > 0);
        assert.ok(result.errors[0].includes("nonexistent-spec"));
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe("validation edge cases", () => {
    it("returns null for wrong version", async () => {
      const dir = await makeTempDir();
      try {
        const persistence = new GlobalStatePersistence(dir);
        await writeFile(
          join(dir, "state.json"),
          JSON.stringify({ version: 2, piCoderActive: true, activeSpecId: null, updatedAt: new Date().toISOString() }),
          "utf-8",
        );
        const loaded = await persistence.load();
        assert.strictEqual(loaded, null);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("returns null for corrupt JSON", async () => {
      const dir = await makeTempDir();
      try {
        const persistence = new GlobalStatePersistence(dir);
        await writeFile(join(dir, "state.json"), "{corrupt", "utf-8");
        const loaded = await persistence.load();
        assert.strictEqual(loaded, null);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});

// ---------------------------------------------------------------------------
// SpecStatePersistence
// ---------------------------------------------------------------------------

describe("SpecStatePersistence", () => {
  describe("save + load roundtrip", () => {
    it("saves and loads per-spec state", async () => {
      const dir = await makeTempDir();
      try {
        const specsDir = join(dir, "specs");
        const state = makeSpecState({
          currentState: "TDD_RED_WRITE" as FSMState,
          loopCount: 1,
          gitRef: "abc1234",
          evidence: ["spec_saved", "spec_user_approved"],
        });
        await SpecStatePersistence.save(specsDir, "user-auth", state);
        const loaded = await SpecStatePersistence.load(specsDir, "user-auth");
        assert.ok(loaded, "Should load saved state");
        assert.strictEqual(loaded.currentState, "TDD_RED_WRITE");
        assert.strictEqual(loaded.loopCount, 1);
        assert.strictEqual(loaded.gitRef, "abc1234");
        assert.deepStrictEqual(loaded.evidence, ["spec_saved", "spec_user_approved"]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("returns null when no state file exists", async () => {
      const dir = await makeTempDir();
      try {
        const loaded = await SpecStatePersistence.load(join(dir, "specs"), "nonexistent");
        assert.strictEqual(loaded, null);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe("delete", () => {
    it("removes the spec state file", async () => {
      const dir = await makeTempDir();
      try {
        const specsDir = join(dir, "specs");
        await SpecStatePersistence.save(specsDir, "user-auth", makeSpecState());
        await SpecStatePersistence.delete(specsDir, "user-auth");
        const loaded = await SpecStatePersistence.load(specsDir, "user-auth");
        assert.strictEqual(loaded, null);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("is a no-op when no file exists", async () => {
      const dir = await makeTempDir();
      try {
        await SpecStatePersistence.delete(join(dir, "specs"), "nonexistent"); // Should not throw
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
