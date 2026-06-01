/**
 * Pi Coder V1 — Init Command Handler
 *
 * Extracted from extensions/index.ts (Phase 4, Step 4.2).
 * Initializes pi-coder directory structure and config.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { PiCoderConfig } from "../types.ts";
import { detectTestCommand, detectTestCommands, detectDbStack } from "../config.ts";
import type { HandlerContext } from "../handlers/types.ts";

/** Resolve the package's own agents/ directory path. */
function getPackageAgentsDir(): string {
  // This file is at src/commands/init.ts, so agents/ is two directories up
  const thisDir = dirname(fileURLToPath(import.meta.url));
  return join(thisDir, "..", "..", "agents");
}

/** Register the /pi-coder-init command. */
export function registerInitCommand(ctx: HandlerContext): void {
  ctx.pi.registerCommand("pi-coder-init", {
    description: "Initialize pi-coder directory structure and config",
    handler: async (_args, cmdCtx) => {
      const cwd = cmdCtx.cwd;
      const created: string[] = [];
      const skipped: string[] = [];
      const warnings: string[] = [];

      // 1. Create .pi-coder/ directory structure
      const knowledgeDir = join(cwd, ".pi-coder", "knowledge");
      const specsDir = join(cwd, ".pi-coder", "specs");
      const agentsDir = join(cwd, ".pi", "agents");

      mkdirSync(knowledgeDir, { recursive: true });
      created.push(".pi-coder/knowledge/");
      mkdirSync(specsDir, { recursive: true });
      created.push(".pi-coder/specs/");

      // 2. Create .pi/agents/ if missing
      if (!existsSync(agentsDir)) {
        mkdirSync(agentsDir, { recursive: true });
        created.push(".pi/agents/");
      }

      // 3. Create .pi-coder/config.json — only if it doesn't already exist
      const configPath = join(cwd, ".pi-coder", "config.json");
      const detectedDbStack = detectDbStack(cwd);
      if (!existsSync(configPath)) {
        const detectedTestCommand = detectTestCommand(cwd);
        const detectedTestCommands = detectTestCommands(cwd);
        const defaultConfig: PiCoderConfig = {
          testCommand: detectedTestCommand,
          testCommands: detectedTestCommands,
          maxLoops: 3,
          createBranch: true,
          mergeBranch: "merge",
          branchPrefix: "pi-coder/",
          interviewTimeout: 0,
          retryEscalation: { maxRetries: 10, enrichedSteerThreshold: 4, replanThreshold: 7 },
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
          dbCommands: detectedDbStack,
        };
        writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2), "utf-8");
        created.push(".pi-coder/config.json");
      } else {
        skipped.push(".pi-coder/config.json (already exists)");
      }

      // 4. Copy agent .md files — skip existing (don't overwrite customizations)
      const packageAgentsDir = getPackageAgentsDir();
      const agentFilenames = [
        "pi-coder-researcher.md",
        "pi-coder-implementor.md",
        "pi-coder-reviewer.md",
      ];

      for (const filename of agentFilenames) {
        const source = join(packageAgentsDir, filename);
        const target = join(agentsDir, filename);

        if (!existsSync(source)) {
          warnings.push(`Agent source file not found: ${filename}`);
          continue;
        }

        if (!existsSync(target)) {
          copyFileSync(source, target);
          created.push(`.pi/agents/${filename}`);
        } else {
          skipped.push(`.pi/agents/${filename} (already exists)`);
        }
      }

      // 4b. Copy orchestrator prompt template from prompts/ — skip existing
      const packagePromptsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "prompts");
      const orchestratorSource = join(packagePromptsDir, "pi-coder-orchestrator.md");
      const orchestratorTarget = join(cwd, ".pi", "agents", "pi-coder-orchestrator.md");

      if (existsSync(orchestratorSource)) {
        if (!existsSync(orchestratorTarget)) {
          mkdirSync(dirname(orchestratorTarget), { recursive: true });
          copyFileSync(orchestratorSource, orchestratorTarget);
          created.push(".pi/agents/pi-coder-orchestrator.md (prompt template)");
        } else {
          skipped.push(".pi/agents/pi-coder-orchestrator.md (already exists)");
        }
      } else {
        warnings.push("Orchestrator prompt template not found in package");
      }

      // 4c. Create starter design_system.md in knowledge — skip if exists
      const designSystemPath = join(knowledgeDir, "design_system.md");
      if (!existsSync(designSystemPath)) {
        const designSystemContent = [
          "# Design System",
          "",
          "This file documents the project's UI component library, patterns, and conventions.",
          "The implementor and reviewer reference this before writing or reviewing UI code.",
          "Fill in each section for your project.",
          "",
          "## Component Library",
          "",
          "<!-- List reusable UI components and their locations. -->",
          "<!-- e.g., `components/ui/Card.tsx` — bordered card with header slot -->",
          "<!-- e.g., `components/ui/Button.tsx` — primary/secondary/ghost variants -->",
          "",
          "## Layout & Spacing",
          "",
          "<!-- Document the spacing system and layout conventions. -->",
          "<!-- e.g., 4px base grid, gap-2 (8px) between sibling elements -->",
          "<!-- e.g., max-width container with responsive breakpoints at 640/768/1024px -->",
          "",
          "## Colors & Theming",
          "",
          "<!-- Document color tokens, dark mode strategy, and theme configuration. -->",
          "<!-- e.g., CSS custom properties: --color-primary, --color-bg, --color-text -->",
          "",
          "## Typography",
          "",
          "<!-- Document font families, sizes, and heading hierarchy. -->",
          "<!-- e.g., Inter for body, heading scale: text-sm / text-base / text-lg / text-xl -->",
          "",
          "## Interaction Patterns",
          "",
          "<!-- Document common interaction patterns and conventions. -->",
          "<!-- e.g., Modal dialogs use `Dialog` component with overlay click to dismiss -->",
          "<!-- e.g., Form validation shows errors inline below each field -->",
          "<!-- e.g., Loading states use skeleton placeholders, not spinners -->",
          "",
          "## Existing Patterns to Follow",
          "",
          "<!-- When adding a new feature, what existing components/patterns should be reused? -->",
          "<!-- e.g., List pages: use DataTable with ColumnDef and server-side pagination -->",
          "<!-- e.g., Detail pages: use Card layout with header slot and action buttons -->",
          "",
        ].join("\n");
        writeFileSync(designSystemPath, designSystemContent, "utf-8");
        created.push(".pi-coder/knowledge/design_system.md (starter template — fill in for your project)");
      } else {
        skipped.push(".pi-coder/knowledge/design_system.md (already exists)");
      }

      // 4d. Create database.md in knowledge — skip if exists
      const databaseMdPath = join(knowledgeDir, "database.md");
      if (!existsSync(databaseMdPath)) {
        const dbMdLines: string[] = [
          "# Database",
          "",
          "This file documents the project's database configuration.",
          "The researcher and implementor reference this before working on data-layer features.",
        ];
        if (detectedDbStack) {
          dbMdLines.push("");
          dbMdLines.push(`This project uses **${detectedDbStack.stack}** for its database.`);
          dbMdLines.push("");
          dbMdLines.push("## Key Tables");
          dbMdLines.push("");
          dbMdLines.push("<!-- List the most important tables and their purpose. -->");
          dbMdLines.push("<!-- e.g., `users` — Core user accounts with email, hashed password, and role -->");
          dbMdLines.push("<!-- e.g., `sessions` — Active user sessions with token and expiry -->");
          dbMdLines.push("");
          dbMdLines.push("## Gotchas");
          dbMdLines.push("");
          dbMdLines.push("<!-- Document unexpected schema details, naming conventions, or traps. -->");
          dbMdLines.push("<!-- e.g., `created_at` columns use timestamptz, not timestamp — always compare with timezone-aware values -->");
          dbMdLines.push("<!-- e.g., `users.email` has a unique constraint but the app doesn't enforce it — rely on the DB constraint -->");
        } else {
          dbMdLines.push("");
          dbMdLines.push("<!-- No database stack was auto-detected. If this project uses a database, -->");
          dbMdLines.push("<!-- add \"dbCommands\": { \"stack\": \"supabase\" } to .pi-coder/config.json. -->");
          dbMdLines.push("<!-- See the README's \"dbCommands\" configuration section for details. -->");
        }
        writeFileSync(databaseMdPath, dbMdLines.join("\n") + "\n", "utf-8");
        created.push(`.pi-coder/knowledge/database.md${detectedDbStack ? ` (${detectedDbStack.stack} detected)` : " (no DB detected — fill in manually)"}`);
      } else {
        skipped.push(".pi-coder/knowledge/database.md (already exists)");
      }

      // 4d. Create .pi-coder/damage-control.json
      const damageControlPath = join(cwd, ".pi-coder", "damage-control.json");
      if (!existsSync(damageControlPath)) {
        const damageControlContent = JSON.stringify({
          enabled: true,
          rules: {
            bashToolPatterns: [
              { pattern: "\\brm\\s+(-rf?|--recursive|-r\\s*-f)", reason: "Recursive delete is destructive — describe what needs removing and use a targeted approach" },
              { pattern: "\\bsudo\\b", reason: "Sudo commands require host-level access — ask the user to run it" },
              { pattern: "\\bgit\\s+push\\s+.*--force", reason: "Force push rewrites shared history — use a new commit or branch" },
              { pattern: "\\bgit\\s+push\\s+.*--delete", reason: "Deleting remote branches is destructive" },
              { pattern: "\\bgit\\s+reset\\s+--hard", reason: "Hard reset discards uncommitted changes — use pi_coder_git rollback" },
              { pattern: "\\bgit\\s+clean\\s+-", reason: "Git clean removes untracked files — clarify what needs removing" },
              { pattern: "\\bchmod\\s+.*777\\b", reason: "chmod 777 is a security risk — use minimum permissions" },
              { pattern: "\\btruncate\\b", reason: "Truncating files is destructive — write new content instead" },
              { pattern: "\\b(?:mkfs|dd\\s+if=)\\b", reason: "Can destroy filesystems — do not attempt to work around this" },
              { pattern: "\\bDROP\\s+(?:TABLE|DATABASE|SCHEMA)\\b", reason: "Dropping database objects is destructive — use migrations to alter schema instead" },
              { pattern: "\\bTRUNCATE\\s+", reason: "Truncating tables destroys data — use DELETE with WHERE to remove specific rows" },
              { pattern: "\\bDELETE\\s+FROM\\b(?![^;]*\\bWHERE\\b)", reason: "DELETE without WHERE removes all rows — add a WHERE clause to target specific rows" },
              { pattern: "\\b(?:supabase\\s+db\\s+dump|pg_dump|mysqldump)\\b", reason: "Full schema dumps produce massive output — use targeted queries instead (see dbCommands in config)" },
            ],
            zeroAccessPaths: [".env", ".env.local", ".env.production", "~/.ssh/", "~/.gnupg/"],
            readOnlyPaths: [".git/config"],
            noDeletePaths: [".git/", "node_modules/"],
          },
        }, null, 2) + "\n";
        writeFileSync(damageControlPath, damageControlContent, "utf-8");
        created.push(".pi-coder/damage-control.json");
      } else {
        skipped.push(".pi-coder/damage-control.json (already exists)");
      }

      // 4e. Create .pi-coder/.gitignore
      const piCoderGitignorePath = join(cwd, ".pi-coder", ".gitignore");
      if (!existsSync(piCoderGitignorePath)) {
        writeFileSync(piCoderGitignorePath, [
          "# Workspace-local pi-coder files — not project artifacts",
          "state.json",
          "logs/",
        ].join("\n") + "\n", "utf-8");
        created.push(".pi-coder/.gitignore");
      } else {
        skipped.push(".pi-coder/.gitignore (already exists)");
      }

      // 5. Warn if subagent tool is not detected
      if (!ctx.subagentsAvailable) {
        warnings.push(
          "pi-subagents is not detected. Delegation features will not work until installed: `pi install npm:pi-subagents`",
        );
      }

      // 6. Disable ALL built-in subagents via project settings
      const settingsPath = join(cwd, ".pi", "settings.json");
      let settings: Record<string, unknown> = {};
      try {
        if (existsSync(settingsPath)) {
          settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
        }
      } catch {
        // Start fresh if corrupt
      }

      const subagentsConfig = (settings as Record<string, Record<string, unknown>>).subagents ?? {};
      const alreadyDisabled = subagentsConfig.disableBuiltins === true;
      if (!alreadyDisabled) {
        subagentsConfig.disableBuiltins = true;
        (settings as Record<string, Record<string, unknown>>).subagents = subagentsConfig;

        mkdirSync(dirname(settingsPath), { recursive: true });
        writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
        created.push(".pi/settings.json (disabled all built-in subagents — pi-coder agents only)");
      } else {
        skipped.push(".pi/settings.json (built-in subagents already disabled)");
      }

      // 7. Report summary
      const lines: string[] = ["Pi Coder Init Complete"];
      if (created.length > 0) {
        lines.push(`Created: ${created.join(", ")}`);
      }
      if (skipped.length > 0) {
        lines.push(`Skipped: ${skipped.join(", ")}`);
      }
      if (warnings.length > 0) {
        lines.push(`Warnings: ${warnings.join(", ")}`);
      }
      cmdCtx.ui.notify(lines.join("\n"), "info");

      // Log init command
      ctx.logEvent("command", { command: "init", result: "success", created: created.length, skipped: skipped.length, warnings: warnings.length });
    },
  });
}
