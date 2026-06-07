---
name: pi-coder-light
description: Light mode implementation lifecycle — implementation delegation, review cycles, and fix classification. Load this skill ONLY when in Light mode.
---

# Pi Coder — Light Mode Procedures

This skill contains procedures specific to Light mode. For shared procedures (spec work, review, delegation templates, recovery), load `pi-coder-core`.

## Light Mode Implementation

In Light mode, a simplified FSM guides the lifecycle: spec → implement → review → merge. There are NO TDD RED/GREEN phases — you implement, then review.

**Key differences from TDD mode:**
- No RED/GREEN phases — IMPLEMENTING replaces all 4 TDD states
- `pi_coder_run_tests` is advisory, not FSM-gated
- The reviewer classifies fixes as functional or non-functional in its verdict

### How to work in Light mode:

1. **Start a cycle** — `pi_coder_advance_fsm` with targetState `SPEC_WORK`
2. **Research** — Delegate to `pi-coder.researcher` to understand the codebase
3. **Save & approve spec** — Use `pi_coder_save_spec` then `pi_coder_approve_spec` for approval
4. **Checkpoint** — `pi_coder_advance_fsm` to `SPEC_APPROVED`, then `pi_coder_advance_fsm` to `GIT_CHECKPOINT`, then `pi_coder_git checkpoint`. The FSM will auto-transition from GIT_CHECKPOINT to IMPLEMENTING on checkpoint success — do NOT call `pi_coder_advance_fsm` after the checkpoint.
5. **Implement** — In IMPLEMENTING state, delegate to `pi-coder.implementor` 1-2 units at a time (see IMPLEMENTING State section)
6. **Run tests freely** — `pi_coder_run_tests` is advisory in Light mode — use it to check progress, but it doesn't gate FSM transitions
7. **Review** — `pi_coder_advance_fsm` to `REVIEWING`, then delegate to `pi-coder.reviewer` (the auto-transition handler will advance to APPROVED or NEEDS_CHANGES based on the verdict)
8. **Fix if needed** — If the reviewer finds issues
9. **Final approval & merge** — APPROVED → MERGING → COMPLETE (direct path if user already approved via pi_coder_approve_final) or APPROVED → FINAL_APPROVAL → MERGING → COMPLETE (step-by-step)

### IMPLEMENTING State

1. Read the spec with `pi_coder_read_spec` to get the implementation plan
2. Start with unit 1 (or the first incomplete unit on re-entry after NEEDS_CHANGES)
3. Delegate 1-2 units at a time to `pi-coder.implementor` using the **Light mode delegation template** from `pi-coder-core` — NEVER delegate the entire spec at once
4. After each delegation, optionally checkpoint between units with `pi_coder_git checkpoint`
5. Re-read the spec with `pi_coder_read_spec` before the next delegation — ACs or constraints may have been adjusted
6. Repeat steps 3-5 until all units are complete
7. Then advance to REVIEWING with `pi_coder_advance_fsm`

Additional details:
- Run tests freely with `pi_coder_run_tests` to check progress — they're advisory, not FSM gates
- You can also delegate to `pi-coder.researcher` if you need to investigate something during implementation (e.g., clarify a pattern, find a dependency)
- If implementation reveals the spec needs changes, you can delegate to the researcher and update the spec with `pi_coder_save_spec`

### Fix Classification Flow for NEEDS_CHANGES

When the reviewer returns a "needs changes" verdict, the fix must be classified:

1. **Functional fix** (changes production behavior):
   - Advance to IMPLEMENTING with `pi_coder_advance_fsm IMPLEMENTING`
   - Delegate implementor for a full implementation cycle
   - Loop count increments

2. **Non-functional fix** (refactoring, comments, test cleanup — no behavior change):
   - Delegate implementor to apply the fix directly in NEEDS_CHANGES
   - Then advance to REVIEWING with `pi_coder_advance_fsm REVIEWING` — no evidence gate in Light mode
   - Loop count increments

**Verdict extraction failure recovery**: If the auto-transition didn't fire (you don't see an AUTO-TRANSITION notice after the reviewer, and instead see "⚠️ AUTO-TRANSITION FAILED"), read the review output yourself and manually advance with `pi_coder_advance_fsm` to APPROVED or NEEDS_CHANGES based on your reading of the review.

**The reviewer classifies the fix type in its verdict** — do NOT self-authorize a classification. The reviewer's `Fix-Type:` output guides your choice of path.

### When to switch modes

- **To TDD mode:** If a task needs test-first discipline, suggest `/pi-coder` to switch
- **To Plan mode:** If you need pure investigation without implementation, suggest `/pi-coder` to switch
