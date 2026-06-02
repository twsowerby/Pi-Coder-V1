# Extension Hooks & Known Gaps Analysis

## Files Retrieved

1. `extensions/index.ts` (full) — Main extension entry; wires all hooks, handlers, commands, and shared state
2. `src/handlers/before-agent-start.ts` (full) — Injects orchestrator prompt, filters tools/skills, runs nudge system
3. `src/handlers/session-start.ts` (full) — Initializes all pi-coder state on session start: config, FSM, persistence, tools, subagent events
4. `src/token-tracker.ts` (full) — Tracks cumulative token usage across spec lifecycle and per-FSM-state breakdown
5. `src/log-analysis.ts` (full) — Pure functions for computing statistics from structured JSONL logs
6. `src/handlers/tool-call.ts` (full) — Validates tool calls against FSM state, blocks disallowed tools, tracks subagent delegation
7. `src/handlers/tool-result.ts` (full) — Auto-transitions FSM based on results, handles review verdicts, extracts subagent usage
8. `src/nudge-engine.ts` (first 80 lines) — Nudge state tracking and threshold calculation
9. `src/types.ts` (full) — All shared type definitions
10. `extensions/constants.ts` (full) — Tool lists per mode, MODE_TOOL_SETS, UI style constants
11. `src/state-machine.ts` (first 80 lines) — TDD FSM definition with transition guards
12. `src/light-state-machine.ts` (first 80 lines) — Light FSM definition with simplified lifecycle
13. `_dev_docs/adversarial-reviews/01-fork-reviewer-fsm-integrity.md` (full) — Fork context danger analysis
14. `_dev_docs/adversarial-reviews/02-output-reads-signal-loss.md` (full) — Output file-only and reads signal loss analysis
15. `_dev_docs/adversarial-reviews/03-chains-parallel-failure-modes.md` (full) — Chain/parallel failure modes analysis
16. `_dev_docs/adversarial-reviews/04-architectural-coherence.md` (full) — Architectural coherence of pi-subagents features
17. `_dev_docs/fsm-review.md` (full) — FSM precondition/invariant audit and proposed architecture
18. `_dev_docs/specs/15-three-mode-system.md` (full) — Three-mode system spec

---

## 1. Extension Hooks and FSM Wiring

### Registered Event Hooks

| Hook | Handler File | Purpose |
|------|-------------|---------|
| `session_start` | `src/handlers/session-start.ts` | Initialize config, logger, FSM, persistence, tools, sub-listeners |
| `before_agent_start` | `src/handlers/before-agent-start.ts` | Replace system prompt, filter tools/skills, nudge system |
| `tool_call` | `src/handlers/tool-call.ts` | Validate against FSM state, block disallowed tools, track subagents |
| `tool_result` | `src/handlers/tool-result.ts` | Auto-transition FSM, extract review verdicts, track subagent usage |
| `turn_end` | `extensions/index.ts` (inline) | Capture orchestrator token usage, accumulate into lifecycle/phase buckets |
| `agent_end` | `extensions/index.ts` (inline) | Desktop notification on agent idle |
| `session_shutdown` | `extensions/index.ts` (inline) | Emit session summary, cleanup timers, persist final state |

### FSM Wiring Flow

```
session_start → Create StateMachine (TDD) or LightStateMachine (Light) or null (Plan/Off)
                Register tools, set evidence flags on tool results
                Restore persisted state from .pi-coder/state.json

before_agent_start → Inject mode-specific prompt (TDD/Light/Plan)
                     Filter tool snippets to mode-appropriate subset
                     Filter skills to mode-relevant subset
                     Fire nudge if threshold exceeded

tool_call → Default-deny: only MODE_TOOL_SETS[mode] allowed
            Plan: only pi-coder.researcher subagent
            Light/TDD: validate subagent against isActionAllowed()
            NEEDS_CHANGES: require non_functional_classified evidence for implementor

tool_result → Auto-transition FSM:
              - interview in SPEC_WORK → set spec_user_approved evidence
              - pi_coder_run_tests → TDD RED/GREEN validation + auto-transitions
              - pi_coder_git checkpoint → advance to TDD_RED_WRITE/IMPLEMENTING
              - pi_coder_git merge → advance to COMPLETE
              - subagent reviewer → extract verdict → APPROVED or NEEDS_CHANGES
```

### Evidence Flag Lifecycle

| Flag | Set by | When | Cleared |
|------|--------|------|---------|
| `spec_saved` | `pi_coder_save_spec` execute | On successful spec save | On IDLE transition |
| `spec_user_approved` | `tool_result` handler | `interview` tool completes in SPEC_WORK | On IDLE transition |
| `test_run_this_state` | `tool_result` handler | `pi_coder_run_tests` completes | On any state transition |
| `review_completed` | `tool_result` handler | Reviewer verdict extracted successfully | On IDLE transition |
| `non_functional_classified` | `tool_result` handler | Reviewer verdict says `fixType: non-functional` | On IDLE transition |

### Transition Guards (in StateMachine)

| From → To | Required Evidence |
|-----------|------------------|
| SPEC_WORK → SPEC_APPROVED | `spec_saved` + `spec_user_approved` |
| TDD_RED_VALIDATE → TDD_GREEN_WRITE | `test_run_this_state` |
| TDD_GREEN_VALIDATE → TDD_RED_WRITE | `test_run_this_state` |
| TDD_GREEN_VALIDATE → REVIEWING | `test_run_this_state` |
| REVIEWING → APPROVED | `review_completed` |
| NEEDS_CHANGES → REVIEWING | `non_functional_classified` |

Light mode has: SPEC_WORK → SPEC_APPROVED (same as TDD) and REVIEWING → APPROVED (review_completed). No `test_run_this_state` guards.

---

## 2. Token Tracker — What Metrics It Captures

### Lifecycle Metrics

- **`lifecycleTokens`**: Cumulative `{ input, output, cacheRead, cacheWrite, cost, turns }` across a single spec lifecycle
- **`phaseTokens`**: Per-FSM-state breakdown, each with source breakdown (orchestrator vs subagent)
- **`lifecycleStartTime`**: Wall-clock start time for duration calculation

### Session Metrics

- **`sessionTurnCount`**: Total orchestrator turns in this session
- **`sessionStartTime`**: Session start timestamp
- **`sessionSpecCount`**: Number of specs attempted in this session
- **`specApprovalInterviewStartTime`**: Duration of the approval interview

### Accrual Sources

- **`accrueOrchestrator(usage)`**: Called on `turn_end` — captures orchestrator (main session) token usage
- **`accrueSubagent(usage)`**: Called on `tool_result` when subagent completes — captures subagent token usage

Both feed into:
1. `lifecycleTokens` (cumulative)
2. The `phaseTokens[currentAccrualState]` bucket with source breakdown

### State Transition Emission

`emitStateUsageAndTransition(fromState, toState, specId)`:
- Emits `fsm_state_usage` event for the state being exited
- Switches accrual to the new state
- The event includes full per-source breakdown: `{ orchestrator: {...}, subagent: {...} }`

### Cache Metrics

The tracker captures **`cacheRead` and `cacheWrite`** in every bucket. These come from:
- `turn_end` event: `usage.cacheRead`, `usage.cacheWrite`
- `extractSubagentUsage()`: `usage.cacheRead`, `usage.cacheWrite`

The `log-analysis.ts` `computeCostAnalysis()` computes `cacheSavingsPercent` as `(cacheReadTokens / totalInputTokens) * 100`.

### What Is NOT Tracked

- Per-model breakdown (model is logged in `turn_usage` and `subagent_end` events but not accumulated in the tracker)
- Context window pressure or utilization
- Prompt caching hit rates across sessions
- Streaming token rates

---

## 3. Log Analysis System — What It Tracks

### Structured Event Types (Logged via `logEvent`)

Core events visible from the code: `lifecycle_start`, `lifecycle_end`, `fsm_transition`, `tool_call`, `tool_call_blocked`, `subagent_start`, `subagent_end`, `review_result`, `verdict_extraction_failed`, `tdd_red_validate`, `tdd_green_validate`, `config_validation`, `state_restore`, `spec_approval`, `circuit_breaker`, `nudge_fired`, `nudge_escalation`, `prompt_size`, `session_summary`, `fsm_state_usage`, `subagent_control`, `skill_read`, `turn_usage`, `unit_end`.

### Analysis Functions (Pure, in `log-analysis.ts`)

| Function | Metric |
|----------|--------|
| `computeTotalSessions` | Unique session IDs |
| `computeAvgLifecycleDuration` | Average spec lifecycle wall-clock time |
| `computeTddFirstTryRate` | % of GREEN validations on first attempt |
| `computeMostLoopedSpecs` | Top N specs by loop count |
| `computeReviewDistribution` | approved / needs_changes / request_changes |
| `computeNudgeEffectiveness` | acted within 1 turn vs escalated |
| `computeTokenUsage` | Total/per-agent/avg-per-spec token counts |
| `computeCostAnalysis` | Total cost, source, cache savings, coverage stats |
| `computeAgentDurations` | Per-agent avg/min/max duration |
| `computeUnitStats` | Per-unit loop counts and outcomes |
| `computeRedTautologyCount` | RED tautology occurrences |
| `computeTimeInState` | Avg/min/max ms spent in each FSM state |
| `computeOrchestratorTurnsPerSpec` | Tool calls per spec |
| `computeSkillUtilization` | Skill reads by name |
| `computePhaseTokenBreakdown` | Per-state token breakdown with source detail |

### Output Format

`formatSummary()` produces a human-readable report with:
- Session counts, lifecycle durations, TDD success rates
- Most-looped specs, review distribution
- Token usage (total, per-agent, avg-per-spec) with cache stats
- Cost analysis with source tagging and cache savings percentage
- Per-agent durations, per-unit stats
- Time-in-state distributions, orchestrator turns per spec
- Per-state token breakdown (orchestrator vs subagent percentages)

---

## 4. KNOWN Gaps from Adversarial Reviews

### Review 01: Fork Context for Reviewer (NEEDS_CHANGES)

**Critical findings:**

| # | Finding | Severity |
|---|---------|----------|
| 1 | `pi_coder_run_tests`/`git`/`interview` tool result steers survive fork filtering | 🟠 Medium |
| 2 | Reviewer independence contract violation — orchestrator reasoning in assistant messages passes through fork | 🔴 High |
| 3 | Prior-review output pollution through orchestrator prose references | 🔴 High |
| 4 | Verdict extraction false-positive risk under richer context (Tier 1 emoji / Tier 2 text) | 🟡 Low–Medium |
| 5 | Project context leakage through conversation history (system prompt stripped, but prose references survive) | 🟡 Low |
| 6 | `stripParentOnlySubagentMessages` filter is incomplete — designed for advisory (oracle) not adversarial (reviewer) | 🔴 High |
| 7 | FSM evidence gate integrity dilution — gate checks *that* a review happened, not *if it was independent* | 🟠 Medium |

**Required mitigations if fork is adopted:**
- M1: Extend filter to strip `pi_coder_run_tests`, `pi_coder_git`, `interview`, `pi_coder_advance_fsm` tool results
- M2: Strip all assistant messages for adversarial fork (option A — reviewer gets task via `subagent` call's `task` parameter)
- M3: Strip loop-count and circuit-breaker references
- M4: Reinforce reviewer system prompt about ignoring orchestration artifacts
- M5: Log `review_independence_mode` field in verdict events

### Review 02: Output File-Only & Reads (NEEDS_CHANGES)

**Critical findings:**

| # | Finding | Severity |
|---|---------|----------|
| 1 | Orchestrator has no `read` tool — cannot access researcher's file output | 🔴 FATAL |
| 2 | `finalOutput` replaced with file reference — verdict extraction pipeline fails entirely | 🔴 CRITICAL |
| 3 | `messages` array stripped in `file-only` mode — eliminates `rawContent` fallback | 🔴 HIGH |
| 4 | `reads` gives subagents full spec — violates minimal delegation context principle | 🟠 HIGH |
| 5 | `reads` lets implementor see future units — over-implementation risk | 🟠 HIGH |
| 6 | Output files pollute git / concurrent runs | 🟡 MEDIUM |
| 7 | Subagent usage tracking IS preserved (partial refutation) | N/A |

**Verdict:** `output: file-only` and `reads` for spec handoffs are both rejected in current form.

### Review 03: Chains & Parallel Failure Modes (NEEDS_CHANGES)

**Critical findings:**

| # | Finding | Severity |
|---|---------|----------|
| 1 | `extractReviewVerdict()` reads only `results[0]` — for a chain `[implementor→reviewer]`, reads implementor output, not reviewer verdict | 🔴 CRITICAL |
| 2 | `SubagentMonitor` uses scalar fields — cannot track multiple parallel agents (overwrite, loss of timing/UI data) | 🔴 CRITICAL |
| 3 | FSM state desynchronization during chain execution — chains crossing FSM state boundaries cause illegal transitions | 🔴 CRITICAL |
| 4 | No steer message injection point in chains — orchestrator loses primary navigation mechanism | 🟠 HIGH |
| 5 | Parallel researcher output merging is intractable at LLM scale | 🟠 SIGNIFICANT |
| 6 | Mid-chain failures leave orchestrator blind — no structured metadata on which step failed | 🔴 CRITICAL |
| 7 | `extractSubagentTarget()` returns `undefined` for chain input shapes — entire validation block skipped | 🟠 SIGNIFICANT (security bypass) |
| 8 | Timing calculations wrong for chains | 🟡 LOW |
| 9 | `control.enabled = false` may not propagate to chain steps | 🟡 LOW |

**Required mitigations (P0):**
- Verdict extraction must iterate `results[]` to find reviewer output
- Agent validation must handle chain/parallel input shapes
- SubagentMonitor must support multiple concurrent agents (Map-based)
- Chains must not cross FSM state boundaries

### Review 04: Architectural Coherence (NEEDS_CHANGES)

**Core thesis:** All proposed pi-subagents features (chains, fork, reads, file-only, parallel) are architectural mismatches that fight the extension's core design philosophy.

**Key arguments:**

1. **The orchestrator is NOT overhead** — every inter-step turn performs essential work (context pruning, FSM management, evidence gating, user interaction) that cannot be eliminated by chains
2. **Fork context for reviewer violates independence contract** — no evidence that fresh context is inadequate; high risk of anchor bias with no measurement framework
3. **`output: file-only` is a net loss** — orchestrator can't read files; even if it could, costs more LLM turns; pruning happens regardless after one turn
4. **`reads` subverts information control** — orchestrator deliberately controls what each subagent sees; `reads` bypasses this; `pi_coder_read_spec` already exists for this purpose
5. **Parallel researchers create reconciliation problem** — conflicting findings, overlapping file reads, no demonstrated need
6. **No measurement framework exists** — can't evaluate whether any change is actually an improvement
7. **Philosophy drift risk** — each "small" concession shifts authority from orchestrator to subagents; the orchestrator becomes unnecessary if this continues

**All recommendations: REJECT as designed.** Requires measurement framework and evidence of current system inadequacy before any changes.

---

## 5. Specific Architectural Issues Flagged

### FSM Review — Invariant Audit

The FSM enforces **state topology** but does NOT enforce **state preconditions** uniformly:

| Invariant | Status | Gap |
|-----------|--------|-----|
| I1: Spec saved before SPEC_APPROVED | ✅ Enforced | `pi_coder_advance_fsm` guard + `spec_saved` evidence |
| I2: Spec user-approved before implementation | ❌ NOT ENFORCED | Was prompt-only; now enforced via `spec_user_approved` evidence + transition guard |
| I3: TDD states require test execution | ✅ Now enforced | `test_run_this_state` evidence guards on transitions out of validation states |
| I4: Review verdict drives APPROVED/NEEDS_CHANGES | ✅ Now enforced | `review_completed` evidence + auto-transition in `tool_result` handler |
| I5: Knowledge stores cross-cutting gotchas only | ❌ NOT ENFORCED | LLM persists cycle summaries despite guidance; low severity |

### Two-Tier Enforcement Gaps

1. **Evidence resets on state transitions** — `test_run_this_state` is cleared on every transition. But `spec_saved` and `spec_user_approved` persist until IDLE. This means evidence from SPEC_WORK carries forward through GIT_CHECKPOINT and TDD phases, which is correct but could be confusing for debugging if stale evidence remains after a cycle reset.

2. **`NEEDS_CHANGES → REVIEWING` requires `non_functional_classified`** — This is checked both in the FSM transition guard AND in the `tool_call` handler (blocking implementor delegation in NEEDS_CHANGES without this evidence). This dual enforcement is intentional but means the error messages differ: the FSM gives a generic error while the tool-call handler gives contextual guidance.

3. **Plan mode has no FSM at all** — Plan mode falls through to the `if (piCoderMode === "tdd" || piCoderMode === "light")` checks and is handled separately (researcher-only restriction). This is correct but means plan mode entirely bypasses the evidence/evidence framework — by design.

---

## 6. Context Caching Management

### What EXISTS

**Token tracking of cache metrics:** The `TokenTracker`, `turn_end` handler, and `log-analysis.ts` all capture `cacheRead` and `cacheWrite` tokens:
- `turn_usage` events log `{ input, output, cacheRead, cacheWrite, cost }` per turn
- `subagent_end` events log the same from `extractSubagentUsage()`
- `computeCostAnalysis()` calculates `cacheSavingsPercent`
- `computePhaseTokenBreakdown()` includes cache tokens per FSM state

**Prompt caching in prompt builders:** `loadOrchestratorPrompt()`, `loadLightModePrompt()`, `loadPlanModePrompt()` all cache the loaded template string after first load (reset on session start). This is a simple in-memory cache of the prompt template text, not a context caching optimization.

### What Does NOT Exist

1. **No prompt prefix stability for context caching.** The system prompt is rebuilt on every `before_agent_start` call with dynamic content (FSM state, loop count, active spec, filtered tools). The prompt's prefix changes every turn because:
   - The `[MODE: TDD]` indicator is prepended
   - Template variables like `{{currentState}}`, `{{loopCount}}` are substituted
   - Nudge messages may be appended
   - This prevents Anthropic/Gemini-style prompt caching from hitting, because the cache key is the entire prompt content

2. **No cache-aware prompt ordering.** The prompt concatenation order is:
   ```
   modeIndicator → orchestratorPrompt → appendSystemPrompt → contextFiles → skills → date + cwd → nudgeMessage
   ```
   Dynamic content is interleaved with static content. For effective prompt caching, static content should be at the prefix (beginning) and dynamic content at the suffix (end).

3. **No cache control headers.** There's no mechanism to set cache control points in the prompt (e.g., Anthropic's `cache_control` breakpoints).

4. **No subagent context cache reuse.** Subagents always run with `defaultContext: fresh`, so they never benefit from cached context from previous calls. Each subagent invocation starts from scratch, re-reading all the same project files.

### Practical Impact

- The `cacheRead`/`cacheWrite` metrics in the tracker may be **zero for orchestrator turns** if the API doesn't support prompt caching, or could be significant if it does (e.g., Anthropic API with `cache_control`).
- The `cacheSavingsPercent` in log analysis could be a useful metric for optimization: if it's near 0%, there's significant savings available from making prompts cache-friendly.
- Subagent token usage is the dominant cost (researcher reads many files, implementor reads many files). These are all fresh-context — no caching.

---

## 7. Three-Mode System — Current State

### Implementation Status: **Fully Implemented**

The three-mode system described in Spec 15 is fully implemented in the codebase. Evidence:

| Spec 15 Component | Implementation Status | Location |
|-------------------|----------------------|----------|
| `PiCoderMode = "off" \| "plan" \| "light" \| "tdd"` | ✅ Done | `src/types.ts:219` |
| `LightFSMState` type | ✅ Done | `src/types.ts:31-44` |
| `IStateMachine` interface | ✅ Done | `src/types.ts:73-107` |
| `LightStateMachine` class | ✅ Done | `src/light-state-machine.ts` |
| `PLAN_TOOLS` constant | ✅ Done | `extensions/constants.ts:30-38` |
| `MODE_TOOL_SETS` mapping | ✅ Done | `extensions/constants.ts:44-49` |
| Mode indicator in `before_agent_start` | ✅ Done | `src/handlers/before-agent-start.ts:62-68` |
| Plan mode subagent restriction | ✅ Done | `src/handlers/tool-call.ts:86-93` |
| Light mode FSM validation | ✅ Done | `src/handlers/tool-call.ts:94-155` |
| `buildPlanModePrompt()` | ✅ Done | `src/prompts/prompt-builders.ts` (imported) |
| `buildLightModePrompt()` | ✅ Done | `src/prompts/prompt-builders.ts` (imported) |
| 4-option mode menu (`/pi-coder`) | ✅ Done | `src/commands/mode.ts` (registered) |
| Light mode git auto-transition | ✅ Done | `src/handlers/tool-result.ts:218-228` (IMPLEMENTING vs TDD_RED_WRITE) |
| Light mode review auto-transition | ✅ Done | `src/handlers/tool-result.ts:313-337` (IMPLEMENTING vs TDD_RED_WRITE in steers) |
| Nudge for Light mode | ✅ Done | `src/handlers/before-agent-start.ts:112` |
| `refreshUI` for Plan/Light | ✅ Done | `extensions/index.ts:78-129` |
| State persistence for Light FSM | ✅ Done | `src/handlers/session-start.ts:155-195` |
| Cross-mode spec pause/resume | ✅ Done | `src/handlers/session-start.ts:173-195` (mode mismatch detection) |

### Removed Components (as spec'd)

- `lightModeImplementorBlockedAtTurn` turn-boundary gate: **Removed** — replaced by `IMPLEMENTING` state FSM enforcement
- Old light mode with no FSM: **Replaced** by `LightStateMachine` with full FSM

### State Machine Differences: TDD vs Light

| Aspect | TDD (StateMachine) | Light (LightStateMachine) |
|--------|---------------------|---------------------------|
| Implementation states | TDD_RED_WRITE, TDD_RED_VALIDATE, TDD_GREEN_WRITE, TDD_GREEN_VALIDATE | IMPLEMENTING (single state) |
| Test gates | Required (`test_run_this_state` evidence) | None (tests advisory) |
| `pi_coder_run_tests` availability | Only in validation states | All states |
| Researcher in implementation | Not allowed in TDD phases | Allowed in IMPLEMENTING |
| BLOCKED reachable | From RED_VALIDATE (tests pass unexpectedly) | From any state (`allowAnyToBlocked: true`) |
| Git checkpoint auto-advance | → TDD_RED_WRITE | → IMPLEMENTING |
| Needs Changes fix | → TDD_RED_WRITE (functional) or REVIEWING (non-functional) | → IMPLEMENTING or REVIEWING |

### Known Gaps in Three-Mode System

1. **Cross-mode spec migration is explicitly out of scope** (Spec 15 §12). A TDD spec with `TDD_RED_WRITE` state cannot be resumed in Light mode — the state name is invalid. The `session-start.ts` handler detects this (lines 173-190) and shows a warning, but offers no migration path.

2. **Plan mode has no FSM ergo no state persistence.** Switching from Plan to Light/TDD creates a fresh FSM. There's no mechanism to carry Plan-mode discoveries into the FSM state (though knowledge entries and the conversation history itself serve this purpose).

3. **Light mode `REVIEWING → APPROVED` requires `review_completed` evidence**, same as TDD. The `tool_result` handler sets this when extracting a verdict. But the Light mode transition guard table only has this one guard for REVIEWING→APPROVED — the NEEDS_CHANGES→REVIEWING path also requires `non_functional_classified`.

4. **The `IMPLEMENTING` state in Light mode has no "completion" evidence gate.** The orchestrator advances manually from IMPLEMENTING → REVIEWING. There's no equivalent of `test_run_this_state` to verify implementation actually happened before review. This is by design (Light mode trusts the orchestrator's judgment about implementation completeness) but it's a weaker guarantee than TDD.

---

## Key Code Snippets

### HandlerContext — the shared state object (`src/handlers/types.ts`, used everywhere)

```typescript
const hctx: HandlerContext = {
  pi, piCoderMode, stateMachine, config, subagentsAvailable,
  activeSpecId, tokenTracker, nudgeEngine, subagentMonitor,
  specManager, sessionCtx, logger, sessionId, gitOps, tddRunner,
  knowledgeStore, globalStatePersistence, specStateCreatedAt, projectCwd,
  logEvent, persistState, refreshUI, refreshSubagentWidget,
};
```

### Auto-transition on review verdict (`tool-result.ts:296-337`)

```typescript
const target = reviewVerdict.verdict === "approved" ? "APPROVED" : "NEEDS_CHANGES";
ctx.stateMachine!.setEvidence("review_completed");
ctx.stateMachine!.transition(target);
ctx.tokenTracker.emitStateUsageAndTransition("REVIEWING", target, ctx.activeSpecId);
```

### Default-deny tool check (`tool-call.ts:39-58`)

```typescript
const allowedTools = MODE_TOOL_SETS[ctx.piCoderMode];
if (!allowedTools.includes(toolName)) {
  return { block: true, reason: guidance };
}
```

### Nudge threshold check (`before-agent-start.ts:112-147`)

```typescript
if (threshold !== undefined &&
    !ctx.nudgeEngine.state.actionAttempted &&
    ctx.nudgeEngine.state.turnsSinceEntry > threshold &&
    ctx.nudgeEngine.state.lastNudgeLevel < maxEscalation) {
  ctx.nudgeEngine.state.lastNudgeLevel++;
  // Level 1-2: append to system prompt
  // Level 3: user-visible notification
}
```

---

## Architecture Summary

```
┌──────────────────────────────────────────────────────────────────────┐
│ extensions/index.ts — Extension Factory                              │
│   ↓ Creates HandlerContext (shared state)                            │
│   ↓ Registers: session_start, before_agent_start, tool_call,        │
│   ↓            tool_result, turn_end, agent_end, session_shutdown    │
├──────────────────────────────────────────────────────────────────────┤
│ session_start → Config, Logger, FSM (TDD/Light/null), Persistence,  │
│                 Tools, Subagent events, Knowledge, SpecManager      │
├──────────────────────────────────────────────────────────────────────┤
│ before_agent_start → Mode indicator + Mode-specific prompt           │
│                      + Filtered tools/skills + Nudge injection       │
├──────────────────────────────────────────────────────────────────────┤
│ tool_call → Default-deny tool check → FSM validation →              │
│             Subagent delegation tracking → Nudge reset               │
├──────────────────────────────────────────────────────────────────────┤
│ tool_result → Auto-transition FSM (tests/git/review) →              │
│               Evidence flag setting → Subagent usage tracking →     │
│               State persistence → UI refresh                         │
├──────────────────────────────────────────────────────────────────────┤
│ TokenTracker ← turn_end (orchestrator), tool_result (subagent)      │
│   → lifecycleTokens, phaseTokens per FSM state, source breakdown    │
├──────────────────────────────────────────────────────────────────────┤
│ LogAnalysis ← .pi-coder/logs/ JSONL → computeFullSummary()          │
│   → Sessions, durations, TDD rates, review distribution, costs,     │
│     time-in-state, per-agent breakdowns, cache savings               │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Consolidated Risk Register

| ID | Risk | Source | Severity | Status |
|----|------|--------|----------|--------|
| GAP-01 | `extractReviewVerdict()` reads only `results[0]` — breaks for chains | Review 03 | 🔴 CRITICAL | Known, unmitigated |
| GAP-02 | `SubagentMonitor` is scalar — cannot track parallel agents | Review 03 | 🔴 CRITICAL | Known, unmitigated |
| GAP-03 | `extractSubagentTarget()` returns `undefined` for chain input — all validation bypassed | Review 03 | 🔴 CRITICAL (security) | Known, unmitigated |
| GAP-04 | Fork context leaks orchestrator reasoning to reviewer | Review 01 | 🔴 HIGH | Rejected as-designed |
| GAP-05 | `output: file-only` breaks verifier extraction pipeline | Review 02 | 🔴 CRITICAL | Rejected as-designed |
| GAP-06 | `reads` for spec files violates minimal delegation principle | Review 02 | 🟠 HIGH | Rejected as-designed |
| GAP-07 | Chains cross FSM state boundaries causing illegal transitions | Review 03 | 🔴 CRITICAL | Rejected as-designed |
| GAP-08 | No measurement framework for review quality or pruning effectiveness | Review 04 | 🟠 SIGNIFICANT | Known, not started |
| GAP-09 | Prompt construction order not cache-friendly — high redundant token cost | Code analysis | 🟠 HIGH | Known, unmitigated |
| GAP-10 | Subagents always use fresh context — no cache reuse across calls | Code analysis | 🟠 HIGH | By design, but costly |
| GAP-11 | Light mode IMPLEMENTING → REVIEWING has no completion evidence gate | FSM review | 🟡 MEDIUM | By design |
| GAP-12 | Cross-mode spec migration impossible (TDD ↔ Light) | Spec 15 §12 | 🟡 MEDIUM | Explicitly out of scope |
| GAP-13 | `spec_user_approved` interview heuristic may fire incorrectly in non-approval contexts | Session-start | 🟡 LOW- MEDIUM | Heuristic, best-effort |
| GAP-14 | `GlobalState.piCoderActive` deprecated field still in migration path | types.ts | 🟡 LOW | Migration compat |

---

## Start Here

**Open `src/handlers/tool-result.ts`** — This is the most critical file for understanding the system's control plane. It contains:
- All FSM auto-transition logic (review verdicts, test validation, git operations)
- Evidence flag setting
- Subagent usage extraction
- Verdict extraction failure recovery paths
- All the steer message injection that drives orchestrator behavior

Every adversarial review gap (GAP-01 through GAP-07) traces back to assumptions baked into this file. Understanding its structure is prerequisite for any change.
