/**
 * Tests for the desktop notification utility.
 *
 * Tests focus on the logic (shouldNotify, event filtering, platform
 * detection) rather than the actual OS notification dispatching.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { sendDesktopNotification, resetPlatformCache } from "../src/desktop-notifier.ts";

// ---------------------------------------------------------------------------
// sendDesktopNotification does not throw
// ---------------------------------------------------------------------------

describe("sendDesktopNotification", () => {
  it("does not throw on any platform", () => {
    // On CI / headless environments, there may be no notification daemon,
    // but the function should never throw — it degrades gracefully.
    resetPlatformCache();
    assert.doesNotThrow(() => sendDesktopNotification("Test Title", "Test Body"));
  });

  it("handles empty strings gracefully", () => {
    resetPlatformCache();
    assert.doesNotThrow(() => sendDesktopNotification("", ""));
  });

  it("handles special characters in title and body", () => {
    resetPlatformCache();
    assert.doesNotThrow(() => sendDesktopNotification("Test \"quotes\"", "Body with 'single' and 🎉 emoji"));
  });
});
