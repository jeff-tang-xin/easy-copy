import { useCallback, useEffect, useRef } from "react";

/**
 * Debounce a callback so the wrapped function only fires after `delayMs`
 * of inactivity. The latest args always win — earlier calls are dropped.
 *
 * The returned function is stable across renders (same reference), so
 * passing it as a prop or listing it in a `useEffect` dep array won't
 * cause unnecessary re-renders or re-runs.
 *
 * **Flush semantics (data-loss guard).** Debouncing exists to coalesce
 * writes, never to cancel them. The returned function carries a `flush()`
 * method that immediately executes any pending invocation, and the hook's
 * own cleanup flushes on unmount. Callers that swap the debounced target
 * mid-session (switching notes/requests) MUST call `flush()` *before*
 * the switch — an effect cleanup that merely clears the timer silently
 * drops the user's last keystrokes.
 *
 * Use for non-textarea fields (KV inputs, method selector, etc.) where
 * you want to coalesce keystrokes into one disk write, but the input
 * itself doesn't need an internal draft (it's already a controlled
 * `<input value=...>` — caret stays put).
 *
 * For `<textarea>` body editing, use a separate draft state — debouncing
 * alone still re-renders the textarea on each onChange and risks caret
 * loss with very large bodies.
 */
export type DebouncedFn<T extends unknown[]> = ((...args: T) => void) & {
  /** Execute the pending invocation immediately, if any. No-op otherwise. */
  flush: () => void;
  /** True while an invocation is scheduled but has not run yet. */
  isPending: () => boolean;
};

export function useDebouncedCallback<T extends unknown[]>(
  fn: (...args: T) => void,
  delayMs: number,
): DebouncedFn<T> {
  // Keep the latest fn in a ref so we can swap it on every render without
  // resetting the timer / re-binding the returned wrapper.
  const fnRef = useRef(fn);
  fnRef.current = fn;

  // Stable timer slot. The actual callback that gets scheduled always
  // dispatches the *current* fn (via fnRef) — so callers can pass an
  // inline closure that captures fresh state and we still invoke the
  // most recent version.
  const timerRef = useRef<number | null>(null);
  // Args of the invocation that is scheduled but has not run yet. Kept so
  // `flush()` can execute it even after the timer is cleared.
  const pendingArgsRef = useRef<T | null>(null);

  const flush = useCallback(() => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (pendingArgsRef.current != null) {
      const args = pendingArgsRef.current;
      pendingArgsRef.current = null;
      fnRef.current(...args);
    }
  }, []);

  // Unmount: flush, never drop. The old cleanup only cleared the timer,
  // which is how a quick edit followed by closing the window lost the
  // last 400ms of typing with no error and no undo.
  useEffect(() => {
    return () => {
      flush();
    };
  }, [flush]);

  // useCallback (not just `return ... => ...`) so the returned function
  // reference is stable across renders. Without this, every parent render
  // would re-create the wrapper (re-rendering every consumer and re-firing
  // effects that list it in their deps).
  const debounced = useCallback(
    (...args: T) => {
      pendingArgsRef.current = args;
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        pendingArgsRef.current = null;
        fnRef.current(...args);
      }, delayMs);
    },
    [delayMs],
  ) as DebouncedFn<T>;

  debounced.flush = flush;
  debounced.isPending = useCallback(
    () => timerRef.current != null || pendingArgsRef.current != null,
    [],
  );

  return debounced;
}
