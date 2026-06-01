/**
 * Pi Coder V1 — Prompt Formatters
 *
 * Pure functions that format config values into prompt sections.
 * Extracted from extensions/index.ts for testability.
 */

import type { TestCommands } from "../types.ts";

/**
 * Format referenceProjects config into a prompt section.
 * Returns empty string if no reference projects configured.
 */
export function formatReferenceProjects(referenceProjects: Record<string, string> | undefined): string {
  if (!referenceProjects || Object.keys(referenceProjects).length === 0) {
    return "";
  }
  const lines = ["**Reference Projects (EXPERIMENTAL):**"];
  for (const [name, absPath] of Object.entries(referenceProjects)) {
    lines.push(`- **${name}**: ${absPath}`);
  }
  lines.push("");
  lines.push("When investigating a reference project, delegate to pi-coder.researcher and include the");
  lines.push("project path in the task. Do NOT pass cwd to the subagent tool — the researcher accesses");
  lines.push("reference projects by navigating to them via bash (cd, grep, find) and reading files");
  lines.push("with absolute paths. Reads are allowed; writes are blocked by damage-control.");
  return lines.join("\n");
}

/**
 * Format testCommands config into a prompt section.
 * Returns empty string if no testCommands configured.
 */
export function formatTestSuites(testCommands: TestCommands | undefined): string {
  if (!testCommands || Object.keys(testCommands).length === 0) {
    return "";
  }
  const lines = ["**Available Test Suites:**"];
  for (const [name, command] of Object.entries(testCommands)) {
    lines.push(`- **${name}**: \`${command}\``);
  }
  lines.push("");
  lines.push("Use pi_coder_run_tests with suite parameter to run a specific suite.");
  lines.push("Default suite is 'unit'. Use suite='all' to run every suite.");
  lines.push("When a spec unit has testSuite set, pass that suite name when running tests for that unit.");
  return lines.join("\n");
}
