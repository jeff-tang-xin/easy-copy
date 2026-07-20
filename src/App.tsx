import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { enable, isEnabled, disable } from "@tauri-apps/plugin-autostart";
import "./App.css";

/* ===== SVG Icon Components ===== */
const IconSearch = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.5" />
    <path d="M11 11l3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

const IconStar = ({ filled }: { filled: boolean }) => (
  <svg width="15" height="15" viewBox="0 0 16 16" fill={filled ? "currentColor" : "none"}>
    <path d="M8 1.2l2.05 4.16 4.6.67-3.33 3.24.79 4.58L8 11.69l-4.11 2.16.79-4.58L1.35 6.43l4.6-.67L8 1.2z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
  </svg>
);

const IconTrash = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
    <path d="M3 4h10M6 4V2.5h4V4M5 4l.5 9.5h5L11 4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const IconTag = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
    <path d="M2.5 8.5L8 3l5.5 5.5L8 14z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    <circle cx="6" cy="6.5" r="1" fill="currentColor" />
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

type ItemType = "Text" | "Image" | "Files";

interface ClipboardItem {
  id: string;
  type: ItemType;
  content: string;
  timestamp: string;
  favorite: boolean;
  tags: string[];
}

interface ImageCache {
  [id: string]: string;
}

interface AppConfig {
  max_items: number;
  poll_interval_ms: number;
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
  const [showFavoritesOnly, setShowFavoritesOnly] = useState(false);
  const [enlargedImage, setEnlargedImage] = useState<string | null>(null);
  const [autoStartEnabled, setAutoStartEnabled] = useState(false);
  const [toast, setToast] = useState<{ msg: string; type: "success" | "error" } | null>(null);

  // Tag state
  const [tagInputId, setTagInputId] = useState<string | null>(null);
  const [tagInputValue, setTagInputValue] = useState("");
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [allTags, setAllTags] = useState<string[]>([]);

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
  const [config, setConfig] = useState<AppConfig>({ max_items: 500, poll_interval_ms: 500 });

  // Context menu
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  // Search highlight
  const searchRef = useRef("");

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
    const tags = await invoke<string[]>("get_all_tags");
    setAllTags(tags);
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
  }, [items, selectedIndex, enlargedImage]);

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

  const handleSearch = async (value: string) => {
    setSearch(value);
    searchRef.current = value;
    if (value.trim()) {
      const results = await invoke<ClipboardItem[]>("search_history", { query: value });
      setItems(results);
      results
        .filter((i) => i.type === "Image")
        .forEach((i) => loadImage(i.id));
    } else {
      refresh();
    }
  };

  const handleCopy = async (id: string) => {
    await invoke("copy_to_clipboard", { id });
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1500);
  };

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

  const handleToggleFavorite = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    await invoke("toggle_favorite", { id });
    if (showFavoritesOnly) {
      const favs = await invoke<ClipboardItem[]>("get_favorites");
      setItems(favs);
    } else if (search.trim()) {
      const results = await invoke<ClipboardItem[]>("search_history", { query: search });
      setItems(results);
    } else {
      refresh();
    }
  };

  const handleToggleFavoritesFilter = async () => {
    const next = !showFavoritesOnly;
    setShowFavoritesOnly(next);
    setSearch("");
    if (next) {
      const favs = await invoke<ClipboardItem[]>("get_favorites");
      setItems(favs);
    } else {
      refresh();
    }
  };

  const refreshAllTags = async () => {
    const tags = await invoke<string[]>("get_all_tags");
    setAllTags(tags);
  };

  const handleAddTag = async (id: string, e: React.KeyboardEvent) => {
    if (e.key !== "Enter") return;
    const tag = tagInputValue.trim();
    if (!tag) {
      setTagInputId(null);
      setTagInputValue("");
      return;
    }
    await invoke("add_tag", { id, tag });
    setTagInputId(null);
    setTagInputValue("");
    refreshAllTags();
    // Refresh current view
    if (showFavoritesOnly) {
      const favs = await invoke<ClipboardItem[]>("get_favorites");
      setItems(favs);
    } else if (search.trim()) {
      const results = await invoke<ClipboardItem[]>("search_history", { query: search });
      setItems(results);
    } else {
      refresh();
    }
  };

  const handleRemoveTag = async (id: string, tag: string, e: React.MouseEvent) => {
    e.stopPropagation();
    await invoke("remove_tag", { id, tag });
    refreshAllTags();
    if (showFavoritesOnly) {
      const favs = await invoke<ClipboardItem[]>("get_favorites");
      setItems(favs);
    } else if (search.trim()) {
      const results = await invoke<ClipboardItem[]>("search_history", { query: search });
      setItems(results);
    } else {
      refresh();
    }
  };

  const handleTagClick = (tag: string) => {
    setSearch(tag);
    handleSearch(tag);
  };

  const handleTagFilterToggle = (tag: string) => {
    if (tagFilter === tag) {
      setTagFilter(null);
      refresh();
    } else {
      setTagFilter(tag);
      setSearch(tag);
      handleSearch(tag);
    }
  };

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
  };

  const handleSaveConfig = async () => {
    await invoke("set_config", { config });
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
                title={exec ? `⚠ Executable file — click to open: ${f}` : `Click to open: ${f}`}
                onClick={(e) => handleOpenFile(f, e)}
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
                invoke("open_file", { path: part.trim() });
              }}
              title={`Open: ${part}`}
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
            className="search-input"
            type="text"
            placeholder="Search history & tags..."
            value={search}
            onChange={(e) => handleSearch(e.target.value)}
            autoFocus
          />
        </div>
        {items.length > 0 && (
          <button
            className={`filter-btn ${showFavoritesOnly ? "active" : ""}`}
            onClick={handleToggleFavoritesFilter}
            title="Show favorites only"
          >
            <IconStar filled={showFavoritesOnly} />
          </button>
        )}
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

      {allTags.length > 0 && (
        <div className="tag-bar">
          {allTags.map((tag) => (
            <span
              key={tag}
              className={`tag-chip ${tagFilter === tag ? "active" : ""}`}
              onClick={() => handleTagFilterToggle(tag)}
            >
              {tag}
            </span>
          ))}
        </div>
      )}

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
                className={`item-card ${item.type.toLowerCase()} ${item.favorite ? "favorited" : ""} ${index === selectedIndex ? "selected" : ""}`}
                onClick={() => handleCopy(item.id)}
                onContextMenu={(e) => handleContextMenu(e, item.id)}
              >
                <div className="item-content">{renderContent(item)}</div>
                {(item.tags.length > 0 || tagInputId === item.id) && (
                  <div className="item-tags">
                    {item.tags.map((tag) => (
                      <span key={tag} className="tag-badge" onClick={(e) => { e.stopPropagation(); handleTagClick(tag); }}>
                        {tag}
                        <span className="tag-remove" onClick={(e) => handleRemoveTag(item.id, tag, e)}>×</span>
                      </span>
                    ))}
                    {tagInputId === item.id && (
                      <div className="tag-input-wrapper">
                        <input
                          className="tag-input"
                          type="text"
                          value={tagInputValue}
                          onChange={(e) => setTagInputValue(e.target.value)}
                          onKeyDown={(e) => { e.stopPropagation(); handleAddTag(item.id, e); }}
                          onBlur={() => { setTagInputId(null); setTagInputValue(""); }}
                          placeholder="tag name..."
                          autoFocus
                        />
                        {tagInputValue.trim() && (() => {
                          const matches = allTags
                            .filter((t) => t.toLowerCase().includes(tagInputValue.toLowerCase()) && !item.tags.includes(t))
                            .slice(0, 5);
                          if (matches.length === 0) return null;
                          return (
                            <div className="tag-suggestions">
                              {matches.map((t) => (
                                <span
                                  key={t}
                                  className="tag-suggestion-item"
                                  onMouseDown={(e) => {
                                    e.preventDefault();
                                    invoke("add_tag", { id: item.id, tag: t });
                                    setTagInputId(null);
                                    setTagInputValue("");
                                    refreshAllTags();
                                    refresh();
                                  }}
                                >
                                  {t}
                                </span>
                              ))}
                            </div>
                          );
                        })()}
                      </div>
                    )}
                  </div>
                )}
                <div className="item-meta">
                  <span className="item-type-badge"><TypeIcon type={item.type} /></span>
                  <span className="item-time">{formatTime(item.timestamp)}</span>
                  <button
                    className="tag-add-btn"
                    onClick={(e) => { e.stopPropagation(); setTagInputId(item.id); setTagInputValue(""); }}
                    title="Add tag"
                  >
                    <IconTag />
                  </button>
                  <button
                    className={`fav-btn ${item.favorite ? "active" : ""}`}
                    onClick={(e) => handleToggleFavorite(item.id, e)}
                    title="Toggle favorite"
                  >
                    <IconStar filled={item.favorite} />
                  </button>
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
          title={`Theme: ${themeMode}`}
        >
          {themeMode === 'auto' ? <IconAuto /> : themeMode === 'light' ? <IconSun /> : <IconMoon />}
        </button>
        <span className="footer-stats">
          {stats.count} items{stats.size > 0 ? ` · ${formatSize(stats.size)}` : ""}
        </span>
        <span className="footer-hint">Ctrl+Shift+V</span>
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
            <button className="ctx-item" onClick={() => { handleToggleFavorite(contextMenu.itemId, { stopPropagation: () => {} } as React.MouseEvent); closeContextMenu(); }}>
              <IconStar filled={items.find(i => i.id === contextMenu.itemId)?.favorite ?? false} /> Toggle Favorite
            </button>
            <button className="ctx-item" onClick={() => { setTagInputId(contextMenu.itemId); setTagInputValue(""); closeContextMenu(); }}>
              <IconTag /> Add Tag
            </button>
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
