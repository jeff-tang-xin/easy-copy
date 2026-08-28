import { useEffect, useState } from "react";

/**
 * Theme hook shared by every window in Easy-Copy.
 *
 * - Reads "easy-copy-theme" from localStorage on first render.
 * - Falls back to legacy "theme" key for backward compatibility with early
 *   versions that used a different name.
 * - "auto" follows the system `prefers-color-scheme` media query.
 * - Cross-window sync: same-origin `storage` events are listened for, and
 *   on focus we re-read the value (storage events don't fire in the tab that
 *   wrote the value).
 * - Applies the resolved theme to `document.documentElement[data-theme]`
 *   so the CSS custom properties (var(--bg-primary), ...) work.
 *
 * Without this hook mounted the CSS variables are undefined and the whole
 * UI renders unstyled.
 */
export type ThemeMode = "auto" | "light" | "dark";

const STORAGE_KEY = "easy-copy-theme";
const LEGACY_KEY = "theme";

const readStoredMode = (): ThemeMode => {
  const cur = localStorage.getItem(STORAGE_KEY);
  if (cur === "auto" || cur === "light" || cur === "dark") return cur;
  const legacy = localStorage.getItem(LEGACY_KEY);
  if (legacy === "auto" || legacy === "light" || legacy === "dark") return legacy;
  return "auto";
};

export function useTheme(): {
  themeMode: ThemeMode;
  setThemeMode: (m: ThemeMode) => void;
  theme: "light" | "dark";
} {
  const [themeMode, setThemeModeState] = useState<ThemeMode>(readStoredMode);
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia("(prefers-color-scheme: dark)").matches
  );

  const theme = themeMode === "auto" ? (systemDark ? "dark" : "light") : themeMode;

  // Track OS-level theme changes only matter when in 'auto' mode, but the
  // listener is cheap to keep attached.
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // Sync theme when *another* window changes the shared key.
  // - `storage` event: fires in OTHER tabs/windows, not the writer.
  // - `focus`: belt-and-braces, picks up the value on window focus
  //   (useful for multi-window apps that don't all share storage events).
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY || !e.newValue) return;
      if (e.newValue === "auto" || e.newValue === "light" || e.newValue === "dark") {
        setThemeModeState(e.newValue);
      }
    };
    const onFocus = () => {
      const next = readStoredMode();
      setThemeModeState((prev) => (prev === next ? prev : next));
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  const setThemeMode = (m: ThemeMode) => {
    localStorage.setItem(STORAGE_KEY, m);
    // Also clear the legacy key so we don't keep two sources of truth.
    localStorage.removeItem(LEGACY_KEY);
    setThemeModeState(m);
  };

  return { themeMode, setThemeMode, theme };
}
