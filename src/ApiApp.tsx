import { useEffect, useRef, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { JsonView } from "./JsonView";
import "./App.css";
import "./ApiApp.css";

/* =============================================================
 * API Platform - Postman-like HTTP client built on Tauri.
 *
 * Data model mirrors the Rust structs in src-tauri/src/models.rs:
 *   ApiState { nodes: ApiNode[], envs: ApiEnvironment[], active_env_id }
 *   ApiNode  { id, parent_id, name, node_type: Folder|Request, request?: ApiRequest }
 *   ApiRequest { method, url, headers[], query[], path_vars[], body_type,
 *                body_raw_lang, body?, form_data[], url_encoded[],
 *                binary_file?, msgpack_file?, history[] }
 *   FormField { key, value, type: text|file, file_path?, file_name? }
 *
 * Backend commands (all registered in lib.rs):
 *   api_load_state() -> ApiState
 *   api_save_node(node) -> ApiNode
 *   api_delete_node(id)
 *   api_save_env(env) -> ApiEnvironment
 *   api_delete_env(id)
 *   api_set_active_env(env_id?)
 *   api_execute(request) -> ApiResponse
 *   select_file() -> Option<String>      (native file picker via rfd)
 * ============================================================= */

// ── Types ──────────────────────────────────────────────────────

interface FormField {
  key: string;
  value: string;
  type: "text" | "file";
  file_path?: string | null;
  file_name?: string | null;
}

interface ApiRequest {
  method: string;
  url: string;
  headers: [string, string][];
  query: [string, string][];
  path_vars: [string, string][];
  body_type: string;
  body_raw_lang: string;
  body?: string | null;
  form_data: FormField[];
  url_encoded: [string, string][];
  binary_file?: string | null;
  msgpack_file?: string | null;
  env_id?: string | null;
  history: ApiResponse[];
}

interface ApiResponse {
  status: number;
  status_text: string;
  headers: [string, string][];
  request_headers: [string, string][];
  body?: string | null;
  duration_ms: number;
  timestamp: number;
  error?: string | null;
}

interface ApiNode {
  id: string;
  parent_id: string | null;
  name: string;
  node_type: "folder" | "request";
  request?: ApiRequest | null;
  created_at: number;
  updated_at: number;
}

interface ApiEnvironment {
  id: string;
  name: string;
  vars: [string, string][];
}

interface ApiState {
  nodes: ApiNode[];
  envs: ApiEnvironment[];
  active_env_id: string | null;
}

// ── Helpers ────────────────────────────────────────────────────

const uid = () => crypto.randomUUID();
const now = () => Date.now();

function newRequest(): ApiRequest {
  return {
    method: "GET",
    url: "",
    headers: [["", ""]],
    query: [["", ""]],
    path_vars: [["", ""]],
    body_type: "none",
    body_raw_lang: "json",
    body: "",
    form_data: [{ key: "", value: "", type: "text" }],
    url_encoded: [["", ""]],
    binary_file: null,
    msgpack_file: null,
    env_id: null,
    history: [],
  };
}

function newFolder(name: string, parentId: string | null): ApiNode {
  return { id: uid(), parent_id: parentId, name, node_type: "folder", request: null, created_at: now(), updated_at: now() };
}

function newRequestNode(name: string, parentId: string | null): ApiNode {
  return { id: uid(), parent_id: parentId, name, node_type: "request", request: newRequest(), created_at: now(), updated_at: now() };
}

/** Extract path vars from URL like /api/:id/users/:userId -> [["id",""],["userId",""]] */
function extractPathVars(url: string): string[] {
  const matches = url.match(/:(\w+)/g) || [];
  return matches.map(m => m.slice(1));
}

const METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"];

const RAW_LANGS = ["json", "xml", "javascript", "text", "html"] as const;

const BODY_TYPES = ["none", "form-data", "urlencoded", "binary", "msgpack", "raw"] as const;

const STATUS_CLASS = (s: number) =>
  s >= 200 && s < 300 ? "api-status-2xx" :
  s >= 300 && s < 400 ? "api-status-3xx" :
  s >= 400 && s < 500 ? "api-status-4xx" : "api-status-5xx";

/* =============================================================
 * Theme hook (shared with App.tsx / NotesApp.tsx / ToolsApp.tsx)
 * Reads "easy-copy-theme" from localStorage, syncs across windows
 * via storage + focus events, sets html[data-theme] attribute.
 * Without this, CSS custom properties (var(--bg-primary), ...) are
 * undefined and the entire UI renders unstyled.
 * ============================================================= */

function useTheme() {
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

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === "easy-copy-theme" && e.newValue) {
        setThemeMode(e.newValue as any);
      }
    };
    window.addEventListener("storage", onStorage);
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
}
// ── Modal: Input Dialog ────────────────────────────────────────

interface InputModalProps {
  title: string;
  label?: string;
  initialValue?: string;
  confirmText?: string;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}

function InputModal({ title, label, initialValue = "", confirmText = "OK", onConfirm, onCancel }: InputModalProps) {
  const [val, setVal] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") { e.preventDefault(); onConfirm(val); }
    if (e.key === "Escape") { e.preventDefault(); onCancel(); }
  };

  return (
    <div className="api-modal-overlay" onMouseDown={onCancel}>
      <div className="api-modal" onMouseDown={e => e.stopPropagation()}>
        <div className="api-modal-title">{title}</div>
        {label && <label className="api-modal-label">{label}</label>}
        <input
          ref={inputRef}
          className="api-modal-input"
          type="text"
          value={val}
          onChange={e => setVal(e.target.value)}
          onKeyDown={handleKey}
          placeholder="Enter name..."
        />
        <div className="api-modal-actions">
          <button className="api-btn api-btn-secondary" onClick={onCancel}>Cancel</button>
          <button className="api-btn" onClick={() => onConfirm(val)} disabled={!val.trim()}>{confirmText}</button>
        </div>
      </div>
    </div>
  );
}

// ── Modal: Confirm Dialog ──────────────────────────────────────

interface ConfirmModalProps {
  title: string;
  message: string;
  confirmText?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

function ConfirmModal({ title, message, confirmText = "Confirm", danger = false, onConfirm, onCancel }: ConfirmModalProps) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onCancel(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onCancel]);

  return (
    <div className="api-modal-overlay" onMouseDown={onCancel}>
      <div className="api-modal" onMouseDown={e => e.stopPropagation()}>
        <div className="api-modal-title">{title}</div>
        <p className="api-modal-message">{message}</p>
        <div className="api-modal-actions">
          <button className="api-btn api-btn-secondary" onClick={onCancel}>Cancel</button>
          <button className={danger ? "api-btn api-btn-danger" : "api-btn"} onClick={onConfirm}>{confirmText}</button>
        </div>
      </div>
    </div>
  );
}

// ── Context Menu ───────────────────────────────────────────────

interface ContextMenuItem {
  label: string;
  icon?: string;
  danger?: boolean;
  onClick: () => void;
}

function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: ContextMenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const escHandler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("mousedown", handler);
    window.addEventListener("keydown", escHandler);
    return () => {
      window.removeEventListener("mousedown", handler);
      window.removeEventListener("keydown", escHandler);
    };
  }, [onClose]);

  return (
    <div ref={ref} className="api-context-menu" style={{ left: x, top: y }}>
      {items.map((item, i) => (
        <button key={i} className={`api-context-item${item.danger ? " danger" : ""}`} onClick={() => { item.onClick(); onClose(); }}>
          {item.icon && <span className="api-context-icon">{item.icon}</span>}
          {item.label}
        </button>
      ))}
    </div>
  );
}

// ── Modal: Move to Folder ──────────────────────────────────────────

interface MoveToModalProps {
  node: ApiNode;
  nodes: ApiNode[];
  onConfirm: (newParentId: string | null) => void;
  onCancel: () => void;
}

function MoveToModal({ node, nodes, onConfirm, onCancel }: MoveToModalProps) {
  const [selected, setSelected] = useState<string | null>(null);

  const forbidden = (() => {
    const out = new Set<string>([node.id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const n of nodes) {
        if (n.parent_id && out.has(n.parent_id) && !out.has(n.id)) {
          out.add(n.id);
          changed = true;
        }
      }
    }
    return out;
  })();

  const childrenOf = (parentId: string | null): ApiNode[] =>
    nodes.filter(n => n.parent_id === parentId && n.node_type === "folder" && !forbidden.has(n.id));

  const renderFolder = (folder: ApiNode, depth: number): React.ReactNode => {
    const children = childrenOf(folder.id);
    return (
      <div key={folder.id}>
        <button
          type="button"
          className={"api-moveto-item" + (selected === folder.id ? " api-moveto-selected" : "")}
          style={{ paddingLeft: 8 + depth * 16 }}
          onClick={() => setSelected(folder.id)}
        >
          <span className="api-moveto-icon">📁</span>
          <span className="api-moveto-name">{folder.name}</span>
        </button>
        {children.map(child => renderFolder(child, depth + 1))}
      </div>
    );
  };

  const rootFolders = childrenOf(null);
  const hasAnyTarget = rootFolders.length > 0;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onCancel(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onCancel]);

  return (
    <div className="api-modal-overlay" onMouseDown={onCancel}>
      <div className="api-modal" onMouseDown={e => e.stopPropagation()}>
        <div className="api-modal-title">Move "{node.name}" to...</div>
        <div className="api-moveto-tree">
          <button
            type="button"
            className={"api-moveto-item api-moveto-root" + (selected === null ? " api-moveto-selected" : "")}
            onClick={() => setSelected(null)}
          >
            <span className="api-moveto-icon">🏠</span>
            <span className="api-moveto-name">Root (top level)</span>
          </button>
          {rootFolders.map(f => renderFolder(f, 1))}
        </div>
        {!hasAnyTarget && (
          <div className="api-hint">No other folders available.</div>
        )}
        <div className="api-modal-actions">
          <button className="api-btn api-btn-secondary" onClick={onCancel}>Cancel</button>
          <button
            className="api-btn api-btn-primary"
            disabled={!hasAnyTarget}
            onClick={() => onConfirm(selected)}
          >
            Move here
          </button>
        </div>
      </div>
    </div>
  );
}

// ── KV Editor (headers, query, path vars, url_encoded) ─────────

interface KvEditorProps {
  pairs: [string, string][];
  onChange: (pairs: [string, string][]) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
}

function KvEditor({ pairs, onChange, keyPlaceholder = "key", valuePlaceholder = "value" }: KvEditorProps) {
  const update = (i: number, field: 0 | 1, val: string) => {
    const next = pairs.map(([k, v], idx) => idx === i ? (field === 0 ? [val, v] : [k, val]) as [string, string] : [k, v] as [string, string]);
    onChange(next);
  };

  const addRow = () => onChange([...pairs, ["", ""]]);

  const removeRow = (i: number) => {
    if (pairs.length <= 1) {
      onChange([["", ""]]);
      return;
    }
    onChange(pairs.filter((_, idx) => idx !== i));
  };

  return (
    <div className="api-kv-table">
      {pairs.map(([k, v], i) => (
        <div key={i} className="api-kv-row">
          <input
            className="api-kv-input"
            type="text"
            value={k}
            onChange={e => update(i, 0, e.target.value)}
            placeholder={keyPlaceholder}
          />
          <input
            className="api-kv-input"
            type="text"
            value={v}
            onChange={e => update(i, 1, e.target.value)}
            placeholder={valuePlaceholder}
          />
          <button className="api-kv-delete" onClick={() => removeRow(i)} title="Remove">×</button>
        </div>
      ))}
      <button className="api-kv-add" onClick={addRow}>+ Add Row</button>
    </div>
  );
}

// ── Form-Data Editor ───────────────────────────────────────────

interface FormDataEditorProps {
  fields: FormField[];
  onChange: (fields: FormField[]) => void;
}

function FormDataEditor({ fields, onChange }: FormDataEditorProps) {
  const update = (i: number, patch: Partial<FormField>) => {
    onChange(fields.map((f, idx) => idx === i ? { ...f, ...patch } : f));
  };

  const addRow = () => onChange([...fields, { key: "", value: "", type: "text" }]);

  const removeRow = (i: number) => {
    if (fields.length <= 1) { onChange([{ key: "", value: "", type: "text" }]); return; }
    onChange(fields.filter((_, idx) => idx !== i));
  };

  const pickFile = async (i: number) => {
    try {
      const path = await invoke<string | null>("select_file");
      if (path) {
        const name = path.split(/[\\/]/).pop() || path;
        update(i, { file_path: path, file_name: name, type: "file" });
      }
    } catch { /* user cancelled */ }
  };

  return (
    <div className="api-kv-table">
      {fields.map((f, i) => (
        <div key={i} className="api-form-row">
          <input
            className="api-kv-input"
            type="text"
            value={f.key}
            onChange={e => update(i, { key: e.target.value })}
            placeholder="key"
          />
          <select
            className="api-form-type-select"
            value={f.type}
            onChange={e => update(i, { type: e.target.value as "text" | "file" })}
          >
            <option value="text">Text</option>
            <option value="file">File</option>
          </select>
          {f.type === "file" ? (
            <div className="api-form-file-cell">
              <input
                className="api-kv-input api-form-file-input"
                type="text"
                value={f.file_path || ""}
                onChange={e => update(i, { file_path: e.target.value })}
                placeholder="file path"
                readOnly
              />
              <button className="api-form-browse-btn" onClick={() => pickFile(i)}>Browse</button>
            </div>
          ) : (
            <input
              className="api-kv-input"
              type="text"
              value={f.value}
              onChange={e => update(i, { value: e.target.value })}
              placeholder="value"
            />
          )}
          <button className="api-kv-delete" onClick={() => removeRow(i)} title="Remove">×</button>
        </div>
      ))}
      <button className="api-kv-add" onClick={addRow}>+ Add Field</button>
    </div>
  );
}
// ── Body Editor ────────────────────────────────────────────────

interface BodyEditorProps {
  req: ApiRequest;
  onChange: (req: ApiRequest) => void;
}

function BodyEditor({ req, onChange }: BodyEditorProps) {
  const setBodyType = (bt: string) => onChange({ ...req, body_type: bt });
  const setRawLang = (lang: string) => onChange({ ...req, body_raw_lang: lang, body_type: "raw" });
  const setBody = (body: string) => onChange({ ...req, body });

  const pickBinaryFile = async () => {
    try {
      const path = await invoke<string | null>("select_file");
      if (path) onChange({ ...req, binary_file: path });
    } catch { /* cancelled */ }
  };

  const pickMsgpackFile = async () => {
    try {
      const path = await invoke<string | null>("select_file");
      if (path) onChange({ ...req, msgpack_file: path });
    } catch { /* cancelled */ }
  };

  return (
    <div className="api-body-editor">
      <div className="api-body-types">
        {BODY_TYPES.map(bt => (
          <button
            key={bt}
            className={`api-body-type${req.body_type === bt ? " active" : ""}`}
            onClick={() => setBodyType(bt)}
          >
            {bt === "urlencoded" ? "x-www-form-urlencoded" : bt === "form-data" ? "form-data" : bt}
          </button>
        ))}
      </div>

      <div className="api-body-content">
        {req.body_type === "none" && (
          <div className="api-hint">This request does not have a body.</div>
        )}

        {req.body_type === "form-data" && (
          <FormDataEditor
            fields={req.form_data?.length ? req.form_data : [{ key: "", value: "", type: "text" }]}
            onChange={form_data => onChange({ ...req, form_data })}
          />
        )}

        {req.body_type === "urlencoded" && (
          <KvEditor
            pairs={req.url_encoded?.length ? req.url_encoded : [["", ""]]}
            onChange={url_encoded => onChange({ ...req, url_encoded })}
            keyPlaceholder="key"
            valuePlaceholder="value"
          />
        )}

        {req.body_type === "binary" && (
          <div className="api-file-picker">
            <div className="api-file-picker-row">
              <input
                className="api-kv-input"
                type="text"
                value={req.binary_file || ""}
                onChange={e => onChange({ ...req, binary_file: e.target.value })}
                placeholder="Select a file..."
                readOnly
              />
              <button className="api-browse-btn" onClick={pickBinaryFile}>Browse</button>
            </div>
            {req.binary_file && <div className="api-hint">File: <code>{req.binary_file}</code></div>}
          </div>
        )}

        {req.body_type === "msgpack" && (
          <div className="api-file-picker">
            <div className="api-file-picker-row">
              <input
                className="api-kv-input"
                type="text"
                value={req.msgpack_file || ""}
                onChange={e => onChange({ ...req, msgpack_file: e.target.value })}
                placeholder="Select a file..."
                readOnly
              />
              <button className="api-browse-btn" onClick={pickMsgpackFile}>Browse</button>
            </div>
            {req.msgpack_file && <div className="api-hint">File: <code>{req.msgpack_file}</code></div>}
          </div>
        )}

        {req.body_type === "raw" && (
          <>
            <div className="api-raw-lang-bar">
              {RAW_LANGS.map(lang => (
                <button
                  key={lang}
                  className={`api-raw-lang${(req.body_raw_lang || "json") === lang ? " active" : ""}`}
                  onClick={() => setRawLang(lang)}
                >
                  {lang}
                </button>
              ))}
            </div>
            <textarea
              className="api-body-textarea"
              value={req.body || ""}
              onChange={e => setBody(e.target.value)}
              placeholder={`Enter ${req.body_raw_lang || "json"} content here...`}
              spellCheck={false}
            />
          </>
        )}
      </div>
    </div>
  );
}
// ── Tree Node (Sidebar) ────────────────────────────────────────

interface TreeNodeProps {
  node: ApiNode;
  nodes: ApiNode[];
  selectedId: string | null;
  collapsedIds: Set<string>;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
  onRename: (node: ApiNode) => void;
  onDelete: (node: ApiNode) => void;
  onDuplicate: (node: ApiNode) => void;
  onContextMenu: (e: React.MouseEvent, node: ApiNode) => void;
}

function TreeNode({
  node, nodes, selectedId, collapsedIds,
  onSelect, onToggle, onRename, onDelete, onDuplicate, onContextMenu,
}: TreeNodeProps) {
  const children = nodes.filter(n => n.parent_id === node.id);
  const isFolder = node.node_type === "folder";
  const isCollapsed = collapsedIds.has(node.id);
  const isSelected = selectedId === node.id;

  return (
    <div className="api-tree-folder">
      <div
        className={`api-tree-row${isSelected ? " selected" : ""}${isCollapsed ? " collapsed" : ""}`}
        onClick={() => isFolder ? onToggle(node.id) : onSelect(node.id)}
        onDoubleClick={() => onRename(node)}
        onContextMenu={e => onContextMenu(e, node)}
      >
        {isFolder && <span className="api-tree-icon">▼</span>}
        {isFolder ? (
          <span className="api-tree-name">📁 {node.name}</span>
        ) : (
          <>
            <span className={`api-method api-method-${(node.request?.method || "get").toLowerCase()}`}>
              {node.request?.method || "GET"}
            </span>
            <span className="api-tree-name api-tree-request">{node.name}</span>
          </>
        )}
      </div>
      {isFolder && !isCollapsed && children.length > 0 && (
        <div className="api-tree-children">
          {children.map(child => (
            <TreeNode
              key={child.id}
              node={child}
              nodes={nodes}
              selectedId={selectedId}
              collapsedIds={collapsedIds}
              onSelect={onSelect}
              onToggle={onToggle}
              onRename={onRename}
              onDelete={onDelete}
              onDuplicate={onDuplicate}
              onContextMenu={onContextMenu}
            />
          ))}
        </div>
      )}
    </div>
  );
}
// ── Response Viewer ────────────────────────────────────────────

interface ResponseViewerProps {
  response: ApiResponse | null;
  loading: boolean;
  error: string | null;
}

function ResponseViewer({ response, loading, error }: ResponseViewerProps) {
  const [tab, setTab] = useState<"body" | "headers" | "request">("body");
  const [view, setView] = useState<"pretty" | "raw">("pretty");

  if (loading) {
    return (
      <div className="api-response-inner">
        <div className="api-response-header">
          <div className="api-spinner" />
          <span className="api-duration">Sending request...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="api-response-inner">
        <div className="api-error">{error}</div>
      </div>
    );
  }

  if (!response) {
    return (
      <div className="api-response-inner">
        <div className="api-placeholder">
          <svg className="api-placeholder-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
          </svg>
          <h3>No Response Yet</h3>
          <p>Send a request to see the response here.</p>
        </div>
      </div>
    );
  }

  const isJson = (() => {
    try { JSON.parse(response.body || ""); return true; } catch { return false; }
  })();

  return (
    <div className="api-response-inner">
      <div className="api-response-header">
        <span className={`api-status ${STATUS_CLASS(response.status)}`}>
          {response.status} {response.status_text}
        </span>
        <span className="api-duration">{response.duration_ms}ms</span>
        {response.error && <span className="api-error-inline">⚠ {response.error}</span>}
      </div>

      <div className="api-response-tabs">
        <button className={`api-tab${tab === "body" ? " active" : ""}`} onClick={() => setTab("body")}>Body</button>
        <button className={`api-tab${tab === "headers" ? " active" : ""}`} onClick={() => setTab("headers")}>
          Headers{response.headers.length > 0 && <span className="api-tab-badge">{response.headers.length}</span>}
        </button>
        <button className={`api-tab${tab === "request" ? " active" : ""}`} onClick={() => setTab("request")}>
          Request{response.request_headers.length > 0 && <span className="api-tab-badge">{response.request_headers.length}</span>}
        </button>
      </div>

      <div className="api-response-content">
        {tab === "body" && (
          <>
            {response.body ? (
              <>
                <div className="api-view-toggle">
                  <button className={view === "pretty" ? "active" : ""} onClick={() => setView("pretty")} disabled={!isJson}>Pretty</button>
                  <button className={view === "raw" ? "active" : ""} onClick={() => setView("raw")}>Raw</button>
                </div>
                {view === "pretty" && isJson ? (
                  <div className="api-pretty"><JsonView data={JSON.parse(response.body!)} /></div>
                ) : (
                  <pre className="api-raw">{response.body}</pre>
                )}
              </>
            ) : (
              <div className="api-hint">Response body is empty.</div>
            )}
          </>
        )}

        {tab === "headers" && (
          <div>
            {response.headers.length === 0 ? (
              <div className="api-hint">No response headers.</div>
            ) : (
              response.headers.map(([name, value], i) => (
                <div key={i} className="api-h-row">
                  <span className="api-h-name">{name}</span>
                  <span className="api-h-value">{value}</span>
                </div>
              ))
            )}
          </div>
        )}

        {tab === "request" && (
          <div>
            {response.request_headers.length === 0 ? (
              <div className="api-hint">No request headers captured.</div>
            ) : (
              response.request_headers.map(([name, value], i) => (
                <div key={i} className="api-h-row">
                  <span className="api-h-name">{name}</span>
                  <span className="api-h-value">{value}</span>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
// ── Main App ───────────────────────────────────────────────────

export default function ApiApp() {
  useTheme();
  const [state, setState] = useState<ApiState>({ nodes: [], envs: [], active_env_id: null });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [response, setResponse] = useState<ApiResponse | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"headers" | "query" | "path" | "body">("headers");

  // Modal state
  const [inputModal, setInputModal] = useState<{ title: string; label?: string; initial?: string; confirmText?: string; onConfirm: (v: string) => void } | null>(null);
  const [confirmModal, setConfirmModal] = useState<{ title: string; message: string; confirmText?: string; danger?: boolean; onConfirm: () => void } | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);
  const [moveToModal, setMoveToModal] = useState<{ node: ApiNode } | null>(null);

  // ── Load state on mount ──────────────────────────────────────

  const loadState = useCallback(async () => {
    try {
      const s = await invoke<ApiState>("api_load_state");
      setState(s);
      if (s.nodes.length > 0) {
        const firstReq = s.nodes.find(n => n.node_type === "request");
        if (firstReq) setSelectedId(firstReq.id);
      }
    } catch (e) {
      console.error("Failed to load API state:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadState(); }, [loadState]);

  // ── Derived ──────────────────────────────────────────────────

  const selectedNode = state.nodes.find(n => n.id === selectedId) || null;
  const activeEnv = state.envs.find(e => e.id === state.active_env_id) || null;

  // Auto-sync path vars with URL
  const urlPathVars = selectedNode?.request ? extractPathVars(selectedNode.request.url) : [];

  // ── Node operations ─────────────────────────────────────────

  const saveNode = useCallback(async (node: ApiNode) => {
    try {
      const saved = await invoke<ApiNode>("api_save_node", { node: { ...node, updated_at: now() } });
      setState(prev => {
        const idx = prev.nodes.findIndex(n => n.id === saved.id);
        const nodes = idx >= 0
          ? prev.nodes.map(n => n.id === saved.id ? saved : n)
          : [...prev.nodes, saved];
        return { ...prev, nodes };
      });
    } catch (e) {
      console.error("Failed to save node:", e);
    }
  }, []);

  const deleteNodeById = useCallback(async (id: string) => {
    try {
      await invoke("api_delete_node", { id });
      setState(prev => {
        // Collect descendants
        const toRemove = new Set<string>([id]);
        let changed = true;
        while (changed) {
          changed = false;
          for (const n of prev.nodes) {
            if (n.parent_id && toRemove.has(n.parent_id) && !toRemove.has(n.id)) {
              toRemove.add(n.id);
              changed = true;
            }
          }
        }
        return { ...prev, nodes: prev.nodes.filter(n => !toRemove.has(n.id)) };
      });
      if (selectedId === id) setSelectedId(null);
    } catch (e) {
      console.error("Failed to delete node:", e);
    }
  }, [selectedId]);

  const duplicateNode = useCallback((node: ApiNode) => {
    const copy: ApiNode = {
      ...node,
      id: uid(),
      name: `${node.name} (copy)`,
      created_at: now(),
      updated_at: now(),
      request: node.request ? { ...node.request, history: [] } : null,
    };
    saveNode(copy);
  }, [saveNode]);

  // ── Add operations ──────────────────────────────────────────

  const addFolder = (parentId: string | null) => {
    setInputModal({
      title: "New Folder",
      label: "Folder name",
      initial: "New Folder",
      confirmText: "Create",
      onConfirm: (name) => {
        setInputModal(null);
        saveNode(newFolder(name, parentId));
      },
    });
  };

  const addRequest = (parentId: string | null) => {
    setInputModal({
      title: "New Request",
      label: "Request name",
      initial: "New Request",
      confirmText: "Create",
      onConfirm: (name) => {
        setInputModal(null);
        const node = newRequestNode(name, parentId);
        saveNode(node).then(() => setSelectedId(node.id));
      },
    });
  };

  // ── Rename ───────────────────────────────────────────────────

  const startRename = (node: ApiNode) => {
    setInputModal({
      title: `Rename ${node.node_type}`,
      label: "Name",
      initial: node.name,
      confirmText: "Rename",
      onConfirm: (name) => {
        setInputModal(null);
        saveNode({ ...node, name });
      },
    });
  };

  // ── Context menu ─────────────────────────────────────────────

  const showContextMenu = (e: React.MouseEvent, node: ApiNode) => {
    e.preventDefault();
    e.stopPropagation();
    const items: ContextMenuItem[] = [
      { label: "Rename", onClick: () => startRename(node) },
      { label: "Duplicate", onClick: () => duplicateNode(node) },
      { label: "Move to...", onClick: () => setMoveToModal({ node }) },
    ];
    if (node.node_type === "folder") {
      items.push(
        { label: "Add Folder", onClick: () => addFolder(node.id) },
        { label: "Add Request", onClick: () => addRequest(node.id) },
      );
    }
    items.push({ label: "Delete", danger: true, onClick: () => {
      setConfirmModal({
        title: "Delete",
        message: `Delete "${node.name}"?${node.node_type === "folder" ? " All contents will be removed." : ""}`,
        confirmText: "Delete",
        danger: true,
        onConfirm: () => { setConfirmModal(null); deleteNodeById(node.id); },
      });
    }});
    setContextMenu({ x: e.clientX, y: e.clientY, items });
  };

  // ── Move to (context menu → modal) ───────────────────────────

  // Move a node to a new parent folder (or top level if newParentId is null).
  // Used by the "Move to..." context menu + MoveToModal flow.
  const moveNode = (nodeToMove: ApiNode, newParentId: string | null) => {
    if (nodeToMove.id === newParentId) return;          // can't be own parent
    if (nodeToMove.parent_id === newParentId) return;   // no-op

    // Prevent moving a folder into its own descendant (would create cycle)
    if (newParentId) {
      let current: string | undefined = newParentId;
      while (current) {
        if (current === nodeToMove.id) return;
        const parent = state.nodes.find(n => n.id === current);
        if (!parent) break;
        current = parent.parent_id || undefined;
      }
    }

    saveNode({ ...nodeToMove, parent_id: newParentId });
    setMoveToModal(null);
  };
  // ── Request editing ──────────────────────────────────────────

  const updateRequest = useCallback((patch: Partial<ApiRequest>) => {
    if (!selectedNode) return;
    const updatedReq = { ...selectedNode.request!, ...patch };
    saveNode({ ...selectedNode, request: updatedReq });
  }, [selectedNode, saveNode]);

  // Sync path vars: add new ones from URL, keep existing values
  useEffect(() => {
    if (!selectedNode?.request) return;
    const urlVars = extractPathVars(selectedNode.request.url);
    const existing = selectedNode.request.path_vars || [];
    const synced: [string, string][] = urlVars.map(key => {
      const found = existing.find(([k]) => k === key);
      return found || [key, ""];
    });
    // Only update if changed
    const existingKeys = existing.map(([k]) => k).join(",");
    const newKeys = urlVars.join(",");
    if (existingKeys !== newKeys) {
      updateRequest({ path_vars: synced.length > 0 ? synced : [["", ""]] });
    }
  }, [selectedNode?.request?.url]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Send request ─────────────────────────────────────────────

  const sendRequest = async () => {
    if (!selectedNode?.request) return;
    const req = selectedNode.request;
    setSending(true);
    setSendError(null);
    setResponse(null);
    try {
      // Filter out empty pairs
      const cleanReq: ApiRequest = {
        ...req,
        headers: req.headers.filter(([k]) => k.trim()),
        query: req.query.filter(([k]) => k.trim()),
        path_vars: req.path_vars.filter(([k]) => k.trim()),
        url_encoded: (req.url_encoded || []).filter(([k]) => k.trim()),
        form_data: (req.form_data || []).filter(f => f.key.trim()),
        env_id: state.active_env_id,
      };
      const resp = await invoke<ApiResponse>("api_execute", { request: cleanReq });
      setResponse(resp);
      // Save to history
      if (selectedNode) {
        const newHistory = [resp, ...(req.history || [])].slice(0, 50);
        saveNode({ ...selectedNode, request: { ...req, history: newHistory } });
      }
    } catch (e: any) {
      setSendError(String(e?.message || e));
    } finally {
      setSending(false);
    }
  };

  // ── Environment operations ───────────────────────────────────

  const addEnv = () => {
    setInputModal({
      title: "New Environment",
      label: "Environment name",
      initial: "New Environment",
      confirmText: "Create",
      onConfirm: (name) => {
        setInputModal(null);
        const env: ApiEnvironment = { id: uid(), name, vars: [["", ""]] };
        invoke<ApiEnvironment>("api_save_env", { env }).then(saved => {
          setState(prev => ({ ...prev, envs: [...prev.envs, saved] }));
        });
      },
    });
  };

  const updateEnv = (env: ApiEnvironment) => {
    invoke<ApiEnvironment>("api_save_env", { env }).then(saved => {
      setState(prev => ({ ...prev, envs: prev.envs.map(e => e.id === saved.id ? saved : e) }));
    });
  };

  const deleteEnv = (env: ApiEnvironment) => {
    setConfirmModal({
      title: "Delete Environment",
      message: `Delete environment "${env.name}"?`,
      confirmText: "Delete",
      danger: true,
      onConfirm: () => {
        setConfirmModal(null);
        invoke("api_delete_env", { id: env.id }).then(() => {
          setState(prev => ({
            ...prev,
            envs: prev.envs.filter(e => e.id !== env.id),
            active_env_id: prev.active_env_id === env.id ? null : prev.active_env_id,
          }));
        });
      },
    });
  };

  const setActiveEnv = (envId: string | null) => {
    invoke("api_set_active_env", { envId }).then(() => {
      setState(prev => ({ ...prev, active_env_id: envId }));
    });
  };

  // ── Render ───────────────────────────────────────────────────

  if (loading) {
    return <div className="api-app"><div className="api-placeholder"><div className="api-spinner" /></div></div>;
  }

  const req = selectedNode?.request || null;
  const headerCount = req?.headers?.filter(([k]) => k.trim()).length || 0;
  const queryCount = req?.query?.filter(([k]) => k.trim()).length || 0;
  const pathCount = req?.path_vars?.filter(([k]) => k.trim()).length || 0;
  const hasBody = req?.body_type && req.body_type !== "none";

  return (
    <div className="api-app">
      {/* ── Sidebar ── */}
      <div className="api-sidebar">
        {/* Collections */}
        <div className="api-sidebar-section" style={{ flex: 1 }}>
          <div className="api-sidebar-header">
            <span className="api-sidebar-title">Collections</span>
            <div className="api-sidebar-actions">
              <button className="api-icon-btn" onClick={() => addFolder(null)} title="New Folder">📁+</button>
              <button className="api-icon-btn" onClick={() => addRequest(null)} title="New Request">+</button>
            </div>
          </div>
          <div className="api-tree">
            {state.nodes.filter(n => n.parent_id === null).length === 0 ? (
              <div className="api-empty">
                No collections yet.
                <br />
                Click + to create a request.
              </div>
            ) : (
              state.nodes
                .filter(n => n.parent_id === null)
                .map(node => (
                  <TreeNode
                    key={node.id}
                    node={node}
                    nodes={state.nodes}
                    selectedId={selectedId}
                    collapsedIds={collapsedIds}
                    onSelect={setSelectedId}
                    onToggle={id => setCollapsedIds(prev => {
                      const next = new Set(prev);
                      next.has(id) ? next.delete(id) : next.add(id);
                      return next;
                    })}
                    onRename={startRename}
                    onDelete={(n) => showContextMenu({ preventDefault: () => {}, stopPropagation: () => {}, clientX: 0, clientY: 0 } as any, n)}
                    onDuplicate={duplicateNode}
                    onContextMenu={showContextMenu}
                  />
                ))
            )}
          </div>
        </div>

        {/* Environments */}
        <div className="api-sidebar-section">
          <div className="api-sidebar-header">
            <span className="api-sidebar-title">Environments</span>
            <div className="api-sidebar-actions">
              <button className="api-icon-btn" onClick={addEnv} title="New Environment">+</button>
            </div>
          </div>
          <div className="api-envs">
            {state.envs.length === 0 ? (
              <div className="api-empty">No environments.</div>
            ) : (
              state.envs.map(env => {
                const isActive = state.active_env_id === env.id;
                return (
                  <div key={env.id} className={`api-env-block${isActive ? " active" : ""}`}>
                    <div className="api-env-row" onClick={() => setActiveEnv(isActive ? null : env.id)}>
                      <span style={{ flex: 1 }}>{isActive ? "✓" : "○"} {env.name}</span>
                      <button className="api-mini-btn" onClick={e => { e.stopPropagation(); deleteEnv(env); }}>×</button>
                    </div>
                    {isActive && (
                      <div className="api-env-vars">
                        {env.vars.map(([k, v], i) => (
                          <div key={i} className="api-env-var-row">
                            <input
                              className="api-kv-input"
                              type="text"
                              value={k}
                              onChange={e => {
                                const next = env.vars.map((p, idx) => idx === i ? [e.target.value, p[1]] as [string, string] : p);
                                updateEnv({ ...env, vars: next });
                              }}
                              placeholder="key"
                            />
                            <input
                              className="api-kv-input"
                              type="text"
                              value={v}
                              onChange={e => {
                                const next = env.vars.map((p, idx) => idx === i ? [p[0], e.target.value] as [string, string] : p);
                                updateEnv({ ...env, vars: next });
                              }}
                              placeholder="value"
                            />
                            <button
                              className="api-mini-btn"
                              onClick={() => {
                                const next = env.vars.filter((_, idx) => idx !== i);
                                updateEnv({ ...env, vars: next.length > 0 ? next : [["", ""]] });
                              }}
                            >×</button>
                          </div>
                        ))}
                        <button className="api-env-add-btn" onClick={() => updateEnv({ ...env, vars: [...env.vars, ["", ""]] })}>
                          + Add Variable
                        </button>
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
      {/* ── Editor (middle) ── */}
      <div className="api-editor">
        {req ? (
          <div className="api-editor-inner">
            <div className="api-editor-topbar">
              <div className="api-editor-name" onClick={() => selectedNode && startRename(selectedNode)}>
                {selectedNode?.name}
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>
              </div>
            </div>

            <div className="api-url-bar">
              <select
                className="api-method-select"
                value={req.method}
                onChange={e => updateRequest({ method: e.target.value })}
              >
                {METHODS.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
              <input
                className="api-url-input"
                type="text"
                value={req.url}
                onChange={e => updateRequest({ url: e.target.value })}
                onKeyDown={e => { if (e.key === "Enter") sendRequest(); }}
                placeholder="https://api.example.com/users/:id"
              />
              <button className="api-send-btn" onClick={sendRequest} disabled={sending || !req.url.trim()}>
                {sending ? "Sending..." : "Send"}
              </button>
            </div>

            {activeEnv && (
              <div className="api-env-banner">
                Environment: <strong>{activeEnv.name}</strong> — using <code>{activeEnv.vars.filter(([k]) => k).length}</code> variables
              </div>
            )}

            <div className="api-tabs">
              <button className={`api-tab${activeTab === "headers" ? " active" : ""}`} onClick={() => setActiveTab("headers")}>
                Headers{headerCount > 0 && <span className="api-tab-badge">{headerCount}</span>}
              </button>
              <button className={`api-tab${activeTab === "query" ? " active" : ""}`} onClick={() => setActiveTab("query")}>
                Query{queryCount > 0 && <span className="api-tab-badge">{queryCount}</span>}
              </button>
              <button className={`api-tab${activeTab === "path" ? " active" : ""}`} onClick={() => setActiveTab("path")}>
                Path Variables{pathCount > 0 && <span className="api-tab-badge">{pathCount}</span>}
              </button>
              <button className={`api-tab${activeTab === "body" ? " active" : ""}`} onClick={() => setActiveTab("body")}>
                Body{hasBody && <span className="api-tab-badge-dot" />}
              </button>
            </div>

            <div className="api-tab-content">
              {activeTab === "headers" && (
                <KvEditor
                  pairs={req.headers?.length ? req.headers : [["", ""]]}
                  onChange={headers => updateRequest({ headers })}
                  keyPlaceholder="header name"
                  valuePlaceholder="value"
                />
              )}
              {activeTab === "query" && (
                <KvEditor
                  pairs={req.query?.length ? req.query : [["", ""]]}
                  onChange={query => updateRequest({ query })}
                  keyPlaceholder="param name"
                  valuePlaceholder="value"
                />
              )}
              {activeTab === "path" && (
                <>
                  {urlPathVars.length === 0 ? (
                    <div className="api-hint">
                      No path variables detected. Use <code>:variable</code> syntax in the URL
                      (e.g. <code>/api/users/:id</code>) to define path variables.
                    </div>
                  ) : null}
                  <KvEditor
                    pairs={req.path_vars?.length ? req.path_vars : [["", ""]]}
                    onChange={path_vars => updateRequest({ path_vars })}
                    keyPlaceholder="variable"
                    valuePlaceholder="value"
                  />
                </>
              )}
              {activeTab === "body" && (
                <BodyEditor req={req} onChange={updateRequest} />
              )}
            </div>
          </div>
        ) : (
          <div className="api-placeholder">
            <svg className="api-placeholder-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="12" cy="12" r="10" />
              <path d="M12 6v6l4 2" />
            </svg>
            <h3>No Request Selected</h3>
            <p>Select a request from the collection or create a new one to get started.</p>
            <div className="api-placeholder-actions">
              <button className="api-btn" onClick={() => addRequest(null)}>New Request</button>
              <button className="api-btn api-btn-secondary" onClick={() => addFolder(null)}>New Folder</button>
            </div>
          </div>
        )}
      </div>

      {/* ── Response (right) ── */}
      <div className="api-response">
        <ResponseViewer response={response} loading={sending} error={sendError} />
      </div>

      {/* ── Modals ── */}
      {inputModal && (
        <InputModal
          title={inputModal.title}
          label={inputModal.label}
          initialValue={inputModal.initial}
          confirmText={inputModal.confirmText}
          onConfirm={inputModal.onConfirm}
          onCancel={() => setInputModal(null)}
        />
      )}
      {confirmModal && (
        <ConfirmModal
          title={confirmModal.title}
          message={confirmModal.message}
          confirmText={confirmModal.confirmText}
          danger={confirmModal.danger}
          onConfirm={confirmModal.onConfirm}
          onCancel={() => setConfirmModal(null)}
        />
      )}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenu.items}
          onClose={() => setContextMenu(null)}
        />
      )}
      {moveToModal && (
        <MoveToModal
          node={moveToModal.node}
          nodes={state.nodes}
          onConfirm={targetParentId => moveNode(moveToModal.node, targetParentId)}
          onCancel={() => setMoveToModal(null)}
        />
      )}
    </div>
  );
}