/**
 * useClipboard — shared hook for clipboard-history windows.
 *
 * Encapsulates all the state + side-effects related to the clipboard
 * history list: fetching, searching, deleting, copying, image loading,
 * stats, undo, and the clipboard-update / shortcut-error event listeners.
 *
 * Previously all of this lived inline in App.tsx (~300 lines). Extracting
 * it means:
 *   - App.tsx becomes pure rendering (JSX + layout).
 *   - The logic is reusable if another window ever needs clipboard data.
 *   - Tests (if we ever add them) can exercise the hook without mounting
 *     the whole app.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { friendlyError } from "./friendlyError";
import type { UseToastReturn } from "./useToast";

export interface ClipboardItem {
  id: string;
  type: "Text" | "Image" | "Files";
  content: string;
  timestamp: string;
  favorite: boolean;
  tags: string[];
  saved_as_note?: boolean;
}

export interface AppConfig {
  max_items: number;
  poll_interval_ms: number;
  clipboard_shortcut: string;
  notes_shortcut: string;
  tools_shortcut: string;
  screenshot_shortcut: string;
  api_shortcut: string;
  copy_on_double_click: boolean;
  storage_root: string | null;
}

export interface ImageCache {
  [id: string]: string;
}

export interface ClipboardStats {
  count: number;
  size: number;
}

export interface UseClipboardOptions {
  /** Toast helper for surfacing errors & info messages. */
  showToast: UseToastReturn["showToast"];
}

export interface UseClipboardReturn {
  items: ClipboardItem[];
  search: string;
  setSearch: (v: string) => void;
  copiedId: string | null;
  imageCache: ImageCache;
  stats: ClipboardStats;
  incognito: boolean;
  /** Refresh the list from the backend (also reloads images + stats). */
  refresh: () => Promise<void>;
  handleCopy: (id: string) => Promise<void>;
  handleDelete: (id: string, e: React.MouseEvent) => Promise<void>;
  undoToast: ClipboardItem | null;
  handleUndoDelete: () => Promise<void>;
  handleClear: () => Promise<void>;
  handleToggleIncognito: () => Promise<void>;
  handleExport: () => Promise<void>;
  handleImport: () => void;
  toggleFavorite: (id: string) => Promise<void>;
  addTag: (id: string, tag: string) => Promise<void>;
  removeTag: (id: string, tag: string) => Promise<void>;
  getAllTags: () => Promise<string[]>;
}

export function useClipboard({ showToast }: UseClipboardOptions): UseClipboardReturn {
  const [items, setItems] = useState<ClipboardItem[]>([]);
  const [search, setSearch] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [imageCache, setImageCache] = useState<ImageCache>({});
  const imageCacheRef = useRef<ImageCache>({});
  const [stats, setStats] = useState<ClipboardStats>({ count: 0, size: 0 });
  const [incognito, setIncognito] = useState(false);

  // Delete-undo state
  const [undoToast, setUndoToast] = useState<ClipboardItem | null>(null);
  const undoTimerRef = useRef<number | null>(null);

  // Search debounce
  const searchRef = useRef("");
  const searchTimerRef = useRef<number | null>(null);
  const searchGenRef = useRef(0);
  const mountedRef = useRef(true);

  // Mark unmounted so in-flight invokes can short-circuit.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadImage = useCallback(async (id: string) => {
    if (imageCacheRef.current[id]) return;
    try {
      const data = await invoke<string | null>("get_image_data", { id });
      if (!mountedRef.current) return;
      if (data) {
        imageCacheRef.current[id] = data;
        setImageCache((prev) => ({ ...prev, [id]: data }));
      } else {
        showToast(`图片加载失败：${id.slice(0, 8)}`, "error");
      }
    } catch (e) {
      showToast(friendlyError(e, "图片加载失败"), "error");
    }
  }, [showToast]);

  const refresh = useCallback(async () => {
    try {
      const history = await invoke<ClipboardItem[]>("get_history");
      if (!mountedRef.current) return;
      setItems(history);
      history
        .filter((i) => i.type === "Image")
        .forEach((i) => loadImage(i.id));
      const [count, size] = await invoke<[number, number]>("get_stats");
      if (!mountedRef.current) return;
      setStats({ count, size });
    } catch (e) {
      showToast(friendlyError(e, "刷新历史失败"), "error");
    }
  }, [loadImage, showToast]);

  // Auto-refresh on clipboard updates + shortcut-error forwarding.
  useEffect(() => {
    refresh();
    const unlisten = listen<ClipboardItem>("clipboard-update", () => {
      refresh();
    });
    const unlistenShortcutError = listen<string>("shortcut-error", (event) => {
      showToast(event.payload, "error");
    });
    return () => {
      unlisten.then((fn) => fn());
      unlistenShortcutError.then((fn) => fn());
    };
  }, [refresh, showToast]);

  // Intercept window close: hide instead of destroy.
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

  // Debounced search.
  const handleSearch = useCallback((value: string) => {
    setSearch(value);
    searchRef.current = value;
    if (searchTimerRef.current !== null) {
      clearTimeout(searchTimerRef.current);
    }
    const myGen = ++searchGenRef.current;
    searchTimerRef.current = window.setTimeout(async () => {
      if (!mountedRef.current) return;
      if (searchGenRef.current !== myGen) return;
      if (value.trim()) {
        try {
          const results = await invoke<ClipboardItem[]>("search_history", { query: value });
          if (!mountedRef.current) return;
          if (searchGenRef.current !== myGen) return;
          setItems(results);
          results
            .filter((i) => i.type === "Image")
            .forEach((i) => loadImage(i.id));
        } catch (e) {
          if (searchGenRef.current === myGen) {
            showToast(friendlyError(e, "搜索失败"), "error");
          }
        }
      } else {
        refresh();
      }
    }, 150);
  }, [loadImage, refresh, showToast]);

  // Expose `setSearch` but route through the debounced handler so callers
  // can't bypass the debounce by writing directly to state.
  const setSearchDebounced = useCallback((v: string) => handleSearch(v), [handleSearch]);

  const handleCopy = useCallback(async (id: string) => {
    try {
      await invoke("copy_to_clipboard", { id });
      setCopiedId(id);
      setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), 1500);
    } catch (err) {
      showToast(friendlyError(err, "复制失败"), "error");
    }
  }, [showToast]);

  const handleDelete = useCallback(async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const item = items.find((i) => i.id === id);
    try {
      await invoke("delete_item", { id });
    } catch (err) {
      showToast(friendlyError(err, "删除失败"), "error");
      return;
    }
    refresh();
    if (item) {
      if (undoTimerRef.current) window.clearTimeout(undoTimerRef.current);
      setUndoToast(item);
      undoTimerRef.current = window.setTimeout(() => {
        setUndoToast(null);
        undoTimerRef.current = null;
      }, 3000);
    }
  }, [items, refresh, showToast]);

  const handleUndoDelete = useCallback(async () => {
    if (!undoToast) return;
    if (undoTimerRef.current) {
      window.clearTimeout(undoTimerRef.current);
      undoTimerRef.current = null;
    }
    try {
      await invoke("restore_item", { item: undoToast });
      setUndoToast(null);
      refresh();
    } catch (err) {
      showToast(friendlyError(err, "恢复失败"), "error");
    }
  }, [undoToast, refresh, showToast]);

  const handleClear = useCallback(async () => {
    try {
      await invoke("clear_history");
      setItems([]);
      setImageCache({});
      imageCacheRef.current = {};
    } catch (err) {
      showToast(friendlyError(err, "清空失败"), "error");
    }
  }, [showToast]);

  const handleToggleIncognito = useCallback(async () => {
    const next = !incognito;
    setIncognito(next);
    try {
      await invoke("set_incognito", { enabled: next });
    } catch (err) {
      setIncognito(!next);
      showToast(friendlyError(err, "切换失败"), "error");
      return;
    }
    showToast(next ? "已开启隐身模式 - 暂停记录" : "已关闭隐身模式 - 恢复记录");
  }, [incognito, showToast]);

  const handleExport = useCallback(async () => {
    try {
      const json = await invoke<string>("export_history");
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `easy-copy-history-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      showToast("历史已导出");
    } catch (e) {
      showToast(friendlyError(e, "导出失败"), "error");
    }
  }, [showToast]);

  const handleImport = useCallback(() => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const count = await invoke<number>("import_history", { json: text });
        showToast(`已导入 ${count} 条`);
        refresh();
      } catch (err) {
        showToast(friendlyError(err, "导入失败"), "error");
      }
    };
    input.click();
  }, [refresh, showToast]);

  const toggleFavorite = useCallback(async (id: string) => {
    try {
      await invoke("toggle_favorite", { id });
      await refresh();
    } catch (err) {
      showToast(friendlyError(err, "操作失败"), "error");
    }
  }, [refresh, showToast]);

  const addTag = useCallback(async (id: string, tag: string) => {
    try {
      await invoke("add_tag", { id, tag });
      await refresh();
    } catch (err) {
      showToast(friendlyError(err, "添加标签失败"), "error");
    }
  }, [refresh, showToast]);

  const removeTag = useCallback(async (id: string, tag: string) => {
    try {
      await invoke("remove_tag", { id, tag });
      await refresh();
    } catch (err) {
      showToast(friendlyError(err, "移除标签失败"), "error");
    }
  }, [refresh, showToast]);

  const getAllTags = useCallback(async () => {
    try {
      return await invoke<string[]>("get_all_tags");
    } catch (err) {
      showToast(friendlyError(err, "加载标签失败"), "error");
      return [];
    }
  }, [showToast]);

  return {
    items,
    search,
    setSearch: setSearchDebounced,
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
    toggleFavorite,
    addTag,
    removeTag,
    getAllTags,
  };
}
