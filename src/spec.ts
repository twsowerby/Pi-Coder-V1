/**
 * Spec File Management for Pi Coder v1.
 *
 * Handles spec ID generation and the `.pi-coder/specs/` file lifecycle —
 * create, read, update, delete, list. Spec files are stored as Markdown
 * with YAML frontmatter so they're human-readable and version-control-friendly.
 */

import { join } from "node:path";
import {
  readFile,
  writeFile,
  readdir,
  mkdir,
  rm,
  access,
} from "node:fs/promises";
import { accessSync } from "node:fs";
import type { SpecFile, ImplementationUnit, TestStrategy } from "./types.ts";

// ---------------------------------------------------------------------------
// Phase 1: Spec ID Generation
// ---------------------------------------------------------------------------

/**
 * Generate a unique spec ID from a user request string.
 *
 * Rules:
 * - Lowercase, replace non-alphanumeric runs with a single hyphen
 * - Trim leading/trailing hyphens
 * - Truncate to 40 characters
 * - Default to "spec" for empty/all-special-char requests
 * - Append -2, -3, etc. on collision with existing spec IDs
 */
export function generateSpecId(
  userRequest: string,
  existingSpecs: string[],
): string {
  const slug = userRequest
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

  const name = slug || "spec";

  // Timestamp prefix: YYYY-MM-DD-HHmm — prevents duplicate names,
  // gives natural chronological ordering
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;

  const id = `${timestamp}-${name}`;

  if (!existingSpecs.includes(id)) return id;

  let counter = 2;
  while (existingSpecs.includes(`${id}-${counter}`)) {
    counter++;
  }
  return `${id}-${counter}`;
}

// ---------------------------------------------------------------------------
// Phase 2: Spec File Operations
// ---------------------------------------------------------------------------

/**
 * Manages spec files in a `.pi-coder/specs/` directory.
 *
 * Each spec is stored as a directory containing:
 * - `spec.md` — Markdown with YAML frontmatter (human-readable)
 * - `state.json` — FSM state, evidence flags, git ref (machine-readable)
 */
export class SpecManager {
  private readonly _specsDir: string;

  /** The specs directory path (e.g., .pi-coder/specs/). */
  get specsDir(): string { return this._specsDir; }

  constructor(specsDir: string) {
    this._specsDir = specsDir;
  }

  /** Get the directory path for a spec ID. */
  getSpecDir(specId: string): string {
    return join(this._specsDir, specId);
  }

  /** Check if a spec directory exists. */
  specDirExists(specId: string): boolean {
    // Sync check — used in integrity validation
    try {
      accessSync(join(this._specsDir, specId));
      return true;
    } catch {
      return false;
    }
  }

  /** Async version of specDirExists. */
  async specDirExistsAsync(specId: string): Promise<boolean> {
    try {
      await access(join(this._specsDir, specId));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Initialize a spec directory early (on SPEC_WORK entry).
   * Creates the directory + request.md + empty state so that
   * crashes mid-spec-work don't lose the user's original request.
   * Returns the spec directory path.
   */
  async initSpecDir(specId: string, userRequest: string): Promise<string> {
    const specDir = this.getSpecDir(specId);
    await mkdir(specDir, { recursive: true });

    // Write the user's original request
    const requestPath = join(specDir, "request.md");
    await writeFile(requestPath, userRequest, "utf-8");

    return specDir;
  }

  /**
   * Save (or overwrite) the user's original request.
   * Useful if the request is refined across multiple research rounds.
   */
  async saveRequest(specId: string, userRequest: string): Promise<void> {
    const requestPath = join(this.getSpecDir(specId), "request.md");
    await writeFile(requestPath, userRequest, "utf-8");
  }

  /**
   * Read the user's original request. Returns null if not found.
   */
  async readRequest(specId: string): Promise<string | null> {
    const requestPath = join(this.getSpecDir(specId), "request.md");
    try {
      return await readFile(requestPath, "utf-8");
    } catch (err: unknown) {
      if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw err;
    }
  }

  /**
   * Create a spec file. Serializes the SpecFile to Markdown + YAML frontmatter.
   * Returns the file path.
   */
  async createSpec(spec: SpecFile): Promise<string> {
    const specDir = this.getSpecDir(spec.id);
    await mkdir(specDir, { recursive: true });

    const content = serializeSpec(spec);
    const filePath = join(specDir, "spec.md");
    await writeFile(filePath, content, "utf-8");
    return filePath;
  }

  /**
   * Read a spec file by ID. Returns null if the file doesn't exist.
   */
  async readSpec(specId: string): Promise<SpecFile | null> {
    const filePath = join(this.getSpecDir(specId), "spec.md");
    try {
      const content = await readFile(filePath, "utf-8");
      return parseSpec(content);
    } catch (err: unknown) {
      if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw err;
    }
  }

  /**
   * Raw file content reader (for testing frontmatter format).
   * @internal
   */
  async readSpecRaw(specId: string): Promise<string> {
    const filePath = join(this.getSpecDir(specId), "spec.md");
    return readFile(filePath, "utf-8");
  }

  /**
   * Update a spec by merging partial updates, then writing back.
   * Throws if the spec doesn't exist.
   */
  async updateSpec(specId: string, updates: Partial<SpecFile>): Promise<void> {
    const existing = await this.readSpec(specId);
    if (!existing) {
      throw new Error(`Spec "${specId}" not found`);
    }
    const merged: SpecFile = { ...existing, ...updates };
    const content = serializeSpec(merged);
    const filePath = join(this.getSpecDir(specId), "spec.md");
    await writeFile(filePath, content, "utf-8");
  }

  /**
   * Delete a spec directory. No-op if the directory doesn't exist.
   */
  async deleteSpec(specId: string): Promise<void> {
    const specDir = this.getSpecDir(specId);
    try {
      await rm(specDir, { recursive: true, force: true });
    } catch (err: unknown) {
      if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
        return; // Already gone — no error
      }
      throw err;
    }
  }

  /**
   * Check if a spec directory exists but has no spec.md (i.e., abandoned).
   * Returns specId if abandoned, null if not.
   */
  isAbandoned(specId: string): boolean {
    if (!this.specDirExists(specId)) return false;
    try {
      accessSync(join(this.getSpecDir(specId), "spec.md"));
      return false; // spec.md exists — not abandoned
    } catch {
      return true; // Directory exists but no spec.md
    }
  }

  /**
   * List all spec IDs in the specs directory (subdirectory names).
   */
  async listSpecs(): Promise<string[]> {
    try {
      const entries = await readdir(this._specsDir, { withFileTypes: true });
      return entries
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();
    } catch (err: unknown) {
      if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

/**
 * Serialize a SpecFile to Markdown with YAML frontmatter.
 *
 * Format:
 * ---
 * id: user-authentication
 * status: SPEC_WORK
 * created: 2026-05-25T10:00:00.000Z
 * ---
 *
 * # User Authentication
 *
 * ## Acceptance Criteria
 * - [ ] AC1
 * - [ ] AC2
 *
 * ## Constraints
 * - Constraint 1
 *
 * ## Key Files
 * - `src/auth.ts`
 *
 * ## Pruned Context
 * Research summary...
 */
function serializeSpec(spec: SpecFile): string {
  const lines: string[] = [];

  // Frontmatter
  lines.push("---");
  lines.push(`id: ${spec.id}`);
  lines.push(`status: ${spec.status}`);
  lines.push(`created: ${new Date().toISOString()}`);
  lines.push("---");
  lines.push("");

  // Title
  lines.push(`# ${spec.title}`);
  lines.push("");

  // Acceptance Criteria
  lines.push("## Acceptance Criteria");
  for (const ac of spec.acceptanceCriteria) {
    lines.push(`- [ ] ${ac}`);
  }
  lines.push("");

  // Constraints
  lines.push("## Constraints");
  for (const c of spec.constraints) {
    lines.push(`- ${c}`);
  }
  lines.push("");

  // Key Files
  lines.push("## Key Files");
  for (const f of spec.keyFiles) {
    lines.push(`- \`${f}\``);
  }
  lines.push("");

  // Implementation Plan
  if (spec.implementationPlan.length > 0) {
    lines.push("## Implementation Plan");
    for (const unit of spec.implementationPlan) {
      const acRefs = unit.acceptanceCriteriaIndices.map((i) => `AC${i + 1}`).join(", ");
      const strategyStr = unit.testStrategy ? ` (strategy: ${unit.testStrategy})` : "";
      const rationaleStr = unit.testStrategyRationale ? ` — ${unit.testStrategyRationale}` : "";
      const suiteStr = unit.testSuite ? ` (suite: ${unit.testSuite})` : "";
      const deps = unit.dependsOn.length > 0 ? ` (depends on: ${unit.dependsOn.join(", ")})` : "";
      lines.push(`- **${unit.name}** [${acRefs}]${strategyStr}${rationaleStr}${suiteStr}${deps}`);
      for (const f of unit.keyFiles) {
        lines.push(`  - \`${f}\``);
      }
    }
    lines.push("");
  }

  // Pruned Context
  lines.push("## Pruned Context");
  lines.push(spec.prunedContext);
  lines.push("");

  return lines.join("\n");
}

/**
 * Parse a Markdown spec file back into a SpecFile.
 */
function parseSpec(content: string): SpecFile {
  // Extract frontmatter
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatterMatch) {
    throw new Error("Spec file missing YAML frontmatter");
  }

  const frontmatter = frontmatterMatch[1];
  const idMatch = frontmatter.match(/^id:\s*(.+)$/m);
  const statusMatch = frontmatter.match(/^status:\s*(.+)$/m);

  if (!idMatch || !statusMatch) {
    throw new Error("Spec file frontmatter missing id or status");
  }

  const id = idMatch[1].trim();
  const status = statusMatch[1].trim();

  // Extract title from first heading
  const titleMatch = content.match(/^# (.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : id;

  // Extract sections
  const acceptanceCriteria = extractListSection(content, "## Acceptance Criteria", true);
  const constraints = extractListSection(content, "## Constraints", false);
  const keyFiles = extractCodeListSection(content, "## Key Files");
  const implementationPlan = extractImplementationPlan(content);
  const prunedContext = extractTextSection(content, "## Pruned Context");

  return {
    id,
    title,
    acceptanceCriteria,
    constraints,
    keyFiles,
    prunedContext,
    implementationPlan,
    status: status as SpecFile["status"],
  };
}

/**
 * Extract a list section (e.g., Acceptance Criteria, Constraints).
 * For AC, strips "- [ ] " prefix. For others, strips "- " prefix.
 */
function extractListSection(content: string, heading: string, isCheckbox: boolean): string[] {
  const regex = new RegExp(
    `${escapeRegex(heading)}\\n((?:\\s*- (?:\\[ \\] )?.+\\n)*)`,
    "m"
  );
  const match = content.match(regex);
  if (!match) return [];

  const prefix = isCheckbox ? /- \[ \] / : /- /;
  return match[1]
    .trim()
    .split("\n")
    .map((line) => line.trim().replace(prefix, ""))
    .filter(Boolean);
}

/**
 * Extract a list of code-quoted items (Key Files section).
 */
function extractCodeListSection(content: string, heading: string): string[] {
  const regex = new RegExp(
    `${escapeRegex(heading)}\\n((?:\\s*- \`.+\`\\n)*)`,
    "m"
  );
  const match = content.match(regex);
  if (!match) return [];

  return match[1]
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^- `/, "").replace(/`$/, ""));
}

/**
 * Extract a plain text section (e.g., Pruned Context).
 * Reads until the next heading or end of file.
 */
function extractTextSection(content: string, heading: string): string {
  const regex = new RegExp(
    `${escapeRegex(heading)}\\n([\\s\\S]*?)(?=\\n## |$)`,
    "m"
  );
  const match = content.match(regex);
  if (!match) return "";

  return match[1].trim();
}

/**
 * Extract the Implementation Plan section from a spec file.
 *
 * Format:
 *   - **Unit Name** [AC1, AC2] (strategy: tdd|verify|skip) (depends on: Other Unit)
 *     - `path/to/file.ts`
 *
 * Returns an array of ImplementationUnit objects.
 */
function extractImplementationPlan(content: string): ImplementationUnit[] {
  const heading = "## Implementation Plan";
  // No 'm' flag — $ matches end-of-string only.
  // The Implementation Plan is always followed by Pruned Context, but
  // we include $ as fallback when it's the last section.
  const sectionRegex = new RegExp(
    `${escapeRegex(heading)}\\n([\\s\\S]*?)(?=\\n## |$)`,
  );
  const sectionMatch = content.match(sectionRegex);
  if (!sectionMatch) return [];

  const section = sectionMatch[1].trim();
  const units: ImplementationUnit[] = [];

  // Match unit lines: - **Name** [AC1, AC2] optionally (strategy: tdd|verify|skip) optionally (depends on: X, Y)
  // The strategy and depends-on can appear in any order after the AC refs
  const unitRegex = /^- \*\*(.+?)\*\*\s*\[([^\]]+)\](.*)$/gm;
  let unitMatch: RegExpExecArray | null;

  while ((unitMatch = unitRegex.exec(section)) !== null) {
    const name = unitMatch[1].trim();
    const acRefs = unitMatch[2].split(",").map((s) => {
      const num = s.trim().replace(/^AC/, "");
      return parseInt(num, 10) - 1; // Convert AC1 → index 0
    }).filter((n) => !isNaN(n));
    const trailing = unitMatch[3] ?? "";

    // Extract testSuite from trailing string
    const suiteMatch = trailing.match(/\(suite:\s*(\w+)\)/i);
    const testSuite = suiteMatch ? suiteMatch[1].toLowerCase() : undefined;

    // Extract dependsOn from trailing string
    const dependsOnMatch = trailing.match(/\(depends on:\s*(.+?)\)/);
    const dependsOn = dependsOnMatch
      ? dependsOnMatch[1].split(",").map((s) => s.trim())
      : [];

    // Find indented key files below this unit (stop at next unit line)
    const afterUnit = section.substring(unitMatch.index + unitMatch[0].length);
    const afterLines = afterUnit.split("\n");
    const keyFileLines: string[] = [];
    for (const line of afterLines) {
      if (/^- \*\*/.test(line.trim())) break; // Next unit found — stop
      if (/^\s+- `/.test(line)) keyFileLines.push(line);
    }
    const keyFiles = keyFileLines
      .map((line) => line.trim().replace(/^- `/, "").replace(/`$/, ""))
      .filter(Boolean);

    const unit: ImplementationUnit = {
      name,
      acceptanceCriteriaIndices: acRefs,
      keyFiles,
      dependsOn,
      testStrategy: "tdd", // default; may be overwritten by strategy match below
    };

    // Parse strategy field
    const strategyMatch = trailing.match(/\(strategy:\s*(tdd|verify|skip)\)/i);
    if (strategyMatch) {
      unit.testStrategy = strategyMatch[1].toLowerCase() as TestStrategy;
    } else {
      // No strategy found — default to tdd
      unit.testStrategy = "tdd";
    }

    // Rationale extraction
    const rationaleMatch = trailing.match(/—\s*(.+?)(?:\s*\(|$)/);
    if (rationaleMatch) {
      unit.testStrategyRationale = rationaleMatch[1].trim();
    }

    if (testSuite) {
      unit.testSuite = testSuite;
    }
    units.push(unit);
  }

  return units;
}

/**
 * Escape special regex characters in a string.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
