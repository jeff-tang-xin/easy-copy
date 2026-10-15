import { useState, useEffect, useLayoutEffect, useCallback, useRef, useMemo, memo } from "react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTheme } from "./hooks/useTheme";
import { useToast } from "./hooks/useToast";
import { useDebouncedCallback } from "./hooks/useDebouncedCallback";
import { friendlyError } from "./hooks/friendlyError";
import ReactMarkdown from "react-markdown";
import { renderToStaticMarkup } from "react-dom/server";
import remarkGfm from "remark-gfm";
import { IconLink, IconPin } from "./components/Icons";
import "./App.css";
import "./NotesApp.css";

interface Note {
  id: string;
  title: string;
  content: string;
  tags: string[];
  category: string | null;
  pinned: boolean;
  source_clip_id: string | null;
  created_at: string;
  updated_at: string;
}

const UNTITLED = "未命名";

// PromptModal — app-themable text-input modal. Defined at module scope (not
// inline inside NotesApp) so it isn't recreated on every render of the parent
// — recreating a component mid-edit would unmount/remount it and discard
// whatever the user has already typed.
//
// Used by category rename and any future askText() call sites. Kept inline
// (not promoted to src/hooks/PromptModal.tsx) because NotesApp is the only
// consumer today; lift it when a second window needs it.
//
// The `[onCancel]` dep is intentional even though onCancel is a new closure
// on every parent render: re-registering the keydown listener on every
// keystroke is cheaper than a ref dance, and the parent only re-renders while
// the modal is open for state that's already changing (selectedCategory,
// search, etc.) so the churn is bounded.
function PromptModal({
  title,
  defaultValue,
  onCancel,
  onConfirm,
}: {
  title: string;
  defaultValue: string;
  onCancel: () => void;
  onConfirm: (v: string) => void;
}) {
  const [val, setVal] = useState(defaultValue);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onCancel]);

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="exec-confirm-dialog" onClick={(e) => e.stopPropagation()}>
        <h3 className="exec-confirm-title">{title}</h3>
        <input
          ref={inputRef}
          className="settings-input"
          type="text"
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && val.trim()) onConfirm(val);
          }}
          placeholder="请输入…"
        />
        <div className="exec-confirm-buttons">
          <button className="exec-btn-cancel" onClick={onCancel}>取消</button>
          <button
            className="exec-btn-open"
            disabled={!val.trim()}
            onClick={() => onConfirm(val)}
          >
            确定
          </button>
        </div>
      </div>
    </div>
  );
}

// 右键菜单定位容器。旧实现用固定 200/160 估算菜单尺寸做视口钳制，但
// .ctx-header 实际 max-width 220px，长标题菜单会溢出屏幕右/下缘且不可点。
// 这里渲染后用 getBoundingClientRect 实测尺寸再钳制；useLayoutEffect 在
// 首帧绘制前完成校正，不会闪位。菜单每次打开都重新挂载，x/y 即打开时坐标。
function ClampedMenu({ x, y, children }: { x: number; y: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const left = Math.max(4, Math.min(x, window.innerWidth - rect.width - 4));
    const top = Math.max(4, Math.min(y, window.innerHeight - rect.height - 4));
    setPos((cur) => (cur.left === left && cur.top === top ? cur : { left, top }));
  }, [x, y]);
  return (
    <div ref={ref} className="context-menu" style={{ left: pos.left, top: pos.top }}>
      {children}
    </div>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString();
}

// Strip markdown markers for a short content preview (first line-ish, ~80 chars).
// 必须放在模块作用域：原先它是 NotesApp 内部的普通函数，每次渲染都是新引用，
// 一旦作为 prop 传给 memo 化的 NoteRow 就会让 memo 完全失效。
function previewText(content: string): string {
  const t = content.replace(/[#>*_`~\-]+/g, " ").replace(/\s+/g, " ").trim();
  return t.length > 80 ? t.slice(0, 80) + "…" : t;
}

// 列表行。用 React.memo 包住，配合稳定的回调，使「切换选中」只重渲染
// 旧选中行 + 新选中行，而不是整份列表。
// 关键点：这里只接 isActive 布尔值，不接当前选中的 id —— 传 id 的话每行的 props
// 都会随选中变化，memo 就白做了。
const NoteRow = memo(function NoteRow({
  note,
  isActive,
  onSelect,
  onContextMenu,
}: {
  note: Note;
  isActive: boolean;
  onSelect: (id: string) => void;
  onContextMenu: (id: string, x: number, y: number) => void;
}) {
  // 内联箭头在组件内部用 note 闭包生成。若从父级 map 里传下来，
  // 每次父级渲染都是新函数引用，同样会击穿 memo。
  const handleClick = () => onSelect(note.id);
  const handleContextMenu = (e: ReactMouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onContextMenu(note.id, e.clientX, e.clientY);
  };
  const preview = previewText(note.content);
  // 键盘可达（roving tabindex）：选中行 tabIndex=0 是 Tab 进入列表的锚点，
  // 其余行 -1，焦点移动由列表容器的方向键委托处理（见 handleRovingKeyDown），
  // Enter/Space 同样由容器触发 click。行本身保持无键盘逻辑，memo 不受影响。
  return (
    <div
      className={`notes-item ${isActive ? "active" : ""}`}
      role="option"
      aria-selected={isActive}
      tabIndex={isActive ? 0 : -1}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
    >
      <div className="notes-item-title">
        {note.pinned && <span className="notes-pin"><IconPin /></span>}
        {note.title || UNTITLED}
      </div>
      {preview && <div className="notes-item-preview">{preview}</div>}
      <div className="notes-item-meta">
        <span>{formatDate(note.updated_at)}</span>
        {note.tags.length > 0 && (
          <span className="notes-item-tags">
            {note.tags.slice(0, 3).map((t) => `#${t}`).join(" ")}
          </span>
        )}
      </div>
    </div>
  );
});

export default function NotesApp() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [viewMode, setViewMode] = useState<"edit" | "split" | "preview">("edit");
  // Shared toast hook. Replaces a string-only local state; with useToast
  // we also get a structured {msg, type} for CSS-driven success/error tinting
  // and a unified de-dupe + auto-dismiss.
  const { toast, showToast } = useToast();
  const flashToast = useCallback((msg: string) => showToast(msg, "success"), [showToast]);
  const errorToast = useCallback(
    (msg: string) => showToast(msg, "error"),
    [showToast],
  );
  // null = All, '' = Uncategorized, others = strict match on category name
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  // Right-click menu for category rename/delete
  const [catMenu, setCatMenu] = useState<{ x: number; y: number; name: string } | null>(null);
  // Right-click menu for a note in the list
  const [noteMenu, setNoteMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  // Theme is centralised in ./hooks/useTheme. The shared hook keeps every
  // window in sync when the user toggles it from the clipboard window.
  useTheme();

  const loadNotes = useCallback(async () => {
    try {
      const list = await invoke<Note[]>("list_notes");
      setNotes(list);
      // Keep current selection if still exists, otherwise pick first
      setSelectedId((cur) => {
        if (cur && list.some((n) => n.id === cur)) return cur;
        return list[0]?.id ?? null;
      });
    } catch (e) {
      // Backend failure while listing — surface it instead of swallowing.
      errorToast(`加载笔记失败: ${friendlyError(e, "加载失败")}`);
    }
  }, [errorToast]);

  useEffect(() => {
    loadNotes();
  }, [loadNotes]);

  // Refresh when the notes window is shown again (e.g. via tray / shortcut)
  useEffect(() => {
    const win = getCurrentWindow();
    const unlisten = win.onFocusChanged(({ payload: focused }) => {
      if (focused) loadNotes();
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [loadNotes]);

  // Derive category/tag universes for the sidebar
  const categories = useMemo(() => {
    const set = new Set<string>();
    notes.forEach((n) => {
      if (n.category && n.category.trim()) set.add(n.category);
    });
    return Array.from(set).sort();
  }, [notes]);

  const allTags = useMemo(() => {
    const map = new Map<string, number>();
    notes.forEach((n) => n.tags.forEach((t) => map.set(t, (map.get(t) ?? 0) + 1)));
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [notes]);

  // Sort: pinned first, then by updated_at desc (stable within same group)
  const sortNotes = (list: Note[]) =>
    [...list].sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
    });

  // NoteRow 是 memo 化的，回调必须引用稳定，否则每次父级渲染都击穿 memo。
  // 两个 setter 都是 React 保证稳定的引用，所以 deps 可以为空。
  const handleSelectNote = useCallback((id: string) => setSelectedId(id), []);

  // 列表/分类的键盘导航（roving tabindex）：方向键在 [role=option] 行间移动
  // 焦点，Enter/Space 触发点击。事件委托在容器上处理，行组件（NoteRow 已
  // memo 化）无需感知键盘逻辑，也不会因新回调引用而击穿 memo。
  const handleRovingKeyDown = useCallback((e: React.KeyboardEvent<HTMLElement>) => {
    const { key } = e;
    if (key !== "ArrowDown" && key !== "ArrowUp" && key !== "Enter" && key !== " ") return;
    const rows = Array.from(
      e.currentTarget.querySelectorAll<HTMLElement>("[role='option']"),
    );
    if (rows.length === 0) return;
    const idx = rows.indexOf(document.activeElement as HTMLElement);
    if (key === "ArrowDown" || key === "ArrowUp") {
      e.preventDefault();
      const next =
        idx === -1
          ? key === "ArrowDown"
            ? 0
            : rows.length - 1
          : key === "ArrowDown"
            ? Math.min(idx + 1, rows.length - 1)
            : Math.max(idx - 1, 0);
      rows[next]?.focus();
      rows[next]?.scrollIntoView({ block: "nearest" });
    } else if (idx !== -1) {
      // Enter/Space 激活当前聚焦行（复用各行已有的 onClick 逻辑）。
      e.preventDefault();
      rows[idx].click();
    }
  }, []);

  const handleNoteContextMenu = useCallback(
    (id: string, x: number, y: number) => setNoteMenu({ x, y, id }),
    [],
  );

  const filtered = useMemo(() => {
    // 1) category gate
    let list = notes;
    if (selectedCategory !== null) {
      list = list.filter((n) =>
        selectedCategory === "" ? !n.category : n.category === selectedCategory,
      );
    }
    // 2) parse search: split into #tag tokens and plain text
    const raw = search.trim();
    if (!raw) return sortNotes(list);
    const tokens = raw.split(/\s+/);
    const tagTokens = tokens.filter((t) => t.startsWith("#")).map((t) => t.slice(1).toLowerCase()).filter(Boolean);
    const textTokens = tokens.filter((t) => !t.startsWith("#")).map((t) => t.toLowerCase());
    return sortNotes(list.filter((n) => {
      // every tag token must match one of the note's tags
      const tagsLower = n.tags.map((t) => t.toLowerCase());
      for (const tt of tagTokens) {
        if (!tagsLower.some((t) => t.includes(tt))) return false;
      }
      if (textTokens.length === 0) return true;
      const hay = (n.title + "\n" + n.content).toLowerCase();
      return textTokens.every((tt) => hay.includes(tt));
    }));
  }, [notes, search, selectedCategory]);

  const selected = useMemo(
    () => notes.find((n) => n.id === selectedId) ?? null,
    [notes, selectedId]
  );

  // Local editing buffers (avoid round-trip on every keystroke)
  const [draftTitle, setDraftTitle] = useState("");
  const [draftContent, setDraftContent] = useState("");
  const [draftTags, setDraftTags] = useState<string[]>([]);
  const [draftCategory, setDraftCategory] = useState<string>("");
  // Bound value of the tag-input field at the bottom of the editor header.
  // Kept as a local `useState` rather than folded into `draftTags` so the
  // input can hold the in-progress text (the not-yet-Enter'd value) without
  // the dirty-buffer effect treating every keystroke as a tag mutation.
  const [tagInput, setTagInput] = useState("");
  const lastLoadedId = useRef<string | null>(null);

  // Debounced auto-save。saveState 增加 "error" 态：保存失败后标题栏持久
  // 显示「未保存·点击重试」，而不是只闪一条 toast 就当没事发生。
  const [saveState, setSaveState] = useState<"saved" | "saving" | "idle" | "error">("idle");
  // 保存代数：每次发起保存自增。异步保存返回时只在自己仍是最新一代时才
  // 更新 saveState，防止迟到的旧结果（如切换笔记后才返回的失败）覆盖新状态。
  const saveEpochRef = useRef(0);
  // 最近一次保存的 Promise（performSave 内同步赋值），供 flushSave 等待落盘。
  const lastSaveRef = useRef<Promise<void>>(Promise.resolve());
  // 「✓ 已保存」1.5s 后归位的定时器。新保存开始前要清掉，否则旧定时器会把
  // saving 态提前打回 idle，状态提示闪烁。
  const savedHintTimerRef = useRef<number | null>(null);
  // 草稿重载 effect 在切换笔记后置位，让紧随其后的保存 effect 跳过一次：
  // 切换的过渡渲染里草稿还是旧笔记的值、selected 已是新笔记，不跳过就会
  // 把旧草稿调度成新笔记的保存（数据串写）。
  const skipNextSaveRef = useRef(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  // Mirror of the content textarea used by the toolbar's wrap/insert helpers
  // and the markdown keyboard shortcuts (Ctrl+B / Ctrl+I / Tab / list-enter).
  // Without this, `textareaRef.current` in wrapSelection / insertAtLineStart
  // would throw at runtime.
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // 实际落盘。参数显式传入而非闭包捕获：debouncedSave 的 flush() 执行的是
  // 「调度时捕获的参数」，切换笔记后也能把旧笔记的草稿存到旧笔记上。
  const performSave = useCallback(
    (id: string, title: string, content: string, tags: string[], category: string) => {
      const epoch = ++saveEpochRef.current;
      const p = (async () => {
        try {
          const updated = await invoke<Note | null>("update_note", {
            id,
            input: {
              title: title.trim() || UNTITLED,
              content,
              tags,
              category: category.trim() ? category.trim() : null,
            },
          });
          if (updated) {
            setNotes((prev) => prev.map((n) => (n.id === updated.id ? updated : n)));
            if (saveEpochRef.current === epoch) {
              setSaveState("saved");
              if (savedHintTimerRef.current) window.clearTimeout(savedHintTimerRef.current);
              savedHintTimerRef.current = window.setTimeout(() => setSaveState("idle"), 1500);
            }
          } else if (saveEpochRef.current === epoch) {
            // 笔记已不存在（update_note 返回空）：按保存失败处理，让
            // 「未保存·点击重试」持久可见，而不是永远卡在「保存中…」。
            setSaveState("error");
          }
        } catch (e) {
          errorToast(friendlyError(e, "保存失败"));
          if (saveEpochRef.current === epoch) setSaveState("error");
        }
      })();
      lastSaveRef.current = p;
    },
    [errorToast],
  );

  const debouncedSave = useDebouncedCallback(performSave, 400);

  // 同步落盘并等待完成：删除笔记 / 关窗前用，确保 update_note 先于
  // delete_note / 窗口隐藏到达后端。performSave 自吞错误，Promise 恒 resolve。
  const flushSave = useCallback(async () => {
    debouncedSave.flush();
    await lastSaveRef.current;
  }, [debouncedSave]);

  // 草稿重载：切换笔记时先把上一条的待保存内容同步落盘，再覆盖本地草稿。
  // flush() 执行的是调度时捕获的旧笔记 id + 旧草稿，落点不会错；不 flush
  // 的话旧定时器随后被丢弃，最后一次编辑静默丢失。（删除路径已在
  // handleDelete/deleteNote 里 flush+await 过，这里对已删除笔记 flush 是
  // 空操作。）注意：本 effect 必须位于 debouncedSave/saveEpochRef 等
  // 声明之后——此前放在组件上部引发了 TDZ 运行时崩溃。
  useEffect(() => {
    if (!selected) {
      lastLoadedId.current = null;
      setDraftTitle("");
      setDraftContent("");
      setDraftTags([]);
      setDraftCategory("");
      return;
    }
    if (lastLoadedId.current !== selected.id) {
      debouncedSave.flush();
      // 作废在途保存的状态回写，并把编辑器复位到新笔记的干净起点——
      // 上一条笔记的保存失败不应以「未保存」的形式泄漏到新笔记的编辑器。
      saveEpochRef.current += 1;
      setSaveState("idle");
      skipNextSaveRef.current = true;
      lastLoadedId.current = selected.id;
      setDraftTitle(selected.title);
      setDraftContent(selected.content);
      setDraftTags(selected.tags);
      setDraftCategory(selected.category ?? "");
    }
  }, [selected, debouncedSave]);

  // Intercept window close: hide instead of destroy so it can be reopened.
  // 隐藏前先把待保存内容落盘（flush + await），否则最后 400ms 的编辑会随
  // 窗口隐藏一起丢掉，下次打开时界面与磁盘不一致。
  useEffect(() => {
    const win = getCurrentWindow();
    const unlisten = win.onCloseRequested((event) => {
      event.preventDefault();
      flushSave()
        .catch(() => {})
        .then(() => win.hide());
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [flushSave]);

  // 「未保存·点击重试」：用当前草稿立即再保存一次。
  const handleRetrySave = useCallback(() => {
    const id = lastLoadedId.current;
    if (!id) return;
    setSaveState("saving");
    performSave(id, draftTitle, draftContent, draftTags, draftCategory);
  }, [draftTitle, draftContent, draftTags, draftCategory, performSave]);

  // 调度保存：有 diff 才置 saving + 调度防抖。注意这里不能在 cleanup 里
  // flush——本 effect 的 deps 含四个草稿字段，每次按键都会触发 cleanup，
  // flush 会让 400ms 防抖退化成每键一写。数据不丢由四处兜底保证：切换笔记
  // 时 flush（上方草稿重载 effect）、删除前 flush+await（handleDelete /
  // deleteNote）、关窗前 flush+await（onCloseRequested）、卸载时由
  // useDebouncedCallback 内置的卸载 flush 兜底。
  useEffect(() => {
    if (!selected) return;
    // 状态性守卫：草稿尚未加载到这条笔记时绝不调度保存。skipNextSaveRef
    // 只能挡住「重载 effect 先跑」的单次过渡；HMR 热重载（effect 全部重跑、
    // 顺序不保证）或未来重构打乱声明顺序时，草稿可能是空的或属于别的笔记，
    // 此时保存会把空内容串写进这条笔记——用户报告的「未编辑却触发自动保存、
    // 内容被清空」即此机制。lastLoadedId 由草稿重载 effect 维护，是可靠的
    // 「草稿 ↔ 笔记」对齐信号。
    if (lastLoadedId.current !== selected.id) return;
    // 跳过切换笔记后的过渡渲染：此时草稿还是旧笔记的值、selected 已是
    // 新笔记，若不跳过会把旧草稿调度成新笔记的保存（数据串写）。
    if (skipNextSaveRef.current) {
      skipNextSaveRef.current = false;
      return;
    }
    // Skip on the very first load of a note (no diff). Title compares
    // post-normalization: performSave persists `trim() || UNTITLED`, so an
    // empty draft title vs a stored "未命名笔记" must not read as a diff —
    // otherwise every notes refresh re-schedules an identical save forever.
    const normTitle = (t: string) => t.trim() || UNTITLED;
    if (
      normTitle(draftTitle) === normTitle(selected.title) &&
      draftContent === selected.content &&
      JSON.stringify(draftTags) === JSON.stringify(selected.tags) &&
      (draftCategory || null) === (selected.category || null)
    ) {
      return;
    }
    if (savedHintTimerRef.current) window.clearTimeout(savedHintTimerRef.current);
    setSaveState("saving");
    debouncedSave(selected.id, draftTitle, draftContent, draftTags, draftCategory);
  }, [draftTitle, draftContent, draftTags, draftCategory, selected, debouncedSave]);

  // 卸载时清掉「已保存」提示定时器（待保存内容由 hook 的卸载 flush 兜底）。
  useEffect(
    () => () => {
      if (savedHintTimerRef.current) window.clearTimeout(savedHintTimerRef.current);
    },
    [],
  );

  // Create a fresh note. Wrapped in useCallback so the global keydown
  // effect below can list it as a dependency without the listener being
  // re-bound on every keystroke (each render of NotesApp would otherwise
  // re-create `handleNew`, which the listener would then drop and re-attach).
  const handleNew = useCallback(async () => {
    try {
      const created = await invoke<Note>("create_note", {
        input: {
          title: "未命名笔记",
          content: "",
          tags: [],
          category: selectedCategory && selectedCategory !== "" ? selectedCategory : null,
        },
      });
      setNotes((prev) => [created, ...prev]);
      setSelectedId(created.id);
    } catch (e) {
      errorToast(friendlyError(e, "创建笔记失败"));
    }
  }, [selectedCategory, errorToast]);

  // Global shortcuts: Ctrl+N new, Ctrl+F focus search, Esc clear search.
  // `handleNew` is a `useCallback` so this effect only re-binds when
  // `selectedCategory` changes, not on every NotesApp render.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey) {
        if (e.key.toLowerCase() === "n") { e.preventDefault(); handleNew(); }
        else if (e.key.toLowerCase() === "f") {
          e.preventDefault();
          searchInputRef.current?.focus();
          searchInputRef.current?.select();
        }
      } else if (e.key === "Escape" && document.activeElement === searchInputRef.current) {
        setSearch("");
        searchInputRef.current?.blur();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleNew]);

  // Lightweight in-app confirm modal — avoids native window.confirm which
  // looks out of place inside a Tauri WebView and can't be themed.
  const [confirmModal, setConfirmModal] = useState<{ title: string; message: string; onConfirm: () => void } | null>(null);
  const [promptModal, setPromptModal] = useState<{ title: string; defaultValue: string; onConfirm: (v: string) => void } | null>(null);
  const ask = (opts: { title: string; message: string; onConfirm: () => void }) => setConfirmModal(opts);
  const askText = (opts: { title: string; defaultValue: string; onConfirm: (v: string) => void }) => setPromptModal(opts);

  const handleDelete = async () => {
    if (!selected) return;
    ask({
      title: "删除笔记",
      message: `确认删除「${selected.title || UNTITLED}」？该操作无法撤销。`,
      onConfirm: async () => {
        setConfirmModal(null);
        try {
          // 先落盘待保存编辑再删除：否则删除引发的草稿重载会对已删除的
          // 笔记触发 flush，update_note 打到不存在的笔记上报错。
          await flushSave();
          await invoke("delete_note", { id: selected.id });
          setNotes((prev) => {
            const next = prev.filter((n) => n.id !== selected.id);
            // Pick a new selection only if we just deleted the currently
            // selected one. Use the *post-filter* list (not the stale closure
            // value of `notes`) so the new selectedId actually exists in state.
            setSelectedId((cur) => (cur === selected.id ? (next[0]?.id ?? null) : cur));
            return next;
          });
          flashToast("已删除");
        } catch (e) {
          errorToast(friendlyError(e, "删除失败"));
        }
      },
    });
  };

  const handlePin = async () => {
    if (!selected) return;
    try {
      await invoke("toggle_note_pin", { id: selected.id });
      await loadNotes();
    } catch (e) {
      errorToast(friendlyError(e, "置顶操作失败"));
    }
  };

  const handleCopy = async () => {
    if (!selected) return;
    try {
      await navigator.clipboard.writeText(selected.content);
      flashToast("已复制");
    } catch (e) {
      errorToast(friendlyError(e, "复制失败"));
    }
  };

  const handleTagAdd = (raw: string) => {
    const t = raw.trim();
    if (!t || draftTags.includes(t)) return;
    setDraftTags((prev) => [...prev, t]);
  };

  const copyNote = async (note: Note) => {
    try {
      await navigator.clipboard.writeText(note.content);
      flashToast("已复制");
    } catch (e) {
      errorToast(friendlyError(e, "复制失败"));
    }
  };

  const pinNote = async (id: string) => {
    try {
      await invoke("toggle_note_pin", { id });
      await loadNotes();
    } catch (e) {
      errorToast(friendlyError(e, "置顶操作失败"));
    }
  };

  const deleteNote = async (note: Note) => {
    ask({
      title: "删除笔记",
      message: `确认删除「${note.title || UNTITLED}」？该操作无法撤销。`,
      onConfirm: async () => {
        setConfirmModal(null);
        try {
          // 同 handleDelete：先落盘待保存编辑再删除，避免 update/delete 竞态。
          await flushSave();
          await invoke("delete_note", { id: note.id });
          setNotes((prev) => {
            const next = prev.filter((n) => n.id !== note.id);
            // Same fix as handleDelete: pick the new selection from the
            // post-filter list so it actually points to a note that still exists.
            setSelectedId((cur) => (cur === note.id ? (next[0]?.id ?? null) : cur));
            return next;
          });
          flashToast("已删除");
        } catch (e) {
          errorToast(friendlyError(e, "删除失败"));
        }
      },
    });
  };

  // Wrap selected text with markdown markers (used by toolbar buttons + keyboard shortcuts)
  const wrapSelection = useCallback((left: string, right: string) => {
    const ta = textareaRef.current;
    if (!ta) return;
    const { selectionStart: s, selectionEnd: eSel, value } = ta;
    const before = value.slice(0, s);
    const mid = value.slice(s, eSel);
    const after = value.slice(eSel);
    const next = before + left + mid + right + after;
    setDraftContent(next);
    requestAnimationFrame(() => {
      ta.focus();
      ta.selectionStart = s + left.length;
      ta.selectionEnd = eSel + left.length;
    });
  }, []);

  // Insert text at cursor position (used for headings, list markers, etc.)
  const insertAtLineStart = useCallback((prefix: string) => {
    const ta = textareaRef.current;
    if (!ta) return;
    const { selectionStart: s, value } = ta;
    const lineStart = value.lastIndexOf("\n", s - 1) + 1;
    const before = value.slice(0, lineStart);
    const after = value.slice(lineStart);
    const next = before + prefix + after;
    setDraftContent(next);
    requestAnimationFrame(() => {
      ta.focus();
      ta.selectionStart = ta.selectionEnd = s + prefix.length;
    });
  }, []);

  // Markdown editing shortcuts inside the textarea
  const handleEditorKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const ta = e.currentTarget;
    const { selectionStart: s, selectionEnd: eSel, value } = ta;
    const wrap = (left: string, right: string) => {
      e.preventDefault();
      const before = value.slice(0, s);
      const mid = value.slice(s, eSel);
      const after = value.slice(eSel);
      const next = before + left + mid + right + after;
      setDraftContent(next);
      // Restore selection around the wrapped text on next tick
      requestAnimationFrame(() => {
        ta.selectionStart = s + left.length;
        ta.selectionEnd = eSel + left.length;
      });
    };
    if (e.key === "Tab") {
      e.preventDefault();
      const before = value.slice(0, s);
      const after = value.slice(eSel);
      const next = before + "  " + after;
      setDraftContent(next);
      requestAnimationFrame(() => {
        ta.selectionStart = ta.selectionEnd = s + 2;
      });
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
      if (e.key.toLowerCase() === "b") return wrap("**", "**");
      if (e.key.toLowerCase() === "i") return wrap("*", "*");
    }
    if (e.key === "Enter") {
      // Continue list marker on Enter
      const lineStart = value.lastIndexOf("\n", s - 1) + 1;
      const line = value.slice(lineStart, s);
      const m = line.match(/^(\s*)([-*]\s|\d+\.\s)(.*)$/);
      if (m) {
        const [, indent, marker, rest] = m;
        if (rest.length === 0) {
          // Empty list item → break out of list
          e.preventDefault();
          const before = value.slice(0, lineStart);
          const after = value.slice(s);
          setDraftContent(before + "\n" + after);
          requestAnimationFrame(() => {
            ta.selectionStart = ta.selectionEnd = lineStart + 1;
          });
          return;
        }
        // Continue list
        e.preventDefault();
        let nextMarker = marker;
        const numMatch = marker.match(/^(\d+)\.\s$/);
        if (numMatch) nextMarker = `${parseInt(numMatch[1], 10) + 1}. `;
        const insert = "\n" + indent + nextMarker;
        const before = value.slice(0, s);
        const after = value.slice(eSel);
        setDraftContent(before + insert + after);
        const newPos = s + insert.length;
        requestAnimationFrame(() => {
          ta.selectionStart = ta.selectionEnd = newPos;
        });
      }
    }
  };

  // Render the note as a standalone HTML document and open it in the system browser
  const handleOpenInBrowser = async () => {
    if (!selected) return;
    try {
      // 不传 urlTransform：react-markdown 默认 defaultUrlTransform 只放行
      // http/https/mailto 等安全协议，javascript: 等会被清空。此前的恒等
      // 放行会让导出的 HTML 在浏览器里可执行脚本。
      const innerHtml = renderToStaticMarkup(
        <ReactMarkdown remarkPlugins={[remarkGfm]}>
          {draftContent || "*暂无内容可预览。*"}
        </ReactMarkdown>,
      );
      const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${(draftTitle || UNTITLED).replace(/</g, "&lt;")}</title>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Inter", Roboto, sans-serif; max-width: 820px; margin: 40px auto; padding: 0 24px; line-height: 1.7; color: #1a1a1a; background: #fafafa; }
h1,h2,h3 { border-bottom: 1px solid #ddd; padding-bottom: 4px; }
h3 { border-bottom: none; }
pre { background: #f0f0f0; padding: 12px 16px; border-radius: 6px; overflow-x: auto; font-family: "JetBrains Mono", Consolas, monospace; font-size: 13px; }
code { background: #f0f0f0; padding: 1px 6px; border-radius: 4px; font-family: "JetBrains Mono", Consolas, monospace; font-size: 0.9em; }
pre code { background: none; padding: 0; }
blockquote { border-left: 3px solid #4a90d9; padding: 4px 16px; margin: 0.6em 0; background: #eef4fb; border-radius: 0 6px 6px 0; color: #555; }
table { border-collapse: collapse; margin: 0.8em 0; }
th,td { border: 1px solid #ddd; padding: 6px 14px; }
th { background: #f0f0f0; }
img { max-width: 100%; border-radius: 6px; }
a { color: #4a90d9; text-decoration: none; }
a:hover { text-decoration: underline; }
hr { border: none; border-top: 1px solid #ddd; margin: 1em 0; }
@media (prefers-color-scheme: dark) {
body { color: #e0e0e0; background: #1a1a1a; }
h1,h2,h3 { border-color: #333; }
pre,code { background: #2a2a2a; }
blockquote { background: #1e2a36; border-color: #4a90d9; }
th { background: #2a2a2a; }
th,td { border-color: #333; }
hr { border-color: #333; }
}
</style>
</head>
<body>
${innerHtml}
</body>
</html>`;
      await invoke("open_note_preview", { html });
      flashToast("已在浏览器中打开");
    } catch (e) {
      errorToast(friendlyError(e, "打开失败"));
    }
  };

  return (
    <div className="notes-app">
      <aside className="notes-sidebar">
        <div className="notes-toolbar">
          <div className="notes-search-wrap">
            <input
              ref={searchInputRef}
              className="notes-search"
              placeholder="搜索  (使用 #标签)…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Escape") setSearch(""); }}
            />
            {search && (
              <button className="notes-search-clear" onClick={() => setSearch("")} title="清空搜索 (Esc)">✕</button>
            )}
          </div>
          <button className="notes-btn primary" onClick={handleNew} title="新建笔记 (Ctrl+N)">
            +
          </button>
        </div>

        <div className="side-section">
          <h4>分类</h4>
          {/* 键盘可达：roving tabindex + 方向键/Enter，见 handleRovingKeyDown */}
          <div role="listbox" aria-label="分类" onKeyDown={handleRovingKeyDown}>
            <div
              className={`cat-item ${selectedCategory === null ? "active" : ""}`}
              role="option"
              aria-selected={selectedCategory === null}
              tabIndex={selectedCategory === null ? 0 : -1}
              onClick={() => setSelectedCategory(null)}
            >
              全部
              <span className="cat-count">{notes.length}</span>
            </div>
            <div
              className={`cat-item ${selectedCategory === "" ? "active" : ""}`}
              role="option"
              aria-selected={selectedCategory === ""}
              tabIndex={selectedCategory === "" ? 0 : -1}
              onClick={() => setSelectedCategory("")}
            >
              未分类
              <span className="cat-count">{notes.filter((n) => !n.category).length}</span>
            </div>
            {categories.map((c) => (
              <div
                key={c}
                className={`cat-item ${selectedCategory === c ? "active" : ""}`}
                role="option"
                aria-selected={selectedCategory === c}
                tabIndex={selectedCategory === c ? 0 : -1}
                onClick={() => setSelectedCategory(c)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setCatMenu({ x: e.clientX, y: e.clientY, name: c });
                }}
                title={c}
              >
                <span className="cat-name">{c}</span>
                <span className="cat-count">{notes.filter((n) => n.category === c).length}</span>
              </div>
            ))}
          </div>
        </div>

        {allTags.length > 0 && (
          <div className="side-section">
            <h4>标签</h4>
            <div className="tag-cloud">
              {allTags.slice(0, 40).map(([t, count]) => (
                <span
                  key={t}
                  className="tag-chip"
                  onClick={() => {
                    const token = `#${t}`;
                    setSearch((prev) =>
                      prev.split(/\s+/).includes(token) ? prev : (prev ? prev + " " : "") + token,
                    );
                  }}
                  title={`${count} 条笔记`}
                >
                  #{t}
                </span>
              ))}
            </div>
          </div>
        )}

        <div
          className="notes-list"
          role="listbox"
          aria-label="笔记列表"
          onKeyDown={handleRovingKeyDown}
        >
          {filtered.length === 0 && (
            <div className="notes-empty">
              <div className="notes-empty-title">
                {notes.length === 0 ? "暂无笔记" : "无匹配结果"}
              </div>
              <div className="notes-empty-hint">
                {notes.length === 0 ? "点击右上角的 + 创建第一条笔记" : "试试更换关键词，或清除搜索条件"}
              </div>
              {search && (
                <button className="notes-btn" onClick={() => setSearch("")}>
                  清空搜索
                </button>
              )}
            </div>
          )}
          {filtered.map((n) => (
            <NoteRow
              key={n.id}
              note={n}
              isActive={n.id === selectedId}
              onSelect={handleSelectNote}
              onContextMenu={handleNoteContextMenu}
            />
          ))}
        </div>
        <div className="notes-list-status">
          {filtered.length} 条笔记
          {filtered.filter((n) => n.pinned).length > 0 &&
            ` · ${filtered.filter((n) => n.pinned).length} 条已置顶`}
        </div>
      </aside>

      <main className="notes-editor">
        {!selected ? (
          <div className="notes-blank">
            <p className="notes-blank-title">未选择任何笔记</p>
            <p className="notes-blank-hint">从左侧选择一条笔记，或立即新建</p>
            <button className="notes-btn primary" onClick={handleNew}>新建一条笔记</button>
          </div>
        ) : (
          <>
            <div className="notes-editor-header">
              <div className="notes-header-row">
                <input
                  className="notes-title-input"
                  value={draftTitle}
                  placeholder={UNTITLED}
                  onChange={(e) => setDraftTitle(e.target.value)}
                />
                <span className={`notes-saved-hint ${saveState === "saved" ? "visible" : ""}`}>
                  {saveState === "saving" ? "保存中…" : saveState === "saved" ? "✓ 已保存" : ""}
                  {saveState === "error" && (
                    <button
                      className="save-retry"
                      onClick={handleRetrySave}
                      title="上次保存失败，点击重试"
                    >
                      未保存·点击重试
                    </button>
                  )}
                </span>
                <div className="notes-view-segmented" role="group" aria-label="视图模式">
                  {(["edit", "split", "preview"] as const).map((m) => (
                    <button
                      key={m}
                      className={`notes-seg-btn ${viewMode === m ? "active" : ""}`}
                      onClick={() => setViewMode(m)}
                      title={m === "edit" ? "编辑视图" : m === "split" ? "分屏视图" : "预览视图"}
                    >
                      {m === "edit" ? "编辑" : m === "split" ? "分屏" : "预览"}
                    </button>
                  ))}
                </div>
              </div>
              <div className="notes-header-row">
                <input
                  className="cat-input"
                  list="note-cat-list"
                  value={draftCategory}
                  placeholder="分类"
                  onChange={(e) => setDraftCategory(e.target.value)}
                />
                <datalist id="note-cat-list">
                  {categories.map((c) => (
                    <option key={c} value={c} />
                  ))}
                </datalist>
                <div className="notes-actions">
                  <button className="notes-btn" onClick={handleOpenInBrowser} title="在默认浏览器中打开渲染后的笔记">
                    打开 ↗
                  </button>
                  <button className="notes-btn" onClick={handlePin} title="置顶">
                    {selected.pinned ? "取消置顶" : "置顶"}
                  </button>
                  <button className="notes-btn" onClick={handleCopy} title="复制内容">
                    复制
                  </button>
                  <button className="notes-btn danger" onClick={handleDelete} title="删除">
                    删除
                  </button>
                </div>
              </div>
            </div>

            <div className="notes-tags-row">
              {draftTags.map((t) => (
                <span key={t} className="notes-tag">
                  #{t}
                  <button
                    className="notes-tag-x"
                    onClick={() => setDraftTags((prev) => prev.filter((x) => x !== t))}
                  >
                    ×
                  </button>
                </span>
              ))}
              <input
                className="notes-tag-input"
                placeholder="添加标签 ↵"
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    handleTagAdd(tagInput);
                    setTagInput("");
                  }
                }}
              />
            </div>

            {viewMode !== "preview" && (
              <div className="notes-format-bar">
                <button className="notes-format-btn" onClick={() => wrapSelection("**", "**")} title="Bold (Ctrl+B)"><b>B</b></button>
                <button className="notes-format-btn" onClick={() => wrapSelection("*", "*")} title="Italic (Ctrl+I)"><i>I</i></button>
                <button className="notes-format-btn" onClick={() => wrapSelection("`", "`")} title="Inline code">{"< >"}</button>
                <span className="notes-format-sep" />
                <button className="notes-format-btn" onClick={() => insertAtLineStart("# ")} title="Heading 1">H1</button>
                <button className="notes-format-btn" onClick={() => insertAtLineStart("## ")} title="Heading 2">H2</button>
                <button className="notes-format-btn" onClick={() => insertAtLineStart("### ")} title="Heading 3">H3</button>
                <span className="notes-format-sep" />
                <button className="notes-format-btn" onClick={() => insertAtLineStart("- ")} title="Bullet list">• List</button>
                <button className="notes-format-btn" onClick={() => insertAtLineStart("1. ")} title="Numbered list">1. List</button>
                <button className="notes-format-btn" onClick={() => insertAtLineStart("> ")} title="Blockquote">" Quote</button>
                <span className="notes-format-sep" />
                <button className="notes-format-btn" onClick={() => wrapSelection("[", "](https://)")} title="Link"><IconLink /> Link</button>
                <button className="notes-format-btn" onClick={() => wrapSelection("```\n", "\n```")} title="Code block">{ } Block</button>
              </div>
            )}

            <div className={`notes-body${viewMode === "split" ? " split" : ""}`}>
              {viewMode !== "edit" && (
                <div className="notes-preview markdown-body">
                  {/* 不传 urlTransform：默认消毒只放行 http/https/mailto 等
                      安全协议，预览里 javascript: 链接不可执行。 */}
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {draftContent || "*暂无内容可预览。*"}
                  </ReactMarkdown>
                </div>
              )}
              {viewMode !== "preview" && (
                <textarea
                  ref={textareaRef}
                  className="notes-textarea"
                  value={draftContent}
                  placeholder="在此输入笔记…（支持 Markdown；Tab / Ctrl+B / Ctrl+I / Enter 继续列表）"
                  onChange={(e) => setDraftContent(e.target.value)}
                  onKeyDown={handleEditorKeyDown}
                  spellCheck={false}
                />
              )}
            </div>

            {selected.source_clip_id && (
              <div className="notes-source">来自剪贴板：{selected.source_clip_id.slice(0, 8)}…</div>
            )}
          </>
        )}
      </main>

      {toast && (
        <div className={`toast toast-${toast.type}`}>{toast.msg}</div>
      )}

      {confirmModal && (
        <div className="modal-overlay" onClick={() => setConfirmModal(null)}>
          <div className="exec-confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <h3 className="exec-confirm-title">{confirmModal.title}</h3>
            <p className="exec-confirm-desc">{confirmModal.message}</p>
            <div className="exec-confirm-buttons">
              <button className="exec-btn-cancel" onClick={() => setConfirmModal(null)}>取消</button>
              <button className="exec-btn-open" onClick={confirmModal.onConfirm}>确认</button>
            </div>
          </div>
        </div>
      )}

      {promptModal && (
        <PromptModal
          title={promptModal.title}
          defaultValue={promptModal.defaultValue}
          onCancel={() => setPromptModal(null)}
          onConfirm={(v) => { promptModal.onConfirm(v); }}
        />
      )}

      {noteMenu && (() => {
        const note = notes.find((n) => n.id === noteMenu.id);
        if (!note) return null;
        return (
          <>
            <div className="context-menu-overlay" onClick={() => setNoteMenu(null)} onContextMenu={(e) => { e.preventDefault(); setNoteMenu(null); }} />
            {/* ClampedMenu 渲染后实测尺寸再钳制，长标题不再溢出视口 */}
            <ClampedMenu x={noteMenu.x} y={noteMenu.y}>
              <div className="ctx-header" title={note.title || UNTITLED}>{note.title || UNTITLED}</div>
              <button className="ctx-item" onClick={() => { setNoteMenu(null); pinNote(note.id); }}>
                {note.pinned ? "取消置顶" : "置顶"}
              </button>
              <button className="ctx-item" onClick={() => { setNoteMenu(null); copyNote(note); }}>
                复制
              </button>
              <button className="ctx-item ctx-danger" onClick={() => { setNoteMenu(null); deleteNote(note); }}>
                删除
              </button>
            </ClampedMenu>
          </>
        );
      })()}

      {catMenu && (
        <>
          <div className="context-menu-overlay" onClick={() => setCatMenu(null)} onContextMenu={(e) => { e.preventDefault(); setCatMenu(null); }} />
          <ClampedMenu x={catMenu.x} y={catMenu.y}>
            <div className="ctx-header" title={catMenu.name}>分类：{catMenu.name}</div>
            <button className="ctx-item" onClick={async () => {
              const oldName = catMenu.name;
              setCatMenu(null);
              askText({
                title: "重命名分类",
                defaultValue: oldName,
                onConfirm: async (next) => {
                  setPromptModal(null);
                  const trimmed = next.trim();
                  if (!trimmed) {
                    errorToast("分类名不能为空");
                    return;
                  }
                  if (trimmed === oldName) return;
                  try {
                    const affected = await invoke<number>("rename_note_category", { from: oldName, to: trimmed });
                    await loadNotes();
                    if (selectedCategory === oldName) setSelectedCategory(trimmed);
                    flashToast(`已重命名 ${affected} 条笔记`);
                  } catch (err) {
                    errorToast(friendlyError(err, "重命名失败"));
                  }
                },
              });
            }}>
              重命名…
            </button>
            <button className="ctx-item ctx-danger" onClick={async () => {
              const name = catMenu.name;
              setCatMenu(null);
              ask({
                title: "删除分类",
                message: `确认删除分类「${name}」？分类下的笔记会被保留，但分类字段会被清空。`,
                onConfirm: async () => {
                  setConfirmModal(null);
                  try {
                    const affected = await invoke<number>("delete_note_category", { name });
                    await loadNotes();
                    if (selectedCategory === name) setSelectedCategory(null);
                    flashToast(`已清空 ${affected} 条笔记的分类`);
                  } catch (err) {
                    errorToast(friendlyError(err, "删除失败"));
                  }
                },
              });
            }}>
              删除分类
            </button>
          </ClampedMenu>
        </>
      )}
    </div>
  );
}
