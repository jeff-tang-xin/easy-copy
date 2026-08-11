// Allow Tauri's #[command] macro to infer Result<T, String> for sync commands
// without us having to spell the wrapper on every handler. Future-friendly
// shim until we migrate the crate to edition 2024 explicitly.
#![allow(dependency_on_unit_never_type_fallback)]

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use crate::models::{ApiEnvironment, ApiNode, ApiNodeType, ApiRequest, ApiResponse, ApiState};
use reqwest::cookie::Jar;
use reqwest::{header, Client, ClientBuilder, Method, Proxy};

/// Maximum number of historical responses kept per request.
pub const HISTORY_LIMIT: usize = 50;

/// Manages API collections, environments, and request execution.
/// Mirrors `NoteManager`'s pattern: single JSON file, in-memory `Arc<Mutex<...>>`.
pub struct ApiStore {
    state: Arc<Mutex<ApiState>>,
    data_dir: Option<PathBuf>,
    /// Shared cookie jar so successive calls in the same session persist cookies.
    cookie_jar: Arc<Jar>,
}

impl ApiStore {
    pub fn new(data_dir: Option<PathBuf>) -> Self {
        Self {
            state: Arc::new(Mutex::new(ApiState::default())),
            data_dir,
            cookie_jar: Arc::new(Jar::default()),
        }
    }

    fn file_path(&self) -> Option<PathBuf> {
        self.data_dir.as_ref().map(|d| d.join("api_collections.json"))
    }

    /// Load state from disk. Silently starts empty on any error.
    pub fn load(&self) {
        let path = match self.file_path() {
            Some(p) => p,
            None => return,
        };
        let json = match fs::read_to_string(&path) {
            Ok(j) => j,
            Err(_) => return,
        };
        if let Ok(loaded) = serde_json::from_str::<ApiState>(&json) {
            *self.state.lock().unwrap_or_else(|e| e.into_inner()) = loaded;
        }
    }

    /// Persist state to disk. Best-effort.
    fn save(&self) {
        let path = match self.file_path() {
            Some(p) => p,
            None => return,
        };
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let state = self.state.lock().unwrap_or_else(|e| e.into_inner()).clone();
        if let Ok(json) = serde_json::to_string_pretty(&state) {
            let _ = fs::write(path, json);
        }
    }

    // ── Tree helpers ────────────────────────────────────────────

    pub fn list_nodes(&self) -> Vec<ApiNode> {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).nodes.clone()
    }

    pub fn list_envs(&self) -> Vec<ApiEnvironment> {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).envs.clone()
    }

    pub fn active_env_id(&self) -> Option<String> {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).active_env_id.clone()
    }

    pub fn set_active_env(&self, env_id: Option<String>) {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).active_env_id = env_id;
        self.save();
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
        if state.active_env_id.as_deref() == Some(id) {
            state.active_env_id = None;
        }
        drop(state);
        self.save();
    }

    // ── Variable expansion ──────────────────────────────────────

    /// Expand `{{var_name}}` placeholders in `input` using the active env's vars.
    /// Unknown placeholders are left untouched.
    pub fn expand(&self, input: &str) -> String {
        let (vars, active_id) = {
            let s = self.state.lock().unwrap_or_else(|e| e.into_inner());
            let active = s.envs.iter().find(|e| Some(&e.id) == s.active_env_id.as_ref());
            let map: HashMap<String, String> = match active {
                Some(env) => env.vars.iter().cloned().collect(),
                None => HashMap::new(),
            };
            (map, s.active_env_id.clone())
        };
        if active_id.is_none() {
            return input.to_string();
        }
        expand_placeholders(input, &vars)
    }

    // ── Execution ───────────────────────────────────────────────

    /// Execute an HTTP request, persist the response to history, return the response.
    pub async fn execute(&self, mut req: ApiRequest) -> ApiResponse {
        let started = Instant::now();
        let orig_url = req.url.clone();
        let orig_method = req.method.clone();

        // Expand URL and headers/body values.
        req.url = self.expand(&req.url);

        // Replace path variables (`:var` in URL).
        for (k, v) in &req.path_vars {
            let v = self.expand(v);
            req.url = req.url.replace(&format!(":{}", k), &v);
        }

        let expanded_headers: Vec<(String, String)> = req
            .headers
            .iter()
            .map(|(k, v)| (k.clone(), self.expand(v)))
            .collect();

        let method = Method::from_bytes(req.method.to_uppercase().as_bytes())
            .unwrap_or(Method::GET);

        let mut builder = ClientBuilder::new()
            .cookie_provider(self.cookie_jar.clone())
            .danger_accept_invalid_certs(true); // A3: SSL skip

        // A3: optional proxy — read PROXY env or skip. We expose none in this build.
        if let Ok(p) = std::env::var("EASY_COPY_HTTP_PROXY") {
            if !p.is_empty() {
                if let Ok(proxy) = Proxy::all(&p) {
                    builder = builder.proxy(proxy);
                }
            }
        }
        let client: Client = match builder.build() {
            Ok(c) => c,
            Err(e) => return error_response(&req, started, format!("client build: {e}")),
        };

        let mut request = client.request(method, &req.url);
        for (k, v) in &expanded_headers {
            // Try to parse common headers; otherwise append raw.
            if let (Ok(name), Ok(value)) = (
                header::HeaderName::from_bytes(k.as_bytes()),
                header::HeaderValue::from_str(v),
            ) {
                request = request.header(name, value);
            }
        }

        // Append query params.
        if !req.query.is_empty() {
            let qp: Vec<(String, String)> = req.query.iter()
                .map(|(k, v)| (k.clone(), self.expand(v)))
                .collect();
            request = request.query(&qp);
        }

        // Build body based on body_type.
        let bt = if req.body_type.is_empty() { "none" } else { &req.body_type };
        match bt {
            "raw" => {
                let content = req.body.as_deref().unwrap_or("");
                let content = self.expand(content);
                let ct = match req.body_raw_lang.as_str() {
                    "json" => "application/json",
                    "xml" => "application/xml",
                    "javascript" => "application/javascript",
                    "text" => "text/plain",
                    "html" => "text/html",
                    _ => "text/plain",
                };
                request = request.header("content-type", ct);
                if !content.is_empty() {
                    request = request.body(content);
                }
            }
            "form-data" => {
                let mut form = reqwest::multipart::Form::new();
                for f in &req.form_data {
                    let key = self.expand(&f.key);
                    if f.field_type == "file" {
                        if let Some(path) = &f.file_path {
                            if let Ok(bytes) = fs::read(path) {
                                let file_name = f.file_name.clone()
                                    .or_else(|| {
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
                            }
                        }
                    } else {
                        let value = self.expand(&f.value);
                        form = form.text(key, value);
                    }
                }
                request = request.multipart(form);
            }
            "urlencoded" => {
                let params: Vec<(String, String)> = req.url_encoded.iter()
                    .map(|(k, v)| (k.clone(), self.expand(v)))
                    .collect();
                request = request.form(&params);
            }
            "binary" => {
                if let Some(path) = &req.binary_file {
                    if let Ok(bytes) = fs::read(path) {
                        request = request.header("content-type", "application/octet-stream");
                        request = request.body(bytes);
                    }
                }
            }
            "msgpack" => {
                if let Some(path) = &req.msgpack_file {
                    if let Ok(bytes) = fs::read(path) {
                        request = request.header("content-type", "application/msgpack");
                        request = request.body(bytes);
                    }
                }
            }
            _ => {
                // "none" or legacy: fall back to raw body text if present.
                if let Some(body) = &req.body {
                    if !body.is_empty() {
                        let body = self.expand(body);
                        request = request.body(body);
                    }
                }
            }
        }

        let resp_result = request.send().await;
        let response = match resp_result {
            Ok(r) => r,
            Err(e) => {
                let response = error_response(&req, started, format!("send: {e}"));
                self.append_history(&orig_url, &orig_method, response.clone());
                return response;
            }
        };

        let status = response.status();
        let status_text = status.canonical_reason().unwrap_or("").to_string();
        let headers: Vec<(String, String)> = response
            .headers()
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
            .collect();
        let body_result = response.text().await;
        let body = match body_result {
            Ok(b) => Some(truncate(&b, 256 * 1024)),
            Err(e) => Some(format!("<failed to read body: {e}>")),
        };

        let response = ApiResponse {
            status: status.as_u16(),
            status_text,
            headers,
            request_headers: expanded_headers.clone(),
            body,
            duration_ms: started.elapsed().as_millis() as u64,
            timestamp: chrono::Utc::now().timestamp_millis(),
            error: None,
        };
        self.append_history(&orig_url, &orig_method, response.clone());
        response
    }

    fn append_history(&self, url: &str, method: &str, resp: ApiResponse) {
        // Find the request node by matching URL+method.
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(node) = state.nodes.iter_mut().find(|n| {
            n.node_type == ApiNodeType::Request
                && n.request
                    .as_ref()
                    .map(|r| r.url == url && r.method == method)
                    .unwrap_or(false)
        }) {
            if let Some(r) = node.request.as_mut() {
                r.history.insert(0, resp);
                if r.history.len() > HISTORY_LIMIT {
                    r.history.truncate(HISTORY_LIMIT);
                }
            }
        }
        drop(state);
        self.save();
    }
}

fn error_response(_req: &ApiRequest, started: Instant, msg: String) -> ApiResponse {
    ApiResponse {
        status: 0,
        status_text: "ERROR".into(),
        headers: vec![],
        request_headers: vec![],
        body: None,
        duration_ms: started.elapsed().as_millis() as u64,
        timestamp: chrono::Utc::now().timestamp_millis(),
        error: Some(msg),
    }
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
        i += input[i..].chars().next().unwrap().len_utf8();
    }
    out
}

fn find_close(bytes: &[u8]) -> Option<usize> {
    let mut i = 0;
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
pub fn api_set_active_env(
    env_id: Option<String>,
    store: tauri::State<'_, Arc<ApiStore>>,
) -> Result<(), String> {
    store.set_active_env(env_id);
    Ok(())
}

#[tauri::command]
pub async fn api_execute(
    request: ApiRequest,
    store: tauri::State<'_, Arc<ApiStore>>,
) -> Result<ApiResponse, String> {
    Ok(store.execute(request).await)
}
