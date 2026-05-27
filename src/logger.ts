/**
 * Pi Coder Logger — Structured JSONL logging for harness telemetry.
 *
 * Writes one JSON object per line to `.pi-coder/logs/pi-coder-{YYYY-MM-DD}.log`.
 * Captures FSM transitions, subagent outcomes, TDD metrics, review verdicts,
 * nudge effectiveness, and lifecycle summaries.
 *
 * When disabled, logger is a no-op with zero overhead.
 * Log level controls which event types are written.
 */

import type { LoggingConfig } from "./types.ts";
import { existsSync, mkdirSync, appendFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Event Types
// ---------------------------------------------------------------------------

/**
 * All supported log event types, categorized by level.
 *
 * Minimal: lifecycle + TDD events
 * Standard: + subagent + review + user interaction + command
 * Verbose: + nudge
 */
export type LogEventType =
  | "lifecycle_start"
  | "lifecycle_end"
  | "fsm_transition"
  | "tdd_red_validate"
  | "tdd_green_validate"
  | "circuit_breaker"
  | "subagent_start"
  | "subagent_end"
  | "review_result"
  | "command"
  | "user_intervention"
  | "nudge_fired"
  | "nudge_escalation"
  | "tool_call_blocked"
  | "state_restore"
  | "subagent_control"
  | "mode_switch"
  | "prompt_size"
  | "skill_read"
  | "tool_call";

/**
 * Mapping from event type to the minimum log level required.
 * Events at a lower level than the configured level are dropped.
 */
export const LOG_LEVEL_MAP: Record<LogEventType, "minimal" | "standard" | "verbose"> = {
  // Minimal: lifecycle + TDD
  lifecycle_start: "minimal",
  lifecycle_end: "minimal",
  fsm_transition: "minimal",
  tdd_red_validate: "minimal",
  tdd_green_validate: "minimal",
  circuit_breaker: "minimal",

  // Standard: + subagent + review + user + command
  subagent_start: "standard",
  subagent_end: "standard",
  tool_call_blocked: "standard",
  state_restore: "standard",
  subagent_control: "standard",
  mode_switch: "standard",
  review_result: "standard",
  command: "standard",
  user_intervention: "standard",
  prompt_size: "standard",
  skill_read: "standard",
  tool_call: "standard",

  // Verbose: + nudge
  nudge_fired: "verbose",
  nudge_escalation: "verbose",
};

/** Level hierarchy: minimal < standard < verbose */
const LEVEL_ORDER: Record<string, number> = {
  minimal: 0,
  standard: 1,
  verbose: 2,
};

// ---------------------------------------------------------------------------
// Log Event structure
// ---------------------------------------------------------------------------

/**
 * A single structured log event written as one JSON line.
 */
export interface LogEvent {
  /** ISO 8601 timestamp */
  timestamp: string;
  /** UUID identifying the extension session */
  sessionId: string;
  /** Event type (determines payload shape) */
  type: LogEventType;
  /** Structured event payload */
  payload: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Logger Class
// ---------------------------------------------------------------------------

/**
 * Structured JSONL logger for pi-coder telemetry.
 *
 * - Each log entry is one JSON object per line
 * - Log files are named `pi-coder-{YYYY-MM-DD}.log`
 * - One file per calendar day, with automatic rotation
 * - When `config.enabled` is false, `log()` is a no-op
 * - Log level controls which event types are written
 */
export class Logger {
  private readonly logDir: string;
  private readonly config: LoggingConfig;
  /** Track the current day's log file name to avoid repeated path computation */
  private currentLogFile: string | null = null;
  private currentLogDate: string | null = null;

  constructor(logDir: string, loggingConfig: LoggingConfig) {
    this.logDir = logDir;
    this.config = loggingConfig;
  }

  /**
   * Write a structured log event.
   * No-op when logging is disabled or the event type is filtered by level.
   */
  log(event: LogEvent): void {
    // No-op when disabled
    if (!this.config.enabled) return;

    // Filter by log level
    if (!this.shouldLog(event.type)) return;

    // Ensure log directory exists
    if (!existsSync(this.logDir)) {
      mkdirSync(this.logDir, { recursive: true });
    }

    // Determine the current day's log file
    const now = new Date();
    const dateStr = this.formatDate(now);

    if (this.currentLogDate !== dateStr) {
      this.currentLogDate = dateStr;
      this.currentLogFile = join(this.logDir, `pi-coder-${dateStr}.log`);

      // Rotate old files if we're starting a new day's file
      this.rotateIfNeeded();
    }

    // Append one JSON line
    const line = JSON.stringify(event);
    appendFileSync(this.currentLogFile!, line + "\n", "utf-8");
  }

  /**
   * Check whether an event type should be logged at the current level.
   */
  private shouldLog(type: LogEventType): boolean {
    const eventLevel = LOG_LEVEL_MAP[type];
    if (!eventLevel) return false;

    const configuredLevel = this.config.level ?? "standard";
    return LEVEL_ORDER[eventLevel] <= LEVEL_ORDER[configuredLevel];
  }

  /**
   * Rotate old log files if the count exceeds maxLogFiles.
   * Deletes the oldest files first.
   */
  private rotateIfNeeded(): void {
    try {
      const files = readdirSync(this.logDir)
        .filter(f => f.startsWith("pi-coder-") && f.endsWith(".log"))
        .sort();

      const maxFiles = this.config.maxLogFiles ?? 10;

      // We're about to create a new file, so delete oldest if over limit
      while (files.length >= maxFiles) {
        const oldest = files.shift();
        if (oldest) {
          unlinkSync(join(this.logDir, oldest));
        } else {
          break;
        }
      }
    } catch {
      // Rotation is best-effort — don't block logging
    }
  }

  /**
   * Format a Date as YYYY-MM-DD.
   */
  private formatDate(d: Date): string {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
}
