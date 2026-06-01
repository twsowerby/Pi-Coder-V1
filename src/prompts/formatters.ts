/**
 * Pi Coder V1 — Prompt Formatters
 *
 * Pure functions that format config values into prompt sections.
 * Extracted from extensions/index.ts for testability.
 */

import type { TestCommands, DbCommandsConfig } from "../types.ts";

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

/**
 * Format dbCommands config into a prompt section for the orchestrator.
 * Returns empty string if no dbCommands configured (null/undefined).
 * When configured, tells the orchestrator which DB stack is available and
 * how to instruct subagents to inspect it.
 */
export function formatDbCommands(dbCommands: DbCommandsConfig | null | undefined): string {
  if (!dbCommands) return "";

  const lines = ["**Database Inspection Commands:**"];
  lines.push("");
  lines.push(`This project uses **${dbCommands.stack}** for its database. When a spec touches the data layer (tables, queries, migrations, ORM models), include DB inspection instructions in researcher and implementor delegation briefs.`);
  lines.push("");
  lines.push(intentByStack(dbCommands.stack));
  lines.push("");
  lines.push("**When to include DB inspection in delegation briefs:**");
  lines.push("- Researcher brief: When the spec mentions database tables, columns, migrations, or queries");
  lines.push("- Implementor RED brief: When writing tests that involve database state or ORM queries");
  lines.push("- Implementor GREEN brief: When implementing code that reads from or writes to the database");
  lines.push("");
  lines.push("**Critical:** Always use targeted queries to inspect specific tables and columns. Never use full schema dump commands (e.g. `supabase db dump`, `pg_dump`, `mysqldump`) — they produce massive output that wastes tokens. The agent knows SQL; give it the stack and query tool, not the full schema.");
  return lines.join("\n");
}

/**
 * Return stack-specific DB inspection guidance.
 * The agent knows SQL — just tell it the query tool and it'll write its own queries.
 */
function intentByStack(stack: string): string {
  switch (stack) {
    case "supabase":
      return [
        "Use `supabase db query --local` to run read-only SQL against the local database.",
        "Example: `supabase db query --local \"SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'users'\"`",
        "Use `supabase db lint` to check for schema issues.",
      ].join("\n");
    case "prisma":
      return [
        "Use `npx prisma db pull --print` to introspect the current schema.",
        "Use `npx prisma db execute --stdin` to run SQL queries (pipe via stdin).",
        "Use `npx prisma validate` to check the schema.",
      ].join("\n");
    case "drizzle":
      return [
        "Use `npx drizzle-kit introspect` to introspect the current schema.",
        "Use `psql -c` or equivalent to run targeted SQL queries against the database.",
      ].join("\n");
    case "raw-pg":
      return [
        "Use `psql -c` to run targeted SQL queries against the PostgreSQL database.",
        "Query `information_schema.columns` to inspect table structures.",
      ].join("\n");
    case "raw-mysql":
      return [
        "Use `mysql -e` to run targeted SQL queries against the MySQL database.",
        "Query `information_schema.columns` to inspect table structures.",
      ].join("\n");
    case "raw-sqlite":
      return [
        "Use `sqlite3 <db-path> '<sql>'` to run targeted SQL queries.",
        "Use `.schema <table>` to inspect a specific table's structure.",
      ].join("\n");
    default:
      return `This project uses a custom database stack (\"${stack}\"). When delegating, tell the agent to use appropriate read-only query commands for this stack to inspect schema and data.`;
  }
}
