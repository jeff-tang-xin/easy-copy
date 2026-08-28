import { useState, useCallback, useRef, useEffect } from "react";

/**
 * Shared toast hook used by every window in Easy-Copy.
 *
 * Behaviour:
 *   - `showToast(msg)` enqueues a message; multiple toasts in quick
 *     succession are de-duplicated so spamming the same text doesn't
 *     refresh its own timer and outlast the user's patience.
 *   - Each toast auto-dismisses after `duration` ms (default 2500).
 *   - The returned `toast` value is always the most recent message;
 *     the existing simple single-slot model from App.tsx is preserved
 *     so the four windows render the same `.toast` CSS class.
 *
 * The reason for keeping the API tiny (msg, type) rather than a full
 * stack of toasts: this project only ever shows ONE toast at a time
 * per window. A multi-toast queue would be over-engineering and would
 * require new CSS for stacking.
 */
export type ToastKind = "success" | "error";

export interface ToastState {
  msg: string;
  type: ToastKind;
}

export interface UseToastReturn {
  toast: ToastState | null;
  showToast: (msg: string, type?: ToastKind) => void;
}

export function useToast(duration: number = 2500): UseToastReturn {
  const [toast, setToast] = useState<ToastState | null>(null);
  const timerRef = useRef<number | null>(null);

  const clearTimer = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  useEffect(() => clearTimer, []);

  const showToast = useCallback(
    (msg: string, type: ToastKind = "success") => {
      setToast((cur) => (cur?.msg === msg && cur.type === type ? cur : { msg, type }));
      clearTimer();
      timerRef.current = window.setTimeout(() => {
        setToast((cur) => (cur?.msg === msg ? null : cur));
        timerRef.current = null;
      }, duration);
    },
    [duration],
  );

  return { toast, showToast };
}
