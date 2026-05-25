# Spec 05: Knowledge System

## Context

The knowledge store is how pi-coder accumulates project-specific learnings across spec cycles. When an implementor discovers a gotcha or a reviewer identifies a recurring mistake, the orchestrator persists it here. Future researcher and implementor agents read these files to avoid repeating errors.

## Dependencies

Spec 01 (type definitions)

---

## Phase 1: File Operations

### Acceptance Criteria

- Knowledge files can be written, read, listed, and checked for existence
- The knowledge directory is created on first write if it doesn't exist
- Listing returns only the filenames, not full paths, for easy inclusion in subagent briefs

### Tasks

1. Implement `upsert(filename, content)` that writes a knowledge file to the knowledge directory — creates the directory if it doesn't exist, overwrites if the file already exists, returns the file path on success
2. Implement `read(filename)` that returns the file content as a string, or null if the file doesn't exist
3. Implement `list()` that returns all `.md` filenames in the knowledge directory, and `exists(filename)` that returns a boolean
4. Content is written as-is — raw markdown with no transformation or wrapping

---

## Phase 2: Naming Safety

### Acceptance Criteria

- Filenames are descriptive and human-readable (enforced by validation)
- Path traversal and non-markdown files are rejected
- Rejection errors include the naming rules so the orchestrator can correct and retry

### Tasks

1. Validate filenames: must end in `.md`, the stem must be 3-50 characters of lowercase alphanumeric and hyphens only
2. Reject path traversal attempts (e.g., `../`, absolute paths, nested directories) — throw a descriptive error listing the naming rules
3. Reject filenames that don't end in `.md` — throw with the rule that knowledge files must be markdown
