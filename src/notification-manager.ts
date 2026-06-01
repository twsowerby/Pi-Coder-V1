/**
 * Pi Coder V1 — Notification Manager
 *
 * Handles desktop notification dispatch based on config.
 * Extracted from extensions/index.ts for testability.
 */

import type { PiCoderConfig } from "./types.ts";
import { sendDesktopNotification } from "./desktop-notifier.ts";

/**
 * Check if a notification event should fire based on config.
 * If config.notifications.events is not set, all events are enabled.
 */
export function shouldNotify(config: PiCoderConfig, event: string): boolean {
  if (!config.notifications.enabled) return false;
  const allowed = config.notifications.events;
  if (!allowed) return true; // default: all events
  return allowed.includes(event as any);
}

/**
 * Send a desktop notification if the event is configured.
 */
export function notify(config: PiCoderConfig, event: string, title: string, body: string): void {
  if (shouldNotify(config, event)) {
    sendDesktopNotification(title, body);
  }
}
