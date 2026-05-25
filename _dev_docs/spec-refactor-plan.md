# Directory-Based Spec Model — Implementation Plan

## Summary of Changes

### New model
```
.pi-coder/
  state.json                    ← GLOBAL: { piCoderActive, activeSpecId, updatedAt }
  config.json
  knowledge/
  logs/
  specs/
    ux-tweaks/
      spec.md                   ← human-readable spec content
      state.json                ← PER-SPEC: FSM state + evidence + git ref
    daily-planner/
      spec.md
      state.json
```

### Old model
```
.pi-coder/
  state.json                    ← { piCoderActive, fsm: { currentState, activeSpecId, loopCount, gitRef } }
  specs/
    ux-tweaks.md                ← flat file
```

---

## Files to modify (in dependency order)

### 1. `src/types.ts`
- Add `EvidenceFlag` type
- Add `SpecState` interface (per-spec state.json shape)
- Add `GlobalState` interface (global state.json shape — rename from what StatePersistence uses)

### 2. `src/state-machine.ts`
- Add `evidence` Set<EvidenceFlag> to StateMachine
- Add `setEvidence(flag)` / `hasEvidence(flag)` / `clearEvidence(flags)` methods
- Add TRANSITION_GUARDS table — evidence required for specific transitions
- Modify `transition()` to check evidence guards BEFORE allowing transition
  - Return structured error with missing evidence
- Remove `activeSpecId` from StateMachine entirely — it moves to per-spec state
- `StateMachineJSON` changes: replace `activeSpecId` with nothing (or keep as
  read-only accessor that reads from the spec state, not stored in SM)
  
  Wait — `activeSpecId` is used extensivley in the extension for logging,
  UI display, git branch names. It needs to live somewhere accessible.
  
  Decision: `activeSpecId` moves to the GLOBAL state. The StateMachine
  doesn't own it. The extension reads/writes it through the global state
  persistence. But the StateMachine still needs to know the spec ID for
  transition guards (spec_saved = activeSpecId is set in global state).
  
  Simpler: Keep `activeSpecId` on StateMachine but it's set/cleared by the
  extension, not persisted inside the StateMachine's own JSON. The
  StateMachine's `toJSON()` still includes it for backward compat with
  per-spec state.json.
  
  Actually — let me think again. The per-spec state.json needs:
  - currentState, loopCount, gitRef, evidence
  The global state.json needs:
  - piCoderActive, activeSpecId, updatedAt
  The StateMachine currently holds: currentState, activeSpecId, loopCount, gitRef
  
  Cleanest: StateMachine keeps activeSpecId, but it's set by the extension
  (when global state loads, when pi_coder_save_spec is called). The
  StateMachine's toJSON/fromJSON is used for per-spec state.json. The
  global persistence layer reads activeSpecId from StateMachine and writes
  it to global state.json separately.

  Actually that's messy. Let me think differently:
  
  **StateMachine** owns: currentState, loopCount, gitRef, evidence
  **Global state** owns: piCoderActive, activeSpecId
  **Per-spec state** owns: currentState, loopCount, gitRef, evidence
  
  When a spec is active, the StateMachine IS the in-memory representation
  of that spec's state. When a spec completes, its state is the last
  write to per-spec state.json and the global pointer clears.
  
  activeSpecId on StateMachine: it's useful for guards (spec_saved check).
  But with evidence flags, spec_saved is just an evidence flag. We don't
  need activeSpecId on the StateMachine for guard purposes — we check
  `hasEvidence("spec_saved")` instead.
  
  But we DO need activeSpecId for:
  - Git branch names (pi_coder_git)
  - UI display (refreshUI)
  - Log events
  - Spec file paths
  
  All of these are extension concerns, not StateMachine concerns.
  
  **Decision:** Remove `activeSpecId` from `StateMachine`. Move it to a
  module-level variable in the extension (alongside `piCoderActive`).
  This is cleaner — the StateMachine doesn't care about which spec it's
  tracking, only about the FSM state and evidence.

### 3. `src/spec.ts` — SpecManager
- Change `createSpec` to write `{specsDir}/{id}/spec.md` instead of `{specsDir}/{id}.md`
- Change `readSpec` to read from `{specsDir}/{id}/spec.md`
- Change `updateSpec` to write to `{specsDir}/{id}/spec.md`
- Change `deleteSpec` to remove the directory (or just the spec.md)
- Change `listSpecs` to list subdirectories instead of .md files
- Add `getSpecDir(specId)` method — returns the spec directory path
- Add `specDirExists(specId)` method — checks if the directory exists

### 4. `src/state-persistence.ts` — Split into two classes
- `GlobalStatePersistence` — reads/writes `.pi-coder/state.json` (slim: piCoderActive, activeSpecId)
- `SpecStatePersistence` — reads/writes `.pi-coder/specs/{id}/state.json` (FSM + evidence)
- Old `StatePersistence` deleted or repurposed
- `PersistedState` type replaced by `GlobalState` type
- `PersistedFSM` replaced by per-spec state type from types.ts
- Integrity checks: global checks that `.pi-coder/specs/{activeSpecId}/` exists
  per-spec checks that spec.md exists alongside state.json

### 5. `src/tools.ts`
- Remove SPEC_WORK→SPEC_APPROVED guard from advance_fsm (moved to StateMachine transition guards)
- Remove post-spec-states guard from advance_fsm (moved to StateMachine)
- `pi_coder_save_spec`: set evidence("spec_saved") on StateMachine, set activeSpecId on global state
- `pi_coder_git checkpoint`: check `stateMachine.hasEvidence("spec_saved")` instead of `activeSpecId`
  (Actually, git needs the spec ID string for branch names, which comes from global state)
- `pi_coder_advance_fsm`: handle transition guard errors from StateMachine.transition()
  — the SM now returns structured errors with missing evidence

### 6. `extensions/index.ts` — The big one
- Module-level `activeSpecId` variable (moved from StateMachine)
- Module-level `globalStatePersistence` and `specStatePersistence`
- `persistState()` refactored:
  - Global: save { piCoderActive, activeSpecId }
  - Per-spec: save { currentState, loopCount, gitRef, evidence } to specs/{activeSpecId}/state.json
- `session_start` restore:
  - Load global state.json → set piCoderActive, activeSpecId
  - If activeSpecId is set, load per-spec state.json → restore StateMachine
  - Integrity: verify spec directory exists
- `pi_coder_save_spec` tool_result: set evidence("spec_saved"), set activeSpecId
- `interview` tool_result in SPEC_WORK: set evidence("spec_user_approved")
- `pi_coder_run_tests` tool_result: set evidence("test_run_this_state")
- State transitions: clear evidence("test_run_this_state") on any transition
- Review auto-transition: subagent tool_result in REVIEWING → APPROVED/NEEDS_CHANGES
- All `stateMachine.activeSpecId` references → module-level `activeSpecId`
- All `smRef.current.activeSpecId` → new getter that reads from module-level
- Init command: create specs/ directory (no change, it's already created)
- Reset command: no change needed

### 7. Tests
- `src/state-machine.test.ts` — add tests for evidence flags and transition guards
- `src/spec.test.ts` — update for directory-based model
- `src/state-persistence.test.ts` — split into global + per-spec tests
- `src/tools.test.ts` — transition guard errors instead of ad-hoc blocks
- `extensions/index.test.ts` — update for new state model
- `extensions/index-commands.test.ts` — verify init still creates correct structure
