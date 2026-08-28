import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { UseToastReturn } from "./useToast";

/**
 * useWindowLifecycle — shared behaviour for every top-level window.
 *
 * Installs the common cross-cutting concerns that every window in the app
 * needs:
 *
 *   1. `onCloseRequested` → hide instead of destroy (so the window can be
 *      re-opened later via tray / hotkey).
 *   2. `shortcut-error` event → forward as an error toast. Without this,
 *      a hotkey the OS already had bound to another app would silently
 *      no-op and the user would have no idea why their key combination
 *      stopped working.
 *   3. Optional `clipboard-update` listener → fires the provided callback
 *      (the clipboard main window refreshes its list; other windows may
 *      update related UI, e.g. notes window marks "saved from clip").
 *
 * Previously every window reimplemented 2–3 of these inline with
 * slightly different error handling. Extracting them means:
 *   - Consistent behaviour across all 5 windows
 *   - One place to fix if the lifecycle contract changes
 *   - ~20 lines fewer boilerplate per window file
 */
export interface UseWindowLifecycleOptions {
  /** Toast helper for surfacing shortcut errors. */
  showToast: UseToastReturn["showToast"];
  /**
   * Optional callback fired on every `clipboard-update` event.
   * If not provided, the event is not subscribed to.
   */
  onClipboardUpdate?: () => void | Promise<void>;
  /**
   * Whether to intercept the close request and hide instead of destroy.
   * Default: true. Set to false for windows that really should close
   * (e.g. one-off dialogs, though those should use Modal instead).
   */
  hideOnClose?: boolean;
}

export function useWindowLifecycle({
  showToast,
  onClipboardUpdate,
  hideOnClose = true,
}: UseWindowLifecycleOptions): void {
  // ── 1. Hide on close ────────────────────────────────────────
  useEffect(() => {
    if (!hideOnClose) return;
    const win = getCurrentWindow();
    const unlisten = win.onCloseRequested((event) => {
      event.preventDefault();
      win.hide();
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [hideOnClose]);

  // ── 2. Shortcut error forwarding ────────────────────────────
  useEffect(() => {
    const unlisten = listen<string>("shortcut-error", (event) => {
      showToast(event.payload, "error");
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [showToast]);

  // ── 3. Clipboard update subscription (optional) ─────────────
  useEffect(() => {
    if (!onClipboardUpdate) return;
    const unlisten = listen("clipboard-update", () => {
      void onClipboardUpdate();
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [onClipboardUpdate]);
}
