/**
 * Pi Coder V1 — UI Formatting Helpers
 *
 * Pure formatting functions for UI display.
 * Extracted from extensions/index.ts for testability.
 */

/** Format duration from ms to human-readable string. */
export function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  return `${mins}m${remSecs}s`;
}

/** Format token count to human-readable. */
export function formatTokenCount(tokens: number): string {
  if (tokens < 1000) return `${tokens}`;
  if (tokens < 1000000) return `${(tokens / 1000).toFixed(1)}k`;
  return `${(tokens / 1000000).toFixed(1)}M`;
}
