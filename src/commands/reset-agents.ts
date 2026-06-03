/**
 * Pi Coder V1 — Reset Agents Command Handler
 *
 * Extracted from extensions/index.ts (Phase 4, Step 4.3).
 * Resets pi-coder agent files to package defaults.
 */

import { existsSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { HandlerContext } from "../handlers/types.ts";
import { resetLightModePromptCache, resetPlanModePromptCache, resetDevModePromptCache } from "../prompts/prompt-builders.ts";

/** Get the package's default agents directory. */
function getPackageAgentsDir(): string {
  // This file is at src/commands/reset-agents.ts, so agents/ is two directories up
  const thisDir = dirname(fileURLToPath(import.meta.url));
  return join(thisDir, "..", "..", "agents");
}

/** Register the /pi-coder-reset-agents command. */
export function registerResetAgentsCommand(ctx: HandlerContext): void {
  ctx.pi.registerCommand("pi-coder-reset-agents", {
    description: "Reset pi-coder agent files to package defaults",
    handler: async (_args, cmdCtx) => {
      // 1. Warn and require confirmation
      const ok = await cmdCtx.ui.confirm(
        "Reset agent files?",
        "All customizations to pi-coder agent files will be lost. Continue?",
      );
      if (!ok) return;

      // 2. Overwrite .pi/agents/pi-coder-*.md with package defaults
      const agentsDir = join(cmdCtx.cwd, ".pi", "agents");
      const packageAgentsDir = getPackageAgentsDir();
      const agentFilenames = [
        "pi-coder-researcher.md",
        "pi-coder-implementor.md",
        "pi-coder-reviewer.md",
      ];

      const reset: string[] = [];
      for (const filename of agentFilenames) {
        const source = join(packageAgentsDir, filename);
        const target = join(agentsDir, filename);

        if (!existsSync(source)) {
          continue; // Package source file missing — skip
        }

        copyFileSync(source, target);
        reset.push(filename);
      }

      // Reset dev mode prompt from prompts/ directory
      const packagePromptsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "prompts");
      const devSource = join(packagePromptsDir, "pi-coder-dev.md");
      if (existsSync(devSource)) {
        copyFileSync(devSource, join(agentsDir, "pi-coder-dev.md"));
        reset.push("pi-coder-dev.md");
      }

      // 3. Invalidate all prompt caches if any agent files were reset
      if (reset.length > 0) {
        resetLightModePromptCache();
        resetPlanModePromptCache();
        resetDevModePromptCache();
      }

      // 4. Report which files were reset
      if (reset.length > 0) {
        cmdCtx.ui.notify(`Agent files reset to defaults: ${reset.join(", ")}`, "info");
      } else {
        cmdCtx.ui.notify("No agent files found to reset.", "info");
      }

      // Log reset command
      ctx.logEvent("command", { command: "reset_agents", result: "success", filesReset: reset.length });
    },
  });
}
