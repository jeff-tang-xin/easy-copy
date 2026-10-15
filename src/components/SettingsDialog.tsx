import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  IconSettings, IconExport, IconImport,
} from "./Icons";
import { friendlyError } from "../hooks/friendlyError";
import type { ToastKind } from "../hooks/useToast";
// 复用 useClipboard 导出的 AppConfig：此处原本自带一份字段完全相同的副本，
// 两份定义各自演进迟早会漂移（后端只有一个 Config 结构），故统一为单一来源。
import type { AppConfig } from "../hooks/useClipboard";

interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
  onSaved?: (config: AppConfig) => void;
  showToast: (msg: string, type?: ToastKind) => void;
  onExport?: () => void;
  onImport?: () => void;
}

/** Format a KeyboardEvent as a "Ctrl+Shift+V" style combo, or null while only modifiers are held. */
function formatCombo(e: React.KeyboardEvent): string | null {
  const key = e.key;
  if (key === "Control" || key === "Shift" || key === "Alt" || key === "Meta") {
    return null; // Modifier pressed alone — wait for the actual key.
  }
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.shiftKey) parts.push("Shift");
  if (e.altKey) parts.push("Alt");
  if (e.metaKey) parts.push("Super");
  if (key === " ") parts.push("Space");
  else if (key.length === 1) parts.push(key.toUpperCase());
  else parts.push(key); // "F2", "ArrowUp", "Home", …
  return parts.join("+");
}

/**
 * Shortcut field with an explicit record button: clicking it focuses the input
 * and captures the next key combo ("Ctrl+Shift+V" format). Esc cancels
 * recording; without the button the input still accepts plain manual typing.
 */
function ShortcutInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const [recording, setRecording] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const startRecording = () => {
    setRecording(true);
    inputRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!recording) return; // Plain typing path — leave the input alone.
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setRecording(false);
      return;
    }
    const combo = formatCombo(e);
    if (combo === null) {
      e.preventDefault(); // Modifier alone: swallow so it doesn't type.
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    onChange(combo);
    setRecording(false);
  };

  return (
    <div className="shortcut-field">
      <input
        ref={inputRef}
        className={`settings-input${recording ? " recording" : ""}`}
        type="text"
        placeholder={recording ? "按下组合键…" : placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => setRecording(false)}
      />
      <button
        type="button"
        className="shortcut-record-btn"
        onClick={startRecording}
        title="点击后按下想要的组合键"
      >
        {recording ? "录制中…" : "录制"}
      </button>
    </div>
  );
}

export function SettingsDialog({
  open,
  onClose,
  onSaved,
  showToast,
  onExport,
  onImport,
}: SettingsDialogProps) {
  const [config, setConfig] = useState<AppConfig>({
    max_items: 500,
    poll_interval_ms: 500,
    clipboard_shortcut: "Ctrl+Shift+V",
    notes_shortcut: "Ctrl+Shift+N",
    tools_shortcut: "Ctrl+Shift+T",
    screenshot_shortcut: "Ctrl+Shift+S",
    api_shortcut: "Ctrl+Shift+U",
    copy_on_double_click: true,
    auto_hide_on_copy: true,
    storage_root: null,
  });
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  // In-progress text for the two number inputs, or null when not being edited.
  //
  // Why a separate draft instead of writing straight to `config`: these fields
  // must be clamped to a valid range, but clamping on every keystroke makes
  // them impossible to use — typing "2000" got rewritten to "50" as soon as the
  // first "2" landed, and clearing the box snapped to 500. The draft holds the
  // raw text while the user types; the value is parsed and clamped on blur.
  //
  // Note `draft` takes priority in `value={draft ?? config.x}`, so a stale draft
  // would mask freshly loaded config. `if (!open) return null` only skips
  // rendering — it does NOT unmount, so hook state survives a close/reopen when
  // the parent keeps this mounted. The open effect below resets both drafts for
  // that reason; do not rely on unmounting to clear them.
  const [maxItemsDraft, setMaxItemsDraft] = useState<string | null>(null);
  const [pollDraft, setPollDraft] = useState<string | null>(null);
  // Snapshot of the last-loaded/saved config, used to detect unsaved edits:
  // backdrop clicks must not silently discard them (cancel button still can).
  const [baseline, setBaseline] = useState<AppConfig | null>(null);

  // Load config whenever the dialog opens.
  useEffect(() => {
    if (!open) return;
    // Drop any abandoned edit text so the reloaded config is what shows.
    setMaxItemsDraft(null);
    setPollDraft(null);
    let cancelled = false;
    setLoading(true);
    invoke<AppConfig>("get_config")
      .then((c) => {
        if (cancelled) return;
        setConfig(c);
        setBaseline(c);
      })
      .catch((e) => showToast(friendlyError(e, "加载配置失败"), "error"))
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, showToast]);

  if (!open) return null;

  // Clamp bounds mirror the backend (`clamp_max_items` 50..=2000 and
  // `clamp_poll_interval` 200..=60000). Keeping them in sync matters: a value
  // the front-end accepts but the backend rewrites would silently disagree with
  // what the user sees.
  const clampMaxItems = (n: number) => Math.min(2000, Math.max(50, n));
  const clampPoll = (n: number) => Math.min(60000, Math.max(200, n));

  // Resolve a draft string to a committed, clamped number. Empty/garbage input
  // falls back to the value already in config rather than a magic constant, so
  // clearing the box and clicking away restores what was there instead of
  // teleporting to 500.
  const commit = (draft: string | null, current: number, clamp: (n: number) => number) => {
    if (draft === null) return current;
    const n = parseInt(draft, 10);
    return Number.isNaN(n) ? current : clamp(n);
  };

  const onMaxItemsBlur = () => {
    // 函数式更新：blur 与其它异步 setConfig（如 get_config 回填、选择文件夹）
    // 可能交错，闭包快照式 `{...config}` 会把对方的更新整份覆盖掉。
    setConfig((c) => ({ ...c, max_items: commit(maxItemsDraft, c.max_items, clampMaxItems) }));
    setMaxItemsDraft(null);
  };
  const onPollBlur = () => {
    setConfig((c) => ({
      ...c,
      poll_interval_ms: commit(pollDraft, c.poll_interval_ms, clampPoll),
    }));
    setPollDraft(null);
  };

  const handleSave = async () => {
    // Saving via keyboard (or clicking straight from a focused input) can fire
    // before blur commits, so fold any pending draft in here rather than
    // relying on the blur handlers' async state updates.
    const merged: AppConfig = {
      ...config,
      max_items: commit(maxItemsDraft, config.max_items, clampMaxItems),
      poll_interval_ms: commit(pollDraft, config.poll_interval_ms, clampPoll),
    };
    setConfig(merged);
    setMaxItemsDraft(null);
    setPollDraft(null);
    setSaving(true);
    try {
      await invoke("set_config", { config: merged });
      setBaseline(merged);
      showToast("设置已保存");
      onSaved?.(merged);
      onClose();
    } catch (err) {
      showToast(friendlyError(err, "保存失败"), "error");
    } finally {
      setSaving(false);
    }
  };

  const handleSelectFolder = async () => {
    try {
      const sel = await invoke<string>("select_folder");
      // Functional update: `config` captured before the await is stale by the
      // time the folder picker closes, so spreading it would clobber any edit
      // committed while the dialog was open.
      if (sel) setConfig((c) => ({ ...c, storage_root: sel }));
    } catch (e) {
      showToast(friendlyError(e, "选择文件夹失败"), "error");
    }
  };

  // Backdrop clicks must not silently discard unsaved edits — steer the user
  // to the Save/Cancel buttons instead (Esc is already swallowed by App's
  // global handler while settings are open, so backdrop is the only risk).
  const hasUnsavedChanges =
    baseline !== null && JSON.stringify(config) !== JSON.stringify(baseline);
  const requestClose = () => {
    if (hasUnsavedChanges) {
      showToast("有未保存的修改，请点击「保存」或「取消」", "error");
      return;
    }
    onClose();
  };

  return (
    <div className="modal-overlay" onClick={requestClose}>
      <div className="settings-dialog" onClick={(e) => e.stopPropagation()}>
        <h3 className="settings-title">
          <IconSettings /> 设置
        </h3>

        {loading ? (
          <div className="settings-loading">加载中…</div>
        ) : (
          <>
            <div className="settings-row">
              <label className="settings-label">最大历史条数</label>
              <input
                className="settings-input"
                type="number"
                min="50"
                max="2000"
                value={maxItemsDraft ?? config.max_items}
                onChange={(e) => setMaxItemsDraft(e.target.value)}
                onBlur={onMaxItemsBlur}
              />
            </div>

            <div className="settings-row">
              <label className="settings-label">轮询间隔 (毫秒)</label>
              <input
                className="settings-input"
                type="number"
                min="200"
                max="60000"
                value={pollDraft ?? config.poll_interval_ms}
                onChange={(e) => setPollDraft(e.target.value)}
                onBlur={onPollBlur}
              />
            </div>

            <div className="settings-row settings-row-toggle">
              <label className="settings-label" htmlFor="copy-on-dbl">
                双击复制
              </label>
              <input
                id="copy-on-dbl"
                className="settings-checkbox"
                type="checkbox"
                checked={config.copy_on_double_click}
                onChange={(e) =>
                  setConfig({ ...config, copy_on_double_click: e.target.checked })
                }
              />
              <span className="settings-hint">
                关闭后，双击文本条目会打开预览窗口而非直接复制
              </span>
            </div>

            <div className="settings-row settings-row-toggle">
              <label className="settings-label" htmlFor="auto-hide-on-copy">
                复制后自动隐藏
              </label>
              <input
                id="auto-hide-on-copy"
                className="settings-checkbox"
                type="checkbox"
                checked={config.auto_hide_on_copy}
                onChange={(e) =>
                  setConfig({ ...config, auto_hide_on_copy: e.target.checked })
                }
              />
              <span className="settings-hint">
                复制成功后自动隐藏主窗口（默认开启，Esc 也可手动隐藏）
              </span>
            </div>

            <div className="settings-row">
              <label className="settings-label">剪贴板快捷键</label>
              <ShortcutInput
                placeholder="Ctrl+Shift+V"
                value={config.clipboard_shortcut}
                onChange={(v) => setConfig({ ...config, clipboard_shortcut: v })}
              />
            </div>

            <div className="settings-row">
              <label className="settings-label">笔记快捷键</label>
              <ShortcutInput
                placeholder="Ctrl+Shift+N"
                value={config.notes_shortcut}
                onChange={(v) => setConfig({ ...config, notes_shortcut: v })}
              />
            </div>

            <div className="settings-row">
              <label className="settings-label">工具快捷键</label>
              <ShortcutInput
                placeholder="Ctrl+Shift+T"
                value={config.tools_shortcut}
                onChange={(v) => setConfig({ ...config, tools_shortcut: v })}
              />
            </div>

            <div className="settings-row">
              <label className="settings-label">截图快捷键</label>
              <ShortcutInput
                placeholder="Ctrl+Shift+S"
                value={config.screenshot_shortcut}
                onChange={(v) => setConfig({ ...config, screenshot_shortcut: v })}
              />
            </div>

            <div className="settings-row">
              <label className="settings-label">API 快捷键</label>
              <ShortcutInput
                placeholder="Ctrl+Shift+U"
                value={config.api_shortcut}
                onChange={(v) => setConfig({ ...config, api_shortcut: v })}
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
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      storage_root: e.target.value || null,
                    })
                  }
                />
                <button
                  className="settings-action-btn"
                  onClick={handleSelectFolder}
                >
                  浏览
                </button>
              </div>
              <span className="settings-hint">
                剪贴板历史、笔记、截图与 API 集合的保存位置。留空使用默认目录。
              </span>
            </div>

            <div className="settings-row">
              <label className="settings-label">数据管理</label>
              <div className="settings-buttons-row">
                <button
                  className="settings-action-btn"
                  onClick={() => onExport?.()}
                >
                  <IconExport /> 导出
                </button>
                <button
                  className="settings-action-btn"
                  onClick={() => onImport?.()}
                >
                  <IconImport /> 导入
                </button>
              </div>
            </div>
          </>
        )}

        <div className="settings-footer">
          <button className="exec-btn-cancel" onClick={onClose}>
            取消
          </button>
          <button
            className="exec-btn-open"
            onClick={handleSave}
            disabled={saving || loading}
          >
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}
