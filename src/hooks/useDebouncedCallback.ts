import { useCallback, useEffect, useRef } from "react";

/**
 * Debounce a callback so the wrapped function only fires after `delayMs`
 * of inactivity. The latest args always win — earlier calls are dropped.
 *
 * The returned function is stable across renders (same reference), so
 * passing it as a prop or listing it in a `useEffect` dep array won't
 * cause unnecessary re-renders or re-runs.
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
export function useDebouncedCallback<T extends unknown[]>(
  fn: (...args: T) => void,
  delayMs: number,
): (...args: T) => void {
  // Keep the latest fn in a ref so we can swap it on every render without
  // resetting the timer / re-binding the returned wrapper.
  const fnRef = useRef(fn);
  fnRef.current = fn;

  // Stable timer slot. The actual callback that gets scheduled always
  // dispatches the *current* fn (via fnRef) — so callers can pass an
  // inline closure that captures fresh state and we still invoke the
  // most recent version.
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current != null) clearTimeout(timerRef.current);
    };
  }, []);

  // useCallback (not just `return ... => ...`) so the returned function
  // reference is stable across renders. Without this, every parent render
  // would re-create this wrapper, which:
  //   1. Causes every consumer to re-render (new prop reference), and
  //   2. Re-fires any `useEffect` that lists it in its deps, even when
  //      nothing else changed — which is exactly the loop that used to
  //      wreck ApiApp's path-vars sync effect (running on every render).
  return useCallback((...args: T) => {
    if (timerRef.current != null) clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      fnRef.current(...args);
    }, delayMs);
  }, [delayMs]);
}
