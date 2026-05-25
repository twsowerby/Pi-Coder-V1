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
  unlink,
  readdir,
  mkdir,
} from "node:fs/promises";
import type { SpecFile, ImplementationUnit } from "./types.ts";

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

  const base = slug || "spec";

  if (!existingSpecs.includes(base)) return base;

  let counter = 2;
  while (existingSpecs.includes(`${base}-${counter}`)) {
    counter++;
  }
  return `${base}-${counter}`;
}

// ---------------------------------------------------------------------------
// Phase 2: Spec File Operations
// ---------------------------------------------------------------------------

/**
 * Manages spec files in a `.pi-coder/specs/` directory.
 *
 * Each spec is stored as `{dir}/{id}.md` — Markdown with YAML frontmatter.
 */
export class SpecManager {
  private readonly specsDir: string;

  constructor(specsDir: string) {
    this.specsDir = specsDir;
  }

  /**
   * Create a spec file. Serializes the SpecFile to Markdown + YAML frontmatter.
   * Returns the file path.
   */
  async createSpec(spec: SpecFile): Promise<string> {
    await mkdir(this.specsDir, { recursive: true });

    const content = serializeSpec(spec);
    const filePath = join(this.specsDir, `${spec.id}.md`);
    await writeFile(filePath, content, "utf-8");
    return filePath;
  }

  /**
   * Read a spec file by ID. Returns null if the file doesn't exist.
   */
  async readSpec(specId: string): Promise<SpecFile | null> {
    const filePath = join(this.specsDir, `${specId}.md`);
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
    const filePath = join(this.specsDir, `${specId}.md`);
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
    const filePath = join(this.specsDir, `${specId}.md`);
    await writeFile(filePath, content, "utf-8");
  }

  /**
   * Delete a spec file. No-op if the file doesn't exist.
   */
  async deleteSpec(specId: string): Promise<void> {
    const filePath = join(this.specsDir, `${specId}.md`);
    try {
      await unlink(filePath);
    } catch (err: unknown) {
      if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
        return; // Already gone — no error
      }
      throw err;
    }
  }

  /**
   * List all spec IDs in the specs directory (filename stems of .md files).
   */
  async listSpecs(): Promise<string[]> {
    try {
      const entries = await readdir(this.specsDir);
      return entries
        .filter((e) => e.endsWith(".md"))
        .map((e) => e.slice(0, -3)) // Remove .md
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
      const deps = unit.dependsOn.length > 0 ? ` (depends on: ${unit.dependsOn.join(", ")})` : "";
      lines.push(`- **${unit.name}** [${acRefs}]${deps}`);
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
 *   - **Unit Name** [AC1, AC2] (depends on: Other Unit)
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

  // Match unit lines: - **Name** [AC1, AC2] or - **Name** [AC1, AC2] (depends on: X, Y)
  const unitRegex = /^- \*\*(.+?)\*\*\s*\[([^\]]+)\](?:\s*\(depends on: (.+?)\))?$/gm;
  let unitMatch: RegExpExecArray | null;

  while ((unitMatch = unitRegex.exec(section)) !== null) {
    const name = unitMatch[1].trim();
    const acRefs = unitMatch[2].split(",").map((s) => {
      const num = s.trim().replace(/^AC/, "");
      return parseInt(num, 10) - 1; // Convert AC1 → index 0
    }).filter((n) => !isNaN(n));
    const dependsOn = unitMatch[3]
      ? unitMatch[3].split(",").map((s) => s.trim())
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

    units.push({
      name,
      acceptanceCriteriaIndices: acRefs,
      keyFiles,
      dependsOn,
    });
  }

  return units;
}

/**
 * Escape special regex characters in a string.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
