import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTheme } from "./hooks/useTheme";
import { useToast } from "./hooks/useToast";
import { friendlyError } from "./hooks/friendlyError";
import ReactMarkdown from "react-markdown";
import { renderToStaticMarkup } from "react-dom/server";
import remarkGfm from "remark-gfm";
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

function formatDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString();
}

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

  // Strip markdown markers for a short content preview (first line-ish, ~80 chars)
  const previewText = (content: string): string => {
    const t = content.replace(/[#>*_`~\-]+/g, " ").replace(/\s+/g, " ").trim();
    return t.length > 80 ? t.slice(0, 80) + "…" : t;
  };

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
      lastLoadedId.current = selected.id;
      setDraftTitle(selected.title);
      setDraftContent(selected.content);
      setDraftTags(selected.tags);
      setDraftCategory(selected.category ?? "");
    }
  }, [selected]);

  // Debounced auto-save
  const saveTimer = useRef<number | null>(null);
  const [saveState, setSaveState] = useState<"saved" | "saving" | "idle">("idle");
  const searchInputRef = useRef<HTMLInputElement>(null);
  // Mirror of the content textarea used by the toolbar's wrap/insert helpers
  // and the markdown keyboard shortcuts (Ctrl+B / Ctrl+I / Tab / list-enter).
  // Without this, `textareaRef.current` in wrapSelection / insertAtLineStart
  // would throw at runtime.
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!selected) return;
    // Skip on the very first load of a note (no diff)
    if (
      draftTitle === selected.title &&
      draftContent === selected.content &&
      JSON.stringify(draftTags) === JSON.stringify(selected.tags) &&
      (draftCategory || null) === (selected.category || null)
    ) {
      return;
    }
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    setSaveState("saving");
    saveTimer.current = window.setTimeout(async () => {
      try {
        const updated = await invoke<Note | null>("update_note", {
          id: selected.id,
          input: {
            title: draftTitle.trim() || UNTITLED,
            content: draftContent,
            tags: draftTags,
            category: draftCategory.trim() ? draftCategory.trim() : null,
          },
        });
        if (updated) {
          setNotes((prev) => prev.map((n) => (n.id === updated.id ? updated : n)));
          setSaveState("saved");
          window.setTimeout(() => setSaveState("idle"), 1500);
        }
      } catch (e) {
        errorToast(friendlyError(e, "保存失败"));
        setSaveState("idle");
      }
    }, 400);
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
    };
  }, [draftTitle, draftContent, draftTags, draftCategory, selected, errorToast]);

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
      const innerHtml = renderToStaticMarkup(
        <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={(url) => url}>
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
          <div
            className={`cat-item ${selectedCategory === null ? "active" : ""}`}
            onClick={() => setSelectedCategory(null)}
          >
            全部
            <span className="cat-count">{notes.length}</span>
          </div>
          <div
            className={`cat-item ${selectedCategory === "" ? "active" : ""}`}
            onClick={() => setSelectedCategory("")}
          >
            未分类
            <span className="cat-count">{notes.filter((n) => !n.category).length}</span>
          </div>
          {categories.map((c) => (
            <div
              key={c}
              className={`cat-item ${selectedCategory === c ? "active" : ""}`}
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

        <div className="notes-list">
          {filtered.length === 0 && (
            <div className="notes-empty">
              {notes.length === 0 ? "暂无笔记。点击 + 创建一条。" : "无匹配结果。"}
            </div>
          )}
          {filtered.map((n) => (
            <div
              key={n.id}
              className={`notes-item ${n.id === selectedId ? "active" : ""}`}
              onClick={() => setSelectedId(n.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setNoteMenu({ x: e.clientX, y: e.clientY, id: n.id });
              }}
            >
              <div className="notes-item-title">
                {n.pinned && <span className="notes-pin">📌</span>}
                {n.title || UNTITLED}
              </div>
              {previewText(n.content) && (
                <div className="notes-item-preview">{previewText(n.content)}</div>
              )}
              <div className="notes-item-meta">
                <span>{formatDate(n.updated_at)}</span>
                {n.tags.length > 0 && (
                  <span className="notes-item-tags">{n.tags.slice(0, 3).map((t) => `#${t}`).join(" ")}</span>
                )}
              </div>
            </div>
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
            <p>未选择任何笔记。</p>
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
                <button className="notes-format-btn" onClick={() => wrapSelection("[", "](https://)")} title="Link">🔗 Link</button>
                <button className="notes-format-btn" onClick={() => wrapSelection("```\n", "\n```")} title="Code block">{ } Block</button>
              </div>
            )}

            <div className={`notes-body${viewMode === "split" ? " split" : ""}`}>
              {viewMode !== "edit" && (
                <div className="notes-preview markdown-body">
                  <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={(url) => url}>
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
            <div
              className="context-menu"
              style={{ left: Math.min(noteMenu.x, window.innerWidth - 200), top: Math.min(noteMenu.y, window.innerHeight - 200) }}
            >
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
            </div>
          </>
        );
      })()}

      {catMenu && (
        <>
          <div className="context-menu-overlay" onClick={() => setCatMenu(null)} onContextMenu={(e) => { e.preventDefault(); setCatMenu(null); }} />
          <div
            className="context-menu"
            style={{ left: Math.min(catMenu.x, window.innerWidth - 200), top: Math.min(catMenu.y, window.innerHeight - 160) }}
          >
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
          </div>
        </>
      )}
    </div>
  );
}
