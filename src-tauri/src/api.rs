// Allow Tauri's #[command] macro to infer Result<T, String> for sync commands
// without us having to spell the wrapper on every handler. Future-friendly
// shim until we migrate the crate to edition 2024 explicitly.
#![allow(dependency_on_unit_never_type_fallback)]

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::models::{
    ApiAuth, ApiEnvironment, ApiNode, ApiRequest, ApiResponse, ApiState,
};
use base64::Engine as _;
use futures_util::StreamExt as _;
use reqwest::cookie::{CookieStore as _, Jar};
use reqwest::redirect::Policy;
use reqwest::{header, Client, ClientBuilder, Method, Proxy};

/// Total request timeout when the request doesn't specify one. reqwest itself
/// has **no** default, which is why a request to a black-hole address used to
/// hang the UI indefinitely with no way to cancel.
pub const DEFAULT_TIMEOUT_SECS: u64 = 30;

/// Connect-phase timeout. Kept well below the total so a dead host fails fast
/// instead of burning the whole budget on TCP.
const CONNECT_TIMEOUT_SECS: u64 = 10;

/// Hard cap on how many bytes of a response body we pull off the socket.
///
/// The previous implementation called `response.text()`, which buffers the
/// *entire* body into memory before any truncation — a 2 GB download was an
/// OOM. We now stream and stop reading once we cross this line.
const MAX_BODY_BYTES: usize = 5 * 1024 * 1024;

/// How much of the body we hand to the front-end as text. Larger than this and
/// the renderer chokes; the full size is still reported via `body_size`.
const MAX_BODY_TEXT_BYTES: usize = 512 * 1024;

/// Manages API collections, environments, and request execution.
/// Mirrors `NoteManager`'s pattern: single JSON file, in-memory `Arc<Mutex<...>>`.
pub struct ApiStore {
    state: Arc<Mutex<ApiState>>,
    /// Storage root. Wrapped in a `Mutex` so `set_data_dir` can swap it
    /// after construction (when the user changes `storage_root` from the
    /// settings panel) without forcing every other method through a lock.
    data_dir: std::sync::Mutex<Option<PathBuf>>,
    /// Shared cookie jar so successive calls in the same session persist cookies.
    ///
    /// Wrapped in a `Mutex<Arc<..>>` rather than a bare `Arc` because `Jar` has
    /// no "clear" API — `clear_cookies` swaps in a fresh jar instead.
    cookie_jar_slot: Mutex<Arc<Jar>>,
    /// Reusable clients keyed by the two settings that must be baked in at
    /// build time: `(insecure_tls, follow_redirects)`.
    ///
    /// The previous code called `ClientBuilder::new().build()` inside `execute`,
    /// so every single send threw away the connection pool and redid the TLS
    /// handshake from scratch. Per-request timeouts don't need a new client —
    /// `RequestBuilder::timeout` covers that.
    clients: Mutex<HashMap<(bool, bool), Client>>,
}

/// Everything one request needs from its bound environment, read under a
/// single lock. Empty/default means "no env bound" — see `env_snapshot`.
#[derive(Default)]
struct EnvSnapshot {
    vars: HashMap<String, String>,
    base_url: String,
    headers: Vec<(String, String)>,
}

impl ApiStore {
    pub fn new(data_dir: Option<PathBuf>) -> Self {
        Self {
            state: Arc::new(Mutex::new(ApiState::default())),
            data_dir: std::sync::Mutex::new(data_dir),
            cookie_jar_slot: Mutex::new(Arc::new(Jar::default())),
            clients: Mutex::new(HashMap::new()),
        }
    }

    fn cookie_jar(&self) -> Arc<Jar> {
        self.cookie_jar_slot
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// Update the data directory at runtime (used when the user changes
    /// `storage_root` from the settings panel). Re-reads `api_collections.json`
    /// from the new location so subsequent operations hit the right file.
    /// Best-effort: if the new path doesn't exist yet or contains corrupt
    /// JSON, we just start with the in-memory state.
    pub fn set_data_dir(&self, data_dir: PathBuf) {
        *self.data_dir.lock().unwrap_or_else(|e| e.into_inner()) = Some(data_dir);
        self.load();
    }

    fn file_path(&self) -> Option<PathBuf> {
        self.data_dir
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .map(|d| d.join("api_collections.json"))
    }

    /// Load state from disk.
    ///
    /// A corrupt file is **preserved** (renamed to `*.corrupt-<ts>`) rather
    /// than silently ignored: the old behaviour returned early, leaving the
    /// user with an apparently empty collection list, and then the next `save()`
    /// overwrote the damaged-but-possibly-recoverable file with that emptiness.
    pub fn load(&self) {
        let path = match self.file_path() {
            Some(p) => p,
            None => return,
        };
        let json = match fs::read_to_string(&path) {
            Ok(j) => j,
            Err(_) => return,
        };
        match serde_json::from_str::<ApiState>(&json) {
            Ok(loaded) => {
                *self.state.lock().unwrap_or_else(|e| e.into_inner()) = loaded;
            }
            Err(e) => {
                let stamp = chrono::Utc::now().timestamp_millis();
                let backup = path.with_extension(format!("corrupt-{stamp}.json"));
                let _ = fs::copy(&path, &backup);
                eprintln!(
                    "api_collections.json failed to parse ({e}); backed up to {}",
                    backup.display()
                );
            }
        }
    }

    /// Persist state to disk atomically.
    ///
    /// Writes to a sibling temp file and renames over the target. A plain
    /// `fs::write` truncates in place, so a crash or power loss mid-write left
    /// a half-written JSON file — combined with the old silent-ignore `load()`,
    /// that meant losing every saved request.
    fn save(&self) {
        let path = match self.file_path() {
            Some(p) => p,
            None => return,
        };
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let state = self.state.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let json = match serde_json::to_string_pretty(&state) {
            Ok(j) => j,
            Err(_) => return,
        };
        let tmp = path.with_extension("json.tmp");
        if fs::write(&tmp, &json).is_err() {
            return;
        }
        // `rename` over an existing file is atomic on NTFS and POSIX alike.
        if fs::rename(&tmp, &path).is_err() {
            let _ = fs::remove_file(&tmp);
        }
    }

    // ── Tree helpers ────────────────────────────────────────────

    pub fn list_nodes(&self) -> Vec<ApiNode> {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).nodes.clone()
    }

    pub fn list_envs(&self) -> Vec<ApiEnvironment> {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).envs.clone()
    }

    pub fn upsert_node(&self, node: ApiNode) -> ApiNode {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(existing) = state.nodes.iter_mut().find(|n| n.id == node.id) {
            *existing = node.clone();
        } else {
            state.nodes.push(node.clone());
        }
        drop(state);
        self.save();
        node
    }

    pub fn delete_node(&self, id: &str) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        // Cascade: drop this node and any descendants.
        let to_remove: Vec<String> = collect_descendants(&state.nodes, id);
        state.nodes.retain(|n| !to_remove.contains(&n.id));
        drop(state);
        self.save();
    }

    pub fn upsert_env(&self, env: ApiEnvironment) -> ApiEnvironment {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(existing) = state.envs.iter_mut().find(|e| e.id == env.id) {
            *existing = env.clone();
        } else {
            state.envs.push(env.clone());
        }
        drop(state);
        self.save();
        env
    }

    pub fn delete_env(&self, id: &str) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.envs.retain(|e| e.id != id);
        drop(state);
        self.save();
    }

    // ── Variable expansion ──────────────────────────────────────

    /// Snapshot everything `execute` needs from **the request's own**
    /// environment: vars, base URL and shared headers.
    ///
    /// Environments bind per request (`ApiRequest::env_id`), not globally.
    /// A request with no `env_id`, or one pointing at a deleted env, simply
    /// gets no env: placeholders stay literal, no base is prepended and no
    /// shared headers are merged.
    ///
    /// All three come back from **one** lock acquisition. Two reasons:
    /// `expand` used to lock and clone the whole var map on *every* call —
    /// once per URL, per header, per query param, per form field, 20+
    /// lock/clone cycles for a single request — and reading base/headers
    /// separately could straddle an edit and mix a base from one env with
    /// headers from another.
    fn env_snapshot(&self, env_id: Option<&str>) -> EnvSnapshot {
        let Some(env_id) = env_id else {
            return EnvSnapshot::default();
        };
        let s = self.state.lock().unwrap_or_else(|e| e.into_inner());
        match s.envs.iter().find(|e| e.id == env_id) {
            Some(env) => EnvSnapshot {
                vars: env.vars.iter().cloned().collect(),
                base_url: env.base_url.clone(),
                headers: env.headers.clone(),
            },
            None => EnvSnapshot::default(),
        }
    }

    /// Expand `{{var_name}}` placeholders in `input` using the active env's vars.
    /// Unknown placeholders are left untouched.
    // ── Execution ───────────────────────────────────────────────

    /// Execute an HTTP request and return the response.
    ///
    /// History is deliberately **not** written here. It used to be, via
    /// `append_history`, which looked the node up by matching URL+method and
    /// took the first hit — so with two requests sharing a URL the response
    /// landed on the wrong one. Worse, the front-end also appended history
    /// locally and then saved its own snapshot, silently reverting the backend
    /// write. History is now owned by the front-end alone.
    pub async fn execute(&self, mut req: ApiRequest) -> ApiResponse {
        let started = Instant::now();
        let mut warnings: Vec<String> = Vec::new();

        // One snapshot of *this request's* env for the whole call (see
        // `env_snapshot`). Binding is per request, so two requests sent back
        // to back can legitimately resolve different envs.
        let env = self.env_snapshot(req.env_id.as_deref());
        let vars = env.vars;

        // Expand URL, then prepend the env base, then substitute `:path_vars`.
        //
        // Order matters: the base join must happen *after* placeholder
        // expansion, or a URL like `{{host}}/x` would still look relative at
        // join time and get the base glued in front of its own host.
        req.url = expand_placeholders(&req.url, &vars);
        req.url = join_base_url(&env.base_url, &req.url);
        let path_vars: Vec<(String, String)> = req
            .path_vars
            .iter()
            .map(|(k, v)| (k.clone(), expand_placeholders(v, &vars)))
            .collect();
        req.url = substitute_path_vars(&req.url, &path_vars);

        // Request headers first, then merge in the env's shared ones. Both
        // sides get placeholder expansion, so an env header may itself be
        // written as `Bearer {{token}}`.
        let own_headers: Vec<(String, String)> = req
            .headers
            .iter()
            .map(|(k, v)| (k.clone(), expand_placeholders(v, &vars)))
            .collect();
        let env_headers: Vec<(String, String)> = env
            .headers
            .iter()
            .map(|(k, v)| (k.clone(), expand_placeholders(v, &vars)))
            .collect();
        let expanded_headers = merge_env_headers(&env_headers, &own_headers);

        let method = Method::from_bytes(req.method.to_uppercase().as_bytes())
            .unwrap_or(Method::GET);

        let timeout = Duration::from_secs(req.timeout_secs.unwrap_or(DEFAULT_TIMEOUT_SECS).max(1));
        let redirect_policy = if req.follow_redirects {
            Policy::limited(10)
        } else {
            Policy::none()
        };
        if req.insecure_tls {
            warnings.push(
                "TLS 证书校验已按请求配置关闭，此请求的流量可被中间人解密".to_string(),
            );
        }



        // Reuse a client per (tls, redirect) combination so the connection pool
        // and TLS session cache actually survive between sends.
        let client: Client = {
            let key = (req.insecure_tls, req.follow_redirects);
            let cached = self
                .clients
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get(&key)
                .cloned();
            match cached {
                Some(c) => c,
                None => {
                    let mut builder = ClientBuilder::new()
                        .cookie_provider(self.cookie_jar())
                        .connect_timeout(Duration::from_secs(CONNECT_TIMEOUT_SECS))
                        .redirect(redirect_policy)
                        // Opt-in per request now. This used to be
                        // unconditionally `true` for every request.
                        .danger_accept_invalid_certs(req.insecure_tls);

                    // Optional proxy from the environment. Kept as-is, but a
                    // malformed value is now reported rather than silently
                    // ignored (a debugging tool must never quietly bypass the
                    // proxy the user thinks it is using).
                    if let Ok(p) = std::env::var("EASY_COPY_HTTP_PROXY") {
                        if !p.is_empty() {
                            match Proxy::all(&p) {
                                Ok(proxy) => builder = builder.proxy(proxy),
                                Err(e) => warnings
                                    .push(format!("代理配置无效，已直连: {p} ({e})")),
                            }
                        }
                    }

                    match builder.build() {
                        Ok(c) => {
                            self.clients
                                .lock()
                                .unwrap_or_else(|e| e.into_inner())
                                .insert(key, c.clone());
                            c
                        }
                        Err(e) => {
                            return error_response(
                                started,
                                format!("HTTP 客户端初始化失败: {e}"),
                                warnings,
                            )
                        }
                    }
                }
            }
        };

        // Per-request timeout goes on the request, not the client, so the
        // cached client stays shared.
        let mut request = client.request(method, &req.url).timeout(timeout);
        for (k, v) in &expanded_headers {
            // A header that reqwest refuses used to vanish without a trace,
            // which is how "I definitely set Authorization" bugs happen.
            // Surface it as a warning attached to the response instead.
            if k.trim().is_empty() {
                continue;
            }
            match (
                header::HeaderName::from_bytes(k.as_bytes()),
                header::HeaderValue::from_str(v),
            ) {
                (Ok(name), Ok(value)) => request = request.header(name, value),
                (Err(_), _) => {
                    warnings.push(format!("请求头名称非法，已跳过: {k}"));
                }
                (_, Err(_)) => {
                    warnings.push(format!(
                        "请求头 {k} 的值含非法字符（如换行或非 ASCII），已跳过"
                    ));
                }
            }
        }

        // Declarative auth → header/query. Applied after explicit headers so an
        // Auth tab selection wins over a stale hand-written header.
        let mut auth_query: Vec<(String, String)> = Vec::new();
        match &req.auth {
            ApiAuth::None => {}
            ApiAuth::Bearer { token } => {
                let token = expand_placeholders(token, &vars);
                if token.trim().is_empty() {
                    warnings.push("Bearer 认证已选择但 token 为空".to_string());
                } else {
                    match header::HeaderValue::from_str(&format!("Bearer {token}")) {
                        Ok(v) => request = request.header(header::AUTHORIZATION, v),
                        Err(_) => warnings.push("Bearer token 含非法字符".to_string()),
                    }
                }
            }
            ApiAuth::Basic { username, password } => {
                let u = expand_placeholders(username, &vars);
                let p = expand_placeholders(password, &vars);
                let encoded =
                    base64::engine::general_purpose::STANDARD.encode(format!("{u}:{p}"));
                match header::HeaderValue::from_str(&format!("Basic {encoded}")) {
                    Ok(v) => request = request.header(header::AUTHORIZATION, v),
                    Err(_) => warnings.push("Basic 认证凭据含非法字符".to_string()),
                }
            }
            ApiAuth::ApiKey { key, value, location } => {
                let k = expand_placeholders(key, &vars);
                let v = expand_placeholders(value, &vars);
                if k.trim().is_empty() {
                    warnings.push("API Key 认证已选择但键名为空".to_string());
                } else if location == "query" {
                    auth_query.push((k, v));
                } else {
                    match (
                        header::HeaderName::from_bytes(k.as_bytes()),
                        header::HeaderValue::from_str(&v),
                    ) {
                        (Ok(n), Ok(hv)) => request = request.header(n, hv),
                        _ => warnings.push(format!("API Key 头 {k} 非法，已跳过")),
                    }
                }
            }
        }

        // Append query params.
        let mut qp: Vec<(String, String)> = req
            .query
            .iter()
            .map(|(k, v)| (k.clone(), expand_placeholders(v, &vars)))
            .collect();
        qp.extend(auth_query);
        if !qp.is_empty() {
            request = request.query(&qp);
        }

        // Build body based on body_type.
        let bt = if req.body_type.is_empty() { "none" } else { &req.body_type };
        match bt {
            "raw" => {
                let content = req.body.as_deref().unwrap_or("");
                let content = expand_placeholders(content, &vars);
                let ct = match req.body_raw_lang.as_str() {
                    "json" => "application/json",
                    "xml" => "application/xml",
                    "javascript" => "application/javascript",
                    "text" => "text/plain",
                    "html" => "text/html",
                    _ => "text/plain",
                };
                // Don't clobber an explicit Content-Type from the headers tab.
                let has_explicit_ct = expanded_headers
                    .iter()
                    .any(|(k, _)| k.eq_ignore_ascii_case("content-type"));
                if !has_explicit_ct {
                    request = request.header("content-type", ct);
                }
                if !content.is_empty() {
                    request = request.body(content);
                }
            }
            "form-data" => {
                let mut form = reqwest::multipart::Form::new();
                for f in &req.form_data {
                    let key = expand_placeholders(&f.key, &vars);
                    if f.field_type == "file" {
                        let path = match &f.file_path {
                            Some(p) if !p.trim().is_empty() => p,
                            _ => {
                                return error_response(
                                    started,
                                    format!("form-data 字段 {key} 是文件类型但未选择文件"),
                                    warnings,
                                );
                            }
                        };
                        // A read failure used to be swallowed by `if let Ok`,
                        // so the request went out *missing the part* and the
                        // user saw an inexplicable 400 from the server.
                        let bytes = match fs::read(path) {
                            Ok(b) => b,
                            Err(e) => {
                                return error_response(
                                    started,
                                    format!("读取上传文件失败 ({path}): {e}"),
                                    warnings,
                                );
                            }
                        };
                        let file_name = f.file_name.clone().or_else(|| {
                            std::path::Path::new(path)
                                .file_name()
                                .map(|n| n.to_string_lossy().into_owned())
                        });
                        let part = reqwest::multipart::Part::bytes(bytes);
                        let part = if let Some(name) = file_name {
                            part.file_name(name)
                        } else {
                            part
                        };
                        form = form.part(key, part);
                    } else {
                        let value = expand_placeholders(&f.value, &vars);
                        form = form.text(key, value);
                    }
                }
                request = request.multipart(form);
            }
            "urlencoded" => {
                let params: Vec<(String, String)> = req.url_encoded.iter()
                    .map(|(k, v)| (k.clone(), expand_placeholders(v, &vars)))
                    .collect();
                request = request.form(&params);
            }
            "binary" | "msgpack" => {
                let (path_opt, ct) = if bt == "binary" {
                    (&req.binary_file, "application/octet-stream")
                } else {
                    (&req.msgpack_file, "application/msgpack")
                };
                let path = match path_opt {
                    Some(p) if !p.trim().is_empty() => p,
                    _ => {
                        return error_response(
                            started,
                            format!("body 类型为 {bt} 但未选择文件"),
                            warnings,
                        );
                    }
                };
                let bytes = match fs::read(path) {
                    Ok(b) => b,
                    Err(e) => {
                        return error_response(
                            started,
                            format!("读取请求体文件失败 ({path}): {e}"),
                            warnings,
                        );
                    }
                };
                request = request.header("content-type", ct).body(bytes);
            }
            _ => {
                // "none" or legacy: fall back to raw body text if present.
                if let Some(body) = &req.body {
                    if !body.is_empty() {
                        let body = expand_placeholders(body, &vars);
                        request = request.body(body);
                    }
                }
            }
        }

        // Snapshot the *actual* headers by building the request first. The
        // previous version recorded `expanded_headers` — the user-typed set —
        // which silently omitted everything added afterwards: the Auth tab's
        // Authorization, the body's Content-Type, plus the host / accept /
        // user-agent / cookie headers reqwest fills in itself. A debugging
        // tool showing a request that differs from the one on the wire is
        // worse than showing nothing, so read them off the built request.
        let built = match request.build() {
            Ok(r) => r,
            Err(e) => {
                return error_response(started, format!("构建请求失败: {e}"), warnings);
            }
        };
        let mut sent_headers: Vec<(String, String)> = built
            .headers()
            .iter()
            .map(|(k, v)| {
                (
                    k.as_str().to_string(),
                    // Non-UTF8 header values are legal on the wire; show a
                    // lossy rendering rather than dropping the row.
                    v.to_str()
                        .map(str::to_string)
                        .unwrap_or_else(|_| String::from_utf8_lossy(v.as_bytes()).into_owned()),
                )
            })
            .collect();

        // Cookies are attached by reqwest's cookie middleware during `execute`,
        // i.e. after `build()`, so they are absent from the snapshot above.
        // A stale jar cookie changing a response is exactly the case this tab
        // exists to diagnose — add what the jar will send, unless the request
        // already carries a hand-written Cookie header (which wins).
        if !sent_headers
            .iter()
            .any(|(k, _)| k.eq_ignore_ascii_case("cookie"))
        {
            let jar_cookies = self.cookies_for(&req.url);
            if !jar_cookies.is_empty() {
                sent_headers.push(("cookie".to_string(), jar_cookies.join("; ")));
            }
        }

        // hyper adds the transport-level headers while writing the request to
        // the socket — they exist on neither the builder nor the built
        // `Request`, so a request with no user headers would otherwise render
        // an empty tab (which reads as "the tool is broken"). Reconstruct the
        // ones whose values are fully determined by the request we just built,
        // and mark them so nobody mistakes them for something they typed.
        if let Some(host) = built.url().host_str() {
            let authority = match built.url().port() {
                // Only a non-default port appears in the Host header.
                Some(p) => format!("{host}:{p}"),
                None => host.to_string(),
            };
            add_implicit_header(&mut sent_headers, "host", &authority);
        }
        add_implicit_header(&mut sent_headers, "accept", "*/*");
        // Set by the `gzip`/`brotli`/`deflate` features; reqwest asks for
        // whatever it can transparently decode.
        add_implicit_header(&mut sent_headers, "accept-encoding", "gzip, br, deflate");
        if let Some(len) = built.body().and_then(|b| b.as_bytes()).map(<[u8]>::len) {
            add_implicit_header(&mut sent_headers, "content-length", &len.to_string());
        }

        let response = match client.execute(built).await {
            Ok(r) => r,
            Err(e) => {
                // Distinguish the timeout case explicitly — it's by far the
                // most common failure and "send: ..." told the user nothing.
                let msg = if e.is_timeout() {
                    format!("请求超时（{} 秒），可在设置中调整超时时间", timeout.as_secs())
                } else if e.is_connect() {
                    format!("连接失败: {e}")
                } else if e.is_builder() {
                    // reqwest's Display for builder errors is the literal
                    // string "builder error" — the actual cause (usually a
                    // malformed URL) only lives in the source chain. A URL
                    // with no scheme/host is the overwhelmingly common case,
                    // so name it outright instead of leaking `url` internals.
                    format!(
                        "URL 无效: {}。请填写完整地址（含 http:// 或 https://），\
                         若使用了 {{{{变量}}}} 请确认当前环境已激活且变量已定义",
                        error_chain(&e)
                    )
                } else {
                    format!("发送失败: {}", error_chain(&e))
                };
                return error_response(started, msg, warnings);
            }
        };

        let status = response.status();
        let status_text = status.canonical_reason().unwrap_or("").to_string();
        let headers: Vec<(String, String)> = response
            .headers()
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
            .collect();
        let final_url = {
            let u = response.url().to_string();
            if u == req.url { None } else { Some(u) }
        };
        let content_type = response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();

        // Stream the body with a hard cap. `response.text()` buffered the whole
        // payload before truncating, so a huge download was an OOM, and it also
        // lossily UTF-8-decoded binary responses into mojibake.
        let mut buf: Vec<u8> = Vec::new();
        let mut truncated = false;
        let mut total: u64 = 0;
        let mut read_error: Option<String> = None;
        {
            let mut stream = response.bytes_stream();
            while let Some(chunk) = stream.next().await {
                match chunk {
                    Ok(bytes) => {
                        total += bytes.len() as u64;
                        if buf.len() < MAX_BODY_BYTES {
                            let room = MAX_BODY_BYTES - buf.len();
                            if bytes.len() > room {
                                buf.extend_from_slice(&bytes[..room]);
                                truncated = true;
                                // Stop pulling: we have all we're going to show.
                                break;
                            }
                            buf.extend_from_slice(&bytes);
                        } else {
                            truncated = true;
                            break;
                        }
                    }
                    Err(e) => {
                        read_error = Some(format!("读取响应体失败: {e}"));
                        break;
                    }
                }
            }
        }

        let looks_binary = is_binary_content(&content_type, &buf);
        let body = if looks_binary {
            // Hand back base64 so the front-end can offer a download / hex view
            // instead of rendering broken glyphs.
            Some(base64::engine::general_purpose::STANDARD.encode(&buf))
        } else {
            let text = String::from_utf8_lossy(&buf).into_owned();
            let capped = truncate(&text, MAX_BODY_TEXT_BYTES);
            if capped.len() < text.len() {
                truncated = true;
            }
            Some(capped)
        };
        if truncated {
            warnings.push(format!(
                "响应体过大，已截断显示（实际 {} 字节）",
                total
            ));
        }

        ApiResponse {
            status: status.as_u16(),
            status_text,
            headers,
            request_headers: sent_headers,
            body,
            duration_ms: started.elapsed().as_millis() as u64,
            timestamp: chrono::Utc::now().timestamp_millis(),
            error: read_error,
            warnings,
            is_binary: looks_binary,
            body_size: total,
            truncated,
            final_url,
        }
    }

    /// Snapshot the cookies the shared jar currently holds for `url`.
    ///
    /// The jar has always been silently accumulating cookies across requests
    /// with no way for the user to see or clear them — a debugging trap when a
    /// stale session cookie makes a request behave differently than the same
    /// request in a browser.
    pub fn cookies_for(&self, url: &str) -> Vec<String> {
        let parsed = match url.parse::<reqwest::Url>() {
            Ok(u) => u,
            Err(_) => return Vec::new(),
        };
        match self.cookie_jar().cookies(&parsed) {
            Some(v) => v
                .to_str()
                .unwrap_or("")
                .split(';')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect(),
            None => Vec::new(),
        }
    }

    /// Drop every cookie by swapping in a fresh jar.
    ///
    /// `Jar` exposes no clear API, so we replace the whole thing. Held behind
    /// a `Mutex` because the client builder clones the `Arc` per request.
    pub fn clear_cookies(&self) {
        *self.cookie_jar_slot.lock().unwrap_or_else(|e| e.into_inner()) = Arc::new(Jar::default());
    }
}

fn error_response(started: Instant, msg: String, warnings: Vec<String>) -> ApiResponse {
    ApiResponse {
        status: 0,
        status_text: "ERROR".into(),
        headers: vec![],
        request_headers: vec![],
        body: None,
        duration_ms: started.elapsed().as_millis() as u64,
        timestamp: chrono::Utc::now().timestamp_millis(),
        error: Some(msg),
        warnings,
        is_binary: false,
        body_size: 0,
        truncated: false,
        final_url: None,
    }
}

/// Decide whether a body should be treated as opaque bytes.
///
/// Two signals: an explicitly non-text `Content-Type`, or a NUL byte in the
/// first few KB (no text format contains one, every binary format does).
fn is_binary_content(content_type: &str, body: &[u8]) -> bool {
    let ct = content_type.to_ascii_lowercase();
    let ct = ct.split(';').next().unwrap_or("").trim();
    if !ct.is_empty() {
        let textual = ct.starts_with("text/")
            || ct == "application/json"
            || ct == "application/xml"
            || ct == "application/javascript"
            || ct == "application/x-www-form-urlencoded"
            || ct.ends_with("+json")
            || ct.ends_with("+xml");
        if textual {
            return false;
        }
        // Known-binary families short-circuit before we sniff.
        if ct.starts_with("image/")
            || ct.starts_with("audio/")
            || ct.starts_with("video/")
            || ct.starts_with("font/")
            || ct == "application/octet-stream"
            || ct == "application/pdf"
            || ct == "application/zip"
            || ct == "application/msgpack"
            || ct == "application/protobuf"
        {
            return true;
        }
    }
    let probe = &body[..body.len().min(8192)];
    probe.contains(&0)
}

/// Substitute `:name` path variables in a URL.
///
/// This is the **production** implementation. It used to live inline in
/// `execute` while the test module carried a hand-copied duplicate — so the
/// tests could keep passing while the real code drifted. Single source now.
///
/// Boundary rule: a variable name ends at the first character that isn't a
/// letter, digit, `_`, `.`, `-` or `~`. This is the exact dual of the
/// front-end regex `:[A-Za-z_][\p{L}\p{N}_.\-~]*` in `ApiApp.tsx`. The old
/// backend rule only accepted `/ ? # :` and end-of-string as boundaries, so a
/// URL like `/api/:id=1` or `/x/:id&y` never got substituted and the literal
/// `:id` was sent to the server.
///
/// `https://host:8080/p` is safe without a special case: `8080` starts with a
/// digit, and a caller's `path_vars` key would have to literally be `8080` to
/// match — which the front-end can't produce.
fn substitute_path_vars(url: &str, path_vars: &[(String, String)]) -> String {
    fn is_name_char(c: char) -> bool {
        c.is_alphanumeric() || matches!(c, '_' | '.' | '-' | '~')
    }

    let mut out = url.to_string();
    for (k, v) in path_vars {
        // An empty key would make the needle a bare `:`, matching every colon
        // in the URL (including the scheme separator).
        if k.is_empty() {
            continue;
        }
        let needle = format!(":{k}");
        let mut result = String::with_capacity(out.len());
        let mut rest = out.as_str();
        while let Some(pos) = rest.find(&needle) {
            let after = &rest[pos + needle.len()..];
            let boundary = after.chars().next().map_or(true, |c| !is_name_char(c));
            result.push_str(&rest[..pos]);
            if boundary {
                result.push_str(v);
            } else {
                // Partial match (`:id` inside `:identifier`) — keep it verbatim.
                result.push_str(&needle);
            }
            rest = after;
        }
        result.push_str(rest);
        out = result;
    }
    out
}

/// Record a header hyper will add at the transport layer.
///
/// These never appear on the built `Request`, so the "请求头" tab has to
/// reconstruct them or show a misleading empty list. Anything the user (or an
/// environment) set explicitly always wins: a hand-written `Host` override is
/// precisely the kind of thing someone inspects this tab to confirm.
fn add_implicit_header(headers: &mut Vec<(String, String)>, name: &str, value: &str) {
    if headers.iter().any(|(k, _)| k.eq_ignore_ascii_case(name)) {
        return;
    }
    headers.push((name.to_string(), value.to_string()));
}

/// Flatten an error and its `source()` chain into one line.
///
/// `reqwest::Error`'s `Display` is often a useless category label — a
/// malformed URL renders as just "builder error", with the real reason
/// ("relative URL without a base") buried one level down. Callers show
/// this to users, so the chain is what actually matters.
fn error_chain(e: &dyn std::error::Error) -> String {
    let mut parts = vec![e.to_string()];
    let mut cur = e.source();
    while let Some(s) = cur {
        let text = s.to_string();
        // reqwest sometimes repeats the parent's text verbatim.
        if !parts.iter().any(|p| p == &text) {
            parts.push(text);
        }
        cur = s.source();
    }
    parts.join(": ")
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    // Truncate at char boundary.
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…<truncated {} bytes>", &s[..end], s.len() - end)
}

fn expand_placeholders(input: &str, vars: &HashMap<String, String>) -> String {
    let bytes = input.as_bytes();
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    while i < bytes.len() {
        if i + 1 < bytes.len() && bytes[i] == b'{' && bytes[i + 1] == b'{' {
            // Find closing `}}`.
            if let Some(close) = find_close(&bytes[i + 2..]) {
                let name = std::str::from_utf8(&bytes[i + 2..i + 2 + close])
                    .unwrap_or("")
                    .trim();
                if let Some(value) = vars.get(name) {
                    out.push_str(value);
                } else {
                    // Leave untouched.
                    out.push_str(&input[i..i + 2 + close + 2]);
                }
                i += 2 + close + 2;
                continue;
            }
        }
        out.push(input[i..].chars().next().unwrap());
        i += input[i..].chars().next().unwrap().len_utf8() as usize;
    }
    out
}

/// Merge the active environment's shared headers with the request's own.
///
/// Rules, in order of precedence:
///   1. **The request wins.** A header set on the request overrides the env's
///      value for the same name — nearest definition wins, which is what the
///      user sees in front of them when they hit Send.
///   2. **Empty value means "drop it"** — but only when it actually shadows an
///      env header. Writing the header name on the request with a blank value
///      removes the inherited one instead of sending an empty header; without
///      this there is no way to opt a single request out of an env-wide
///      `Authorization`. A blank-valued header that shadows nothing is passed
///      through untouched, preserving the pre-env behaviour.
///   3. Env headers come first in the output so the inherited context reads
///      before the request-specific overrides.
///
/// Name comparison is case-insensitive per RFC 7230; the request's spelling is
/// the one that survives. Blank names are skipped on both sides.
fn merge_env_headers(
    env_headers: &[(String, String)],
    req_headers: &[(String, String)],
) -> Vec<(String, String)> {
    let overridden: HashMap<String, String> = req_headers
        .iter()
        .filter(|(k, _)| !k.trim().is_empty())
        .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.clone()))
        .collect();

    let env_names: std::collections::HashSet<String> = env_headers
        .iter()
        .filter(|(k, _)| !k.trim().is_empty())
        .map(|(k, _)| k.trim().to_ascii_lowercase())
        .collect();

    let mut out: Vec<(String, String)> = Vec::with_capacity(env_headers.len() + req_headers.len());
    for (k, v) in env_headers {
        if k.trim().is_empty() {
            continue;
        }
        // Skipped here when overridden; the request's own entry is appended
        // below, so the value the user typed is the one that goes out.
        if !overridden.contains_key(&k.trim().to_ascii_lowercase()) {
            out.push((k.trim().to_string(), v.clone()));
        }
    }
    for (k, v) in req_headers {
        if k.trim().is_empty() {
            continue;
        }
        // Rule 2: blank value is a deletion marker — but only against an env
        // header. Shadowing nothing, it stays a plain (if odd) empty header,
        // exactly as it behaved before environments could carry headers.
        if v.trim().is_empty() && env_names.contains(&k.trim().to_ascii_lowercase()) {
            continue;
        }
        out.push((k.clone(), v.clone()));
    }
    out
}

/// Join an environment base URL with a request URL.
///
/// Absolute request URLs (`http://`, `https://`) win outright — an explicit
/// address in the URL bar must never be silently rewritten by whichever
/// environment happens to be active. Everything else is treated as a path and
/// appended to `base`.
///
/// The slash handling is deliberately tolerant: users type `{{host}}` values
/// with and without a trailing slash, and paths with and without a leading
/// one. Collapsing the seam here is what prevents the `orders//order-tracking`
/// class of double-slash bugs.
fn join_base_url(base: &str, url: &str) -> String {
    let base = base.trim();
    let url = url.trim();
    if base.is_empty() {
        return url.to_string();
    }
    let lower = url.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        return url.to_string();
    }
    if url.is_empty() {
        return base.to_string();
    }
    format!("{}/{}", base.trim_end_matches('/'), url.trim_start_matches('/'))
}

fn find_close(bytes: &[u8]) -> Option<usize> {    let mut i = 0;
    while i + 1 < bytes.len() {
        if bytes[i] == b'}' && bytes[i + 1] == b'}' {
            return Some(i);
        }
        i += 1;
    }
    None
}

fn collect_descendants(nodes: &[ApiNode], root_id: &str) -> Vec<String> {
    let mut out = vec![root_id.to_string()];
    let mut changed = true;
    while changed {
        changed = false;
        let current_len = out.len();
        for n in nodes {
            if let Some(parent) = &n.parent_id {
                if out.contains(parent) && !out.contains(&n.id) {
                    out.push(n.id.clone());
                }
            }
        }
        if out.len() != current_len {
            changed = true;
        }
    }
    out
}

// ── Tauri commands ─────────────────────────────────────────────

#[tauri::command]
pub fn api_load_state(store: tauri::State<'_, Arc<ApiStore>>) -> Result<ApiState, String> {
    Ok(store.state.lock().unwrap_or_else(|e| e.into_inner()).clone())
}

#[tauri::command]
pub fn api_save_node(
    node: ApiNode,
    store: tauri::State<'_, Arc<ApiStore>>,
) -> Result<ApiNode, String> {
    Ok(store.upsert_node(node))
}

#[tauri::command]
pub fn api_delete_node(id: String, store: tauri::State<'_, Arc<ApiStore>>) -> Result<(), String> {
    store.delete_node(&id);
    Ok(())
}

#[tauri::command]
pub fn api_save_env(
    env: ApiEnvironment,
    store: tauri::State<'_, Arc<ApiStore>>,
) -> Result<ApiEnvironment, String> {
    Ok(store.upsert_env(env))
}

#[tauri::command]
pub fn api_delete_env(id: String, store: tauri::State<'_, Arc<ApiStore>>) -> Result<(), String> {
    store.delete_env(&id);
    Ok(())
}

#[tauri::command]
pub async fn api_execute(
    request: ApiRequest,
    store: tauri::State<'_, Arc<ApiStore>>,
) -> Result<ApiResponse, String> {
    Ok(store.execute(request).await)
}

/// List the cookies the shared jar holds for a URL.
///
/// The jar was previously invisible: it accumulated session cookies across
/// requests with no UI to inspect or reset them, so a stale cookie could make
/// an identical request behave differently than in a browser.
#[tauri::command]
pub async fn api_list_cookies(
    url: String,
    store: tauri::State<'_, Arc<ApiStore>>,
) -> Result<Vec<String>, String> {
    Ok(store.cookies_for(&url))
}

#[tauri::command]
pub async fn api_clear_cookies(store: tauri::State<'_, Arc<ApiStore>>) -> Result<(), String> {
    store.clear_cookies();
    Ok(())
}

/// Strip everything that could redirect the write outside the target folder.
///
/// `Content-Disposition` is attacker-controlled: a server can answer with
/// `filename="../../autorun.inf"`. We only ever want the final component, so
/// take the segment after the last separator and drop the characters Windows
/// rejects in file names. Reserved device names (CON, PRN, ...) would still be
/// refused by the OS, but they can't escape the directory, so a failed write is
/// an acceptable outcome there.
fn sanitize_filename(raw: &str) -> Option<String> {
    let last = raw
        .rsplit(|c| c == '/' || c == '\\' || c == ':')
        .next()
        .unwrap_or("");
    let cleaned: String = last
        .chars()
        .filter(|c| !matches!(c, '<' | '>' | '"' | '|' | '?' | '*') && !c.is_control())
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').trim();
    // "." and ".." collapse to empty here, which is exactly what we want.
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// Pull a file name out of a `Content-Disposition` header value.
///
/// Handles the two forms that appear in the wild:
///   - `attachment; filename="report.xlsx"` (optionally unquoted)
///   - `attachment; filename*=UTF-8''report%20final.xlsx` (RFC 5987)
///
/// The starred form wins when both are present, since that's the one carrying
/// non-ASCII names. Percent-decoding is done by hand because the crate we'd
/// normally reach for isn't a dependency here.
fn filename_from_disposition(value: &str) -> Option<String> {
    let mut plain: Option<String> = None;

    for part in value.split(';') {
        let part = part.trim();
        let (key, val) = match part.split_once('=') {
            Some(kv) => kv,
            None => continue,
        };
        let key = key.trim().to_ascii_lowercase();
        let val = val.trim();

        if key == "filename*" {
            // charset'language'percent-encoded-value
            let encoded = val.rsplit('\'').next().unwrap_or(val);
            if let Some(name) = sanitize_filename(&percent_decode(encoded)) {
                return Some(name);
            }
        } else if key == "filename" && plain.is_none() {
            let unquoted = val.trim_matches('"');
            plain = sanitize_filename(unquoted);
        }
    }

    plain
}

/// Minimal `%XX` decoder for RFC 5987 header values, UTF-8 aware.
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            if let (Some(hi), Some(lo)) = (hi, lo) {
                out.push((hi * 16 + lo) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Guess an extension from the MIME type for servers that send no
/// `Content-Disposition` at all. Deliberately a short list: a wrong extension
/// is worse than none, because Windows would then open the file with the wrong
/// program.
fn extension_for_mime(content_type: &str) -> Option<&'static str> {
    let mime = content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let ext = match mime.as_str() {
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" => "xlsx",
        "application/vnd.ms-excel" => "xls",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document" => "docx",
        "application/msword" => "doc",
        "application/pdf" => "pdf",
        "application/zip" | "application/x-zip-compressed" => "zip",
        "application/gzip" => "gz",
        "application/octet-stream" => "bin",
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/svg+xml" => "svg",
        "text/csv" => "csv",
        _ => return None,
    };
    Some(ext)
}

/// Decide the name to save a binary response under.
///
/// Priority: `Content-Disposition` → last path segment of the URL → a generic
/// stem. An extension is appended from the MIME type only when the chosen name
/// doesn't already carry one, so a server-provided `report.xlsx` is never
/// mangled into `report.xlsx.bin`.
fn suggest_download_name(
    headers: &[(String, String)],
    url: &str,
    content_type: &str,
) -> String {
    let disposition = headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("content-disposition"))
        .and_then(|(_, v)| filename_from_disposition(v));

    if let Some(name) = disposition {
        return name;
    }

    // Fall back to the URL's last path segment, ignoring query and fragment.
    let path_part = url
        .split(['?', '#'])
        .next()
        .unwrap_or("")
        .trim_end_matches('/');
    let from_url = path_part
        .rsplit('/')
        .next()
        .and_then(|s| sanitize_filename(s))
        .filter(|s| !s.is_empty());

    let stem = from_url.unwrap_or_else(|| "download".to_string());
    let has_ext = std::path::Path::new(&stem)
        .extension()
        .is_some_and(|e| !e.is_empty());

    match (has_ext, extension_for_mime(content_type)) {
        (false, Some(ext)) => format!("{stem}.{ext}"),
        _ => stem,
    }
}

/// Starting folder for the save dialog. No `dirs` crate in the tree, so resolve
/// the profile directory manually. Purely a convenience hint — we deliberately
/// don't create it, because seeding a dialog is no reason to make folders on the
/// user's disk.
fn downloads_dir() -> Result<PathBuf, String> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map_err(|_| "找不到用户目录（USERPROFILE / HOME 均未设置）".to_string())?;
    let dir = PathBuf::from(home).join("Downloads");
    if dir.is_dir() {
        Ok(dir)
    } else {
        Err("下载目录不存在".to_string())
    }
}

/// Save a binary response body to a location the user picks.
///
/// The body arrives as base64 because that's how `execute` hands binary
/// payloads to the front-end (see the `looks_binary` branch there). We decode
/// straight to bytes and write those — the data never passes through a UTF-8
/// conversion, which is what used to turn downloads into corrupted files.
///
/// `rfd` is used rather than a dialog plugin because it's already a direct
/// dependency (see `select_folder` in lib.rs) and this feature must not add one.
/// The dialog handles the overwrite confirmation for us, so there's no
/// de-duplicating of names here.
///
/// Returns the full path written, or `Ok(None)` when the user cancels —
/// cancelling is a normal outcome, not an error the UI should shout about.
#[tauri::command]
pub fn api_save_binary_body(
    body_base64: String,
    url: String,
    headers: Vec<(String, String)>,
) -> Result<Option<String>, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(body_base64.as_bytes())
        .map_err(|e| format!("响应体解码失败：{e}"))?;

    if bytes.is_empty() {
        return Err("响应体为空，无内容可保存。".to_string());
    }

    let content_type = headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("content-type"))
        .map(|(_, v)| v.as_str())
        .unwrap_or("");

    let name = suggest_download_name(&headers, &url, content_type);

    let mut dialog = rfd::FileDialog::new()
        .set_title("保存响应体")
        .set_file_name(&name);
    // Only steer the dialog's starting folder if we can actually resolve one;
    // a missing profile dir shouldn't block the save outright.
    if let Ok(dir) = downloads_dir() {
        dialog = dialog.set_directory(dir);
    }

    let target = match dialog.save_file() {
        Some(path) => path,
        None => return Ok(None),
    };

    fs::write(&target, &bytes).map_err(|e| format!("写入文件失败：{e}"))?;

    Ok(Some(target.to_string_lossy().into_owned()))
}

/// Reveal a previously saved file using the opener plugin already in the tree.
#[tauri::command]
pub fn api_reveal_path(app: tauri::AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let p = std::path::Path::new(&path);
    // Open the containing folder rather than the file itself: launching an
    // arbitrary downloaded document is a bigger action than the user asked for.
    let target = p.parent().unwrap_or(p);
    app.opener()
        .open_path(target.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| format!("打开文件夹失败：{e}"))
}

// ============================================================
// Unit tests for file-private helpers in api.rs.
//
// These helpers are the guts of the API platform's request pipeline
// (placeholder expansion, body truncation, tree cascade delete) and
// are pure / sync / no-Tauri — exactly the right shape for a unit
// test. We don't test `execute` itself here because it requires a
// live reqwest client; that belongs in an integration test.
// ============================================================
#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::ApiNodeType;
    use std::collections::HashMap;

    /// `build()` exposes only explicitly-set headers.
    ///
    /// Verified by experiment: host / accept / user-agent / accept-encoding
    /// are added by hyper while writing to the socket, so they are absent
    /// here. This is why `execute` reconstructs them via
    /// `add_implicit_header` — without that, a request carrying no custom
    /// headers renders an empty "请求头" tab.
    #[test]
    fn build_exposes_only_explicit_headers() {
        let client = reqwest::Client::new();
        let built = client
            .get("http://example.com/x")
            .header("x-mine", "1")
            .build()
            .expect("build");
        let names: Vec<String> = built
            .headers()
            .iter()
            .map(|(k, _)| k.as_str().to_string())
            .collect();
        assert_eq!(names, vec!["x-mine".to_string()]);
    }

    #[test]
    fn implicit_headers_do_not_override_explicit_ones() {
        let mut h = hs(&[("Host", "custom.example")]);
        add_implicit_header(&mut h, "host", "real.example");
        add_implicit_header(&mut h, "accept", "*/*");
        // The user's Host survives, case-insensitively matched.
        assert_eq!(h[0], ("Host".to_string(), "custom.example".to_string()));
        // A header nobody set is appended.
        assert_eq!(h[1], ("accept".to_string(), "*/*".to_string()));
        assert_eq!(h.len(), 2);
    }

    fn vars(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    // ── env shared headers ─────────────────────────────────────

    fn hs(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn merge_env_headers_inherits_when_request_is_silent() {
        let out = merge_env_headers(
            &hs(&[("Authorization", "Bearer t"), ("X-Tenant", "acme")]),
            &hs(&[("Accept", "application/json")]),
        );
        assert_eq!(
            out,
            hs(&[
                ("Authorization", "Bearer t"),
                ("X-Tenant", "acme"),
                ("Accept", "application/json"),
            ])
        );
    }

    #[test]
    fn merge_env_headers_request_wins_case_insensitively() {
        // The request's spelling and value survive; the env entry vanishes
        // rather than being sent twice.
        let out = merge_env_headers(
            &hs(&[("Authorization", "Bearer env")]),
            &hs(&[("authorization", "Bearer own")]),
        );
        assert_eq!(out, hs(&[("authorization", "Bearer own")]));
    }

    #[test]
    fn merge_env_headers_blank_value_opts_out() {
        // The escape hatch: one request needs to be anonymous.
        let out = merge_env_headers(
            &hs(&[("Authorization", "Bearer env"), ("X-Tenant", "acme")]),
            &hs(&[("Authorization", "  ")]),
        );
        assert_eq!(out, hs(&[("X-Tenant", "acme")]));
    }

    #[test]
    fn merge_env_headers_blank_value_shadowing_nothing_is_kept() {
        // Regression guard: opting out must not change how a plain empty
        // header behaved before environments could carry headers at all.
        let out = merge_env_headers(&[], &hs(&[("X-Debug", "")]));
        assert_eq!(out, hs(&[("X-Debug", "")]));
    }

    #[test]
    fn merge_env_headers_skips_blank_names() {
        let out = merge_env_headers(&hs(&[("", "ignored")]), &hs(&[("  ", "also")]));
        assert!(out.is_empty());
    }

    #[test]
    fn merge_env_headers_without_env_is_identity() {
        let own = hs(&[("Accept", "*/*"), ("X-A", "1")]);
        assert_eq!(merge_env_headers(&[], &own), own);
    }

    // ── per-request env binding ────────────────────────────────
    // Envs bind per request via `ApiRequest::env_id`; there is no global
    // "active env". These pin the three resolution outcomes.

    fn store_with_env() -> ApiStore {
        let store = ApiStore::new(None);
        store.upsert_env(ApiEnvironment {
            id: "dev".to_string(),
            name: "Dev".to_string(),
            base_url: "http://dev.test".to_string(),
            headers: vec![("X-Env".to_string(), "dev".to_string())],
            vars: vec![("token".to_string(), "abc".to_string())],
        });
        store
    }

    #[test]
    fn env_snapshot_resolves_the_requests_own_env() {
        let store = store_with_env();
        let snap = store.env_snapshot(Some("dev"));
        assert_eq!(snap.base_url, "http://dev.test");
        assert_eq!(snap.headers, hs(&[("X-Env", "dev")]));
        assert_eq!(snap.vars.get("token").map(String::as_str), Some("abc"));
    }

    #[test]
    fn env_snapshot_without_binding_is_empty() {
        // "No env bound" means send exactly what the user typed: no base
        // prepended, no shared headers, placeholders left literal.
        let store = store_with_env();
        let snap = store.env_snapshot(None);
        assert!(snap.base_url.is_empty());
        assert!(snap.headers.is_empty());
        assert!(snap.vars.is_empty());
        assert_eq!(join_base_url(&snap.base_url, "/api/x"), "/api/x");
        assert_eq!(merge_env_headers(&snap.headers, &hs(&[("A", "1")])), hs(&[("A", "1")]));
    }

    #[test]
    fn env_snapshot_with_dangling_id_degrades_to_no_env() {
        // Deleting an env leaves referencing requests with a stale id. That
        // must behave as "unbound", not panic or resurrect anything.
        let store = store_with_env();
        store.delete_env("dev");
        let snap = store.env_snapshot(Some("dev"));
        assert!(snap.base_url.is_empty());
        assert!(snap.headers.is_empty());
        assert!(snap.vars.is_empty());
    }

    #[test]
    fn env_snapshot_keeps_sibling_envs_apart() {
        // Two requests sent back to back may resolve different envs; one
        // must never pick up the other's base or headers.
        let store = store_with_env();
        store.upsert_env(ApiEnvironment {
            id: "prod".to_string(),
            name: "Prod".to_string(),
            base_url: "https://prod.test".to_string(),
            headers: vec![("X-Env".to_string(), "prod".to_string())],
            vars: vec![("token".to_string(), "zzz".to_string())],
        });
        let dev = store.env_snapshot(Some("dev"));
        let prod = store.env_snapshot(Some("prod"));
        assert_eq!(dev.base_url, "http://dev.test");
        assert_eq!(prod.base_url, "https://prod.test");
        assert_eq!(prod.headers, hs(&[("X-Env", "prod")]));
        assert_eq!(prod.vars.get("token").map(String::as_str), Some("zzz"));
    }

    // ── env base URL joining ───────────────────────────────────

    #[test]
    fn join_base_url_leaves_absolute_urls_alone() {
        // An explicit address must never be rewritten by the active env,
        // whatever the base says — this is the safety property of the feature.
        let base = "http://10.61.107.5:2001";
        assert_eq!(join_base_url(base, "https://example.com/x"), "https://example.com/x");
        assert_eq!(join_base_url(base, "http://other:8080/y"), "http://other:8080/y");
        // Scheme detection is case-insensitive.
        assert_eq!(join_base_url(base, "HTTPS://example.com/z"), "HTTPS://example.com/z");
    }

    #[test]
    fn join_base_url_prepends_relative_paths() {
        let base = "http://10.61.107.5:2001";
        assert_eq!(
            join_base_url(base, "/front-api/orders"),
            "http://10.61.107.5:2001/front-api/orders"
        );
        // Missing leading slash is just as common as having one.
        assert_eq!(
            join_base_url(base, "front-api/orders"),
            "http://10.61.107.5:2001/front-api/orders"
        );
    }

    #[test]
    fn join_base_url_collapses_the_seam() {
        // Trailing slash on the base plus leading slash on the path is the
        // exact combination that used to produce `host//path`.
        assert_eq!(
            join_base_url("http://h:1/", "/api/x"),
            "http://h:1/api/x"
        );
        assert_eq!(join_base_url("http://h:1///", "///api/x"), "http://h:1/api/x");
    }

    #[test]
    fn join_base_url_without_base_is_identity() {
        // No env active, or env with an empty base: behave exactly as before.
        assert_eq!(join_base_url("", "/api/x"), "/api/x");
        assert_eq!(join_base_url("   ", "/api/x"), "/api/x");
        assert_eq!(join_base_url("", "http://a/b"), "http://a/b");
    }

    #[test]
    fn join_base_url_with_empty_url_yields_base() {
        assert_eq!(join_base_url("http://h:1", ""), "http://h:1");
        assert_eq!(join_base_url("http://h:1/", "  "), "http://h:1/");
    }

    // ── binary download naming ─────────────────────────────────
    // A malicious or careless server controls Content-Disposition, so these
    // guard the path-traversal filter as much as the happy path.

    #[test]
    fn sanitize_filename_strips_directory_traversal() {
        assert_eq!(
            sanitize_filename("../../autorun.inf").as_deref(),
            Some("autorun.inf")
        );
        assert_eq!(
            sanitize_filename(r"..\..\windows\system32\evil.dll").as_deref(),
            Some("evil.dll")
        );
        assert_eq!(sanitize_filename("C:/Windows/hosts").as_deref(), Some("hosts"));
        // Pure traversal segments carry no name at all.
        assert_eq!(sanitize_filename(".."), None);
        assert_eq!(sanitize_filename("../"), None);
        assert_eq!(sanitize_filename("   "), None);
    }

    #[test]
    fn sanitize_filename_drops_characters_windows_rejects() {
        assert_eq!(
            sanitize_filename("re<po>rt|1?.xlsx").as_deref(),
            Some("report1.xlsx")
        );
        // Control characters (including the NUL truncation trick) are removed.
        assert_eq!(sanitize_filename("a\u{0}b.bin").as_deref(), Some("ab.bin"));
    }

    #[test]
    fn filename_from_disposition_reads_quoted_and_bare_forms() {
        assert_eq!(
            filename_from_disposition("attachment; filename=\"report.xlsx\"").as_deref(),
            Some("report.xlsx")
        );
        assert_eq!(
            filename_from_disposition("attachment; filename=report.xlsx").as_deref(),
            Some("report.xlsx")
        );
        assert_eq!(filename_from_disposition("inline").as_deref(), None);
    }

    #[test]
    fn filename_from_disposition_prefers_rfc5987_starred_form() {
        // The starred parameter is the one that can carry non-ASCII, so it wins
        // even when it appears after the plain fallback.
        let v = "attachment; filename=\"fallback.bin\"; filename*=UTF-8''%E6%8A%A5%E8%A1%A8.xlsx";
        assert_eq!(filename_from_disposition(v).as_deref(), Some("报表.xlsx"));
    }

    #[test]
    fn filename_from_disposition_percent_decodes_spaces() {
        let v = "attachment; filename*=UTF-8''report%20final.xlsx";
        assert_eq!(filename_from_disposition(v).as_deref(), Some("report final.xlsx"));
    }

    #[test]
    fn percent_decode_leaves_malformed_escapes_alone() {
        // A trailing '%' or non-hex digits must not panic or eat characters.
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("a%zz"), "a%zz");
    }

    #[test]
    fn suggest_download_name_falls_back_to_url_then_mime() {
        // No Content-Disposition: use the URL's last segment.
        let name = suggest_download_name(&[], "https://x.test/api/export.xlsx?t=1", "");
        assert_eq!(name, "export.xlsx");

        // URL has no usable extension: append one derived from the MIME type.
        let name = suggest_download_name(
            &[],
            "https://x.test/api/export",
            "application/pdf; charset=binary",
        );
        assert_eq!(name, "export.pdf");

        // Unknown MIME and no extension: leave the stem bare rather than
        // guessing wrong and making Windows open the wrong program.
        let name = suggest_download_name(&[], "https://x.test/api/blob", "application/x-weird");
        assert_eq!(name, "blob");
    }

    #[test]
    fn suggest_download_name_does_not_double_up_extensions() {
        let headers = vec![(
            "Content-Disposition".to_string(),
            "attachment; filename=\"data.xlsx\"".to_string(),
        )];
        let name = suggest_download_name(
            &headers,
            "https://x.test/whatever",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        );
        assert_eq!(name, "data.xlsx");
    }

    #[test]
    fn suggest_download_name_matches_header_case_insensitively() {
        // reqwest lowercases header names; other sources may not.
        let headers = vec![(
            "content-disposition".to_string(),
            "attachment; filename=\"a.zip\"".to_string(),
        )];
        assert_eq!(
            suggest_download_name(&headers, "https://x.test/b", ""),
            "a.zip"
        );
    }

    #[test]
    fn suggest_download_name_survives_a_url_with_no_path() {
        let name = suggest_download_name(&[], "https://x.test", "image/png");
        // "x.test" already looks extensioned, so no MIME suffix is appended.
        assert_eq!(name, "x.test");

        let name = suggest_download_name(&[], "", "image/png");
        assert_eq!(name, "download.png");
    }

    // ── expand_placeholders ────────────────────────────────────

    #[test]
    fn expand_replaces_known_placeholders() {
        let v = vars(&[("host", "api.example.com"), ("version", "v2")]);
        assert_eq!(
            expand_placeholders("https://{{host}}/{{version}}/users", &v),
            "https://api.example.com/v2/users"
        );
    }

    #[test]
    fn expand_leaves_unknown_placeholders_untouched() {
        // The contract: unknown names stay verbatim so the user can
        // see "you forgot to set this" rather than silently turning
        // into the empty string.
        let v = vars(&[("host", "api.example.com")]);
        assert_eq!(
            expand_placeholders("{{host}}/{{missing}}", &v),
            "api.example.com/{{missing}}"
        );
    }

    #[test]
    fn expand_passes_through_text_without_placeholders() {
        let v = vars(&[("host", "x")]);
        assert_eq!(expand_placeholders("plain text", &v), "plain text");
    }

    #[test]
    fn expand_handles_empty_value() {
        // An env var that exists but is empty should expand to ""
        // (not to the original `{{name}}`). This is the contract
        // that the front-end relies on for "user explicitly cleared
        // this variable" — the empty string must propagate.
        let v = vars(&[("token", "")]);
        assert_eq!(expand_placeholders("Bearer {{token}}", &v), "Bearer ");
    }

    #[test]
    fn expand_does_not_treat_single_braces_as_placeholder() {
        // Single `{` or `}` must not be confused for the start of
        // a placeholder; the helper only fires on the doubled
        // sequence `{{` / `}}`. JSON in a request body has plenty
        // of single braces.
        let v = vars(&[("host", "x")]);
        let input = r#"{"a":1,"b":"{not-a-placeholder}"}"#;
        assert_eq!(expand_placeholders(input, &v), input);
    }

    #[test]
    fn expand_trims_whitespace_around_placeholder_name() {
        // Users sometimes type `{{ host }}` (with spaces) in the
        // front-end by accident. The helper trims internally so the
        // lookup still hits. This is a real call we got from the
        // Postman migration: their UI used to auto-trim.
        let v = vars(&[("host", "x")]);
        assert_eq!(expand_placeholders("{{ host }}", &v), "x");
    }

    #[test]
    fn expand_handles_unclosed_placeholder_gracefully() {
        // A literal `{{` with no matching `}}` must be left alone
        // rather than consumed to end-of-string. The find_close
        // helper returns None in that case.
        let v = vars(&[("host", "x")]);
        assert_eq!(expand_placeholders("prefix {{host", &v), "prefix {{host");
    }

    // ── truncate ───────────────────────────────────────────────

    #[test]
    fn truncate_passes_through_short_strings_unchanged() {
        assert_eq!(truncate("hello", 100), "hello");
    }

    #[test]
    fn truncate_caps_long_strings_at_a_char_boundary() {
        // Use a multi-byte char to verify the byte→char-boundary
        // walk. "中文" is 6 bytes (3 per char). Cutting at byte 4
        // would split the second char; the helper should back up to
        // byte 3 (end of the first char) and add the truncation marker.
        let s = "中文abc";
        let out = truncate(s, 4);
        // The output must be valid UTF-8 (this is the property we
        // actually care about — no mid-codepoint slice) and must
        // contain the truncation marker.
        assert!(out.contains("truncated"));
        assert!(out.is_char_boundary(out.find('…').unwrap()));
    }

    #[test]
    fn truncate_keeps_exact_boundary_strings_intact() {
        // `max == s.len()` is the pass-through boundary: nothing is dropped,
        // so no marker is added.
        assert_eq!(truncate("hello world", 11), "hello world");
        assert_eq!(truncate("hello world", 12), "hello world");
        // One byte under the length *is* a truncation, so the marker appears.
        // The marker is mandatory whenever bytes are dropped — a silently
        // shortened body would be indistinguishable from a real short body.
        assert_eq!(truncate("hello world", 5), "hello…<truncated 6 bytes>");
    }

    // ── find_close ─────────────────────────────────────────────

    #[test]
    fn find_close_returns_offset_of_closing_braces() {
        // The helper scans the byte slice (which starts *after* the
        // opening `{{`) for the first `}}` and returns its offset.
        assert_eq!(find_close(b"host}}/tail"), Some(4));
        assert_eq!(find_close(b"a}}b}}c"), Some(1));
    }

    #[test]
    fn find_close_returns_none_when_no_close_present() {
        assert_eq!(find_close(b"host"), None);
        assert_eq!(find_close(b""), None);
        // `}` alone (not doubled) must not match.
        assert_eq!(find_close(b"host}"), None);
    }

    // ── collect_descendants ────────────────────────────────────

    fn node(id: &str, parent: Option<&str>) -> ApiNode {
        ApiNode {
            id: id.to_string(),
            parent_id: parent.map(|s| s.to_string()),
            name: id.to_string(),
            node_type: ApiNodeType::Folder,
            request: None,
            created_at: 0,
            updated_at: 0,
        }
    }

    #[test]
    fn collect_descendants_returns_self_when_no_children() {
        let nodes = vec![node("a", None), node("b", None)];
        assert_eq!(collect_descendants(&nodes, "a"), vec!["a"]);
    }

    #[test]
    fn collect_descendants_walks_the_full_tree() {
        // Tree:
        //   root
        //   ├── a
        //   │   └── a1
        //   │       └── a1x
        //   └── b
        let nodes = vec![
            node("root", None),
            node("a", Some("root")),
            node("b", Some("root")),
            node("a1", Some("a")),
            node("a1x", Some("a1")),
        ];
        let mut got = collect_descendants(&nodes, "root");
        got.sort();
        assert_eq!(got, vec!["a", "a1", "a1x", "b", "root"]);
    }

    #[test]
    fn collect_descendants_stops_at_subtree_boundary() {
        // Deleting "a" should not pull in "b" or "root".
        let nodes = vec![
            node("root", None),
            node("a", Some("root")),
            node("a1", Some("a")),
            node("b", Some("root")),
        ];
        let mut got = collect_descendants(&nodes, "a");
        got.sort();
        assert_eq!(got, vec!["a", "a1"]);
    }

    #[test]
    fn collect_descendants_tolerates_dangling_parent_references() {
        // If a node points to a parent that doesn't exist (corrupt data), the
        // helper must not loop forever. The `while changed` fixpoint loop
        // terminates because each pass only ever appends ids not already in
        // `out`, and `out` is bounded by the node count.
        let nodes = vec![
            node("a", Some("ghost")), // ghost parent
            node("b", Some("a")),
        ];
        // Deleting the dangling id still collects everything hanging off it:
        // "a" names "ghost" as its parent, so "a" *is* a descendant of
        // "ghost", and "b" follows through "a". Orphaning a subtree by
        // deleting only the missing root would leave unreachable nodes behind.
        let mut got = collect_descendants(&nodes, "ghost");
        got.sort();
        assert_eq!(got, vec!["a", "b", "ghost"]);
        // Deleting "a" takes "b" with it but must not climb up to "ghost".
        let mut got = collect_descendants(&nodes, "a");
        got.sort();
        assert_eq!(got, vec!["a", "b"]);
    }

    // ── path-var substitution symmetry with front-end ──────────
    //
    // These tests pin the contract that the back-end path-var
    // replacement matches the front-end `extractPathVars` in
    // ApiApp.tsx (regex `:[A-Za-z_][\p{L}\p{N}_.\-~]*` with the
    // `u` flag). A mismatch here means a URL like `/api/:用户ID/...`
    // gets extracted on the UI but never substituted on the
    // back-end — the request goes out as a literal `:用户ID` and
    // the server 404s. These tests exercise the **production**
    // `substitute_path_vars` directly. They used to run against a
    // hand-copied reimplementation living in this module, which meant
    // the tests could stay green while the real code drifted — and it
    // had drifted: the copy only accepted `/ ? # :` as terminators, so
    // `/api/:id=1` was never substituted in production.

    /// Adapter so the cases below can pass `&str` pairs.
    fn subst(url: &str, vars: &[(&str, &str)]) -> String {
        let owned: Vec<(String, String)> = vars
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect();
        substitute_path_vars(url, &owned)
    }

    #[test]
    fn substitute_supports_cjk_path_var_names() {
        // The front-end regex accepts `\p{L}` (Unicode letters,
        // including CJK). The back-end must therefore substitute a
        // CJK name the moment the URL has `:用户ID` followed by a
        // structural delimiter — not silently drop it.
        let url = "/api/:用户ID/profile";
        let got = subst(url, &[("用户ID", "42")]);
        assert_eq!(got, "/api/42/profile");
    }

    #[test]
    fn substitute_does_not_touch_a_port_colon() {
        // A URL like `https://api.example.com:8080/v1/users` contains
        // a colon followed by digits. The port must be preserved: the
        // needle is `:port`, which simply doesn't occur in the URL.
        let url = "https://api.example.com:8080/v1/users";
        let got = subst(url, &[("port", "9999")]);
        assert_eq!(got, url);
    }

    #[test]
    fn substitute_skips_empty_keys() {
        // A hand-edited `api_collections.json` with an empty
        // `path_vars: [["", "x"]]` entry must not match every
        // colon in the URL (a degenerate `:` needle that fires
        // anywhere). We bail before the loop even starts.
        let url = "https://api.example.com:8080/v1/users";
        let got = subst(url, &[("", "X")]);
        assert_eq!(got, url);
    }

    #[test]
    fn substitute_preserves_unrelated_colons() {
        // A URL with multiple colons (scheme + port) should only
        // replace the one we actually asked for. The scheme `https:`
        // and the port `:8080` are off-limits.
        let url = "https://api.example.com:8080/v1/users/:id";
        let got = subst(url, &[("id", "42")]);
        assert_eq!(got, "https://api.example.com:8080/v1/users/42");
    }

    #[test]
    fn substitute_terminates_on_non_name_characters() {
        // Regression for the old backend rule, which only treated
        // `/ ? # :` and end-of-string as boundaries. `=`, `&` and `,`
        // are all legal right after a path var, and the literal `:id`
        // used to be sent to the server verbatim.
        assert_eq!(subst("/api/:id=1", &[("id", "42")]), "/api/42=1");
        assert_eq!(subst("/api/x?u=:id&v=2", &[("id", "42")]), "/api/x?u=42&v=2");
        assert_eq!(subst("/api/:id,next", &[("id", "42")]), "/api/42,next");
    }

    #[test]
    fn substitute_does_not_match_a_longer_name() {
        // `:id` must not fire inside `:identifier` — otherwise the
        // longer variable is corrupted into `42entifier`.
        assert_eq!(
            subst("/api/:identifier", &[("id", "42")]),
            "/api/:identifier"
        );
    }

    #[test]
    fn substitute_replaces_every_occurrence() {
        assert_eq!(
            subst("/a/:id/b/:id", &[("id", "7")]),
            "/a/7/b/7"
        );
    }

    // ── Binary detection ────────────────────────────────────────
    // Responses used to be forced through `text()`, so a PNG came
    // back as mojibake. These pin the two signals we use.

    #[test]
    fn binary_detection_trusts_textual_content_types() {
        // A NUL in a body that claims to be JSON is not our problem to
        // reinterpret — the declared type wins for textual families.
        assert!(!is_binary_content("application/json", b"{\"a\":1}"));
        assert!(!is_binary_content("text/html; charset=utf-8", b"<html>"));
        assert!(!is_binary_content("application/vnd.api+json", b"{}"));
    }

    #[test]
    fn binary_detection_flags_known_binary_types() {
        assert!(is_binary_content("image/png", b"\x89PNG"));
        assert!(is_binary_content("application/octet-stream", b"abc"));
        assert!(is_binary_content("application/pdf", b"%PDF-1.7"));
    }

    #[test]
    fn binary_detection_sniffs_nul_when_type_is_unknown() {
        // No/unhelpful Content-Type is common. A NUL byte appears in
        // every binary format and no text format.
        assert!(is_binary_content("", b"\x00\x01\x02"));
        assert!(!is_binary_content("", b"plain text"));
        assert!(is_binary_content("application/x-unknown", b"a\x00b"));
    }

    #[test]
    fn binary_detection_handles_empty_body() {
        // A 204 with no body must not panic the slice logic.
        assert!(!is_binary_content("", b""));
        assert!(!is_binary_content("application/json", b""));
    }
}
