/**
 * Damage-Control — block destructive tool calls with actionable feedback
 *
 * Inspired by damage-control-continue.ts from pi-vs-claude-code.
 * Instead of just blocking with "no", returns detailed guidance so the
 * agent can adapt and continue working in the same turn.
 *
 * Rules are loaded from `.pi-coder/damage-control.json` (project-scoped).
 * If no rules file exists, sensible defaults are used.
 *
 * Applies to ALL sessions in the project — including subagent sessions
 * (researcher, implementor, reviewer) — because it's loaded at the
 * package level via pi's extension auto-discovery.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BashRule {
	/** Regex pattern matched against the bash command string */
	pattern: string;
	/** Human-readable reason shown to the agent */
	reason: string;
	/** If true, prompt user for confirmation instead of blocking outright */
	ask?: boolean;
}

interface DamageControlRules {
	/** Bash command patterns to block or confirm */
	bashToolPatterns: BashRule[];
	/** Paths with zero access — no read, no write, no bash reference */
	zeroAccessPaths: string[];
	/** Paths that can be read but not modified */
	readOnlyPaths: string[];
	/** Paths that can be modified but not deleted */
	noDeletePaths: string[];
}

interface DamageControlConfig {
	rules: DamageControlRules;
	/** Whether damage-control is active (default: true) */
	enabled: boolean;
}

// ---------------------------------------------------------------------------
// Default rules
// ---------------------------------------------------------------------------

const DEFAULT_RULES: DamageControlRules = {
	bashToolPatterns: [
		{ pattern: "\\brm\\s+(-rf?|--recursive|-r\\s*-f)", reason: "Recursive delete is destructive — describe what needs removing and delegate to the implementor with a targeted approach." },
		{ pattern: "\\bsudo\\b", reason: "Sudo commands require host-level access. Tell the user what you need and ask them to run it." },
		{ pattern: "\\bgit\\s+push\\s+.*--force", reason: "Force push rewrites shared history. Never force-push — use a new commit or branch instead." },
		{ pattern: "\\bgit\\s+push\\s+.*--delete", reason: "Deleting remote branches is destructive. Use a feature branch and let the orchestrator merge it." },
		{ pattern: "\\bgit\\s+reset\\s+--hard", reason: "Hard reset discards uncommitted changes. Use pi_coder_git rollback instead." },
		{ pattern: "\\bgit\\s+clean\\s+-", reason: "Git clean removes untracked files. This is destructive — clarify what needs removing instead." },
		{ pattern: "\\bdrop\\s+database\\b", reason: "Dropping a database is irreversible. Use migrations or ask the user to handle this manually." },
		{ pattern: "\\bchmod\\s+.*777\\b", reason: "chmod 777 is a security risk. Use the minimum permissions needed and delegate to the implementor." },
		{ pattern: "\\btruncate\\b", reason: "Truncating files is destructive. Write new content instead of destroying existing data." },
		{ pattern: "\\b(?:mkfs|dd\\s+if=)\\b", reason: "This command can destroy filesystems. Do not attempt to work around this restriction." },
	],
	zeroAccessPaths: [
		".env.production",
		"~/.ssh/",
		"~/.gnupg/",
	],
	readOnlyPaths: [
		".env",
		".env.local",
		".git/config",
	],
	noDeletePaths: [
		".git/",
		"node_modules/",
	],
};

// ---------------------------------------------------------------------------
// Feedback generator
// ---------------------------------------------------------------------------

function continueFeedback(toolName: string, violationReason: string, invocation: string): string {
	return [
		`🛡️ Damage-Control: ${toolName} blocked — ${violationReason}`,
		``,
		`Attempted: ${invocation}`,
		``,
		`Don't call ${toolName} like this. Decide which case you're in and continue:`,
		``,
		`→ NON-DESTRUCTIVE (reading .env to verify a key, listing a protected dir, checking config):`,
		`   Assume the data is present and correct. Skip the verification step and move on with the task.`,
		`   If you actually need a value, ask the user for it explicitly.`,
		``,
		`→ DESTRUCTIVE (delete, overwrite, force-push, drop, rm, truncate, sudo, kill, etc.):`,
		`   STOP. Tell the user exactly what you need to ship this task and ask how they want to proceed.`,
		`   Do not invent a workaround that achieves the same destructive effect.`,
		``,
		`Pick the right path above and continue working. Do not retry this exact call.`,
	].join("\n");
}

// ---------------------------------------------------------------------------
// Path matching
// ---------------------------------------------------------------------------

function resolvePath(p: string, cwd: string): string {
	if (p.startsWith("~")) {
		p = path.join(process.env.HOME ?? "/tmp", p.slice(1));
	}
	return path.resolve(cwd, p);
}

function isPathMatch(targetPath: string, pattern: string, cwd: string): boolean {
	const resolvedPattern = pattern.startsWith("~")
		? path.join(process.env.HOME ?? "/tmp", pattern.slice(1))
		: pattern;

	// Directory prefix match (pattern ends with /)
	if (resolvedPattern.endsWith("/")) {
		const absolutePattern = path.isAbsolute(resolvedPattern)
			? resolvedPattern
			: path.resolve(cwd, resolvedPattern);
		return targetPath.startsWith(absolutePattern);
	}

	// Glob-style pattern matching
	const regexPattern = resolvedPattern
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*/g, ".*");

	const regex = new RegExp(`^${regexPattern}$|^${regexPattern}/|/${regexPattern}$|/${regexPattern}/`);

	const relativePath = path.relative(cwd, targetPath);

	return (
		regex.test(targetPath) ||
		regex.test(relativePath) ||
		targetPath.includes(resolvedPattern) ||
		relativePath.includes(resolvedPattern)
	);
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	let config: DamageControlConfig = {
		rules: DEFAULT_RULES,
		enabled: true,
	};

	let projectCwd = "";
	let rulesLoaded = false;

	pi.on("session_start", async (_event, ctx) => {
		projectCwd = ctx.cwd;
		const rulesPath = path.join(ctx.cwd, ".pi-coder", "damage-control.json");

		try {
			if (fs.existsSync(rulesPath)) {
				const content = fs.readFileSync(rulesPath, "utf8");
				const loaded = JSON.parse(content) as Partial<DamageControlConfig>;

				config = {
					enabled: loaded.enabled !== false,
					rules: {
						bashToolPatterns: loaded.rules?.bashToolPatterns ?? DEFAULT_RULES.bashToolPatterns,
						zeroAccessPaths: loaded.rules?.zeroAccessPaths ?? DEFAULT_RULES.zeroAccessPaths,
						readOnlyPaths: loaded.rules?.readOnlyPaths ?? DEFAULT_RULES.readOnlyPaths,
						noDeletePaths: loaded.rules?.noDeletePaths ?? DEFAULT_RULES.noDeletePaths,
					},
				};
				rulesLoaded = true;
				const total =
					config.rules.bashToolPatterns.length +
					config.rules.zeroAccessPaths.length +
					config.rules.readOnlyPaths.length +
					config.rules.noDeletePaths.length;
				ctx.ui.notify(`🛡️ Damage-Control: ${total} rules loaded from project config`, "info");
			} else {
				// Use defaults — no notification, the defaults are sensible
				config = { rules: DEFAULT_RULES, enabled: true };
				rulesLoaded = true;
			}
		} catch (err) {
			ctx.ui.notify(
				`🛡️ Damage-Control: Failed to load rules: ${err instanceof Error ? err.message : String(err)}. Using defaults.`,
				"warning",
			);
			config = { rules: DEFAULT_RULES, enabled: true };
			rulesLoaded = true;
		}
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!config.enabled || !rulesLoaded) return { block: false };

		const { toolName, input } = event;
		let violationReason: string | null = null;
		let shouldAsk = false;

		// --- Path extraction ---

		const inputPaths: string[] = [];
		if (toolName === "read" || toolName === "write" || toolName === "edit") {
			const p = (input as { path?: string }).path;
			if (p) inputPaths.push(p);
		} else if (toolName === "grep" || toolName === "find" || toolName === "ls") {
			const p = (input as { path?: string }).path;
			if (p) inputPaths.push(p);
		}

		// --- Zero-access path checks (read/write/edit/grep/find/ls) ---

		for (const p of inputPaths) {
			const resolved = resolvePath(p, projectCwd);
			for (const zap of config.rules.zeroAccessPaths) {
				if (isPathMatch(resolved, zap, projectCwd)) {
					violationReason = `Access to zero-access path restricted: ${zap}`;
					break;
				}
			}
			if (violationReason) break;
		}

		// --- Grep glob matches zero-access paths ---

		if (!violationReason && toolName === "grep") {
			const glob = (input as { glob?: string }).glob;
			if (glob) {
				for (const zap of config.rules.zeroAccessPaths) {
					if (glob.includes(zap) || isPathMatch(glob, zap, projectCwd)) {
						violationReason = `Glob matches zero-access path: ${zap}`;
						break;
					}
				}
			}
		}

		// --- Bash command checks ---

		if (!violationReason && toolName === "bash") {
			const command = (input as { command?: string }).command ?? "";

			// Bash tool patterns
			for (const rule of config.rules.bashToolPatterns) {
				try {
					const regex = new RegExp(rule.pattern);
					if (regex.test(command)) {
						violationReason = rule.reason;
						shouldAsk = !!rule.ask;
						break;
					}
				} catch {
					// Invalid regex — skip this rule
				}
			}

			// Bash references zero-access path
			if (!violationReason) {
				for (const zap of config.rules.zeroAccessPaths) {
					if (command.includes(zap)) {
						violationReason = `Bash command references zero-access path: ${zap}`;
						break;
					}
				}
			}

			// Bash may modify read-only path
			if (!violationReason) {
				for (const rop of config.rules.readOnlyPaths) {
					if (
						command.includes(rop) &&
						(/[\s>|]/.test(command) || command.includes("rm") || command.includes("mv") || command.includes("sed"))
					) {
						violationReason = `Bash command may modify read-only path: ${rop}`;
						break;
					}
				}
			}

			// Bash deletes/moves protected path
			if (!violationReason) {
				for (const ndp of config.rules.noDeletePaths) {
					if (command.includes(ndp) && (command.includes("rm") || command.includes("mv"))) {
						violationReason = `Bash command attempts to delete/move protected path: ${ndp}`;
						break;
					}
				}
			}
		}

		// --- Write/edit to read-only paths ---

		if (!violationReason && (toolName === "write" || toolName === "edit")) {
			for (const p of inputPaths) {
				const resolved = resolvePath(p, projectCwd);
				for (const rop of config.rules.readOnlyPaths) {
					if (isPathMatch(resolved, rop, projectCwd)) {
						violationReason = `Modification of read-only path restricted: ${rop}`;
						break;
					}
				}
				if (violationReason) break;
			}
		}

		// --- Write/edit to no-delete paths (allow creation, block deletion) ---
		// Note: write can overwrite (which is like delete+create), but the most
		// common destructive case is editing package-lock.json or similar.
		// We don't block write/edit to noDeletePaths — that's for rm/mv only.

		// --- Handle violation ---

		if (violationReason) {
			const invocation = toolName === "bash"
				? (input as { command?: string }).command ?? ""
				: JSON.stringify(input);

			if (shouldAsk && ctx.hasUI) {
				const confirmed = await ctx.ui.confirm(
					`🛡️ Damage-Control Confirmation`,
					`Dangerous command detected: ${violationReason}\n\nCommand: ${invocation}\n\nAllow?`,
				);

				if (!confirmed) {
					return {
						block: true,
						reason: continueFeedback(toolName, `${violationReason} (user denied)`, invocation),
					};
				}
				// User confirmed — allow through
				return { block: false };
			}

			// Block with actionable feedback
			return {
				block: true,
				reason: continueFeedback(toolName, violationReason, invocation),
			};
		}

		return { block: false };
	});
}
