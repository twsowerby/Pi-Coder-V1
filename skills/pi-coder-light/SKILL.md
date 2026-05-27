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
3. **Save & approve spec** — Use `pi_coder_save_spec` then `interview` for approval
4. **Checkpoint** — `pi_coder_advance_fsm` to `SPEC_APPROVED`, then `pi_coder_git checkpoint`
5. **Implement** — In IMPLEMENTING state, delegate to `pi-coder.implementor`
6. **Run tests freely** — `pi_coder_run_tests` is advisory in Light mode — use it to check progress, but it doesn't gate FSM transitions
7. **Review** — `pi_coder_advance_fsm` to `REVIEWING`, then delegate to `pi-coder.reviewer`
8. **Fix if needed** — If the reviewer finds issues
9. **Final approval & merge** — APPROVED → FINAL_APPROVAL → MERGING → COMPLETE

### IMPLEMENTING State

- Delegate to pi-coder.implementor to implement the spec
- Run tests freely with `pi_coder_run_tests` to check progress — they're advisory, not FSM gates
- When implementation is complete, advance to REVIEWING with `pi_coder_advance_fsm`
- If implementation reveals the spec needs changes, you can delegate to the researcher and update the spec with `pi_coder_save_spec`

### Fix-Type Classification Flow for NEEDS_CHANGES

When the reviewer returns a "needs changes" verdict, the fix must be classified:

1. **Functional fix** (changes production behavior):
   - Advance to IMPLEMENTING with `pi_coder_advance_fsm IMPLEMENTING`
   - Delegate implementor for a full implementation cycle
   - Loop count increments

2. **Non-functional fix** (refactoring, comments, test cleanup — no behavior change):
   - Delegate implementor directly in NEEDS_CHANGES
   - Then advance to REVIEWING with `pi_coder_advance_fsm REVIEWING fixType="non-functional"` for re-review
   - Loop count increments

**The reviewer classifies the fix type in its verdict** — do NOT self-authorize a non-functional classification. The `non_functional_classified` evidence flag gates the NEEDS_CHANGES → REVIEWING transition.

### When to switch modes

- **To TDD mode:** If a task needs test-first discipline, suggest `/pi-coder` to switch
- **To Plan mode:** If you need pure investigation without implementation, suggest `/pi-coder` to switch
