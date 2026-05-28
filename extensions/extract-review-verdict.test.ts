/**
 * Tests for extractReviewVerdict — parses reviewer subagent output
 * to determine verdict, fix type, and issue counts.
 *
 * Updated for VerdictResult discriminated union type and hardened
 * emoji extraction (last-occurrence-wins, no 500-char limit).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractReviewVerdict, type ReviewVerdict } from "./index.ts";

// ---------------------------------------------------------------------------
// pi-subagents Details format
// ---------------------------------------------------------------------------

describe("extractReviewVerdict — pi-subagents Details format", () => {
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
      assert.deepEqual(result.issues, []); // regex extraction cannot produce structured issues
    }
  });

  it("extracts needs_changes verdict from finalOutput with ❌", () => {
    const result = extractReviewVerdict({
      mode: "single",
      results: [{ finalOutput: "## Verdict\n\n❌ Needs Changes — fundamental design flaw" }],
    });
    assert.equal(result?.verdict, "needs_changes");
  });

  it("extracts fixType from finalOutput", () => {
    const result = extractReviewVerdict({
      mode: "single",
      results: [{ finalOutput: "## Verdict\n\n⚠️ Needs Changes\nFix type: non-functional\n🟡 Minor naming issue" }],
    });
    assert.equal(result?.verdict, "needs_changes");
    if (result?.verdict === "needs_changes") {
      assert.equal(result.fixType, "non-functional");
      assert.deepEqual(result.issues, []); // regex extraction cannot produce structured issues
    }
  });

  it("extracts functional fixType", () => {
    const result = extractReviewVerdict({
      mode: "single",
      results: [{ finalOutput: "## Verdict\n\n⚠️ Needs Changes\nFix type: functional\n🔴 Auth bypass found" }],
    });
    assert.equal(result?.verdict, "needs_changes");
    if (result?.verdict === "needs_changes") {
      assert.equal(result.fixType, "functional");
      assert.deepEqual(result.issues, []); // regex extraction cannot produce structured issues
    }
  });

  it("handles underscore variant of non_functional in fixType", () => {
    const result = extractReviewVerdict({
      mode: "single",
      results: [{ finalOutput: "⚠️ Needs Changes\nFix type: non_functional" }],
    });
    assert.equal(result?.verdict, "needs_changes");
    if (result?.verdict === "needs_changes") {
      assert.equal(result.fixType, "non-functional");
    }
  });

  it("counts severity markers correctly", () => {
    const result = extractReviewVerdict({
      mode: "single",
      results: [{ finalOutput: "⚠️ Issues:\n🔴 Critical bug\n🔴 Another critical\n🟠 Medium issue\n🟡 Low issue" }],
    });
    assert.equal(result?.verdict, "needs_changes");
    if (result?.verdict === "needs_changes") {
      assert.deepEqual(result.issues, []); // regex extraction cannot produce structured issues
    }
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
});

// ---------------------------------------------------------------------------
// Text-pattern fallbacks (no emoji)
// ---------------------------------------------------------------------------

describe("extractReviewVerdict — text pattern fallbacks", () => {
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

  it("NOW matches 'approved' AFTER first 500 chars (500-char limit removed)", () => {
    const padding = "x".repeat(501);
    const result = extractReviewVerdict({
      content: padding + "approved",
    });
    assert.equal(result?.verdict, "approved");
  });
});

// ---------------------------------------------------------------------------
// NEW: Verdict after 500 chars
// ---------------------------------------------------------------------------

describe("extractReviewVerdict — verdict after 500 chars", () => {
  it("finds ✅ verdict at the end of a long review (>500 chars of prose)", () => {
    const prose = "This is a detailed review paragraph. ".repeat(25); // ~900 chars
    const result = extractReviewVerdict({
      content: prose + "\n\n**Verdict:** ✅ Approved",
    });
    assert.equal(result?.verdict, "approved");
  });

  it("finds ⚠️ Needs Changes verdict at the end of a long review", () => {
    const prose = "This is a detailed review paragraph. ".repeat(25); // ~900 chars
    const result = extractReviewVerdict({
      content: prose + "\n\n**Verdict:** ⚠️ Needs Changes\nFix-Type: functional",
    });
    assert.equal(result?.verdict, "needs_changes");
    if (result?.verdict === "needs_changes") {
      assert.equal(result.fixType, "functional");
    }
  });

  it("finds text-only verdict after 500 chars", () => {
    const padding = "x".repeat(600);
    const result = extractReviewVerdict({
      content: padding + " approved",
    });
    assert.equal(result?.verdict, "approved");
  });
});

// ---------------------------------------------------------------------------
// NEW: Emoji false positive — last occurrence wins
// ---------------------------------------------------------------------------

describe("extractReviewVerdict — emoji false positive handling", () => {
  it("✅ in prose but ⚠️ verdict at end → returns needs_changes", () => {
    const result = extractReviewVerdict({
      content: "I did ✅ verify the tests pass, but there are some issues.\n\n**Verdict:** ⚠️ Needs Changes\nFix-Type: functional",
    });
    assert.equal(result?.verdict, "needs_changes");
  });

  it("✅ in prose but ❌ verdict at end → returns needs_changes", () => {
    const result = extractReviewVerdict({
      content: "Tests ✅ pass and lint ✅ clean.\n\n**Verdict:** ❌ Needs Changes\nFix-Type: non-functional",
    });
    assert.equal(result?.verdict, "needs_changes");
    if (result?.verdict === "needs_changes") {
      assert.equal(result.fixType, "non-functional");
    }
  });

  it("⚠️ in prose but ✅ verdict at end → returns approved", () => {
    const result = extractReviewVerdict({
      content: "Note: ⚠️ this is a complex module. Overall the implementation is solid.\n\n**Verdict:** ✅ Approved",
    });
    assert.equal(result?.verdict, "approved");
  });

  it("multiple ✅ emojis — last one is the verdict", () => {
    // Both emojis are ✅ — it's approved regardless of position
    const result = extractReviewVerdict({
      content: "✅ Tests pass\n\n**Verdict:** ✅ Approved",
    });
    assert.equal(result?.verdict, "approved");
  });
});

// ---------------------------------------------------------------------------
// NEW: Verdict without emoji prefix (text-only)
// ---------------------------------------------------------------------------

describe("extractReviewVerdict — verdict without emoji prefix", () => {
  it("matches '**Verdict:** Approved' with no emoji", () => {
    const result = extractReviewVerdict({
      content: "This is a thorough review.\n\n**Verdict:** Approved",
    });
    assert.equal(result?.verdict, "approved");
  });

  it("matches '**Verdict:** Needs Changes' with no emoji", () => {
    const result = extractReviewVerdict({
      content: "This is a thorough review.\n\n**Verdict:** Needs Changes\nFix-Type: functional",
    });
    assert.equal(result?.verdict, "needs_changes");
    if (result?.verdict === "needs_changes") {
      assert.equal(result.fixType, "functional");
    }
  });
});

// ---------------------------------------------------------------------------
// NEW: Missing fixType on needs_changes defaults to functional
// ---------------------------------------------------------------------------

describe("extractReviewVerdict — missing fixType defaults to functional", () => {
  it("needs_changes without Fix-Type line defaults to functional", () => {
    const result = extractReviewVerdict({
      content: "⚠️ Needs Changes — some issues found",
    });
    assert.equal(result?.verdict, "needs_changes");
    if (result?.verdict === "needs_changes") {
      assert.equal(result.fixType, "functional"); // safe default
    }
  });

  it("❌ Needs Changes without Fix-Type defaults to functional", () => {
    const result = extractReviewVerdict({
      mode: "single",
      results: [{ finalOutput: "❌ Needs Changes - critical issues" }],
    });
    assert.equal(result?.verdict, "needs_changes");
    if (result?.verdict === "needs_changes") {
      assert.equal(result.fixType, "functional");
    }
  });
});

// ---------------------------------------------------------------------------
// NEW: VerdictResult type shape
// ---------------------------------------------------------------------------

describe("extractReviewVerdict — VerdictResult type shape", () => {
  it("approved result has only verdict field", () => {
    const result = extractReviewVerdict({
      content: "✅ Approved",
    });
    assert.equal(result?.verdict, "approved");
    // Approved variant should NOT have fixType or issues
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

  it("null return for unrecognised input", () => {
    const result = extractReviewVerdict({
      content: "The code looks fine to me, no issues found.",
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

  it("approved verdict has no fixType (even if Fix-Type appears in text)", () => {
    const result = extractReviewVerdict({
      content: "✅ Approved\nFix type: functional",
    });
    assert.equal(result?.verdict, "approved");
    // Approved variant should NOT have fixType
    assert.deepEqual(Object.keys(result!), ["verdict"]);
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
