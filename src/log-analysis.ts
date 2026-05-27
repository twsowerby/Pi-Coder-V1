/**
 * Pi Coder Log Analysis — Pure functions for computing statistics
 * from structured JSONL logs.
 *
 * All functions are pure and testable without the pi runtime.
 * Input is parsed log entries (array of JSON objects).
 * Output is structured statistics.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A parsed log entry from a JSONL log file. */
export interface LogEntry {
  timestamp: string;
  sessionId: string;
  type: string;
  payload: Record<string, unknown>;
}

/** Summary statistics computed from log entries. */
export interface LogSummary {
  /** Number of unique session IDs */
  totalSessions: number;
  /** Average lifecycle duration in milliseconds (from lifecycle_start/end pairs) */
  avgLifecycleDurationMs: number | null;
  /** TDD first-try success rate (GREEN_VALIDATE valid on first loop) */
  tddFirstTrySuccessRate: number | null;
  /** Top 5 most-looped specs (by loop count) */
  mostLoopedSpecs: Array<{ specId: string | null; loopCount: number }>;
  /** Review outcome distribution */
  reviewDistribution: { approved: number; needsChanges: number; requestChanges: number };
  /** Nudge effectiveness: nudges that led to action within 1 turn vs escalated */
  nudgeEffectiveness: { actedWithinTurn: number; escalated: number };
  /** Token usage totals and per-agent breakdown */
  tokenUsage: {
    total: { input: number; output: number; total: number };
    perAgent: Record<string, { input: number; output: number; total: number }>;
    avgPerSpec: { input: number; output: number; total: number } | null;
  };
  /** Number of RED_TAUTOLOGY events */
  redTautologyCount: number;
  /** Spec count (for averaging) */
  specCount: number;
  /** Time-in-state distributions: average ms spent in each FSM state */
  timeInState: Record<string, { avgMs: number; count: number; minMs: number; maxMs: number }>;
  /** Orchestrator turns per spec: tool_call events grouped by specId */
  orchestratorTurnsPerSpec: Record<string, number>;
  /** Skill utilization: skill_read events grouped by skillName */
  skillUtilization: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

/**
 * Parse all JSONL log files in a directory into structured entries.
 * Returns an empty array if the directory doesn't exist or has no log files.
 *
 * Note: Uses dynamic import of node:fs and node:path.
 * For pure-testability, use parseLogEntries() with raw JSONL strings.
 */
export async function parseLogDir(logDir: string): Promise<LogEntry[]> {
  const { readdirSync, readFileSync, existsSync } = await import("node:fs");
  const { join } = await import("node:path");

  if (!existsSync(logDir)) return [];

  const entries: LogEntry[] = [];
  const files = readdirSync(logDir).filter((f: string) => f.endsWith(".log")).sort();

  for (const file of files) {
    const content = readFileSync(join(logDir, file), "utf-8");
    for (const line of content.trim().split("\n").filter(Boolean)) {
      try {
        entries.push(JSON.parse(line));
      } catch {
        // Skip malformed lines
      }
    }
  }

  return entries;
}

/**
 * Parse raw JSONL string content into structured log entries.
 * Useful for testing without file I/O.
 */
export function parseLogEntries(jsonlContent: string): LogEntry[] {
  const entries: LogEntry[] = [];
  for (const line of jsonlContent.trim().split("\n").filter(Boolean)) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      // Skip malformed lines
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Analysis Functions
// ---------------------------------------------------------------------------

/**
 * Compute total sessions by counting unique sessionId values.
 */
export function computeTotalSessions(entries: LogEntry[]): number {
  const sessions = new Set(entries.map(e => e.sessionId));
  return sessions.size;
}

/**
 * Compute average lifecycle duration from lifecycle_start/lifecycle_end pairs.
 * Matches on sessionId + specId.
 */
export function computeAvgLifecycleDuration(entries: LogEntry[]): number | null {
  const ends = entries.filter(e => e.type === "lifecycle_end");

  if (ends.length === 0) return null;

  let totalMs = 0;
  let count = 0;

  for (const end of ends) {
    const wallClockMs = end.payload.wallClockMs as number | null | undefined;
    if (typeof wallClockMs === "number" && wallClockMs > 0) {
      totalMs += wallClockMs;
      count++;
    }
  }

  return count > 0 ? totalMs / count : null;
}

/**
 * Compute TDD first-try success rate: percentage of GREEN validations
 * that succeed on loopCount 0 (i.e., first GREEN attempt after RED).
 */
export function computeTddFirstTryRate(entries: LogEntry[]): number | null {
  const greenValidations = entries.filter(
    e => e.type === "tdd_green_validate" && e.payload.valid === true,
  );

  if (greenValidations.length === 0) return null;

  // Find the loop count at the time of each green validation
  // by looking at the nearest preceding fsm_transition with the same specId
  let firstTryCount = 0;
  for (const gv of greenValidations) {
    // Check if this is the first green attempt (loopCount = 0 at the time)
    // We approximate by checking if there was a previous green_validate for the same specId in the same session
    const specId = gv.payload.specId;
    const sessionId = gv.sessionId;
    const gvIndex = entries.indexOf(gv);

    const previousGreenForSpec = entries.slice(0, gvIndex).find(e =>
      e.type === "tdd_green_validate" &&
      e.payload.specId === specId &&
      e.sessionId === sessionId,
    );

    if (!previousGreenForSpec) {
      firstTryCount++;
    }
  }

  return greenValidations.length > 0
    ? firstTryCount / greenValidations.length
    : null;
}

/**
 * Find the top N most-looped specs based on circuit_breaker and lifecycle_end events.
 */
export function computeMostLoopedSpecs(entries: LogEntry[], topN = 5): Array<{ specId: string | null; loopCount: number }> {
  const maxLoops: Map<string | null, number> = new Map();

  // Extract from circuit_breaker events
  for (const e of entries.filter(e => e.type === "circuit_breaker")) {
    const specId = e.payload.specId as string | null;
    const loopCount = e.payload.loopCount as number;
    const current = maxLoops.get(specId) ?? 0;
    maxLoops.set(specId, Math.max(current, loopCount));
  }

  // Also extract from lifecycle_end events
  // No-op: lifecycle_end does not include loopCount directly;
  // loop counts are already captured from circuit_breaker and fsm_transition events

  // Extract from fsm_transition events that include loopCount
  for (const e of entries.filter(e => e.type === "fsm_transition" && typeof e.payload.loopCount === "number")) {
    const specId = e.payload.specId as string | null;
    const loopCount = e.payload.loopCount as number;
    if (loopCount > 0) {
      const current = maxLoops.get(specId) ?? 0;
      maxLoops.set(specId, Math.max(current, loopCount));
    }
  }

  return Array.from(maxLoops.entries())
    .map(([specId, loopCount]) => ({ specId, loopCount }))
    .sort((a, b) => b.loopCount - a.loopCount)
    .slice(0, topN);
}

/**
 * Compute review outcome distribution.
 */
export function computeReviewDistribution(entries: LogEntry[]): { approved: number; needsChanges: number; requestChanges: number } {
  const reviews = entries.filter(e => e.type === "review_result");
  const result = { approved: 0, needsChanges: 0, requestChanges: 0 };

  for (const r of reviews) {
    const verdict = r.payload.verdict as string;
    if (verdict === "approved") result.approved++;
    else if (verdict === "needs_changes") result.needsChanges++;
    else if (verdict === "request_changes") result.requestChanges++;
  }

  return result;
}

/**
 * Compute nudge effectiveness: actions within 1 turn vs escalated nudges.
 */
export function computeNudgeEffectiveness(entries: LogEntry[]): { actedWithinTurn: number; escalated: number } {
  const nudgeFired = entries.filter(e => e.type === "nudge_fired");
  const nudgeEscalated = entries.filter(e => e.type === "nudge_escalation");

  // A nudge was "acted on" if it didn't escalate further
  const totalNudges = nudgeFired.length;
  const totalEscalations = nudgeEscalated.length;

  return {
    actedWithinTurn: totalNudges - totalEscalations,
    escalated: totalEscalations,
  };
}

/**
 * Compute token usage totals and per-agent breakdown.
 */
export function computeTokenUsage(entries: LogEntry[]): {
  total: { input: number; output: number; total: number };
  perAgent: Record<string, { input: number; output: number; total: number }>;
  avgPerSpec: { input: number; output: number; total: number } | null;
} {
  const total = { input: 0, output: 0, total: 0 };
  const perAgent: Record<string, { input: number; output: number; total: number }> = {};

  const subagentEnds = entries.filter(e => e.type === "subagent_end");

  for (const e of subagentEnds) {
    const usage = e.payload.tokenUsage as { input: number; output: number; total: number } | undefined;
    if (!usage) continue;

    total.input += usage.input;
    total.output += usage.output;
    total.total += usage.total;

    const agent = e.payload.agent as string;
    if (!perAgent[agent]) {
      perAgent[agent] = { input: 0, output: 0, total: 0 };
    }
    perAgent[agent].input += usage.input;
    perAgent[agent].output += usage.output;
    perAgent[agent].total += usage.total;
  }

  // Average per spec (from lifecycle_end totalTokens)
  const lifecycleEnds = entries.filter(e => e.type === "lifecycle_end");
  let avgPerSpec: { input: number; output: number; total: number } | null = null;
  if (lifecycleEnds.length > 0) {
    const sumTokens = { input: 0, output: 0, total: 0 };
    for (const e of lifecycleEnds) {
      const tokens = e.payload.totalTokens as { input: number; output: number; total: number } | undefined;
      if (!tokens) continue;
      sumTokens.input += tokens.input;
      sumTokens.output += tokens.output;
      sumTokens.total += tokens.total;
    }
    avgPerSpec = {
      input: sumTokens.input / lifecycleEnds.length,
      output: sumTokens.output / lifecycleEnds.length,
      total: sumTokens.total / lifecycleEnds.length,
    };
  }

  return { total, perAgent, avgPerSpec };
}

/**
 * Count RED_TAUTOLOGY occurrences from tdd_red_validate events where valid is false.
 */
export function computeRedTautologyCount(entries: LogEntry[]): number {
  return entries.filter(
    e => e.type === "tdd_red_validate" && e.payload.valid === false && e.payload.reason === "RED_TAUTOLOGY",
  ).length;
}

/**
 * Count unique spec IDs from lifecycle events.
 */
export function computeSpecCount(entries: LogEntry[]): number {
  const specIds = new Set(
    entries
      .filter(e => e.type === "lifecycle_start" || e.type === "lifecycle_end")
      .map(e => e.payload.specId as string)
      .filter(Boolean),
  );
  return specIds.size;
}

/**
 * Compute time-in-state distributions from consecutive fsm_transition events.
 * For each transition, the duration = next_transition.timestamp - this_transition.timestamp,
 * grouped by the `from` state.
 */
export function computeTimeInState(entries: LogEntry[]): Record<string, { avgMs: number; count: number; minMs: number; maxMs: number }> {
  const transitions = entries.filter(e => e.type === "fsm_transition");
  const durationsByState: Record<string, number[]> = {};

  for (let i = 0; i < transitions.length - 1; i++) {
    const current = transitions[i];
    const next = transitions[i + 1];
    const from = current.payload.from as string;

    try {
      const currentTs = new Date(current.timestamp).getTime();
      const nextTs = new Date(next.timestamp).getTime();
      const duration = nextTs - currentTs;
      if (duration > 0) {
        if (!durationsByState[from]) durationsByState[from] = [];
        durationsByState[from].push(duration);
      }
    } catch {
      // Skip entries with invalid timestamps
    }
  }

  const result: Record<string, { avgMs: number; count: number; minMs: number; maxMs: number }> = {};
  for (const [state, durations] of Object.entries(durationsByState)) {
    const avgMs = durations.reduce((a, b) => a + b, 0) / durations.length;
    const minMs = Math.min(...durations);
    const maxMs = Math.max(...durations);
    result[state] = { avgMs, count: durations.length, minMs, maxMs };
  }
  return result;
}

/**
 * Compute orchestrator turns per spec from tool_call events grouped by specId.
 */
export function computeOrchestratorTurnsPerSpec(entries: LogEntry[]): Record<string, number> {
  const toolCalls = entries.filter(e => e.type === "tool_call");
  const counts: Record<string, number> = {};

  for (const tc of toolCalls) {
    const specId = (tc.payload.specId as string) ?? "none";
    counts[specId] = (counts[specId] ?? 0) + 1;
  }

  return counts;
}

/**
 * Compute skill utilization from skill_read events grouped by skillName.
 */
export function computeSkillUtilization(entries: LogEntry[]): Record<string, number> {
  const skillReads = entries.filter(e => e.type === "skill_read");
  const counts: Record<string, number> = {};

  for (const sr of skillReads) {
    const skillName = (sr.payload.skillName as string) ?? "unknown";
    counts[skillName] = (counts[skillName] ?? 0) + 1;
  }

  return counts;
}

// ---------------------------------------------------------------------------
// Full Summary
// ---------------------------------------------------------------------------

/**
 * Compute a full summary from all log entries.
 */
export function computeFullSummary(entries: LogEntry[]): LogSummary {
  return {
    totalSessions: computeTotalSessions(entries),
    avgLifecycleDurationMs: computeAvgLifecycleDuration(entries),
    tddFirstTrySuccessRate: computeTddFirstTryRate(entries),
    mostLoopedSpecs: computeMostLoopedSpecs(entries),
    reviewDistribution: computeReviewDistribution(entries),
    nudgeEffectiveness: computeNudgeEffectiveness(entries),
    tokenUsage: computeTokenUsage(entries),
    redTautologyCount: computeRedTautologyCount(entries),
    specCount: computeSpecCount(entries),
    timeInState: computeTimeInState(entries),
    orchestratorTurnsPerSpec: computeOrchestratorTurnsPerSpec(entries),
    skillUtilization: computeSkillUtilization(entries),
  };
}

/**
 * Format a summary as human-readable text for display in the pi chat.
 */
export function formatSummary(summary: LogSummary): string {
  const lines: string[] = ["📊 Pi Coder Log Summary"];

  lines.push(`\nSessions: ${summary.totalSessions}`);

  if (summary.avgLifecycleDurationMs !== null) {
    const seconds = (summary.avgLifecycleDurationMs / 1000).toFixed(1);
    lines.push(`Avg lifecycle duration: ${seconds}s`);
  }

  if (summary.tddFirstTrySuccessRate !== null) {
    const pct = (summary.tddFirstTrySuccessRate * 100).toFixed(1);
    lines.push(`TDD first-try success rate: ${pct}%`);
  }

  if (summary.mostLoopedSpecs.length > 0) {
    lines.push("\nMost-looped specs:");
    for (const s of summary.mostLoopedSpecs) {
      lines.push(`  ${s.specId ?? "unknown"}: ${s.loopCount} loops`);
    }
  }

  const rd = summary.reviewDistribution;
  const totalReviews = rd.approved + rd.needsChanges + rd.requestChanges;
  if (totalReviews > 0) {
    lines.push(`\nReview outcomes: ✅ ${rd.approved} approved, ⚠️ ${rd.needsChanges} needs changes, ❌ ${rd.requestChanges} request changes`);
  }

  const ne = summary.nudgeEffectiveness;
  const totalNudgeActions = ne.actedWithinTurn + ne.escalated;
  if (totalNudgeActions > 0) {
    lines.push(`Nudge effectiveness: ${ne.actedWithinTurn} acted within turn, ${ne.escalated} escalated`);
  }

  const tu = summary.tokenUsage;
  if (tu.total.total > 0) {
    lines.push(`\nToken usage: ${tu.total.total.toLocaleString()} total (${tu.total.input.toLocaleString()} in, ${tu.total.output.toLocaleString()} out)`);
    const agents = Object.entries(tu.perAgent);
    if (agents.length > 1) {
      lines.push("Per agent:");
      for (const [agent, usage] of agents) {
        lines.push(`  ${agent}: ${usage.total.toLocaleString()} total`);
      }
    }
    if (tu.avgPerSpec) {
      lines.push(`Avg per spec: ${Math.round(tu.avgPerSpec.total).toLocaleString()} tokens`);
    }
  }

  if (summary.redTautologyCount > 0) {
    lines.push(`\n🔴 RED tautology occurrences: ${summary.redTautologyCount}`);
  }

  // Time-in-state distributions
  const timeInState = summary.timeInState;
  const timeInStateEntries = Object.entries(timeInState);
  if (timeInStateEntries.length > 0) {
    lines.push(`\n⏱️ Time in state:`);
    for (const [state, info] of timeInStateEntries.sort((a, b) => b[1].avgMs - a[1].avgMs)) {
      const avgSecs = (info.avgMs / 1000).toFixed(1);
      const minSecs = (info.minMs / 1000).toFixed(1);
      const maxSecs = (info.maxMs / 1000).toFixed(1);
      lines.push(`  ${state}: avg ${avgSecs}s (${info.count} transitions, ${minSecs}s–${maxSecs}s)`);
    }
  }

  // Orchestrator turns per spec
  const turnsPerSpec = summary.orchestratorTurnsPerSpec;
  const turnsEntries = Object.entries(turnsPerSpec).filter(([id]) => id !== "none");
  if (turnsEntries.length > 0) {
    lines.push(`\n🔧 Orchestrator turns per spec:`);
    for (const [specId, count] of turnsEntries.sort((a, b) => b[1] - a[1])) {
      lines.push(`  ${specId}: ${count} tool calls`);
    }
  }

  // Skill utilization
  const skillUtil = summary.skillUtilization;
  const skillEntries = Object.entries(skillUtil);
  if (skillEntries.length > 0) {
    lines.push(`\n📚 Skill utilization:`);
    for (const [skillName, count] of skillEntries.sort((a, b) => b[1] - a[1])) {
      lines.push(`  ${skillName}: ${count} reads`);
    }
  }

  return lines.join("\n");
}
