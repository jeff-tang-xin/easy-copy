import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
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

const UNTITLED = "Untitled";

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
  const [toast, setToast] = useState<string | null>(null);
  // null = All, '' = Uncategorized, others = strict match on category name
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  // Right-click menu for category rename/delete
  const [catMenu, setCatMenu] = useState<{ x: number; y: number; name: string } | null>(null);
  // Right-click menu for a note in the list
  const [noteMenu, setNoteMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const [themeMode, setThemeMode] = useState<"auto" | "light" | "dark">(
    () =>
      (localStorage.getItem("easy-copy-theme") as any) ||
      (localStorage.getItem("theme") as any) ||
      "auto"
  );
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia("(prefers-color-scheme: dark)").matches
  );

  const theme = themeMode === "auto" ? (systemDark ? "dark" : "light") : themeMode;

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const fn = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener("change", fn);
    return () => mq.removeEventListener("change", fn);
  }, []);

  // Sync theme when clipboard window updates the shared key
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === "easy-copy-theme" && e.newValue) {
        setThemeMode(e.newValue as any);
      }
    };
    window.addEventListener("storage", onStorage);
    // also re-read on focus (same-origin storage events don't fire in same tab)
    const onFocus = () => {
      const cur = localStorage.getItem("easy-copy-theme");
      if (cur && cur !== themeMode) setThemeMode(cur as any);
    };
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("focus", onFocus);
    };
  }, [themeMode]);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

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
      console.error("list_notes failed", e);
    }
  }, []);

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

  // Global shortcuts: Ctrl+N new, Ctrl+F focus search, Esc clear search
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
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
        console.error("update_note failed", e);
        setSaveState("idle");
      }
    }, 400);
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
    };
  }, [draftTitle, draftContent, draftTags, draftCategory, selected]);

  const flashToast = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 1500);
  };

  const handleNew = async () => {
    try {
      const created = await invoke<Note>("create_note", {
        input: {
          title: "New note",
          content: "",
          tags: [],
          category: selectedCategory && selectedCategory !== "" ? selectedCategory : null,
        },
      });
      setNotes((prev) => [created, ...prev]);
      setSelectedId(created.id);
    } catch (e) {
      console.error(e);
    }
  };

  const handleDelete = async () => {
    if (!selected) return;
    if (!confirm(`Delete "${selected.title || UNTITLED}"?`)) return;
    try {
      await invoke("delete_note", { id: selected.id });
      setNotes((prev) => prev.filter((n) => n.id !== selected.id));
      setSelectedId((prev) => {
        const rest = notes.filter((n) => n.id !== prev);
        return rest[0]?.id ?? null;
      });
    } catch (e) {
      console.error(e);
    }
  };

  const handlePin = async () => {
    if (!selected) return;
    try {
      await invoke("toggle_note_pin", { id: selected.id });
      await loadNotes();
    } catch (e) {
      console.error(e);
    }
  };

  const handleCopy = async () => {
    if (!selected) return;
    try {
      await navigator.clipboard.writeText(selected.content);
      flashToast("Copied");
    } catch (e) {
      console.error(e);
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
      flashToast("Copied");
    } catch (e) {
      console.error(e);
    }
  };

  const pinNote = async (id: string) => {
    try {
      await invoke("toggle_note_pin", { id });
      await loadNotes();
    } catch (e) {
      console.error(e);
    }
  };

  const deleteNote = async (note: Note) => {
    if (!confirm(`Delete "${note.title || UNTITLED}"?`)) return;
    try {
      await invoke("delete_note", { id: note.id });
      setNotes((prev) => prev.filter((n) => n.id !== note.id));
      if (selectedId === note.id) {
        setSelectedId((prev) => {
          const rest = notes.filter((n) => n.id !== prev);
          return rest[0]?.id ?? null;
        });
      }
    } catch (e) {
      console.error(e);
    }
  };

  const [tagInput, setTagInput] = useState("");

  // Shared textarea ref for toolbar formatting actions
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

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
          {draftContent || "*Nothing to preview.*"}
        </ReactMarkdown>,
      );
      const html = `<!DOCTYPE html>
<html lang="en">
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
      flashToast("Opened in browser");
    } catch (e) {
      console.error("open_note_preview failed", e);
      flashToast(`Failed: ${e}`);
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
              placeholder="Search  (use #tag)…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Escape") setSearch(""); }}
            />
            {search && (
              <button className="notes-search-clear" onClick={() => setSearch("")} title="Clear search (Esc)">✕</button>
            )}
          </div>
          <button className="notes-btn primary" onClick={handleNew} title="New note (Ctrl+N)">
            +
          </button>
        </div>

        <div className="side-section">
          <h4>Categories</h4>
          <div
            className={`cat-item ${selectedCategory === null ? "active" : ""}`}
            onClick={() => setSelectedCategory(null)}
          >
            All
            <span className="cat-count">{notes.length}</span>
          </div>
          <div
            className={`cat-item ${selectedCategory === "" ? "active" : ""}`}
            onClick={() => setSelectedCategory("")}
          >
            Uncategorized
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
            <h4>Tags</h4>
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
                  title={`${count} note${count > 1 ? "s" : ""}`}
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
              {notes.length === 0 ? "No notes yet. Click + to create one." : "No matches."}
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
          {filtered.length} note{filtered.length !== 1 ? "s" : ""}
          {filtered.filter((n) => n.pinned).length > 0 &&
            ` · ${filtered.filter((n) => n.pinned).length} pinned`}
        </div>
      </aside>

      <main className="notes-editor">
        {!selected ? (
          <div className="notes-blank">
            <p>No note selected.</p>
            <button className="notes-btn primary" onClick={handleNew}>Create a note</button>
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
                  {saveState === "saving" ? "Saving…" : saveState === "saved" ? "✓ Saved" : ""}
                </span>
                <div className="notes-view-segmented" role="group" aria-label="View mode">
                  {(["edit", "split", "preview"] as const).map((m) => (
                    <button
                      key={m}
                      className={`notes-seg-btn ${viewMode === m ? "active" : ""}`}
                      onClick={() => setViewMode(m)}
                      title={`${m[0].toUpperCase()}${m.slice(1)} view`}
                    >
                      {m === "edit" ? "Edit" : m === "split" ? "Split" : "Preview"}
                    </button>
                  ))}
                </div>
              </div>
              <div className="notes-header-row">
                <input
                  className="cat-input"
                  list="note-cat-list"
                  value={draftCategory}
                  placeholder="Category"
                  onChange={(e) => setDraftCategory(e.target.value)}
                />
                <datalist id="note-cat-list">
                  {categories.map((c) => (
                    <option key={c} value={c} />
                  ))}
                </datalist>
                <div className="notes-actions">
                  <button className="notes-btn" onClick={handleOpenInBrowser} title="Open rendered note in default browser">
                    Open ↗
                  </button>
                  <button className="notes-btn" onClick={handlePin} title="Pin">
                    {selected.pinned ? "Unpin" : "Pin"}
                  </button>
                  <button className="notes-btn" onClick={handleCopy} title="Copy content">
                    Copy
                  </button>
                  <button className="notes-btn danger" onClick={handleDelete} title="Delete">
                    Delete
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
                placeholder="add tag ↵"
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
                    {draftContent || "*Nothing to preview.*"}
                  </ReactMarkdown>
                </div>
              )}
              {viewMode !== "preview" && (
                <textarea
                  ref={textareaRef}
                  className="notes-textarea"
                  value={draftContent}
                  placeholder="Write your notes here… (Markdown supported; Tab / Ctrl+B / Ctrl+I / Enter continue list)"
                  onChange={(e) => setDraftContent(e.target.value)}
                  onKeyDown={handleEditorKeyDown}
                  spellCheck={false}
                />
              )}
            </div>

            {selected.source_clip_id && (
              <div className="notes-source">From clipboard item: {selected.source_clip_id.slice(0, 8)}…</div>
            )}
          </>
        )}
      </main>

      {toast && <div className="notes-toast">{toast}</div>}

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
                {note.pinned ? "Unpin" : "Pin"}
              </button>
              <button className="ctx-item" onClick={() => { setNoteMenu(null); copyNote(note); }}>
                Copy
              </button>
              <button className="ctx-item ctx-danger" onClick={() => { setNoteMenu(null); deleteNote(note); }}>
                Delete
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
            <div className="ctx-header" title={catMenu.name}>Category: {catMenu.name}</div>
            <button className="ctx-item" onClick={async () => {
              const oldName = catMenu.name;
              setCatMenu(null);
              const next = window.prompt(`Rename category "${oldName}" to:`, oldName);
              if (next === null) return;
              const trimmed = next.trim();
              if (!trimmed || trimmed === oldName) return;
              try {
                const affected = await invoke<number>("rename_note_category", { from: oldName, to: trimmed });
                await loadNotes();
                if (selectedCategory === oldName) setSelectedCategory(trimmed);
                setToast(`Renamed ${affected} note${affected === 1 ? "" : "s"}`);
                setTimeout(() => setToast(null), 1500);
              } catch (err) {
                setToast(`Rename failed: ${err}`);
                setTimeout(() => setToast(null), 2000);
              }
            }}>
              Rename…
            </button>
            <button className="ctx-item ctx-danger" onClick={async () => {
              const name = catMenu.name;
              setCatMenu(null);
              const ok = window.confirm(`Delete category "${name}"? Notes under it will become uncategorized (notes are kept).`);
              if (!ok) return;
              try {
                const affected = await invoke<number>("delete_note_category", { name });
                await loadNotes();
                if (selectedCategory === name) setSelectedCategory(null);
                setToast(`Cleared category on ${affected} note${affected === 1 ? "" : "s"}`);
                setTimeout(() => setToast(null), 1500);
              } catch (err) {
                setToast(`Delete failed: ${err}`);
                setTimeout(() => setToast(null), 2000);
              }
            }}>
              Delete category
            </button>
          </div>
        </>
      )}
    </div>
  );
}
