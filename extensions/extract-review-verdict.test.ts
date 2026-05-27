/**
 * Tests for extractReviewVerdict — parses reviewer subagent output
 * to determine verdict, fix type, and issue counts.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractReviewVerdict } from "./index.ts";

// ---------------------------------------------------------------------------
// pi-subagents Details format
// ---------------------------------------------------------------------------

describe("extractReviewVerdict — pi-subagents Details format", () => {
  it("extracts approved verdict from finalOutput with ✅", () => {
    const result = extractReviewVerdict({
      mode: "single",
      results: [{ finalOutput: "## Verdict\n\n✅ Approved — code looks good" }],
    });
    assert.deepEqual(result, {
      verdict: "approved",
      fixType: null,
      issueCount: 0,
      highSeverityCount: 0,
    });
  });

  it("extracts needs_changes verdict from finalOutput with ⚠️", () => {
    const result = extractReviewVerdict({
      mode: "single",
      results: [{ finalOutput: "## Verdict\n\n⚠️ Needs Changes — missing error handling" }],
    });
    assert.deepEqual(result, {
      verdict: "needs_changes",
      fixType: null,
      issueCount: 0,
      highSeverityCount: 0,
    });
  });

  it("extracts request_changes verdict from finalOutput with ❌", () => {
    const result = extractReviewVerdict({
      mode: "single",
      results: [{ finalOutput: "## Verdict\n\n❌ Request Changes — fundamental design flaw" }],
    });
    assert.deepEqual(result, {
      verdict: "request_changes",
      fixType: null,
      issueCount: 0,
      highSeverityCount: 0,
    });
  });

  it("extracts fixType from finalOutput", () => {
    const result = extractReviewVerdict({
      mode: "single",
      results: [{ finalOutput: "## Verdict\n\n⚠️ Needs Changes\nFix type: non-functional\n🟡 Minor naming issue" }],
    });
    assert.equal(result?.verdict, "needs_changes");
    assert.equal(result?.fixType, "non-functional");
    assert.equal(result?.issueCount, 1);
  });

  it("extracts functional fixType", () => {
    const result = extractReviewVerdict({
      mode: "single",
      results: [{ finalOutput: "## Verdict\n\n⚠️ Needs Changes\nFix type: functional\n🔴 Auth bypass found" }],
    });
    assert.equal(result?.verdict, "needs_changes");
    assert.equal(result?.fixType, "functional");
    assert.equal(result?.highSeverityCount, 1);
  });

  it("handles underscore variant of non_functional in fixType", () => {
    const result = extractReviewVerdict({
      mode: "single",
      results: [{ finalOutput: "⚠️ Needs Changes\nFix type: non_functional" }],
    });
    assert.equal(result?.fixType, "non-functional");
  });

  it("counts severity markers correctly", () => {
    const result = extractReviewVerdict({
      mode: "single",
      results: [{ finalOutput: "⚠️ Issues:\n🔴 Critical bug\n🔴 Another critical\n🟠 Medium issue\n🟡 Low issue" }],
    });
    assert.equal(result?.issueCount, 4);
    assert.equal(result?.highSeverityCount, 2);
  });

  it("returns null when finalOutput is not a string", () => {
    const result = extractReviewVerdict({
      mode: "single",
      results: [{ finalOutput: 42 }],
    });
    assert.equal(result, null);
  });

  it("returns null when results array is empty", () => {
    const result = extractReviewVerdict({
      mode: "single",
      results: [],
    });
    assert.equal(result, null);
  });
});

// ---------------------------------------------------------------------------
// Content string format (fallback)
// ---------------------------------------------------------------------------

describe("extractReviewVerdict — string content fallback", () => {
  it("extracts approved from content string with ✅", () => {
    const result = extractReviewVerdict({
      content: "## Review\n\n✅ Approved — all good",
    });
    assert.equal(result?.verdict, "approved");
  });

  it("extracts needs_changes from content string with ⚠️", () => {
    const result = extractReviewVerdict({
      content: "⚠️ Needs Changes — fix the error handling",
    });
    assert.equal(result?.verdict, "needs_changes");
  });
});

// ---------------------------------------------------------------------------
// Content array format (tool result)
// ---------------------------------------------------------------------------

describe("extractReviewVerdict — content array format", () => {
  it("extracts verdict from array of content blocks", () => {
    const result = extractReviewVerdict({
      content: [
        { type: "text", text: "## Verdict\n\n❌ Request Changes — rewrite needed" },
      ],
    });
    assert.equal(result?.verdict, "request_changes");
  });

  it("joins multiple text blocks", () => {
    const result = extractReviewVerdict({
      content: [
        { type: "text", text: "⚠️ Needs Changes" },
        { type: "text", text: "\nFix type: functional" },
      ],
    });
    assert.equal(result?.verdict, "needs_changes");
    assert.equal(result?.fixType, "functional");
  });

  it("ignores non-text content blocks", () => {
    const result = extractReviewVerdict({
      content: [
        { type: "image", data: "..." },
        { type: "text", text: "✅ Approved" },
      ],
    });
    assert.equal(result?.verdict, "approved");
  });
});

// ---------------------------------------------------------------------------
// Text-pattern fallbacks (no emoji)
// ---------------------------------------------------------------------------

describe("extractReviewVerdict — text pattern fallbacks", () => {
  it("matches 'approved' in first 500 chars (case-insensitive)", () => {
    const result = extractReviewVerdict({
      content: "Verdict: Approved — implementation meets all criteria",
    });
    assert.equal(result?.verdict, "approved");
  });

  it("matches 'needs changes' in first 500 chars", () => {
    const result = extractReviewVerdict({
      content: "Verdict: Needs Changes — missing input validation",
    });
    assert.equal(result?.verdict, "needs_changes");
  });

  it("matches 'request changes' in first 500 chars", () => {
    const result = extractReviewVerdict({
      content: "Verdict: Request Changes — architecture not aligned with spec",
    });
    assert.equal(result?.verdict, "request_changes");
  });

  it("does NOT match 'approved' after first 500 chars", () => {
    const padding = "x".repeat(501);
    const result = extractReviewVerdict({
      content: padding + "approved",
    });
    assert.equal(result, null);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("extractReviewVerdict — edge cases", () => {
  it("returns null for null input", () => {
    assert.equal(extractReviewVerdict(null), null);
  });

  it("returns null for undefined input", () => {
    assert.equal(extractReviewVerdict(undefined), null);
  });

  it("returns null for string input", () => {
    assert.equal(extractReviewVerdict("just a string"), null);
  });

  it("returns null for empty object", () => {
    assert.equal(extractReviewVerdict({}), null);
  });

  it("returns null when verdict cannot be determined", () => {
    assert.equal(extractReviewVerdict({
      content: "The code looks fine to me, no issues found.",
    }), null);
  });

  it("fixType is null for approved verdict even if present in text", () => {
    const result = extractReviewVerdict({
      content: "✅ Approved\nFix type: functional",
    });
    assert.equal(result?.verdict, "approved");
    assert.equal(result?.fixType, null);
  });

  it("returns null when text is empty", () => {
    const result = extractReviewVerdict({
      results: [{ finalOutput: "" }],
    });
    assert.equal(result, null);
  });

  it("prefers emoji over text pattern matching", () => {
    // Both emojis are present — ✅ wins for approved
    const result = extractReviewVerdict({
      content: "✅ Approved based on review",
    });
    assert.equal(result?.verdict, "approved");
  });
});
