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
export type ToastKind = "success" | "error" | "warning";

export interface ToastState {
  msg: string;
  type: ToastKind;
}

export interface UseToastReturn {
  toast: ToastState | null;
  showToast: (msg: string, type?: ToastKind, durationOverride?: number) => void;
}

/** Per-kind default durations. Errors carry the most information (a full
 * backend message, a path, a hint) and used to vanish in 2.5s — before
 * anyone finished reading them. Warnings sit in between. */
const KIND_DURATION_MS: Record<ToastKind, number> = {
  success: 2500,
  warning: 4000,
  error: 5000,
};

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
    (msg: string, type: ToastKind = "success", durationOverride?: number) => {
      // Explicit override wins; otherwise the kind decides. The `duration`
      // hook argument stays as the success baseline for call-site compat.
      const effective =
        durationOverride ?? (type === "success" ? duration : KIND_DURATION_MS[type]);
      setToast((cur) => (cur?.msg === msg && cur.type === type ? cur : { msg, type }));
      clearTimer();
      timerRef.current = window.setTimeout(() => {
        setToast((cur) => (cur?.msg === msg ? null : cur));
        timerRef.current = null;
      }, effective);
    },
    [duration],
  );

  return { toast, showToast };
}
