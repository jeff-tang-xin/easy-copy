import { useEffect, useMemo, useRef, useState, useCallback, memo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { JsonView } from "./JsonView";
import { bodyFormatFor, checkBody, RAW_LANGS, type BodyCheck } from "./lib/bodyFormats";
import { useTheme } from "./hooks/useTheme";
import { useVerticalSplit } from "./hooks/useVerticalSplit";
import { useToast } from "./hooks/useToast";
import { friendlyError } from "./hooks/friendlyError";
import { useDebouncedCallback } from "./hooks/useDebouncedCallback";
import { IconChevron, IconFolder, IconHome, IconLock } from "./components/Icons";
import "./App.css";
import "./ApiApp.css";

/* =============================================================
 * API Platform - Postman-like HTTP client built on Tauri.
 *
 * Data model mirrors the Rust structs in src-tauri/src/models.rs:
 *   ApiState { nodes: ApiNode[], envs: ApiEnvironment[] }
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
  /// Total request timeout. Optional so old saved collections still load;
  /// the backend falls back to its own default.
  timeout_secs?: number | null;
  /// Skip TLS certificate verification. Was hardcoded to *always on* in the
  /// backend, silently exposing every Authorization header to MITM. Now an
  /// explicit per-request opt-in, defaulting to off.
  insecure_tls?: boolean;
  follow_redirects?: boolean;
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
  /// Non-fatal problems (unreadable upload, dropped illegal header, bad
  /// proxy config, truncated body). These used to be swallowed silently,
  /// which made "the server returned 400 and I have no idea why" a
  /// regular occurrence.
  warnings?: string[] | null;
  /// True when the body is base64 rather than text.
  is_binary?: boolean;
  /// Full body size on the wire, even if `body` was truncated.
  body_size?: number;
  truncated?: boolean;
  /// Set only when redirects moved us somewhere else.
  final_url?: string | null;
}

/// How many past responses we keep per request. Front-end owns history now.
const HISTORY_LIMIT = 50;

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
  base_url: string;
  headers: [string, string][];
  vars: [string, string][];
}

interface ApiState {
  nodes: ApiNode[];
  envs: ApiEnvironment[];
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
    form_data: [{ key: "", value: "", type: "text" as const }],
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

/** Extract path vars from URL like /api/:id/users/:userId -> ["id", "userId"]
 *  Also supports CJK: /api/:用户ID/users -> ["用户ID"].
 *
 *  Implementation note: the first character after `:` must be a letter or
 *  underscore (a path-var "name" starts with an identifier character in
 *  every common path-template dialect). This deliberately excludes
 *  `:8080` (the port in `https://host:8080/path`) so a port number is
 *  never confused with a variable.
 *
 *  After the first character, the rest of the name accepts any character
 *  that isn't a URL path-structural delimiter or whitespace. We exclude
 *  `:`, `/`, `?`, `#`, and whitespace from the *post-first-char* set so
 *  that:
 *    - `https://api/v1/:user:8080/info` correctly extracts `user` (and
 *      does not fuse it with the port), matching the Rust side's
 *      `is_boundary` check in `src-tauri/src/api.rs`;
 *    - `/api/:id/users` extracts `id` (and not `id/users`); and
 *    - CJK / accented / other Unicode letters are accepted as part of
 *      the name.
 *
 *  Note: `\p{L}` in JS regex requires the `u` flag, which we set below.
 *  Without the flag, Unicode property escapes throw at compile time.
 */
function extractPathVars(url: string): string[] {
  // First char: ASCII letter or underscore (excludes `:8080`).
  // Following chars: any letter (Unicode), digit, underscore, or `.`/`-`/`~`
  // (RFC 3986 unreserved, which we extend with Unicode letters so CJK
  // works). Anything in the delimiter set `[^\p{L}\p{N}_.\-~]` ends the name.
  const matches = url.match(/:[A-Za-z_][\p{L}\p{N}_.\-~]*/gu) || [];
  return matches.map(m => m.slice(1));
}

const METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"];

/* RAW_LANGS now lives with the format registry so the language list and the
 * capabilities backing it can't drift apart. */

const BODY_TYPES = ["none", "form-data", "urlencoded", "binary", "msgpack", "raw"] as const;

const STATUS_CLASS = (s: number) =>
  s >= 200 && s < 300 ? "api-status-2xx" :
  s >= 300 && s < 400 ? "api-status-3xx" :
  s >= 400 && s < 500 ? "api-status-4xx" : "api-status-5xx";

/// Human-readable byte count for the response size badge.
const formatBytes = (n: number): string => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
};

/// Variable names that usually identify *which machine* an environment points
/// at, in descending order of confidence. Matched case-insensitively.
const ENV_HINT_KEYS = ["host", "baseurl", "base_url", "url", "endpoint", "server"];
const ENV_HINT_MAX_LEN = 28;

/// `http://10.61.107.5:2001/api` -> `10.61.107.5:2001`. The scheme and path are
/// constant noise; the authority is what actually differs between environments.
/// Non-URL values pass through untouched.
function envHintAuthority(value: string): string {
  const schemeEnd = value.indexOf("://");
  return schemeEnd >= 0 ? value.slice(schemeEnd + 3).split(/[/?#]/)[0] : value;
}

/// Label for an environment in the URL-bar dropdown, e.g. `dev - 10.61.107.5:2001`.
///
/// A bare name like `dev` doesn't answer the question users actually ask when
/// switching environments ("where does this point?"), so we append the most
/// representative variable we can find:
///   0. the env's dedicated `base_url` -- authoritative when set;
///   1. the first variable whose key matches ENV_HINT_KEYS -> show the value alone,
///      reduced to its authority;
///   2. otherwise the first variable with both key and value non-empty -> show
///      `key=authority`, since an arbitrary variable name is itself information.
///      The authority reduction matters *more* here, not less: a project that
///      names its base URL `omsx` instead of `host` used to render the raw
///      `omsx=http://1…`, which is pure noise — the truncation ate the address
///      and left only the scheme.
///   3. otherwise nothing -- just the name, never a dangling " - ".
/// Long values are truncated so the dropdown can't push the URL input off-screen.
/// Display only: `env.name` stays untouched for the sidebar, renames and storage.
function envSelectLabel(env: ApiEnvironment): string {
  const filled = env.vars.filter(([k, v]) => k.trim() && v.trim());
  let hint = "";
  // The dedicated base URL is by definition *the* address of this env, so it
  // outranks any guess made from variable names.
  if (env.base_url?.trim()) {
    hint = envHintAuthority(env.base_url.trim());
  }
  for (const key of hint ? [] : ENV_HINT_KEYS) {
    const match = filled.find(([k]) => k.trim().toLowerCase() === key);
    if (match) {
      hint = envHintAuthority(match[1].trim());
      break;
    }
  }
  if (!hint && filled.length > 0) {
    hint = `${filled[0][0].trim()}=${envHintAuthority(filled[0][1].trim())}`;
  }
  if (!hint) return env.name;
  if (hint.length > ENV_HINT_MAX_LEN) hint = `${hint.slice(0, ENV_HINT_MAX_LEN)}…`;
  return `${env.name} - ${hint}`;
}

/* =============================================================
 * Theme hook is provided by ./hooks/useTheme (shared across all
 * windows). Reading it here directly is what caused 4 copies of
 * the same logic to drift apart — keep the import-only form.
 * ============================================================= */
// ── Env Var Editor (single row) ────────────────────────────────
//
// Same draft-buffering rationale as KvEditor / UrlInput. The env
// sidebar's parent `updateEnv` calls `setState(prev => ...)` on
// every keystroke (which is necessary so the rest of the page
// stays in sync with the active env's var list), and without a
// local buffer the row's <input> would re-set its value and the
// caret would jump on the second character.

function EnvVarRow({
  k, v,
  onChange,
  onRemove,
  keyPlaceholder = "变量名",
  valPlaceholder = "值",
}: {
  k: string;
  v: string;
  onChange: (next: [string, string]) => void;
  onRemove: () => void;
  keyPlaceholder?: string;
  valPlaceholder?: string;
}) {
  const [draftK, setDraftK] = useState(k);
  const [draftV, setDraftV] = useState(v);

  // Re-sync from prop only on external change (rare: env was
  // reloaded from disk, or the user removed a sibling row).
  useEffect(() => { setDraftK(prev => prev === k ? prev : k); }, [k]);
  useEffect(() => { setDraftV(prev => prev === v ? prev : v); }, [v]);

  return (
    <div className="api-env-var-row">
      <input
        className="api-kv-input"
        type="text"
        value={draftK}
        onChange={e => {
          const next = e.target.value;
          setDraftK(next);
          onChange([next, draftV]);
        }}
        placeholder={keyPlaceholder}
      />
      <input
        className="api-kv-input"
        type="text"
        value={draftV}
        onChange={e => {
          const next = e.target.value;
          setDraftV(next);
          onChange([draftK, next]);
        }}
        placeholder={valPlaceholder}
      />
      <button className="api-mini-btn" onClick={onRemove} title="删除">×</button>
    </div>
  );
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
          placeholder="请输入名称…"
        />
        <div className="api-modal-actions">
          <button className="api-btn api-btn-secondary" onClick={onCancel}>取消</button>
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

function ConfirmModal({ title, message, confirmText = "确认", danger = false, onConfirm, onCancel }: ConfirmModalProps) {
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
          <button className="api-btn api-btn-secondary" onClick={onCancel}>取消</button>
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
          <span className="api-moveto-icon"><IconFolder /></span>
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
        <div className="api-modal-title">移动 "{node.name}" 到…</div>
        <div className="api-moveto-tree">
          <button
            type="button"
            className={"api-moveto-item api-moveto-root" + (selected === null ? " api-moveto-selected" : "")}
            onClick={() => setSelected(null)}
          >
            <span className="api-moveto-icon"><IconHome /></span>
            <span className="api-moveto-name">根目录（顶层）</span>
          </button>
          {rootFolders.map(f => renderFolder(f, 1))}
        </div>
        {!hasAnyTarget && (
          <div className="api-hint">暂无可用的目标文件夹。</div>
        )}
        <div className="api-modal-actions">
          <button className="api-btn api-btn-secondary" onClick={onCancel}>取消</button>
          <button
            className="api-btn api-btn-primary"
            disabled={!hasAnyTarget}
            onClick={() => onConfirm(selected)}
          >
            移动到此处
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Modal: Environment Manager ─────────────────────────────────
//
// Environments used to live pinned to the bottom of the sidebar, which
// had two problems: it stole vertical space from the request tree, and
// the value inputs were far too narrow to read a URL (`http://10…`).
//
// It also conflated two different things: an env was only *expandable*
// while it was *active*, so inspecting a variable forced you to switch
// environments. This modal now only *manages* envs (create/edit/delete);
// which env applies is a per-request choice made in the URL bar, so
// there is no "active" state to show here at all.

interface EnvManagerModalProps {
  envs: ApiEnvironment[];
  onAdd: () => void;
  onUpdate: (env: ApiEnvironment) => void;
  onDelete: (env: ApiEnvironment) => void;
  onClose: () => void;
}

function EnvManagerModal({
  envs, onAdd, onUpdate, onDelete, onClose,
}: EnvManagerModalProps) {
  // Nothing is "active" any more — just inspect the first env by default.
  const [viewingId, setViewingId] = useState<string | null>(
    envs.length > 0 ? envs[0].id : null
  );

  // Follow newly created envs. `addEnv` appends, so a growing list means
  // the last entry is the one the user just made — jump to it, otherwise
  // the right pane would keep showing the previously viewed env.
  const prevCountRef = useRef(envs.length);
  useEffect(() => {
    if (envs.length > prevCountRef.current) setViewingId(envs[envs.length - 1].id);
    prevCountRef.current = envs.length;
  }, [envs]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  // The viewed env may vanish (deleted); fall back rather than blank out.
  const viewing = envs.find(e => e.id === viewingId) ?? envs[0] ?? null;

  return (
    <div className="api-modal-overlay" onMouseDown={onClose}>
      <div className="api-modal api-env-modal" onMouseDown={e => e.stopPropagation()}>
        <div className="api-modal-title">环境变量</div>

        {envs.length === 0 ? (
          <div className="api-env-modal-empty">
            <div className="api-hint">
              还没有环境。环境用来存放 <code>{"{{host}}"}</code> 这类变量，
              可在 URL 和请求头中通过 <code>{"{{变量名}}"}</code> 引用。
            </div>
            <button className="api-btn api-btn-primary" onClick={onAdd}>新建第一个环境</button>
          </div>
        ) : (
          <div className="api-env-modal-body">
            {/* Left: env list */}
            <div className="api-env-modal-list">
              {envs.map(env => {
                const isViewing = viewing?.id === env.id;
                return (
                  <div
                    key={env.id}
                    className={"api-env-modal-item" + (isViewing ? " viewing" : "")}
                    role="button"
                    tabIndex={0}
                    aria-current={isViewing}
                    onClick={() => setViewingId(env.id)}
                    onKeyDown={e => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setViewingId(env.id);
                      }
                    }}
                  >
                    <span className="api-env-modal-name" title={env.name}>{env.name}</span>
                    <button
                      className="api-mini-btn"
                      title="删除环境"
                      onClick={e => { e.stopPropagation(); onDelete(env); }}
                    >×</button>
                  </div>
                );
              })}
              <button className="api-env-add-btn" onClick={onAdd}>+ 新建环境</button>
            </div>

            {/* Right: variables of the viewed env */}
            <div className="api-env-modal-vars">
              {viewing && (
                <>
                  <div className="api-env-modal-varhead">
                    <span>{viewing.name}</span>
                  </div>

                  {/* Base URL: a dedicated slot, not a magically-named var.
                      Relative request URLs get this prepended; absolute ones
                      (http/https) are left alone. */}
                  <div className="api-env-section">
                    <div className="api-env-section-title">基础地址</div>
                    <input
                      className="api-input api-env-baseurl"
                      value={viewing.base_url ?? ""}
                      placeholder="http://10.61.107.5:2001"
                      onChange={e => onUpdate({ ...viewing, base_url: e.target.value })}
                    />
                    <div className="api-hint">
                      填写后，URL 只需写 <code>/front-api/orders</code>；
                      以 http(s) 开头的完整地址不受影响。
                    </div>
                  </div>

                  {/* Shared headers: merged into every request in this env. */}
                  <div className="api-env-section">
                    <div className="api-env-section-title">公共请求头</div>
                    <div className="api-env-modal-varlist">
                      {(viewing.headers ?? []).map(([k, v], i) => (
                        <EnvVarRow
                          key={i}
                          k={k}
                          v={v}
                          keyPlaceholder="Authorization"
                          valPlaceholder="Bearer {{token}}"
                          onChange={next => {
                            const arr = (viewing.headers ?? []).map((p, idx) => idx === i ? next : p);
                            onUpdate({ ...viewing, headers: arr });
                          }}
                          onRemove={() => {
                            const next = (viewing.headers ?? []).filter((_, idx) => idx !== i);
                            onUpdate({ ...viewing, headers: next.length > 0 ? next : [["", ""]] });
                          }}
                        />
                      ))}
                      <button
                        className="api-env-add-btn"
                        onClick={() => onUpdate({
                          ...viewing, headers: [...(viewing.headers ?? []), ["", ""]],
                        })}
                      >+ 添加请求头</button>
                    </div>
                    <div className="api-hint">
                      自动加到该环境下的每个请求。请求自己设置同名请求头会覆盖它；
                      把值留空则该请求不发送这条。
                    </div>
                  </div>

                  <div className="api-env-section">
                    <div className="api-env-section-title">变量</div>
                    <div className="api-env-modal-varlist">
                      {viewing.vars.map(([k, v], i) => (
                        <EnvVarRow
                          key={i}
                          k={k}
                          v={v}
                          onChange={next => {
                            const arr = viewing.vars.map((p, idx) => idx === i ? next : p);
                            onUpdate({ ...viewing, vars: arr });
                          }}
                          onRemove={() => {
                            const next = viewing.vars.filter((_, idx) => idx !== i);
                            onUpdate({ ...viewing, vars: next.length > 0 ? next : [["", ""]] });
                          }}
                        />
                      ))}
                      <button
                        className="api-env-add-btn"
                        onClick={() => onUpdate({ ...viewing, vars: [...viewing.vars, ["", ""]] })}
                      >+ 添加变量</button>
                    </div>
                    <div className="api-hint">
                      在 URL、请求头、请求体中用 <code>{"{{变量名}}"}</code> 引用。
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        <div className="api-modal-actions">
          <button className="api-btn api-btn-primary" onClick={onClose}>完成</button>
        </div>
      </div>
    </div>
  );
}

// ── KV Editor (headers, query, path vars, url_encoded) ─────────
//
// Implementation note: this is a **draft-buffered** editor. The prop
// `pairs` is treated as the source of truth on remount; once mounted,
// the editor keeps its own internal `draft` state so each keystroke
// doesn't recreate a new `value` reference on the underlying <input>.
// Without the buffer, every parent `setState` (e.g. on path-vars sync
// or debounced save round-trip) would push a new `pairs` array into
// the editor, React would re-set the <input> value, and the caret
// would jump to the end on every keystroke — the classic
// "controlled-input stutter" that made the URL / header / query
// fields feel broken.
//
// The buffer is re-synced from `pairs` only when `pairs` *itself*
// changes (i.e. something external edited the request: switching
// selection, loading from disk, programmatic path-vars sync, etc.).
// A user typing into a field produces a new `pairs` only after
// `onChange` is called, and we *only* call onChange when the
// user mutates the draft — so the sync effect is a no-op for the
// "user is typing" case (the new `pairs` deep-equals the draft).

interface KvEditorProps {
  pairs: [string, string][];
  onChange: (pairs: [string, string][]) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
}

function KvEditor({ pairs, onChange, keyPlaceholder = "键名", valuePlaceholder = "值" }: KvEditorProps) {
  // Local draft. Initialised from `pairs` on first render; re-synced
  // when `pairs` itself changes from outside (see useEffect below).
  const [draft, setDraft] = useState<[string, string][]>(pairs);

  // Re-sync when external `pairs` changes (e.g. another component
  // edited the request, or the selection switched to a different
  // request that happens to have the same id-shape). We compare the
  // serialised form so a fresh-but-equivalent array doesn't clobber
  // the user's in-flight typing.
  useEffect(() => {
    setDraft(prev => {
      const a = prev.map(([k, v]) => `${k}\u0000${v}`).join("\n");
      const b = pairs.map(([k, v]) => `${k}\u0000${v}`).join("\n");
      return a === b ? prev : pairs;
    });
  }, [pairs]);

  // NOTE: `onChange` must never be called from inside a `setDraft` updater.
  // State updaters have to be pure — React may invoke them twice (StrictMode)
  // and does so during the render phase, which turns the parent's setState
  // into "update ApiApp while rendering KvEditor". Compute the next value
  // from `draft` first, then commit and notify as two plain statements.
  const commit = (next: [string, string][]) => {
    setDraft(next);
    onChange(next);
  };

  const update = (i: number, field: 0 | 1, val: string) => {
    commit(draft.map(([k, v], idx) =>
      idx === i ? (field === 0 ? [val, v] : [k, val]) as [string, string] : [k, v] as [string, string]
    ));
  };

  const addRow = () => {
    commit([...draft, ["", ""] as [string, string]]);
  };

  const removeRow = (i: number) => {
    commit(draft.length <= 1 ? [["", ""]] : draft.filter((_, idx) => idx !== i));
  };

  return (
    <div className="api-kv-table">
      {draft.map(([k, v], i) => (
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
          <button className="api-kv-delete" onClick={() => removeRow(i)} title="删除">×</button>
        </div>
      ))}
      <button className="api-kv-add" onClick={addRow}>+ 添加行</button>
    </div>
  );
}

// ── Path-Var Editor (URL-driven) ────────────────────────────────
//
// Renders one row per `:name` token in the URL, with the value
// sourced from `req.path_vars` (so user-typed values persist and
// survive an app restart). Unlike the generic KvEditor, the key
// column is **read-only** here: the URL is the only thing that
// declares a path-var name. If the user wants to rename `:id` to
// `:userId`, they edit the URL — not this table. This avoids the
// previous "I renamed the key here but the URL still has :id, so
// the request goes nowhere" footgun.
//
// The component is intentionally small (no separate subcomponent
// for the row) because the row markup is trivial and the
// draft-buffer machinery from KvEditor is overkill for read-only
// keys. Values *do* go through a per-row local draft so typing a
// long value doesn't bounce the caret when the parent re-renders
// after a path-vars debounced save (same rationale as
// `UrlInput`).

interface PathVarEditorProps {
  urlKeys: string[];
  stored: [string, string][];
  onChange: (path_vars: [string, string][]) => void;
}

function PathVarEditor({ urlKeys, stored, onChange }: PathVarEditorProps) {
  // For each key, look up the value the user previously typed. Missing
  // keys get an empty value. Memoised so the `useEffect` below can
  // depend on `rows` without firing on every parent re-render (the
  // map() would otherwise allocate a new array literal each render,
  // and that breaks the effect's `Object.is` dep comparison).
  const rows = useMemo(
    () => urlKeys.map(k => {
      const found = stored.find(([kk]) => kk === k);
      return { key: k, value: found ? found[1] : "" };
    }),
    [urlKeys, stored],
  );

  // Per-row local draft so typing a long value doesn't bounce the
  // caret when the parent re-renders after a debounced save (same
  // rationale as `UrlInput` / `EnvVarRow`). Re-sync only when the
  // `stored` prop changes from outside (selection switch, disk load,
  // another component mutated `req.path_vars`).
  //
  // We key the draft by URL key, NOT by array index: if the URL
  // changes mid-typing (e.g. user typed `:id` then renamed it to
  // `:userId` without leaving the path-vars tab), the draft for the
  // *old* key is just dropped and the *new* key starts fresh from
  // `stored` — which is what we want, because the new key never had
  // a stored value anyway. (The user can switch back to the URL
  // input and edit there; the path-vars tab doesn't accept key edits.)
  const [drafts, setDrafts] = useState<Record<string, string>>(() =>
    Object.fromEntries(rows.map(r => [r.key, r.value]))
  );
  useEffect(() => {
    setDrafts(prev => {
      const next: Record<string, string> = {};
      let changed = false;
      for (const r of rows) {
        // Only pull from `stored` for keys we don't have a local
        // draft for. If `prev` already has a draft for this key,
        // keep it (this is the "user is typing" case — the parent's
        // setState has propagated the new stored value through, but
        // the local draft is one keystroke ahead and we don't want
        // to clobber it).
        if (r.key in prev) {
          next[r.key] = prev[r.key];
        } else {
          next[r.key] = r.value;
          changed = true;
        }
      }
      // Also drop drafts for keys the URL no longer declares (the
      // user removed `:id` from the URL) — otherwise the map grows
      // forever and we'd ship stale drafts on the next URL edit.
      for (const k of Object.keys(prev)) {
        if (!(k in next)) {
          changed = true;
          break;
        }
      }
      return changed ? next : prev;
    });
  }, [rows]);

  // When the user types a value, we write back the full ordered list
  // of `(key, value)` pairs derived from the URL — that's the only
  // way to keep `req.path_vars` in sync with what the user sees,
  // without resurrecting a "renamed the key in the table" mode that
  // we explicitly do not support (the URL is authoritative).
  const updateValue = (key: string, value: string) => {
    setDrafts(prev => ({ ...prev, [key]: value }));
    const next: [string, string][] = urlKeys.map(k => {
      if (k === key) return [k, value];
      // Read other rows' values from the *latest* drafts (so a
      // rapid-fire edit on two rows in the same tick doesn't lose
      // the first one to a stale `stored` read).
      const d = drafts[k];
      if (d !== undefined) return [k, d];
      const existing = stored.find(([kk]) => kk === k);
      return existing ? existing : [k, ""];
    });
    onChange(next);
  };

  return (
    <div className="api-kv-table">
      {rows.map(({ key }) => {
        const draft = drafts[key] ?? "";
        return (
          <div key={key} className="api-kv-row">
            <input
              className="api-kv-input"
              type="text"
              value={key}
              readOnly
              title="路径变量名由 URL 中的 :name 决定，编辑 URL 即可重命名"
            />
            <input
              className="api-kv-input"
              type="text"
              value={draft}
              onChange={e => updateValue(key, e.target.value)}
              placeholder="值"
            />
            <span
              className="api-kv-delete api-kv-delete-info"
              title="该变量名由 URL 定义，无法在此删除"
            ><IconLock /></span>
          </div>
        );
      })}
      <div className="api-hint" style={{ marginTop: 8 }}>
        路径变量名由 URL 中的 <code>:name</code> 决定。在 URL 模板里增删 <code>:name</code> 即可在此表增删行。
      </div>
    </div>
  );
}

// ── Form-Data Editor ───────────────────────────────────────────
//
// Draft-buffered for the same reason as KvEditor: keeping local state
// means a parent re-render with a fresh `fields` reference doesn't
// re-set the <input> value and bounce the caret. See the longer note
// on KvEditor for the full rationale.

interface FormDataEditorProps {
  fields: FormField[];
  onChange: (fields: FormField[]) => void;
}

function FormDataEditor({ fields, onChange }: FormDataEditorProps) {
  // NOTE: explicit type on setDraft callback arg to prevent TS widening
  // of FormField.type from literal union to plain string. See TS2345 error
  // on the setDraft call inside update() — adding the type param here
  // gives contextual typing that prevents the spread+ternary widening bug.
  const [draft, setDraft] = useState<FormField[]>(fields);

  // Re-sync when external `fields` changes (e.g. body-type toggle, or
  // selection switch). Compare by serialised form so equivalent arrays
  // don't clobber in-flight typing.
  useEffect(() => {
    setDraft(prev => {
      const a = prev.map(f => `${f.type}\u0000${f.key}\u0000${f.value}\u0000${f.file_path || ""}\u0000${f.file_name || ""}`).join("\n");
      const b = fields.map(f => `${f.type}\u0000${f.key}\u0000${f.value}\u0000${f.file_path || ""}\u0000${f.file_name || ""}`).join("\n");
      return a === b ? prev : fields;
    });
  }, [fields]);

  // See the note on KvEditor.commit: `onChange` must stay out of the
  // `setDraft` updater, which React treats as pure and may run during render.
  const commit = (next: FormField[]) => {
    setDraft(next);
    onChange(next);
  };

  const update = (i: number, patch: Partial<FormField>) => {
    commit(draft.map((f, idx) => (idx === i ? ({ ...f, ...patch } as FormField) : f)));
  };

  const addRow = () => {
    const newField: FormField = { key: "", value: "", type: "text" as const };
    commit([...draft, newField]);
  };

  const removeRow = (i: number) => {
    commit(draft.length <= 1
      ? [{ key: "", value: "", type: "text" as const, file_path: null, file_name: null }]
      : draft.filter((_, idx) => idx !== i));
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
      {draft.map((f, i) => (
        <div key={i} className="api-form-row">
          <input
            className="api-kv-input"
            type="text"
            value={f.key}
            onChange={e => update(i, { key: e.target.value })}
            placeholder="键名"
          />
          <select
            className="api-form-type-select"
            value={f.type}
            onChange={e => update(i, { type: e.target.value as "text" | "file" })}
          >
            <option value="text">文本</option>
            <option value="file">文件</option>
          </select>
          {f.type === "file" ? (
            <div className="api-form-file-cell">
              <input
                className="api-kv-input api-form-file-input"
                type="text"
                value={f.file_path || ""}
                onChange={e => update(i, { file_path: e.target.value })}
                placeholder="文件路径"
                readOnly
              />
              <button className="api-form-browse-btn" onClick={() => pickFile(i)}>浏览</button>
            </div>
          ) : (
            <input
              className="api-kv-input"
              type="text"
              value={f.value}
              onChange={e => update(i, { value: e.target.value })}
              placeholder="值"
            />
          )}
          <button className="api-kv-delete" onClick={() => removeRow(i)} title="删除">×</button>
        </div>
      ))}
      <button className="api-kv-add" onClick={addRow}>+ 添加字段</button>
    </div>
  );
}
// ── Body Editor ────────────────────────────────────────────────
//
// Draft-buffered. The raw-body <textarea> in particular benefits
// enormously: the previous implementation let the parent's
// `setState(prev => nodes.map(...))` propagate a new `req` reference
// on every keystroke, which React dutifully re-applied as the
// textarea's `value`, and the caret would jump to the end as soon
// as you typed more than 2-3 chars. The raw lang bar, body-type
// switcher, and binary/msgpack file pickers all hold their own
// state too, but those don't have caret issues — keeping them in
// the draft just makes the whole editor feel consistent.

interface BodyEditorProps {
  req: ApiRequest;
  onChange: (req: ApiRequest) => void;
}

// ── Raw JSON body toolbar ──────────────────────────────────────
//
// Extracted rather than inlined into `BodyEditor`: that component was already
// ~130 lines handling six body types, and folding format/minify/validate/tree
// state into it would have pushed it well past the point of being readable
// (classic 过长方法 + 发散式变化 — it would then change for both "body type
// switching" and "JSON tooling" reasons).
//
// Owns no body text of its own; it reports edits upward through `onFormat` so
// `BodyEditor`'s draft stays the single source of truth for the textarea.

interface BodyFormatBarProps {
  body: string;
  lang: string;
  onFormat: (next: string) => void;
}

/** Indent widths offered by the 美化 control. */
const JSON_INDENTS = [2, 4] as const;

/** Toolbar above the raw-body editor: reformat actions and a live
 *  syntax-status pill.
 *
 *  Language-agnostic by construction — every capability is looked up through
 *  the format registry, so this component contains no `if (lang === ...)`
 *  branches and gains new languages for free. */
function BodyFormatBar({ body, lang, onFormat }: BodyFormatBarProps) {
  const fmt = bodyFormatFor(lang);

  // Live validation drives both the status pill and whether the action
  // buttons are enabled. Memoized on the text so typing in a large payload
  // doesn't re-validate once per button per keystroke.
  const check = useMemo(() => checkBody(fmt, body), [fmt, body]);

  const apply = (transform: (src: string) => { ok: boolean; text: string }) => {
    const res = transform(body);
    // Guarded by `disabled`, but re-check: the button could be clicked in the
    // same tick as an edit that invalidated the text.
    if (res.ok) onFormat(res.text);
  };

  // Reformatting anything unparseable would either throw or silently corrupt
  // the payload, so gate on a clean parse.
  const canFormat = check.state === "valid";

  return (
    <div className="api-json-bar">
      {fmt.format && (
        <div className="api-json-group">
          {JSON_INDENTS.map(n => (
            <button
              key={n}
              className="api-json-btn"
              onClick={() => apply(src => fmt.format!(src, n))}
              disabled={!canFormat}
              title={`以 ${n} 空格缩进重新格式化`}
            >
              美化 {n}
            </button>
          ))}
          {fmt.minify && (
            <button
              className="api-json-btn"
              onClick={() => apply(fmt.minify!)}
              disabled={!canFormat}
              title="压缩为单行"
            >
              压缩
            </button>
          )}
        </div>
      )}

      <span className={`api-json-status ${statusClass(check.state)}`} title={statusTitle(check)}>
        {statusText(check)}
      </span>
    </div>
  );
}

/** Maps a check state to its pill modifier. Extracted so the class list stays
 *  a lookup instead of a nested ternary in JSX. */
function statusClass(state: BodyCheck["state"]): string {
  switch (state) {
    case "valid":
      return "is-valid";
    case "invalid":
      return "is-invalid";
    default:
      return "is-idle";
  }
}

function statusText(check: BodyCheck): string {
  switch (check.state) {
    case "empty":
      return "尚无内容";
    case "unsupported":
      return "无语法检查";
    case "valid":
      return "✓ 语法正确";
    case "invalid":
      // A line number we can't vouch for is worse than none — see the locator
      // notes in JsonView. `line === 0` means "unknown", so show the message
      // alone rather than pointing at the wrong line.
      return check.line > 0
        ? `✗ 第 ${check.line} 行 第 ${check.column} 列：${check.message}`
        : `✗ ${check.message}`;
  }
}

/** Full text for the `title` tooltip, since the pill itself is ellipsized. */
function statusTitle(check: BodyCheck): string | undefined {
  return check.state === "invalid" ? check.message : undefined;
}

function BodyEditor({ req, onChange }: BodyEditorProps) {
  // Mirror `req` into local draft state. The buffer is the source
  // of truth while the editor is mounted; the prop is the
  // re-sync source (selection switch, body-type change coming from
  // outside, etc.).
  const [draft, setDraft] = useState<ApiRequest>(req);

  useEffect(() => {
    setDraft(prev => {
      // Cheap identity check: if the prop hasn't changed in any
      // user-visible way, keep the draft untouched so the caret
      // doesn't bounce.
      //
      // The two collection fields must be compared **by value**. They were
      // compared by reference, but the parent rebuilds these arrays on every
      // state update, so the references always differed — the draft was reset
      // on each keystroke and the caret jumped to the end of the field.
      // `KvEditor` and `EnvVarRow` already do the serialized comparison; this
      // one was the last holdout.
      if (
        prev.body_type === req.body_type &&
        prev.body_raw_lang === req.body_raw_lang &&
        prev.body === req.body &&
        prev.binary_file === req.binary_file &&
        prev.msgpack_file === req.msgpack_file &&
        JSON.stringify(prev.url_encoded ?? []) === JSON.stringify(req.url_encoded ?? []) &&
        JSON.stringify(prev.form_data ?? []) === JSON.stringify(req.form_data ?? [])
      ) {
        return prev;
      }
      return req;
    });
  }, [req]);

  // Same rule as the other draft-buffered editors: keep `onChange` out of the
  // `setDraft` updater so the updater stays pure (React may run it mid-render,
  // which surfaces as "cannot update ApiApp while rendering <this>").
  const commit = (patch: Partial<ApiRequest>) => {
    const next: ApiRequest = { ...draft, ...patch };
    setDraft(next);
    onChange(next);
  };

  const setBodyType = (bt: string) => commit({ body_type: bt });
  const setRawLang = (lang: string) => commit({ body_raw_lang: lang, body_type: "raw" });
  const setBody = (body: string) => commit({ body });

  const rawLang = draft.body_raw_lang || "json";
  const fmt = bodyFormatFor(rawLang);

  // The tree is a permanent companion to the textarea, not an alternate view,
  // so there's no view state to hold. It stays derived (a memo, not state) —
  // caching a parsed copy would add a second source of truth to invalidate on
  // every keystroke (以查询取代临时变量).
  //
  // Resolves to null when the language has no tree form or the text doesn't
  // parse; the pane then shows a placeholder instead of unmounting, so the
  // editor's width stays put while you type through transiently-broken states.
  const bodyTree = useMemo(() => {
    if (!fmt.toTree) return null;
    const t = (draft.body || "").trim();
    if (!t) return null;
    return fmt.toTree(t);
  }, [fmt, draft.body]);

  const pickBinaryFile = async () => {
    try {
      const path = await invoke<string | null>("select_file");
      if (path) commit({ binary_file: path });
    } catch { /* cancelled */ }
  };

  const pickMsgpackFile = async () => {
    try {
      const path = await invoke<string | null>("select_file");
      if (path) commit({ msgpack_file: path });
    } catch { /* cancelled */ }
  };

  return (
    <div className="api-body-editor">
      <div className="api-body-types">
        {BODY_TYPES.map(bt => (
          <button
            key={bt}
            className={`api-body-type${draft.body_type === bt ? " active" : ""}`}
            onClick={() => setBodyType(bt)}
          >
            {bt === "urlencoded" ? "x-www-form-urlencoded" : bt === "form-data" ? "form-data" : bt}
          </button>
        ))}
      </div>

      <div className="api-body-content">
        {draft.body_type === "none" && (
          <div className="api-hint">此请求没有请求体。</div>
        )}

        {draft.body_type === "form-data" && (
          <FormDataEditor
            fields={draft.form_data?.length ? draft.form_data : [{ key: "", value: "", type: "text" as const }]}
            onChange={form_data => commit({ form_data })}
          />
        )}

        {draft.body_type === "urlencoded" && (
          <KvEditor
            pairs={draft.url_encoded?.length ? draft.url_encoded : [["", ""]]}
            onChange={url_encoded => commit({ url_encoded })}
            keyPlaceholder="键"
            valuePlaceholder="值"
          />
        )}

        {draft.body_type === "binary" && (
          <div className="api-file-picker">
            <div className="api-file-picker-row">
              <input
                className="api-kv-input"
                type="text"
                value={draft.binary_file || ""}
                onChange={e => commit({ binary_file: e.target.value })}
                placeholder="选择文件..."
                readOnly
              />
              <button className="api-browse-btn" onClick={pickBinaryFile}>浏览</button>
            </div>
            {draft.binary_file && <div className="api-hint">文件: <code>{draft.binary_file}</code></div>}
          </div>
        )}

        {draft.body_type === "msgpack" && (
          <div className="api-file-picker">
            <div className="api-file-picker-row">
              <input
                className="api-kv-input"
                type="text"
                value={draft.msgpack_file || ""}
                onChange={e => commit({ msgpack_file: e.target.value })}
                placeholder="选择文件..."
                readOnly
              />
              <button className="api-browse-btn" onClick={pickMsgpackFile}>浏览</button>
            </div>
            {draft.msgpack_file && <div className="api-hint">文件: <code>{draft.msgpack_file}</code></div>}
          </div>
        )}

        {draft.body_type === "raw" && (
          <>
            <div className="api-raw-lang-bar">
              {RAW_LANGS.map(lang => (
                <button
                  key={lang}
                  className={`api-raw-lang${rawLang === lang ? " active" : ""}`}
                  onClick={() => setRawLang(lang)}
                >
                  {lang}
                </button>
              ))}
            </div>
            {/* Shown for every language: the registry decides which controls
              * are meaningful, so plain text simply gets a status pill. */}
            <BodyFormatBar body={draft.body || ""} lang={rawLang} onFormat={setBody} />
            {/* Source and tree side by side. The tree pane only exists for
              * languages that can produce one; for the rest the textarea takes
              * the full width rather than sitting next to an empty panel. */}
            <div className={`api-body-split${fmt.toTree ? " has-tree" : ""}`}>
              <textarea
                className="api-body-textarea"
                value={draft.body || ""}
                onChange={e => setBody(e.target.value)}
                placeholder={`在此输入 ${rawLang} 内容...`}
                spellCheck={false}
              />
              {fmt.toTree && (
                <div className="api-body-tree">
                  {bodyTree !== null ? (
                    <JsonView data={bodyTree} toolbar lineNumbers />
                  ) : (
                    <div className="api-body-tree-empty">
                      {(draft.body || "").trim() ? "内容无法解析，修正后自动显示树形结构" : "输入内容后显示树形结构"}
                    </div>
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
// ── URL Input ──────────────────────────────────────────────────
//
// Standalone, draft-buffered URL bar. The previous version used
// `value={req.url}` directly, which — combined with the parent's
// `setState(prev => nodes.map(...))` on every keystroke — re-set the
// <input>'s value on every render and the caret jumped to the end
// after 2-3 chars. This wraps a local string in a useState buffer
// and only commits to the parent on each keystroke. The parent's
// re-render still propagates `req.url` back via the `value` prop,
// but the local draft is already in sync with it (the commit
// happens in the same tick as the keystroke), so React bails out
// of the value re-set.

function UrlInput({ value, onCommit, onEnter }: { value: string; onCommit: (v: string) => void; onEnter: () => void }) {
  const [draft, setDraft] = useState(value);

  // Re-sync from prop only when the prop changes from outside
  // (selection switch, disk load, etc.). The cheap identity check
  // avoids touching draft on every keystroke — the keystroke path
  // is draft → onCommit → prop update → re-render → effect with
  // identical draft, so we no-op.
  useEffect(() => {
    setDraft(prev => (prev === value ? prev : value));
  }, [value]);

  return (
    <input
      className="api-url-input"
      type="text"
      value={draft}
      onChange={e => {
        const v = e.target.value;
        setDraft(v);
        onCommit(v);
      }}
      onKeyDown={e => {
        if (e.key === "Enter") {
          e.preventDefault();
          onEnter();
        }
      }}
      placeholder="https://api.example.cn/v1/users/:id"
    />
  );
}

// ── Tree Node (Sidebar) ────────────────────────────────────────

interface TreeNodeProps {
  node: ApiNode;
  /**
   * parent id -> children, pre-grouped **once** by the parent component.
   *
   * This replaces the old `nodes: ApiNode[]` + `nodes.filter(n => n.parent_id === node.id)`
   * pattern, which re-scanned the whole collection inside every single node —
   * O(n^2) per render of the sidebar. Building the map here (per node) instead
   * of at the top would be even worse than the filter, hence it is passed down.
   */
  childrenMap: Map<string, ApiNode[]>;
  selectedId: string | null;
  collapsedIds: Set<string>;
  /**
   * Recursion depth, used only as a stack-overflow guard: an imported JSON
   * collection can contain a parent cycle (a -> b -> a). The map build tolerates
   * that, but rendering would recurse forever.
   */
  depth?: number;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
  onRename: (node: ApiNode) => void;
  onDelete: (node: ApiNode) => void;
  onDuplicate: (node: ApiNode) => void;
  onContextMenu: (e: React.MouseEvent, node: ApiNode) => void;
  /** 当前正被拖拽的节点 id（源节点淡化显示），无拖拽时为 null。 */
  draggingId: string | null;
  /** 当前悬停且可放入的目标文件夹 id（高亮显示），否则为 null。 */
  dragOverId: string | null;
  onDragStart: (e: React.DragEvent, node: ApiNode) => void;
  onDragOver: (e: React.DragEvent, node: ApiNode) => void;
  onDragLeave: (e: React.DragEvent, node: ApiNode) => void;
  onDrop: (e: React.DragEvent, node: ApiNode) => void;
  onDragEnd: () => void;
}

// memo: the sidebar tree re-renders on every keystroke in the request editor
// (the whole ApiApp re-renders). With all callbacks below wrapped in
// useCallback and `childrenMap` memoised on `state.nodes`, memo lets React skip
// the entire subtree unless something the node actually shows has changed.
const TreeNode = memo(function TreeNode({
  node, childrenMap, selectedId, collapsedIds, depth = 0,
  onSelect, onToggle, onRename, onDelete, onDuplicate, onContextMenu,
  draggingId, dragOverId, onDragStart, onDragOver, onDragLeave, onDrop, onDragEnd,
}: TreeNodeProps) {
  // Cycle guard, see `depth` above. 64 is far deeper than any hand-built
  // collection, so a legitimate tree is never truncated.
  if (depth > 64) return null;

  const children = childrenMap.get(node.id) ?? [];
  const isFolder = node.node_type === "folder";
  const isCollapsed = collapsedIds.has(node.id);
  const isSelected = selectedId === node.id;

  return (
    <div className="api-tree-folder">
      {/*
        The row handlers stay inline arrows *here* (closing over `node`) rather
        than being built per-node in the parent: a fresh function per child from
        the parent would break the `memo` above on every parent render. They are
        deliberately not useCallback-wrapped — these props land on a plain DOM
        element (nothing to memoise for) and hooks may not run after the `depth`
        early return above.
      */}
      <div
        className={`api-tree-row${isSelected ? " selected" : ""}${isCollapsed ? " collapsed" : ""}${draggingId === node.id ? " dragging" : ""}${dragOverId === node.id ? " drop-target" : ""}`}
        draggable
        onDragStart={e => onDragStart(e, node)}
        onDragOver={e => onDragOver(e, node)}
        onDragLeave={e => onDragLeave(e, node)}
        onDrop={e => onDrop(e, node)}
        onDragEnd={onDragEnd}
        onClick={() => isFolder ? onToggle(node.id) : onSelect(node.id)}
        onDoubleClick={() => onRename(node)}
        onContextMenu={e => onContextMenu(e, node)}
      >
        {isFolder && <span className="api-tree-icon"><IconChevron /></span>}
        {isFolder ? (
          <span className="api-tree-name"><IconFolder /> {node.name}</span>
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
              childrenMap={childrenMap}
              selectedId={selectedId}
              collapsedIds={collapsedIds}
              depth={depth + 1}
              onSelect={onSelect}
              onToggle={onToggle}
              onRename={onRename}
              onDelete={onDelete}
              onDuplicate={onDuplicate}
              onContextMenu={onContextMenu}
              draggingId={draggingId}
              dragOverId={dragOverId}
              onDragStart={onDragStart}
              onDragOver={onDragOver}
              onDragLeave={onDragLeave}
              onDrop={onDrop}
              onDragEnd={onDragEnd}
            />
          ))}
        </div>
      )}
    </div>
  );
});
// ── Response Viewer ────────────────────────────────────────────

interface ResponseViewerProps {
  response: ApiResponse | null;
  loading: boolean;
  error: string | null;
}

function ResponseViewer({ response, loading, error }: ResponseViewerProps) {
  const [tab, setTab] = useState<"body" | "headers" | "request">("body");
  const [view, setView] = useState<"pretty" | "raw" | "text">("pretty");
  const [copied, setCopied] = useState(false);
  // Binary download state. Kept here rather than in the parent because it is
  // purely presentational and must reset whenever a new response arrives.
  const [saving, setSaving] = useState(false);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  // A fresh response invalidates any previous download, otherwise the old
  // "已保存到 …" line would sit under an unrelated result.
  useEffect(() => {
    setSavedPath(null);
    setSaveError(null);
  }, [response]);

  const handleSaveBinary = useCallback(async (resp: ApiResponse) => {
    if (!resp.body) {
      setSaveError("响应体为空，无内容可保存。");
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      // `body` holds base64 for binary responses; the backend decodes it to
      // raw bytes so the file is written byte-for-byte.
      const path = await invoke<string | null>("api_save_binary_body", {
        bodyBase64: resp.body,
        url: resp.final_url ?? "",
        headers: resp.headers,
      });
      // `null` means the user dismissed the save dialog — not an error, and
      // nothing to report in the UI.
      if (path) setSavedPath(path);
    } catch (e) {
      setSaveError(String(e));
    } finally {
      setSaving(false);
    }
  }, []);

  const handleReveal = useCallback(async (path: string) => {
    try {
      await invoke("api_reveal_path", { path });
    } catch (e) {
      setSaveError(String(e));
    }
  }, []);

  // Parse once, memoized. This used to call `JSON.parse` twice per render
  // (once for the `isJson` probe, once inside the JSX) on a body that can be
  // half a megabyte — on every keystroke-triggered re-render of the parent.
  //
  // Declared *above* the early returns: hooks must run unconditionally, and
  // the loading/error/empty branches below return before this point.
  const parsed = useMemo(() => {
    if (!response?.body || response.is_binary) return { ok: false as const };
    const t = response.body.trim();
    // Cheap pre-check: JSON must start with a structural character. Avoids
    // paying for a throwing parse on plain HTML error pages, which is the
    // common case for a failed request.
    if (!t.startsWith("{") && !t.startsWith("[")) return { ok: false as const };
    try {
      return { ok: true as const, value: JSON.parse(t) };
    } catch {
      return { ok: false as const };
    }
  }, [response?.body, response?.is_binary]);

  if (loading) {
    return (
      <div className="api-response-inner">
        <div className="api-response-header">
          <div className="api-spinner" />
          <span className="api-duration">正在发送请求...</span>
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
          <h3>暂无响应</h3>
          <p>发送一个请求以在此查看响应结果。</p>
        </div>
      </div>
    );
  }

  const isJson = parsed.ok;

  const copyBody = async () => {
    if (!response?.body) return;
    // Copy the *beautified* form when we're showing beautified output —
    // copying minified text off a pretty view is a papercut.
    const text = view === "pretty" && parsed.ok
      ? JSON.stringify(parsed.value, null, 2)
      : response.body;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch { /* clipboard denied — nothing useful to say */ }
  };

  return (
    <div className="api-response-inner">
      <div className="api-response-header">
        <span className={`api-status ${STATUS_CLASS(response.status)}`}>
          {response.status} {response.status_text}
        </span>
        <span className="api-duration">{response.duration_ms}ms</span>
        {typeof response.body_size === "number" && response.body_size > 0 && (
          <span className="api-duration">{formatBytes(response.body_size)}</span>
        )}
        {response.error && <span className="api-error-inline">⚠ {response.error}</span>}
      </div>

      {/* Non-fatal problems the backend used to swallow entirely. */}
      {response.warnings && response.warnings.length > 0 && (
        <div className="api-warnings">
          {response.warnings.map((w, i) => (
            <div key={i} className="api-warning-row">⚠ {w}</div>
          ))}
        </div>
      )}

      {response.final_url && (
        <div className="api-warnings">
          <div className="api-warning-row">↪ 已重定向到 {response.final_url}</div>
        </div>
      )}

      <div className="api-response-tabs">
        <button className={`api-tab${tab === "body" ? " active" : ""}`} onClick={() => setTab("body")}>响应体</button>
        <button className={`api-tab${tab === "headers" ? " active" : ""}`} onClick={() => setTab("headers")}>
          响应头{response.headers.length > 0 && <span className="api-tab-badge">{response.headers.length}</span>}
        </button>
        <button className={`api-tab${tab === "request" ? " active" : ""}`} onClick={() => setTab("request")}>
          请求头{response.request_headers.length > 0 && <span className="api-tab-badge">{response.request_headers.length}</span>}
        </button>
      </div>

      <div className="api-response-content">
        {tab === "body" && (
          <>
            {response.is_binary ? (
              // Previously this was force-decoded as UTF-8 and rendered as
              // a screenful of replacement characters.
              <div className="api-hint">
                二进制响应（{formatBytes(response.body_size ?? 0)}），已不作文本展示。
                <div className="api-hint-actions">
                  <button
                    className="api-btn api-btn-secondary api-btn-sm"
                    onClick={() => handleSaveBinary(response)}
                    disabled={saving}
                  >
                    {saving ? "保存中…" : "保存文件"}
                  </button>
                  {savedPath && (
                    <button
                      className="api-btn api-btn-secondary api-btn-sm"
                      onClick={() => handleReveal(savedPath)}
                    >
                      打开所在文件夹
                    </button>
                  )}
                </div>
                {saveError && <div className="api-error-inline">⚠ {saveError}</div>}
                {savedPath && (
                  <div className="api-saved-path">已保存到：{savedPath}</div>
                )}
              </div>
            ) : response.body ? (
              <>
                <div className="api-body-toolbar">
                  <div className="api-view-toggle">
                    <button className={view === "pretty" ? "active" : ""} onClick={() => setView("pretty")} disabled={!isJson}>美化</button>
                    <button className={view === "raw" ? "active" : ""} onClick={() => setView("raw")}>原始</button>
                    {isJson && (
                      <button className={view === "text" ? "active" : ""} onClick={() => setView("text")}>缩进文本</button>
                    )}
                  </div>
                  <button className="api-copy-btn" onClick={copyBody}>{copied ? "已复制" : "复制"}</button>
                </div>
                {response.truncated && (
                  <div className="api-warning-row">
                    响应体过大，仅显示前一部分。
                  </div>
                )}
                {view === "pretty" && parsed.ok ? (
                  <div className="api-pretty"><JsonView data={parsed.value} toolbar lineNumbers /></div>
                ) : view === "text" && parsed.ok ? (
                  // Indented plain text: what you want when copying into a
                  // file or diffing, where the collapsible tree gets in the way.
                  <pre className="api-raw">{JSON.stringify(parsed.value, null, 2)}</pre>
                ) : (
                  <pre className="api-raw">{response.body}</pre>
                )}
              </>
            ) : (
              <div className="api-hint">响应体为空。</div>
            )}
          </>
        )}

        {tab === "headers" && (
          <div>
            {response.headers.length === 0 ? (
              <div className="api-hint">无响应头。</div>
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
              <div className="api-hint">未捕获到请求头。</div>
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
  // Mount the shared theme hook so html[data-theme] is set + storage/focus
  // listeners are attached. The hook doesn't return anything we need here;
  // JsonView (and any future themed child) reads theme via document.documentElement.
  useTheme();
  // Editor/response split height — draggable, persisted, ratio-based.
  const split = useVerticalSplit();
  const [state, setState] = useState<ApiState>({ nodes: [], envs: [] });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [response, setResponse] = useState<ApiResponse | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"headers" | "query" | "path" | "body" | "settings">("headers");

  // Modal state
  const [inputModal, setInputModal] = useState<{ title: string; label?: string; initial?: string; confirmText?: string; onConfirm: (v: string) => void } | null>(null);
  const [confirmModal, setConfirmModal] = useState<{ title: string; message: string; confirmText?: string; danger?: boolean; onConfirm: () => void } | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);
  const [moveToModal, setMoveToModal] = useState<{ node: ApiNode } | null>(null);
  const [envModalOpen, setEnvModalOpen] = useState(false);

  // Shared toast hook. Identical to the clipboard window's: de-dupes the
  // same message text, clears its own timer on unmount, and renders the
  // same `.toast` markup the existing CSS targets.
  const { toast, showToast } = useToast();

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
      showToast(`加载失败: ${friendlyError(e)}`, "error");
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => { loadState(); }, [loadState]);

  // ── Derived ──────────────────────────────────────────────────

  const selectedNode = state.nodes.find(n => n.id === selectedId) || null;

  // Pre-group the flat node list into parent -> children **once per nodes change**.
  //
  // 为什么放在顶层而不是 TreeNode 内部：TreeNode 里原来是
  // `nodes.filter(n => n.parent_id === node.id)`，每个节点都要扫一遍全表 → O(n^2)；
  // 若改成在 TreeNode 内部建 Map，则每个节点建一次 Map，比 filter 还慢。
  //
  // 顺便修掉一个真实存在的丢数据 Bug：parent_id 指向已不存在的 id（dangling
  // parent，例如导入的 JSON 或删除父节点时残留）的节点，既进不了根列表
  // （不等于 null）、也进不了任何 children（没有匹配的 node.id），于是在侧栏
  // 彻底消失 —— 但它仍在 state.nodes 里并会被保存，用户视角是数据凭空不见。
  // Rust 侧的 collect_descendants_tolerates_dangling_parent_references 说明这个
  // 场景确实出现过。这里把孤儿（以及自环 pid === n.id）一律提升为根节点。
  //
  // 不做任何排序：原来的 filter 保留 nodes 的原始顺序，用户手动排的顺序依赖它。
  const { childrenMap, roots } = useMemo(() => {
    const ids = new Set(state.nodes.map(n => n.id));
    const map = new Map<string, ApiNode[]>();
    const rootList: ApiNode[] = [];
    for (const n of state.nodes) {
      const pid = n.parent_id;
      // `pid == null` 同时覆盖 null 与 undefined（旧数据可能缺字段）
      if (pid == null || pid === n.id || !ids.has(pid)) {
        rootList.push(n);
        continue;
      }
      let arr = map.get(pid);
      if (!arr) { arr = []; map.set(pid, arr); }
      arr.push(n);
    }
    return { childrenMap: map, roots: rootList };
  }, [state.nodes]);

  // 提到外面并 useCallback：原来是写在 JSX 里的内联箭头，每次渲染都是新函数，
  // 会直接让 memo 化的 TreeNode 全部重渲染。函数式更新所以 deps 为空。
  const toggleCollapsed = useCallback((id: string) => {
    setCollapsedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  // Auto-sync path vars with URL
  const urlPathVars = selectedNode?.request ? extractPathVars(selectedNode.request.url) : [];

  // ── Node operations ─────────────────────────────────────────

  // friendlyError is imported from ./hooks/friendlyError; this used to
  // be a per-file inline helper that just truncated the raw error. The
  // shared version recognises common substrings (path-not-found,
  // permission, timeout, etc.) and produces a real Chinese message.

  // saveNode is the disk-write side of the editor pipeline. It is now
  // strictly an IPC: it does NOT touch local state. The previous
  // implementation also did `setState(prev => ...)` with the round-tripped
  // `saved` node, which had two bad side-effects:
  //
  //   1. The local state would be overwritten with whatever the backend
  //      sent back, including any `updated_at` clamping the backend
  //      applied. Combined with the path-vars effect (which depends on
  //      `state.nodes`), this created a feedback loop: typing in the URL
  //      → setState (in updateRequest) → saveNode IPC returns → setState
  //      again with the same node → path-vars effect fires because the
  //      nodes array reference changed → another setState → another IPC.
  //      A single keystroke ended up triggering 3-4 IPCs and the input
  //      visibly stuttered on every collection.
  //
  //   2. If the user typed a character and *immediately* switched to
  //      another request, the saveNode round-trip would still setState
  //      on the (now-unselected) original node — racing with the user's
  //      next edit on the new node.
  //
  // The local state managed by `updateRequest` and the path-vars effect
  // is the single source of truth for the UI. The backend is only the
  // source of truth for **persistence across restarts**; it does not
  // need to write back to the UI on every keystroke.
  const saveNode = useCallback(async (node: ApiNode) => {
    try {
      await invoke<ApiNode>("api_save_node", { node: { ...node, updated_at: now() } });
    } catch (e) {
      showToast(`保存失败: ${friendlyError(e)}`, "error");
    }
  }, [showToast]);

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
      // 用函数式更新读当前选中项，而不是闭包里的 `selectedId`：
      // 这样 deps 里不需要 selectedId，deleteNodeById 的引用在整个生命周期内
      // 保持稳定 → 依赖它的 confirmDeleteNode / showContextMenu 也才能稳定，
      // 否则每次切换选中节点都会让整棵树的 memo 失效。
      setSelectedId(cur => (cur === id ? null : cur));
    } catch (e) {
      showToast(`删除失败: ${friendlyError(e)}`, "error");
    }
  }, [showToast]);

  const duplicateNode = useCallback((node: ApiNode) => {
    const copy: ApiNode = {
      ...node,
      id: uid(),
      name: `${node.name} (副本)`,
      created_at: now(),
      updated_at: now(),
      request: node.request ? { ...node.request, history: [] } : null,
    };
    // Add to local state immediately so the sidebar reflects the new node
    // without waiting for the disk round-trip. `saveNode` no longer
    // setStates (see comment above) so we have to do it here.
    setState(prev => ({ ...prev, nodes: [...prev.nodes, copy] }));
    saveNode(copy);
  }, [saveNode]);

  // ── Add operations ──────────────────────────────────────────
  //
  // 以下几个回调都用 useCallback 包住，deps 只有 `saveNode` / `deleteNodeById`
  // （两者本身也是稳定的 useCallback）。这是 `React.memo(TreeNode)` 生效的前提：
  // 只要有一个回调每次渲染都换新引用，整棵树的 memo 命中率就是 0。
  // 顺序上必须先稳定这些「叶子」，再包依赖它们的 showContextMenu。
  //
  // 它们内部只用函数式 setState（`setState(prev => ...)`），不读 state.nodes，
  // 因此不会捕获过期的 state。

  const addFolder = useCallback((parentId: string | null) => {
    setInputModal({
      title: "新建文件夹",
      label: "文件夹名称",
      initial: "新文件夹",
      confirmText: "创建",
      onConfirm: (name) => {
        setInputModal(null);
        const node = newFolder(name, parentId);
        // Local-first: the sidebar shows the new folder instantly; the
        // disk write is fire-and-forget. `saveNode` only does IPC.
        setState(prev => ({ ...prev, nodes: [...prev.nodes, node] }));
        saveNode(node);
      },
    });
  }, [saveNode]);

  const addRequest = useCallback((parentId: string | null) => {
    setInputModal({
      title: "新建请求",
      label: "请求名称",
      initial: "新请求",
      confirmText: "创建",
      onConfirm: (name) => {
        setInputModal(null);
        const node = newRequestNode(name, parentId);
        setState(prev => ({ ...prev, nodes: [...prev.nodes, node] }));
        setSelectedId(node.id);
        saveNode(node);
      },
    });
  }, [saveNode]);

  // ── Rename ───────────────────────────────────────────────────

  const startRename = useCallback((node: ApiNode) => {
    setInputModal({
      title: `重命名 ${node.node_type === "folder" ? "文件夹" : "请求"}`,
      label: "名称",
      initial: node.name,
      confirmText: "重命名",
      onConfirm: (name) => {
        setInputModal(null);
        if (!name.trim() || name === node.name) return;
        const updated: ApiNode = { ...node, name };
        setState(prev => ({ ...prev, nodes: prev.nodes.map(n => n.id === node.id ? updated : n) }));
        saveNode(updated);
      },
    });
  }, [saveNode]);

  // Confirm-then-delete is intentionally a direct call here. The previous
  // implementation routed through showContextMenu with a synthesised event
  // (`{ preventDefault: () => {} } as any`) which both bypassed the real
  // context-menu state and produced a *visible* but disabled popup behind the
  // confirm dialog. Going through ConfirmModal keeps the user flow simple and
  // removes the `as any` cast.
  const confirmDeleteNode = useCallback((node: ApiNode) => {
    setConfirmModal({
      title: "删除",
      message: `确认删除 "${node.name}"?${node.node_type === "folder" ? "\n其下所有内容将一并删除。" : ""}`,
      confirmText: "删除",
      danger: true,
      onConfirm: () => { setConfirmModal(null); deleteNodeById(node.id); },
    });
  }, [deleteNodeById]);

  // ── Context menu ─────────────────────────────────────────────

  // deps 全是上面那批稳定的 useCallback，所以 showContextMenu 本身也稳定，
  // 可以安全地作为 prop 传给 memo 化的 TreeNode。
  const showContextMenu = useCallback((e: React.MouseEvent, node: ApiNode) => {
    e.preventDefault();
    e.stopPropagation();
    const items: ContextMenuItem[] = [
      { label: "重命名", onClick: () => startRename(node) },
      { label: "复制", onClick: () => duplicateNode(node) },
      { label: "移动到...", onClick: () => setMoveToModal({ node }) },
    ];
    if (node.node_type === "folder") {
      items.push(
        { label: "新建文件夹", onClick: () => addFolder(node.id) },
        { label: "新建请求", onClick: () => addRequest(node.id) },
      );
    }
    items.push({ label: "删除", danger: true, onClick: () => confirmDeleteNode(node) });
    setContextMenu({ x: e.clientX, y: e.clientY, items });
  }, [startRename, duplicateNode, addFolder, addRequest, confirmDeleteNode]);

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

    const moved: ApiNode = { ...nodeToMove, parent_id: newParentId };
    // Local-first: reflect the new parent in the tree right away.
    setState(prev => ({ ...prev, nodes: prev.nodes.map(n => n.id === nodeToMove.id ? moved : n) }));
    saveNode(moved);
    setMoveToModal(null);
  };

  // ── Drag & drop (tree reordering by parent) ──────────────────

  // 被拖节点本身放 ref：回调里要读它的最新值，但它不参与渲染，
  // 放 state 只会让每个 dragover 都被迫读一次陈旧闭包。
  const dragNodeRef = useRef<ApiNode | null>(null);
  // 这两个 id 要驱动样式，只能是 state；写入前都做等值判断，避免
  // dragover（每几十毫秒触发一次）无意义地 setState。
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  // moveNode 是裸函数（每次渲染新引用）且闭包读 state.nodes。若直接进
  // useCallback 的依赖数组，下面的回调每渲染都会换引用，击穿 TreeNode 的 memo。
  // 用 ref 桥接后依赖数组可以恒为空。
  const moveNodeRef = useRef(moveNode);
  moveNodeRef.current = moveNode;

  // 目标是否位于被拖节点的子树内（含自身）。moveNode 内部也有同样的
  // 环检测，这里提前判断只是为了不给非法目标显示放置高亮。
  const isDescendantOf = (ancestorId: string, targetId: string) => {
    let current: string | undefined = targetId;
    while (current) {
      if (current === ancestorId) return true;
      const parent = state.nodes.find(n => n.id === current);
      if (!parent) return false;
      current = parent.parent_id || undefined;
    }
    return false;
  };

  // 拖到请求行上时，落点回退为该请求所在的文件夹 —— 用户瞄准的是"这个位置"，
  // 而不是"这个请求"。不这么做的话，拖到请求上完全没有任何反馈，看起来就像
  // 拖拽功能坏了（树里请求行远多于文件夹行，这是最常撞上的情况）。
  const resolveDropTarget = (target: ApiNode): string | null =>
    target.node_type === "folder" ? target.id : (target.parent_id ?? null);

  // 不能放回原父节点（无意义）；不能放进自己的子树。
  // 同样读 state.nodes，所以和 moveNode 一样走 ref 桥接。
  const canDrop = (dragged: ApiNode | null, target: ApiNode) => {
    if (!dragged) return false;
    const destId = resolveDropTarget(target);
    if (dragged.id === destId) return false;
    if ((dragged.parent_id ?? null) === destId) return false;
    if (destId === null) return true;               // 落到顶层
    return !isDescendantOf(dragged.id, destId);
  };
  const canDropRef = useRef(canDrop);
  canDropRef.current = canDrop;
  const resolveDropTargetRef = useRef(resolveDropTarget);
  resolveDropTargetRef.current = resolveDropTarget;

  const handleDragStart = useCallback((e: React.DragEvent, node: ApiNode) => {
    e.stopPropagation();                            // 否则祖先行也会开始拖拽
    dragNodeRef.current = node;
    setDraggingId(node.id);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", node.id);  // Firefox 不设 data 不触发拖拽
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, node: ApiNode) => {
    e.stopPropagation();
    if (!canDropRef.current(dragNodeRef.current, node)) return; // 不 preventDefault ⇒ 不允许放置
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    // 高亮真正的落点：悬停在请求上时亮的是它的父文件夹，而不是那一行请求。
    const destId = resolveDropTargetRef.current(node);
    setDragOverId(prev => prev === destId ? prev : destId);
  }, []);

  const handleDragLeave = useCallback((_e: React.DragEvent, node: ApiNode) => {
    // 只清自己：离开子行进入父行时，父行的 dragover 会紧接着改回来。
    // 注意比的是解析后的落点 —— 悬停请求行时高亮挂在其父文件夹上。
    const destId = resolveDropTargetRef.current(node);
    setDragOverId(prev => prev === destId ? null : prev);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent, node: ApiNode) => {
    e.preventDefault();
    e.stopPropagation();                            // 防止冒泡到根容器再移到顶层
    const dragged = dragNodeRef.current;
    if (canDropRef.current(dragged, node) && dragged) {
      moveNodeRef.current(dragged, resolveDropTargetRef.current(node));
    }
    dragNodeRef.current = null;
    setDraggingId(null);
    setDragOverId(null);
  }, []);

  const handleDragEnd = useCallback(() => {
    dragNodeRef.current = null;
    setDraggingId(null);
    setDragOverId(null);
  }, []);

  // 落在树的空白处 = 移动到顶层。
  const handleRootDrop = useCallback((e: React.DragEvent) => {
    if (e.target !== e.currentTarget) return;     // 实际落在某行上的，由行处理
    e.preventDefault();
    const dragged = dragNodeRef.current;
    if (dragged && dragged.parent_id) moveNodeRef.current(dragged, null);
    dragNodeRef.current = null;
    setDraggingId(null);
    setDragOverId(null);
  }, []);

  // ── Request editing ──────────────────────────────────────────

  // Persist the currently-selected node to disk. Wrapped in a debounce so
  // that typing into any of the editor inputs (URL, method, headers KV,
  // form-data, body, etc.) coalesces a flurry of keystrokes into one
  // `api_save_node` IPC round-trip. Without this, a single character
  // triggered 2+ IPCs (one for the field itself, one for the path-vars
  // sync effect) and the input visibly stuttered on long collections.
  //
  // We use a ref for the freshest node snapshot rather than closing over
  // a stale render-time value. The "latest-wins via ref" pattern also
  // matters when the user clicks over to another request mid-debounce:
  // we still flush the original node, but `saveNode` (which now ONLY
  // does the IPC, no setState) is idempotent on the same id, so a stale
  // write can't corrupt anything the user has touched on the new
  // selection.
  const nodeFlushRef = useRef<{ id: string; node: ApiNode } | null>(null);
  const flushNodeToBackend = useDebouncedCallback((payload: { id: string; node: ApiNode }) => {
    // Only write to backend. The local state merge in `updateRequest` /
    // the path-vars effect is the source of truth for the UI; the
    // backend is the source of truth for persistence. Mixing them
    // caused stale-render races.
    saveNode(payload.node);
  }, 400);

  // Local state update + scheduled persist. The previous implementation
  // always called `saveNode` directly, which (a) blocked every keystroke
  // on an IPC round-trip and (b) interacted badly with the path-vars
  // sync effect to cause duplicate saves and lost characters.
  //
  // Note: this callback intentionally only depends on `selectedId`, NOT
  // on `selectedNode`. `selectedNode` is recomputed from `state.nodes`
  // on every render (and changes reference every time we setState),
  // so depending on it would re-create this callback on every
  // keystroke — which would in turn re-create `flushNodeToBackend`
  // (via its ref) and re-fire the path-vars effect. Reading from the
  // ref keeps everything stable.
  //
  // The path-vars sync (extracting `:foo` from the URL into the
  // path-vars KV editor) used to be a separate `useEffect` watching
  // `state.nodes`, but that caused two setState writes per URL
  // keystroke (one for the URL itself, one for the derived
  // path-vars), plus two debounced IPCs. We fold the sync INTO the
  // URL update path so it happens in the same setState tick.
  const selectedIdRef = useRef<string | null>(selectedId);
  selectedIdRef.current = selectedId;
  const updateRequest = useCallback((patch: Partial<ApiRequest>) => {
    const id = selectedIdRef.current;
    if (!id) return;
    setState(prev => {
      const cur = prev.nodes.find(n => n.id === id);
      if (!cur) return prev;
      const updatedReq = { ...(cur.request || newRequest()), ...patch };
      // The path-vars KV editor is a projection of the URL's
      // `:name` placeholders (URL is the single source of truth for
      // which variables exist). When the URL changes, we *retain*
      // any user-typed values for keys that still appear in the new
      // URL and drop keys that no longer do. We do NOT inject empty
      // rows for newly-added `:name` placeholders here: the path-vars
      // tab (rendered as `PathVarEditor`) builds its rows from
      // `urlPathVars` on every render, so the user sees a new empty
      // value field the moment they type `:` into the URL — no need
      // (and not safe) to also write a synthetic `["name", ""]`
      // into `req.path_vars`. `sendRequest` re-derives the full
      // key set from the URL at execute time, so transient
      // mismatches between `req.path_vars` and the URL are harmless.
      if ("url" in patch) {
        const urlKeys = new Set(extractPathVars(updatedReq.url));
        const existing = updatedReq.path_vars || [];
        // Keep only entries whose key is still in the URL; preserve
        // their stored values verbatim. New keys are NOT pre-seeded
        // here for the reasons above.
        updatedReq.path_vars = existing.filter(([k]) => urlKeys.has(k));
      }
      const updatedNode: ApiNode = { ...cur, request: updatedReq };
      nodeFlushRef.current = { id, node: updatedNode };
      flushNodeToBackend(nodeFlushRef.current);
      return { ...prev, nodes: prev.nodes.map(n => n.id === id ? updatedNode : n) };
    });
  }, [flushNodeToBackend]);

  // One-shot path-vars cleanup for the *currently selected* node, fired
  // when the selection itself changes (e.g. user clicks a different
  // request in the sidebar, or the initial load picks a default).
  //
  // The URL is the single source of truth for which path-var names
  // exist. The `req.path_vars` field on disk is a *cache* of the
  // user-typed values, keyed by name. When the selection changes we
  // need to drop any cached value whose key is no longer in the URL —
  // otherwise the disk file would grow a tail of orphan entries for
  // every URL edit. We do NOT inject empty rows for new `:name`
  // placeholders here, because the `PathVarEditor` is a URL-driven
  // projection that builds its rows from `urlPathVars` on every
  // render; a synthetic `["name", ""]` in `req.path_vars` would be
  // redundant at best and confusing at worst.
  //
  // This effect must NOT depend on `state.nodes` (that would re-fire
  // on every keystroke and produce the double-write the `updateRequest`
  // path is designed to prevent). We read the freshest node from a
  // state ref (rather than the render-time `state.nodes`) so the
  // initial load — which sets both `state.nodes` and `selectedId` in
  // the same tick — sees a consistent view. Without the ref, this
  // effect would fire before `state.nodes` had been updated and
  // find `cur?.request` to be null, no-oping.
  const stateRef = useRef(state);
  stateRef.current = state;
  useEffect(() => {
    if (!selectedId) return;
    const cur = stateRef.current.nodes.find(n => n.id === selectedId);
    if (!cur?.request) return;
    const url = cur.request.url;
    const urlKeys = new Set(extractPathVars(url));
    const existing = cur.request.path_vars || [];
    // Drop entries whose key is no longer in the URL. This is a
    // selection-change event, not a keystroke event, so the disk
    // write is immediate rather than debounced — a quick switch to
    // another request inside the debounce window would otherwise
    // risk losing the cleanup.
    const kept = existing.filter(([k]) => urlKeys.has(k));
    if (kept.length === existing.length) return;
    const updated: ApiNode = {
      ...cur,
      request: { ...cur.request, path_vars: kept },
    };
    setState(prev => {
      const idx = prev.nodes.findIndex(n => n.id === selectedId);
      if (idx < 0) return prev;
      return { ...prev, nodes: prev.nodes.map(n => n.id === selectedId ? updated : n) };
    });
    saveNode(updated);
  }, [selectedId, saveNode]);

  // ── Send request ─────────────────────────────────────────────
  //
  // Guarded by a monotonic sequence number. Previously, switching to a
  // different request while one was in flight let the *older* reply land
  // last and overwrite the newer response; and because the closure had
  // captured a stale `selectedNode`, the history entry was written to
  // whichever request had been selected when Send was pressed. Both
  // symptoms disappear if a reply is ignored unless it belongs to the
  // most recent send.
  const sendSeq = useRef(0);

  const sendRequest = useCallback(async () => {
    const node = selectedNode;
    if (!node?.request) return;
    const req = node.request;
    const seq = ++sendSeq.current;
    setSending(true);
    setSendError(null);
    setResponse(null);
    try {
      // Re-derive path_vars from the URL. The KV editor for path vars
      // is a *projection* of the URL's `:name` placeholders (URL is
      // the single source of truth for which variables exist), but
      // `req.path_vars` may have keys the URL no longer declares (the
      // user renamed or removed one) and may be missing keys the URL
      // just added (the user never opened the path-vars tab to type a
      // value). We re-derive the key list from the URL here so the
      // backend always sees the *current* variable set, with values
      // looked up from `req.path_vars` by key (missing keys send as
      // empty strings, which the backend uses to mean "leave the
      // placeholder alone"). The user's stored values still get
      // persisted to disk via the `updateRequest` path in the editor,
      // so renaming `:id` to `:userId` in the URL doesn't drop the
      // value they typed for the old key.
      const pathVarKeys = extractPathVars(req.url);
      const pathVarsWithValues: [string, string][] = pathVarKeys.map(k => {
        const found = req.path_vars.find(([kk]) => kk === k);
        return found ? found : [k, ""];
      });
      // Filter out empty pairs.
      const cleanReq: ApiRequest = {
        ...req,
        headers: req.headers.filter(([k]) => k.trim()),
        query: req.query.filter(([k]) => k.trim()),
        path_vars: pathVarsWithValues,
        url_encoded: (req.url_encoded || []).filter(([k]) => k.trim()),
        form_data: (req.form_data || []).filter(f => f.key.trim()),
      };
      const resp = await invoke<ApiResponse>("api_execute", { request: cleanReq });
      // A newer send superseded us — drop this reply entirely.
      if (seq !== sendSeq.current) return;
      setResponse(resp);
      // History is owned by the front-end. The backend used to append it
      // too, matching the node by URL+method (wrong node when two share a
      // URL) and then getting clobbered by our own `saveNode` snapshot.
      // Note we target `node.id` explicitly rather than trusting whatever
      // is selected by the time the reply arrives.
      setState(prev => {
        const target = prev.nodes.find(n => n.id === node.id);
        if (!target?.request) return prev;
        const newHistory = [resp, ...(target.request.history || [])].slice(0, HISTORY_LIMIT);
        const updated: ApiNode = {
          ...target,
          request: { ...target.request, history: newHistory },
        };
        saveNode(updated);
        return { ...prev, nodes: prev.nodes.map(n => n.id === node.id ? updated : n) };
      });
    } catch (e: any) {
      if (seq !== sendSeq.current) return;
      setSendError(friendlyError(e));
    } finally {
      // Only the latest send is allowed to clear the spinner, otherwise a
      // slow earlier reply switches it off while a newer one is running.
      if (seq === sendSeq.current) setSending(false);
    }
  }, [selectedNode, saveNode]);

  // ── Environment operations ───────────────────────────────────
  //
  // `updateEnv` and friends used to invoke `api_save_env` on every
  // keystroke. Each keypress did a full read-modify-write round-trip
  // to the backend, then `setState` with the *return value* of the
  // round-trip, which produced the exact same race we hit on the
  // request editor: concurrent invokes, late replies, and the slow
  // keyboard of "my variable name is randomly going back to what it
  // was 200ms ago". The fix is the same one we used for `updateRequest`:
  // write to local state synchronously on every keystroke and only
  // schedule a debounced disk write. `addEnv` keeps its single-shot
  // invoke because the env doesn't exist locally until the backend
  // returns the new id; `setActiveEnv` and `deleteEnv` are click
  // events, not keystrokes, so the round-trip is fine for them.
  //
  // NB: the debounced callback does **NOT** `setState` on `.then`.
  // Doing so would re-introduce the same race the original code had:
  // a late reply from a *previous* keystroke would clobber the latest
  // in-memory value. Local state is the source of truth; the backend
  // is only the persistence layer.
  const envFlushRef = useRef<{ id: string; env: ApiEnvironment } | null>(null);
  const flushEnvToBackend = useDebouncedCallback((payload: { id: string; env: ApiEnvironment }) => {
    invoke<ApiEnvironment>("api_save_env", { env: payload.env })
      .catch(e => {
        showToast(`保存环境失败: ${friendlyError(e)}`, "error");
      });
  }, 400);

  const updateEnv = useCallback((env: ApiEnvironment) => {
    // 1) Optimistic local write — the input shows the user's text on the
    //    very next render, no IPC involved.
    setState(prev => ({
      ...prev,
      envs: prev.envs.map(e => e.id === env.id ? env : e),
    }));
    // 2) Schedule a debounced disk write. The ref always holds the
    //    freshest snapshot; the debounced callback closes over the
    //    snapshot we captured when the *current* keystroke fired, not
    //    the render-time `env`, so concurrent calls collapse into a
    //    single write of the latest version.
    envFlushRef.current = { id: env.id, env };
    flushEnvToBackend(envFlushRef.current);
  }, [flushEnvToBackend]);

  const addEnv = () => {
    setInputModal({
      title: "新建环境",
      label: "环境名称",
      initial: "新环境",
      confirmText: "创建",
      onConfirm: (name) => {
        setInputModal(null);
        const env: ApiEnvironment = {
          id: uid(), name, base_url: "", headers: [["", ""]], vars: [["", ""]],
        };
        // New envs need the backend-assigned id, so we still do a
        // single round-trip here — but the local state is updated
        // optimistically so the sidebar shows the new env immediately.
        setState(prev => ({ ...prev, envs: [...prev.envs, env] }));
        invoke<ApiEnvironment>("api_save_env", { env }).catch(e => {
          showToast(`创建环境失败: ${friendlyError(e)}`, "error");
          // Rollback on failure so the sidebar doesn't keep a phantom env.
          setState(prev => ({ ...prev, envs: prev.envs.filter(x => x.id !== env.id) }));
        });
      },
    });
  };

  const deleteEnv = (env: ApiEnvironment) => {
    setConfirmModal({
      title: "删除环境",
      message: `确认删除环境 "${env.name}"?`,
      confirmText: "删除",
      danger: true,
      onConfirm: () => {
        setConfirmModal(null);
        // Optimistic removal — the env disappears instantly; the disk
        // write is fire-and-forget. A failure leaves a phantom env in
        // the sidebar that the next reload will reconcile, which is
        // strictly better than leaving the env visible while a slow
        // disk drive makes the user wonder if the click registered.
        //
        // Requests bound to this env keep their now-dangling `env_id`.
        // Rewriting every referencing node would mean a save storm here,
        // and the id is harmless: both the backend (`env_snapshot`) and
        // the picker below resolve an unknown id to "no env". Undoing a
        // failed delete then restores those bindings for free.
        setState(prev => ({
          ...prev,
          envs: prev.envs.filter(e => e.id !== env.id),
        }));
        invoke("api_delete_env", { id: env.id }).catch(e => {
          showToast(`删除环境失败: ${friendlyError(e)}`, "error");
          setState(prev => ({
            ...prev,
            envs: [...prev.envs, env],
          }));
        });
      },
    });
  };

  // ── Render ───────────────────────────────────────────────────
  //
  // NOTE: everything hook-shaped must stay ABOVE the `loading` early
  // return. `inheritedHeaders` originally sat down with the other
  // derived counts and silently changed the hook count between the
  // loading and loaded renders ("change in the order of Hooks").

  const req = selectedNode?.request || null;
  // Headers inherited from the request's environment. Mirrors the backend's
  // `merge_env_headers`: a same-named request header (case-insensitive) wins,
  // so it is no longer inherited — whether it overrides or opts out entirely.
  const inheritedHeaders = useMemo(() => {
    const env = req?.env_id ? state.envs.find(e => e.id === req.env_id) : undefined;
    if (!env) return [] as [string, string][];
    const own = new Set(
      (req?.headers ?? [])
        .filter(([k]) => k.trim())
        .map(([k]) => k.trim().toLowerCase())
    );
    return (env.headers ?? []).filter(
      ([k]) => k.trim() && !own.has(k.trim().toLowerCase())
    );
  }, [state.envs, req?.env_id, req?.headers]);

  if (loading) {
    return <div className="api-app"><div className="api-placeholder"><div className="api-spinner" /></div></div>;
  }

  const ownHeaderCount = req?.headers?.filter(([k]) => k.trim()).length || 0;
  const headerCount = ownHeaderCount + inheritedHeaders.length;
  const queryCount = req?.query?.filter(([k]) => k.trim()).length || 0;
  const pathCount = req?.path_vars?.filter(([k]) => k.trim()).length || 0;
  const hasBody = req?.body_type && req.body_type !== "none";

  return (
    <div
      className="api-app"
      ref={split.containerRef}
      style={{ ["--api-split-top" as string]: `${split.topPct}%` }}
    >
      {/* ── Sidebar ── */}
      <div className="api-sidebar">
        {/* Collections */}
        <div className="api-sidebar-section" style={{ flex: 1 }}>
          <div className="api-sidebar-header">
            <span className="api-sidebar-title">请求集合</span>
            <div className="api-sidebar-actions">
              <button className="api-icon-btn" onClick={() => addFolder(null)} title="新建文件夹"><IconFolder />+</button>
              <button className="api-icon-btn" onClick={() => addRequest(null)} title="新建请求">+</button>
            </div>
          </div>
          {/*
            Only claim the drop when it lands on the container's own padding —
            i.e. "move to top level". An unconditional preventDefault() here
            would fire *after* each row's handler (React delegates at the root,
            so a row's stopPropagation cannot stop it) and re-enable dropping on
            rows the row itself just refused, killing every drop-target
            highlight and stealing real drops away to the top level.
          */}
          <div
            className="api-tree"
            onDragOver={e => { if (e.target === e.currentTarget) e.preventDefault(); }}
            onDrop={handleRootDrop}
          >
            {roots.length === 0 ? (
              <div className="api-empty">
                暂无请求集合。
                <br />
                点击 + 创建一个请求。
              </div>
            ) : (
              roots.map(node => (
                <TreeNode
                  key={node.id}
                  node={node}
                  childrenMap={childrenMap}
                  selectedId={selectedId}
                  collapsedIds={collapsedIds}
                  depth={0}
                  onSelect={setSelectedId}
                  onToggle={toggleCollapsed}
                  onRename={startRename}
                  onDelete={confirmDeleteNode}
                  onDuplicate={duplicateNode}
                  onContextMenu={showContextMenu}
                  draggingId={draggingId}
                  dragOverId={dragOverId}
                  onDragStart={handleDragStart}
                  onDragOver={handleDragOver}
                  onDragLeave={handleDragLeave}
                  onDrop={handleDrop}
                  onDragEnd={handleDragEnd}
                />
              ))
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
              <button
                className="api-editor-env-btn"
                onClick={() => setEnvModalOpen(true)}
                title="管理环境变量"
              >
                {req.env_id
                  ? state.envs.find(e => e.id === req.env_id)?.name ?? "环境"
                  : "环境变量"}
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ width: 12, height: 12 }}>
                  <path d="M6 3l4 5-4 5" />
                </svg>
              </button>
            </div>

            <div className="api-url-bar">
              <select
                className="api-method-select"
                value={req.method}
                onChange={e => updateRequest({ method: e.target.value })}
              >
                {METHODS.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
              {state.envs.length > 0 && (
                <select
                  className="api-env-select"
                  value={req.env_id ?? ""}
                  onChange={e => updateRequest({ env_id: e.target.value || null })}
                  title="本请求使用的环境"
                >
                  <option value="">无环境</option>
                  {state.envs.map(env => <option key={env.id} value={env.id}>{envSelectLabel(env)}</option>)}
                </select>
              )}
              <UrlInput
                value={req.url}
                onCommit={url => updateRequest({ url })}
                onEnter={sendRequest}
              />
              <button className="api-send-btn" onClick={sendRequest} disabled={sending || !req.url.trim()}>
                {sending ? "发送中..." : "发送"}
              </button>
            </div>

            <div className="api-tabs">
              <button className={`api-tab${activeTab === "headers" ? " active" : ""}`} onClick={() => setActiveTab("headers")}>
                请求头{headerCount > 0 && <span className="api-tab-badge">{headerCount}</span>}
              </button>
              <button className={`api-tab${activeTab === "query" ? " active" : ""}`} onClick={() => setActiveTab("query")}>
                查询参数{queryCount > 0 && <span className="api-tab-badge">{queryCount}</span>}
              </button>
              <button className={`api-tab${activeTab === "path" ? " active" : ""}`} onClick={() => setActiveTab("path")}>
                路径变量{pathCount > 0 && <span className="api-tab-badge">{pathCount}</span>}
              </button>
              <button className={`api-tab${activeTab === "body" ? " active" : ""}`} onClick={() => setActiveTab("body")}>
                请求体{hasBody && <span className="api-tab-badge-dot" />}
              </button>
              <button className={`api-tab${activeTab === "settings" ? " active" : ""}`} onClick={() => setActiveTab("settings")}>
                设置{req.insecure_tls && <span className="api-tab-badge-dot api-dot-warn" />}
              </button>
            </div>

            <div className="api-tab-content">
              {activeTab === "headers" && (
                <>
                  {/* Read-only preview of what the active env contributes, so
                      the request that goes out is never a surprise. Editing
                      happens in the env dialog; overriding happens by adding a
                      same-named row below. */}
                  {inheritedHeaders.length > 0 && (
                    <div className="api-inherited-headers">
                      <div className="api-inherited-title">
                        来自环境「{state.envs.find(e => e.id === req.env_id)?.name}」
                      </div>
                      {inheritedHeaders.map(([k, v], i) => (
                        <div className="api-inherited-row" key={i}>
                          <span className="api-inherited-k">{k}</span>
                          <span className="api-inherited-v" title={v}>{v}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  <KvEditor
                    pairs={req.headers?.length ? req.headers : [["", ""]]}
                    onChange={headers => updateRequest({ headers })}
                    keyPlaceholder="请求头名称"
                    valuePlaceholder="值"
                  />
                </>
              )}
              {activeTab === "query" && (
                <KvEditor
                  pairs={req.query?.length ? req.query : [["", ""]]}
                  onChange={query => updateRequest({ query })}
                  keyPlaceholder="参数名"
                  valuePlaceholder="值"
                />
              )}
              {activeTab === "path" && (
                <>
                  {urlPathVars.length === 0 ? (
                    <div className="api-hint">
                      未检测到路径变量。在 URL 中使用 <code>:变量名</code> 语法定义路径变量
                      （例如 <code>/api/users/:id</code>）。
                    </div>
                  ) : (
                    // The path-vars KV editor is a *projection* of the
                    // URL's `:name` placeholders. URL is the single
                    // source of truth for which variables exist; this
                    // table is just where the user types the values.
                    // Rendering the projection (instead of the raw
                    // `req.path_vars`) means: (1) adding a new `:foo`
                    // to the URL immediately produces a `foo` row ready
                    // to be filled in — no more "I added :id to the URL
                    // and the path-vars tab still shows an empty row",
                    // which was the original "input is broken" report;
                    // (2) renaming `:id` to `:userId` in the URL
                    // immediately renames the row, preserving any
                    // value the user had typed (looked up by key);
                    // (3) removing all `:name` placeholders from the
                    // URL collapses the table to a single empty
                    // placeholder row, which is the same state we use
                    // everywhere else. The `req.path_vars` field on
                    // disk keeps the user's typed values, keyed by name,
                    // so persisting "user typed a value for :id" is
                    // still a real write — the projection only changes
                    // which keys we *show*; values are sourced from
                    // (and committed back to) `req.path_vars`.
                    <PathVarEditor
                      urlKeys={urlPathVars}
                      stored={req.path_vars || []}
                      onChange={path_vars => updateRequest({ path_vars })}
                    />
                  )}
                </>
              )}
              {activeTab === "body" && (
                <BodyEditor req={req} onChange={updateRequest} />
              )}
              {activeTab === "settings" && (
                <div className="api-settings">
                  <label className="api-setting-row">
                    <span className="api-setting-label">超时（秒）</span>
                    <input
                      className="api-setting-input"
                      type="number"
                      min={1}
                      max={600}
                      placeholder="30"
                      value={req.timeout_secs ?? ""}
                      onChange={e => {
                        const raw = e.target.value.trim();
                        // Empty means "use the backend default", which is a
                        // meaningfully different state from any number — so it
                        // maps to null rather than to 0 or 30.
                        if (raw === "") {
                          updateRequest({ timeout_secs: null });
                          return;
                        }
                        const n = Number(raw);
                        if (Number.isFinite(n) && n > 0) {
                          updateRequest({ timeout_secs: Math.min(Math.round(n), 600) });
                        }
                      }}
                    />
                    <span className="api-setting-hint">留空使用默认 30 秒，最大 600 秒</span>
                  </label>

                  <label className="api-setting-row">
                    <span className="api-setting-label">跳过 TLS 证书校验</span>
                    <input
                      type="checkbox"
                      checked={!!req.insecure_tls}
                      onChange={e => updateRequest({ insecure_tls: e.target.checked })}
                    />
                    <span className="api-setting-hint">
                      仅用于自签名证书的测试环境；开启后该请求不再验证服务端身份，
                      存在中间人攻击风险。
                    </span>
                  </label>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="api-placeholder">
            <svg className="api-placeholder-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="12" cy="12" r="10" />
              <path d="M12 6v6l4 2" />
            </svg>
            <h3>未选择请求</h3>
            <p>从左侧集合中选择一个请求，或创建一个新请求以开始。</p>
            <div className="api-placeholder-actions">
              <button className="api-btn" onClick={() => addRequest(null)}>新建请求</button>
              <button className="api-btn api-btn-secondary" onClick={() => addFolder(null)}>新建文件夹</button>
            </div>
          </div>
        )}
      </div>

      {/* ── Splitter: drag to rebalance editor vs response ── */}
      <div
        className="api-splitter"
        data-dragging={split.dragging}
        role="separator"
        aria-orientation="horizontal"
        aria-label="调整请求区与响应区高度"
        aria-valuenow={Math.round(split.topPct)}
        aria-valuemin={15}
        aria-valuemax={85}
        tabIndex={0}
        title="拖拽调整高度（双击恢复默认）"
        onMouseDown={split.onHandleMouseDown}
        onKeyDown={split.onHandleKeyDown}
        onDoubleClick={split.reset}
      >
        <div className="api-splitter-grip" />
      </div>

      {/* ── Response (right) ── */}
      <div className="api-response">
        <ResponseViewer response={response} loading={sending} error={sendError} />
      </div>

      {/* ── Modals ── */}
      {toast && (
        <div className={`toast toast-${toast.type}`}>{toast.msg}</div>
      )}

      {/* Rendered before the generic modals on purpose: `addEnv` / `deleteEnv`
          open InputModal / ConfirmModal on top of this one, and since all
          overlays share z-index 9999, paint order decides who wins. */}
      {envModalOpen && (
        <EnvManagerModal
          envs={state.envs}
          onAdd={addEnv}
          onUpdate={updateEnv}
          onDelete={deleteEnv}
          onClose={() => setEnvModalOpen(false)}
        />
      )}

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
// DEBUG_MARKER_FIX_1
