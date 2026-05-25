# Spec 14: Interaction Logging

## Context

Pi-coder needs structured logging to enable incremental improvement of the harness based on real interactions. Logs capture interaction-level telemetry: FSM transitions, subagent outcomes, TDD metrics, review verdicts, nudge effectiveness, and lifecycle summaries. They deliberately exclude full prompts, file contents, and raw LLM responses (too verbose, privacy implications).

## Dependencies

Spec 01 (types), Spec 09 (extension hooks — where most events originate), Spec 10 (commands — toggle logging via config)

---

## Phase 1: Logger Module

### Acceptance Criteria

- Logger writes structured JSONL files to `.pi-coder/logs/`
- Each log entry has a timestamp, event type, and structured payload
- Log file naming is time-ordered and human-readable
- Logger can be toggled on/off via `config.logging.enabled`
- When disabled, logger is a no-op with zero overhead
- Log directory created on first write if missing

### Tasks

1. Add logging types to `src/types.ts`:
   - `LoggingConfig` — `enabled: boolean`, `level: "minimal" | "standard" | "verbose"`, `maxLogFiles: number` (default 10, rotate oldest)
   - Update `PiCoderConfig` to include `logging: LoggingConfig` with defaults (`enabled: false`, `level: "standard"`, `maxLogFiles: 10`)

2. Create `src/logger.ts` with a `Logger` class:
   - Constructor takes `(logDir: string, loggingConfig: LoggingConfig)`
   - `log(event: LogEvent)` — writes a JSONL entry. When `!config.enabled`, returns immediately (no-op). When enabled, appends one JSON line to the current log file.
   - Log file naming: `pi-coder-{YYYY-MM-DD}.log` — one file per calendar day, with automatic rotation
   - On first write of the day: if file count exceeds `maxLogFiles`, delete the oldest before creating the new one
   - `LogEvent` type: `{ timestamp: string; sessionId: string; type: LogLevelEventType; payload: Record<string, unknown> }` — `timestamp` is ISO 8601, `sessionId` is a UUID generated once per extension session, `type` is one of the event types from Phase 2

3. Generate `sessionId` once at extension initialization (in `session_start`) and pass it to all log calls — this lets us correlate events across a single pi-coder session even if they span multiple log files

4. Add tests: logger creates directory, writes JSONL, no-op when disabled, rotates old files, generates valid JSON per line

---

## Phase 2: Event Types & Extension Instrumentation

### Acceptance Criteria

- All key orchestrator interactions are captured as structured log events
- Events are emitted at the right points in the extension lifecycle
- Token usage is captured from subagent results where available
- Duration tracking for subagent runs and TDD cycles
- Log level controls which events are written

### Tasks

1. Define event types and their payloads in `src/logger.ts`:

   **Lifecycle events (all levels):**
   - `lifecycle_start` — `{ specId, userRequest }` — orchestrator begins work on a spec
   - `lifecycle_end` — `{ specId, outcome: "COMPLETE" | "BLOCKED" | "ABORTED", wallClockMs, totalTokens }` — spec finished
   - `fsm_transition` — `{ from, to, event, loopCount, specId }` — every state change

   **Subagent events (standard+ level):**
   - `subagent_start` — `{ agent, taskSummary, specId, fsmState }` — delegation begins. `taskSummary` is first 200 chars of the task string (not the full prompt)
   - `subagent_end` — `{ agent, durationMs, tokenUsage: { input, output, total }, outcome: "success" | "error" | "timeout", specId }` — delegation completes. Token usage extracted from subagent result metadata.

   **TDD events (all levels):**
   - `tdd_red_validate` — `{ valid, reason?, passed, failed, specId }` — RED phase validation result
   - `tdd_green_validate` — `{ valid, reason?, passed, failed, specId }` — GREEN phase validation result
   - `circuit_breaker` — `{ loopCount, maxLoops, specId }` — circuit breaker tripped

   **Review events (standard+ level):**
   - `review_result` — `{ verdict: "approved" | "needs_changes" | "request_changes", issueCount, highSeverityCount, loopCount, specId }` — reviewer returns verdict

   **Nudge events (verbose level):**
   - `nudge_fired` — `{ fsmState, level, expectedAction }` — nudge message generated
   - `nudge_escalation` — `{ fsmState, newLevel }` — nudge escalated to next level

   **User interaction events (standard+ level):**
   - `command` — `{ command: "toggle" | "init" | "reset_agents", result }` — user ran a pi-coder command
   - `user_intervention` — `{ fsmState, interventionType }` — user made a decision in BLOCKED state (continue/rewrite/abort) or overrode circuit breaker

2. Instrument `extensions/index.ts` to emit log events at the corresponding points:
   - `session_start`: log `command` if init/toggle
   - `tool_call`: log `subagent_start` when subagent tool is called (extract agent name + task summary)
   - `tool_result`: log `subagent_end` with duration + tokens, `tdd_red_validate` / `tdd_green_validate`, `review_result` (parse verdict from reviewer output), `fsm_transition` on every auto-transition
   - `before_agent_start`: log `nudge_fired` / `nudge_escalation` when nudges are generated
   - Toggle command: log `command` with toggle state
   - Init/reset commands: log `command` with result
   - RED_TAUTOLOGY anomaly: log `user_intervention` with user's choice
   - Circuit breaker: log `circuit_breaker` + `user_intervention`
   - Lifecycle start/end: emit from the orchestrator flow (track via FSM IDLE→RESEARCHING and COMPLETE/BLOCKED/IDLE transitions)

3. Duration tracking: record `Date.now()` at `subagent_start`, compute delta at `subagent_end`. Track lifecycle start time at first IDLE→RESEARCHING transition, compute wall clock at lifecycle end.

4. Token usage: extract from subagent tool_result metadata. The pi-subagents tool result includes a `usage` field with `prompt_tokens`, `completion_tokens`, `total_tokens`. Map to `input`/`output`/`total`.

5. Log level filtering:
   - `minimal`: lifecycle events + TDD events only
   - `standard`: + subagent events + review events + user interaction events + command events
   - `verbose`: + nudge events

6. Add tests: each event type is emitted with correct payload structure, level filtering excludes the right events, token usage extraction, duration calculation

---

## Phase 3: Log Analysis Utilities

### Acceptance Criteria

- A command provides log summary statistics
- Summary includes: total sessions, average lifecycle duration, TDD success rates, most-looped specs, nudge effectiveness, token usage breakdown
- Output is human-readable in the pi chat

### Tasks

1. Add `/pi-coder-logs` command via `pi.registerCommand`:
   - Parses all `.pi-coder/logs/*.log` files
   - Computes and displays summary statistics:
     - Total sessions (by sessionId count)
     - Average lifecycle duration (from `lifecycle_start`/`lifecycle_end` pairs)
     - TDD success rates: % of RED→GREEN transitions that succeed on first try vs. need loops
     - Top 5 most-looped specs (by loop count at `circuit_breaker` or `lifecycle_end`)
     - Review outcome distribution (approved vs. needs changes vs. request changes)
     - Nudge effectiveness: count of nudges that led to action within 1 turn vs. nudges that escalated
     - Token usage: total, per-agent breakdown, average per spec
     - RED_TAUTOLOGY frequency
   - Falls back to "No logs found" when log directory is empty or missing
   - Optional `--verbose` flag shows per-session breakdown instead of aggregate

2. Add `src/log-analysis.ts` with pure functions for computing each stat from parsed log entries — testable independently of the command

3. Add tests: stat computation functions produce correct values from known log data, command returns formatted output, empty log directory handled gracefully

---

## Log File Format Reference

Each line is a valid JSON object:

```jsonl
{"timestamp":"2026-05-25T10:15:30.123Z","sessionId":"a1b2c3d4","type":"fsm_transition","payload":{"from":"IDLE","to":"RESEARCHING","event":"start_research","loopCount":0,"specId":"user-auth"}}
{"timestamp":"2026-05-25T10:15:45.456Z","sessionId":"a1b2c3d4","type":"subagent_start","payload":{"agent":"pi-coder.researcher","taskSummary":"Research the codebase for user authentication patterns...","specId":"user-auth","fsmState":"RESEARCHING"}}
{"timestamp":"2026-05-25T10:16:22.789Z","sessionId":"a1b2c3d4","type":"subagent_end","payload":{"agent":"pi-coder.researcher","durationMs":37333,"tokenUsage":{"input":1200,"output":3500,"total":4700},"outcome":"success","specId":"user-auth"}}
```
