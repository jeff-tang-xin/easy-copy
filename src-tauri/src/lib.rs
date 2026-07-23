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
    let resp = reqwest::Client::new()
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
// Screenshot commands
// ============================================================

/// Capture all monitors and save to a temp PNG, then open the screenshot window.
async fn capture_and_show(app: tauri::AppHandle) -> Result<(), String> {
    use xcap::Monitor;
    use image::ImageFormat;

    // Hide our own windows so they are not captured in the screenshot, then give
    // the compositor a moment to actually repaint before grabbing the frame.
    for label in ["main", "notes", "tools", "screenshot"] {
        if let Some(w) = app.get_webview_window(label) {
            let _ = w.hide();
        }
    }
    tokio::time::sleep(std::time::Duration::from_millis(80)).await;

    // Capture primary monitor
    let monitors = Monitor::all().map_err(|e| format!("Failed to enumerate monitors: {}", e))?;
    let monitor = monitors.into_iter().next().ok_or("No monitor found")?;
    let image = monitor.capture_image().map_err(|e| format!("Capture failed: {}", e))?;

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

    // Open screenshot window as a true borderless fullscreen overlay.
    if let Some(w) = app.get_webview_window("screenshot") {
        w.emit("screenshot-captured", data_url)
            .map_err(|e| format!("Emit failed: {}", e))?;
        let _ = w.set_fullscreen(true);
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
    use xcap::Monitor;
    use image::ImageFormat;

    let monitors = Monitor::all().map_err(|e| format!("Failed to enumerate monitors: {}", e))?;
    let monitor = monitors.into_iter().next().ok_or("No monitor found")?;
    let image = monitor.capture_image().map_err(|e| format!("Capture failed: {}", e))?;

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
    let _guard = crate::clipboard::CLIPBOARD_LOCK.lock().unwrap();
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
    if window.is_visible().unwrap_or(false) {
        let _ = window.hide();
    } else {
        let _ = window.show();
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
