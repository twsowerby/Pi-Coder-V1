# Spec 03: Worker Output

## Status: ✅ COMPLETE

All 3 phases implemented and verified. 30 tests pass.

---

## Phase 1: Spec ID Generation ✅

### Implementation
- `generateSpecId(userRequest, existingSpecs)` in `src/spec.ts`
- Slugifies: lowercase → replace non-alphanumeric runs with hyphens → trim leading/trailing hyphens → truncate to 40 chars
- Defaults to `"spec"` for empty / special-char / whitespace-only requests
- Collision handling: appends `-2`, `-3`, etc. incrementing counter

### Tests (14)
- Normal slugification, lowercase, non-alphanumeric replacement, leading/trailing hyphen trim
- 40-char truncation, empty string → "spec", special chars → "spec", whitespace → "spec"
- Collision with -2 suffix, multiple collisions, collision with "spec" default, no collision (no suffix)
- Mixed alphanumeric (OAuth2, v3)

---

## Phase 2: Spec File Operations ✅

### Implementation
- `SpecManager` class in `src/spec.ts` with:
  - `createSpec(spec)` — serializes to Markdown + YAML frontmatter, writes to `{specsDir}/{id}.md`
  - `readSpec(specId)` — parses frontmatter + body sections back to SpecFile, returns null if missing
  - `updateSpec(specId, partialUpdates)` — reads, merges, writes back. Throws if spec not found
  - `deleteSpec(specId)` — removes file. No-op if missing
  - `listSpecs()` — returns sorted .md filename stems
  - `readSpecRaw(specId)` — internal helper for test inspection

### File Format
```markdown
---
id: user-authentication
status: DRAFTING_SPEC
created: 2026-05-25T10:00:00.000Z
---

# User Authentication

## Acceptance Criteria
- [ ] Users can sign up
- [ ] Users can log in

## Constraints
- Must use bcrypt

## Key Files
- `src/auth.ts`

## Pruned Context
Research summary...
```

### Tests (13)
- createSpec: writes file, has YAML frontmatter, has structured body sections
- readSpec: returns null for missing, parses back to SpecFile
- updateSpec: merges partial updates, throws for nonexistent
- deleteSpec: removes file, no-op for nonexistent
- listSpecs: empty array, returns sorted IDs, only .md files

---

## Phase 3: Round-Trip Integrity ✅

### Tests (4)
- create→read: all fields match (id, title, acceptanceCriteria, constraints, keyFiles, prunedContext, status)
- update→read: updated fields changed, non-updated fields unchanged
- delete→read: returns null
- create→delete→list: deleted spec excluded from listing

---

## Test Results

```
30 tests, 8 suites, 0 failures
```

## All Acceptance Criteria Met

| Criterion | Status |
|---|---|
| Spec IDs are human-readable slugs derived from user request | ✅ |
| No two active specs share the same ID | ✅ |
| Edge cases (empty, special chars, duplicates) produce valid IDs | ✅ |
| Spec files created as valid Markdown with YAML frontmatter | ✅ |
| Specs read back into structured form without data loss | ✅ |
| Partial updates merge cleanly | ✅ |
| Cleanup removes spec files | ✅ |
| create→read round-trip preserves all data | ✅ |
| update→read shows changes, preserves others | ✅ |
| delete→read returns null | ✅ |
