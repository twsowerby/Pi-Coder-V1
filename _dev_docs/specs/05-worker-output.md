# Spec 05: Worker Output — Knowledge System

## Status: ✅ COMPLETE

Both phases implemented and verified.

---

## Phase 1: File Operations ✅

### Implementation (`src/knowledge.ts`)

`KnowledgeStore` class with:
- `upsert(filename, content)` — validates filename, creates directory if missing, writes raw markdown, returns full file path
- `read(filename)` — returns file content as string, or null if not found
- `list()` — returns `.md` filenames only (no paths), sorted alphabetically, graceful empty array for missing dir
- `exists(filename)` — boolean check for file existence

### Tests (4 suites, 15 tests)
- upsert: creates file, overwrites existing, creates missing directory, returns path
- read: returns content, returns null for missing
- list: lists .md files, only filenames not paths, empty for empty dir, empty for missing dir, filters non-.md files
- exists: true when present, false when missing

---

## Phase 2: Naming Safety ✅

### Implementation

`validateFilename()` function enforcing:
- Must end in `.md`
- Stem (before `.md`) 3-50 chars, lowercase alphanumeric + hyphens only
- No path separators (`/`, `\`), no `..` traversal, no absolute paths (Unix or Windows)
- Error messages include all naming rules so the orchestrator can correct and retry

### Tests (3 suites, 10 tests)
- Validation: accepts valid names (3-char min, 50-char max, hyphens, numbers), rejects no .md extension, stem < 3 chars, stem > 50 chars, uppercase, spaces, underscores
- Path traversal: rejects `../`, nested `sub/dir/`, absolute `/etc/`, Windows `C:\`
- Error messages: include naming rules in validation errors

---

## Test Results

```
25 tests, 8 suites, 0 failures
```

## Additional Changes

- Added `@types/node` as devDependency (required for typecheck)
- Added `"types": ["node"]` to `tsconfig.json` (required for `node:fs` / `node:path` imports)

## All Acceptance Criteria Met

| Criterion | Status |
|---|---|
| Knowledge files can be written, read, listed, checked for existence | ✅ |
| Knowledge directory is created on first write if it doesn't exist | ✅ |
| Listing returns only filenames (not paths) | ✅ |
| Content is written as-is (raw markdown) | ✅ |
| Filenames validated: .md, 3-50 char stem, lowercase alphanumeric + hyphens | ✅ |
| Path traversal rejected with descriptive error | ✅ |
| Non-.md rejected with naming rules | ✅ |
| Error messages include naming rules | ✅ |
