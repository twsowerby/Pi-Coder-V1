/**
 * Unit tests for subagent-context-guard.ts pure functions.
 *
 * These test the truncation, pruning, and extraction logic
 * without needing a Pi extension context.
 */

import { describe, it, expect } from "vitest";
import {
  resolveLimits,
  truncateReadResult,
  truncateBashResult,
  truncateGrepResult,
  pruneOldToolResults,
  extractMessageText,
  extractTaskSummary,
  extractFilesModified,
  extractCurrentStep,
  extractTextFromContent,
  type ContentBlock,
  type PrunableMessage,
} from "../subagent-context-guard.ts";
import type { PiCoderConfig } from "../../types.ts";

// ---------------------------------------------------------------------------
// resolveLimits
// ---------------------------------------------------------------------------

describe("resolveLimits", () => {
  const baseConfig: PiCoderConfig = {
    testCommand: "npm test",
    maxLoops: 5,
    createBranch: true,
    mergeBranch: "merge",
    branchPrefix: "pi-coder/",
    interviewTimeout: 0,
    nudge: { enabled: true, defaults: { turnsBeforeNudge: 1, escalationLevels: 3 }, states: {} },
    logging: { enabled: false, level: "standard", maxLogFiles: 10 },
    subagentControl: { enabled: true },
    notifications: { enabled: false },
    retryEscalation: { maxRetries: 10, enrichedSteerThreshold: 4, replanThreshold: 7 },
    subagentContextGuard: {
      enabled: true,
      readLineLimit: 200,
      bashCharLimit: 5000,
      grepResultLimit: 50,
      contextPruneTurns: 4,
    },
  };

  it("returns global defaults when no overrides", () => {
    const limits = resolveLimits(baseConfig, "pi-coder.implementor");
    expect(limits.readLineLimit).toBe(200);
    expect(limits.bashCharLimit).toBe(5000);
    expect(limits.grepResultLimit).toBe(50);
    expect(limits.contextPruneTurns).toBe(4);
  });

  it("applies per-agent overrides", () => {
    const config: PiCoderConfig = {
      ...baseConfig,
      subagentContextGuard: {
        ...baseConfig.subagentContextGuard!,
        agentOverrides: {
          implementor: { readLineLimit: 150, bashCharLimit: 3000 },
        },
      },
    };
    const limits = resolveLimits(config, "pi-coder.implementor");
    expect(limits.readLineLimit).toBe(150);
    expect(limits.bashCharLimit).toBe(3000);
    // grepResultLimit falls back to global
    expect(limits.grepResultLimit).toBe(50);
  });

  it("uses defaults when guard config is missing", () => {
    const config: PiCoderConfig = { ...baseConfig, subagentContextGuard: undefined };
    const limits = resolveLimits(config, "pi-coder.researcher");
    expect(limits.readLineLimit).toBe(200);
    expect(limits.bashCharLimit).toBe(5000);
  });
});

// ---------------------------------------------------------------------------
// truncateReadResult
// ---------------------------------------------------------------------------

describe("truncateReadResult", () => {
  it("returns undefined when content is under line limit", () => {
    const content: ContentBlock[] = [{ type: "text", text: "line1\nline2\nline3" }];
    const result = truncateReadResult(content, 10);
    expect(result).toBeUndefined();
  });

  it("truncates read result to head + tail with notice", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
    const content: ContentBlock[] = [{ type: "text", text: lines.join("\n") }];
    const result = truncateReadResult(content, 10);

    expect(result).toBeDefined();
    const text = result!.content[0].text!;
    // Should have 5 head lines + notice + 5 tail lines
    expect(text).toContain("90 lines truncated");
    expect(text).toContain("line 1");
    expect(text).toContain("line 5");
    expect(text).toContain("line 96");
    expect(text).toContain("line 100");
    // Should NOT contain middle lines
    expect(text).not.toContain("line 50");
  });

  it("skips non-text content blocks", () => {
    const content: ContentBlock[] = [{ type: "image", text: undefined as unknown as string }];
    const result = truncateReadResult(content, 10);
    expect(result).toBeUndefined();
  });

  it("handles empty content array", () => {
    const result = truncateReadResult([], 10);
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// truncateBashResult
// ---------------------------------------------------------------------------

describe("truncateBashResult", () => {
  it("returns undefined when content is under char limit", () => {
    const content: ContentBlock[] = [{ type: "text", text: "short output" }];
    const result = truncateBashResult(content, 100);
    expect(result).toBeUndefined();
  });

  it("truncates bash result to head + tail with notice", () => {
    const longText = "A".repeat(10000);
    const content: ContentBlock[] = [{ type: "text", text: longText }];
    const result = truncateBashResult(content, 1000);

    expect(result).toBeDefined();
    const text = result!.content[0].text!;
    expect(text).toContain("chars truncated");
    // Head: ~500 chars, Tail: ~500 chars, Notice: ~80 chars
    expect(text.length).toBeLessThan(2000);
  });
});

// ---------------------------------------------------------------------------
// truncateGrepResult
// ---------------------------------------------------------------------------

describe("truncateGrepResult", () => {
  it("returns undefined when content is under line limit", () => {
    const content: ContentBlock[] = [{ type: "text", text: "file1.ts:10:match\nfile2.ts:20:match" }];
    const result = truncateGrepResult(content, 10);
    expect(result).toBeUndefined();
  });

  it("truncates grep result keeping first N lines", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `file.ts:${i + 1}:match`);
    const content: ContentBlock[] = [{ type: "text", text: lines.join("\n") }];
    const result = truncateGrepResult(content, 10);

    expect(result).toBeDefined();
    const text = result!.content[0].text!;
    expect(text).toContain("90 more matches");
    expect(text).toContain("file.ts:1:match");
    expect(text).toContain("file.ts:10:match");
    expect(text).not.toContain("file.ts:11:match");
  });
});

// ---------------------------------------------------------------------------
// pruneOldToolResults
// ---------------------------------------------------------------------------

describe("pruneOldToolResults", () => {
  it("returns messages unchanged when pruneAge is 0", () => {
    const messages: PrunableMessage[] = [
      { role: "toolResult", toolName: "read", content: "big file content" },
      { role: "assistant", content: "I see the file" },
    ];
    const result = pruneOldToolResults(messages, 0);
    expect(result).toEqual(messages);
  });

  it("returns messages unchanged when not enough assistant turns", () => {
    const messages: PrunableMessage[] = [
      { role: "toolResult", toolName: "read", content: "content" },
      { role: "assistant", content: "ok" },
    ];
    const result = pruneOldToolResults(messages, 5);
    expect(result).toEqual(messages);
  });

  it("prunes old toolResult messages but keeps recent ones", () => {
    const messages: PrunableMessage[] = [
      { role: "toolResult", toolName: "read", content: "old read 1" },
      { role: "assistant", content: "analysis 1" },
      { role: "toolResult", toolName: "bash", content: "old bash 1" },
      { role: "assistant", content: "analysis 2" },
      { role: "toolResult", toolName: "read", content: "recent read" },
      { role: "assistant", content: "analysis 3" },
      { role: "user", content: "next prompt" },
    ];

    const result = pruneOldToolResults(messages, 2);

    // First toolResult (index 0) should be pruned (more than 2 assistant turns from end)
    // Second toolResult (index 2) should be right at the boundary
    // Third toolResult (index 4) should be kept
    const prunedCount = result.filter(m =>
      typeof m.content === "string" && m.content.startsWith("[Pruned:")
    ).length;
    expect(prunedCount).toBeGreaterThanOrEqual(1);

    // Recent read should be preserved intact
    const recentRead = result.find(m =>
      m.role === "toolResult" && typeof m.content === "string" && m.content === "recent read"
    );
    expect(recentRead).toBeDefined();
  });

  it("never prunes user or assistant messages", () => {
    const messages: PrunableMessage[] = [
      { role: "toolResult", toolName: "read", content: "old content" },
      { role: "assistant", content: "analysis 1" },
      { role: "toolResult", toolName: "bash", content: "old bash" },
      { role: "assistant", content: "analysis 2" },
      { role: "user", content: "prompt" },
      { role: "assistant", content: "analysis 3" },
      { role: "user", content: "another prompt" },
    ];

    const result = pruneOldToolResults(messages, 2);

    for (const msg of result) {
      if (msg.role === "user" || msg.role === "assistant") {
        expect(typeof msg.content === "string" && !msg.content.startsWith("[Pruned:")).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// extractMessageText
// ---------------------------------------------------------------------------

describe("extractMessageText", () => {
  it("extracts string content", () => {
    expect(extractMessageText({ role: "user", content: "hello" })).toBe("hello");
  });

  it("extracts text from content blocks", () => {
    const msg: PrunableMessage = {
      role: "toolResult",
      content: [{ type: "text", text: "line 1" }, { type: "text", text: "line 2" }],
    };
    expect(extractMessageText(msg)).toBe("line 1\nline 2");
  });

  it("returns empty string for undefined content", () => {
    expect(extractMessageText({ role: "user" })).toBe("");
  });
});

// ---------------------------------------------------------------------------
// extractTaskSummary
// ---------------------------------------------------------------------------

describe("extractTaskSummary", () => {
  it("extracts first user message as task summary", () => {
    const messages: PrunableMessage[] = [
      { role: "assistant", content: "context" },
      { role: "user", content: "Implement the login feature for users" },
    ];
    expect(extractTaskSummary(messages)).toBe("Implement the login feature for users");
  });

  it("truncates long task summaries to 200 chars", () => {
    const messages: PrunableMessage[] = [
      { role: "user", content: "A".repeat(300) },
    ];
    const summary = extractTaskSummary(messages);
    expect(summary.length).toBe(200); // 197 + "..."
    expect(summary.endsWith("...")).toBe(true);
  });

  it("returns Unknown task when no user message", () => {
    const messages: PrunableMessage[] = [
      { role: "assistant", content: "hello" },
    ];
    expect(extractTaskSummary(messages)).toBe("Unknown task");
  });
});

// ---------------------------------------------------------------------------
// extractTextFromContent
// ---------------------------------------------------------------------------

describe("extractTextFromContent", () => {
  it("extracts text from text blocks", () => {
    const content: ContentBlock[] = [
      { type: "text", text: "hello" },
      { type: "text", text: "world" },
    ];
    expect(extractTextFromContent(content)).toBe("hello\nworld");
  });

  it("skips non-text blocks", () => {
    const content: ContentBlock[] = [
      { type: "image", text: undefined as unknown as string },
      { type: "text", text: "hello" },
    ];
    expect(extractTextFromContent(content)).toBe("hello");
  });

  it("returns undefined for empty array", () => {
    expect(extractTextFromContent([])).toBeUndefined();
  });
});
