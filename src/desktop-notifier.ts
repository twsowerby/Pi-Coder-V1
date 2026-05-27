/**
 * Desktop notification utility for Pi Coder.
 *
 * Sends OS-level desktop notifications using the best available method:
 *   - OSC 777: Ghostty, iTerm2, WezTerm, rxvt-unicode
 *   - OSC 99: Kitty
 *   - notify-send: Linux (libnotify)
 *   - osascript: macOS (display notification)
 *   - PowerShell toast: Windows Terminal (WSL)
 *
 * Based on the pi notify.ts example extension.
 */

import { execFile } from "node:child_process";

// ---------------------------------------------------------------------------
// Platform detection
// ---------------------------------------------------------------------------

function detectPlatform(): "osc777" | "osc99" | "notify-send" | "osascript" | "windows-toast" {
  // Windows Terminal (WSL)
  if (process.env.WT_SESSION) {
    return "windows-toast";
  }
  // Kitty
  if (process.env.KITTY_WINDOW_ID) {
    return "osc99";
  }
  // macOS
  if (process.platform === "darwin") {
    return "osascript";
  }
  // Linux with libnotify
  if (process.platform === "linux") {
    return "notify-send";
  }
  // Fallback: OSC 777 (works in Ghostty, iTerm2, WezTerm, rxvt-unicode)
  return "osc777";
}

// ---------------------------------------------------------------------------
// Platform-specific senders
// ---------------------------------------------------------------------------

function notifyOSC777(title: string, body: string): void {
  process.stdout.write(`\x1b]777;notify;${title};${body}\x07`);
}

function notifyOSC99(title: string, body: string): void {
  // Kitty OSC 99: i=notification id, d=0 means not done yet, p=body for second part
  process.stdout.write(`\x1b]99;i=1:d=0;${title}\x1b\\`);
  process.stdout.write(`\x1b]99;i=1:p=body;${body}\x1b\\`);
}

function notifyNotifySend(title: string, body: string): void {
  try {
    execFile("notify-send", [title, body], (err) => {
      if (err) {
        // Fall back to OSC 777 if notify-send fails
        notifyOSC777(title, body);
      }
    });
  } catch {
    notifyOSC777(title, body);
  }
}

function notifyOsascript(title: string, body: string): void {
  try {
    // Escape double quotes in the body for AppleScript safety
    const safeBody = body.replace(/"/g, '\\"');
    const safeTitle = title.replace(/"/g, '\\"');
    execFile("osascript", [
      "-e",
      `display notification "${safeBody}" with title "${safeTitle}"`,
    ], (err) => {
      if (err) {
        // Fall back to OSC 777 if osascript fails
        notifyOSC777(title, body);
      }
    });
  } catch {
    notifyOSC777(title, body);
  }
}

function windowsToastScript(title: string, body: string): string {
  const type = "Windows.UI.Notifications";
  const mgr = `[${type}.ToastNotificationManager, ${type}, ContentType = WindowsRuntime]`;
  const template = `[${type}.ToastTemplateType]::ToastText01`;
  const toast = `[${type}.ToastNotification]::new($xml)`;
  return [
    `${mgr} > $null`,
    `$xml = [${type}.ToastNotificationManager]::GetTemplateContent(${template})`,
    `$xml.GetElementsByTagName('text')[0].AppendChild($xml.CreateTextNode('${body.replace(/'/g, "''")}')) > $null`,
    `[${type}.ToastNotificationManager]::CreateToastNotifier('${title.replace(/'/g, "''")}').Show(${toast})`,
  ].join("; ");
}

function notifyWindowsToast(title: string, body: string): void {
  try {
    execFile("powershell.exe", ["-NoProfile", "-Command", windowsToastScript(title, body)]);
  } catch {
    // No fallback on Windows
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

let _platform: ReturnType<typeof detectPlatform> | null = null;

/**
 * Send a desktop notification. Auto-detects the best available method.
 * Safe to call from any OS — no-ops if the platform isn't supported.
 */
export function sendDesktopNotification(title: string, body: string): void {
  if (!_platform) {
    _platform = detectPlatform();
  }

  switch (_platform) {
    case "osc99":
      notifyOSC99(title, body);
      break;
    case "notify-send":
      notifyNotifySend(title, body);
      break;
    case "osascript":
      notifyOsascript(title, body);
      break;
    case "windows-toast":
      notifyWindowsToast(title, body);
      break;
    case "osc777":
    default:
      notifyOSC777(title, body);
      break;
  }
}

/** Reset the cached platform detection (useful for testing). */
export function resetPlatformCache(): void {
  _platform = null;
}
