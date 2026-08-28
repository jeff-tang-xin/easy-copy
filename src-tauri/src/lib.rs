// Allow Tauri's #[command] macro to infer Result<T, String> for sync commands
// across the crate (api.rs especially). Stops the `dependency_on_unit_never_type_fallback`
// lint, which Rust 2024 will turn into a hard error in a future release.
#![allow(dependency_on_unit_never_type_fallback)]

mod clipboard;
mod models;
mod notes;
mod api;
mod proxy;
mod process;
mod screenshot;

use crate::api::*;
use crate::process::{list_processes, list_ports, kill_process};
use crate::proxy::{
    start_proxy, stop_proxy, get_proxy_logs, clear_proxy_logs,
    get_proxy_status, set_proxy_default_target, upsert_proxy_route,
    delete_proxy_route, toggle_proxy_route, urlencoding_min,
};
use crate::screenshot::{
    capture_screenshot, trigger_screenshot, save_screenshot,
    copy_image_to_clipboard, capture_and_show,
};

use std::path::PathBuf;
use std::sync::Arc;

use clipboard::ClipboardManager;
use models::{AppConfig, NoteInput};
use notes::NoteManager;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use tauri_plugin_autostart::MacosLauncher;

#[tauri::command]
fn get_history(manager: tauri::State<'_, Arc<ClipboardManager>>) -> Vec<models::ClipboardItem> {
    manager.get_items()
}

/// Return history items, stats, and image data in a single IPC call.
///
/// Replaces the old N+1 pattern (one `get_history` + `get_stats` +
/// N `get_image_data`) with one round-trip. The front-end's
/// `useClipboard.refresh()` uses this to cut IPC overhead on
/// every clipboard-update event.
#[tauri::command]
fn get_history_full(
    manager: tauri::State<'_, Arc<ClipboardManager>>,
) -> models::HistoryFull {
    manager.get_history_full()
}

#[tauri::command]
fn search_history(
    query: String,
    manager: tauri::State<'_, Arc<ClipboardManager>>,
) -> Vec<models::ClipboardItem> {
    manager.search(&query)
}

#[tauri::command]
fn copy_to_clipboard(
    id: String,
    manager: tauri::State<'_, Arc<ClipboardManager>>,
) -> Result<String, String> {
    manager.copy_to_clipboard(&id)
}

#[tauri::command]
fn delete_item(id: String, manager: tauri::State<'_, Arc<ClipboardManager>>) {
    manager.delete_item(&id);
}

#[tauri::command]
fn toggle_favorite(id: String, manager: tauri::State<'_, Arc<ClipboardManager>>) {
    manager.toggle_favorite(&id);
}

#[tauri::command]
fn get_favorites(manager: tauri::State<'_, Arc<ClipboardManager>>) -> Vec<models::ClipboardItem> {
    manager.get_favorites()
}

#[tauri::command]
fn add_tag(id: String, tag: String, manager: tauri::State<'_, Arc<ClipboardManager>>) {
    manager.add_tag(&id, &tag);
}

#[tauri::command]
fn remove_tag(id: String, tag: String, manager: tauri::State<'_, Arc<ClipboardManager>>) {
    manager.remove_tag(&id, &tag);
}

#[tauri::command]
fn get_all_tags(manager: tauri::State<'_, Arc<ClipboardManager>>) -> Vec<String> {
    manager.get_all_tags()
}

#[tauri::command]
fn clear_history(manager: tauri::State<'_, Arc<ClipboardManager>>) {
    manager.clear();
}

#[tauri::command]
fn restore_item(item: models::ClipboardItem, manager: tauri::State<'_, Arc<ClipboardManager>>) {
    manager.restore_item(item);
}

#[tauri::command]
fn get_stats(manager: tauri::State<'_, Arc<ClipboardManager>>) -> (usize, u64) {
    manager.get_stats()
}

#[tauri::command]
fn get_image_data(
    id: String,
    manager: tauri::State<'_, Arc<ClipboardManager>>,
) -> Option<String> {
    manager.get_image_data(&id)
}

/// Open a file or folder using explorer.exe (Windows).
#[tauri::command]
fn open_file(path: String) -> Result<(), String> {
    use std::process::Command;
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("Empty path".to_string());
    }
    if !std::path::Path::new(trimmed).exists() {
        return Err(format!("Path not found: {}", trimmed));
    }
    Command::new("explorer.exe")
        .arg(trimmed)
        .spawn()
        .map_err(|e| format!("Failed to open: {}", e))?;
    Ok(())
}

/// Open a URL in the system default browser via the opener plugin.
#[tauri::command]
fn open_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Err("Empty url".to_string());
    }
    // Only allow http/https to avoid launching arbitrary protocols.
    let lower = trimmed.to_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return Err("Only http/https URLs are allowed".to_string());
    }
    // Use the opener plugin so query strings are handled correctly (no explorer.exe path parsing).
    app.opener()
        .open_url(trimmed, None::<&str>)
        .map_err(|e| format!("Failed to open url: {}", e))?;
    Ok(())
}

/// Why a provider lookup failed.
///
/// The distinction drives the fallback decision: retrying a second provider
/// only helps for transport-level trouble. A rejected *query* (bad IP, unknown
/// domain) will be rejected by every provider identically, so retrying just
/// doubles the user's wait — up to 16s with two 8s timeouts — before showing
/// the same message.
#[derive(Debug)]
enum LookupError {
    /// The query itself is bad; the answer won't change elsewhere.
    Invalid(String),
    /// Network error, timeout, 5xx, or rate limit — worth another provider.
    Transport(String),
}

impl LookupError {
    fn message(self) -> String {
        match self {
            LookupError::Invalid(m) | LookupError::Transport(m) => m,
        }
    }
}

/// Look up geo/ASN info for an IP or domain. When `target` is None/empty the
/// caller's own public IP is returned.
/// Runs on the backend so the WebView isn't blocked by CSP / net permissions.
/// Tries ipwho.is first, then freeipapi.com — both free over HTTPS, no key.
#[tauri::command]
async fn ip_lookup(target: Option<String>) -> Result<serde_json::Value, String> {
    // Trim once here so both providers get an identical, whitespace-free query:
    // a trailing newline makes every geo API report "invalid query".
    let query = target.as_deref().map(str::trim).unwrap_or("").to_string();

    // Provider order matters. We deliberately do NOT use ip-api.com any more:
    // its free endpoint is HTTP-only and answers HTTPS requests with
    // `SSL unavailable for this endpoint, order a key at ...`, which is what
    // broke this command. Downgrading to plaintext http:// would "fix" the
    // error by leaking the user's own public IP over the wire — unacceptable
    // for a privacy tool, so we switched to providers that speak HTTPS for
    // free instead.
    let primary = match ip_lookup_ipwhois(&query).await {
        Ok(v) => return Ok(v),
        // A bad query short-circuits: no point asking the backup the same thing.
        Err(LookupError::Invalid(m)) => return Err(m),
        Err(e) => e,
    };
    // Transport failure — try the backup before giving up, since these free
    // services rate-limit aggressively and one 429 shouldn't break the tool.
    match ip_lookup_freeipapi(&query).await {
        Ok(v) => Ok(v),
        // Surface both causes: blaming only the primary hides "the backup is
        // down too", which is exactly what you need when debugging offline.
        Err(backup) => Err(format!(
            "{} (backup provider also failed: {})",
            primary.message(),
            backup.message()
        )),
    }
}

/// Shared HTTP client for geo lookups.
///
/// Built once and reused: a per-call `Client` throws away the connection pool
/// and the TLS session cache, so every lookup would pay a fresh handshake
/// (and the fallback path would pay it twice).
static IP_HTTP: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();

fn ip_http() -> &'static reqwest::Client {
    IP_HTTP.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(8))
            .build()
            // Falls back to the default client: builder() only fails on a
            // broken TLS backend, where a per-call build would fail too.
            .unwrap_or_default()
    })
}

/// Shared HTTP GET + JSON decode for the geo providers.
///
/// Checks the status code before decoding: without this an HTML error page or
/// a 429 body would be fed to the JSON parser and surface as a confusing
/// "Parse failed: expected value" instead of the real cause.
async fn ip_fetch_json(url: &str) -> Result<serde_json::Value, LookupError> {
    let resp = ip_http()
        .get(url)
        .header("User-Agent", "easy-copy/0.1")
        .send()
        .await
        .map_err(|e| LookupError::Transport(format!("Request failed: {}", e)))?;
    let status = resp.status();
    if !status.is_success() {
        let msg = format!("Lookup failed: HTTP {}", status.as_u16());
        // 4xx (other than 429) means the provider rejected this query, so the
        // backup would reject it too; everything else is worth a retry.
        return Err(if status.is_client_error() && status.as_u16() != 429 {
            LookupError::Invalid(msg)
        } else {
            LookupError::Transport(msg)
        });
    }
    resp.json::<serde_json::Value>()
        .await
        .map_err(|e| LookupError::Transport(format!("Parse failed: {}", e)))
}

/// Primary provider: ipwho.is — free, HTTPS, no API key, and returns ASN/org.
async fn ip_lookup_ipwhois(query: &str) -> Result<serde_json::Value, LookupError> {
    let url = if query.is_empty() {
        "https://ipwho.is/".to_string()
    } else {
        format!("https://ipwho.is/{}", urlencoding_min(query))
    };
    let raw = ip_fetch_json(&url).await?;

    // ipwho.is signals errors via `success: false` + `message`. Note this comes
    // back with HTTP 200 even for a bogus query (verified: `/notanip` →
    // 200 + {"success":false,"message":"404 not found"}), so the status check
    // alone can't catch it.
    if raw.get("success").and_then(serde_json::Value::as_bool) == Some(false) {
        let msg = raw
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("lookup failed");
        // Query-level rejection: the backup provider would say the same.
        return Err(LookupError::Invalid(format!("Lookup failed: {}", msg)));
    }

    // ASN arrives as a bare number (15169); prefix it so the UI shows "AS15169".
    let asn = raw
        .get("connection")
        .and_then(|c| c.get("asn"))
        .and_then(serde_json::Value::as_i64)
        .map(|n| format!("AS{}", n));

    // Normalise to the shape the frontend (IpInfo) expects.
    Ok(serde_json::json!({
        "ip": raw.get("ip"),
        "city": raw.get("city"),
        "region": raw.get("region"),
        "country": raw.get("country_code"),
        "country_name": raw.get("country"),
        "postal": raw.get("postal"),
        "latitude": raw.get("latitude"),
        "longitude": raw.get("longitude"),
        "timezone": raw.get("timezone").and_then(|t| t.get("id")),
        "org": raw.get("connection").and_then(|c| c.get("org")),
        "asn": asn,
    }))
}

/// Backup provider: freeipapi.com — also free HTTPS without a key, but uses
/// camelCase field names and has no `success` flag, so it needs its own mapper.
async fn ip_lookup_freeipapi(query: &str) -> Result<serde_json::Value, LookupError> {
    let url = if query.is_empty() {
        "https://freeipapi.com/api/json".to_string()
    } else {
        format!("https://freeipapi.com/api/json/{}", urlencoding_min(query))
    };
    let raw = ip_fetch_json(&url).await?;

    // No explicit error flag: a response without an address means "no data".
    let ip = raw.get("ipAddress").and_then(|v| v.as_str()).unwrap_or("");
    if ip.is_empty() {
        return Err(LookupError::Invalid("Lookup failed: no data".to_string()));
    }

    // `timeZones` is an array; the first entry is the primary zone.
    let timezone = raw
        .get("timeZones")
        .and_then(|v| v.as_array())
        .and_then(|a| a.first())
        .cloned();
    let asn = raw
        .get("asn")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| format!("AS{}", s));

    Ok(serde_json::json!({
        "ip": raw.get("ipAddress"),
        "city": raw.get("cityName"),
        "region": raw.get("regionName"),
        "country": raw.get("countryCode"),
        "country_name": raw.get("countryName"),
        "postal": raw.get("zipCode"),
        "latitude": raw.get("latitude"),
        "longitude": raw.get("longitude"),
        "timezone": timezone,
        "org": raw.get("asnOrganization"),
        "asn": asn,
    }))
}

#[tauri::command]
fn set_incognito(enabled: bool, manager: tauri::State<'_, Arc<ClipboardManager>>) {
    manager.set_incognito(enabled);
}

#[tauri::command]
fn is_incognito(manager: tauri::State<'_, Arc<ClipboardManager>>) -> bool {
    manager.is_incognito()
}

#[tauri::command]
fn get_config(manager: tauri::State<'_, Arc<ClipboardManager>>) -> AppConfig {
    manager.get_config()
}

#[tauri::command]
fn set_config(
    config: AppConfig,
    app: tauri::AppHandle,
    manager: tauri::State<'_, Arc<ClipboardManager>>,
) {
    // If `storage_root` changed, the new path won't be honoured by managers
    // that captured `data_dir` at construction time. Invalidate the cache and
    // push the new path to every persistent store so the change is live.
    if config.storage_root != manager.get_config().storage_root {
        let new_path = config
            .storage_root
            .clone()
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| {
                app.path()
                    .app_data_dir()
                    .unwrap_or_else(|_| std::env::temp_dir().join("easy-copy"))
            });
        let _ = std::fs::create_dir_all(&new_path);
        invalidate_data_dir_cache();
        apply_data_dir(&app, new_path);
    }
    manager.set_config(config.clone());
    register_shortcuts(app.clone(), config);
}

#[tauri::command]
fn export_history(manager: tauri::State<'_, Arc<ClipboardManager>>) -> Result<String, String> {
    manager.export_history()
}

#[tauri::command]
fn import_history(json: String, manager: tauri::State<'_, Arc<ClipboardManager>>) -> Result<usize, String> {
    manager.import_history(&json)
}

// ============================================================
// Notes commands
// ============================================================

#[tauri::command]
fn list_notes(manager: tauri::State<'_, Arc<NoteManager>>) -> Vec<models::Note> {
    manager.list()
}

#[tauri::command]
fn create_note(
    input: NoteInput,
    manager: tauri::State<'_, Arc<NoteManager>>,
) -> models::Note {
    manager.create(input, None)
}

#[tauri::command]
fn update_note(
    id: String,
    input: NoteInput,
    manager: tauri::State<'_, Arc<NoteManager>>,
) -> Option<models::Note> {
    manager.update(&id, input)
}

#[tauri::command]
fn delete_note(
    id: String,
    manager: tauri::State<'_, Arc<NoteManager>>,
    clip_manager: tauri::State<'_, Arc<ClipboardManager>>,
) {
    if let Some(note) = manager.get(&id) {
        if let Some(clip_id) = note.source_clip_id {
            clip_manager.set_saved_as_note(&clip_id, false);
        }
    }
    manager.delete(&id);
}

#[tauri::command]
fn toggle_note_pin(id: String, manager: tauri::State<'_, Arc<NoteManager>>) {
    manager.toggle_pin(&id);
}

#[tauri::command]
fn list_note_categories(manager: tauri::State<'_, Arc<NoteManager>>) -> Vec<String> {
    manager.list_categories()
}

#[tauri::command]
fn rename_note_category(
    from: String,
    to: String,
    manager: tauri::State<'_, Arc<NoteManager>>,
) -> usize {
    manager.rename_category(&from, &to)
}

#[tauri::command]
fn delete_note_category(
    name: String,
    manager: tauri::State<'_, Arc<NoteManager>>,
) -> usize {
    manager.delete_category(&name)
}

/// Turn a clipboard item into a note. Text / Image / Files all supported.
/// - Text: content used as-is; first line as title.
/// - Image: embedded as Markdown image via data URL; title = `[Image] <time>`.
/// - Files: content becomes a Markdown bullet list; title = `[Files]`.
#[tauri::command]
fn create_note_from_clip(
    clip_id: String,
    clip_manager: tauri::State<'_, Arc<ClipboardManager>>,
    note_manager: tauri::State<'_, Arc<NoteManager>>,
) -> Result<models::Note, String> {
    let item = clip_manager
        .get_items()
        .into_iter()
        .find(|i| i.id == clip_id)
        .ok_or_else(|| "Clipboard item not found".to_string())?;
    if item.saved_as_note {
        return Err("Already saved as note".to_string());
    }
    let (title, content) = match item.item_type {
        models::ItemType::Image => {
            let data_url = clip_manager
                .get_image_data(&clip_id)
                .ok_or_else(|| "Image data not found".to_string())?;
            let ts = chrono::DateTime::from_timestamp_millis(item.timestamp)
                    .map(|dt| dt.format("%Y-%m-%d %H:%M").to_string())
                    .unwrap_or_default();
            (
                format!("[Clip] [Image] {}", ts),
                format!("![clipboard image]({})\n", data_url),
            )
        }
        models::ItemType::Files => {
            let files: Vec<String> = item
                .content
                .lines()
                .filter(|l| !l.trim().is_empty())
                .map(|l| format!("- {}", l))
                .collect();
            ("[Clip] [Files]".to_string(), files.join("\n"))
        }
        models::ItemType::Text => {
            let t = item
                .content
                .lines()
                .next()
                .unwrap_or("Untitled")
                .chars()
                .take(60)
                .collect::<String>();
            let t = if t.trim().is_empty() {
                "Untitled".to_string()
            } else {
                t
            };
            (format!("[Clip] {}", t), item.content.clone())
        }
    };
    let input = NoteInput {
        title,
        content,
        tags: vec!["clipboard".to_string()],
        category: None,
    };
    let note = note_manager.create(input, Some(clip_id.clone()));
    clip_manager.set_saved_as_note(&clip_id, true);
    Ok(note)
}

/// Render a note's HTML in the system default browser.
/// Writes the HTML to a temp file and opens it via the opener plugin.
#[tauri::command]
fn open_note_preview(html: String, app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let temp = std::env::temp_dir().join("easy-copy-note-preview.html");
    std::fs::write(&temp, &html).map_err(|e| format!("Write failed: {}", e))?;
    app.opener()
        .open_path(temp.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| format!("Open failed: {}", e))
}

/// Toggle the notes window: show+focus if hidden, hide if currently visible+focused,
/// otherwise bring it to the front. Called from the clipboard UI and the tray.
#[tauri::command]
fn open_notes_window(app: tauri::AppHandle) -> Result<(), String> {
    toggle_window_by_label(&app, "notes")
}

/// Toggle the tools window: show+focus if hidden, hide if currently visible+focused,
/// otherwise bring it to the front.
#[tauri::command]
fn open_tools_window(app: tauri::AppHandle) -> Result<(), String> {
    toggle_window_by_label(&app, "tools")
}

/// Toggle the api window: show+focus if hidden, hide if currently visible+focused,
/// otherwise bring it to the front.
#[tauri::command]
fn open_api_window(app: tauri::AppHandle) -> Result<(), String> {
    toggle_window_by_label(&app, "api")
}

/// Toggle any window by its WebviewWindow label. Mirrors the inline
/// `toggle_window` logic for the named child windows so each
/// `open_*_window` command is a one-liner. Used to be duplicated 3x.
fn toggle_window_by_label(app: &tauri::AppHandle, label: &str) -> Result<(), String> {
    match app.get_webview_window(label) {
        Some(w) => {
            toggle_window(&w);
            Ok(())
        }
        None => Err(format!("{} window not found", label)),
    }
}

/// Native folder picker for the "Storage Location" setting.
#[tauri::command]
fn select_folder() -> Result<Option<String>, String> {
    match rfd::FileDialog::new().set_title("Select Storage Folder").pick_folder() {
        Some(path) => Ok(Some(path.to_string_lossy().into_owned())),
        None => Ok(None),
    }
}

/// Native file picker used by the API platform for `form-data` file fields
/// and binary/msgpack bodies. Returns the absolute path or `None` if cancelled.
#[tauri::command]
fn select_file() -> Result<Option<String>, String> {
    match rfd::FileDialog::new().set_title("Select File").pick_file() {
        Some(path) => Ok(Some(path.to_string_lossy().into_owned())),
        None => Ok(None),
    }
}

// ============================================================
// Proxy commands
// ============================================================

// ProxyState, match_route, and all proxy commands live in `mod proxy` (proxy.rs).
// Re-exported here for backwards compatibility with code that references `crate::ProxyState`.
pub use crate::proxy::ProxyState;

// All proxy commands live in `mod proxy` (proxy.rs) and are registered via
// `proxy::start_proxy` etc. in the generate_handler! macro below.

/// Toggle the main window visibility.
fn toggle_window(window: &tauri::WebviewWindow) {
    let visible = window.is_visible().unwrap_or(false);
    let focused = window.is_focused().unwrap_or(false);
    if visible && focused {
        let _ = window.hide();
    } else {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

// ============================================================
// Shared cache for `effective_data_dir`.
//
// The cache is a single process-wide `Mutex<Option<PathBuf>>`,
// constructed lazily via `OnceLock`. It must be a *single* static —
// if `effective_data_dir` and `invalidate_data_dir_cache` each
// declared their own (the earlier, buggy version), invalidation
// would silently no-op because each function would touch its own
// independent static. We fix that by lifting the cache to the
// module scope and referencing it from both functions.
//
// The inner `Mutex<Option<PathBuf>>` is constructed exactly once
// and the lock is dropped after every read — we don't pay a lock
// cost on the hot path beyond an atomic + one uncontended lock.
// ============================================================
static DATA_DIR_CACHE: std::sync::OnceLock<std::sync::Mutex<Option<PathBuf>>> =
    std::sync::OnceLock::new();

/// Resolve the data directory the app should use, honoring the user's optional
/// `storage_root` override. Falls back to the standard Tauri-managed app data
/// dir when no override is set. Centralised here so every manager (clipboard,
/// notes, screenshots, tools, api) reads/writes the same location and a single
/// settings change re-points them all.
///
/// **Caching strategy**: the resolved path is cached in a process-wide
/// `Mutex<Option<PathBuf>>` so that `set_config` can invalidate the cache when
/// the user changes `storage_root` from the settings panel. A `OnceLock` (the
/// earlier, buggy design) would freeze the value at first read (which happens
/// in `setup`), making any settings change a no-op for the lifetime of the
/// process — the user would see "saved", but new writes still go to the old
/// path, silently losing data.
///
/// Invalidation rules:
///   - First call (cold start): reads `app_data_dir/config.json` and honours
///     `storage_root` if set, otherwise falls back to `app_data_dir`.
///   - `set_config` calls `invalidate_data_dir_cache`, which drops the cached
///     value. The next `effective_data_dir` call re-reads `config.json`.
///   - `set_config` *also* calls `apply_data_dir` to push the new path to
///     every manager that holds one (`ClipboardManager` / `NoteManager` /
///     `ProxyState` / `ApiStore`). This way the *next* operation (save
///     clipboard, list notes, …) hits the right directory even if no
///     `effective_data_dir` call happens between the settings change and the
///     next user action.
///
/// **Path-of-truth alignment**: this reads from `app_data_dir/config.json` —
/// the same location `ClipboardManager::set_config` writes to (clipboard.rs).
/// Tauri distinguishes `app_data_dir` (`%APPDATA%\<bundle id>` on Windows)
/// from `app_config_dir` (`%APPDATA%\<bundle id>\Config`); we deliberately
/// stay on `app_data_dir` because that's where the rest of the app's state
/// (history.json, notes/, screenshots/, proxy_config.json, …) already lives,
/// and it's the only place `storage_root` is round-trippable.
fn effective_data_dir(app: &tauri::AppHandle) -> PathBuf {
    let cache = DATA_DIR_CACHE.get_or_init(|| std::sync::Mutex::new(None));

    // Fast path: cache hit. We clone to release the lock before doing I/O.
    if let Some(p) = cache.lock().unwrap_or_else(|e| e.into_inner()).clone() {
        return p;
    }

    // Slow path: read `config.json` and resolve. On any read error, fall back
    // to `app_data_dir` so the app still has somewhere to write.
    let resolved = resolve_data_dir_locked(app);
    *cache.lock().unwrap_or_else(|e| e.into_inner()) = Some(resolved.clone());
    resolved
}

/// Invalidate the cached `effective_data_dir` so the next call re-reads
/// `config.json`. Called from `set_config` *before* re-resolving, so the
/// next `effective_data_dir` call observes the user's new `storage_root`.
///
/// Note: managers that captured the old `data_dir` at construction time
/// (`ClipboardManager::new`, `NoteManager::new`, `ProxyState::config_path`,
/// `ApiStore::new`) must be told the new path separately via `apply_data_dir`
/// — invalidating the cache alone doesn't reach them.
fn invalidate_data_dir_cache() {
    if let Some(c) = DATA_DIR_CACHE.get() {
        *c.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }
}

/// Push `path` into every manager that owns a `data_dir`. Mirrors the
/// fields constructed in `setup` so a `storage_root` change is observed
/// by all four persistent stores without restarting the app.
fn apply_data_dir(
    app: &tauri::AppHandle,
    path: std::path::PathBuf,
) {
    use tauri::Manager;
    if let Some(m) = app.try_state::<Arc<ClipboardManager>>() {
        m.set_data_dir(path.clone());
    }
    if let Some(m) = app.try_state::<Arc<NoteManager>>() {
        m.set_data_dir(path.clone());
    }
    if let Some(m) = app.try_state::<std::sync::Arc<ProxyState>>() {
        // Drop the `config_path` lock BEFORE calling `load_config` —
        // `load_config` itself takes `config_path.lock()` to compute the
        // file path. Holding it across the call would self-deadlock on
        // a non-reentrant `Mutex`. Take the lock, swap the value, drop it,
        // then re-read on the new path.
        {
            if let Ok(mut p) = m.config_path.lock() {
                *p = Some(path.clone());
            }
        }
        m.load_config();
    }
    if let Some(m) = app.try_state::<Arc<api::ApiStore>>() {
        m.set_data_dir(path);
    }
}

/// Read `config.json` and resolve the data directory. Pure helper used by
/// `effective_data_dir` so the slow path is testable in isolation.
fn resolve_data_dir_locked(app: &tauri::AppHandle) -> PathBuf {
    let fallback = || {
        app.path()
            .app_data_dir()
            .unwrap_or_else(|_| std::env::temp_dir().join("easy-copy"))
    };
    let candidate = fallback();
    if let Ok(json) = std::fs::read_to_string(candidate.join("config.json")) {
        if let Ok(cfg) = serde_json::from_str::<AppConfig>(&json) {
            if let Some(custom) = cfg.storage_root {
                let p = std::path::PathBuf::from(custom);
                let _ = std::fs::create_dir_all(&p);
                return p;
            }
        }
    }
    fallback()
}

/// (Re)register both global shortcuts based on current config. Unregisters all
/// previously registered shortcuts first so `set_config` can rebind on the fly.
///
/// On per-shortcut failure, the event `shortcut-error` is emitted to the
/// frontend so the user can see *why* their hotkey didn't take effect. The
/// previous behaviour was `eprintln!` (backend stderr only) — a user
/// changing a shortcut that the OS already had bound to another app
/// (Ctrl+Shift+V → Teams, etc.) used to see a no-op and a silent failure.
/// Now the owning window surfaces it as an error toast.
///
/// The `app` parameter is **owned** (not borrowed) because
/// `GlobalShortcut::on_shortcut` requires its callback to be `Fn + Send +
/// Sync + 'static`. Borrow-capturing `&AppHandle` into a `'static` closure
/// would never compile; cloning the cheap `AppHandle` (it's just an Arc-like
/// handle internally) into the closure sidesteps the lifetime issue
/// entirely. We also take `cfg: AppConfig` by value so the function owns
/// the data the closure references, again to keep everything `'static`.
fn register_shortcuts(app: tauri::AppHandle, cfg: AppConfig) {
    // Tear down all previously registered chords so `set_config` can rebind
    // on the fly. Done once up front so each per-shortcut `on_shortcut`
    // call doesn't race with a sibling unregister.
    let _ = app.global_shortcut().unregister_all();

    // `bind` is a free-standing helper (not a closure) so we don't have
    // to fight closure-capture lifetimes — we take `app: AppHandle` by
    // value and clone it into the handler closure. Each call is fully
    // self-contained; nothing escapes into the surrounding scope.
    fn bind(app: &tauri::AppHandle, label: &'static str, raw: &str) {
        let gs = app.global_shortcut();
        match raw.parse::<Shortcut>() {
            Ok(sc) => {
                let app_for_handler = app.clone();
                let result = gs.on_shortcut(sc, move |handler_app, _sc, event| {
                    if event.state == ShortcutState::Pressed {
                        match label {
                            "clipboard" => { if let Some(w) = handler_app.get_webview_window("main") { toggle_window(&w); } }
                            "notes"     => { if let Some(w) = handler_app.get_webview_window("notes") { toggle_window(&w); } }
                            "tools"     => { if let Some(w) = handler_app.get_webview_window("tools") { toggle_window(&w); } }
                            "api"       => { if let Some(w) = handler_app.get_webview_window("api")   { toggle_window(&w); } }
                            "screenshot" => {
                                let app2 = handler_app.clone();
                                tauri::async_runtime::spawn(async move {
                                    let _ = capture_and_show(app2).await;
                                });
                            }
                            _ => {}
                        }
                    }
                });
                if let Err(e) = result {
                    // The OS rejected the hotkey — likely already bound by
                    // another app. Tell the user instead of printing to a
                    // log file no one reads.
                    let _ = app.emit(
                        "shortcut-error",
                        format!("无法注册{}快捷键 {}：{}", label_chinese(label), raw, e),
                    );
                }
            }
            Err(e) => {
                // Bad chord string (e.g. "Ctrl+Foo" where Foo isn't a key).
                let _ = app.emit(
                    "shortcut-error",
                    format!("{}快捷键格式错误 {}：{}", label_chinese(label), raw, e),
                );
            }
        }
    }

    bind(&app, "clipboard",  &cfg.clipboard_shortcut);
    bind(&app, "notes",      &cfg.notes_shortcut);
    bind(&app, "tools",      &cfg.tools_shortcut);
    bind(&app, "screenshot", &cfg.screenshot_shortcut);
    bind(&app, "api",        &cfg.api_shortcut);
}

/// Map shortcut role → Chinese label for the error toast.
fn label_chinese(label: &str) -> &'static str {
    match label {
        "clipboard"  => "剪贴板",
        "notes"      => "笔记",
        "tools"      => "工具",
        "screenshot" => "截图",
        "api"        => "API",
        _            => "快捷键",
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        // Intercept window close requests: instead of destroying the window
        // (which makes `get_webview_window` return None forever), hide it so
        // the user can reopen it later. The main app stays alive via the tray.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // The main window has a tray icon; hide it instead of closing.
                // Child windows (notes/tools/api/screenshot) must also hide,
                // otherwise they get destroyed and cannot be reopened.
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .setup(|app| {
            let app_handle = app.handle().clone();

            // --- System Tray ---
            // All tray items use Chinese labels so the menu matches the rest
            // of the UI. The IDs stay English because they're internal keys
            // matched in the `on_menu_event` switch.
            let show_item = MenuItem::with_id(app, "show", "显示剪贴板", true, None::<&str>)?;
            let show_notes_item = MenuItem::with_id(app, "show_notes", "显示笔记", true, None::<&str>)?;
            let show_tools_item = MenuItem::with_id(app, "show_tools", "显示工具", true, None::<&str>)?;
            let show_screenshot_item = MenuItem::with_id(app, "show_screenshot", "截图", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &show_notes_item, &show_tools_item, &show_screenshot_item, &quit_item])?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Easy Copy - Clipboard Manager")
                .menu(&menu)
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            toggle_window(&window);
                        }
                    }
                    "show_notes" => {
                        if let Some(window) = app.get_webview_window("notes") {
                            toggle_window(&window);
                        }
                    }
                    "show_tools" => {
                        if let Some(window) = app.get_webview_window("tools") {
                            toggle_window(&window);
                        }
                    }
                    "show_screenshot" => {
                        let app2 = app.clone();
                        tauri::async_runtime::spawn(async move {
                            let _ = capture_and_show(app2).await;
                        });
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            toggle_window(&window);
                        }
                    }
                })
                .build(app)?;

            // --- Resolve the data directory once, honoring the user's optional
            //     `storage_root` override. Every manager below uses this single
            //     path so a settings change re-points all persistent state
            //     (clipboard history, notes, proxy config, window position,
            //     API collections) in one place. `effective_data_dir` is
            //     cached, so reading the same value here for each manager is
            //     free after the first hit.
            let data_dir = Some(effective_data_dir(&app_handle));

            // --- Clipboard Manager with persistence ---
            let manager = Arc::new(ClipboardManager::new(500, data_dir.clone()));
            manager.load_from_disk();
            manager.load_config();
            app.manage(manager.clone());

            // --- Note Manager with persistence ---
            let note_manager = Arc::new(NoteManager::new(data_dir.clone()));
            note_manager.load();
            app.manage(note_manager);

            // --- HTTP Proxy state with persistence ---
            let proxy_state = std::sync::Arc::new(ProxyState::default());
            *proxy_state.config_path.lock().unwrap_or_else(|e| e.into_inner()) = data_dir.clone();
            proxy_state.load_config();
            app.manage(proxy_state);

            // --- Global Shortcuts: register based on user config ---
            let cfg = manager.get_config();
            register_shortcuts(app.handle().clone(), cfg);

            // --- Restore window position & size from disk (with sanity checks) ---
            // Skip Windows minimized sentinel coords (-32000) and tiny corrupt sizes,
            // otherwise the window becomes invisible/off-screen on next launch.
            // Uses the same `data_dir` resolved above so window_state.json
            // sits next to the rest of the app's persistent state.
            if let Some(ref dir) = data_dir {
                if let Ok(json) = std::fs::read_to_string(dir.join("window_state.json")) {
                    if let Ok(state) = serde_json::from_str::<serde_json::Value>(&json) {
                        if let Some(window) = app.get_webview_window("main") {
                            if let (Some(x), Some(y)) = (state["x"].as_i64(), state["y"].as_i64()) {
                                if x > -30000 && y > -30000 {
                                    let _ = window.set_position(tauri::LogicalPosition::new(x as f64, y as f64));
                                }
                            }
                            if let (Some(w), Some(h)) = (state["width"].as_f64(), state["height"].as_f64()) {
                                if w >= 200.0 && h >= 200.0 {
                                    let _ = window.set_size(tauri::LogicalSize::new(w, h));
                                }
                            }
                        }
                    }
                }
            }

            // --- Start clipboard monitoring ---
            ClipboardManager::start_monitoring(app_handle.clone(), manager);

            // --- API store (Postman-like HTTP client) ---
            let api_store = Arc::new(api::ApiStore::new(Some(effective_data_dir(&app_handle))));
            api_store.load();
            app.manage(api_store);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_history,
            get_history_full,
            search_history,
            copy_to_clipboard,
            delete_item,
            toggle_favorite,
            get_favorites,
            clear_history,
            get_image_data,
            open_file,
            open_url,
            ip_lookup,
            add_tag,
            remove_tag,
            get_all_tags,
            restore_item,
            get_stats,
            set_incognito,
            is_incognito,
            get_config,
            set_config,
            export_history,
            import_history,
            list_notes,
            create_note,
            update_note,
            delete_note,
            toggle_note_pin,
            list_note_categories,
            rename_note_category,
            delete_note_category,
            create_note_from_clip,
            open_notes_window,
            open_note_preview,
            open_tools_window,
            open_api_window,
            get_proxy_status,
            set_proxy_default_target,
            upsert_proxy_route,
            delete_proxy_route,
            toggle_proxy_route,
            start_proxy,
            stop_proxy,
            get_proxy_logs,
            clear_proxy_logs,
            list_processes,
            list_ports,
            kill_process,
            capture_screenshot,
            trigger_screenshot,
            save_screenshot,
            copy_image_to_clipboard,
            api_load_state,
            api_save_node,
            api_delete_node,
            api_save_env,
            api_delete_env,
            api_set_active_env,
            api_execute,
            api_list_cookies,
            api_clear_cookies,
            select_folder,
            select_file
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            // Save clipboard data
            if let Some(manager) = app_handle.try_state::<Arc<ClipboardManager>>() {
                manager.save_to_disk();
            }
            // Save window position & size (skip minimized/hidden or corrupt values)
            if let Some(window) = app_handle.get_webview_window("main") {
                let is_minimized = window.is_minimized().unwrap_or(false);
                let is_visible = window.is_visible().unwrap_or(true);
                if !is_minimized && is_visible {
                    if let (Ok(pos), Ok(size)) = (window.outer_position(), window.outer_size()) {
                        if pos.x > -30000 && pos.y > -30000 && size.width >= 200 && size.height >= 200 {
                            let state = serde_json::json!({
                                "x": pos.x,
                                "y": pos.y,
                                "width": size.width as f64,
                                "height": size.height as f64
                            });
                            // Use the same `effective_data_dir` the rest of
                            // the app reads/writes, so window_state.json
                            // lives next to history.json / notes/ /
                            // proxy_config.json / … and honours the user's
                            // `storage_root` override.
                            let _ = std::fs::write(
                                effective_data_dir(&app_handle).join("window_state.json"),
                                state.to_string(),
                            );
                        }
                    }
                }
            }
        }
    });
}

