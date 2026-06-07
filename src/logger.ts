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
  | "verdict_extraction_failed"
  | "review_override"
  | "review_override_contradiction"
  | "command"
  | "user_intervention"
  | "nudge_fired"
  | "nudge_escalation"
  | "tool_call_blocked"
  | "state_restore"
  | "subagent_control"
  | "mode_switch"
  | "prompt_size"
  | "spec_approval"
  | "skill_read"
  | "tool_call"
  | "session_summary"
  | "unit_start"
  | "unit_end"
  | "config_validation"
  | "turn_usage"
  | "fsm_state_usage"
  | "green_retry"
  | "green_retry_enriched"
  | "green_retry_replan"
  | "green_retry_blocked"
  | "verify_retry"
  | "verify_retry_enriched"
  | "verify_retry_replan"
  | "verify_retry_blocked"
  | "verdict_extraction_degraded"
  | "verdict_extraction_source"

  | "plan_mode_summary"
  | "proactive_compaction_initiated"
  | "proactive_compaction_completed"
  | "boundary_compaction_initiated"
  | "boundary_compaction_completed"
  | "boundary_compaction_skipped_cooldown"
  | "subagent_runaway"
  | "proactive_compaction_error"
  | "proactive_compaction_resume"
  | "proactive_compaction_resume_failed"
  | "boundary_compaction_error"
  | "boundary_compaction_resume"
  | "boundary_compaction_resume_failed"
  | "review_saved_to_file"
  | "review_save_failed"
  | "research_tmp_cleaned"
  | "research_tmp_cleanup_failed"
  | "final_signoff"
  | "subagent_guard_activated"
  | "guard_truncated"
  | "guard_context_pruned"
  | "guard_compaction_summary"
  | "research_summary_injected";

/**
 * Mapping from event type to the minimum log level required.
 * Events at a lower level than the configured level are dropped.
 */
export const LOG_LEVEL_MAP: Record<LogEventType, "minimal" | "standard" | "verbose"> = {
  // Minimal: lifecycle + TDD + session summary
  lifecycle_start: "minimal",
  lifecycle_end: "minimal",
  fsm_transition: "minimal",
  tdd_red_validate: "minimal",
  tdd_green_validate: "minimal",
  circuit_breaker: "minimal",
  session_summary: "minimal",

  // Standard: + subagent + review + user + command + units + config
  subagent_start: "standard",
  subagent_end: "standard",
  tool_call_blocked: "standard",
  state_restore: "standard",
  subagent_control: "standard",
  mode_switch: "standard",
  review_result: "standard",
  verdict_extraction_failed: "standard",
  review_override: "standard",
  review_override_contradiction: "standard",
  command: "standard",
  user_intervention: "standard",
  prompt_size: "standard",
  skill_read: "standard",
  tool_call: "standard",
  spec_approval: "standard",
  unit_start: "standard",
  unit_end: "standard",
  config_validation: "standard",
  turn_usage: "standard",
  fsm_state_usage: "standard",

  // P0: GREEN retry escalation events
  green_retry: "standard",
  green_retry_enriched: "standard",
  green_retry_replan: "standard",
  green_retry_blocked: "minimal",

  // P0: Verify retry escalation events
  verify_retry: "standard",
  verify_retry_enriched: "standard",
  verify_retry_replan: "standard",
  verify_retry_blocked: "minimal",

  // P1: Verdict extraction degraded
  verdict_extraction_degraded: "standard",
  verdict_extraction_source: "standard",

  plan_mode_summary: "standard",
  proactive_compaction_initiated: "standard",
  proactive_compaction_completed: "standard",
  boundary_compaction_initiated: "standard",
  boundary_compaction_completed: "standard",
  boundary_compaction_skipped_cooldown: "standard",
  subagent_runaway: "standard",
  proactive_compaction_error: "standard",
  proactive_compaction_resume: "standard",
  proactive_compaction_resume_failed: "standard",
  boundary_compaction_error: "standard",
  boundary_compaction_resume: "standard",
  boundary_compaction_resume_failed: "standard",
  review_saved_to_file: "standard",
  review_save_failed: "standard",
  research_tmp_cleaned: "standard",
  research_tmp_cleanup_failed: "standard",
  final_signoff: "minimal",

  // Subagent context guard events
  subagent_guard_activated: "standard",
  guard_truncated: "standard",
  guard_context_pruned: "verbose",
  guard_compaction_summary: "standard",
  research_summary_injected: "standard",

  // Verbose: + nudge
  nudge_fired: "verbose",
  nudge_escalation: "verbose",
};

/**
 * Standardized trigger for FSM transitions.
 * Replaces the free-form `event` string on fsm_transition events.
 * The `event` field is retained for backward compatibility but deprecated;
 * new analysis should use `trigger`.
 */
export type FSMTrigger =
  | "auto_tdd_validation"
  | "auto_git_checkpoint"
  | "auto_git_merge"
  | "auto_review_verdict"
  | "auto_implementor_complete"
  | "manual_advance_fsm"
  | "auto_subagent_complete"
  | "fsm_reset";

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
  /** ISO 8601 timestamp (always UTC) */
  timestamp: string;
  /** Local timestamp with timezone offset (e.g., 2026-05-29T15:39:13+10:00) */
  localTimestamp?: string;
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
 * - Log files are organized by session: `.pi-coder/logs/{sessionId}/YYYY-MM-DD.log`
 * - One file per calendar day, with automatic rotation
 * - When `config.enabled` is false, `log()` is a no-op
 * - Log level controls which event types are written
 * - Dual timestamps: UTC `timestamp` + local `localTimestamp`
 */
export class Logger {
  private readonly baseLogDir: string;
  private readonly config: LoggingConfig;
  /** Session ID for this logger instance — determines the session subdirectory */
  private sessionId: string | null = null;
  /** Track the current day's log file name to avoid repeated path computation */
  private currentLogFile: string | null = null;
  private currentLogDate: string | null = null;

  constructor(baseLogDir: string, loggingConfig: LoggingConfig, sessionId?: string) {
    this.baseLogDir = baseLogDir;
    this.config = loggingConfig;
    if (sessionId) {
      this.sessionId = sessionId;
    }
  }

  /**
   * Set or update the session ID. This determines the session subdirectory.
   * Call this after construction when the session ID becomes available.
   */
  setSessionId(id: string): void {
    this.sessionId = id;
    // Reset file tracking so next log() resolves the new directory
    this.currentLogFile = null;
    this.currentLogDate = null;
  }

  /**
   * Get the effective log directory (session-scoped if sessionId is set).
   * When sessionIdPrefix is configured, the directory is named `{prefix}-{sessionId}`.
   */
  private getEffectiveLogDir(): string {
    if (this.sessionId) {
      const dirName = this.config.sessionIdPrefix
        ? `${this.config.sessionIdPrefix}-${this.sessionId}`
        : this.sessionId;
      return join(this.baseLogDir, dirName);
    }
    return this.baseLogDir;
  }

  /**
   * Format a local timestamp with timezone offset.
   * Uses the timezone from config if set, otherwise system local timezone.
   */
  private formatLocalTimestamp(d: Date): string {
    const tz = this.config.timezone;
    if (tz) {
      // Use the configured IANA timezone
      try {
        const formatter = new Intl.DateTimeFormat("sv-SE", {
          timeZone: tz,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          fractionalSecondDigits: 3,
          timeZoneName: "shortOffset",
        });
        // Format like: 2026-05-29 15:39:13.000 GMT+10
        // Convert to ISO-ish: 2026-05-29T15:39:13.000+10:00
        const parts = formatter.formatToParts(d);
        const get = (type: string) => parts.find(p => p.type === type)?.value ?? "";
        const tzName = get("timeZoneName"); // e.g., "GMT+10", "GMT−4" (may use Unicode minus U+2212)
        // Normalize timezone offset to ±HH:MM format
        // Replace Unicode minus (U+2212) with ASCII hyphen for consistency
        const normalizedTz = tzName.replace(/\u2212/g, "-");
        const offsetMatch = normalizedTz.match(/([+-])(\d{1,2})(?::?(\d{2}))?/);
        let offset = "+00:00";
        if (offsetMatch) {
          const sign = offsetMatch[1];
          const hours = offsetMatch[2].padStart(2, "0");
          const minutes = (offsetMatch[3] ?? "00").padStart(2, "0");
          offset = `${sign}${hours}:${minutes}`;
        }
        return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}.${get("fractionalSecond")}${offset}`;
      } catch {
        // Invalid timezone — fall through to local below
      }
    }
    // Default: system local timezone with offset
    const offsetMin = -d.getTimezoneOffset();
    const sign = offsetMin >= 0 ? "+" : "-";
    const absMin = Math.abs(offsetMin);
    const hours = String(Math.floor(absMin / 60)).padStart(2, "0");
    const minutes = String(absMin % 60).padStart(2, "0");
    const offsetStr = `${sign}${hours}:${minutes}`;
    // Build local ISO string manually for maximum compatibility
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    const hour = String(d.getHours()).padStart(2, "0");
    const min = String(d.getMinutes()).padStart(2, "0");
    const sec = String(d.getSeconds()).padStart(2, "0");
    const ms = String(d.getMilliseconds()).padStart(3, "0");
    return `${year}-${month}-${day}T${hour}:${min}:${sec}.${ms}${offsetStr}`;
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

    const effectiveLogDir = this.getEffectiveLogDir();

    // Ensure log directory exists
    if (!existsSync(effectiveLogDir)) {
      mkdirSync(effectiveLogDir, { recursive: true });
    }

    // Add local timestamp if not already set by caller
    const eventWithLocal: LogEvent = event.localTimestamp
      ? event
      : { ...event, localTimestamp: this.formatLocalTimestamp(new Date()) };

    // Determine the current day's log file
    const now = new Date();
    const dateStr = this.formatDate(now);

    if (this.currentLogDate !== dateStr || !this.currentLogFile) {
      this.currentLogDate = dateStr;
      this.currentLogFile = join(effectiveLogDir, `${dateStr}.log`);

      // Rotate old files if we're starting a new day's file
      this.rotateIfNeeded();
    }

    // Append one JSON line
    const line = JSON.stringify(eventWithLocal);
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
      const dir = this.getEffectiveLogDir();
      const files = readdirSync(dir)
        .filter(f => f.endsWith(".log"))
        .sort();

      const maxFiles = this.config.maxLogFiles ?? 10;

      // We're about to create a new file, so delete oldest if over limit
      while (files.length >= maxFiles) {
        const oldest = files.shift();
        if (oldest) {
          unlinkSync(join(dir, oldest));
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
