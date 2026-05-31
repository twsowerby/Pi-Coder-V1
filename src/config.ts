/**
 * Pi Coder v1 — Config Loading, Validation, and Test-Command Detection
 *
 * Extracted from extensions/index.ts for maintainability.
 * Handles loading .pi-coder/config.json, validating config values,
 * and auto-detecting test commands from package.json.
 */

import type { PiCoderConfig, TestCommands } from "./types.ts";
import { existsSync, readFileSync } from "node:fs";
import { join, isAbsolute, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Default Config
// ---------------------------------------------------------------------------

export const DEFAULT_CONFIG: PiCoderConfig = {
  testCommand: "npm test",
  maxLoops: 3,
  createBranch: true,
  mergeBranch: "merge",
  branchPrefix: "pi-coder/",
  interviewTimeout: 0,
  nudge: {
    enabled: true,
    defaults: { turnsBeforeNudge: 1, escalationLevels: 3 },
    states: {
      SPEC_WORK: { turnsBeforeNudge: 3 },
      BLOCKED: { turnsBeforeNudge: 2 },
      IDLE: { enabled: false },
      SPEC_APPROVED: { enabled: false },
      FINAL_APPROVAL: { enabled: false },
      COMPLETE: { enabled: false },
    },
  },
  logging: {
    enabled: false,
    level: "standard",
    maxLogFiles: 10,
  },
  subagentControl: {
    enabled: true,
  },
  notifications: {
    enabled: false,
  },
};

// ---------------------------------------------------------------------------
// Config Validation
// ---------------------------------------------------------------------------

/** Result of validating a PiCoderConfig. */
export interface ConfigValidationResult {
  config: PiCoderConfig;
  warnings: Array<{ field: string; value: unknown; fix: string }>;
}

/** Validate critical config values, applying fixes and emitting warnings. */
export function validateConfig(cfg: PiCoderConfig): ConfigValidationResult {
  const warnings: Array<{ field: string; value: unknown; fix: string }> = [];

  if (typeof cfg.maxLoops !== "number" || cfg.maxLoops < 1) {
    warnings.push({ field: "maxLoops", value: cfg.maxLoops, fix: "defaulted to 3" });
    console.warn(`⚠️ pi-coder: maxLoops must be a positive integer, got ${cfg.maxLoops} — defaulting to 3`);
    cfg = { ...cfg, maxLoops: 3 };
  }
  if (typeof cfg.testCommand !== "string" || cfg.testCommand.trim() === "") {
    warnings.push({ field: "testCommand", value: cfg.testCommand, fix: 'defaulted to "npm test"' });
    console.warn(`⚠️ pi-coder: testCommand must be a non-empty string, got ${JSON.stringify(cfg.testCommand)} — defaulting to "npm test"`);
    cfg = { ...cfg, testCommand: "npm test" };
  }
  if (cfg.testCommands) {
    const tc = cfg.testCommands;
    // Validate all values are non-empty strings (testCommands is now Record<string, string>)
    let modified = false;
    for (const [key, value] of Object.entries(tc)) {
      if (typeof value !== "string" || value.trim() === "") {
        if (key === "unit" && Object.keys(tc).length === 1) {
          // Only key and it's invalid — fall back to testCommand
          warnings.push({ field: `testCommands.${key}`, value, fix: "fell back to testCommand" });
          console.warn(`⚠️ pi-coder: testCommands.${key} must be a non-empty string, got ${JSON.stringify(value)} — falling back to testCommand`);
          tc[key] = cfg.testCommand;
          modified = true;
        } else {
          // Remove invalid entries
          warnings.push({ field: `testCommands.${key}`, value, fix: "removed" });
          console.warn(`⚠️ pi-coder: testCommands.${key} must be a non-empty string if provided, got ${JSON.stringify(value)} — removing`);
          delete tc[key];
          modified = true;
        }
      }
    }
    if (modified) {
      cfg = { ...cfg, testCommands: { ...tc } };
    }
  }
  if (typeof cfg.interviewTimeout !== "number" || cfg.interviewTimeout < 0) {
    warnings.push({ field: "interviewTimeout", value: cfg.interviewTimeout, fix: "defaulted to 0" });
    console.warn(`⚠️ pi-coder: interviewTimeout must be ≥ 0, got ${cfg.interviewTimeout} — defaulting to 0`);
    cfg = { ...cfg, interviewTimeout: 0 };
  }
  if (typeof cfg.branchPrefix !== "string" || cfg.branchPrefix.trim() === "") {
    warnings.push({ field: "branchPrefix", value: cfg.branchPrefix, fix: 'defaulted to "pi-coder/"' });
    console.warn(`⚠️ pi-coder: branchPrefix must be a non-empty string, got ${JSON.stringify(cfg.branchPrefix)} — defaulting to "pi-coder/"`);
    cfg = { ...cfg, branchPrefix: "pi-coder/" };
  }
  return { config: cfg, warnings };
}

// ---------------------------------------------------------------------------
// Config Loading
// ---------------------------------------------------------------------------

export function loadConfig(cwd: string): ConfigValidationResult {
  const configPath = join(cwd, ".pi-coder", "config.json");
  try {
    if (existsSync(configPath)) {
      const raw = readFileSync(configPath, "utf-8");
      const parsed = JSON.parse(raw);

      // Migrate legacy gitStrategy → createBranch + mergeBranch
      if ("gitStrategy" in parsed && !("createBranch" in parsed) && !("mergeBranch" in parsed)) {
        if (parsed.gitStrategy === "squash") {
          parsed.mergeBranch = "squash";
        } else {
          parsed.mergeBranch = "merge";
        }
        parsed.createBranch = true;
        delete parsed.gitStrategy;
      }

      // Resolve and validate referenceProjects paths
      if (parsed.referenceProjects && typeof parsed.referenceProjects === "object") {
        const resolved: Record<string, string> = {};
        for (const [name, rawPath] of Object.entries(parsed.referenceProjects)) {
          if (typeof rawPath !== "string") continue;
          // Expand ~ to home directory
          let expanded = rawPath.startsWith("~/")
            ? join(process.env.HOME ?? "/tmp", rawPath.slice(2))
            : rawPath.startsWith("~")
              ? join(process.env.HOME ?? "/tmp", rawPath.slice(1))
              : rawPath;
          // Resolve relative paths against project cwd
          const absolute = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
          // Validate directory exists
          if (existsSync(absolute)) {
            resolved[name] = absolute;
          } else {
            console.warn(`⚠️ pi-coder: reference project "${name}" path not found: ${absolute} — skipping`);
          }
        }
        parsed.referenceProjects = Object.keys(resolved).length > 0 ? resolved : undefined;
      }

      return validateConfig({ ...DEFAULT_CONFIG, ...parsed, nudge: { ...DEFAULT_CONFIG.nudge, ...(parsed.nudge ?? {}) }, logging: { ...DEFAULT_CONFIG.logging, ...(parsed.logging ?? {}) }, subagentControl: { ...DEFAULT_CONFIG.subagentControl, ...(parsed.subagentControl ?? {}) }, notifications: { ...DEFAULT_CONFIG.notifications, ...(parsed.notifications ?? {}) } });
    }
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    console.warn(`⚠️ pi-coder: failed to load config.json: ${message} — using defaults`);
    // Fall through to default
  }
  return validateConfig({ ...DEFAULT_CONFIG });
}

// ---------------------------------------------------------------------------
// Test Command Detection
// ---------------------------------------------------------------------------

/**
 * Auto-detect the test command from the project's package.json scripts.
 * Looks for "vitest", "jest", then "test" scripts, falling back to "npm test".
 */
export function detectTestCommand(cwd: string): string {
  const pkgPath = join(cwd, "package.json");
  try {
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      const scripts = pkg.scripts ?? {};
      if (scripts.vitest) return "npx vitest run";
      if (scripts.jest) return "npx jest";
      if (scripts.test) return "npm test";
    }
  } catch {
    // Fall through to default
  }
  return "npm test";
}

/**
 * Detect structured test commands from package.json.
 * Returns a Record<string, string> mapping suite names to commands.
 * Always includes 'unit'. Detects component, integration, e2e, and
 * other test:* scripts automatically.
 */
export function detectTestCommands(cwd: string): TestCommands {
  const pkgPath = join(cwd, "package.json");
  try {
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      const scripts = pkg.scripts ?? {};
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      const result: TestCommands = {};

      // Always detect unit test command
      result.unit = scripts["test:ci"] || scripts.vitest ? "npx vitest run" : scripts.jest ? "npx jest" : scripts.test ? "npm test" : "npm test";

      // Detect component test runners (jsdom/TL)
      if (deps?.["@testing-library/react"] || scripts["test:component"] || scripts["test:ui"]) {
        result.component = scripts["test:component"] || scripts["test:ui"] || "npx vitest run --project jsdom";
      }

      // Detect E2E test runners
      if (deps?.playwright || scripts["test:e2e"]) {
        result.e2e = scripts["test:e2e"] || "npx playwright test";
      } else if (deps?.cypress || scripts["test:e2e"]) {
        result.e2e = scripts["test:e2e"] || "npx cypress run";
      }

      // Auto-detect any other test:* scripts from package.json
      for (const [name, _cmd] of Object.entries(scripts as Record<string, string>)) {
        if (name.startsWith("test:") && name !== "test:ci" && name !== "test:e2e" && name !== "test:component" && name !== "test:ui") {
          // Extract suite name from script name (e.g., "test:integration" -> "integration")
          const suiteName = name.slice(5); // Remove "test:" prefix
          if (!(suiteName in result)) {
            result[suiteName] = `npm run ${name}`;
          }
        }
      }

      return result;
    }
  } catch {
    // Fall through
  }
  return { unit: "npm test" };
}
