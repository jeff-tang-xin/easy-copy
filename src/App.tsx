import { useState, useEffect, useCallback, useRef, useMemo, memo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { enable, isEnabled, disable } from "@tauri-apps/plugin-autostart";
import { useTheme } from "./hooks/useTheme";
import { useToast } from "./hooks/useToast";
import { friendlyError } from "./hooks/friendlyError";
import { useClipboard, type AppConfig, type ClipboardItem } from "./hooks/useClipboard";
import { useWindowLifecycle } from "./hooks/useWindowLifecycle";
import { LazyImage } from "./components/LazyImage";
import { SettingsDialog } from "./components/SettingsDialog";
import {
  IconSearch, IconTrash, IconText, IconFiles,
  IconPower, IconWarning, IconZoomIn, IconZoomOut, IconZoomReset,
  IconSun, IconMoon, IconAuto, IconUndo, IconIncognito,
  IconSettings, IconCopy, TypeIcon,
  IconGlobe, IconNote, IconWrench, IconCamera,
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

// react-syntax-highlighter 的 style 对象没有导出具名类型，这里用它实际的形状。
type CodeStyle = { [key: string]: React.CSSProperties };

interface PreviewModalProps {
  item: ClipboardItem;
  lang: PreviewLang;
  onLangChange: (lang: PreviewLang) => void;
  onClose: () => void;
  onCopy: (id: string) => void;
  /** 由 App 计算并 memo 化的 Prism 主题；子组件不再自己算，避免重复推导。 */
  codeStyle: CodeStyle;
}

/**
 * PreviewModal —— 单视图预览弹窗。
 *
 * 为什么要独立成组件：原先它是 `{previewItem && (() => {...})()}` 的条件 IIFE，
 * 里面的 formatContent（JSON.parse + sql-formatter）在每次 App 重渲染时都会同步
 * 重跑一遍。想加 useMemo 又不行——IIFE 处在条件分支里，条件为假时 Hook 不会被
 * 调用，会破坏 Hook 调用顺序（tsc 检查不出来，运行时直接白屏）。
 * 抽成真正的组件后，Hook 位于组件顶层，条件渲染只决定组件是否挂载，合法。
 */
function PreviewModal({ item, lang, onLangChange, onClose, onCopy, codeStyle }: PreviewModalProps) {
  // 廉价的提前退出：内容超长时无论用户选了什么语言都强制走纯文本。
  // 注意这里用的是**字符数**而不是字节数：中文按 UTF-8 是 3 字节，
  // 若按字节判断，中文内容会被当成 3 倍大，用户远未卡顿就被剥夺高亮。
  const tooLong = item.content.length > HIGHLIGHT_MAX_CHARS;
  const effectiveLang: PreviewLang = tooLong ? 'text' : lang;
  // deps 用 item.content 而非 item：refresh() 会整体换掉 items 数组，
  // item 引用变了但内容没变，用 item 会白白重算一次格式化。
  // deps 用 effectiveLang 而非 lang：超长时 effectiveLang 恒为 'text'，
  // 用 lang 会让用户切下拉时反复重算出同一个结果。
  const rendered = useMemo(
    () =>
      effectiveLang === 'json' || effectiveLang === 'sql'
        ? formatContent(item.content, effectiveLang)
        : item.content,
    [item.content, effectiveLang]
  );

  return (
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="preview-modal" onClick={(e) => e.stopPropagation()}>
        <div className="preview-header">
          <div className="preview-lang-picker">
            <label htmlFor="preview-lang-select">预览为</label>
            <select
              id="preview-lang-select"
              className="preview-lang-select"
              value={lang}
              onChange={(e) => onLangChange(e.target.value as PreviewLang)}
              disabled={tooLong}
              title={tooLong ? '内容过大，已禁用高亮' : undefined}
            >
              {PREVIEW_LANGUAGES.map((l) => (
                <option key={l} value={l}>{l}</option>
              ))}
            </select>
            {/* 超过 HIGHLIGHT_MAX_CHARS 时下拉被禁用，光靠 title 提示鼠标
                悬停才可见。这里给一条常驻文案，说明为什么没有高亮。 */}
            {tooLong && (
              <span className="preview-lang-note">
                内容过大，已跳过格式化与高亮
              </span>
            )}
          </div>
          <div className="preview-actions">
            <button className="preview-btn" onClick={() => onCopy(item.id)} title="复制"><IconCopy /></button>
            <button className="preview-btn preview-close" onClick={onClose} title="关闭">×</button>
          </div>
        </div>
        <div className="preview-body">
          {effectiveLang === 'text' ? (
            <pre className="preview-raw">{item.content}</pre>
          ) : effectiveLang === 'markdown' ? (
            <div className="preview-markdown">
              <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={(url) => url}>{item.content}</ReactMarkdown>
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
          <span>{item.content.length} 字 · {formatTime(item.timestamp)} · {lang}</span>
        </div>
      </div>
    </div>
  );
}

// --- 搜索关键词高亮 ---
// 移到模块作用域：它是纯函数，留在 App 里会每次渲染重建一个新闭包，
// 一旦作为 prop 传给被 memo 的 ItemCard 就会让 memo 全面失效。
function highlightText(text: string, query: string): React.ReactNode {
  if (!query.trim()) return text;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = text.split(new RegExp(`(${escaped})`, "gi"));
  return parts.map((part, i) =>
    part.toLowerCase() === query.toLowerCase()
      ? <mark key={i} className="search-highlight">{part}</mark>
      : part
  );
}

// 文件路径拆成「目录 + 分隔符 + 文件名」，文件名单独加粗。
// 修复：原实现用 `Math.max(-1, -1)`，对不含分隔符的字符串（如 "file.txt"）
// 会走进错误分支；现在只显式特判「无分隔符」这一种情况。
function renderFilePath(f: string): React.ReactNode {
  const sepBack = f.lastIndexOf("\\");
  const sepFwd = f.lastIndexOf("/");
  const idx = sepBack > sepFwd ? sepBack : sepFwd;
  if (idx >= 0 && idx < f.length - 1) {
    const dir = f.substring(0, idx);
    const name = f.substring(idx + 1);
    // 分隔符是**最后一个**被找到的那个，而 `dir` 切到 `idx`（不含），
    // 所以分隔符字符本身位于原串 `f` 的 `idx` 处。
    return <>{dir}{f[idx]}<span className="file-basename">{name}</span></>;
  }
  return <span className="file-basename">{f}</span>;
}

interface ItemCardProps {
  item: ClipboardItem;
  index: number;
  /** 只传「本行是否选中」而不是 selectedIndex——否则选中项一变，整列表全部重渲染。 */
  isSelected: boolean;
  /** 同理只传「本行是否刚复制」而不是 copiedId。 */
  isCopied: boolean;
  /**
   * 只传本行那一张图的 url，**绝不传整个 imageCache 对象**：
   * useClipboard 的 loadImage 每加载完一张图都会 setImageCache(prev => ({...prev}))
   * 产生全新对象，传整体会让任意一张图加载完成就触发全列表 N 次重渲染，
   * 比不加 memo 还差。
   */
  imageUrl?: string;
  /**
   * 搜索词**必须**作为 prop 传入。原实现从 searchRef.current 读，
   * 而 ref 变化不触发重渲染——过去能工作纯粹因为 App 每次 setState 都整体重渲染。
   * 一旦本组件被 memo 包住，从 ref 读就会让高亮永久停在旧关键词。
   */
  search: string;
  copyOnDoubleClick: boolean;
  onCopy: (id: string) => void;
  onSelect: (index: number) => void;
  onContextMenu: (e: React.MouseEvent, itemId: string) => void;
  onPreview: (item: ClipboardItem) => void;
  onDelete: (id: string, e: React.MouseEvent) => void;
  onOpenFile: (filePath: string, e: React.MouseEvent) => void;
  onEnlargeImage: (url: string) => void;
  onOpenUrl: (url: string) => void;
}

/**
 * ItemCard —— 单条剪贴板记录卡片。
 *
 * 用 memo 包住是为了让「复制某一条」「选中某一条」「某张图加载完成」
 * 这类局部变化只重渲染受影响的行，而不是整个列表。前提是所有 props
 * 都保持稳定引用，见 ItemCardProps 上的各条说明。
 */
const ItemCard = memo(function ItemCard({
  item,
  index,
  isSelected,
  isCopied,
  imageUrl,
  search,
  copyOnDoubleClick,
  onCopy,
  onSelect,
  onContextMenu,
  onPreview,
  onDelete,
  onOpenFile,
  onEnlargeImage,
  onOpenUrl,
}: ItemCardProps) {
  const renderContent = () => {
    if (item.type === "Image") {
      return (
        <div className="item-image">
          {imageUrl ? (
            // LazyImage 基于 IntersectionObserver：视口外的图片根本不会进入
            // <img>，200+ 条图片记录时能省掉大量无谓的 base64 解码与解压。
            // 它会把未识别的 props（这里是 onDoubleClick）透传到内部 <img>。
            <LazyImage
              src={imageUrl}
              alt="clipboard image"
              onDoubleClick={() => onEnlargeImage(imageUrl)}
            />
          ) : (
            <span className="img-placeholder">加载中…</span>
          )}
          <span className="item-desc">{item.content}</span>
        </div>
      );
    }

    if (item.type === "Files") {
      const fileList = item.content.split("\n").filter((f) => f.trim().length > 0);
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
                onClick={(e) => { if (!e.ctrlKey) return; onOpenFile(f, e); }}
              >
                {exec && <span className="exec-indicator">⚠</span>}
                {renderFilePath(f)}
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
                  onOpenUrl(part.trim());
                } else {
                  onCopy(item.id);
                }
              }}
              onContextMenu={(e) => {
                // Ctrl+RightClick opens the URL in the default browser.
                if (e.ctrlKey) {
                  e.preventDefault();
                  e.stopPropagation();
                  onOpenUrl(part.trim());
                }
              }}
              title={`点击复制 · Ctrl+点击 / Ctrl+右键打开：${part}`}
            >
              {part}
            </span>
          ) : (
            <span key={i}>{highlightText(part, search)}</span>
          )
        )}
      </>
    );
  };

  return (
    <div
      className={`item-card ${(item.type || 'text').toLowerCase()} ${isSelected ? "selected" : ""}`}
      onClick={() => { onSelect(index); onCopy(item.id); }}
      onContextMenu={(e) => onContextMenu(e, item.id)}
      onDoubleClick={(e) => {
        e.stopPropagation();
        // Double-click copies by default (configurable).
        if (copyOnDoubleClick) {
          onCopy(item.id);
        } else if (item.type === "Text") {
          onPreview(item);
        }
      }}
    >
      <div className="item-content">{renderContent()}</div>
      <div className="item-meta">
        <span className="item-type-badge"><TypeIcon type={item.type} /></span>
        {item.saved_as_note && <span className="item-saved-note" title="已存为笔记"><IconNote /></span>}
        <span className="item-time">{formatTime(item.timestamp)}</span>
        <button
          className="delete-btn"
          onClick={(e) => onDelete(item.id, e)}
          title="删除"
        >
          <IconTrash />
        </button>
      </div>
      {isCopied && (
        <div className="copied-badge">已复制</div>
      )}
    </div>
  );
});

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

  // `setSearch` 来自 useClipboard，内部已内建防抖：调用时立即更新受控输入值，
  // 真正的查询延迟 150ms 触发，并用世代号（searchGenRef）丢弃过期响应，
  // 避免旧请求的结果覆盖新输入。因此这里**不要**再套一层防抖，
  // 仅做别名让 JSX 的 onChange 读起来更自然。
  const handleSearch = setSearch;

  // Image viewer state
  const [enlargedImage, setEnlargedImage] = useState<string | null>(null);

  // Text preview modal
  const [previewItem, setPreviewItem] = useState<ClipboardItem | null>(null);
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

  // Search input ref — for auto-focus on mouse enter.
  const searchInputRef = useRef<HTMLInputElement>(null);

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

  // 稳定引用，供 PreviewModal 的 onClose 使用，避免每次渲染换新函数。
  const closePreview = useCallback(() => setPreviewItem(null), []);

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
    invoke<AppConfig>("get_config").then((c) => { setConfig(c); }).catch(() => {});
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

  // Reset selection when list changes
  useEffect(() => {
    setSelectedIndex(-1);
  }, [items.length]);

  // Auto-scroll selected item into view
  useEffect(() => {
    if (selectedIndex < 0) return;
    const el = document.querySelector(`.item-card.selected`);
    // 卡片启用了 content-visibility: auto，未渲染区域的高度只是
    // contain-intrinsic-size 的占位值，与真实高度不符。此时
    // block:'nearest' + smooth 会按错误的高度计算滚动量，导致键盘导航
    // 滚动脱轨（跳过目标或反复回弹）。改用 block:'center' 并使用默认的
    // instant 行为：一次定位到位，浏览器随后按实测高度修正即可。
    el?.scrollIntoView({ block: "center" });
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

  const doOpenFile = useCallback(async (filePath: string) => {
    const trimmed = filePath.trim();
    try {
      await invoke("open_file", { path: trimmed });
      showToast(`已打开: ${trimmed}`, "success");
    } catch (err) {
      showToast(friendlyError(err, "打开失败"), "error");
    }
  }, [showToast]);

  const handleOpenFile = useCallback((filePath: string, e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (isExecutableFile(filePath)) {
      setExecConfirm({ path: filePath });
      return;
    }
    void doOpenFile(filePath);
  }, [doOpenFile]);

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

  // --- Context menu ---
  const handleContextMenu = useCallback((e: React.MouseEvent, itemId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, itemId });
  }, []);

  const closeContextMenu = () => setContextMenu(null);

  // --- 传给被 memo 的 ItemCard 的回调，全部用 useCallback 稳定引用 ---
  // 任何一个回调每次渲染换新引用，都会让整列表的 memo 彻底失效。

  const handleSelect = useCallback((index: number) => setSelectedIndex(index), []);

  const handlePreview = useCallback((item: ClipboardItem) => {
    setPreviewItem(item);
    setPreviewLang('text');
  }, []);

  const handleOpenUrl = useCallback((url: string) => {
    invoke("open_url", { url })
      .then(() => showToast(`已打开：${url}`, "success"))
      .catch((err) => showToast(friendlyError(err, "打开失败"), "error"));
  }, [showToast]);

  // handleDelete 来自 useClipboard，其 deps 含 [items]，items 一变引用就变
  // → 刷新一次列表就会让全列表 memo 失效。这里用 ref 包一层拿到永久稳定的
  // 引用。这是权宜之计：根治需要把 useClipboard 里的 handleDelete 改成
  // 用 itemsRef 读取，从而摆脱 [items] 依赖，但那个文件当前不在本次改动范围内。
  const delRef = useRef(handleDelete);
  delRef.current = handleDelete;
  const onDelete = useCallback(
    (id: string, e: React.MouseEvent) => { void delRef.current(id, e); },
    []
  );

  const renderedGroups = useMemo(() => {
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
    return groups;
  }, [items]);

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
        <button className="toolbar-btn" onClick={() => setShowSettings(true)} title="设置">
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
            {renderedGroups.map((group) => (
              <div key={group.label} className="date-group">
                <div className="group-header">{group.label}</div>
                {group.items.map(({ item, index }) => (
                  <ItemCard
                    key={item.id}
                    item={item}
                    index={index}
                    isSelected={index === selectedIndex}
                    isCopied={copiedId === item.id}
                    imageUrl={imageCache[item.id]}
                    search={search}
                    copyOnDoubleClick={config.copy_on_double_click !== false}
                    onCopy={handleCopy}
                    onSelect={handleSelect}
                    onContextMenu={handleContextMenu}
                    onPreview={handlePreview}
                    onDelete={onDelete}
                    onOpenFile={handleOpenFile}
                    onEnlargeImage={openEnlargedImage}
                    onOpenUrl={handleOpenUrl}
                  />
                ))}
              </div>
            ))}
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
            <span><IconGlobe /> API</span>
          </button>
          <button
            className="notes-btn"
            onClick={() => {
              invoke("open_notes_window").catch((e) => showToast(friendlyError(e, "打开笔记失败"), "error"));
            }}
            title={`打开笔记（${config.notes_shortcut}）`}
          >
            <span><IconNote /> 笔记</span>
          </button>
          <button
            className="notes-btn"
            onClick={() => {
              invoke("open_tools_window").catch((e) => showToast(friendlyError(e, "打开工具失败"), "error"));
            }}
            title="打开开发者工具"
          >
            <span><IconWrench /> 工具</span>
          </button>
          <button
            className="notes-btn"
            onClick={() => {
              invoke("trigger_screenshot").catch((e) => showToast(friendlyError(e, "截图失败"), "error"));
            }}
            title={`截图（${config.screenshot_shortcut}）`}
          >
            <span><IconCamera /> 截图</span>
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

      {/* Single-view preview. User picks language from a dropdown:
          text -> plain <pre> / markdown -> ReactMarkdown /
          others -> Prism syntax highlight (json、sql 会自动格式化)。 */}
      {previewItem && (
        <PreviewModal
          item={previewItem}
          lang={previewLang}
          onLangChange={setPreviewLang}
          onClose={closePreview}
          onCopy={handleCopy}
          codeStyle={codeStyle}
        />
      )}

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

      {/* 设置面板整体交给 SettingsDialog：它自持 get_config 加载、草稿态、
          保存中禁用等逻辑。这里只需把保存结果同步回顶层 config，
          因为 footer/hints 要显示实际快捷键。 */}
      <SettingsDialog
        open={showSettings}
        onClose={() => setShowSettings(false)}
        onSaved={(cfg) => setConfig(cfg)}
        showToast={showToast}
        onExport={handleExport}
        onImport={handleImport}
      />
    </div>
  );
}

export default App;
