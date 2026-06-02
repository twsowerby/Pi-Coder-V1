# Code Context — Phase 4 Handler/Command Extraction from `extensions/index.ts`

Total file length: **2,639 lines**

---

## File Layout Overview

| Section | Lines | Description |
|---------|-------|-------------|
| Imports & constants | 1–41 | Import statements, re-exports |
| Module-scope state | 42–52 | `piCoderMode`, `subagentsAvailable`, `stateMachine`, `config` |
| NudgeEngine + SubagentMonitor instances + `sessionCtx` | 53–66 | `nudgeEngine`, `subagentMonitor`, `sessionCtx` |
| **`refreshUI()`** | 76–208 | Deferred from Phase 2/3 |
| **`refreshSubagentWidget()`** | 218–279 | Deferred from Phase 2/3 |
| Module dependencies | 281–306 | `gitOps`, `tddRunner`, `knowledgeStore`, `specManager`, `logger`, `sessionId`, `tokenTracker`, `globalStatePersistence`, `activeSpecId`, `specStateCreatedAt`, `projectCwd`, `persistStatePromise` |
| Re-exports & imports | 370–400 | Prompt builders re-exports, review extraction re-exports |
| `persistState()` | 321–351 | Module-level function |
| `logEvent()` | 358–367 | Module-level function |
| **`piCoderExtension()` factory** | 408–2639 | Extension wiring — contains all 9 targets |
| ┣ **4.6 `session_start` handler** | 413–834 | ~422 lines |
| ┣ `agent_end` handler | 840–844 | ~5 lines (NOT a target — simple notification) |
| ┣ `turn_end` handler | 849–877 | ~29 lines (NOT a target — token capture) |
| ┣ `session_shutdown` handler | 883–908 | ~26 lines (NOT a target — cleanup + persist) |
| ┣ **4.7 `before_agent_start` handler** | 914–1072 | ~159 lines |
| ┣ **4.8 `tool_call` handler** | 1080–1346 | ~267 lines |
| ┣ **4.9 `tool_result` handler** | 1350–1981 | ~632 lines |
| ┣ **4.1 `pi-coder` command** | 1991–2100 | ~110 lines |
| ┣ **4.2 `pi-coder-init` command** | 2106–2376 | ~271 lines |
| ┣ **4.3 `pi-coder-reset-agents` command** | 2382–2439 | ~58 lines |
| ┣ **4.4 `pi-coder-close` command** | 2445–2517 | ~73 lines |
| ┗ **4.5 `pi-coder-logs` command** | 2523–2638 | ~116 lines |

---

## Target 4.1: `commands/pi-coder.ts` — Mode Switch Command

**Line range:** 1991–2100

### Module-level variables READ
- `piCoderMode` (read + written)
- `stateMachine` (read + written)
- `subagentsAvailable` (read)
- `config` (read — for `stateMachine` construction)
- `nudgeEngine` (NOT directly read)
- `tokenTracker.sessionTurnCount` (written — reset to 0)

### Module-level variables WRITTEN
- `piCoderMode` — set to selected mode
- `stateMachine` — replaced with new `StateMachine` or `LightStateMachine` or `null`
- `tokenTracker.sessionTurnCount` — reset to 0

### Module-level functions CALLED
- `logEvent()` — mode_switch, command
- `refreshUI()` — after mode switch
- `persistState()` — at end

### Imports needed
- `PiCoderMode` type
- `StateMachine` class
- `LightStateMachine` class
- `MODE_TOOL_SETS` from constants
- `PiCoderConfig` type (for config ref)

### Exports/re-exports touched
- `piCoderMode` is exported (`export let piCoderMode`)
- `stateMachine` is exported (`export let stateMachine`)

### Interaction with other extracted modules
- **NudgeEngine**: NOT directly called, but `nudgeEngine.reset()` is called on FSM transitions elsewhere
- **TokenTracker**: `sessionTurnCount` written
- **SubagentMonitor**: NOT directly touched
- Uses `pi.setActiveTools()` and `pi.sendMessage()` from `ExtensionAPI`

---

## Target 4.2: `commands/pi-coder-init.ts` — Init Command

**Line range:** 2106–2376

### Module-level variables READ
- `subagentsAvailable` (read — for warning)

### Module-level variables WRITTEN
- NONE directly (writes to filesystem only)

### Module-level functions CALLED
- `logEvent()` — command
- `detectTestCommand()` — from `src/config.ts`
- `detectTestCommands()` — from `src/config.ts`

### Imports needed
- `existsSync`, `readFileSync`, `writeFileSync`, `mkdirSync`, `copyFileSync`, `readdirSync` from `node:fs`
- `join`, `dirname` from `node:path`
- `fileURLToPath` from `node:url`
- `loadConfig`, `detectTestCommand`, `detectTestCommands` from `src/config.ts`
- `PiCoderConfig` type
- Inline `getPackageAgentsDir()` helper (lines 2111–2116) — uses `dirname`, `fileURLToPath`, `import.meta.url`

### Exports/re-exports touched
- None

### Interaction with other extracted modules
- None — pure filesystem I/O + `ctx.ui.notify()`

---

## Target 4.3: `commands/pi-coder-reset-agents.ts` — Reset Agents Command

**Line range:** 2382–2439

### Module-level variables READ
- None (reads filesystem only)

### Module-level variables WRITTEN
- None

### Module-level functions CALLED
- `logEvent()` — command
- `resetOrchestratorPromptCache()` — from prompt-builders
- `resetLightModePromptCache()` — from prompt-builders
- `resetPlanModePromptCache()` — from prompt-builders
- Inline `getPackageAgentsDir()` helper (defined in pi-coder-init scope, lines 2111–2116 — **MUST be shared or duplicated**)

### Imports needed
- `existsSync`, `copyFileSync` from `node:fs`
- `join`, `dirname` from `node:path`
- `fileURLToPath` from `node:url`
- `resetOrchestratorPromptCache`, `resetLightModePromptCache`, `resetPlanModePromptCache` from prompt-builders

### Exports/re-exports touched
- None

### Interaction with other extracted modules
- **Prompt builders**: `resetOrchestratorPromptCache`, `resetLightModePromptCache`, `resetPlanModePromptCache`

---

## Target 4.4: `commands/pi-coder-close.ts` — Close Spec Command

**Line range:** 2445–2517

### Module-level variables READ
- `specManager` (read)
- `activeSpecId` (read + written — set to null)
- `stateMachine` (read — `currentState`, `loopCount`; written — `reset()`)
- `nudgeEngine` (written — `reset("IDLE")`)

### Module-level variables WRITTEN
- `activeSpecId` — set to `null`
- `stateMachine` — `.reset()` called

### Module-level functions CALLED
- `logEvent()` — fsm_transition, command
- `persistState()` — at end
- `refreshUI()` — at end
- `tokenTracker.emitStateUsageAndTransition()`

### Imports needed
- `SpecStatePersistence` — `.delete()` static method
- `IStateMachine` type

### Exports/re-exports touched
- `activeSpecId` is NOT exported
- `stateMachine` is exported (but only `.reset()` called, not reassigned)

### Interaction with other extracted modules
- **NudgeEngine**: `nudgeEngine.reset("IDLE")`
- **TokenTracker**: `emitStateUsageAndTransition()`
- **SpecManager**: `listSpecs()`, `readSpec()`, `updateSpec()`
- **SpecStatePersistence**: `.delete()`

---

## Target 4.5: `commands/pi-coder-logs.ts` — Logs Command

**Line range:** 2523–2638

### Module-level variables READ
- `config` (read — `config.logging.tokenPricing`)

### Module-level variables WRITTEN
- None

### Module-level functions CALLED
- `logEvent()` — command
- `computeFullSummary()` — dynamic import from `src/log-analysis.ts`
- `formatSummary()` — dynamic import from `src/log-analysis.ts`

### Imports needed
- `existsSync`, `readFileSync`, `readdirSync` from `node:fs`
- `join` from `node:path`
- `computeFullSummary`, `formatSummary` from `src/log-analysis.ts`

### Exports/re-exports touched
- None

### Interaction with other extracted modules
- None beyond `config` and `logEvent()`

---

## Target 4.6: `handlers/session-start.ts` — Session Start Handler

**Line range:** 413–834

### Module-level variables READ
- `piCoderMode` (read + written)
- `stateMachine` (read + written — new instances assigned)
- `config` (read + written — loaded from `loadConfig()`)
- `subagentsAvailable` (read + written)
- `tokenTracker` (read + written — multiple fields)
- `sessionCtx` (written — captured from ctx)
- `projectCwd` (written — captured from ctx)
- `sessionId` (written — new UUID)
- `logger` (written — new Logger instance)
- `nudgeEngine` — `reset()` called
- `subagentMonitor` — `.activity`, `.running`, `.widgetTimer` read/written
- `gitOps` (written — new GitOperations)
- `tddRunner` (written — new TddRunner)
- `knowledgeStore` (written — new KnowledgeStore)
- `specManager` (written — new SpecManager)
- `globalStatePersistence` (written — new GlobalStatePersistence)
- `activeSpecId` (read + written — from persisted state)
- `specStateCreatedAt` (read + written — from persisted state)
- `persistStatePromise` (implicitly — `persistState()` called at end)

### Module-level variables WRITTEN
- `tokenTracker.sessionTurnCount` = 0
- `tokenTracker.sessionStartTime`
- `tokenTracker.sessionSpecCount` = 0
- `piCoderMode` — from persisted state or fallback
- `sessionCtx`
- `projectCwd`
- `config`
- `sessionId`
- `logger`
- `stateMachine` — new instance(s)
- `gitOps`
- `tddRunner`
- `knowledgeStore`
- `specManager`
- `globalStatePersistence`
- `subagentsAvailable`
- `activeSpecId`
- `specStateCreatedAt`
- `subagentMonitor.running`, `.activity`, `.widgetTimer`, `.startTime`, `.lastAgent`

### Module-level functions CALLED
- `logEvent()` — config_validation, state_restore, subagent_control, skill_read, etc.
- `refreshUI()`
- `refreshSubagentWidget()`
- `persistState()` — at end
- `nudgeEngine.reset()`
- `loadConfig()` — from `src/config.ts`
- `loadOrchestratorPrompt()` — from prompt-builders
- `resetOrchestratorPromptCache()` — from prompt-builders
- `resetLightModePromptCache()` — from prompt-builders
- `resetPlanModePromptCache()` — from prompt-builders
- `registerTools()` — from `src/tools.ts`
- `notify()` — from `src/notification-manager.ts`
- `formatDurationMs()` — from `src/ui/formatting.ts`
- `formatTokenCount()` — from `src/ui/formatting.ts`

### Sub-listeners registered WITHIN session_start (inline)
These are `pi.events.on(...)` calls that capture `sessionCtx` and module state in closures. They are **tightly coupled** to the session_start handler:
1. **`subagent:control-event` listener** (lines ~510–574) — logs subagent control events
2. **`tool_execution_update` listener** (lines ~586–661) — live subagent progress, populates `subagentMonitor.activity`, calls `refreshSubagentWidget()`
3. **`tool_execution_end` listener** (lines ~664–674) — clears subagent activity widget

### Exports/re-exports touched
- `piCoderMode` (exported, written)
- `subagentsAvailable` (exported, written)
- `stateMachine` (exported, written)
- `config` (exported, written)
- `specManager` (exported, written)

### Interaction with other extracted modules
- **NudgeEngine**: `nudgeEngine.reset()`
- **SubagentMonitor**: writes to `.running`, `.activity`, `.widgetTimer`, `.startTime`, `.lastAgent`; reads `.running`
- **TokenTracker**: writes `sessionTurnCount`, `sessionStartTime`, `sessionSpecCount`, `specApprovalInterviewStartTime`; reads `sessionTurnCount`; calls `accrueSubagent()`, `emitStateUsageAndTransition()`
- **StateMachine/LightStateMachine**: new instances, `fromJSON()` static methods
- **GitOperations/TddRunner**: new instances
- **KnowledgeStore/SpecManager**: new instances
- **GlobalStatePersistence/SpecStatePersistence**: new instances, `.load()`, `.save()`, `.checkIntegrity()`, `.delete()`

---

## Target 4.7: `handlers/before-agent-start.ts` — Before Agent Start Handler

**Line range:** 914–1072

### Module-level variables READ
- `piCoderMode` (read)
- `stateMachine` (read — `currentState`, `loopCount`, `canNudge()`, `isActionAllowed()`, `getValidTransitions()`)
- `config` (read — nudge thresholds, maxLoops)
- `tokenTracker.sessionTurnCount` (read — incremented)
- `nudgeEngine` (read + written — `.state.turnsSinceEntry`, `.getThreshold()`, `.state.actionAttempted`, `.state.lastNudgeLevel`, `.buildMessage()`)
- `activeSpecId` (read — for prompt building)
- `subagentMonitor.running` (read — for working indicator)

### Module-level variables WRITTEN
- `tokenTracker.sessionTurnCount` (incremented)

### Module-level functions CALLED
- `logEvent()` — prompt_size, nudge_fired, nudge_escalation
- `buildOrchestratorPrompt()` — from prompt-builders
- `buildLightModePrompt()` — from prompt-builders
- `buildPlanModePrompt()` — from prompt-builders
- `nudgeEngine.getThreshold()`, `.buildMessage()`
- `formatSkillsForPrompt()` — from `@earendil-works/pi-coding-agent`

### Imports needed
- `PiCoderMode` type
- `IStateMachine` type
- `MODE_TOOL_SETS`, `STATE_STYLE`, `STATE_LABEL` from constants
- `buildOrchestratorPrompt`, `buildLightModePrompt`, `buildPlanModePrompt` from prompt-builders
- `formatSkillsForPrompt`, `Skill` from `@earendil-works/pi-coding-agent`

### Exports/re-exports touched
- None (returns `{ systemPrompt }` to pi event system)

### Interaction with other extracted modules
- **NudgeEngine**: deep coupling — reads/writes `nudgeEngine.state.turnsSinceEntry`, `.state.actionAttempted`, `.state.lastNudgeLevel`; calls `.getThreshold()`, `.buildMessage()`
- **StateMachine**: `currentState`, `canNudge()`, `isActionAllowed()`, `getValidTransitions()`
- **TokenTracker**: `sessionTurnCount` incremented
- **SubagentMonitor**: `.running` read (for prompt decisions)

---

## Target 4.8: `handlers/tool-call.ts` — Tool Call Handler

**Line range:** 1080–1346

### Module-level variables READ
- `piCoderMode` (read)
- `stateMachine` (read — `currentState`, `isActionAllowed()`, `hasEvidence()`, `canNudge()`)
- `config` (read — nudge config)
- `activeSpecId` (read)
- `nudgeEngine` (written — `.state.actionAttempted = true`)
- `tokenTracker.specApprovalInterviewStartTime` (written)
- `subagentMonitor` (written — `.startTime`, `.lastAgent`, `.running`, `.activity`, `.widgetTimer`)
- `specStateCreatedAt` (not read here)

### Module-level variables WRITTEN
- `nudgeEngine.state.actionAttempted` = true
- `tokenTracker.specApprovalInterviewStartTime` = Date.now()
- `subagentMonitor.startTime` = Date.now()
- `subagentMonitor.lastAgent` = targetAgent
- `subagentMonitor.running` = true
- `subagentMonitor.activity` = { ... }
- `subagentMonitor.widgetTimer` = setInterval(...)

### Module-level functions CALLED
- `logEvent()` — tool_call_blocked, tool_call, subagent_start, spec_approval, nudge_fired
- `refreshUI()` — after subagent delegation
- `refreshSubagentWidget()` — after subagent delegation
- `summarizeToolInput()` — from `src/tools.ts`
- `extractSubagentTarget()` — from `src/review-extraction.ts`
- `notify()` — from `src/notification-manager.ts`

### Imports needed
- `MODE_TOOL_SETS` from constants
- `summarizeToolInput` from `src/tools.ts`
- `extractSubagentTarget` from `src/review-extraction.ts`
- `IStateMachine` type

### Exports/re-exports touched
- None (returns `{ block, reason }` or `undefined` to pi event system)

### Interaction with other extracted modules
- **NudgeEngine**: `.state.actionAttempted` written
- **SubagentMonitor**: `.startTime`, `.lastAgent`, `.running`, `.activity`, `.widgetTimer` written
- **TokenTracker**: `.specApprovalInterviewStartTime` written
- **StateMachine**: `currentState`, `isActionAllowed()`, `hasEvidence()`, `canNudge()`

---

## Target 4.9: `handlers/tool-result.ts` — Tool Result Handler

**Line range:** 1350–1981

### Module-level variables READ
- `piCoderMode` (read)
- `stateMachine` (read + written — `transition()`, `setEvidence()`, `.currentState`, `.loopCount`, `.gitRef`, `.currentUnitName`, `.circuitBreakerTripped()`, `.reset()`)
- `config` (read — `maxLoops`, nudge config, logging config)
- `activeSpecId` (read)
- `specStateCreatedAt` (read in persistState)
- `tokenTracker` (read + written — multiple methods and fields)
- `nudgeEngine` (written — `.reset()`)
- `subagentMonitor` (read + written — `.startTime`, `.lastAgent`, `.running`, `.activity`, `.widgetTimer`)
- `sessionCtx` (read — for `ui.notify()`)
- `projectCwd` (read — via `join()` in persist)

### Module-level variables WRITTEN
- `stateMachine` — `.transition()`, `.setEvidence()`, `.reset()` called
- `tokenTracker.lifecycleStartTime`, `.sessionSpecCount`, `.specApprovalInterviewStartTime` — written
- `nudgeEngine` — `.reset()` called
- `subagentMonitor.startTime`, `.lastAgent`, `.running`, `.activity`, `.widgetTimer` — written
- `activeSpecId` — set to null in some paths
- `specStateCreatedAt` — NOT written here

### Module-level functions CALLED
- `logEvent()` — fsm_transition, tdd_red_validate, tdd_green_validate, subagent_end, review_result, verdict_extraction_failed, lifecycle_start, lifecycle_end, circuit_breaker, unit_end, spec_approval, tool_call_blocked
- `refreshUI()` — at end
- `refreshSubagentWidget()` — when clearing subagent widget
- `persistState()` — after transitions
- `notify()` — from `src/notification-manager.ts`
- `extractSubagentUsage()` — from `src/review-extraction.ts`
- `extractReviewVerdict()` — from `src/review-extraction.ts`
- `extractDetailsDiagnostics()` — from `src/review-extraction.ts`
- `isIntercomReceipt()` — from `src/review-extraction.ts`
- `tokenTracker.accrueSubagent()`, `.emitStateUsageAndTransition()`, `.snapshotLifecycleTokens()`, `.snapshotPhaseTokens()`, `.resetLifecycleTracking()`
- `formatTokenCount()`, `formatDurationMs()` — from `src/ui/formatting.ts`
- `nudgeEngine.reset()`

### Imports needed
- `extractSubagentUsage`, `extractReviewVerdict`, `extractDetailsDiagnostics`, `isIntercomReceipt` from `src/review-extraction.ts`
- `formatTokenCount`, `formatDurationMs` from `src/ui/formatting.ts`
- `notify` from `src/notification-manager.ts`
- `SpecStatePersistence` — for `.delete()` in close paths
- `IStateMachine` type, `FSMState` type
- `NudgeEngine` type

### Exports/re-exports touched
- None directly (returns modified `content` or `undefined` to pi event system)

### Interaction with other extracted modules
- **NudgeEngine**: `nudgeEngine.reset(stateMachine.currentState)` after every FSM transition
- **SubagentMonitor**: full lifecycle — `.startTime`, `.lastAgent`, `.running`, `.activity`, `.widgetTimer` all read/written
- **TokenTracker**: `accrueSubagent()`, `emitStateUsageAndTransition()`, `snapshotLifecycleTokens()`, `snapshotPhaseTokens()`, `resetLifecycleTracking()`, `.lifecycleStartTime`, `.sessionSpecCount`, `.specApprovalInterviewStartTime`
- **StateMachine**: `transition()`, `setEvidence()`, `reset()`, `currentState`, `loopCount`, `circuitBreakerTripped()`, `hasEvidence()`, `canNudge()`

---

## Deferred Functions from Phase 2/3

### `refreshUI()` — Lines 76–208

**Signature:** `function refreshUI(): void`

**Module-level variables READ:**
- `sessionCtx` (read — `ExtensionContext`)
- `piCoderMode` (read — branches on "off", "plan", "light", "tdd")
- `stateMachine` (read — `currentState`, `loopCount` in TDD mode)
- `subagentMonitor.running` (read — for working indicator)
- `activeSpecId` (read — for widget label)
- `config.maxLoops` (read — for loop counter display)
- `STATE_STYLE`, `STATE_LABEL` from constants.ts (read)

**Module-level variables WRITTEN:** None

**Calls:** `refreshSubagentWidget()`

**Imports needed:**
- `STATE_STYLE`, `STATE_LABEL` from constants
- `IStateMachine` type

### `refreshSubagentWidget()` — Lines 218–279

**Signature:** `function refreshSubagentWidget(): void`

**Module-level variables READ:**
- `sessionCtx` (read — `ExtensionContext`)
- `piCoderMode` (read — "off" check)
- `subagentMonitor.running` (read)
- `subagentMonitor.activity` (read — agent, task, currentTool, currentPath, durationMs, toolCount, turnCount, tokens, lastUpdatedAt)
- `subagentMonitor.startTime` (read — for fallback duration)
- `activeSpecId` (read — for header)

**Module-level variables WRITTEN:** None

**Imports needed:**
- `formatDurationMs`, `formatTokenCount` from `src/ui/formatting.ts`

---

## `persistState()` — Lines 319–351

**Signature:** `export async function persistState(): Promise<void>`

**Module-level variables READ:**
- `persistStatePromise` (read + written — serialized)
- `piCoderMode`
- `activeSpecId`
- `stateMachine` — `currentState`, `loopCount`, `gitRef`, `getEvidence()`, `currentUnitName`
- `specStateCreatedAt`
- `globalStatePersistence` — `.save()`
- `projectCwd`

**Exports/re-exports touched:** Yes — `export async function persistState()`

---

## `logEvent()` — Lines 358–367

**Signature:** `function logEvent(type: LogEventType, payload: Record<string, unknown>): void`

**Module-level variables READ:**
- `logger`
- `sessionId`
- `tokenTracker.sessionTurnCount`
- `piCoderMode`

---

## piCoderExtension Factory — Lines 408–2639

**Signature:** `export default function piCoderExtension(pi: ExtensionAPI): void`

This is the single entry point. ALL 9 targets are code blocks INSIDE this factory. Extraction must:
1. Keep the factory function structure in `index.ts`
2. Import the extracted handler/command functions
3. Call them, passing needed module-scope state as parameters (or via a shared context object)

---

## Non-Target Handlers (within piCoderExtension but NOT extracted)

| Handler | Lines | Description | Reason not extracted |
|---------|-------|-------------|---------------------|
| `agent_end` | 840–844 | Desktop notification on agent idle | Too small (~5 lines) |
| `turn_end` | 849–877 | Token capture per turn | ~29 lines, tightly coupled to `tokenTracker` |
| `session_shutdown` | 883–908 | Session cleanup + persist | ~26 lines |

These 3 handlers are small enough to remain inline. If extracted later, they should go into `handlers/` as separate files.

---

## Remaining Code NOT Covered by 9 Targets

| Lines | Description | Status |
|-------|-------------|--------|
| 1–32 | Top-level imports | Stay in `index.ts` |
| 33–41 | Constants imports + re-exports | Stay in `index.ts` |
| 42–52 | Module-scope state (`piCoderMode`, `subagentsAvailable`, `stateMachine`, `config`) | Stay in `index.ts` |
| 53–66 | `nudgeEngine`, `subagentMonitor`, `sessionCtx` declarations | Stay in `index.ts` |
| 76–208 | `refreshUI()` | Deferred — stays or moves to `ui/` |
| 218–279 | `refreshSubagentWidget()` | Deferred — stays or moves to `ui/` |
| 281–316 | Module dependencies + `activeSpecId` | Stay in `index.ts` |
| 319–351 | `persistState()` | Stay in `index.ts` (exported, used by multiple targets) |
| 358–367 | `logEvent()` | Stay in `index.ts` (used by ALL targets) |
| 370–400 | Prompt builders re-exports, review extraction re-exports | Stay in `index.ts` |
| 408–412 | `piCoderExtension` factory signature | Stay in `index.ts` |
| 840–844 | `agent_end` handler | Stay inline |
| 849–877 | `turn_end` handler | Stay inline |
| 883–908 | `session_shutdown` handler | Stay inline |

---

## Complete Module-Level Variable Registry

| Variable | Line | Type | Exported? | Used by targets |
|----------|------|------|-----------|-----------------|
| `piCoderMode` | 46 | `PiCoderMode` | ✅ | 4.1, 4.6, 4.7, 4.8, 4.9, refreshUI, refreshSubagentWidget, logEvent |
| `subagentsAvailable` | 47 | `boolean` | ✅ | 4.1, 4.6 |
| `stateMachine` | 48 | `IStateMachine \| null` | ✅ | 4.1, 4.4, 4.6, 4.7, 4.8, 4.9, refreshUI |
| `config` | 49 | `PiCoderConfig` | ✅ | 4.1, 4.4, 4.5, 4.6, 4.7, 4.8, 4.9 |
| `nudgeEngine` | 56 | `NudgeEngine` | ❌ | 4.4, 4.6, 4.7, 4.8, 4.9 |
| `subagentMonitor` | 62 | `SubagentMonitor` | ❌ | 4.6, 4.8, 4.9, refreshUI, refreshSubagentWidget |
| `sessionCtx` | 65 | `ExtensionContext \| null` | ❌ | 4.6, 4.9, refreshUI, refreshSubagentWidget |
| `gitOps` | 282 | `GitOperations` | ❌ | 4.6 |
| `tddRunner` | 283 | `TddRunner` | ❌ | 4.6 |
| `knowledgeStore` | 284 | `KnowledgeStore` | ❌ | 4.6 |
| `specManager` | 287 | `SpecManager` | ✅ | 4.4, 4.6 |
| `logger` | 290 | `Logger` | ❌ | 4.6, logEvent |
| `sessionId` | 293 | `string` | ❌ | 4.6, logEvent |
| `tokenTracker` | 302 | `TokenTracker` | ❌ | 4.1, 4.4, 4.6, 4.7, 4.8, 4.9, logEvent |
| `globalStatePersistence` | 304 | `GlobalStatePersistence` | ❌ | 4.6, persistState |
| `activeSpecId` | 308 | `string \| null` | ❌ | 4.1, 4.4, 4.6, 4.7, 4.8, 4.9, refreshUI, refreshSubagentWidget, persistState |
| `specStateCreatedAt` | 312 | `string \| null` | ❌ | 4.6, persistState |
| `projectCwd` | 315 | `string` | ❌ | 4.6, persistState |
| `persistStatePromise` | 319 | `Promise<void>` | ❌ | persistState |

---

## Cross-Target Coupling Map

| Function/Variable | Targets that use it |
|-------------------|---------------------|
| `logEvent()` | ALL 9 targets |
| `persistState()` | 4.1, 4.4, 4.6, 4.9 |
| `refreshUI()` | 4.1, 4.4, 4.6, 4.8, 4.9 |
| `refreshSubagentWidget()` | 4.6, 4.8, 4.9 |
| `piCoderMode` | 4.1(w), 4.6(w), 4.7, 4.8, 4.9 |
| `stateMachine` | 4.1(w), 4.4(w), 4.6(w), 4.7, 4.8, 4.9(w) |
| `activeSpecId` | 4.1, 4.4(w), 4.6(w), 4.7, 4.8, 4.9 |
| `config` | 4.1, 4.4, 4.5, 4.6(w), 4.7, 4.8, 4.9 |
| `nudgeEngine` | 4.4, 4.6, 4.7(w), 4.8(w), 4.9(w) |
| `subagentMonitor` | 4.6(w), 4.8(w), 4.9(w) |
| `tokenTracker` | 4.1(w), 4.4, 4.6(w), 4.7(w), 4.8(w), 4.9(w) |

(`w` = writes)

---

## Shared Helper: `getPackageAgentsDir()`

- **Defined at:** lines 2111–2116 (inside `piCoderExtension`)
- **Used by:** 4.2 (pi-coder-init) and 4.3 (pi-coder-reset-agents)
- **Must be:** extracted to a shared utility or duplicated in both command files

---

## Key Architecture Notes

1. **All 9 targets are closures inside `piCoderExtension()`** — they capture `pi` (ExtensionAPI) and all module-level variables implicitly. Extraction must pass these as explicit parameters or use a shared context object.

2. **`logEvent()` and `persistState()` are module-level functions** used by nearly all targets. They must either:
   - Remain in `index.ts` and be imported by extracted files
   - Or be moved to shared utility modules

3. **Session_start (4.6) registers 3 sub-listeners** (`subagent:control-event`, `tool_execution_update`, `tool_execution_end`) that form a cohesive unit with the handler and should be extracted together.

4. **`piCoderMode` and `stateMachine` are exported** — other files may import them. The extraction must preserve these exports in `index.ts`.

5. **Circular dependency risk:** If extracted handlers import from `index.ts` while `index.ts` imports from handler files, this creates a cycle. Solution: pass dependencies via parameters (dependency injection pattern) or create a shared state module.

---

## Start Here

Open `/home/twsowerby/Documents/projects/pi-extensions-v2/pi-coder-v1/extensions/index.ts` at line 408 (the `piCoderExtension` factory). All 9 extraction targets are within this function. The key design decision is whether to:
- **(A)** Create a shared `HandlerContext` object holding all module-level state, pass it to each extracted handler/command
- **(B)** Keep module-level state in `index.ts` and have extracted files import it (risks circular deps)
- **(C)** Move module-level state to a separate `state.ts` module that both `index.ts` and extracted files import
