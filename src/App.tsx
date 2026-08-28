import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { enable, isEnabled, disable } from "@tauri-apps/plugin-autostart";
import { useTheme } from "./hooks/useTheme";
import { useToast } from "./hooks/useToast";
import { friendlyError } from "./hooks/friendlyError";
import { useClipboard, type AppConfig, type ClipboardItem } from "./hooks/useClipboard";
import { useWindowLifecycle } from "./hooks/useWindowLifecycle";
import {
  IconSearch, IconTrash, IconText, IconFiles,
  IconPower, IconWarning, IconZoomIn, IconZoomOut, IconZoomReset,
  IconSun, IconMoon, IconAuto, IconUndo, IconIncognito,
  IconSettings, IconExport, IconImport, IconCopy, TypeIcon,
} from "./components/Icons";
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

// Hoisted to module scope: keeps the array stable across renders, and the
// `.some()` call avoids the inner-function allocation the old code had.
const EXECUTABLE_EXTENSIONS = [
  ".exe", ".bat", ".cmd", ".ps1", ".vbs", ".vba", ".wsf", ".msi",
  ".sh", ".bash", ".zsh", ".fish", ".py", ".pl", ".rb", ".php",
  ".jar", ".app", ".com", ".scr", ".reg", ".inf", ".lnk",
] as const;

const isExecutableFile = (filePath: string): boolean => {
  const lower = filePath.toLowerCase().trim();
  return EXECUTABLE_EXTENSIONS.some((ext) => lower.endsWith(ext));
};



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

function formatTime(ts: string): string {
  const date = new Date(ts);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  if (hours < 24) return `${hours} 小时前`;
  if (days < 7) return `${days} 天前`;
  return date.toLocaleDateString();
}

function getDateGroup(ts: string): string {
  // Fix: use calendar-day math (not fixed 24h) so items copied across DST
  // boundaries still fall in the right bucket.
  const date = new Date(ts);
  const now = new Date();
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const day = (a: Date, b: Date) =>
    Math.floor((startOf(a) - startOf(b)) / 86_400_000);

  const dDays = day(now, date);
  if (dDays <= 0) return "今天";
  if (dDays === 1) return "昨天";
  if (dDays < 7) return "本周";
  return date.toLocaleDateString();
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}



function App() {
  // Toast: shared hook
  const { toast, showToast } = useToast();

  // Clipboard state & operations — all IPC + caching + debounced search
  // is encapsulated in useClipboard. App.tsx is now pure rendering.
  const {
    items,
    search,
    setSearch,
    copiedId,
    imageCache,
    stats,
    incognito,
    refresh,
    handleCopy,
    handleDelete,
    undoToast,
    handleUndoDelete,
    handleClear,
    handleToggleIncognito,
    handleExport,
    handleImport,
  } = useClipboard({ showToast });

  // useClipboard returns `setSearch` which is already debounced — alias it
  // so JSX onChange handlers read more naturally.
  const handleSearch = setSearch;

  // Image viewer state
  const [enlargedImage, setEnlargedImage] = useState<string | null>(null);

  // Text preview modal
  const [previewItem, setPreviewItem] = useState<any>(null);
  const [previewLang, setPreviewLang] = useState<PreviewLang>('text');
  const [autoStartEnabled, setAutoStartEnabled] = useState(false);

  // Executable file confirmation dialog
  const [execConfirm, setExecConfirm] = useState<{ path: string } | null>(null);

  // Clear all confirmation dialog
  const [clearConfirm, setClearConfirm] = useState(false);

  // Keyboard navigation selection
  const [selectedIndex, setSelectedIndex] = useState(-1);

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
    api_shortcut: "Ctrl+Shift+U",
    copy_on_double_click: true,
    storage_root: null,
  });

  // Search input ref — for auto-focus on mouse enter & highlightText lookups.
  // `searchRef` holds the current raw input value so `highlightText` can read
  // the latest query without needing to be recreated on every keystroke.
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef("");

  // Context menu
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; itemId: string } | null>(null);

  // Image viewer zoom & pan state
  const [imageZoom, setImageZoom] = useState(1);
  const [imagePos, setImagePos] = useState({ x: 0, y: 0 });
  const isDraggingRef = useRef(false);
  const dragStartRef = useRef({ x: 0, y: 0 });
  const posStartRef = useRef({ x: 0, y: 0 });

  // Track whether the window was maximized by us (to restore on close)
  const wasFullscreenRef = useRef(false);

  // Window lifecycle: hide-on-close + shortcut-error toasts.
  // Clipboard-update refresh is handled inside useClipboard.
  useWindowLifecycle({ showToast });

  const openEnlargedImage = useCallback(async (url: string) => {
    wasFullscreenRef.current = true;
    try {
      const win = getCurrentWindow();
      await win.setDecorations(false);
      await win.maximize();
    } catch (e) {
      // Silently fall back to the in-app zoom view (image is still shown
      // at its natural size in the modal). Window decoration glitches are
      // cosmetic and recoverable on next open; not worth a toast.
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
        // Surface this one: if we can't restore the window chrome, the user
        // is about to interact with a borderless/invisible-frame window with
        // no way to know why. They need to be told.
        showToast(friendlyError(e, "恢复窗口失败"), "error");
      }
    }
  }, [showToast]);

  // Theme: auto (follow system), light, or dark
  const { themeMode, setThemeMode, theme } = useTheme();
  // Memoised so switching preview language doesn't rebuild the style object.
  const codeStyle = useMemo(() => (theme === 'dark' ? oneDark : oneLight), [theme]);

  const cycleTheme = () => {
    setThemeMode(themeMode === 'auto' ? 'light' : themeMode === 'light' ? 'dark' : 'auto');
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
    const wasEnabled = autoStartEnabled;
    try {
      if (autoStartEnabled) {
        await disable();
        setAutoStartEnabled(false);
      } else {
        await enable();
        setAutoStartEnabled(true);
      }
    } catch (e) {
      // The button clicked but the system call failed — roll the icon back
      // so the UI matches reality, and tell the user *why* nothing happened.
      setAutoStartEnabled(wasEnabled);
      showToast(friendlyError(e, "切换开机自启失败"), "error");
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

  // --- Keyboard navigation ---
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const inField = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA';

      // Image preview has highest priority — Escape closes it, everything
      // else is swallowed so the underlying ↑/↓ can't fire on the stale items
      // list at the same time.
      if (enlargedImage) {
        if (e.key === 'Escape') closeEnlargedImage();
        return;
      }
      if (previewItem) {
        if (e.key === 'Escape') setPreviewItem(null);
        return;
      }
      if (inField) return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((prev) => Math.min(prev + 1, items.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((prev) => Math.max(prev - 1, 0));
      } else if (e.key === 'Enter' && selectedIndex >= 0 && selectedIndex < items.length) {
        e.preventDefault();
        const targetItem = items[selectedIndex];
        if (targetItem) handleCopy(targetItem.id);
      } else if (e.key === 'Escape') {
        getCurrentWindow().hide();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [items, selectedIndex, enlargedImage, previewItem, closeEnlargedImage]);

  // Remove the older single-purpose effect that only listened for Escape on
  // the image modal. Its job is now folded into the unified handler above.
  // (Keeping both installed leads to a window where both handlers fire and
  // close the modal twice.)

  // Keep searchRef in sync with the current search value so highlightText
  // can read it without triggering re-renders of the renderContent closure.
  useEffect(() => {
    searchRef.current = search;
  }, [search]);

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
      } catch {
        // ignore — focus is best-effort
      }
    };
    document.addEventListener('mouseenter', handleMouseEnter);
    return () => document.removeEventListener('mouseenter', handleMouseEnter);
  }, []);

  const doOpenFile = async (filePath: string) => {
    const trimmed = filePath.trim();
    try {
      await invoke("open_file", { path: trimmed });
      showToast(`已打开: ${trimmed}`, "success");
    } catch (err) {
      showToast(friendlyError(err, "打开失败"), "error");
    }
  };

  const handleOpenFile = (filePath: string, e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (isExecutableFile(filePath)) {
      setExecConfirm({ path: filePath });
      return;
    }
    void doOpenFile(filePath);
  };

  const handleExecConfirm = () => {
    if (!execConfirm) return;
    void doOpenFile(execConfirm.path);
    setExecConfirm(null);
  };

  const handleExecCancel = () => setExecConfirm(null);

  // friendlyError is now imported from ./hooks/friendlyError so every
  // window produces the same error messages. Previously this function
  // lived inline in App.tsx; ApiApp had a thinner version that just
  // truncated the raw string.

  // --- Settings ---
  const loadConfig = async () => {
    try {
      const cfg = await invoke<AppConfig>("get_config");
      setConfig(cfg);
      configRef.current = cfg;
    } catch (err) {
      showToast(friendlyError(err, "加载配置失败"), "error");
    }
  };

  const handleSaveConfig = async () => {
    try {
      await invoke("set_config", { config });
      configRef.current = config;
      showToast("设置已保存");
      setShowSettings(false);
    } catch (err) {
      showToast(friendlyError(err, "保存失败"), "error");
    }
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
            <span className="img-placeholder">加载中…</span>
          )}
          <span className="item-desc">{item.content}</span>
        </div>
      );
    }

    if (item.type === "Files") {
      const fileList = item.content.split("\n").filter((f) => f.trim().length > 0);
      const renderPath = (f: string) => {
        // Fix: original `Math.max(-1, -1)` would not render a separator for
        // strings without path separators (e.g. "file.txt" → idx = -1).
        // Now we only special-case the "no separator" path explicitly.
        const sepBack = f.lastIndexOf("\\");
        const sepFwd = f.lastIndexOf("/");
        const idx = sepBack > sepFwd ? sepBack : sepFwd;
        if (idx >= 0 && idx < f.length - 1) {
          const dir = f.substring(0, idx);
          const name = f.substring(idx + 1);
          // The separator is the *last* one found, but `dir` was sliced up to
          // `idx` (exclusive), so the separator char lives at index `idx` in
          // the original string `f`.
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
                title={exec ? `⚠ 可执行文件 — Ctrl+点击打开：${f}` : `Ctrl+点击打开：${f}`}
                onClick={(e) => { if (!e.ctrlKey) return; handleOpenFile(f, e); }}
              >
                {exec && <span className="exec-indicator">⚠</span>}
                {renderPath(f)}
              </div>
            );
          })}
          {fileList.length > 5 && (
            <div className="file-more">还有 {fileList.length - 5} 个</div>
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
                  invoke("open_url", { url: part.trim() }).catch((err) =>
                    showToast(friendlyError(err, "打开失败"), "error")
                  );
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
                    .then(() => showToast(`已打开：${part.trim()}`, "success"))
                    .catch((err) => showToast(friendlyError(err, "打开失败"), "error"));
                }
              }}
              title={`点击复制 · Ctrl+点击 / Ctrl+右键打开：${part}`}
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
            placeholder="搜索历史与标签..."
            value={search}
            onChange={(e) => handleSearch(e.target.value)}
            autoFocus
          />
        </div>
        {items.length > 0 && (
          <button className="clear-btn" onClick={() => setClearConfirm(true)} title="清空所有">
            <IconTrash />
          </button>
        )}
        <button
          className={`toolbar-btn ${incognito ? "active-incognito" : ""}`}
          onClick={handleToggleIncognito}
          title="切换隐身模式"
        >
          <IconIncognito />
        </button>
        <button className="toolbar-btn" onClick={() => { loadConfig(); setShowSettings(true); }} title="设置">
          <IconSettings />
        </button>
      </div>

      <div className="list-container">
        {items.length === 0 ? (
          <div className="empty-state">
            <p>暂无剪贴板内容</p>
            <p className="hint">复制任意内容即可开始记录</p>
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
                    title="删除"
                  >
                    <IconTrash />
                  </button>
                </div>
                {copiedId === item.id && (
                  <div className="copied-badge">已复制</div>
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
            title="开机自启"
          >
            <IconPower />
            <span>{autoStartEnabled ? "已开启" : "已关闭"}</span>
          </button>
          <button
            className="theme-btn"
            onClick={cycleTheme}
            title={`主题：${themeMode === 'auto' ? '自动' : themeMode === 'light' ? '浅色' : '深色'}（点击切换）`}
          >
            {themeMode === 'auto' ? <IconAuto /> : themeMode === 'light' ? <IconSun /> : <IconMoon />}
          </button>
          <button
            className="notes-btn"
            onClick={() => {
              invoke("open_api_window").catch((e) => showToast(friendlyError(e, "打开 API 失败"), "error"));
            }}
            title={`打开 API 窗口（${config.api_shortcut}）`}
          >
            <span>🌐 API</span>
          </button>
          <button
            className="notes-btn"
            onClick={() => {
              invoke("open_notes_window").catch((e) => showToast(friendlyError(e, "打开笔记失败"), "error"));
            }}
            title={`打开笔记（${config.notes_shortcut}）`}
          >
            <span>📝 笔记</span>
          </button>
          <button
            className="notes-btn"
            onClick={() => {
              invoke("open_tools_window").catch((e) => showToast(friendlyError(e, "打开工具失败"), "error"));
            }}
            title="打开开发者工具"
          >
            <span>🔧 工具</span>
          </button>
          <button
            className="notes-btn"
            onClick={() => {
              invoke("trigger_screenshot").catch((e) => showToast(friendlyError(e, "截图失败"), "error"));
            }}
            title={`截图（${config.screenshot_shortcut}）`}
          >
            <span>📸 截图</span>
          </button>
        </div>
        <div className="footer-info-group">
          <span className="footer-stats">
            {stats.count} 条{stats.size > 0 ? ` · ${formatSize(stats.size)}` : ""}
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
            <button onClick={() => setImageZoom((z) => Math.min(5, z + 0.25))} title="放大"><IconZoomIn /></button>
            <button onClick={resetImageView} title="重置"><IconZoomReset /></button>
            <button onClick={() => setImageZoom((z) => Math.max(0.2, z - 0.25))} title="缩小"><IconZoomOut /></button>
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
                <label htmlFor="preview-lang-select">预览为</label>
                <select
                  id="preview-lang-select"
                  className="preview-lang-select"
                  value={lang}
                  onChange={(e) => setPreviewLang(e.target.value as PreviewLang)}
                  disabled={tooLong}
                  title={tooLong ? '内容过大，已禁用高亮' : undefined}
                >
                  {PREVIEW_LANGUAGES.map((l) => (
                    <option key={l} value={l}>{l}</option>
                  ))}
                </select>
              </div>
              <div className="preview-actions">
                <button className="preview-btn" onClick={() => handleCopy(previewItem.id)} title="复制"><IconCopy /></button>
                <button className="preview-btn preview-close" onClick={() => setPreviewItem(null)} title="关闭">×</button>
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
              <span>{previewItem.content.length} 字 · {formatTime(previewItem.timestamp)} · {lang}</span>
            </div>
          </div>
        </div>
        );
      })()}

      {execConfirm && (
        <div className="modal-overlay" onClick={handleExecCancel}>
          <div className="exec-confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="exec-confirm-icon"><IconWarning /></div>
            <h3 className="exec-confirm-title">检测到可执行文件</h3>
            <p className="exec-confirm-desc">
              你即将打开一个可能可执行的文件。运行未知脚本可能存在风险，是否继续？
            </p>
            <div className="exec-confirm-path" title={execConfirm.path}>
              {execConfirm.path}
            </div>
            <div className="exec-confirm-buttons">
              <button className="exec-btn-cancel" onClick={handleExecCancel}>
                取消
              </button>
              <button className="exec-btn-open" onClick={handleExecConfirm}>
                仍要打开
              </button>
            </div>
          </div>
        </div>
      )}

      {clearConfirm && (
        <div className="modal-overlay" onClick={() => setClearConfirm(false)}>
          <div className="exec-confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="exec-confirm-icon"><IconTrash /></div>
            <h3 className="exec-confirm-title">清空全部历史？</h3>
            <p className="exec-confirm-desc">
              将永久删除所有剪贴板历史记录，此操作不可撤销。
            </p>
            <div className="exec-confirm-buttons">
              <button className="exec-btn-cancel" onClick={() => setClearConfirm(false)}>
                取消
              </button>
              <button className="exec-btn-open" onClick={handleClear}>
                全部清空
              </button>
            </div>
          </div>
        </div>
      )}

      {undoToast && (
        <div className="undo-toast">
          <span>已删除</span>
          <button onClick={handleUndoDelete}>
            <IconUndo /> 撤销
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
              <IconCopy /> 复制
            </button>
            {items.find(i => i.id === contextMenu.itemId)?.type === "Text" && (
              <button className="ctx-item" onClick={() => {
                const it = items.find(i => i.id === contextMenu.itemId);
                if (it) { setPreviewItem(it); setPreviewLang('text'); }
                closeContextMenu();
              }}>
                <IconText /> 预览
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
                  showToast("已存为笔记");
                } catch (err) {
                  showToast(friendlyError(err, "保存失败"), "error");
                }
              }}>
                <IconText /> {items.find(i => i.id === contextMenu.itemId)?.saved_as_note ? "✅ 已存为笔记" : "存为笔记"}
              </button>
            )}
            <div className="ctx-divider" />
            <button className="ctx-item ctx-danger" onClick={() => { handleDelete(contextMenu.itemId, { stopPropagation: () => {} } as React.MouseEvent); closeContextMenu(); }}>
              <IconTrash /> 删除
            </button>
          </div>
        </>
      )}

      {showSettings && (
        <div className="modal-overlay" onClick={() => setShowSettings(false)}>
          <div className="settings-dialog" onClick={(e) => e.stopPropagation()}>
            <h3 className="settings-title">设置</h3>

            <div className="settings-row">
              <label className="settings-label">最大历史条数</label>
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
              <label className="settings-label">轮询间隔 (毫秒)</label>
              <input
                className="settings-input"
                type="number"
                min="200"
                max="5000"
                value={config.poll_interval_ms}
                onChange={(e) => setConfig({ ...config, poll_interval_ms: Math.max(200, parseInt(e.target.value) || 500) })}
              />
            </div>

            <div className="settings-row settings-row-toggle">
              <label className="settings-label" htmlFor="copy-on-dbl">双击复制</label>
              <input
                id="copy-on-dbl"
                className="settings-checkbox"
                type="checkbox"
                checked={config.copy_on_double_click}
                onChange={(e) => setConfig({ ...config, copy_on_double_click: e.target.checked })}
              />
              <span className="settings-hint">关闭后，双击文本条目会打开预览窗口而非直接复制</span>
            </div>

            <div className="settings-row">
              <label className="settings-label">剪贴板快捷键</label>
              <input
                className="settings-input"
                type="text"
                placeholder="Ctrl+Shift+V"
                value={config.clipboard_shortcut}
                onChange={(e) => setConfig({ ...config, clipboard_shortcut: e.target.value })}
              />
            </div>

            <div className="settings-row">
              <label className="settings-label">笔记快捷键</label>
              <input
                className="settings-input"
                type="text"
                placeholder="Ctrl+Shift+N"
                value={config.notes_shortcut}
                onChange={(e) => setConfig({ ...config, notes_shortcut: e.target.value })}
              />
            </div>

            <div className="settings-row">
              <label className="settings-label">工具快捷键</label>
              <input
                className="settings-input"
                type="text"
                placeholder="Ctrl+Shift+T"
                value={config.tools_shortcut}
                onChange={(e) => setConfig({ ...config, tools_shortcut: e.target.value })}
              />
            </div>

            <div className="settings-row">
              <label className="settings-label">截图快捷键</label>
              <input
                className="settings-input"
                type="text"
                placeholder="Ctrl+Shift+S"
                value={config.screenshot_shortcut}
                onChange={(e) => setConfig({ ...config, screenshot_shortcut: e.target.value })}
              />
            </div>

            <div className="settings-row">
              <label className="settings-label">API 快捷键</label>
              <input
                className="settings-input"
                type="text"
                placeholder="Ctrl+Shift+U"
                value={config.api_shortcut}
                onChange={(e) => setConfig({ ...config, api_shortcut: e.target.value })}
              />
            </div>

            <div className="settings-row">
              <label className="settings-label">存储位置</label>
              <div className="settings-storage-row">
                <input
                  className="settings-input"
                  type="text"
                  placeholder="默认（系统应用数据目录）"
                  value={config.storage_root || ""}
                  onChange={(e) => setConfig({ ...config, storage_root: e.target.value || null })}
                />
                <button
                  className="settings-action-btn"
                  onClick={async () => {
                    try {
                      const sel = await invoke<string>("select_folder");
                      if (sel) setConfig({ ...config, storage_root: sel });
                    } catch (e) {
                      showToast(friendlyError(e, "选择文件夹失败"), "error");
                    }
                  }}
                >
                  浏览
                </button>
              </div>
              <span className="settings-hint">剪贴板历史、笔记、截图与 API 集合的保存位置。留空使用默认目录。</span>
            </div>

            <div className="settings-row">
              <label className="settings-label">数据管理</label>
              <div className="settings-buttons-row">
                <button className="settings-action-btn" onClick={handleExport}>
                  <IconExport /> 导出
                </button>
                <button className="settings-action-btn" onClick={handleImport}>
                  <IconImport /> 导入
                </button>
              </div>
            </div>

            <div className="settings-footer">
              <button className="exec-btn-cancel" onClick={() => setShowSettings(false)}>取消</button>
              <button className="exec-btn-open" onClick={handleSaveConfig}>保存</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
