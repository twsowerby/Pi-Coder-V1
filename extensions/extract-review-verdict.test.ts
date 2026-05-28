/**
 * Tests for extractReviewVerdict — parses reviewer subagent output
 * to determine verdict, fix type, and issue counts.
 *
 * Updated for ---VERDICT--- block format (primary) with emoji/text fallback.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractReviewVerdict } from "./index.ts";

// ---------------------------------------------------------------------------
// ---VERDICT--- block format (primary)
// ---------------------------------------------------------------------------

describe("extractReviewVerdict — ---VERDICT--- block format", () => {
  it("extracts approved verdict from ---VERDICT--- block", () => {
    const result = extractReviewVerdict({
      mode: "single",
      results: [{ finalOutput: "Review analysis...\n\n---VERDICT---\nVERDICT: approved\n---END VERDICT---" }],
    });
    assert.deepEqual(result, { verdict: "approved" });
  });

  it("extracts needs_changes verdict from ---VERDICT--- block with FIX_TYPE", () => {
    const result = extractReviewVerdict({
      mode: "single",
      results: [{ finalOutput: "Review analysis...\n\n---VERDICT---\nVERDICT: needs_changes\nFIX_TYPE: functional\n---END VERDICT---" }],
    });
    assert.equal(result?.verdict, "needs_changes");
    if (result?.verdict === "needs_changes") {
      assert.equal(result.fixType, "functional");
      assert.deepEqual(result.issues, []);
    }
  });

  it("extracts non-functional FIX_TYPE from ---VERDICT--- block", () => {
    const result = extractReviewVerdict({
      mode: "single",
      results: [{ finalOutput: "Review analysis...\n\n---VERDICT---\nVERDICT: needs_changes\nFIX_TYPE: non-functional\n---END VERDICT---" }],
    });
    assert.equal(result?.verdict, "needs_changes");
    if (result?.verdict === "needs_changes") {
      assert.equal(result.fixType, "non-functional");
      assert.deepEqual(result.issues, []);
    }
  });

  it("normalizes non_functional (underscore) to non-functional (hyphen) in ---VERDICT--- block", () => {
    const result = extractReviewVerdict({
      mode: "single",
      results: [{ finalOutput: "---VERDICT---\nVERDICT: needs_changes\nFIX_TYPE: non_functional\n---END VERDICT---" }],
    });
    assert.equal(result?.verdict, "needs_changes");
    if (result?.verdict === "needs_changes") {
      assert.equal(result.fixType, "non-functional");
      assert.deepEqual(result.issues, []);
    }
  });

  it("needs_changes without FIX_TYPE in block defaults to functional", () => {
    const result = extractReviewVerdict({
      mode: "single",
      results: [{ finalOutput: "---VERDICT---\nVERDICT: needs_changes\n---END VERDICT---" }],
    });
    assert.equal(result?.verdict, "needs_changes");
    if (result?.verdict === "needs_changes") {
      assert.equal(result.fixType, "functional"); // safe default
      assert.deepEqual(result.issues, []);
    }
  });

  it("---VERDICT--- block is case-insensitive for verdict value", () => {
    const result = extractReviewVerdict({
      mode: "single",
      results: [{ finalOutput: "---VERDICT---\nVERDICT: Approved\n---END VERDICT---" }],
    });
    assert.equal(result?.verdict, "approved");
  });

  it("---VERDICT--- block takes priority over emoji patterns", () => {
    // The block says approved but there are ⚠️ emojis in prose
    const result = extractReviewVerdict({
      mode: "single",
      results: [{ finalOutput: "⚠️ Some concerns but overall fine\n\n---VERDICT---\nVERDICT: approved\n---END VERDICT---" }],
    });
    assert.equal(result?.verdict, "approved");
  });

  it("---VERDICT--- block takes priority over text patterns", () => {
    const result = extractReviewVerdict({
      content: "The verdict is needs changes according to the text\n\n---VERDICT---\nVERDICT: approved\n---END VERDICT---",
    });
    assert.equal(result?.verdict, "approved");
  });

  it("approved verdict from block has only verdict field", () => {
    const result = extractReviewVerdict({
      content: "---VERDICT---\nVERDICT: approved\n---END VERDICT---",
    });
    assert.equal(result?.verdict, "approved");
    assert.deepEqual(Object.keys(result!), ["verdict"]);
  });
});

// ---------------------------------------------------------------------------
// Emoji fallback patterns
// ---------------------------------------------------------------------------

describe("extractReviewVerdict — emoji fallback patterns", () => {
  it("extracts approved verdict from finalOutput with ✅", () => {
    const result = extractReviewVerdict({
      mode: "single",
      results: [{ finalOutput: "## Verdict\n\n✅ Approved — code looks good" }],
    });
    assert.deepEqual(result, { verdict: "approved" });
  });

  it("extracts needs_changes verdict from finalOutput with ⚠️", () => {
    const result = extractReviewVerdict({
      mode: "single",
      results: [{ finalOutput: "## Verdict\n\n⚠️ Needs Changes — missing error handling" }],
    });
    assert.equal(result?.verdict, "needs_changes");
    if (result?.verdict === "needs_changes") {
      assert.equal(result.fixType, "functional"); // defaults to functional when missing
      assert.deepEqual(result.issues, []);
    }
  });

  it("extracts needs_changes verdict from finalOutput with ❌", () => {
    const result = extractReviewVerdict({
      mode: "single",
      results: [{ finalOutput: "## Verdict\n\n❌ Needs Changes — fundamental design flaw" }],
    });
    assert.equal(result?.verdict, "needs_changes");
  });

  it("extracts fixType from emoji-based review", () => {
    const result = extractReviewVerdict({
      mode: "single",
      results: [{ finalOutput: "## Verdict\n\n⚠️ Needs Changes\nFix type: non-functional\n🟡 Minor naming issue" }],
    });
    assert.equal(result?.verdict, "needs_changes");
    if (result?.verdict === "needs_changes") {
      assert.equal(result.fixType, "non-functional");
      assert.deepEqual(result.issues, []);
    }
  });

  it("extracts functional fixType from emoji-based review", () => {
    const result = extractReviewVerdict({
      mode: "single",
      results: [{ finalOutput: "## Verdict\n\n⚠️ Needs Changes\nFix type: functional\n🔴 Auth bypass found" }],
    });
    assert.equal(result?.verdict, "needs_changes");
    if (result?.verdict === "needs_changes") {
      assert.equal(result.fixType, "functional");
      assert.deepEqual(result.issues, []);
    }
  });

  it("handles underscore variant of non_functional in fixType (emoji fallback)", () => {
    const result = extractReviewVerdict({
      mode: "single",
      results: [{ finalOutput: "⚠️ Needs Changes\nFix type: non_functional" }],
    });
    assert.equal(result?.verdict, "needs_changes");
    if (result?.verdict === "needs_changes") {
      assert.equal(result.fixType, "non-functional");
    }
  });

  it("✅ in prose but ⚠️ verdict at end → returns needs_changes", () => {
    const result = extractReviewVerdict({
      content: "I did ✅ verify the tests pass, but there are some issues.\n\n**Verdict:** ⚠️ Needs Changes\nFix-Type: functional",
    });
    assert.equal(result?.verdict, "needs_changes");
  });

  it("⚠️ in prose but ✅ verdict at end → returns approved", () => {
    const result = extractReviewVerdict({
      content: "Note: ⚠️ this is a complex module. Overall the implementation is solid.\n\n**Verdict:** ✅ Approved",
    });
    assert.equal(result?.verdict, "approved");
  });
});

// ---------------------------------------------------------------------------
// Text pattern fallbacks (no emoji, no block)
// ---------------------------------------------------------------------------

describe("extractReviewVerdict — text pattern fallbacks", () => {
  it("matches '**Verdict:** Approved' structured format", () => {
    const result = extractReviewVerdict({
      content: "Some review text\n\n**Verdict:** Approved",
    });
    assert.equal(result?.verdict, "approved");
  });

  it("matches '**Verdict:** Needs Changes' structured format", () => {
    const result = extractReviewVerdict({
      content: "Some review text\n\n**Verdict:** Needs Changes\nFix-Type: functional",
    });
    assert.equal(result?.verdict, "needs_changes");
    if (result?.verdict === "needs_changes") {
      assert.equal(result.fixType, "functional");
    }
  });

  it("matches 'approved' in text (case-insensitive)", () => {
    const result = extractReviewVerdict({
      content: "Verdict: Approved — implementation meets all criteria",
    });
    assert.equal(result?.verdict, "approved");
  });

  it("matches 'needs changes' in text", () => {
    const result = extractReviewVerdict({
      content: "Verdict: Needs Changes — missing input validation",
    });
    assert.equal(result?.verdict, "needs_changes");
  });

  it("finds text-only verdict after 500 chars (no 500-char limit)", () => {
    const padding = "x".repeat(600);
    const result = extractReviewVerdict({
      content: padding + " approved",
    });
    assert.equal(result?.verdict, "approved");
  });
});

// ---------------------------------------------------------------------------
// Content format variations
// ---------------------------------------------------------------------------

describe("extractReviewVerdict — content format variations", () => {
  it("extracts verdict from array of content blocks", () => {
    const result = extractReviewVerdict({
      content: [
        { type: "text", text: "## Verdict\n\n❌ Needs Changes — rewrite needed" },
      ],
    });
    assert.equal(result?.verdict, "needs_changes");
  });

  it("joins multiple text blocks", () => {
    const result = extractReviewVerdict({
      content: [
        { type: "text", text: "⚠️ Needs Changes" },
        { type: "text", text: "\nFix type: functional" },
      ],
    });
    assert.equal(result?.verdict, "needs_changes");
    if (result?.verdict === "needs_changes") {
      assert.equal(result.fixType, "functional");
    }
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

  it("extracts ---VERDICT--- from content array", () => {
    const result = extractReviewVerdict({
      content: [
        { type: "text", text: "---VERDICT---\nVERDICT: approved\n---END VERDICT---" },
      ],
    });
    assert.equal(result?.verdict, "approved");
  });

  it("extracts from content string format", () => {
    const result = extractReviewVerdict({
      content: "---VERDICT---\nVERDICT: needs_changes\nFIX_TYPE: functional\n---END VERDICT---",
    });
    assert.equal(result?.verdict, "needs_changes");
    if (result?.verdict === "needs_changes") {
      assert.equal(result.fixType, "functional");
    }
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

  it("returns null when text is empty", () => {
    const result = extractReviewVerdict({
      results: [{ finalOutput: "" }],
    });
    assert.equal(result, null);
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

  it("approved verdict has no fixType (even if Fix-Type appears in text)", () => {
    const result = extractReviewVerdict({
      content: "✅ Approved\nFix type: functional",
    });
    assert.equal(result?.verdict, "approved");
    assert.deepEqual(Object.keys(result!), ["verdict"]);
  });

  it("needs_changes result has verdict, fixType, issues fields", () => {
    const result = extractReviewVerdict({
      content: "⚠️ Needs Changes\nFix-Type: functional",
    });
    assert.equal(result?.verdict, "needs_changes");
    if (result?.verdict === "needs_changes") {
      assert.equal(typeof result.fixType, "string");
      assert.equal(Array.isArray(result.issues), true);
    }
  });

  it("needs_changes without Fix-Type defaults to functional", () => {
    const result = extractReviewVerdict({
      content: "⚠️ Needs Changes — some issues found",
    });
    assert.equal(result?.verdict, "needs_changes");
    if (result?.verdict === "needs_changes") {
      assert.equal(result.fixType, "functional"); // safe default
    }
  });

  it("returns fallback for malformed ---VERDICT--- block (missing END)", () => {
    // When the block format doesn't match (missing END delimiter),
    // the function falls back to emoji/text patterns which may find
    // the word 'approved' in the text.
    const result = extractReviewVerdict({
      content: "---VERDICT---\nVERDICT: approved",
    });
    // The text pattern fallback finds 'approved' — this is expected behavior
    assert.equal(result?.verdict, "approved");
  });

  it("returns null for malformed ---VERDICT--- block (invalid verdict value)", () => {
    const result = extractReviewVerdict({
      content: "---VERDICT---\nVERDICT: maybe\n---END VERDICT---",
    });
    // Should fall through — "maybe" isn't a valid verdict
    assert.equal(result, null);
  });

  it("handles ---VERDICT--- block with trailing text after END delimiter", () => {
    const result = extractReviewVerdict({
      content: "---VERDICT---\nVERDICT: approved\n---END VERDICT---\n\nNote: See line 42 for the tricky part.",
    });
    assert.equal(result?.verdict, "approved");
  });
});
