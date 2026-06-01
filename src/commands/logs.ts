/**
 * Pi Coder V1 — Logs Command Handler
 *
 * Extracted from extensions/index.ts (Phase 4, Step 4.5).
 * Shows pi-coder interaction log statistics.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { HandlerContext } from "../handlers/types.ts";

/** Register the /pi-coder-logs command. */
export function registerLogsCommand(ctx: HandlerContext): void {
  ctx.pi.registerCommand("pi-coder-logs", {
    description: "Show pi-coder interaction log statistics. Options: /pi-coder-logs [sessionId] [--spec specId] [--all]",
    handler: async (args, cmdCtx) => {
      const baseLogDir = join(cmdCtx.cwd, ".pi-coder", "logs");

      if (!existsSync(baseLogDir)) {
        cmdCtx.ui.notify("No logs found. Enable logging in .pi-coder/config.json to start collecting telemetry.", "info");
        return;
      }

      // Parse arguments
      const argParts = args.trim().split(/\s+/);
      let filterSessionId: string | null = null;
      let filterSpecId: string | null = null;
      let showAll = false;

      for (const part of argParts) {
        if (part === "--all") {
          showAll = true;
        } else if (part.startsWith("--spec=")) {
          filterSpecId = part.slice(7);
        } else if (part.startsWith("--spec")) {
          filterSpecId = part.slice(7) || null;
        } else if (part && !part.startsWith("--")) {
          filterSessionId = part;
        }
      }

      // Discover session directories and log files
      const entries: Array<Record<string, unknown>> = [];
      const logDirsToRead: string[] = [];

      if (showAll || !filterSessionId) {
        const topEntries = readdirSync(baseLogDir, { withFileTypes: true });
        for (const entry of topEntries) {
          if (entry.isDirectory()) {
            if (filterSessionId && !entry.name.startsWith(filterSessionId)) continue;
            logDirsToRead.push(join(baseLogDir, entry.name));
          } else if (entry.name.endsWith(".log")) {
            logDirsToRead.push(baseLogDir);
          }
        }
        if (logDirsToRead.length === 0 && topEntries.some(e => e.name.endsWith(".log"))) {
          logDirsToRead.push(baseLogDir);
        }
      } else {
        const topEntries = readdirSync(baseLogDir, { withFileTypes: true });
        const match = topEntries.find(e => e.isDirectory() && e.name.startsWith(filterSessionId!));
        if (match) {
          logDirsToRead.push(join(baseLogDir, match.name));
        }
        if (topEntries.some(e => e.name.endsWith(".log"))) {
          logDirsToRead.push(baseLogDir);
        }
      }

      if (logDirsToRead.length === 0) {
        cmdCtx.ui.notify("No log files found for the given filters.", "info");
        return;
      }

      // Read and parse log files from each directory
      const seenDirs = new Set<string>();
      for (const dir of logDirsToRead) {
        if (seenDirs.has(dir)) continue;
        seenDirs.add(dir);
        const files = readdirSync(dir).filter(f => f.endsWith(".log")).sort();
        for (const file of files) {
          const fileContent = readFileSync(join(dir, file), "utf-8");
          for (const line of fileContent.trim().split("\n").filter(Boolean)) {
            try {
              entries.push(JSON.parse(line));
            } catch {
              // Skip malformed lines
            }
          }
        }
      }

      if (entries.length === 0) {
        cmdCtx.ui.notify("Log files found but contain no parseable entries.", "info");
        return;
      }

      // Filter by specId if requested
      let filteredEntries = entries;
      if (filterSpecId) {
        filteredEntries = entries.filter(e => {
          const p = (e as Record<string, unknown>).payload as Record<string, unknown> | undefined;
          return p?.specId === filterSpecId;
        });
        if (filteredEntries.length === 0) {
          cmdCtx.ui.notify(`No log entries found for spec '${filterSpecId}'.`, "info");
          return;
        }
      }

      // Compute and display summary using analysis functions
      const { computeFullSummary, formatSummary } = await import("../log-analysis.ts");
      const summary = computeFullSummary(filteredEntries as any, ctx.config.logging.tokenPricing);
      const text = formatSummary(summary);

      cmdCtx.ui.notify(text, "info");

      // Log that logs were viewed
      ctx.logEvent("command", { command: "logs", result: "success", entryCount: filteredEntries.length, filterSessionId, filterSpecId });
    },
  });
}
