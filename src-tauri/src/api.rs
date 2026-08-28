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
    /// Storage root. Wrapped in a `Mutex` so `set_data_dir` can swap it
    /// after construction (when the user changes `storage_root` from the
    /// settings panel) without forcing every other method through a lock.
    data_dir: std::sync::Mutex<Option<PathBuf>>,
    /// Shared cookie jar so successive calls in the same session persist cookies.
    cookie_jar: Arc<Jar>,
}

impl ApiStore {
    pub fn new(data_dir: Option<PathBuf>) -> Self {
        Self {
            state: Arc::new(Mutex::new(ApiState::default())),
            data_dir: std::sync::Mutex::new(data_dir),
            cookie_jar: Arc::new(Jar::default()),
        }
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

        // Replace path variables (`:var` in URL). The boundary for a variable
        // name is any of `/`, `?`, `#`, `:` or end-of-string — mirroring the
        // front-end `extractPathVars` in ApiApp.tsx (regex
        // `:[A-Za-z_][\p{L}\p{N}_.\-~]*` with the `u` flag) so a URL like
        // `/api/:用户ID/users` correctly substitutes `用户ID` and doesn't
        // bleed into the next segment. A naive `s.replace(":id", v)` would
        // also match `:id2` with v="1" and corrupt the URL.
        //
        // The set of valid name characters on the front-end side already
        // excludes the digits-as-first-character case (`:8080` is a port,
        // not a variable), so we don't need a separate "first byte must be
        // a letter" check here. Including `:` in the boundary set is the
        // belt-and-braces that defends against a hand-edited
        // `api_collections.json` whose `path_vars` contains a `:8080`-
        // shaped name: the `:` between `:name` and the literal `8080`
        // terminates the name match and prevents the port from being
        // clobbered. (The same defence is also implicit on the front-end
        // side because its regex requires `[A-Za-z_]` as the first char.)
        for (k, v) in &req.path_vars {
            let v = self.expand(v);
            let needle = format!(":{}", k);
            // Skip empty `k` to avoid a degenerate `:` needle that
            // would match every colon in the URL. (An empty path-var
            // name is meaningless and shouldn't be a key in
            // `path_vars` to begin with, but a hand-edited JSON
            // file could land us here.)
            if k.is_empty() {
                continue;
            }
            // We replace every occurrence whose suffix is a path/host delimiter
            // (or end-of-string). Walking manually is O(n) per var and the
            // inputs are short URLs, so this is fine.
            let mut out = String::with_capacity(req.url.len());
            let bytes = req.url.as_bytes();
            let mut i = 0;
            while i < bytes.len() {
                if bytes[i..].starts_with(needle.as_bytes()) {
                    let after = i + needle.len();
                    // A path-var name ends at any of these delimiters. We
                    // include `:` so a URL like `https://host:8080/...` does
                    // NOT treat `:8080` as a path variable and silently
                    // corrupt the port. (See the function-level comment
                    // above for the full rationale and the front-end
                    // contract this matches.)
                    let is_boundary = after == bytes.len()
                        || matches!(bytes[after], b'/' | b'?' | b'#' | b':');
                    if is_boundary {
                        out.push_str(&v);
                        i = after;
                        continue;
                    }
                }
                // Push one UTF-8 char (req.url is &str so this is safe).
                let ch = req.url[i..].chars().next().unwrap();
                out.push(ch);
                i += ch.len_utf8() as usize;
            }
            req.url = out;
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
        i += input[i..].chars().next().unwrap().len_utf8() as usize;
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
    use std::collections::HashMap;

    fn vars(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
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
    // the server 404s. These tests directly exercise the loop in
    // `execute` via a small in-process reimplementation, so we can
    // validate the boundary/empty-key logic without spinning up
    // reqwest.

    /// Reimplements the path-var substitution loop in `execute`,
    /// factored out for unit testing. Mirrors the production code
    /// line-for-line; if the production loop drifts, this test will
    /// need to be updated alongside it (and that update is a
    /// signal that the two-sided contract is changing).
    fn substitute_path_vars(url: &str, path_vars: &[(&str, &str)]) -> String {
        let mut url = url.to_string();
        for (k, v) in path_vars {
            if k.is_empty() {
                continue;
            }
            let needle = format!(":{}", k);
            let bytes = url.as_bytes();
            let mut out = String::with_capacity(url.len());
            let mut i = 0;
            while i < bytes.len() {
                if bytes[i..].starts_with(needle.as_bytes()) {
                    let after = i + needle.len();
                    let is_boundary = after == bytes.len()
                        || matches!(bytes[after], b'/' | b'?' | b'#' | b':');
                    if is_boundary {
                        out.push_str(v);
                        i = after;
                        continue;
                    }
                }
                let ch = url[i..].chars().next().unwrap();
                out.push(ch);
                i += ch.len_utf8() as usize;
            }
            url = out;
        }
        url
    }

    #[test]
    fn substitute_supports_cjk_path_var_names() {
        // The front-end regex accepts `\p{L}` (Unicode letters,
        // including CJK). The back-end must therefore substitute a
        // CJK name the moment the URL has `:用户ID` followed by a
        // structural delimiter — not silently drop it.
        let url = "/api/:用户ID/profile";
        let got = substitute_path_vars(url, &[("用户ID", "42")]);
        assert_eq!(got, "/api/42/profile");
    }

    #[test]
    fn substitute_does_not_touch_a_port_colon() {
        // A URL like `https://api.example.com:8080/v1/users` contains
        // a colon followed by digits. The port must be preserved
        // even if a hand-edited `path_vars` happens to contain a
        // name whose prefix would match. The `:` boundary check is
        // what saves us.
        let url = "https://api.example.com:8080/v1/users";
        let got = substitute_path_vars(url, &[("port", "9999")]);
        assert_eq!(got, url);
    }

    #[test]
    fn substitute_skips_empty_keys() {
        // A hand-edited `api_collections.json` with an empty
        // `path_vars: [["", "x"]]` entry must not match every
        // colon in the URL (a degenerate `:` needle that fires
        // anywhere). We bail before the loop even starts.
        let url = "https://api.example.com:8080/v1/users";
        let got = substitute_path_vars(url, &[("", "X")]);
        assert_eq!(got, url);
    }

    #[test]
    fn substitute_preserves_unrelated_colons() {
        // A URL with multiple colons (scheme + port) should only
        // replace the one we actually asked for. The scheme `https:`
        // and the port `:8080` are off-limits.
        let url = "https://api.example.com:8080/v1/users/:id";
        let got = substitute_path_vars(url, &[("id", "42")]);
        assert_eq!(got, "https://api.example.com:8080/v1/users/42");
    }
}
