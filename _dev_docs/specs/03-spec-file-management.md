# Spec 03: Spec File Management

## Context

Specs are the unit of work in pi-coder. Each TDD cycle is driven by a spec file that captures the acceptance criteria, constraints, and pruned context for a piece of work. Spec files live in `.pi-coder/specs/` and are created, read, updated, and cleaned up throughout the lifecycle.

## Dependencies

Spec 01 (type definitions — SpecFile type)

---

## Phase 1: Spec ID Generation

### Acceptance Criteria

- Spec IDs are human-readable slugs derived from the user's request
- No two active specs share the same ID
- Edge cases (empty requests, very long requests, duplicate slugs) produce valid IDs

### Tasks

1. Implement `generateSpecId(userRequest, existingSpecs)` that slugifies the request text — lowercase, replace non-alphanumeric runs with hyphens, trim leading/trailing hyphens, truncate to 40 characters
2. Handle slug collisions by appending an incrementing counter suffix starting at 2 (e.g., `user-auth-2`, `user-auth-3`)
3. Handle edge cases: empty request defaults to `"spec"`, request with only special characters produces `"spec"`, and the counter continues up from any existing collisions

---

## Phase 2: Spec File Operations

### Acceptance Criteria

- Spec files are created as valid Markdown with YAML frontmatter
- Specs can be read back into their structured form without data loss
- Partial updates merge cleanly onto existing content
- Cleanup removes spec files after completion

### Tasks

1. Implement `createSpec(spec)` that serializes a SpecFile to Markdown with YAML frontmatter (id, status, created date) and structured body sections (Acceptance Criteria, Constraints, Key Files, Pruned Context), writing to `{specsDir}/{spec.id}.md`
2. Implement `readSpec(specId)` that parses the Markdown frontmatter and body sections back into a SpecFile, returning null if the file doesn't exist
3. Implement `updateSpec(specId, partialUpdates)` that reads the existing spec, merges the partial updates into the structured data, and writes the file back
4. Implement `deleteSpec(specId)` and `listSpecs()` — delete removes the file, list returns all spec IDs found in the specs directory as filename stems

---

## Phase 3: Round-Trip Integrity

### Acceptance Criteria

- A spec that is created and then read produces the same structured data
- Updated fields appear correctly after a read
- Deleted specs return null on read

### Tasks

1. Verify create→read round-trip for a spec with all fields populated — parsed result matches the original SpecFile
2. Verify update→read round-trip — updated fields appear, non-updated fields are unchanged
3. Verify delete→read returns null
