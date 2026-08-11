import { useEffect, useRef } from "react";

/**
 * Debounce a callback so the wrapped function only fires after `delayMs`
 * of inactivity. The latest args always win — earlier calls are dropped.
 *
 * The returned function is stable across renders (same reference), so
 * passing it as a prop won't cause unnecessary re-renders.
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
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current != null) clearTimeout(timerRef.current);
    };
  }, []);

  return (...args: T) => {
    if (timerRef.current != null) clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      fnRef.current(...args);
    }, delayMs);
  };
}
