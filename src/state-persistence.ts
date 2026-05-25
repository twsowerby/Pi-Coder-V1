/**
 * State Persistence for Pi Coder v1.
 *
 * Persists the FSM state to `.pi-coder/state.json` so that cycles survive
 * session crashes and user-initiated context clears. On init, the extension
 * reads this file to restore the state machine; on every transition or toggle,
 * the extension writes it back (atomic tmp+rename).
 *
 * Shape:
 *   { version, piCoderActive, fsm: { currentState, activeSpecId, loopCount, gitRef }, updatedAt }
 *
 * The spec file is already on disk (.pi-coder/specs/), the knowledge files
 * are on disk, the JSONL log is on disk. This file stores only what would
 * otherwise be lost: the in-memory FSM snapshot and the toggle state.
 */

import { join } from "node:path";
import {
  readFile,
  writeFile,
  unlink,
  rename,
  mkdir,
} from "node:fs/promises";
import type { FSMState } from "./types.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PersistedFSM {
  currentState: FSMState;
  activeSpecId: string | null;
  loopCount: number;
  gitRef: string | null;
}

export interface PersistedState {
  /** Schema version — increment on breaking changes */
  version: 1;
  /** Whether orchestrator mode is active */
  piCoderActive: boolean;
  /** FSM snapshot */
  fsm: PersistedFSM;
  /** ISO timestamp of last write */
  updatedAt: string;
}

export interface IntegrityCheckResult {
  /** True if no errors (warnings are advisory) */
  valid: boolean;
  /** Advisory notes (e.g. terminal state, stale) */
  warnings: string[];
  /** Blocking issues (e.g. spec file missing when specId is set) */
  errors: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATE_FILENAME = "state.json";
const TEMP_FILENAME = "state.json.tmp";

// ---------------------------------------------------------------------------
// StatePersistence class
// ---------------------------------------------------------------------------

/**
 * Reads and writes `.pi-coder/state.json`.
 *
 * All writes are atomic (write to tmp, then rename) so a crash mid-write
 * leaves the previous state intact.
 */
export class StatePersistence {
  private readonly stateDir: string;
  private readonly specsDir: string;

  constructor(piCoderDir: string) {
    this.stateDir = piCoderDir;
    this.specsDir = join(piCoderDir, "specs");
  }

  /** Full path to state.json */
  get statePath(): string {
    return join(this.stateDir, STATE_FILENAME);
  }

  // ---- Write ----

  /**
   * Persist state to disk. Atomic via tmp+rename.
   * Safe to call from fire-and-forget contexts.
   */
  async save(state: PersistedState): Promise<void> {
    await mkdir(this.stateDir, { recursive: true });
    const tempPath = join(this.stateDir, TEMP_FILENAME);
    const content = JSON.stringify(state, null, 2) + "\n";
    // Clean up any leftover temp file from a previous crash
    try { await unlink(tempPath); } catch { /* ignore ENOENT */ }
    await writeFile(tempPath, content, "utf-8");
    await rename(tempPath, this.statePath);
  }

  // ---- Read ----

  /**
   * Load persisted state from disk. Returns null if:
   * - File doesn't exist (fresh start)
   * - File can't be parsed (corrupt — treat as missing)
   * - Version is not 1 (future schema — don't guess)
   */
  async load(): Promise<PersistedState | null> {
    try {
      const content = await readFile(this.statePath, "utf-8");
      const parsed = JSON.parse(content);
      if (!isValidPersistedState(parsed)) return null;
      return parsed;
    } catch {
      // ENOENT, parse error, etc. — treat as "no state"
      return null;
    }
  }

  // ---- Delete ----

  /**
   * Remove state.json. No-op if the file doesn't exist.
   * Called on /pi-coder reset or when a cycle completes cleanly.
   */
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

  // ---- Integrity ----

  /**
   * Verify the persisted state against the filesystem.
   *
   * Checks:
   * - If activeSpecId is set, does the spec file exist?
   * - If currentState is IDLE or COMPLETE, flag as "no resume needed"
   *
   * Does NOT check git ref validity (needs git access, done in extension init).
   * Returns a result with errors (blocking) and warnings (advisory).
   */
  async checkIntegrity(state: PersistedState): Promise<IntegrityCheckResult> {
    const warnings: string[] = [];
    const errors: string[] = [];

    // Spec file exists when specId is set
    if (state.fsm.activeSpecId) {
      const specPath = join(this.specsDir, `${state.fsm.activeSpecId}.md`);
      try {
        await readFile(specPath, "utf-8");
      } catch {
        errors.push(
          `Spec file missing: .pi-coder/specs/${state.fsm.activeSpecId}.md`,
        );
      }
    }

    // Terminal states — no cycle to resume
    if (state.fsm.currentState === "IDLE" || state.fsm.currentState === "COMPLETE") {
      warnings.push(
        `State is ${state.fsm.currentState} — no cycle to resume`,
      );
    }

    return {
      valid: errors.length === 0,
      warnings,
      errors,
    };
  }
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const VALID_STATES: Set<string> = new Set<FSMState>([
  "IDLE", "SPEC_WORK", "SPEC_APPROVED",
  "GIT_CHECKPOINT", "TDD_RED_WRITE", "TDD_RED_VALIDATE",
  "TDD_GREEN_WRITE", "TDD_GREEN_VALIDATE", "REVIEWING",
  "APPROVED", "NEEDS_CHANGES", "FINAL_APPROVAL", "MERGING",
  "COMPLETE", "BLOCKED",
]);

/**
 * Validate the shape of a parsed PersistedState.
 * Returns true if it looks correct, false otherwise.
 */
function isValidPersistedState(value: unknown): value is PersistedState {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;

  // Version
  if (obj.version !== 1) return false;

  // piCoderActive
  if (typeof obj.piCoderActive !== "boolean") return false;

  // fsm
  if (!obj.fsm || typeof obj.fsm !== "object") return false;
  const fsm = obj.fsm as Record<string, unknown>;
  if (typeof fsm.currentState !== "string") return false;
  if (!VALID_STATES.has(fsm.currentState)) return false;
  if (fsm.activeSpecId !== null && typeof fsm.activeSpecId !== "string") return false;
  if (typeof fsm.loopCount !== "number") return false;
  if (fsm.gitRef !== null && typeof fsm.gitRef !== "string") return false;

  // updatedAt
  if (typeof obj.updatedAt !== "string") return false;

  return true;
}
