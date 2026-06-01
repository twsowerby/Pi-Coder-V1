/**
 * Pi Coder V1 — Subagent Monitor
 *
 * Tracks subagent execution state (running status, activity, timing)
 * and provides the widget rendering function.
 *
 * Extracted from extensions/index.ts for testability.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Live subagent progress data — updated via `tool_execution_update` events. */
export interface SubagentActivity {
  agent: string;
  task: string;
  currentTool: string | undefined;
  currentToolArgs: string | undefined;
  currentPath: string | undefined;
  toolCount: number;
  turnCount: number | undefined;
  tokens: number;
  durationMs: number;
  recentTools: Array<{ tool: string; args: string }>;
  lastUpdatedAt: number;
}

// ---------------------------------------------------------------------------
// Subagent Monitor Class
// ---------------------------------------------------------------------------

export class SubagentMonitor {
  /** Whether a pi-coder subagent is currently running. */
  running = false;

  /** Live subagent progress data. */
  activity: SubagentActivity | null = null;

  /** Start time of the current subagent delegation. */
  startTime: number | null = null;

  /** Name of the last subagent agent invoked. */
  lastAgent: string | null = null;

  /** Timer that re-renders the subagent widget to update elapsed duration. */
  widgetTimer: ReturnType<typeof setInterval> | null = null;

  /** Start tracking a new subagent delegation. */
  start(agent: string, task: string, currentTool?: string): void {
    this.startTime = Date.now();
    this.lastAgent = agent;
    this.running = true;
    this.activity = {
      agent,
      task,
      currentTool,
      currentToolArgs: undefined,
      currentPath: undefined,
      toolCount: 0,
      turnCount: undefined,
      tokens: 0,
      durationMs: 0,
      recentTools: [],
      lastUpdatedAt: Date.now(),
    };
  }

  /** Stop tracking — clear all subagent state. */
  stop(): void {
    this.startTime = null;
    this.lastAgent = null;
    this.running = false;
    this.activity = null;
    if (this.widgetTimer) {
      clearInterval(this.widgetTimer);
      this.widgetTimer = null;
    }
  }

  /** Update activity from tool_execution_update events. */
  updateActivity(updater: (a: SubagentActivity) => void): void {
    if (this.activity) {
      updater(this.activity);
      this.activity.lastUpdatedAt = Date.now();
    }
  }
}
