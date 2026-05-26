/**
 * State Persistence for Pi Coder v1.
 *
 * Two persistence layers:
 *
 * 1. Global state (`.pi-coder/state.json`) — slim pointer:
 *    { version, piCoderMode, activeSpecId, updatedAt }
 *    Tells the extension which spec is active and whether orchestrator mode is on.
 *
 * 2. Per-spec state (`.pi-coder/specs/{id}/state.json`) — FSM + evidence:
 *    { version, currentState, loopCount, gitRef, evidence, createdAt, updatedAt }
 *    Lives alongside spec.md in the spec directory. The authoritative source
 *    for the FSM state during an active spec lifecycle.
 *
 * All writes are atomic (write to tmp, then rename) so a crash mid-write
 * leaves the previous state intact.
 */

import { join } from "node:path";
import {
  readFile,
  writeFile,
  unlink,
  rename,
  mkdir,
} from "node:fs/promises";
import type { FSMState, GlobalState, SpecState } from "./types.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATE_FILENAME = "state.json";
const TEMP_FILENAME = "state.json.tmp";

const VALID_STATES: Set<string> = new Set<FSMState>([
  "IDLE", "SPEC_WORK", "SPEC_APPROVED",
  "GIT_CHECKPOINT", "TDD_RED_WRITE", "TDD_RED_VALIDATE",
  "TDD_GREEN_WRITE", "TDD_GREEN_VALIDATE", "REVIEWING",
  "APPROVED", "NEEDS_CHANGES", "FINAL_APPROVAL", "MERGING",
  "COMPLETE", "BLOCKED",
]);

// ---------------------------------------------------------------------------
// GlobalStatePersistence
// ---------------------------------------------------------------------------

export interface IntegrityCheckResult {
  /** True if no errors (warnings are advisory) */
  valid: boolean;
  /** Advisory notes (e.g. terminal state, stale) */
  warnings: string[];
  /** Blocking issues (e.g. spec directory missing) */
  errors: string[];
}

/**
 * Reads and writes `.pi-coder/state.json` — the global pointer.
 */
export class GlobalStatePersistence {
  private readonly piCoderDir: string;
  private readonly specsDir: string;

  constructor(piCoderDir: string) {
    this.piCoderDir = piCoderDir;
    this.specsDir = join(piCoderDir, "specs");
  }

  /** Full path to global state.json */
  get statePath(): string {
    return join(this.piCoderDir, STATE_FILENAME);
  }

  /** Save global state. Atomic via tmp+rename. */
  async save(state: GlobalState): Promise<void> {
    await mkdir(this.piCoderDir, { recursive: true });
    const tempPath = join(this.piCoderDir, TEMP_FILENAME);
    const content = JSON.stringify(state, null, 2) + "\n";
    await writeFile(tempPath, content, "utf-8");
    await rename(tempPath, this.statePath);
  }

  /** Load global state. Returns null if missing, corrupt, or wrong version. */
  async load(): Promise<GlobalState | null> {
    try {
      const content = await readFile(this.statePath, "utf-8");
      const parsed = JSON.parse(content);
      if (!isValidGlobalState(parsed)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  /** Remove global state.json. No-op if missing. */
  async delete(): Promise<void> {
    try {
      await unlink(this.statePath);
    } catch (err: unknown) {
      if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw err;
    }
  }

  /**
   * Verify global state against the filesystem.
   * Checks: does the spec directory exist when activeSpecId is set?
   */
  async checkIntegrity(state: GlobalState): Promise<IntegrityCheckResult> {
    const warnings: string[] = [];
    const errors: string[] = [];

    if (state.activeSpecId) {
      const specDirPath = join(this.specsDir, state.activeSpecId);
      try {
        await readFile(join(specDirPath, "spec.md"), "utf-8");
      } catch {
        errors.push(
          `Spec directory missing or incomplete: .pi-coder/specs/${state.activeSpecId}/`,
        );
      }
    }

    return {
      valid: errors.length === 0,
      warnings,
      errors,
    };
  }
}

// ---------------------------------------------------------------------------
// SpecStatePersistence
// ---------------------------------------------------------------------------

/**
 * Reads and writes `.pi-coder/specs/{id}/state.json` — per-spec FSM state.
 */
export class SpecStatePersistence {
  /**
   * Save per-spec state. Atomic via tmp+rename.
   * @param specsDir - The `.pi-coder/specs/` directory
   * @param specId - The spec ID (directory name)
   * @param state - The spec state to persist
   */
  static async save(specsDir: string, specId: string, state: SpecState): Promise<void> {
    const specDir = join(specsDir, specId);
    await mkdir(specDir, { recursive: true });
    const tempPath = join(specDir, TEMP_FILENAME);
    const content = JSON.stringify(state, null, 2) + "\n";
    await writeFile(tempPath, content, "utf-8");
    await rename(tempPath, join(specDir, STATE_FILENAME));
  }

  /** Load per-spec state. Returns null if missing, corrupt, or wrong version. */
  static async load(specsDir: string, specId: string): Promise<SpecState | null> {
    const statePath = join(specsDir, specId, STATE_FILENAME);
    try {
      const content = await readFile(statePath, "utf-8");
      const parsed = JSON.parse(content);
      if (!isValidSpecState(parsed)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  /** Delete per-spec state.json. No-op if missing. */
  static async delete(specsDir: string, specId: string): Promise<void> {
    const statePath = join(specsDir, specId, STATE_FILENAME);
    try {
      await unlink(statePath);
    } catch (err: unknown) {
      if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function isValidGlobalState(value: unknown): value is GlobalState {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;

  if (obj.version !== 1) return false;
  // piCoderMode is required for new state, piCoderActive is for migration
  if (obj.piCoderMode !== undefined) {
    if (typeof obj.piCoderMode !== "string" || !["off", "light", "tdd"].includes(obj.piCoderMode)) return false;
  } else if (typeof obj.piCoderActive !== "boolean") {
    return false;
  }
  if (obj.activeSpecId !== null && typeof obj.activeSpecId !== "string") return false;
  if (typeof obj.updatedAt !== "string") return false;

  return true;
}

function isValidSpecState(value: unknown): value is SpecState {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;

  if (obj.version !== 1) return false;
  if (typeof obj.currentState !== "string") return false;
  if (!VALID_STATES.has(obj.currentState)) return false;
  if (typeof obj.loopCount !== "number") return false;
  if (obj.gitRef !== null && typeof obj.gitRef !== "string") return false;
  if (!Array.isArray(obj.evidence)) return false;
  if (typeof obj.createdAt !== "string") return false;
  if (typeof obj.updatedAt !== "string") return false;

  return true;
}

// ---------------------------------------------------------------------------
// Backward compat: PersistedFSM / PersistedState for migration
// ---------------------------------------------------------------------------

/**
 * @deprecated Use GlobalState + SpecState instead.
 * Kept for transition period only.
 */
export interface PersistedFSM {
  currentState: FSMState;
  activeSpecId: string | null;
  loopCount: number;
  gitRef: string | null;
}

/**
 * @deprecated Use GlobalState + SpecState instead.
 * Kept for transition period only.
 */
export interface PersistedState {
  version: 1;
  piCoderActive: boolean;
  fsm: PersistedFSM;
  updatedAt: string;
}

// Re-export VALID_STATES for backward compat with old tests
export { VALID_STATES };
