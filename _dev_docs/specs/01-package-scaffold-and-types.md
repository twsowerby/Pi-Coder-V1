# Spec 01: Package Scaffold & Type Definitions

## Context

Everything else builds on this. The package must be a valid pi-package that pi can discover and load. All shared types that later specs import must be defined here so they can develop in parallel without circular dependencies.

## Dependencies

None — foundation spec.

---

## Phase 1: Package Setup

### Acceptance Criteria

- `npm install` completes without errors in the package directory
- pi recognizes the package as a valid pi-package (via `keywords: ["pi-package"]`)
- TypeScript compiles with strict mode enabled

### Tasks

1. Create `package.json` with pi-package keywords, peer dependencies on `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, and `typebox`, and a `pi` manifest declaring extensions and skills entry points
2. Create `tsconfig.json` with strict mode, ES module output, and includes covering `src/` and `extensions/`
3. Create the directory structure: `src/`, `extensions/`, `agents/`, `skills/pi-coder/`
4. Verify `npm install` and `npx tsc --noEmit` both succeed

---

## Phase 2: FSM & State Types

### Acceptance Criteria

- All FSM state names are defined in a single union type
- The transition table can be type-checked — illegal transitions are caught at compile time
- Config types match the `.pi-coder/config.json` schema exactly

### Tasks

1. Define `FSMState` as a union of all 16 state literal strings (IDLE through COMPLETE plus BLOCKED)
2. Define `FSMTransition` as a structure pairing a source state, target state, and event name
3. Define `PiCoderConfig` covering testCommand, maxLoops, gitStrategy, branchPrefix, and the nudge configuration
4. Define `NudgeConfig` with enabled flag, defaults (turnsBeforeNudge, escalationLevels), and per-state overrides
5. Export all types from `src/types.ts`

---

## Phase 3: Domain Value Types

### Acceptance Criteria

- Test results, git results, spec files, and knowledge entries each have a typed structure
- All types are serializable to plain JSON (for `appendEntry` persistence)

### Tasks

1. Define `TestRunResult` with exitCode, output (truncated), passed count, failed count, and timedOut flag
2. Define `GitCheckpointResult` with success flag, ref, branch, message, and error
3. Define `SpecFile` with id, title, acceptanceCriteria, constraints, keyFiles, prunedContext, and status
4. Define `KnowledgeEntry` as a simple filename + content pair (the file IS the storage format)

---

## Phase 4: Verification

### Acceptance Criteria

- All types compile with no errors
- A later spec can import from `src/types.ts` and get full type inference

### Tasks

1. Create a dummy import file that references every exported type, compile it, then delete it — proves the types are reachable and valid
2. Remove the monolithic `specs.md` file if it still exists (replaced by these individual spec files)
