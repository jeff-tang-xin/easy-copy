import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { enable, isEnabled, disable } from "@tauri-apps/plugin-autostart";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
// Use PrismLight + register only the languages we need. Importing the full
// `Prism` bundle pulls ~200 languages (multi-MB) and makes language switches
// visibly janky, especially in Vite dev.
import { PrismLight as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark, oneLight } from "react-syntax-highlighter/dist/esm/styles/prism";
import json from "react-syntax-highlighter/dist/esm/languages/prism/json";
import sql from "react-syntax-highlighter/dist/esm/languages/prism/sql";
import xml from "react-syntax-highlighter/dist/esm/languages/prism/markup"; // xml == markup in Prism
import java from "react-syntax-highlighter/dist/esm/languages/prism/java";
import kotlin from "react-syntax-highlighter/dist/esm/languages/prism/kotlin";
import csharp from "react-syntax-highlighter/dist/esm/languages/prism/csharp";
import go from "react-syntax-highlighter/dist/esm/languages/prism/go";
import rust from "react-syntax-highlighter/dist/esm/languages/prism/rust";
import python from "react-syntax-highlighter/dist/esm/languages/prism/python";
import javascript from "react-syntax-highlighter/dist/esm/languages/prism/javascript";
import typescript from "react-syntax-highlighter/dist/esm/languages/prism/typescript";
import c from "react-syntax-highlighter/dist/esm/languages/prism/c";
import cpp from "react-syntax-highlighter/dist/esm/languages/prism/cpp";
import php from "react-syntax-highlighter/dist/esm/languages/prism/php";
import ruby from "react-syntax-highlighter/dist/esm/languages/prism/ruby";
import bash from "react-syntax-highlighter/dist/esm/languages/prism/bash";
import yaml from "react-syntax-highlighter/dist/esm/languages/prism/yaml";
import css from "react-syntax-highlighter/dist/esm/languages/prism/css";
SyntaxHighlighter.registerLanguage("json", json);
SyntaxHighlighter.registerLanguage("sql", sql);
SyntaxHighlighter.registerLanguage("xml", xml);
SyntaxHighlighter.registerLanguage("markup", xml);
SyntaxHighlighter.registerLanguage("java", java);
SyntaxHighlighter.registerLanguage("kotlin", kotlin);
SyntaxHighlighter.registerLanguage("csharp", csharp);
SyntaxHighlighter.registerLanguage("go", go);
SyntaxHighlighter.registerLanguage("rust", rust);
SyntaxHighlighter.registerLanguage("python", python);
SyntaxHighlighter.registerLanguage("javascript", javascript);
SyntaxHighlighter.registerLanguage("typescript", typescript);
SyntaxHighlighter.registerLanguage("c", c);
SyntaxHighlighter.registerLanguage("cpp", cpp);
SyntaxHighlighter.registerLanguage("php", php);
SyntaxHighlighter.registerLanguage("ruby", ruby);
SyntaxHighlighter.registerLanguage("bash", bash);
SyntaxHighlighter.registerLanguage("yaml", yaml);
SyntaxHighlighter.registerLanguage("css", css);
import { format as formatSql } from "sql-formatter";
import "./App.css";

// Module-level constant so React doesn't see a new object each render.
const CODE_CUSTOM_STYLE = { margin: 0, background: "transparent", fontSize: 13 } as const;
// Bail out of syntax highlighting for very large payloads — Prism tokenising
// a huge minified blob will freeze the main thread for seconds.
const HIGHLIGHT_MAX_CHARS = 100_000;

/* ===== SVG Icon Components ===== */
const IconSearch = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.5" />
    <path d="M11 11l3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

const IconTrash = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
    <path d="M3 4h10M6 4V2.5h4V4M5 4l.5 9.5h5L11 4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const IconText = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
    <rect x="2.5" y="2" width="11" height="12" rx="1" stroke="currentColor" strokeWidth="1.2" />
    <path d="M5 5.5h6M5 7.5h6M5 9.5h4" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
  </svg>
);

const IconImage = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
    <rect x="2" y="2" width="12" height="12" rx="1" stroke="currentColor" strokeWidth="1.2" />
    <circle cx="5.5" cy="5.5" r="1.2" fill="currentColor" />
    <path d="M2.5 12l3-3 2 2 3-3 3 2.5" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
  </svg>
);

const IconFiles = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
    <path d="M1.5 4h4l1.5 1.5H14.5V13.5H1.5z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
  </svg>
);

const IconPower = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
    <path d="M8 2v6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    <path d="M4.5 4a5.5 5.5 0 107 0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none" />
  </svg>
);

const IconWarning = () => (
  <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
    <path d="M12 2L1 22h22L12 2z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
    <path d="M12 9v5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    <circle cx="12" cy="18" r="1.2" fill="currentColor" />
  </svg>
);

const IconZoomIn = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.5" />
    <path d="M7 5v4M5 7h4M11 11l3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

const IconZoomOut = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.5" />
    <path d="M5 7h4M11 11l3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

const IconZoomReset = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <path d="M3 8a5 5 0 119 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    <path d="M12 7v4h-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const IconSun = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
    <circle cx="8" cy="8" r="3" stroke="currentColor" strokeWidth="1.3" />
    <path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.4 1.4M11.6 11.6L13 13M3 13l1.4-1.4M11.6 4.4L13 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
  </svg>
);

const IconMoon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
    <path d="M13 8.5a5 5 0 11-5.5-5.5 4 4 0 005.5 5.5z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
  </svg>
);

const IconAuto = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
    <path d="M8 1.5a6.5 6.5 0 100 13z" fill="currentColor" opacity="0.4" />
    <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.2" />
  </svg>
);

const IconUndo = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
    <path d="M3 6h7a4 4 0 110 8H6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M5 4L3 6l2 2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const IconIncognito = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
    <path d="M2 7l2-4h8l2 4" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    <rect x="1.5" y="7" width="13" height="2" rx="0.5" fill="currentColor" />
    <circle cx="5" cy="11.5" r="2" stroke="currentColor" strokeWidth="1.2" />
    <circle cx="11" cy="11.5" r="2" stroke="currentColor" strokeWidth="1.2" />
  </svg>
);

const IconSettings = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
    <path d="M8 5.5a2.5 2.5 0 100 5 2.5 2.5 0 000-5z" stroke="currentColor" strokeWidth="1.2" />
    <path d="M8 1v2M8 13v2M2 8h2M12 8h2M3.5 3.5l1.4 1.4M11.1 11.1l1.4 1.4M3.5 12.5l1.4-1.4M11.1 4.9l1.4-1.4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
  </svg>
);

const IconExport = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
    <path d="M8 2v8M5 5l3-3 3 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M3 11v2.5h10V11" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
  </svg>
);

const IconImport = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
    <path d="M8 10V2M5 7l3 3 3-3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M3 11v2.5h10V11" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
  </svg>
);

const IconCopy = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
    <rect x="4" y="4" width="9" height="9" rx="1" stroke="currentColor" strokeWidth="1.2" />
    <path d="M3 11V3a1 1 0 011-1h7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
  </svg>
);

// Supported syntax-highlight languages the user can pick manually.
const PREVIEW_LANGUAGES = [
  'text', 'markdown', 'json', 'sql', 'xml', 'markup',
  'java', 'kotlin', 'csharp', 'go', 'rust', 'python',
  'javascript', 'typescript', 'c', 'cpp', 'php', 'ruby',
  'bash', 'yaml', 'css',
] as const;
type PreviewLang = typeof PREVIEW_LANGUAGES[number];

// Try to pretty-format content when we're confident (JSON / SQL). Returns
// original string otherwise.
function formatContent(text: string, lang: PreviewLang): string {
  try {
    if (lang === 'json') return JSON.stringify(JSON.parse(text), null, 2);
    if (lang === 'sql') return formatSql(text, { language: 'sql', keywordCase: 'upper' });
  } catch { /* ignore */ }
  return text;
}

type ItemType = "Text" | "Image" | "Files";

interface ClipboardItem {
  id: string;
  type: ItemType;
  content: string;
  timestamp: string;
  favorite: boolean;
  tags: string[];
  saved_as_note?: boolean;
}

interface ImageCache {
  [id: string]: string;
}

interface AppConfig {
  max_items: number;
  poll_interval_ms: number;
  clipboard_shortcut: string;
  notes_shortcut: string;
  tools_shortcut: string;
  screenshot_shortcut: string;
  copy_on_double_click: boolean;
}

interface ContextMenuState {
  x: number;
  y: number;
  itemId: string;
}

function formatTime(ts: string): string {
  const date = new Date(ts);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString();
}

function getDateGroup(ts: string): string {
  const date = new Date(ts);
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterdayStart = new Date(todayStart.getTime() - 86400000);
  const weekStart = new Date(todayStart.getTime() - 6 * 86400000);

  if (date >= todayStart) return "Today";
  if (date >= yesterdayStart) return "Yesterday";
  if (date >= weekStart) return "This Week";
  return date.toLocaleDateString();
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function TypeIcon({ type }: { type: ItemType }) {
  switch (type) {
    case "Image":
      return <IconImage />;
    case "Files":
      return <IconFiles />;
    default:
      return <IconText />;
  }
}

function App() {
  const [items, setItems] = useState<ClipboardItem[]>([]);
  const [search, setSearch] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [imageCache, setImageCache] = useState<ImageCache>({});
  const imageCacheRef = useRef<ImageCache>({});
  const [enlargedImage, setEnlargedImage] = useState<string | null>(null);
  // Text preview modal
  const [previewItem, setPreviewItem] = useState<ClipboardItem | null>(null);
  const [previewLang, setPreviewLang] = useState<PreviewLang>('text');
  const [autoStartEnabled, setAutoStartEnabled] = useState(false);
  const [toast, setToast] = useState<{ msg: string; type: "success" | "error" } | null>(null);

  // Executable file confirmation dialog
  const [execConfirm, setExecConfirm] = useState<{ path: string } | null>(null);

  // Clear all confirmation dialog
  const [clearConfirm, setClearConfirm] = useState(false);

  // Keyboard navigation selection
  const [selectedIndex, setSelectedIndex] = useState(-1);

  // Stats: item count and storage size
  const [stats, setStats] = useState<{ count: number; size: number }>({ count: 0, size: 0 });

  // Delete undo
  const [undoToast, setUndoToast] = useState<ClipboardItem | null>(null);
  const undoTimerRef = useRef<number | null>(null);

  // Incognito mode
  const [incognito, setIncognito] = useState(false);

  // Settings panel
  const [showSettings, setShowSettings] = useState(false);
  const configRef = useRef<AppConfig | null>(null);
  const [config, setConfig] = useState<AppConfig>({
    max_items: 500,
    poll_interval_ms: 500,
  clipboard_shortcut: "Ctrl+Shift+V",
  notes_shortcut: "Ctrl+Shift+N",
  tools_shortcut: "Ctrl+Shift+T",
  screenshot_shortcut: "Ctrl+Shift+S",
  copy_on_double_click: true,
});

  // Context menu
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  // Search highlight
  const searchRef = useRef("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  // Debounce timer for search so we don't hit the backend on every keystroke.
  const searchTimerRef = useRef<number | null>(null);

  // Image viewer zoom & pan state
  const [imageZoom, setImageZoom] = useState(1);
  const [imagePos, setImagePos] = useState({ x: 0, y: 0 });
  const isDraggingRef = useRef(false);
  const dragStartRef = useRef({ x: 0, y: 0 });
  const posStartRef = useRef({ x: 0, y: 0 });

  // Track whether the window was maximized by us (to restore on close)
  const wasFullscreenRef = useRef(false);

  const openEnlargedImage = useCallback(async (url: string) => {
    wasFullscreenRef.current = true;
    try {
      const win = getCurrentWindow();
      await win.setDecorations(false);
      await win.maximize();
    } catch (e) {
      console.error("Failed to maximize window:", e);
    }
    setImageZoom(1);
    setImagePos({ x: 0, y: 0 });
    setEnlargedImage(url);
  }, []);

  const closeEnlargedImage = useCallback(async () => {
    setEnlargedImage(null);
    if (wasFullscreenRef.current) {
      wasFullscreenRef.current = false;
      try {
        const win = getCurrentWindow();
        await win.unmaximize();
        await win.setDecorations(true);
      } catch (e) {
        console.error("Failed to restore window:", e);
      }
    }
  }, []);

  // Theme: auto (follow system), light, or dark
  const [themeMode, setThemeMode] = useState<'auto' | 'light' | 'dark'>(
    () => (localStorage.getItem('easy-copy-theme') as 'auto' | 'light' | 'dark') || 'auto'
  );
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches
  );
  const theme = themeMode === 'auto' ? (systemDark ? 'dark' : 'light') : themeMode;
  // Memoised so switching preview language doesn't rebuild the style object.
  const codeStyle = useMemo(() => (theme === 'dark' ? oneDark : oneLight), [theme]);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  const cycleTheme = () => {
    setThemeMode((prev) => {
      const next = prev === 'auto' ? 'light' : prev === 'light' ? 'dark' : 'auto';
      localStorage.setItem('easy-copy-theme', next);
      return next;
    });
  };

  // Check autostart status on mount
  useEffect(() => {
    isEnabled().then(setAutoStartEnabled).catch(() => {});
  }, []);

  // Load config once on mount so footer/hints reflect actual shortcuts
  useEffect(() => {
    invoke<AppConfig>("get_config").then((c) => { setConfig(c); configRef.current = c; }).catch(() => {});
  }, []);

  const handleToggleAutoStart = async () => {
    try {
      if (autoStartEnabled) {
        await disable();
        setAutoStartEnabled(false);
      } else {
        await enable();
        setAutoStartEnabled(true);
      }
    } catch (e) {
      console.error("Failed to toggle autostart:", e);
    }
  };

  // --- Image viewer zoom & pan handlers ---
  const handleImageWheel = (e: React.WheelEvent) => {
    e.stopPropagation();
    const delta = e.deltaY > 0 ? -0.15 : 0.15;
    setImageZoom((prev) => Math.min(5, Math.max(0.2, prev + delta)));
  };

  const handleImageMouseDown = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    isDraggingRef.current = true;
    dragStartRef.current = { x: e.clientX, y: e.clientY };
    posStartRef.current = { ...imagePos };
  };

  const handleImageMouseMove = (e: React.MouseEvent) => {
    if (!isDraggingRef.current) return;
    e.stopPropagation();
    const dx = e.clientX - dragStartRef.current.x;
    const dy = e.clientY - dragStartRef.current.y;
    setImagePos({ x: posStartRef.current.x + dx, y: posStartRef.current.y + dy });
  };

  const handleImageMouseUp = () => {
    isDraggingRef.current = false;
  };

  const resetImageView = () => {
    setImageZoom(1);
    setImagePos({ x: 0, y: 0 });
  };

  const loadImage = useCallback(async (id: string) => {
    if (imageCacheRef.current[id]) return;
    const data = await invoke<string | null>("get_image_data", { id });
    if (data) {
      imageCacheRef.current[id] = data;
      setImageCache((prev) => ({ ...prev, [id]: data }));
    }
  }, []);

  const refresh = useCallback(async () => {
    const history = await invoke<ClipboardItem[]>("get_history");
    setItems(history);
    history
      .filter((i) => i.type === "Image")
      .forEach((i) => loadImage(i.id));
    const [count, size] = await invoke<[number, number]>("get_stats");
    setStats({ count, size });
  }, [loadImage]);

  useEffect(() => {
    refresh();
    const unlisten = listen<ClipboardItem>("clipboard-update", () => {
      refresh();
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [refresh]);

  // Intercept window close: hide instead of destroy so it can be reopened
  useEffect(() => {
    const win = getCurrentWindow();
    const unlisten = win.onCloseRequested((event) => {
      event.preventDefault();
      win.hide();
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // Close image modal on Escape
  useEffect(() => {
    if (!enlargedImage) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeEnlargedImage();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [enlargedImage, closeEnlargedImage]);

  // Keyboard navigation: ArrowUp/Down to select, Enter to copy, Esc to hide window
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Don't interfere when image modal is open or user is typing in an input
      if (enlargedImage) return;
      if (previewItem) {
        if (e.key === 'Escape') setPreviewItem(null);
        return;
      }
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((prev) => Math.min(prev + 1, items.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((prev) => Math.max(prev - 1, 0));
      } else if (e.key === 'Enter' && selectedIndex >= 0 && selectedIndex < items.length) {
        e.preventDefault();
        handleCopy(items[selectedIndex].id);
      } else if (e.key === 'Escape') {
        getCurrentWindow().hide();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [items, selectedIndex, enlargedImage, previewItem]);

  // Reset selection when list changes
  useEffect(() => {
    setSelectedIndex(-1);
  }, [items.length]);

  // Auto-scroll selected item into view
  useEffect(() => {
    if (selectedIndex < 0) return;
    const el = document.querySelector(`.item-card.selected`);
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [selectedIndex]);

  // Auto-focus window & search input when mouse enters from another app
  useEffect(() => {
    const handleMouseEnter = async () => {
      try {
        const win = getCurrentWindow();
        if (!(await win.isFocused())) {
          await win.setFocus();
          searchInputRef.current?.focus();
        }
      } catch (e) {
        // ignore
      }
    };
    document.addEventListener('mouseenter', handleMouseEnter);
    return () => document.removeEventListener('mouseenter', handleMouseEnter);
  }, []);

  const handleSearch = (value: string) => {
    // Keep the input responsive by updating the field immediately, but debounce
    // the backend query (150ms) so fast typing doesn't fire an invoke per key.
    setSearch(value);
    searchRef.current = value;
    if (searchTimerRef.current !== null) {
      clearTimeout(searchTimerRef.current);
    }
    searchTimerRef.current = window.setTimeout(async () => {
      // Ignore stale runs if the input changed again after this timer was set.
      if (searchRef.current !== value) return;
      if (value.trim()) {
        const results = await invoke<ClipboardItem[]>("search_history", { query: value });
        if (searchRef.current !== value) return;
        setItems(results);
        results
          .filter((i) => i.type === "Image")
          .forEach((i) => loadImage(i.id));
      } else {
        refresh();
      }
    }, 150);
  };

  const handleCopy = useCallback(async (id: string) => {
    try {
      await invoke("copy_to_clipboard", { id });
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1500);
    } catch (err) {
      showToast(`Copy failed: ${err}`, "error");
    }
  }, []);

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    // Find the item before deleting for potential undo
    const item = items.find((i) => i.id === id);
    await invoke("delete_item", { id });
    refresh();
    if (item) {
      // Clear any existing undo timer
      if (undoTimerRef.current) window.clearTimeout(undoTimerRef.current);
      setUndoToast(item);
      undoTimerRef.current = window.setTimeout(() => {
        setUndoToast(null);
        undoTimerRef.current = null;
      }, 3000);
    }
  };

  const handleUndoDelete = async () => {
    if (!undoToast) return;
    if (undoTimerRef.current) {
      window.clearTimeout(undoTimerRef.current);
      undoTimerRef.current = null;
    }
    await invoke("restore_item", { item: undoToast });
    setUndoToast(null);
    refresh();
  };

  const handleClear = async () => {
    await invoke("clear_history");
    setItems([]);
    setImageCache({});
    imageCacheRef.current = {};
    setClearConfirm(false);
  };

  const showToast = (msg: string, type: "success" | "error" = "success") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 2500);
  };

  const EXECUTABLE_EXTENSIONS = [
    ".exe", ".bat", ".cmd", ".ps1", ".vbs", ".vba", ".wsf", ".msi",
    ".sh", ".bash", ".zsh", ".fish", ".py", ".pl", ".rb", ".php",
    ".jar", ".app", ".com", ".scr", ".reg", ".inf", ".lnk",
  ];

  const isExecutableFile = (filePath: string): boolean => {
    const lower = filePath.toLowerCase().trim();
    return EXECUTABLE_EXTENSIONS.some((ext) => lower.endsWith(ext));
  };

  const doOpenFile = async (filePath: string) => {
    const trimmed = filePath.trim();
    try {
      await invoke("open_file", { path: trimmed });
      showToast(`Opened: ${trimmed}`, "success");
    } catch (err) {
      showToast(`Failed: ${err}`, "error");
    }
  };

  const handleOpenFile = async (filePath: string, e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (isExecutableFile(filePath)) {
      setExecConfirm({ path: filePath });
      return;
    }
    doOpenFile(filePath);
  };

  const handleExecConfirm = async () => {
    if (!execConfirm) return;
    await doOpenFile(execConfirm.path);
    setExecConfirm(null);
  };

  const handleExecCancel = () => {
    setExecConfirm(null);
  };

  // handleTagClick removed with tag UI

  // --- Incognito mode ---
  const handleToggleIncognito = async () => {
    const next = !incognito;
    setIncognito(next);
    await invoke("set_incognito", { enabled: next });
    showToast(next ? "Incognito ON - recording paused" : "Incognito OFF - recording resumed");
  };

  // --- Settings ---
  const loadConfig = async () => {
    const cfg = await invoke<AppConfig>("get_config");
    setConfig(cfg);
    configRef.current = cfg;
  };

  const handleSaveConfig = async () => {
    await invoke("set_config", { config });
    configRef.current = config;
    showToast("Settings saved");
    setShowSettings(false);
  };

  // --- Export / Import ---
  const handleExport = async () => {
    try {
      const json = await invoke<string>("export_history");
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `easy-copy-history-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      showToast("History exported");
    } catch (e) {
      showToast(`Export failed: ${e}`, "error");
    }
  };

  const handleImport = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const count = await invoke<number>("import_history", { json: text });
        showToast(`Imported ${count} items`);
        refresh();
      } catch (err) {
        showToast(`Import failed: ${err}`, "error");
      }
    };
    input.click();
  };

  // --- Context menu ---
  const handleContextMenu = (e: React.MouseEvent, itemId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, itemId });
  };

  const closeContextMenu = () => setContextMenu(null);

  // --- Search highlight helper ---
  const highlightText = (text: string, query: string): React.ReactNode => {
    if (!query.trim()) return text;
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const parts = text.split(new RegExp(`(${escaped})`, "gi"));
    return parts.map((part, i) =>
      part.toLowerCase() === query.toLowerCase()
        ? <mark key={i} className="search-highlight">{part}</mark>
        : part
    );
  };

  const renderContent = (item: ClipboardItem) => {
    if (item.type === "Image") {
      return (
        <div className="item-image">
          {imageCache[item.id] ? (
            <img src={imageCache[item.id]} alt="clipboard image" onDoubleClick={() => openEnlargedImage(imageCache[item.id])} />
          ) : (
            <span className="img-placeholder">Loading...</span>
          )}
          <span className="item-desc">{item.content}</span>
        </div>
      );
    }

    if (item.type === "Files") {
      const fileList = item.content.split("\n").filter((f) => f.trim().length > 0);
      const renderPath = (f: string) => {
        const sep = f.lastIndexOf("\\");
        const sep2 = f.lastIndexOf("/");
        const idx = Math.max(sep, sep2);
        if (idx > 0 && idx < f.length - 1) {
          const dir = f.substring(0, idx);
          const name = f.substring(idx + 1);
          return <>{dir}{f[idx]}<span className="file-basename">{name}</span></>;
        }
        return <span className="file-basename">{f}</span>;
      };
      return (
        <div className="item-files">
          <span className="file-icon"><IconFiles /></span>
          {fileList.slice(0, 5).map((f, i) => {
            const exec = isExecutableFile(f);
            return (
              <div
                key={i}
                className={`file-name clickable-path ${exec ? "is-exec" : ""}`}
                title={exec ? `⚠ Executable — Ctrl+Click to open: ${f}` : `Ctrl+Click to open: ${f}`}
                onClick={(e) => { if (!e.ctrlKey) return; handleOpenFile(f, e); }}
              >
                {exec && <span className="exec-indicator">⚠</span>}
                {renderPath(f)}
              </div>
            );
          })}
          {fileList.length > 5 && (
            <div className="file-more">+{fileList.length - 5} more</div>
          )}
        </div>
      );
    }

    const text = item.content.length > 200
      ? item.content.substring(0, 200) + "..."
      : item.content;
    // Detect URLs and render as clickable links with highlight
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    const parts = text.split(urlRegex);
    return (
      <>
        {parts.map((part, i) =>
          /^https?:\/\//.test(part) ? (
            <span
              key={i}
              className="url-link"
              onClick={(e) => {
                e.stopPropagation();
                if (e.ctrlKey) {
                  invoke("open_url", { url: part.trim() });
                } else {
                  handleCopy(item.id);
                }
              }}
              onContextMenu={(e) => {
                // Ctrl+RightClick opens the URL in the default browser.
                if (e.ctrlKey) {
                  e.preventDefault();
                  e.stopPropagation();
                  invoke("open_url", { url: part.trim() })
                    .then(() => showToast(`Opened: ${part.trim()}`, "success"))
                    .catch((err) => showToast(`Failed: ${err}`, "error"));
                }
              }}
              title={`Click to copy · Ctrl+Click / Ctrl+RightClick to open: ${part}`}
            >
              {part}
            </span>
          ) : (
            <span key={i}>{highlightText(part, searchRef.current)}</span>
          )
        )}
      </>
    );
  };

  return (
    <div className="app">
      <div className="toolbar">
        <div className="search-wrapper">
          <span className="search-icon"><IconSearch /></span>
          <input
            ref={searchInputRef}
            className="search-input"
            type="text"
            placeholder="Search history & tags..."
            value={search}
            onChange={(e) => handleSearch(e.target.value)}
            autoFocus
          />
        </div>
        {items.length > 0 && (
          <button className="clear-btn" onClick={() => setClearConfirm(true)} title="Clear all">
            <IconTrash />
          </button>
        )}
        <button
          className={`toolbar-btn ${incognito ? "active-incognito" : ""}`}
          onClick={handleToggleIncognito}
          title="Toggle incognito mode"
        >
          <IconIncognito />
        </button>
        <button className="toolbar-btn" onClick={() => { loadConfig(); setShowSettings(true); }} title="Settings">
          <IconSettings />
        </button>
      </div>

      <div className="list-container">
        {items.length === 0 ? (
          <div className="empty-state">
            <p>No clipboard items yet.</p>
            <p className="hint">Copy something to get started!</p>
          </div>
        ) : (
          <div className="item-list">
            {(() => {
              // Group items by date
              const groups: { label: string; items: { item: ClipboardItem; index: number }[] }[] = [];
              let currentGroup = "";
              items.forEach((item, index) => {
                const group = getDateGroup(item.timestamp);
                if (group !== currentGroup) {
                  currentGroup = group;
                  groups.push({ label: group, items: [] });
                }
                groups[groups.length - 1].items.push({ item, index });
              });
              return groups.map((group) => (
                <div key={group.label} className="date-group">
                  <div className="group-header">{group.label}</div>
                  {group.items.map(({ item, index }) => (
              <div
                key={item.id}
                className={`item-card ${(item.type || 'text').toLowerCase()} ${index === selectedIndex ? "selected" : ""}`}
                onClick={() => { setSelectedIndex(index); handleCopy(item.id); }}
                onContextMenu={(e) => handleContextMenu(e, item.id)}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  // Double-click copies by default (configurable).
                  if (configRef.current?.copy_on_double_click !== false) {
                    handleCopy(item.id);
                  } else if (item.type === "Text") {
                    setPreviewItem(item);
                    setPreviewLang('text');
                  }
                }}
              >
                <div className="item-content">{renderContent(item)}</div>
                <div className="item-meta">
                  <span className="item-type-badge"><TypeIcon type={item.type} /></span>
                  {item.saved_as_note && <span className="item-saved-note" title="已存为笔记">📝</span>}
                  <span className="item-time">{formatTime(item.timestamp)}</span>
                  <button
                    className="delete-btn"
                    onClick={(e) => handleDelete(item.id, e)}
                    title="Delete"
                  >
                    <IconTrash />
                  </button>
                </div>
                {copiedId === item.id && (
                  <div className="copied-badge">Copied!</div>
                )}
              </div>
                  ))}
                </div>
              ));
            })()}
          </div>
        )}
      </div>

      <div className="footer">
        <div className="footer-btn-group">
          <button
            className={`autostart-btn ${autoStartEnabled ? "active" : ""}`}
            onClick={handleToggleAutoStart}
            title="Toggle auto-start on boot"
          >
            <IconPower />
            <span>{autoStartEnabled ? "ON" : "OFF"}</span>
          </button>
          <button
            className="theme-btn"
            onClick={cycleTheme}
            title={`Theme: ${themeMode} (click to switch)`}
          >
            {themeMode === 'auto' ? <IconAuto /> : themeMode === 'light' ? <IconSun /> : <IconMoon />}
          </button>
          <button
            className="notes-btn"
            onClick={async () => {
              try {
                await invoke("open_notes_window");
              } catch (e) {
                showToast(`Failed: ${e}`, "error");
              }
            }}
            title={`Open Notes (${config.notes_shortcut})`}
          >
            <span>📝 Notes</span>
          </button>
          <button
            className="notes-btn"
            onClick={async () => {
              try {
                await invoke("open_tools_window");
              } catch (e) {
                showToast(`Failed: ${e}`, "error");
              }
            }}
            title="Open Dev Tools"
          >
            <span>🔧 Tools</span>
          </button>
          <button
            className="notes-btn"
            onClick={async () => {
              try {
                await invoke("trigger_screenshot");
              } catch (e) {
                showToast(`Failed: ${e}`, "error");
              }
            }}
            title={`Take Screenshot (${config.screenshot_shortcut})`}
          >
            <span>📸 Screenshot</span>
          </button>
        </div>
        <div className="footer-info-group">
          <span className="footer-stats">
            {stats.count} items{stats.size > 0 ? ` · ${formatSize(stats.size)}` : ""}
          </span>
        </div>
      </div>

      {enlargedImage && (
        <div
          className="image-modal-overlay"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeEnlargedImage();
          }}
          onWheel={handleImageWheel}
          onMouseMove={handleImageMouseMove}
          onMouseUp={handleImageMouseUp}
          onMouseLeave={handleImageMouseUp}
        >
          <img
            src={enlargedImage}
            alt="enlarged"
            className="image-modal-img"
            style={{
              transform: `translate(${imagePos.x}px, ${imagePos.y}px) scale(${imageZoom})`,
              cursor: isDraggingRef.current ? "grabbing" : "grab",
            }}
            draggable={false}
            onMouseDown={handleImageMouseDown}
            onDoubleClick={(e) => {
              e.stopPropagation();
              if (imageZoom !== 1 || imagePos.x !== 0 || imagePos.y !== 0) {
                resetImageView();
              } else {
                closeEnlargedImage();
              }
            }}
          />
          <div className="image-modal-controls" onClick={(e) => e.stopPropagation()}>
            <button onClick={() => setImageZoom((z) => Math.min(5, z + 0.25))} title="Zoom in"><IconZoomIn /></button>
            <button onClick={resetImageView} title="Reset"><IconZoomReset /></button>
            <button onClick={() => setImageZoom((z) => Math.max(0.2, z - 0.25))} title="Zoom out"><IconZoomOut /></button>
            <span className="zoom-label">{Math.round(imageZoom * 100)}%</span>
          </div>
        </div>
      )}

      {toast && (
        <div className={`toast toast-${toast.type}`}>
          {toast.msg}
        </div>
      )}

      {previewItem && (() => {
        // Single-view preview. User picks language from a dropdown:
        //   text     -> plain <pre>
        //   markdown -> ReactMarkdown
        //   others   -> Prism syntax highlight (json / sql are auto-formatted)
        const lang = previewLang;
        const raw = previewItem.content;
        // Cheap early bail: super long content → force plain text regardless of picker.
        const tooLong = raw.length > HIGHLIGHT_MAX_CHARS;
        const effectiveLang: PreviewLang = tooLong ? 'text' : lang;
        const rendered = (effectiveLang === 'json' || effectiveLang === 'sql')
          ? formatContent(raw, effectiveLang)
          : raw;
        return (
        <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setPreviewItem(null); }}>
          <div className="preview-modal" onClick={(e) => e.stopPropagation()}>
            <div className="preview-header">
              <div className="preview-lang-picker">
                <label htmlFor="preview-lang-select">View as</label>
                <select
                  id="preview-lang-select"
                  className="preview-lang-select"
                  value={lang}
                  onChange={(e) => setPreviewLang(e.target.value as PreviewLang)}
                  disabled={tooLong}
                  title={tooLong ? 'Content too large — highlight disabled' : undefined}
                >
                  {PREVIEW_LANGUAGES.map((l) => (
                    <option key={l} value={l}>{l}</option>
                  ))}
                </select>
              </div>
              <div className="preview-actions">
                <button className="preview-btn" onClick={() => handleCopy(previewItem.id)} title="Copy"><IconCopy /></button>
                <button className="preview-btn preview-close" onClick={() => setPreviewItem(null)} title="Close">×</button>
              </div>
            </div>
            <div className="preview-body">
              {effectiveLang === 'text' ? (
                <pre className="preview-raw">{raw}</pre>
              ) : effectiveLang === 'markdown' ? (
                <div className="preview-markdown">
                  <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={(url) => url}>{raw}</ReactMarkdown>
                </div>
              ) : (
                <div className="preview-code">
                  <SyntaxHighlighter
                    language={effectiveLang}
                    style={codeStyle}
                    customStyle={CODE_CUSTOM_STYLE}
                  >
                    {rendered}
                  </SyntaxHighlighter>
                </div>
              )}
            </div>
            <div className="preview-footer">
              <span>{previewItem.content.length} chars · {formatTime(previewItem.timestamp)} · {lang}</span>
            </div>
          </div>
        </div>
        );
      })()}

      {execConfirm && (
        <div className="modal-overlay" onClick={handleExecCancel}>
          <div className="exec-confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="exec-confirm-icon"><IconWarning /></div>
            <h3 className="exec-confirm-title">Executable File Detected</h3>
            <p className="exec-confirm-desc">
              You are about to open a potentially executable file. Running unknown
              scripts can be dangerous. Are you sure?
            </p>
            <div className="exec-confirm-path" title={execConfirm.path}>
              {execConfirm.path}
            </div>
            <div className="exec-confirm-buttons">
              <button className="exec-btn-cancel" onClick={handleExecCancel}>
                Cancel
              </button>
              <button className="exec-btn-open" onClick={handleExecConfirm}>
                Open Anyway
              </button>
            </div>
          </div>
        </div>
      )}

      {clearConfirm && (
        <div className="modal-overlay" onClick={() => setClearConfirm(false)}>
          <div className="exec-confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="exec-confirm-icon"><IconTrash /></div>
            <h3 className="exec-confirm-title">Clear All History?</h3>
            <p className="exec-confirm-desc">
              This will permanently delete all clipboard history. This action
              cannot be undone.
            </p>
            <div className="exec-confirm-buttons">
              <button className="exec-btn-cancel" onClick={() => setClearConfirm(false)}>
                Cancel
              </button>
              <button className="exec-btn-open" onClick={handleClear}>
                Clear All
              </button>
            </div>
          </div>
        </div>
      )}

      {undoToast && (
        <div className="undo-toast">
          <span>Item deleted</span>
          <button onClick={handleUndoDelete}>
            <IconUndo /> Undo
          </button>
        </div>
      )}

      {contextMenu && (
        <>
          <div className="context-menu-overlay" onClick={closeContextMenu} onContextMenu={(e) => { e.preventDefault(); closeContextMenu(); }} />
          <div
            className="context-menu"
            style={{ left: Math.min(contextMenu.x, window.innerWidth - 180), top: Math.min(contextMenu.y, window.innerHeight - 220) }}
          >
            <button className="ctx-item" onClick={() => { handleCopy(contextMenu.itemId); closeContextMenu(); }}>
              <IconCopy /> Copy
            </button>
            {items.find(i => i.id === contextMenu.itemId)?.type === "Text" && (
              <button className="ctx-item" onClick={() => {
                const it = items.find(i => i.id === contextMenu.itemId);
                if (it) { setPreviewItem(it); setPreviewLang('text'); }
                closeContextMenu();
              }}>
                <IconText /> Preview
              </button>
            )}
            {items.find(i => i.id === contextMenu.itemId) && (
              <button className="ctx-item" disabled={items.find(i => i.id === contextMenu.itemId)?.saved_as_note} onClick={async () => {
                const id = contextMenu.itemId;
                closeContextMenu();
                try {
                  await invoke("create_note_from_clip", { clipId: id });
                  await refresh();
                  await invoke("open_notes_window");
                  setToast({ msg: "已存为笔记", type: "success" });
                  setTimeout(() => setToast(null), 1500);
                } catch (err) {
                  setToast({ msg: String(err), type: "error" });
                  setTimeout(() => setToast(null), 2000);
                }
              }}>
                <IconText /> {items.find(i => i.id === contextMenu.itemId)?.saved_as_note ? "✅ 已存为笔记" : "Save as Note"}
              </button>
            )}
            <div className="ctx-divider" />
            <button className="ctx-item ctx-danger" onClick={() => { handleDelete(contextMenu.itemId, { stopPropagation: () => {} } as React.MouseEvent); closeContextMenu(); }}>
              <IconTrash /> Delete
            </button>
          </div>
        </>
      )}

      {showSettings && (
        <div className="modal-overlay" onClick={() => setShowSettings(false)}>
          <div className="settings-dialog" onClick={(e) => e.stopPropagation()}>
            <h3 className="settings-title">Settings</h3>

            <div className="settings-row">
              <label className="settings-label">Max History Items</label>
              <input
                className="settings-input"
                type="number"
                min="50"
                max="5000"
                value={config.max_items}
                onChange={(e) => setConfig({ ...config, max_items: Math.max(50, parseInt(e.target.value) || 500) })}
              />
            </div>

            <div className="settings-row">
              <label className="settings-label">Poll Interval (ms)</label>
              <input
                className="settings-input"
                type="number"
                min="200"
                max="5000"
                value={config.poll_interval_ms}
                onChange={(e) => setConfig({ ...config, poll_interval_ms: Math.max(200, parseInt(e.target.value) || 500) })}
              />
            </div>

            <div className="settings-row">
              <label className="settings-label">Clipboard Shortcut</label>
              <input
                className="settings-input"
                type="text"
                placeholder="Ctrl+Shift+V"
                value={config.clipboard_shortcut}
                onChange={(e) => setConfig({ ...config, clipboard_shortcut: e.target.value })}
              />
            </div>

            <div className="settings-row">
              <label className="settings-label">Notes Shortcut</label>
              <input
                className="settings-input"
                type="text"
                placeholder="Ctrl+Shift+N"
                value={config.notes_shortcut}
                onChange={(e) => setConfig({ ...config, notes_shortcut: e.target.value })}
              />
            </div>

            <div className="settings-row">
              <label className="settings-label">Tools Shortcut</label>
              <input
                className="settings-input"
                type="text"
                placeholder="Ctrl+Shift+T"
                value={config.tools_shortcut}
                onChange={(e) => setConfig({ ...config, tools_shortcut: e.target.value })}
              />
            </div>

            <div className="settings-row">
              <label className="settings-label">Screenshot Shortcut</label>
              <input
                className="settings-input"
                type="text"
                placeholder="Ctrl+Shift+S"
                value={config.screenshot_shortcut}
                onChange={(e) => setConfig({ ...config, screenshot_shortcut: e.target.value })}
              />
            </div>

            <div className="settings-row">
              <label className="settings-label">Data Management</label>
              <div className="settings-buttons-row">
                <button className="settings-action-btn" onClick={handleExport}>
                  <IconExport /> Export
                </button>
                <button className="settings-action-btn" onClick={handleImport}>
                  <IconImport /> Import
                </button>
              </div>
            </div>

            <div className="settings-footer">
              <button className="exec-btn-cancel" onClick={() => setShowSettings(false)}>Cancel</button>
              <button className="exec-btn-open" onClick={handleSaveConfig}>Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;