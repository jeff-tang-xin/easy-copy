import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  IconSettings, IconExport, IconImport,
} from "./Icons";
import { friendlyError } from "../hooks/friendlyError";
import type { ToastKind } from "../hooks/useToast";

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

interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
  onSaved?: (config: AppConfig) => void;
  showToast: (msg: string, type?: ToastKind) => void;
  onExport?: () => void;
  onImport?: () => void;
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
    storage_root: null,
  });
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  // Load config whenever the dialog opens.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    invoke<AppConfig>("get_config")
      .then((c) => { if (!cancelled) setConfig(c); })
      .catch((e) => showToast(friendlyError(e, "加载配置失败"), "error"))
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, showToast]);

  if (!open) return null;

  const handleSave = async () => {
    setSaving(true);
    try {
      await invoke("set_config", { config });
      showToast("设置已保存");
      onSaved?.(config);
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
      if (sel) setConfig({ ...config, storage_root: sel });
    } catch (e) {
      showToast(friendlyError(e, "选择文件夹失败"), "error");
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
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
                max="5000"
                value={config.max_items}
                onChange={(e) =>
                  setConfig({
                    ...config,
                    max_items: Math.max(50, parseInt(e.target.value) || 500),
                  })
                }
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
                onChange={(e) =>
                  setConfig({
                    ...config,
                    poll_interval_ms: Math.max(200, parseInt(e.target.value) || 500),
                  })
                }
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

            <div className="settings-row">
              <label className="settings-label">剪贴板快捷键</label>
              <input
                className="settings-input"
                type="text"
                placeholder="Ctrl+Shift+V"
                value={config.clipboard_shortcut}
                onChange={(e) =>
                  setConfig({ ...config, clipboard_shortcut: e.target.value })
                }
              />
            </div>

            <div className="settings-row">
              <label className="settings-label">笔记快捷键</label>
              <input
                className="settings-input"
                type="text"
                placeholder="Ctrl+Shift+N"
                value={config.notes_shortcut}
                onChange={(e) =>
                  setConfig({ ...config, notes_shortcut: e.target.value })
                }
              />
            </div>

            <div className="settings-row">
              <label className="settings-label">工具快捷键</label>
              <input
                className="settings-input"
                type="text"
                placeholder="Ctrl+Shift+T"
                value={config.tools_shortcut}
                onChange={(e) =>
                  setConfig({ ...config, tools_shortcut: e.target.value })
                }
              />
            </div>

            <div className="settings-row">
              <label className="settings-label">截图快捷键</label>
              <input
                className="settings-input"
                type="text"
                placeholder="Ctrl+Shift+S"
                value={config.screenshot_shortcut}
                onChange={(e) =>
                  setConfig({ ...config, screenshot_shortcut: e.target.value })
                }
              />
            </div>

            <div className="settings-row">
              <label className="settings-label">API 快捷键</label>
              <input
                className="settings-input"
                type="text"
                placeholder="Ctrl+Shift+U"
                value={config.api_shortcut}
                onChange={(e) =>
                  setConfig({ ...config, api_shortcut: e.target.value })
                }
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
