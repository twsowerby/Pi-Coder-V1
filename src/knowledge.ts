/**
 * Knowledge System — Spec 05
 *
 * Manages `.pi-coder/knowledge/` file operations for the upsert_knowledge tool.
 * Knowledge files are raw markdown that accumulate project-specific learnings
 * across TDD cycles.
 */

import { mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

/** Regex for a valid knowledge filename stem: 3-50 lowercase alphanumeric + hyphens */
const VALID_STEM = /^[a-z0-9-]{3,50}$/;

/**
 * Validates a knowledge filename against the naming rules.
 *
 * Rules:
 * - Must end in `.md`
 * - Stem (before `.md`) must be 3-50 characters of lowercase alphanumeric and hyphens only
 * - No path separators, traversal sequences, or absolute paths
 *
 * @throws Error with descriptive message listing the naming rules
 */
function validateFilename(filename: string): void {
  // Check for path separators and traversal
  if (filename.includes("/") || filename.includes("\\") || filename.includes("..")) {
    throw new Error(
      `Invalid knowledge filename "${filename}": path separators and traversal sequences are not allowed. ` +
      `Knowledge filenames must be simple filenames (no directories). ` +
      `Rules: must end in .md, stem must be 3-50 characters of lowercase alphanumeric and hyphens only.`,
    );
  }

  // Check for absolute paths (drive letters on Windows)
  if (/^[A-Za-z]:/.test(filename)) {
    throw new Error(
      `Invalid knowledge filename "${filename}": absolute paths are not allowed. ` +
      `Knowledge filenames must be simple filenames (no directories). ` +
      `Rules: must end in .md, stem must be 3-50 characters of lowercase alphanumeric and hyphens only.`,
    );
  }

  // Check .md extension
  if (!filename.endsWith(".md")) {
    throw new Error(
      `Invalid knowledge filename "${filename}": knowledge files must be markdown (end in .md). ` +
      `Rules: must end in .md, stem must be 3-50 characters of lowercase alphanumeric and hyphens only.`,
    );
  }

  // Extract and validate stem
  const stem = filename.slice(0, -3); // Remove ".md"
  if (!VALID_STEM.test(stem)) {
    const reasons: string[] = [];
    if (stem.length < 3 || stem.length > 50) {
      reasons.push(`stem must be 3-50 characters (got ${stem.length})`);
    }
    if (/[A-Z]/.test(stem)) {
      reasons.push("stem must be lowercase only");
    }
    if (/[^a-z0-9-]/.test(stem)) {
      reasons.push("stem must contain only lowercase alphanumeric characters and hyphens");
    }
    throw new Error(
      `Invalid knowledge filename "${filename}": ${reasons.join(", ")}. ` +
      `Rules: must end in .md, stem must be 3-50 characters of lowercase alphanumeric and hyphens only.`,
    );
  }
}

/**
 * Manages `.pi-coder/knowledge/` file operations.
 *
 * Knowledge files are raw markdown persisted to the knowledge directory.
 * Filenames must follow strict naming rules for safety and readability.
 */
export class KnowledgeStore {
  private readonly knowledgeDir: string;

  constructor(knowledgeDir: string) {
    this.knowledgeDir = knowledgeDir;
  }

  /**
   * Write or update a knowledge file.
   * Creates the knowledge directory if it doesn't exist.
   * Overwrites if the file already exists.
   *
   * @param filename - Must end in .md, stem 3-50 chars lowercase alphanumeric + hyphens
   * @param content - Raw markdown content
   * @returns The full file path
   * @throws Error if filename violates naming rules
   */
  upsert(filename: string, content: string): string {
    validateFilename(filename);
    mkdirSync(this.knowledgeDir, { recursive: true });
    const filePath = join(this.knowledgeDir, filename);
    writeFileSync(filePath, content, "utf-8");
    return filePath;
  }

  /**
   * Read a knowledge file by filename.
   *
   * @param filename - The .md filename to read
   * @returns The file content as a string, or null if not found
   */
  read(filename: string): string | null {
    const filePath = join(this.knowledgeDir, filename);
    try {
      return readFileSync(filePath, "utf-8");
    } catch {
      return null;
    }
  }

  /**
   * List all .md filenames in the knowledge directory.
   * Returns only the filenames (not full paths), sorted alphabetically.
   *
   * @returns Array of .md filenames, or empty array if directory doesn't exist
   */
  list(): string[] {
    try {
      const entries = readdirSync(this.knowledgeDir);
      return entries.filter((name) => name.endsWith(".md")).sort();
    } catch {
      return [];
    }
  }

  /**
   * Check whether a knowledge file exists.
   *
   * @param filename - The .md filename to check
   * @returns true if the file exists, false otherwise
   */
  exists(filename: string): boolean {
    const filePath = join(this.knowledgeDir, filename);
    return existsSync(filePath);
  }
}
