/**
 * Tests for State Persistence — Spec 15.
 *
 * Covers: save/load roundtrip, corrupt/missing files, integrity checks,
 * atomic writes, terminal states, validation edge cases.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  StatePersistence,
  type PersistedState,
  type PersistedFSM,
} from "./state-persistence.ts";
import type { FSMState } from "./types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeState(overrides?: Partial<PersistedState>): PersistedState {
  return {
    version: 1,
    piCoderActive: true,
    fsm: {
      currentState: "SPEC_WORK",
      activeSpecId: "user-auth",
      loopCount: 0,
      gitRef: null,
      ...overrides?.fsm,
    },
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pi-coder-state-test-"));
}

/** Create a StatePersistence pointing at a temp dir + optional spec files. */
async function setup(
  specFiles?: Record<string, string>,
): Promise<{ persistence: StatePersistence; dir: string; cleanup: () => Promise<void> }> {
  const dir = await makeTempDir();
  const specsDir = join(dir, "specs");
  if (specFiles) {
    await mkdir(specsDir, { recursive: true });
    for (const [name, content] of Object.entries(specFiles)) {
      await writeFile(join(specsDir, name), content, "utf-8");
    }
  }
  const persistence = new StatePersistence(dir);
  const cleanup = () => rm(dir, { recursive: true, force: true });
  return { persistence, dir, cleanup };
}

// ---------------------------------------------------------------------------
// Save & Load
// ---------------------------------------------------------------------------

describe("StatePersistence — Save & Load", () => {
  it("saves and loads a roundtrip", async () => {
    const { persistence, cleanup } = await setup();
    try {
      const state = makeState();
      await persistence.save(state);
      const loaded = await persistence.load();
      assert.deepStrictEqual(loaded, state);
    } finally {
      await cleanup();
    }
  });

  it("returns null when no state file exists", async () => {
    const { persistence, cleanup } = await setup();
    try {
      const loaded = await persistence.load();
      assert.strictEqual(loaded, null);
    } finally {
      await cleanup();
    }
  });

  it("overwrites previous state on save", async () => {
    const { persistence, cleanup } = await setup();
    try {
      await persistence.save(makeState({ fsm: { currentState: "SPEC_WORK", activeSpecId: "first", loopCount: 0, gitRef: null } }));
      await persistence.save(makeState({ fsm: { currentState: "TDD_GREEN_WRITE", activeSpecId: "second", loopCount: 2, gitRef: "abc1234" } }));
      const loaded = await persistence.load();
      assert.strictEqual(loaded!.fsm.currentState, "TDD_GREEN_WRITE");
      assert.strictEqual(loaded!.fsm.activeSpecId, "second");
      assert.strictEqual(loaded!.fsm.loopCount, 2);
    } finally {
      await cleanup();
    }
  });

  it("persists piCoderActive toggle state", async () => {
    const { persistence, cleanup } = await setup();
    try {
      await persistence.save(makeState({ piCoderActive: false }));
      const loaded = await persistence.load();
      assert.strictEqual(loaded!.piCoderActive, false);
    } finally {
      await cleanup();
    }
  });

  it("persists all FSM fields", async () => {
    const { persistence, cleanup } = await setup();
    try {
      const fsm: PersistedFSM = {
        currentState: "TDD_RED_VALIDATE",
        activeSpecId: "my-spec",
        loopCount: 3,
        gitRef: "deadbeef",
      };
      await persistence.save(makeState({ fsm }));
      const loaded = await persistence.load();
      assert.deepStrictEqual(loaded!.fsm, fsm);
    } finally {
      await cleanup();
    }
  });

  it("persists updatedAt timestamp", async () => {
    const { persistence, cleanup } = await setup();
    try {
      const ts = "2026-05-25T14:30:00.000Z";
      await persistence.save(makeState({ updatedAt: ts }));
      const loaded = await persistence.load();
      assert.strictEqual(loaded!.updatedAt, ts);
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Corrupt & Invalid Files
// ---------------------------------------------------------------------------

describe("StatePersistence — Corrupt & Invalid Files", () => {
  it("returns null for corrupt JSON", async () => {
    const { persistence, dir, cleanup } = await setup();
    try {
      await writeFile(persistence.statePath, "{{not json", "utf-8");
      const loaded = await persistence.load();
      assert.strictEqual(loaded, null);
    } finally {
      await cleanup();
    }
  });

  it("returns null for wrong version", async () => {
    const { persistence, cleanup } = await setup();
    try {
      const bad = { ...makeState(), version: 2 };
      await writeFile(persistence.statePath, JSON.stringify(bad), "utf-8");
      const loaded = await persistence.load();
      assert.strictEqual(loaded, null);
    } finally {
      await cleanup();
    }
  });

  it("returns null for missing version", async () => {
    const { persistence, cleanup } = await setup();
    try {
      const obj = makeState();
      const { version: _, ...noVersion } = obj;
      await writeFile(persistence.statePath, JSON.stringify(noVersion), "utf-8");
      const loaded = await persistence.load();
      assert.strictEqual(loaded, null);
    } finally {
      await cleanup();
    }
  });

  it("returns null for invalid currentState", async () => {
    const { persistence, cleanup } = await setup();
    try {
      const bad = makeState({ fsm: { currentState: "INVALID_STATE" as FSMState, activeSpecId: null, loopCount: 0, gitRef: null } });
      await writeFile(persistence.statePath, JSON.stringify(bad), "utf-8");
      const loaded = await persistence.load();
      assert.strictEqual(loaded, null);
    } finally {
      await cleanup();
    }
  });

  it("returns null for non-boolean piCoderActive", async () => {
    const { persistence, cleanup } = await setup();
    try {
      const bad = { ...makeState(), piCoderActive: "yes" };
      await writeFile(persistence.statePath, JSON.stringify(bad), "utf-8");
      const loaded = await persistence.load();
      assert.strictEqual(loaded, null);
    } finally {
      await cleanup();
    }
  });

  it("returns null for non-object fsm", async () => {
    const { persistence, cleanup } = await setup();
    try {
      const bad = { ...makeState(), fsm: "not an object" };
      await writeFile(persistence.statePath, JSON.stringify(bad), "utf-8");
      const loaded = await persistence.load();
      assert.strictEqual(loaded, null);
    } finally {
      await cleanup();
    }
  });

  it("returns null for empty file", async () => {
    const { persistence, cleanup } = await setup();
    try {
      await writeFile(persistence.statePath, "", "utf-8");
      const loaded = await persistence.load();
      assert.strictEqual(loaded, null);
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

describe("StatePersistence — Delete", () => {
  it("deletes an existing state file", async () => {
    const { persistence, cleanup } = await setup();
    try {
      await persistence.save(makeState());
      await persistence.delete();
      const loaded = await persistence.load();
      assert.strictEqual(loaded, null);
    } finally {
      await cleanup();
    }
  });

  it("is a no-op when no state file exists", async () => {
    const { persistence, cleanup } = await setup();
    try {
      await persistence.delete(); // Should not throw
      const loaded = await persistence.load();
      assert.strictEqual(loaded, null);
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Atomic Write
// ---------------------------------------------------------------------------

describe("StatePersistence — Atomic Write", () => {
  it("does not leave a temp file after successful save", async () => {
    const { persistence, dir, cleanup } = await setup();
    try {
      await persistence.save(makeState());
      // temp file should not exist
      const tempPath = join(dir, "state.json.tmp");
      let tempExists = true;
      try { await readFile(tempPath, "utf-8"); } catch { tempExists = false; }
      assert.strictEqual(tempExists, false, "Temp file should be cleaned up after rename");
    } finally {
      await cleanup();
    }
  });

  it("cleans up leftover temp file from a previous crash", async () => {
    const { persistence, dir, cleanup } = await setup();
    try {
      // Simulate a leftover temp file
      const tempPath = join(dir, "state.json.tmp");
      await mkdir(dir, { recursive: true });
      await writeFile(tempPath, "stale", "utf-8");
      // Save should succeed despite the leftover
      await persistence.save(makeState());
      const loaded = await persistence.load();
      assert.strictEqual(loaded!.fsm.currentState, "SPEC_WORK");
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Integrity Checks
// ---------------------------------------------------------------------------

describe("StatePersistence — Integrity Checks", () => {
  it("passes when spec file exists and specId is set", async () => {
    const { persistence, cleanup } = await setup({
      "user-auth.md": "# User Auth",
    });
    try {
      const state = makeState({ fsm: { currentState: "SPEC_WORK", activeSpecId: "user-auth", loopCount: 0, gitRef: null } });
      const result = await persistence.checkIntegrity(state);
      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.errors.length, 0);
    } finally {
      await cleanup();
    }
  });

  it("passes when specId is null (no spec expected)", async () => {
    const { persistence, cleanup } = await setup();
    try {
      const state = makeState({ fsm: { currentState: "SPEC_WORK", activeSpecId: null, loopCount: 0, gitRef: null } });
      const result = await persistence.checkIntegrity(state);
      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.errors.length, 0);
    } finally {
      await cleanup();
    }
  });

  it("errors when spec file is missing but specId is set", async () => {
    const { persistence, cleanup } = await setup(); // no spec files
    try {
      const state = makeState({ fsm: { currentState: "TDD_RED_WRITE", activeSpecId: "missing-spec", loopCount: 0, gitRef: null } });
      const result = await persistence.checkIntegrity(state);
      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.length > 0);
      assert.ok(result.errors[0].includes("missing-spec"));
    } finally {
      await cleanup();
    }
  });

  it("warns when state is IDLE (terminal)", async () => {
    const { persistence, cleanup } = await setup();
    try {
      const state = makeState({ fsm: { currentState: "IDLE", activeSpecId: null, loopCount: 0, gitRef: null } });
      const result = await persistence.checkIntegrity(state);
      assert.strictEqual(result.valid, true);
      assert.ok(result.warnings.some((w) => w.includes("IDLE")));
    } finally {
      await cleanup();
    }
  });

  it("warns when state is COMPLETE (terminal)", async () => {
    const { persistence, cleanup } = await setup({
      "done-spec.md": "# Done",
    });
    try {
      const state = makeState({ fsm: { currentState: "COMPLETE", activeSpecId: "done-spec", loopCount: 0, gitRef: "abc" } });
      const result = await persistence.checkIntegrity(state);
      assert.strictEqual(result.valid, true);
      assert.ok(result.warnings.some((w) => w.includes("COMPLETE")));
    } finally {
      await cleanup();
    }
  });

  it("returns both errors and warnings together", async () => {
    const { persistence, cleanup } = await setup(); // no specs dir
    try {
      const state = makeState({ fsm: { currentState: "IDLE", activeSpecId: "gone", loopCount: 0, gitRef: null } });
      const result = await persistence.checkIntegrity(state);
      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.length > 0, "Should have spec-missing error");
      assert.ok(result.warnings.length > 0, "Should have terminal-state warning");
    } finally {
      await cleanup();
    }
  });

  it("no warnings for mid-cycle states", async () => {
    const { persistence, cleanup } = await setup({
      "auth.md": "# Auth",
    });
    try {
      const state = makeState({ fsm: { currentState: "TDD_GREEN_VALIDATE", activeSpecId: "auth", loopCount: 1, gitRef: "abc" } });
      const result = await persistence.checkIntegrity(state);
      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.warnings.length, 0);
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Edge Cases
// ---------------------------------------------------------------------------

describe("StatePersistence — Edge Cases", () => {
  it("handles null activeSpecId and null gitRef", async () => {
    const { persistence, cleanup } = await setup();
    try {
      const fsm: PersistedFSM = { currentState: "SPEC_WORK", activeSpecId: null, loopCount: 0, gitRef: null };
      await persistence.save(makeState({ fsm }));
      const loaded = await persistence.load();
      assert.strictEqual(loaded!.fsm.activeSpecId, null);
      assert.strictEqual(loaded!.fsm.gitRef, null);
    } finally {
      await cleanup();
    }
  });

  it("handles BLOCKED state", async () => {
    const { persistence, cleanup } = await setup({
      "stuck.md": "# Stuck",
    });
    try {
      const fsm: PersistedFSM = { currentState: "BLOCKED", activeSpecId: "stuck", loopCount: 2, gitRef: "abc" };
      await persistence.save(makeState({ fsm }));
      const loaded = await persistence.load();
      assert.strictEqual(loaded!.fsm.currentState, "BLOCKED");
      assert.strictEqual(loaded!.fsm.loopCount, 2);
    } finally {
      await cleanup();
    }
  });

  it("handles NEEDS_CHANGES state with loopCount > 0", async () => {
    const { persistence, cleanup } = await setup({
      "looped.md": "# Looped",
    });
    try {
      const fsm: PersistedFSM = { currentState: "NEEDS_CHANGES", activeSpecId: "looped", loopCount: 5, gitRef: "abc" };
      await persistence.save(makeState({ fsm }));
      const loaded = await persistence.load();
      assert.strictEqual(loaded!.fsm.currentState, "NEEDS_CHANGES");
      assert.strictEqual(loaded!.fsm.loopCount, 5);
    } finally {
      await cleanup();
    }
  });

  it("validates updatedAt is a string", async () => {
    const { persistence, cleanup } = await setup();
    try {
      const bad = { ...makeState(), updatedAt: 12345 };
      await writeFile(persistence.statePath, JSON.stringify(bad), "utf-8");
      const loaded = await persistence.load();
      assert.strictEqual(loaded, null);
    } finally {
      await cleanup();
    }
  });

  it("validates loopCount is a number", async () => {
    const { persistence, cleanup } = await setup();
    try {
      const bad = makeState({ fsm: { currentState: "SPEC_WORK", activeSpecId: null, loopCount: "three" as unknown as number, gitRef: null } });
      await writeFile(persistence.statePath, JSON.stringify(bad), "utf-8");
      const loaded = await persistence.load();
      assert.strictEqual(loaded, null);
    } finally {
      await cleanup();
    }
  });

  it("statePath returns correct path", async () => {
    const { persistence, cleanup } = await setup();
    try {
      assert.ok(persistence.statePath.endsWith("state.json"));
    } finally {
      await cleanup();
    }
  });
});
