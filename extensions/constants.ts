/**
 * Pi Coder v1 — Constants: Tool lists, mode-tool mapping, and UI style constants
 *
 * Extracted from index.ts for reuse and to deduplicate the MODE_TOOL_SETS mapping.
 */

import type { PiCoderMode } from "../src/types.ts";

// ---------------------------------------------------------------------------
// Tool lists per mode
// ---------------------------------------------------------------------------

/** Tools available when pi-coder TDD mode is active. Exported for Spec 10 commands. */
export const ORCHESTRATOR_TOOLS = [
  "ls",
  "find",
  "grep",
  "subagent",
  "pi_coder_git",
  "pi_coder_run_tests",
  "upsert_knowledge",
  "pi_coder_save_spec",
  "pi_coder_read_spec",
"pi_coder_advance_fsm",
  "interview",
  "intercom",
];

/** Tools available in Light mode — spec, implement, review, no TDD phases. */
export const LIGHT_TOOLS = [
  "ls",
  "find",
  "grep",
  "subagent",
  "pi_coder_run_tests",
  "pi_coder_git",
  "pi_coder_save_spec",
  "pi_coder_read_spec",
"pi_coder_advance_fsm",
  "upsert_knowledge",
  "interview",
  "intercom",
];

/** Tools available in Plan mode — investigation only, no spec/git/FSM tools. */
export const PLAN_TOOLS = [
  "ls",
  "find",
  "grep",
  "subagent",
  "upsert_knowledge",
  "interview",
  "intercom",
];

/** Tools available when pi-coder is off (normal pi mode). Exported for use by Spec 10 commands. */
export const NORMAL_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

// ---------------------------------------------------------------------------
// Mode → tool-set mapping (deduplicated from 3x inline rebuilds in index.ts)
// ---------------------------------------------------------------------------

export const MODE_TOOL_SETS: Record<PiCoderMode, string[]> = {
  off: NORMAL_TOOLS,
  plan: PLAN_TOOLS,
  light: LIGHT_TOOLS,
  tdd: ORCHESTRATOR_TOOLS,
  dev: ORCHESTRATOR_TOOLS,
};

// ---------------------------------------------------------------------------
// UI style constants
// ---------------------------------------------------------------------------

/** Visual styling for each FSM state group. */
export const STATE_STYLE: Record<string, { icon: string; color: "success" | "warning" | "error" | "accent" | "muted" | "dim" }> = {
  IDLE:               { icon: "○", color: "dim" },
  SPEC_WORK:          { icon: "●", color: "accent" },
  SPEC_APPROVED:      { icon: "✓", color: "success" },
  GIT_CHECKPOINT:     { icon: "⟳", color: "accent" },
  IMPLEMENTING:       { icon: "●", color: "accent" },
  TDD_RED_WRITE:      { icon: "●", color: "warning" },
  TDD_RED_VALIDATE:   { icon: "●", color: "warning" },
  TDD_GREEN_WRITE:    { icon: "●", color: "accent" },
  TDD_GREEN_VALIDATE: { icon: "●", color: "accent" },
  REVIEWING:          { icon: "◎", color: "accent" },
  APPROVED:           { icon: "✓", color: "success" },
  NEEDS_CHANGES:      { icon: "✗", color: "error" },
  FINAL_APPROVAL:     { icon: "✓", color: "success" },
  MERGING:            { icon: "⟳", color: "accent" },
  COMPLETE:           { icon: "✓", color: "success" },
  BLOCKED:            { icon: "⚠", color: "error" },
};

/** Friendly labels for FSM states. */
export const STATE_LABEL: Record<string, string> = {
  IDLE:               "Idle",
  SPEC_WORK:          "Spec Work",
  SPEC_APPROVED:      "Spec Approved",
  GIT_CHECKPOINT:     "Checkpoint",
  IMPLEMENTING:       "Implementing",
  TDD_RED_WRITE:      "RED",
  TDD_RED_VALIDATE:   "RED Validate",
  TDD_GREEN_WRITE:    "GREEN",
  TDD_GREEN_VALIDATE: "GREEN Validate",
  REVIEWING:          "Reviewing",
  APPROVED:           "Approved",
  NEEDS_CHANGES:      "Needs Changes",
  FINAL_APPROVAL:     "Final Approval",
  MERGING:           "Merging",
  COMPLETE:           "Complete",
  BLOCKED:            "Blocked",
};
