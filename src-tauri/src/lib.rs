mod clipboard;
mod models;
mod notes;

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

/// Look up geo/ASN info for an IP or domain via ip-api.com. When `target` is
/// None/empty the caller's own public IP is returned (ip-api.com/json/).
/// Runs on the backend so the WebView isn't blocked by CSP / net permissions.
#[tauri::command]
async fn ip_lookup(target: Option<String>) -> Result<serde_json::Value, String> {
    // Query ip-api.com (free, no key). ipapi.co returns 429/403 to packaged builds
    // which is why lookup broke after `build`. Empty target = caller's own public IP.
    let url = match target.as_deref().map(str::trim) {
        Some(t) if !t.is_empty() => {
            // Trim again after percent-encoding is skipped: ip-api rejects any
            // trailing whitespace/newline as "invalid query".
            format!("http://ip-api.com/json/{}", urlencoding_min(t.trim()))
        }
        _ => "http://ip-api.com/json/".to_string(),
    };
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .map_err(|e| format!("Client build failed: {}", e))?;
    let resp = client
        .get(&url)
        .header("User-Agent", "easy-copy/0.1")
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    let raw = resp
        .json::<serde_json::Value>()
        .await
        .map_err(|e| format!("Parse failed: {}", e))?;

    // ip-api.com signals errors via `status: "fail"` + `message`.
    if raw.get("status").and_then(|v| v.as_str()) == Some("fail") {
        let msg = raw.get("message").and_then(|v| v.as_str()).unwrap_or("lookup failed");
        return Err(format!("Lookup failed: {}", msg));
    }

    // Normalise ip-api fields to the shape the frontend (IpInfo) expects.
    let json = serde_json::json!({
        "ip": raw.get("query"),
        "city": raw.get("city"),
        "region": raw.get("regionName"),
        "country": raw.get("countryCode"),
        "country_name": raw.get("country"),
        "postal": raw.get("zip"),
        "latitude": raw.get("lat"),
        "longitude": raw.get("lon"),
        "timezone": raw.get("timezone"),
        "org": raw.get("org"),
        "asn": raw.get("as"),
    });
    Ok(json)
}

/// Minimal percent-encoding for the path segment of an IP/domain lookup.
/// Only encodes characters that would break the URL; keeps it dependency-free.
fn urlencoding_min(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'.' | b'-' | b'_' | b'~' | b':' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
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
    manager.set_config(config.clone());
    register_shortcuts(&app, &config);
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
    match app.get_webview_window("notes") {
        Some(w) => {
            let visible = w.is_visible().unwrap_or(false);
            let focused = w.is_focused().unwrap_or(false);
            if visible && focused {
                let _ = w.hide();
            } else {
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
            Ok(())
        }
        None => Err("notes window not found".to_string()),
    }
}

/// Toggle the tools window: show+focus if hidden, hide if currently visible+focused,
/// otherwise bring it to the front.
#[tauri::command]
fn open_tools_window(app: tauri::AppHandle) -> Result<(), String> {
    match app.get_webview_window("tools") {
        Some(w) => {
            let visible = w.is_visible().unwrap_or(false);
            let focused = w.is_focused().unwrap_or(false);
            if visible && focused {
                let _ = w.hide();
            } else {
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
            Ok(())
        }
        None => Err("tools window not found".to_string()),
    }
}

// ============================================================
// Proxy commands
// ============================================================

/// Proxy manager state with routing rules
struct ProxyState {
    running: std::sync::atomic::AtomicBool,
    default_target: std::sync::Mutex<String>,
    routes: std::sync::Mutex<Vec<crate::models::ProxyRoute>>,
    port: std::sync::atomic::AtomicU16,
    logs: std::sync::Mutex<Vec<crate::models::ProxyLog>>,
    shutdown_tx: std::sync::Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    /// Path to the config directory for persistence (JSON file).
    config_path: std::sync::Mutex<Option<std::path::PathBuf>>,
}

impl ProxyState {
    /// Path to the proxy config JSON file.
    fn config_file(&self) -> Option<std::path::PathBuf> {
        self.config_path
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
            .map(|d| d.join("proxy_config.json"))
    }

    /// Load proxy config from disk (routes + default_target).
    /// Starts silently with defaults on any error (missing file, corrupt JSON, ...).
    fn load_config(&self) {
        let path = match self.config_file() {
            Some(p) => p,
            None => return,
        };
        let json = match std::fs::read_to_string(&path) {
            Ok(j) => j,
            Err(_) => return,
        };
        #[derive(serde::Deserialize)]
        struct PersistedProxyConfig {
            default_target: String,
            routes: Vec<crate::models::ProxyRoute>,
        }
        if let Ok(cfg) = serde_json::from_str::<PersistedProxyConfig>(&json) {
            *self.default_target.lock().unwrap_or_else(|e| e.into_inner()) = cfg.default_target;
            *self.routes.lock().unwrap_or_else(|e| e.into_inner()) = cfg.routes;
        }
    }

    /// Save proxy config to disk (routes + default_target).
    fn save_config(&self) {
        let path = match self.config_file() {
            Some(p) => p,
            None => return,
        };
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        #[derive(serde::Serialize)]
        struct PersistedProxyConfig<'a> {
            default_target: &'a str,
            routes: &'a [crate::models::ProxyRoute],
        }
        let cfg = PersistedProxyConfig {
            default_target: &self.default_target.lock().unwrap_or_else(|e| e.into_inner()),
            routes: &self.routes.lock().unwrap_or_else(|e| e.into_inner()),
        };
        if let Ok(json) = serde_json::to_string_pretty(&cfg) {
            let _ = std::fs::write(path, json);
        }
    }
}

impl Default for ProxyState {
    fn default() -> Self {
        Self {
            running: std::sync::atomic::AtomicBool::new(false),
            default_target: std::sync::Mutex::new("http://localhost:8080".to_string()),
            routes: std::sync::Mutex::new(Vec::new()),
            port: std::sync::atomic::AtomicU16::new(10880),
            logs: std::sync::Mutex::new(Vec::new()),
            shutdown_tx: std::sync::Mutex::new(None),
            config_path: std::sync::Mutex::new(None),
        }
    }
}

/// Match request path against routing rules and return the appropriate target
fn match_route(path: &str, routes: &[crate::models::ProxyRoute]) -> (String, Option<String>) {
    for route in routes {
        if !route.enabled {
            continue;
        }
        // Prefix match like nginx location
        if path.starts_with(&route.path_prefix) {
            return (route.target.clone(), Some(route.id.clone()));
        }
    }
    (String::new(), None)
}

/// Start the HTTP proxy server on the given port with nginx-like routing
#[tauri::command]
fn start_proxy(
    state: tauri::State<'_, std::sync::Arc<ProxyState>>,
    port: u16,
) -> Result<(), String> {
    if state.running.load(std::sync::atomic::Ordering::Relaxed) {
        return Err("Proxy already running".to_string());
    }

    // Update the port so get_proxy_status reflects it
    state.port.store(port, std::sync::atomic::Ordering::Relaxed);

    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
    *state.shutdown_tx.lock().unwrap() = Some(tx);

    state.running.store(true, std::sync::atomic::Ordering::Relaxed);

    // Bind with std::net first (no tokio runtime dependency) so we can
    // return an error to the frontend immediately if the port is unavailable.
    let addr = std::net::SocketAddr::from(([0, 0, 0, 0], port));
    let std_listener = match std::net::TcpListener::bind(addr) {
        Ok(l) => l,
        Err(e) => {
            state.running.store(false, std::sync::atomic::Ordering::Relaxed);
            return Err(format!("Failed to bind to port {}: {}", port, e));
        }
    };
    // Required before converting to tokio::net::TcpListener
    std_listener.set_nonblocking(true).unwrap();

    let state_clone = state.inner().clone();
    std::thread::spawn(move || {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async move {
            use axum::{body::Body, extract::Request, http::StatusCode, response::Response, Router};
            use hyper_util::client::legacy::Client;
            use hyper_util::rt::TokioExecutor;
            use hyper_rustls::HttpsConnectorBuilder;
            use std::time::Instant;
            use uuid::Uuid;

            // Convert std listener to tokio listener inside this runtime's reactor
            let listener = match tokio::net::TcpListener::from_std(std_listener) {
                Ok(l) => l,
                Err(e) => {
                    state_clone.running.store(false, std::sync::atomic::Ordering::Relaxed);
                    *state_clone.shutdown_tx.lock().unwrap() = None;
                    eprintln!("Proxy listener conversion failed: {}", e);
                    return;
                }
            };

            // rustls 0.23 requires a process-level CryptoProvider to be installed
            // before any TLS operation. Both `ring` (via hyper-rustls) and
            // `aws-lc-rs` (via reqwest) features may be present, so we must pick
            // one explicitly. `install_default` is idempotent (ignores repeat calls).
            let _ = rustls::crypto::ring::default_provider().install_default();

            let https_connector = HttpsConnectorBuilder::new()
                .with_webpki_roots()
                .https_or_http()
                .enable_http1()
                .build();
            let client: Client<_, Body> =
                Client::builder(TokioExecutor::new()).build(https_connector);

            let handler_state = state_clone.clone();

            // Helper function to push a log entry with all collected details.
            fn push_log_with_details(
                status: u16,
                res_headers: Vec<(String, String)>,
                res_body: Option<String>,
                error: Option<String>,
                method: &str,
                url: &str,
                route_match: &Option<String>,
                start: &Instant,
                state: &std::sync::Arc<ProxyState>,
                req_headers: &Vec<(String, String)>,
                req_body: &Option<String>,
            ) {
                let mut logs = state.logs.lock().unwrap();
                logs.push(crate::models::ProxyLog {
                    id: Uuid::new_v4().to_string(),
                    timestamp: chrono::Utc::now().timestamp_millis(),
                    method: method.to_string(),
                    url: url.to_string(),
                    route_match: route_match.clone(),
                    status,
                    duration_ms: start.elapsed().as_millis() as u64,
                    request_headers: req_headers.clone(),
                    request_body: req_body.clone(),
                    response_headers: res_headers,
                    response_body: res_body,
                    error,
                });
                if logs.len() > 100 {
                    let excess = logs.len() - 100;
                    logs.drain(0..excess);
                }
            }

            let app = Router::new().fallback(move |req: Request| {
                let client = client.clone();
                let state = handler_state.clone();
                async move {
                    let method = req.method().to_string();
                    let uri = req.uri().to_string();
                    let path = req.uri().path().to_string();
                    let start = Instant::now();

                    // Collect request headers for logging.
                    let req_headers: Vec<(String, String)> = req
                        .headers()
                        .iter()
                        .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("<binary>").to_string()))
                        .collect();

                    // Collect request body (up to 64 KB) for logging, then reconstruct.
                    use http_body_util::BodyExt;
                    let (req_parts, req_body) = req.into_parts();
                    let req_body_bytes = BodyExt::collect(req_body)
                        .await
                        .map(|c| c.to_bytes())
                        .unwrap_or_default();
                    let req_body_str = if !req_body_bytes.is_empty() {
                        if req_body_bytes.len() <= 65536 {
                            String::from_utf8(req_body_bytes.to_vec()).ok()
                        } else {
                            String::from_utf8(req_body_bytes[..65536].to_vec())
                                .ok()
                                .map(|s| {
                                    format!(
                                        "{}... (truncated, {} bytes total)",
                                        s,
                                        req_body_bytes.len()
                                    )
                                })
                        }
                    } else {
                        None
                    };
                    let req = Request::from_parts(req_parts, Body::from(req_body_bytes));

                    // Route matching: first match specific prefixes, then use default
                    let (target, matched_route) = {
                        let routes = state.routes.lock().unwrap();
                        let default_target = state.default_target.lock().unwrap();
                        let (route_target, route_id) = match_route(&path, &routes);
                        if route_target.is_empty() {
                            (default_target.clone(), None)
                        } else {
                            (route_target, route_id)
                        }
                    };

                    // No matching route and no default target configured.
                    if target.trim().is_empty() {
                        push_log_with_details(502, vec![], None, None, &method, &uri, &matched_route, &start, &state, &req_headers, &req_body_str);
                        return Response::builder()
                            .status(StatusCode::BAD_GATEWAY)
                            .body(Body::from(
                                "No matching route and no default target configured",
                            ))
                            .unwrap();
                    }

                    // Normalize target: prepend http:// if the user omitted the scheme,
                    // otherwise the URI has no authority and the client fails to connect.
                    let target = if target.starts_with("http://") || target.starts_with("https://") {
                        target
                    } else {
                        format!("http://{}", target)
                    };
                    let target_url = format!("{}{}", target.trim_end_matches('/'), uri);

                    // Parse the target authority so we can rewrite the Host header.
                    let target_host = target_url
                        .parse::<axum::http::Uri>()
                        .ok()
                        .and_then(|u| u.authority().map(|a| a.as_str().to_string()));

                    let mut builder = Request::builder().method(req.method()).uri(&target_url);
                    for (key, value) in req.headers() {
                        // Skip hop-by-hop / framing headers: the body has been fully
                        // collected into a fixed Bytes buffer, so hyper must set the
                        // correct Content-Length (or chunked) itself. Keeping the
                        // original Transfer-Encoding/Content-Length makes the target
                        // server parse a non-chunked body as chunked -> empty response
                        // (especially for POST requests). #4
                        if key == axum::http::header::HOST
                            || key == axum::http::header::TRANSFER_ENCODING
                            || key == axum::http::header::CONTENT_LENGTH
                        {
                            continue;
                        }
                        builder = builder.header(key, value);
                    }
                    // Rewrite Host to the target's authority.
                    if let Some(host) = target_host.as_ref() {
                        builder = builder.header(axum::http::header::HOST, host);
                    }
                    let forwarded_req = match builder.body(req.into_body()) {
                        Ok(r) => r,
                        Err(e) => {
                            return Response::builder()
                                .status(StatusCode::BAD_REQUEST)
                                .body(Body::from(format!("Build request error: {}", e)))
                                .unwrap();
                        }
                    };

                    match client.request(forwarded_req).await {
                        Ok(res) => {
                            let status = res.status().as_u16();
                            let res_headers: Vec<(String, String)> = res
                                .headers()
                                .iter()
                                .map(|(k, v)| {
                                    (k.to_string(), v.to_str().unwrap_or("<binary>").to_string())
                                })
                                .collect();

                            // Collect response body (up to 256 KB) for logging.
                            let (mut res_parts, res_body) = res.into_parts();
                            let res_body_bytes = BodyExt::collect(res_body)
                                .await
                                .map(|c| c.to_bytes())
                                .unwrap_or_default();

                            // Strip hop-by-hop framing headers so hyper re-frames the
                            // fixed buffer correctly for the client. Otherwise a chunked
                            // upstream response is forwarded as "chunked" over a non-
                            // chunked body, and the client sees an empty/null body. #4
                            res_parts.headers.remove(axum::http::header::TRANSFER_ENCODING);
                            res_parts.headers.remove(axum::http::header::CONTENT_LENGTH);

                            let res_body_str = if !res_body_bytes.is_empty() {
                                if res_body_bytes.len() <= 262144 {
                                    String::from_utf8(res_body_bytes.to_vec()).ok()
                                } else {
                                    String::from_utf8(res_body_bytes[..262144].to_vec())
                                        .ok()
                                        .map(|s| {
                                            format!(
                                                "{}... (truncated, {} bytes total)",
                                                s,
                                                res_body_bytes.len()
                                            )
                                        })
                                }
                            } else {
                                None
                            };

                            push_log_with_details(
                                status, res_headers, res_body_str, None,
                                &method, &target_url, &matched_route, &start, &state,
                                &req_headers, &req_body_str,
                            );

                            let res = Response::from_parts(res_parts, Body::from(res_body_bytes));
                            res
                        }
                        Err(e) => {
                            push_log_with_details(
                                503, vec![], None, Some(e.to_string()),
                                &method, &target_url, &matched_route, &start, &state,
                                &req_headers, &req_body_str,
                            );
                            Response::builder()
                                .status(StatusCode::BAD_GATEWAY)
                                .body(Body::from(format!("Proxy error: {}", e)))
                                .unwrap()
                        }
                    }
                }
            });

            let _ = axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    rx.await.ok();
                })
                .await;

            // Cleanup after shutdown
            state_clone.running.store(false, std::sync::atomic::Ordering::Relaxed);
            *state_clone.shutdown_tx.lock().unwrap() = None;
        });
    });

    Ok(())
}

/// Stop the HTTP proxy server
#[tauri::command]
fn stop_proxy(state: tauri::State<'_, std::sync::Arc<ProxyState>>) -> Result<(), String> {
    if !state.running.load(std::sync::atomic::Ordering::Relaxed) {
        return Err("Proxy not running".to_string());
    }
    // Signal graceful shutdown to the axum server
    if let Some(tx) = state.shutdown_tx.lock().unwrap().take() {
        let _ = tx.send(());
    }
    state.running.store(false, std::sync::atomic::Ordering::Relaxed);
    Ok(())
}

/// Get proxy logs
#[tauri::command]
fn get_proxy_logs(
    state: tauri::State<'_, std::sync::Arc<ProxyState>>,
) -> Result<Vec<crate::models::ProxyLog>, String> {
    Ok(state.logs.lock().unwrap().clone())
}

/// Clear proxy logs
#[tauri::command]
fn clear_proxy_logs(state: tauri::State<'_, std::sync::Arc<ProxyState>>) -> Result<(), String> {
    state.logs.lock().unwrap().clear();
    Ok(())
}

/// Get proxy status with routing rules
#[tauri::command]
fn get_proxy_status(
    state: tauri::State<'_, std::sync::Arc<ProxyState>>,
) -> Result<crate::models::ProxyConfig, String> {
    Ok(crate::models::ProxyConfig {
        default_target: state.default_target.lock().unwrap().clone(),
        port: state.port.load(std::sync::atomic::Ordering::Relaxed),
        running: state.running.load(std::sync::atomic::Ordering::Relaxed),
        routes: state.routes.lock().unwrap().clone(),
    })
}

/// Update proxy default target
#[tauri::command]
fn set_proxy_default_target(
    state: tauri::State<'_, std::sync::Arc<ProxyState>>,
    target: String,
) -> Result<(), String> {
    *state.default_target.lock().unwrap() = target;
    state.save_config();
    Ok(())
}

/// Add or update a proxy route
#[tauri::command]
fn upsert_proxy_route(
    state: tauri::State<'_, std::sync::Arc<ProxyState>>,
    route: crate::models::ProxyRoute,
) -> Result<(), String> {
    let mut routes = state.routes.lock().unwrap();
    // Uniqueness check: no other route may share the same path_prefix.
    let prefix = route.path_prefix.trim();
    if prefix.is_empty() {
        return Err("Path prefix cannot be empty".to_string());
    }
    if let Some(conflict) = routes
        .iter()
        .find(|r| r.id != route.id && r.path_prefix.trim() == prefix)
    {
        return Err(format!(
            "Path prefix '{}' already used by another rule (→ {})",
            prefix, conflict.target
        ));
    }
    if let Some(existing) = routes.iter_mut().find(|r| r.id == route.id) {
        existing.path_prefix = route.path_prefix;
        existing.target = route.target;
        existing.enabled = route.enabled;
    } else {
        routes.push(route);
    }
    drop(routes);
    state.save_config();
    Ok(())
}

/// Delete a proxy route
#[tauri::command]
fn delete_proxy_route(
    state: tauri::State<'_, std::sync::Arc<ProxyState>>,
    route_id: String,
) -> Result<(), String> {
    let mut routes = state.routes.lock().unwrap();
    routes.retain(|r| r.id != route_id);
    drop(routes);
    state.save_config();
    Ok(())
}

/// Toggle a proxy route enabled status
#[tauri::command]
fn toggle_proxy_route(
    state: tauri::State<'_, std::sync::Arc<ProxyState>>,
    route_id: String,
) -> Result<(), String> {
    let mut routes = state.routes.lock().unwrap();
    if let Some(route) = routes.iter_mut().find(|r| r.id == route_id) {
        route.enabled = !route.enabled;
    }
    drop(routes);
    state.save_config();
    Ok(())
}

// ============================================================
// Screenshot commands
// ============================================================

/// Geometry of the monitor a capture came from, in physical pixels.
struct CaptureTarget {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

/// Primary monitor if the platform reports one, else the first enumerated.
fn pick_fallback_monitor() -> xcap::XCapResult<xcap::Monitor> {
    use xcap::Monitor;
    let monitors = Monitor::all()?;
    let primary = monitors.iter().find(|m| m.is_primary()).cloned();
    match primary.or_else(|| monitors.into_iter().next()) {
        Some(m) => Ok(m),
        None => Monitor::from_point(0, 0),
    }
}

/// Pick the monitor the mouse cursor is currently on and capture it.
///
/// Multi-monitor: previously this always grabbed `Monitor::all()[0]` (the primary
/// display), so triggering the shortcut on a secondary screen captured the wrong
/// desktop. We resolve the monitor under the cursor instead — what every
/// mainstream capture tool does — and fall back to primary when the cursor
/// position is unavailable.
fn capture_cursor_monitor(
    app: &tauri::AppHandle,
) -> Result<(image::RgbaImage, CaptureTarget), String> {
    use xcap::Monitor;

    let monitor = match app.cursor_position().ok() {
        Some(p) => Monitor::from_point(p.x as i32, p.y as i32)
            .or_else(|_| pick_fallback_monitor())
            .map_err(|e| format!("Failed to resolve monitor: {}", e))?,
        None => pick_fallback_monitor().map_err(|e| format!("Failed to resolve monitor: {}", e))?,
    };

    let target = CaptureTarget {
        x: monitor.x(),
        y: monitor.y(),
        width: monitor.width(),
        height: monitor.height(),
    };
    let image = monitor
        .capture_image()
        .map_err(|e| format!("Capture failed: {}", e))?;
    Ok((image, target))
}

/// Move the overlay window onto `target`'s monitor, then make it fullscreen.
///
/// `set_fullscreen` expands to whichever monitor the window currently sits on, so
/// without repositioning first the overlay would open on the primary display even
/// when the capture came from a secondary one.
fn place_overlay_on(w: &tauri::WebviewWindow, target: &CaptureTarget) {
    use tauri::{PhysicalPosition, PhysicalSize};
    // Leave fullscreen before moving: a fullscreen window ignores position changes.
    let _ = w.set_fullscreen(false);
    let _ = w.set_position(PhysicalPosition::new(target.x, target.y));
    let _ = w.set_size(PhysicalSize::new(target.width, target.height));
    let _ = w.set_fullscreen(true);
}

/// Capture the monitor under the cursor and save to a temp PNG, then open the
/// screenshot overlay on that same monitor.
async fn capture_and_show(app: tauri::AppHandle) -> Result<(), String> {
    use image::ImageFormat;

    // Hide our own windows so they are not captured in the screenshot, then give
    // the compositor a moment to actually repaint before grabbing the frame.
    for label in ["main", "notes", "tools", "screenshot"] {
        if let Some(w) = app.get_webview_window(label) {
            let _ = w.hide();
        }
    }
    tokio::time::sleep(std::time::Duration::from_millis(80)).await;

    // Capture whichever monitor the cursor is on (not blindly the primary).
    let (image, target) = capture_cursor_monitor(&app)?;

    let temp_dir = std::env::temp_dir().join("easy-copy-screenshots");
    let _ = std::fs::create_dir_all(&temp_dir);
    let filename = format!("screenshot_{}.png", chrono::Local::now().format("%Y%m%d_%H%M%S"));
    let path = temp_dir.join(&filename);
    image.save_with_format(&path, ImageFormat::Png).map_err(|e| format!("Save failed: {}", e))?;

    // Read the PNG back and encode as a data URL so the WebView <img> can load it
    // directly (Tauri v2 blocks raw file:// access without asset protocol config).
    let bytes = std::fs::read(&path).map_err(|e| format!("Read failed: {}", e))?;
    let b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &bytes);
    let data_url = format!("data:image/png;base64,{}", b64);

    // Open screenshot window as a borderless fullscreen overlay on the captured
    // monitor, so on-screen pixels line up 1:1 with the image.
    if let Some(w) = app.get_webview_window("screenshot") {
        w.emit("screenshot-captured", data_url)
            .map_err(|e| format!("Emit failed: {}", e))?;
        place_overlay_on(&w, &target);
        let _ = w.set_always_on_top(true);
        let _ = w.show();
        let _ = w.set_focus();
    }
    Ok(())
}

#[tauri::command]
async fn trigger_screenshot(app: tauri::AppHandle) -> Result<(), String> {
    // Delegate to the shared capture routine so the button and the global
    // shortcut / tray produce identical behaviour (data URL, region select, etc.).
    capture_and_show(app).await
}

#[tauri::command]
async fn capture_screenshot(app: tauri::AppHandle) -> Result<String, String> {
    use image::ImageFormat;

    // Same monitor-under-cursor rule as the overlay path.
    let (image, _target) = capture_cursor_monitor(&app)?;

    let temp_dir = std::env::temp_dir().join("easy-copy-screenshots");
    let _ = std::fs::create_dir_all(&temp_dir);
    let filename = format!("screenshot_{}.png", chrono::Local::now().format("%Y%m%d_%H%M%S"));
    let path = temp_dir.join(&filename);
    image.save_with_format(&path, ImageFormat::Png).map_err(|e| format!("Save failed: {}", e))?;

    let path_str = path.to_string_lossy().to_string();

    if let Some(w) = app.get_webview_window("screenshot") {
        let _ = w.emit("screenshot-captured", &path_str);
        let _ = w.show();
        let _ = w.set_focus();
    }
    Ok(path_str)
}

#[tauri::command]
async fn save_screenshot(data_url: String) -> Result<String, String> {

    // Strip data URL prefix: "data:image/png;base64,"
    let b64 = if data_url.starts_with("data:image") {
        data_url.split(",").nth(1).unwrap_or(&data_url)
    } else {
        &data_url
    };
    let bytes = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, b64)
        .map_err(|e| format!("Base64 decode failed: {}", e))?;

    let docs = dirs_next().ok_or("Cannot determine documents directory")?;
    let dir = docs.join("Easy-Copy Screenshots");
    let _ = std::fs::create_dir_all(&dir);
    let filename = format!("screenshot_{}.png", chrono::Local::now().format("%Y%m%d_%H%M%S"));
    let path = dir.join(&filename);
    std::fs::write(&path, &bytes).map_err(|e| format!("Write failed: {}", e))?;

    Ok(path.to_string_lossy().to_string())
}

fn dirs_next() -> Option<std::path::PathBuf> {
    std::path::PathBuf::from(std::env::var("USERPROFILE").ok()?).join("Documents").into()
}

#[tauri::command]
async fn copy_image_to_clipboard(data_url: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || copy_image_to_clipboard_inner(data_url))
        .await
        .map_err(|e| format!("copy task failed: {}", e))?
}

fn copy_image_to_clipboard_inner(data_url: String) -> Result<(), String> {
    let _guard = crate::clipboard::CLIPBOARD_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let b64 = if data_url.starts_with("data:image") {
        data_url.split(",").nth(1).unwrap_or(&data_url)
    } else {
        &data_url
    };
    let bytes = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, b64)
        .map_err(|e| format!("Base64 decode failed: {}", e))?;

    let img = image::load_from_memory(&bytes).map_err(|e| format!("Image load failed: {}", e))?;
    let rgba = img.to_rgba8();
    let (w, h) = rgba.dimensions();

    let mut clipboard = crate::clipboard::open_clipboard_retry()?;
    let img_data = arboard::ImageData {
        width: w as usize,
        height: h as usize,
        bytes: std::borrow::Cow::Borrowed(rgba.as_raw()),
    };
    clipboard.set_image(img_data).map_err(|e| format!("Clipboard write failed: {}", e))
}

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

/// (Re)register both global shortcuts based on current config. Unregisters all
/// previously registered shortcuts first so `set_config` can rebind on the fly.
fn register_shortcuts(app: &tauri::AppHandle, cfg: &AppConfig) {
    let _ = app.global_shortcut().unregister_all();
    match cfg.clipboard_shortcut.parse::<Shortcut>() {
        Ok(sc) => {
            if let Err(e) = app.global_shortcut().on_shortcut(sc, |app, _sc, event| {
                if event.state == ShortcutState::Pressed {
                    if let Some(w) = app.get_webview_window("main") {
                        toggle_window(&w);
                    }
                }
            }) {
                eprintln!("Warning: failed to register clipboard shortcut '{}': {}", cfg.clipboard_shortcut, e);
            }
        }
        Err(e) => eprintln!("Invalid clipboard shortcut '{}': {}", cfg.clipboard_shortcut, e),
    }
    match cfg.notes_shortcut.parse::<Shortcut>() {
        Ok(sc) => {
            if let Err(e) = app.global_shortcut().on_shortcut(sc, |app, _sc, event| {
                if event.state == ShortcutState::Pressed {
                    if let Some(w) = app.get_webview_window("notes") {
                        toggle_window(&w);
                    }
                }
            }) {
                eprintln!("Warning: failed to register notes shortcut '{}': {}", cfg.notes_shortcut, e);
            }
        }
        Err(e) => eprintln!("Invalid notes shortcut '{}': {}", cfg.notes_shortcut, e),
    }
    match cfg.tools_shortcut.parse::<Shortcut>() {
        Ok(sc) => {
            if let Err(e) = app.global_shortcut().on_shortcut(sc, |app, _sc, event| {
                if event.state == ShortcutState::Pressed {
                    if let Some(w) = app.get_webview_window("tools") {
                        toggle_window(&w);
                    }
                }
            }) {
                eprintln!("Warning: failed to register tools shortcut '{}': {}", cfg.tools_shortcut, e);
            }
        }
        Err(e) => eprintln!("Invalid tools shortcut '{}': {}", cfg.tools_shortcut, e),
    }
    match cfg.screenshot_shortcut.parse::<Shortcut>() {
        Ok(sc) => {
            if let Err(e) = app.global_shortcut().on_shortcut(sc, |app, _sc, event| {
                if event.state == ShortcutState::Pressed {
                    // Capture screenshot then open the screenshot window
                    let app2 = app.clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = capture_and_show(app2).await;
                    });
                }
            }) {
                eprintln!("Warning: failed to register screenshot shortcut '{}': {}", cfg.screenshot_shortcut, e);
            }
        }
        Err(e) => eprintln!("Invalid screenshot shortcut '{}': {}", cfg.screenshot_shortcut, e),
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
        .setup(|app| {
            let app_handle = app.handle().clone();

            // --- System Tray ---
            let show_item = MenuItem::with_id(app, "show", "Show Clipboard", true, None::<&str>)?;
            let show_notes_item = MenuItem::with_id(app, "show_notes", "Show Notes", true, None::<&str>)?;
            let show_tools_item = MenuItem::with_id(app, "show_tools", "Show Tools", true, None::<&str>)?;
            let show_screenshot_item = MenuItem::with_id(app, "show_screenshot", "Take Screenshot", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
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

            // --- Clipboard Manager with persistence ---
            let data_dir = app.path().app_data_dir().ok();
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
            register_shortcuts(app.handle(), &cfg);

            // --- Restore window position & size from disk (with sanity checks) ---
            // Skip Windows minimized sentinel coords (-32000) and tiny corrupt sizes,
            // otherwise the window becomes invisible/off-screen on next launch.
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
            ClipboardManager::start_monitoring(app_handle, manager);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_history,
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
            get_proxy_status,
            set_proxy_default_target,
            upsert_proxy_route,
            delete_proxy_route,
            toggle_proxy_route,
            start_proxy,
            stop_proxy,
            get_proxy_logs,
            clear_proxy_logs,
            capture_screenshot,
            trigger_screenshot,
            save_screenshot,
            copy_image_to_clipboard
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
                            if let Some(dir) = app_handle.path().app_data_dir().ok() {
                                let _ = std::fs::write(dir.join("window_state.json"), state.to_string());
                            }
                        }
                    }
                }
            }
        }
    });
}
