use serde::{Deserialize, Serialize};
use chrono::Utc;

// ── Clipboard Item ──────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub enum ItemType {
    #[default]
    Text,
    Image,
    Files,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClipboardItem {
    pub id: String,
    pub content: String,
    pub timestamp: i64,
    /// Tags assigned by the user. Empty by default; an external index may
    /// (and currently does) auto-tag based on the content.
    pub tags: Vec<String>,
    /// True when the user has promoted this item into the "Saved Notes" view.
    pub saved_as_note: bool,
    /// Cross-reference id of the note created from this item, if any. Lets the
    /// UI jump straight to the note when the user clicks the link.
    pub source_clip_id: Option<String>,
    /// Discriminator for the payload kind. The `ItemType` enum is the single
    /// source of truth — an older `content_type: String` field was removed
    /// because nothing read it.
    #[serde(rename = "type", default)]
    pub item_type: ItemType,
    /// User-starred; surfaced at the top of the list.
    #[serde(default)]
    pub favorite: bool,
}

// Backwards-compat note: older `history.json` files may have contained a
// `content_type` and `hash` field. The current `ClipboardItem` struct
// drops both — `item_type` carries the same enum info, and image
// de-dup is done in-memory by the manager (`last_image_hash`) rather
// than persisted per-item. Serde's default behaviour (no
// `#[serde(deny_unknown_fields)]` on this struct) silently discards
// those legacy keys on load, so old data files keep working. New
// history files written by this version will simply not contain them.
//
// `Note::pinned` and the manager-level `incognito` flag are unrelated
// to this removal — they still exist (note sort order depends on
// `pinned`, and `incognito` is an in-memory privacy toggle, not a
// serialised field).

impl ClipboardItem {
    pub fn new_text(content: String) -> Self {
        let now = Utc::now().timestamp_millis();
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            content,
            timestamp: now,
            tags: vec![],
            saved_as_note: false,
            source_clip_id: None,
            item_type: ItemType::Text,
            favorite: false,
        }
    }

    pub fn new_image(desc: String) -> Self {
        let now = Utc::now().timestamp_millis();
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            content: desc,
            timestamp: now,
            tags: vec![],
            saved_as_note: false,
            source_clip_id: None,
            item_type: ItemType::Image,
            favorite: false,
        }
    }

    pub fn new_files(content: String) -> Self {
        let now = Utc::now().timestamp_millis();
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            content,
            timestamp: now,
            tags: vec![],
            saved_as_note: false,
            source_clip_id: None,
            item_type: ItemType::Files,
            favorite: false,
        }
    }
}

// ── Note ───────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Note {
    pub id: String,
    pub title: String,
    pub content: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub tags: Vec<String>,
    pub source_clip_id: Option<String>,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub category: Option<String>,
}

impl Note {
    pub fn new(input: NoteInput, source_clip_id: Option<String>) -> Self {
        let now = Utc::now().timestamp_millis();
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            title: input.title,
            content: input.content,
            created_at: now,
            updated_at: now,
            tags: input.tags,
            source_clip_id,
            pinned: false,
            category: input.category,
        }
    }

    pub fn apply_update(&mut self, input: NoteInput) {
        self.title = input.title;
        self.content = input.content;
        self.tags = input.tags;
        self.category = input.category;
        self.updated_at = Utc::now().timestamp_millis();
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteInput {
    pub title: String,
    pub content: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub category: Option<String>,
}

// ── App Config ─────────────────────────────────────────────────

fn default_clip_sc() -> String { "Ctrl+Shift+V".into() }
fn default_notes_sc() -> String { "Ctrl+Shift+N".into() }
fn default_tools_sc() -> String { "Ctrl+Shift+T".into() }
fn default_screenshot_sc() -> String { "Ctrl+Shift+S".into() }
fn default_api_sc() -> String { "Ctrl+Shift+U".into() }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    #[serde(default = "default_max_items")]
    pub max_items: usize,
    #[serde(default = "default_poll_interval")]
    pub poll_interval_ms: u64,
    #[serde(default = "default_clip_sc")]
    pub clipboard_shortcut: String,
    #[serde(default = "default_notes_sc")]
    pub notes_shortcut: String,
    #[serde(default = "default_tools_sc")]
    pub tools_shortcut: String,
    #[serde(default = "default_screenshot_sc")]
    pub screenshot_shortcut: String,
    #[serde(default = "default_api_sc")]
    pub api_shortcut: String,
    #[serde(default = "default_true")]
    pub copy_on_double_click: bool,
    /// Optional override for the directory where all persistent data is stored
    /// (clipboard history, notes, screenshots, tools state, API collections, ...).
    /// When `None`, the OS-default app data directory is used.
    #[serde(default)]
    pub storage_root: Option<String>,
}

fn default_true() -> bool { true }

fn default_max_items() -> usize { 500 }
fn default_poll_interval() -> u64 { 500 }

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            max_items: default_max_items(),
            poll_interval_ms: default_poll_interval(),
            clipboard_shortcut: default_clip_sc(),
            notes_shortcut: default_notes_sc(),
            tools_shortcut: default_tools_sc(),
            screenshot_shortcut: default_screenshot_sc(),
            copy_on_double_click: true,
            storage_root: None,
            api_shortcut: default_api_sc(),
        }
    }
}

/// Combined payload for `get_history_full` — items + stats + image data map
/// (base64 data URLs, keyed by item id). Returning everything in one IPC
/// call saves N+1 round-trips (one `get_history` + N `get_image_data`)
/// and lets the front-end render the list with images already populated.
///
/// Images are only included for items of type Image; the map is sparse
/// so a text-heavy history doesn't pay the base64 cost for nothing.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryFull {
    pub items: Vec<ClipboardItem>,
    pub stats: (usize, u64),
    /// Map from item id → data:image/png;base64,…
    #[serde(default)]
    pub images: std::collections::HashMap<String, String>,
}

/// Proxy configuration for the HTTP router.
/// A single proxy routing rule.
/// If path matches prefix, route to target.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProxyRoute {
    pub id: String,
    pub path_prefix: String,
    pub target: String,
    pub enabled: bool,
}

/// Proxy configuration for the HTTP router.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProxyConfig {
    pub default_target: String,
    pub port: u16,
    pub running: bool,
    pub routes: Vec<ProxyRoute>,
}

/// A single proxy request log entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProxyLog {
    pub id: String,
    pub timestamp: i64,
    pub method: String,
    pub url: String,
    pub route_match: Option<String>,
    pub status: u16,
    pub duration_ms: u64,
    /// Request headers as (name, value) pairs.
    #[serde(default)]
    pub request_headers: Vec<(String, String)>,
    /// Request body as UTF-8 text (truncated for large/binary payloads).
    #[serde(default)]
    pub request_body: Option<String>,
    /// Response headers as (name, value) pairs.
    #[serde(default)]
    pub response_headers: Vec<(String, String)>,
    /// Response body as UTF-8 text (truncated for large/binary payloads).
    #[serde(default)]
    pub response_body: Option<String>,
    /// Error detail when the forward failed (connection refused, timeout, ...).
    #[serde(default)]
    pub error: Option<String>,
}

// ── API Platform ───────────────────────────────────────────────

/// Node type in the API collection tree.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ApiNodeType {
    Folder,
    Request,
}

/// A single node in the API collection tree (folder or request).
/// The tree is stored as a flat `Vec<ApiNode>`; hierarchy is reconstructed
/// via `parent_id` (`None` = root).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiNode {
    pub id: String,
    pub parent_id: Option<String>,
    pub name: String,
    pub node_type: ApiNodeType,
    /// Only present when `node_type == Request`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request: Option<ApiRequest>,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
}

/// HTTP request stored under a request node.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ApiRequest {
    #[serde(default)]
    pub method: String,
    #[serde(default)]
    pub url: String,
    /// Headers as (name, value) pairs (matches `ProxyLog` shape).
    #[serde(default)]
    pub headers: Vec<(String, String)>,
    /// Query parameters appended to the URL at send time.
    #[serde(default)]
    pub query: Vec<(String, String)>,
    /// Path variables (`:var` in URL) replaced at send time.
    #[serde(default)]
    pub path_vars: Vec<(String, String)>,
    /// Body type: "none", "raw", "form-data", "urlencoded", "binary", "msgpack".
    #[serde(default)]
    pub body_type: String,
    /// Raw body language (used when body_type == "raw"): "json", "xml", "javascript", "text", "html".
    #[serde(default)]
    pub body_raw_lang: String,
    /// Optional request body (text, used when body_type == "raw").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    /// Form data fields (used when body_type == "form-data").
    #[serde(default)]
    pub form_data: Vec<FormField>,
    /// URL-encoded fields (used when body_type == "urlencoded").
    #[serde(default)]
    pub url_encoded: Vec<(String, String)>,
    /// File path for binary body (used when body_type == "binary").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binary_file: Option<String>,
    /// File path for msgpack body (used when body_type == "msgpack").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub msgpack_file: Option<String>,
    /// Optional environment id used to expand `{{var}}` placeholders.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env_id: Option<String>,
    /// Most recent N (50) responses — newest first, capped via `history_limit`.
    ///
    /// NB: history is **owned by the front-end**. The backend never appends to
    /// it during `execute`; it only round-trips whatever the front-end sends
    /// via `api_save_node`. See the comment on `ApiStore::execute` for why the
    /// previous backend-side `append_history` was removed (it matched nodes by
    /// URL+method, so two requests sharing a URL got each other's history, and
    /// the front-end's next save silently rolled the append back).
    #[serde(default)]
    pub history: Vec<ApiResponse>,

    // ── Per-request transport options ───────────────────────────
    /// Total request timeout in seconds. `None` falls back to
    /// `DEFAULT_TIMEOUT_SECS`. A hung endpoint used to wedge the UI forever
    /// because reqwest has no default timeout at all.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_secs: Option<u64>,
    /// Skip TLS certificate verification for this request only. Defaults to
    /// `false`: the previous build hard-coded `danger_accept_invalid_certs(true)`
    /// for *every* request, which silently exposed `Authorization` headers to
    /// any MITM.
    #[serde(default)]
    pub insecure_tls: bool,
    /// Follow 3xx redirects (up to 10 hops). Defaults to `true` via
    /// `default_true` so existing collections keep working.
    #[serde(default = "default_true")]
    pub follow_redirects: bool,
    /// Authentication helper. Expanded into an `Authorization` header at send
    /// time so the user doesn't have to hand-roll base64 for Basic auth.
    #[serde(default)]
    pub auth: ApiAuth,
}

/// Declarative auth config, expanded into a header at send time.
///
/// Modelled as a tagged enum rather than a bag of optional strings so an
/// invalid combination (e.g. bearer token *and* basic password) is
/// unrepresentable.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ApiAuth {
    /// No `Authorization` header added (any hand-written one still applies).
    #[default]
    None,
    Bearer {
        #[serde(default)]
        token: String,
    },
    Basic {
        #[serde(default)]
        username: String,
        #[serde(default)]
        password: String,
    },
    /// API key sent either as a header or a query parameter.
    ApiKey {
        #[serde(default)]
        key: String,
        #[serde(default)]
        value: String,
        /// "header" or "query".
        #[serde(default)]
        location: String,
    },
}

/// A single field in a form-data body (text or file).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct FormField {
    #[serde(default)]
    pub key: String,
    #[serde(default)]
    pub value: String,
    /// "text" or "file".
    #[serde(default, rename = "type")]
    pub field_type: String,
    /// File path (when field_type == "file").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
    /// File name override (optional).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_name: Option<String>,
}

/// Captured HTTP response, persisted under `ApiRequest::history`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiResponse {
    pub status: u16,
    pub status_text: String,
    /// Response headers as (name, value) pairs.
    #[serde(default)]
    pub headers: Vec<(String, String)>,
    /// Actual request headers sent (after env expansion + auto-added).
    #[serde(default)]
    pub request_headers: Vec<(String, String)>,
    /// Response body as UTF-8 text (truncated for large/binary payloads).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    pub duration_ms: u64,
    pub timestamp: i64,
    /// Error detail when the request failed (DNS, TLS, timeout, ...).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,

    /// Non-fatal problems detected while building or sending the request —
    /// e.g. a header whose name/value reqwest refused, or an env placeholder
    /// that had no value. These used to be swallowed entirely, producing the
    /// classic "I definitely set that header" bug report.
    #[serde(default)]
    pub warnings: Vec<String>,
    /// True when the body was detected as non-text (by `Content-Type` or by
    /// invalid UTF-8). The front-end renders a download/hex affordance instead
    /// of dumping mojibake into a `<pre>`.
    #[serde(default)]
    pub is_binary: bool,
    /// Size of the body actually received, in bytes, before truncation.
    /// `body.len()` is not a substitute: it reflects the truncated text.
    #[serde(default)]
    pub body_size: u64,
    /// True when `body` was cut short by the read cap.
    #[serde(default)]
    pub truncated: bool,
    /// Final URL after redirects, when it differs from the requested one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub final_url: Option<String>,
}

/// Named environment holding a flat set of `{{var}}` substitutions.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiEnvironment {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub vars: Vec<(String, String)>,
}

/// Persistence container for the API platform — serialized to a single
/// JSON file at `<storage_root>/api_collections.json`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ApiState {
    #[serde(default)]
    pub nodes: Vec<ApiNode>,
    #[serde(default)]
    pub envs: Vec<ApiEnvironment>,
    /// Currently active environment id (`None` = no env expansion).
    #[serde(default)]
    pub active_env_id: Option<String>,
}
