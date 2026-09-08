// HTTP proxy module — nginx-like routing with rule-based target selection,
// request/response logging, and an axum backend. Extracted from lib.rs so the
// main crate root stays focused on app assembly / tray / window management.

use crate::models::{ProxyConfig, ProxyLog, ProxyRoute};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::{Arc, Mutex};

// ── State ──────────────────────────────────────────────────────

/// Proxy manager state with routing rules.
///
/// Wrapped in `Arc<ProxyState>` at the Tauri state level (registered in
/// `setup`). Interior mutability via `Mutex` / `Atomic*` so command handlers
/// only need `tauri::State<'_, Arc<ProxyState>>` — no `&mut self`.
pub struct ProxyState {
    pub running: AtomicBool,
    pub default_target: Mutex<String>,
    pub routes: Mutex<Vec<ProxyRoute>>,
    pub port: AtomicU16,
    pub logs: Mutex<Vec<ProxyLog>>,
    pub shutdown_tx: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    /// Bind to `0.0.0.0` instead of `127.0.0.1` when true. Opt-in because it
    /// turns the proxy into an open relay for the whole LAN.
    pub allow_lan: AtomicBool,
    /// Path to the config directory for persistence (JSON file).
    pub config_path: Mutex<Option<PathBuf>>,
}

impl ProxyState {
    /// Path to the proxy config JSON file.
    pub fn config_file(&self) -> Option<PathBuf> {
        self.config_path
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
            .map(|d| d.join("proxy_config.json"))
    }

    /// Load proxy config from disk (routes + default_target).
    /// Starts silently with defaults on any error (missing file, corrupt JSON, ...).
    pub fn load_config(&self) {
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
            routes: Vec<ProxyRoute>,
            // Missing in configs written before LAN binding existed — serde
            // fills in `false`, which is the safe (loopback-only) default.
            #[serde(default)]
            allow_lan: bool,
        }
        if let Ok(cfg) = serde_json::from_str::<PersistedProxyConfig>(&json) {
            *self.default_target.lock().unwrap_or_else(|e| e.into_inner()) = cfg.default_target;
            *self.routes.lock().unwrap_or_else(|e| e.into_inner()) = cfg.routes;
            self.allow_lan.store(cfg.allow_lan, Ordering::Relaxed);
        }
    }

    /// Save proxy config to disk (routes + default_target + allow_lan).
    ///
    /// Takes the locks itself, so callers must NOT hold `routes` /
    /// `default_target` guards across this call — `std::sync::Mutex` is not
    /// reentrant and doing so self-deadlocks the calling thread. Mutating
    /// commands should scope their guard (or `drop` it) before persisting.
    pub fn save_config(&self) {
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
            routes: &'a [ProxyRoute],
            allow_lan: bool,
        }
        let cfg = PersistedProxyConfig {
            default_target: &self.default_target.lock().unwrap_or_else(|e| e.into_inner()),
            routes: &self.routes.lock().unwrap_or_else(|e| e.into_inner()),
            allow_lan: self.allow_lan.load(Ordering::Relaxed),
        };
        if let Ok(json) = serde_json::to_string_pretty(&cfg) {
            let _ = std::fs::write(path, json);
        }
    }
}

impl Default for ProxyState {
    fn default() -> Self {
        Self {
            running: AtomicBool::new(false),
            default_target: Mutex::new("http://localhost:8080".to_string()),
            routes: Mutex::new(Vec::new()),
            port: AtomicU16::new(9000),
            logs: Mutex::new(Vec::new()),
            shutdown_tx: Mutex::new(None),
            allow_lan: AtomicBool::new(false),
            config_path: Mutex::new(None),
        }
    }
}

// ── Routing logic ──────────────────────────────────────────────

/// Minimal percent-encoding for the path component of a URL.
///
/// Encodes the characters that ip-api.com (and most HTTP servers) reject in
/// a path segment: spaces, quotes, angle brackets, backslashes, and anything
/// non-ASCII. Leaves `/`, `:`, `.`, `%`, `-`, `_`, `~`, alphanumerics alone.
///
/// We don't pull in the `urlencoding` crate for this — the surface area is
/// tiny and we only need *path* encoding (not query-string encoding, which
/// has a different reserved-set definition).
pub fn urlencoding_min(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for b in input.bytes() {
        match b {
            b'/' | b':' | b'.' | b'-' | b'_' | b'~' | b'%' => out.push(b as char),
            b if b.is_ascii_alphanumeric() => out.push(b as char),
            _ => {
                out.push_str(&format!("%{:02X}", b));
            }
        }
    }
    out
}

/// Match a request path against the configured route table.
///
/// Returns `(target_base, Some(stripped_prefix))` when a route matches —
/// the caller appends the remainder of the path to `target_base`.
/// When no route matches, returns `(default_target, None)` and the caller
/// forwards the full path unchanged.
///
/// Matching semantics:
///   * Only **enabled** routes are considered.
///   * Longest `path_prefix` wins (more specific routes beat shorter ones).
///   * The prefix match is on whole path segments — `/api` matches `/api`
///     and `/api/foo` but not `/apibaz`. (We check either exact equality or
///     that the next char is `/`.)
pub fn match_route(path: &str, routes: &[ProxyRoute]) -> (String, Option<String>) {
    let mut best: Option<&ProxyRoute> = None;
    for r in routes {
        if !r.enabled {
            continue;
        }
        let p = &r.path_prefix;
        if path == p || path.starts_with(&format!("{}/", p)) {
            match best {
                Some(b) if p.len() > b.path_prefix.len() => best = Some(r),
                None => best = Some(r),
                _ => {}
            }
        }
    }
    match best {
        Some(r) => (r.target.clone(), Some(r.path_prefix.clone())),
        None => (
            // No match — caller should fall back to the default target.
            // We can't read `default_target` here because `match_route` is
            // pure (no state). The caller (the axum handler) owns the
            // default and passes it in explicitly.
            String::new(),
            None,
        ),
    }
}

// ── Command helpers ────────────────────────────────────────────

/// Append a log entry to the proxy log ring buffer.
///
/// Caps at 500 entries (oldest dropped first). The log lives in a `Mutex<Vec>`
/// because it's written from the axum request task (single-producer in
/// practice, but `Mutex` is simpler than building a channel for this) and
/// read from the `get_proxy_logs` command handler.
/// Build the upstream URL for a forwarded request.
///
/// Extracted as a pure function so the prefix-stripping / query-preservation
/// rules are unit-testable. `uri_path` must be the full path-and-query
/// (i.e. `parts.uri.path_and_query()`), because the query string has to
/// survive **both** branches — an earlier version only re-appended it on the
/// default-target branch, silently dropping `?a=b` for every matched route.
pub fn build_forward_path(target: &str, uri_path: &str, matched_prefix: Option<&str>) -> String {
    let base = target.trim_end_matches('/');
    let (path, query) = match uri_path.split_once('?') {
        Some((p, q)) => (p, format!("?{}", q)),
        None => (uri_path, String::new()),
    };
    match matched_prefix {
        Some(prefix) => {
            let rest = path.strip_prefix(prefix).unwrap_or(path).trim_start_matches('/');
            format!("{}/{}{}", base, rest, query)
        }
        None => format!("{}{}{}", base, path, query),
    }
}

// ── Forward clients (cached) ───────────────────────────────────

/// Request body type for forwarded requests. `hyper::body::Bytes` is a
/// re-export — `bytes` is not a direct dependency of this crate.
type ForwardBody = http_body_util::Full<hyper::body::Bytes>;

type HttpsClient = hyper_util::client::legacy::Client<
    hyper_rustls::HttpsConnector<hyper_util::client::legacy::connect::HttpConnector>,
    ForwardBody,
>;
type HttpClient = hyper_util::client::legacy::Client<
    hyper_util::client::legacy::connect::HttpConnector,
    ForwardBody,
>;

/// Shared HTTPS forward client (rustls + webpki roots).
///
/// webpki rather than native roots: `with_native_roots()` needs the
/// `native-tokio` feature we don't enable, and publicly-trusted CAs are all
/// the proxy needs.
fn https_client() -> &'static HttpsClient {
    static CLIENT: std::sync::OnceLock<HttpsClient> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| {
        let https = hyper_rustls::HttpsConnectorBuilder::new()
            .with_webpki_roots()
            .https_or_http()
            .enable_http1()
            .build();
        hyper_util::client::legacy::Client::builder(hyper_util::rt::TokioExecutor::new())
            .build(https)
    })
}

/// Shared plain-HTTP forward client.
fn http_client() -> &'static HttpClient {
    static CLIENT: std::sync::OnceLock<HttpClient> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| {
        let mut http = hyper_util::client::legacy::connect::HttpConnector::new();
        http.enforce_http(false);
        hyper_util::client::legacy::Client::builder(hyper_util::rt::TokioExecutor::new())
            .build(http)
    })
}

fn push_log(state: &ProxyState, log: ProxyLog) {    let mut logs = state.logs.lock().unwrap_or_else(|e| e.into_inner());
    logs.insert(0, log);
    if logs.len() > 500 {
        logs.truncate(500);
    }
}

// ── Tauri commands ─────────────────────────────────────────────

#[tauri::command]
pub fn get_proxy_status(state: tauri::State<'_, Arc<ProxyState>>) -> ProxyConfig {
    ProxyConfig {
        running: state.running.load(Ordering::Relaxed),
        default_target: state
            .default_target
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone(),
        port: state.port.load(Ordering::Relaxed),
        routes: state.routes.lock().unwrap_or_else(|e| e.into_inner()).clone(),
        allow_lan: state.allow_lan.load(Ordering::Relaxed),
    }
}

#[tauri::command]
pub fn set_proxy_default_target(
    target: String,
    state: tauri::State<'_, Arc<ProxyState>>,
) -> Result<(), String> {
    let trimmed = target.trim().to_string();
    if trimmed.is_empty() {
        return Err("Default target cannot be empty".to_string());
    }
    *state
        .default_target
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = trimmed;
    state.save_config();
    Ok(())
}

#[tauri::command]
pub fn upsert_proxy_route(
    route: ProxyRoute,
    state: tauri::State<'_, Arc<ProxyState>>,
) -> Result<ProxyRoute, String> {
    if route.path_prefix.is_empty() {
        return Err("Path prefix cannot be empty".to_string());
    }
    if route.target.is_empty() {
        return Err("Target cannot be empty".to_string());
    }
    let mut routes = state.routes.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(existing) = routes.iter_mut().find(|r| r.id == route.id) {
        existing.path_prefix = route.path_prefix.clone();
        existing.target = route.target.clone();
        existing.enabled = route.enabled;
        let updated = existing.clone();
        // Release before persisting: save_config() re-locks `routes` and
        // std Mutex is not reentrant, so holding the guard here froze the
        // command thread forever (UI hung on "保存" when editing a route).
        drop(routes);
        state.save_config();
        return Ok(updated);
    }
    // New route — generate an id if the caller didn't supply one.
    let new_route = if route.id.is_empty() {
        ProxyRoute {
            id: uuid::Uuid::new_v4().to_string(),
            ..route
        }
    } else {
        route
    };
    routes.push(new_route.clone());
    drop(routes);
    state.save_config();
    Ok(new_route)
}

#[tauri::command]
pub fn delete_proxy_route(
    route_id: String,
    state: tauri::State<'_, Arc<ProxyState>>,
) -> Result<(), String> {
    let mut routes = state.routes.lock().unwrap_or_else(|e| e.into_inner());
    let before = routes.len();
    routes.retain(|r| r.id != route_id);
    if routes.len() == before {
        return Err(format!("Route {} not found", route_id));
    }
    drop(routes);
    state.save_config();
    Ok(())
}

#[tauri::command]
pub fn toggle_proxy_route(
    route_id: String,
    state: tauri::State<'_, Arc<ProxyState>>,
) -> Result<bool, String> {
    let mut routes = state.routes.lock().unwrap_or_else(|e| e.into_inner());
    let r = routes
        .iter_mut()
        .find(|r| r.id == route_id)
        .ok_or_else(|| format!("Route {} not found", route_id))?;
    r.enabled = !r.enabled;
    let new_state = r.enabled;
    drop(routes);
    state.save_config();
    Ok(new_state)
}

/// Toggle LAN binding. Takes effect on the next `start_proxy` — rebinding a
/// live listener would drop in-flight connections, so the UI tells the user
/// to restart the proxy.
#[tauri::command]
pub fn set_proxy_allow_lan(
    allow: bool,
    state: tauri::State<'_, Arc<ProxyState>>,
) -> Result<(), String> {
    state.allow_lan.store(allow, Ordering::Relaxed);
    state.save_config();
    Ok(())
}

/// Remove every route in one shot.
#[tauri::command]
pub fn clear_proxy_routes(state: tauri::State<'_, Arc<ProxyState>>) -> Result<(), String> {
    state.routes.lock().unwrap_or_else(|e| e.into_inner()).clear();
    state.save_config();
    Ok(())
}

/// Export all routes as pretty-printed JSON for backup / sharing.
#[tauri::command]
pub fn export_proxy_routes(state: tauri::State<'_, Arc<ProxyState>>) -> Result<String, String> {
    let routes = state.routes.lock().unwrap_or_else(|e| e.into_inner()).clone();
    serde_json::to_string_pretty(&routes).map_err(|e| format!("Failed to serialize routes: {}", e))
}

/// Import routes from JSON produced by `export_proxy_routes`.
///
/// Replaces the whole table rather than merging: merging needs a conflict
/// policy (same prefix, different target) that the UI can't express yet.
/// Imported entries get fresh ids so a re-import can't collide with itself.
#[tauri::command]
pub fn import_proxy_routes(
    json: String,
    state: tauri::State<'_, Arc<ProxyState>>,
) -> Result<usize, String> {
    let parsed: Vec<ProxyRoute> =
        serde_json::from_str(&json).map_err(|e| format!("Invalid routes JSON: {}", e))?;
    for r in &parsed {
        if r.path_prefix.trim().is_empty() {
            return Err("Every route needs a non-empty path prefix".to_string());
        }
        if r.target.trim().is_empty() {
            return Err("Every route needs a non-empty target".to_string());
        }
    }
    let imported: Vec<ProxyRoute> = parsed
        .into_iter()
        .map(|r| ProxyRoute {
            id: uuid::Uuid::new_v4().to_string(),
            ..r
        })
        .collect();
    let count = imported.len();
    *state.routes.lock().unwrap_or_else(|e| e.into_inner()) = imported;
    state.save_config();
    Ok(count)
}

#[tauri::command]
pub fn get_proxy_logs(state: tauri::State<'_, Arc<ProxyState>>) -> Vec<ProxyLog> {    state
        .logs
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
}

#[tauri::command]
pub fn clear_proxy_logs(state: tauri::State<'_, Arc<ProxyState>>) {
    state.logs.lock().unwrap_or_else(|e| e.into_inner()).clear();
}

#[tauri::command]
pub async fn start_proxy(
    port: Option<u16>,
    state: tauri::State<'_, Arc<ProxyState>>,
) -> Result<u16, String> {
    if state.running.load(Ordering::Relaxed) {
        return Err("Proxy is already running".to_string());
    }

    let bind_port = port.unwrap_or_else(|| state.port.load(Ordering::Relaxed));
    state.port.store(bind_port, Ordering::Relaxed);

    let state_ref = state.inner().clone();
    let (tx, rx) = tokio::sync::oneshot::channel::<()>();

    // Store the shutdown sender so stop_proxy can fire it.
    {
        let mut s = state.shutdown_tx.lock().unwrap_or_else(|e| e.into_inner());
        *s = Some(tx);
    }
    state.running.store(true, Ordering::Relaxed);

    // Build the axum router with a single fallback handler that does the
    // routing + forwarding. We use `any` so every method + path lands in
    // the same handler — the proxy is method-agnostic.
    let app = axum::Router::new().fallback(
        axum::routing::any(proxy_handler),
    );

    // Wrapped in State so the handler can access it.
    let app = app.with_state(state_ref.clone());

    // Bind to all interfaces only when the user opted in; loopback otherwise.
    let bind_ip = if state.allow_lan.load(Ordering::Relaxed) {
        [0, 0, 0, 0]
    } else {
        [127, 0, 0, 1]
    };
    let addr = std::net::SocketAddr::from((bind_ip, bind_port));
    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) => {
            // Roll back the optimistic `running = true` above, otherwise a
            // failed bind (port already in use) leaves the app believing the
            // proxy is up and refusing every later start attempt.
            state.running.store(false, Ordering::Relaxed);
            *state.shutdown_tx.lock().unwrap_or_else(|e| e.into_inner()) = None;
            return Err(format!("Failed to bind port {}: {}", bind_port, e));
        }
    };

    // Spawn the server on the Tokio runtime. The server runs until the
    // shutdown channel fires (from stop_proxy) or the listener dies.
    let server_state = state_ref.clone();
    tauri::async_runtime::spawn(async move {
        let serve = axum::serve(listener, app);
        let graceful = serve.with_graceful_shutdown(async move {
            let _ = rx.await;
        });
        let result = graceful.await;
        // Mark not-running when the server exits, regardless of why.
        server_state.running.store(false, Ordering::Relaxed);
        if let Err(e) = result {
            eprintln!("[proxy] server error: {}", e);
        }
    });

    Ok(bind_port)
}

#[tauri::command]
pub fn stop_proxy(state: tauri::State<'_, Arc<ProxyState>>) -> Result<(), String> {
    if !state.running.load(Ordering::Relaxed) {
        return Err("Proxy is not running".to_string());
    }
    // Take the sender out and fire it. `take` leaves `None` behind so a
    // second `stop_proxy` call cleanly returns "not running".
    let mut tx = state.shutdown_tx.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(sender) = tx.take() {
        let _ = sender.send(());
    }
    drop(tx);
    // Set to false immediately from the command side too — the server task
    // will also set it to false when it actually exits, but that can take a
    // few ms and we want the UI to reflect "stopping" right away.
    state.running.store(false, Ordering::Relaxed);
    Ok(())
}

// ── Core proxy handler (axum) ──────────────────────────────────

/// Extract the host (and port, if non-default) from a URL for the Host header.
///
/// Parses `http://example.com:8080/path` → `example.com:8080`,
/// and `https://example.com/path` → `example.com`.
/// Returns `None` for malformed URLs (the caller falls back to no Host header,
/// which most servers accept with a default).
fn extract_host(url: &str) -> Option<String> {
    let rest = url
        .strip_prefix("http://")
        .or_else(|| url.strip_prefix("https://"))?;
    let after_scheme = rest.split('/').next().unwrap_or(rest);
    // after_scheme looks like "host" or "host:port"
    // For the Host header we include the port only when it's explicit in the URL,
    // which matches what browsers do.
    Some(after_scheme.to_string())
}

/// The single fallback handler: matches the request path against the route
/// table, forwards to the selected target, logs the result, and returns the
/// response to the client.
///
/// This is deliberately simple — one handler, no middleware, no routing
/// trickery. The route table is small (users typically have 1–10 rules) so
/// a linear scan in `match_route` is fine.
async fn proxy_handler(
    axum::extract::State(state): axum::extract::State<Arc<ProxyState>>,
    req: axum::http::Request<axum::body::Body>,
) -> Result<axum::response::Response<axum::body::Body>, axum::http::StatusCode> {
    use chrono::Utc;
    use http_body_util::BodyExt;
    use std::time::Instant;

    let start = Instant::now();
    let method = req.method().clone();
    let uri_path = req.uri().path().to_string();
    let full_uri = req.uri().to_string();

    // Snapshot request headers before we consume the body.
    let request_headers: Vec<(String, String)> = req
        .headers()
        .iter()
        .map(|(k, v)| (k.as_str().to_string(), v.to_str().unwrap_or("").to_string()))
        .collect();

    // Read and buffer the request body (up to a limit) for logging.
    // Binary / large payloads are truncated to `"[binary or large body]"`.
    const BODY_LIMIT: usize = 64 * 1024;
    let (parts, body) = req.into_parts();
    let body_bytes = body
        .collect()
        .await
        .map_err(|_| axum::http::StatusCode::BAD_REQUEST)?
        .to_bytes();
    let request_body = if body_bytes.len() <= BODY_LIMIT {
        String::from_utf8(body_bytes.to_vec()).ok()
    } else {
        Some("[binary or large body]".to_string())
    };
    let body_len = body_bytes.len();

    // Resolve target from the route table.
    let routes_snapshot = state.routes.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let (target_base, matched_prefix) = match_route(&uri_path, &routes_snapshot);
    let default_target = state
        .default_target
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();

    let target = if target_base.is_empty() {
        default_target.clone()
    } else {
        target_base.clone()
    };

    // Build the forward URL: strip matched prefix, append the rest.
    // Pass path *and query* so the query survives the matched-route branch too.
    let path_and_query = parts
        .uri
        .path_and_query()
        .map(|pq| pq.as_str().to_string())
        .unwrap_or_else(|| uri_path.clone());
    let forward_path = build_forward_path(&target, &path_and_query, matched_prefix.as_deref());

    // Rebuild the request body from our buffered bytes.
    // hyper 1.x removed `hyper::body::Body`; use `http_body_util::Full` instead
    // — it implements `http_body::Body` and is accepted by hyper_util's legacy client.
    let req_body = http_body_util::Full::new(body_bytes);

    // Build the forwarded request.
    let mut builder = hyper::Request::builder().method(&method).uri(&forward_path);
    for (k, v) in &request_headers {
        // Skip hop-by-hop and host-specific headers.
        let lower = k.to_lowercase();
        if lower == "host" || lower == "content-length" {
            continue;
        }
        builder = builder.header(k, v);
    }
    // Set the correct Host header from the target URL.
    // We don't pull in the `url` crate for this — a quick string parse
    // is enough (the target is always http:// or https:// + host + path).
    if let Some(host) = extract_host(&forward_path) {
        builder = builder.header("Host", host);
    }
    let forward_req = builder
        .body(req_body)
        .map_err(|_| axum::http::StatusCode::BAD_REQUEST)?;

    // Execute the forward request using hyper_util's client.
    //
    // Clients are cached in module-level `OnceLock`s rather than stored in
    // `ProxyState`: a hyper_util `Client` carries its connector as a generic
    // parameter, so holding one in the state struct would leak those type
    // params into every `Arc<ProxyState>` signature. Caching matters because
    // building a client per request also throws away the connection pool,
    // forcing a fresh TCP (and TLS) handshake on every single call.
    let forward_result = if forward_path.starts_with("https://") {
        https_client().request(forward_req).await
    } else {
        http_client().request(forward_req).await
    };

    let duration_ms = start.elapsed().as_millis() as u64;

    match forward_result {
        Ok(resp) => {
            let status = resp.status().as_u16();
            let response_headers: Vec<(String, String)> = resp
                .headers()
                .iter()
                .map(|(k, v)| (k.as_str().to_string(), v.to_str().unwrap_or("").to_string()))
                .collect();

            let (_resp_parts, resp_body) = resp.into_parts();
            let resp_bytes = resp_body
                .collect()
                .await
                .unwrap_or_default()
                .to_bytes();
            // Log preview only — never reuse this for the forwarded body.
            // Lossy/truncated text here must not corrupt what the client gets.
            let response_body = if resp_bytes.len() <= BODY_LIMIT {
                String::from_utf8(resp_bytes.to_vec()).ok()
            } else {
                Some("[binary or large body]".to_string())
            };

            // Build the response we send back to the client.
            let mut response_builder = axum::http::Response::builder().status(status);
            for (k, v) in &response_headers {
                let lower = k.to_lowercase();
                if lower == "content-length"
                    || lower == "transfer-encoding"
                    || lower == "connection"
                {
                    continue;
                }
                response_builder = response_builder.header(k, v);
            }
            // Forward the original bytes verbatim. Building the body from the
            // logging preview (a lossy String) corrupted every binary payload
            // — images, gzip, protobuf — and truncated anything over the log
            // limit.
            let response = response_builder
                .body(axum::body::Body::from(resp_bytes.clone()))
                .unwrap_or_else(|_| axum::http::Response::new(axum::body::Body::empty()));

            // Log the completed request/response pair.
            let log = ProxyLog {
                id: uuid::Uuid::new_v4().to_string(),
                timestamp: Utc::now().timestamp_millis(),
                method: method.to_string(),
                url: full_uri.clone(),
                route_match: matched_prefix.clone(),
                status,
                duration_ms,
                request_headers: request_headers.clone(),
                request_body: request_body.clone(),
                response_headers,
                response_body,
                error: None,
            };
            push_log(&state, log);

            // Suppress unused warning — we captured body_len for logging
            // consistency (could add it to ProxyLog later).
            let _ = body_len;
            let _ = target_base;

            Ok(response)
        }
        Err(e) => {
            // Forwarding failed — log the error and return 502.
            let error_msg = e.to_string();
            let log = ProxyLog {
                id: uuid::Uuid::new_v4().to_string(),
                timestamp: Utc::now().timestamp_millis(),
                method: method.to_string(),
                url: full_uri.clone(),
                route_match: matched_prefix.clone(),
                status: 502,
                duration_ms,
                request_headers,
                request_body,
                response_headers: vec![],
                response_body: None,
                error: Some(error_msg.clone()),
            };
            push_log(&state, log);

            let body = format!("Bad Gateway: {}", error_msg);
            let resp = axum::http::Response::builder()
                .status(axum::http::StatusCode::BAD_GATEWAY)
                .body(axum::body::Body::from(body))
                .unwrap_or_else(|_| axum::http::Response::new(axum::body::Body::empty()));
            Ok(resp)
        }
    }
}

// ── Tests ──────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// Regression: `save_config()` re-locks `routes`, and `std::sync::Mutex`
    /// is not reentrant. `upsert_proxy_route`'s edit branch used to call it
    /// while still holding the guard, hanging the command thread forever
    /// (the UI froze when saving an edited route). A `config_path` must be
    /// set — otherwise save_config() early-returns before taking any lock and
    /// the deadlock cannot reproduce.
    #[test]
    fn save_config_after_dropping_routes_lock_does_not_deadlock() {
        use std::sync::mpsc;
        use std::time::Duration;

        let dir = std::env::temp_dir().join(format!("ec_proxy_dl_{}", std::process::id()));
        let state = Arc::new(ProxyState::default());
        *state.config_path.lock().unwrap_or_else(|e| e.into_inner()) = Some(dir.clone());

        let (tx, rx) = mpsc::channel();
        let worker = Arc::clone(&state);
        std::thread::spawn(move || {
            // Mirror the fixed edit branch: mutate under the guard, drop it,
            // then persist.
            let mut routes = worker.routes.lock().unwrap_or_else(|e| e.into_inner());
            routes.push(route("r1", "/api", "http://localhost:3000", true));
            drop(routes);
            worker.save_config();
            let _ = tx.send(());
        });

        assert!(
            rx.recv_timeout(Duration::from_secs(5)).is_ok(),
            "save_config() deadlocked"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── build_forward_path ──────────────────────────────────────

    #[test]
    fn build_forward_path_strips_matched_prefix() {
        let out = build_forward_path("http://localhost:3000", "/api/users", Some("/api"));
        assert_eq!(out, "http://localhost:3000/users");
    }

    /// The bug this function was extracted for: the matched-route branch used
    /// to drop the query string entirely.
    #[test]
    fn build_forward_path_keeps_query_on_matched_route() {
        let out = build_forward_path("http://localhost:3000", "/api/users?page=2&q=x", Some("/api"));
        assert_eq!(out, "http://localhost:3000/users?page=2&q=x");
    }

    #[test]
    fn build_forward_path_keeps_query_on_default_target() {
        let out = build_forward_path("http://localhost:8080", "/health?verbose=1", None);
        assert_eq!(out, "http://localhost:8080/health?verbose=1");
    }

    #[test]
    fn build_forward_path_trims_duplicate_slashes() {
        let out = build_forward_path("http://localhost:3000/", "/api/users", Some("/api"));
        assert_eq!(out, "http://localhost:3000/users");
    }

    #[test]
    fn build_forward_path_handles_exact_prefix_match() {
        let out = build_forward_path("http://localhost:3000", "/api", Some("/api"));
        assert_eq!(out, "http://localhost:3000/");
    }

    fn route(id: &str, prefix: &str, target: &str, enabled: bool) -> ProxyRoute {
        ProxyRoute {
            id: id.to_string(),
            path_prefix: prefix.to_string(),
            target: target.to_string(),
            enabled,
        }
    }

    #[test]
    fn match_route_no_routes_returns_empty_target() {
        let (target, matched) = match_route("/api/foo", &[]);
        assert_eq!(target, "");
        assert_eq!(matched, None);
    }

    #[test]
    fn match_route_exact_prefix() {
        let routes = vec![route("1", "/api", "http://a", true)];
        let (target, matched) = match_route("/api", &routes);
        assert_eq!(target, "http://a");
        assert_eq!(matched.as_deref(), Some("/api"));
    }

    #[test]
    fn match_route_sub_path() {
        let routes = vec![route("1", "/api", "http://a", true)];
        let (target, matched) = match_route("/api/users/42", &routes);
        assert_eq!(target, "http://a");
        assert_eq!(matched.as_deref(), Some("/api"));
    }

    #[test]
    fn match_route_does_not_match_partial_segment() {
        let routes = vec![route("1", "/api", "http://a", true)];
        let (target, matched) = match_route("/apibaz", &routes);
        assert_eq!(target, "");
        assert_eq!(matched, None);
    }

    #[test]
    fn match_route_longest_prefix_wins() {
        let routes = vec![
            route("1", "/api", "http://a", true),
            route("2", "/api/v2", "http://b", true),
        ];
        let (target, matched) = match_route("/api/v2/users", &routes);
        assert_eq!(target, "http://b");
        assert_eq!(matched.as_deref(), Some("/api/v2"));
    }

    #[test]
    fn match_route_skips_disabled() {
        let routes = vec![route("1", "/api", "http://a", false)];
        let (target, matched) = match_route("/api/foo", &routes);
        assert_eq!(target, "");
        assert_eq!(matched, None);
    }

    #[test]
    fn urlencoding_min_preserves_safe_chars() {
        assert_eq!(urlencoding_min("/api/v2/users-42_foo~bar"), "/api/v2/users-42_foo~bar");
        assert_eq!(urlencoding_min("example.com:8080"), "example.com:8080");
        assert_eq!(urlencoding_min("%20"), "%20");
    }

    #[test]
    fn urlencoding_min_encodes_spaces_and_specials() {
        assert_eq!(urlencoding_min("hello world"), "hello%20world");
        assert_eq!(urlencoding_min("a/b c"), "a/b%20c");
        assert!(urlencoding_min("你好").contains("%"));
    }
}
