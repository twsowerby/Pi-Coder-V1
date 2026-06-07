/**
 * Pi Coder V1 — Subagent Context Guard
 *
 * When pi-coder runs inside a subagent process (PI_SUBAGENT_DEPTH > 0),
 * the extension activates in "subagent-guard" mode instead of disabling
 * itself entirely. Guard mode provides three layers of context management:
 *
 * Layer 1: tool_result truncation — Limits read/bash/grep output sizes
 * Layer 2: context event pruning — Removes old tool results from context
 * Layer 3: session_before_compact — Subagent-aware compaction summaries
 *
 * This module exports pure functions for truncation and pruning, plus
 * a registration function that wires them into the Pi event system.
 * The registration is called from session-start.ts inside the child
 * process guard block.
 */

import type { PiCoderConfig, SubagentContextGuardConfig } from "../types.ts";

// ---------------------------------------------------------------------------
// Limit Resolution
// ---------------------------------------------------------------------------

/** Resolved truncation limits for a specific subagent agent. */
export interface GuardLimits {
  readLineLimit: number;
  bashCharLimit: number;
  grepResultLimit: number;
  contextPruneTurns: number;
}

/**
 * Resolve the effective truncation limits for a given subagent agent.
 * Merges global defaults with per-agent overrides.
 */
export function resolveLimits(config: PiCoderConfig, childAgent: string): GuardLimits {
  const guard = config.subagentContextGuard;
  const defaults: GuardLimits = {
    readLineLimit: guard?.readLineLimit ?? 200,
    bashCharLimit: guard?.bashCharLimit ?? 5000,
    grepResultLimit: guard?.grepResultLimit ?? 50,
    contextPruneTurns: guard?.contextPruneTurns ?? 4,
  };

  // Try per-agent override: childAgent is like "pi-coder.implementor"
  const agentKey = childAgent.startsWith("pi-coder.")
    ? childAgent.slice("pi-coder.".length)
    : childAgent;

  const overrides = guard?.agentOverrides?.[agentKey as keyof NonNullable<SubagentContextGuardConfig["agentOverrides"]>];
  if (overrides) {
    return {
      readLineLimit: overrides.readLineLimit ?? defaults.readLineLimit,
      bashCharLimit: overrides.bashCharLimit ?? defaults.bashCharLimit,
      grepResultLimit: overrides.grepResultLimit ?? defaults.grepResultLimit,
      contextPruneTurns: defaults.contextPruneTurns, // No per-agent override for prune turns
    };
  }

  return defaults;
}

// ---------------------------------------------------------------------------
// Content Block Helpers
// ---------------------------------------------------------------------------

export type ContentBlock = { type: string; text?: string };

/**
 * Extract text from a content block array.
 * Returns the concatenated text from all text blocks, or undefined if no text blocks.
 */
export function extractTextFromContent(content: ContentBlock[]): string | undefined {
  const textParts: string[] = [];
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") {
      textParts.push(block.text);
    }
  }
  return textParts.length > 0 ? textParts.join("\n") : undefined;
}

/**
 * Replace text in content block array.
 * Modifies the first text block's text in-place and returns { content } for
 * the tool_result handler return format, or undefined if no modification needed.
 */
function replaceTextInContent(content: ContentBlock[], newText: string): { content: ContentBlock[] } | undefined {
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") {
      if (block.text === newText) return undefined; // No change
      block.text = newText;
      return { content };
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Layer 1: tool_result Truncation
// ---------------------------------------------------------------------------

/**
 * Truncate a read tool result to a line limit.
 * Keeps first half and last half of lines, inserting a truncation notice.
 */
export function truncateReadResult(content: ContentBlock[], lineLimit: number): { content: ContentBlock[] } | undefined {
  const text = extractTextFromContent(content);
  if (!text) return undefined;

  const lines = text.split("\n");
  if (lines.length <= lineLimit) return undefined; // Under limit, passthrough

  const headCount = Math.ceil(lineLimit / 2);
  const tailCount = Math.floor(lineLimit / 2);

  const head = lines.slice(0, headCount);
  const tail = lines.slice(-tailCount);
  const truncatedCount = lines.length - headCount - tailCount;
  const startLine = headCount + 1; // 1-indexed
  const endLine = lines.length - tailCount;

  const notice =
    `\n[... ${truncatedCount} lines truncated (lines ${startLine}–${endLine}). ` +
    `Use read with offset=${startLine}&limit=${truncatedCount} for specific sections ...]\n`;

  const newText = [...head, notice, ...tail].join("\n");
  return replaceTextInContent(content, newText);
}

/**
 * Truncate a bash tool result to a character limit.
 * Keeps first half and last half of characters, inserting a truncation notice.
 */
export function truncateBashResult(content: ContentBlock[], charLimit: number): { content: ContentBlock[] } | undefined {
  const text = extractTextFromContent(content);
  if (!text) return undefined;

  if (text.length <= charLimit) return undefined; // Under limit, passthrough

  const headCount = Math.ceil(charLimit / 2);
  const tailCount = Math.floor(charLimit / 2);

  const head = text.slice(0, headCount);
  const tail = text.slice(-tailCount);
  const truncatedCount = text.length - headCount - tailCount;

  const notice =
    `\n[... ${truncatedCount} chars truncated. ` +
    `Pipe through head/tail for specific sections ...]\n`;

  const newText = head + notice + tail;
  return replaceTextInContent(content, newText);
}

/**
 * Truncate a grep tool result to a line limit.
 * Keeps only the FIRST N lines (grep results are ordered by relevance).
 */
export function truncateGrepResult(content: ContentBlock[], lineLimit: number): { content: ContentBlock[] } | undefined {
  const text = extractTextFromContent(content);
  if (!text) return undefined;

  const lines = text.split("\n");
  if (lines.length <= lineLimit) return undefined; // Under limit, passthrough

  const head = lines.slice(0, lineLimit);
  const truncatedCount = lines.length - lineLimit;

  const notice =
    `\n[... ${truncatedCount} more matches. ` +
    `Use grep with more specific patterns or find with path filters ...]\n`;

  const newText = head.join("\n") + notice;
  return replaceTextInContent(content, newText);
}

// ---------------------------------------------------------------------------
// Layer 2: Context Event Pruning
// ---------------------------------------------------------------------------

/**
 * Minimal message type for context pruning.
 */
export interface PrunableMessage {
  role: string;
  content?: string | Array<{ type: string; text?: string }>;
  toolName?: string;
  toolCallId?: string;
}

/**
 * Prune old tool results from the conversation history.
 * Replaces toolResult messages older than `pruneAge` assistant turns
 * with compact summaries. Never prunes user, assistant, or toolCall messages.
 */
export function pruneOldToolResults(messages: PrunableMessage[], pruneAge: number): PrunableMessage[] {
  if (pruneAge <= 0) return messages;

  // Count assistant turns from the end of the conversation
  let assistantTurnsFromEnd = 0;
  let pruneBoundaryIndex = messages.length;

  // Walk backwards to find the index boundary beyond which we prune
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") {
      assistantTurnsFromEnd++;
      if (assistantTurnsFromEnd >= pruneAge) {
        pruneBoundaryIndex = i;
        break;
      }
    }
  }

  // If we haven't accumulated enough assistant turns, don't prune anything
  if (assistantTurnsFromEnd < pruneAge) return messages;

  // Prune toolResult messages before the boundary
  const result: PrunableMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (i < pruneBoundaryIndex && msg.role === "toolResult") {
      const toolName = msg.toolName ?? "unknown";
      const originalText = extractMessageText(msg);
      const preview = originalText.length > 80
        ? originalText.slice(0, 77) + "..."
        : originalText;

      result.push({
        ...msg,
        content: `[Pruned: ${toolName} → ${preview}]`,
      });
    } else {
      result.push(msg);
    }
  }

  return result;
}

/** Extract text from a message's content field. */
export function extractMessageText(msg: PrunableMessage): string {
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text!)
      .join("\n");
  }
  return "";
}

// ---------------------------------------------------------------------------
// Layer 3: Subagent-Aware Compaction Summary Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the task summary from the conversation.
 */
export function extractTaskSummary(messages: PrunableMessage[]): string {
  for (const msg of messages) {
    if (msg.role === "user") {
      const text = extractMessageText(msg);
      const firstLine = text.split("\n")[0]?.trim() ?? "";
      return firstLine.length > 200 ? firstLine.slice(0, 197) + "..." : firstLine;
    }
  }
  return "Unknown task";
}

/**
 * Extract the list of files modified via edit/write tool calls.
 */
export function extractFilesModified(messages: PrunableMessage[]): string[] {
  const files = new Set<string>();

  for (const msg of messages) {
    if (msg.role !== "toolCall") continue;
    const text = extractMessageText(msg);
    if (!text) continue;

    const editMatch = text.match(/"path"\s*:\s*"([^"]+)"/);
    if (editMatch) {
      files.add(editMatch[1]);
    }
  }

  return Array.from(files);
}

/**
 * Extract the current step indicator from recent assistant messages.
 */
export function extractCurrentStep(messages: PrunableMessage[]): string {
  const recentAssistant: string[] = [];
  for (let i = messages.length - 1; i >= 0 && recentAssistant.length < 3; i--) {
    if (messages[i].role === "assistant") {
      const text = extractMessageText(messages[i]);
      if (text) recentAssistant.unshift(text);
    }
  }

  const combined = recentAssistant.join(" ");

  const stepPatterns = [
    /writing\s+(tests|implementation)\s+for\s+["']?([^"'\n]+)["']?/i,
    /implementing\s+["']?([^"'\n]+)["']?/i,
    /running\s+(tests|validation)/i,
    /(RED|GREEN|REFACTOR)\s+(phase|step)/i,
    /fixing\s+["']?([^"'\n]+)["']?/i,
    /reviewing\s+implementation/i,
  ];

  for (const pattern of stepPatterns) {
    const match = combined.match(pattern);
    if (match) return match[0].slice(0, 100);
  }

  return "In progress";
}

// ---------------------------------------------------------------------------
// Guard Registration
//
// NOTE: This function registers Pi event handlers for the subagent context
// guard. It must be called from within session-start.ts (where `ctx.pi` has
// the correct ExtensionAPI type that resolves the handler overloads).
// The pure functions above are exported for direct unit testing.
// ---------------------------------------------------------------------------

import type { HandlerContext } from "../handlers/types.ts";

/** Register the subagent context guard handlers. */
export function registerSubagentContextGuard(ctx: HandlerContext): void {
  // If we're not in subagent-guard mode, do nothing
  if (ctx.piCoderMode !== "subagent-guard") return;

  const childAgent = process.env.PI_SUBAGENT_CHILD_AGENT ?? "unknown";
  const config = ctx.config;
  const guardConfig = config?.subagentContextGuard;

  // If guard is explicitly disabled, skip registration
  if (guardConfig?.enabled === false) return;

  const limits = resolveLimits(config, childAgent);

  // --- Layer 1: tool_result truncation ---
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (ctx.pi as any).on("tool_result", async (event: { toolName: string; content: ContentBlock[]; details?: unknown }) => {
    if (ctx.piCoderMode !== "subagent-guard") return;

    const { toolName, content } = event;

    if (!Array.isArray(content)) return;

    if (toolName === "read") {
      const result = truncateReadResult(content, limits.readLineLimit);
      if (result) {
        ctx.logEvent("guard_truncated", {
          toolName,
          childAgent,
          limit: limits.readLineLimit,
          limitType: "lines",
        });
      }
      return result;
    }

    if (toolName === "bash") {
      const result = truncateBashResult(content, limits.bashCharLimit);
      if (result) {
        ctx.logEvent("guard_truncated", {
          toolName,
          childAgent,
          limit: limits.bashCharLimit,
          limitType: "chars",
        });
      }
      return result;
    }

    if (toolName === "grep") {
      const result = truncateGrepResult(content, limits.grepResultLimit);
      if (result) {
        ctx.logEvent("guard_truncated", {
          toolName,
          childAgent,
          limit: limits.grepResultLimit,
          limitType: "lines",
        });
      }
      return result;
    }

    // Not a truncatable tool — passthrough
    return undefined;
  });

  // --- Layer 2: context event pruning ---
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (ctx.pi as any).on("context", async (event: { messages: PrunableMessage[] }) => {
    if (ctx.piCoderMode !== "subagent-guard") return;
    if (limits.contextPruneTurns <= 0) return;

    const messages = event.messages;
    if (!Array.isArray(messages) || messages.length === 0) return;

    const pruned = pruneOldToolResults(messages, limits.contextPruneTurns);

    let wasPruned = false;
    for (let i = 0; i < pruned.length; i++) {
      if (i < messages.length) {
        const origText = extractMessageText(messages[i]);
        const newText = extractMessageText(pruned[i]);
        if (origText !== newText && newText.startsWith("[Pruned:")) {
          wasPruned = true;
          break;
        }
      }
    }

    if (wasPruned) {
      ctx.logEvent("guard_context_pruned", {
        childAgent,
        pruneAge: limits.contextPruneTurns,
        messageCount: messages.length,
      });
    }

    return { messages: pruned };
  });

  // --- Layer 3: session_before_compact handler ---
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (ctx.pi as any).on("session_before_compact", async (event: { preparation: { messagesToSummarize: PrunableMessage[]; previousSummary?: string; firstKeptEntryId?: string; tokensBefore?: number } }) => {
    if (ctx.piCoderMode !== "subagent-guard") return;

    const messages = event.preparation?.messagesToSummarize ?? [];
    const taskSummary = extractTaskSummary(messages);
    const filesModified = extractFilesModified(messages);
    const currentStep = extractCurrentStep(messages);

    ctx.logEvent("guard_compaction_summary", {
      childAgent,
      taskSummary: taskSummary.slice(0, 100),
      filesModifiedCount: filesModified.length,
      currentStep: currentStep.slice(0, 100),
    });

    return {
      compaction: {
        summary: [
          "# Subagent Session Context (CRITICAL — preserve across compaction)",
          "",
          `## Agent: ${childAgent}`,
          `## Task: ${taskSummary}`,
          `## Files Modified: ${filesModified.join(", ") || "none"}`,
          `## Current Step: ${currentStep}`,
          "",
          "Files already read are available via the read tool with offset/limit.",
          "Do NOT re-read entire files - use targeted reads for specific sections.",
        ].join("\n"),
      },
    };
  });
}
