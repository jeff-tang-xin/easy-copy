mod clipboard;
mod models;

use std::sync::Arc;

use clipboard::ClipboardManager;
use models::AppConfig;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::Manager;
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
fn set_config(config: AppConfig, manager: tauri::State<'_, Arc<ClipboardManager>>) {
    manager.set_config(config);
}

#[tauri::command]
fn export_history(manager: tauri::State<'_, Arc<ClipboardManager>>) -> Result<String, String> {
    manager.export_history()
}

#[tauri::command]
fn import_history(json: String, manager: tauri::State<'_, Arc<ClipboardManager>>) -> Result<usize, String> {
    manager.import_history(&json)
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
            let show_item = MenuItem::with_id(app, "show", "Show/Hide", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

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

            // --- Global Shortcut: Ctrl+Shift+V ---
            // If the shortcut is already taken by another app, log a warning instead of crashing.
            let shortcut: Shortcut = "Ctrl+Shift+V".parse()?;
            if let Err(e) = app.global_shortcut().on_shortcut(shortcut, move |app, _sc, event| {
                if event.state == ShortcutState::Pressed {
                    if let Some(window) = app.get_webview_window("main") {
                        toggle_window(&window);
                    }
                }
            }) {
                eprintln!("Warning: failed to register global shortcut Ctrl+Shift+V (may be in use by another app): {}", e);
            }

            // --- Clipboard Manager with persistence ---
            let data_dir = app.path().app_data_dir().ok();
            let manager = Arc::new(ClipboardManager::new(500, data_dir.clone()));
            manager.load_from_disk();
            manager.load_config();
            app.manage(manager.clone());

            // --- Restore window position from disk ---
            if let Some(ref dir) = data_dir {
                if let Ok(json) = std::fs::read_to_string(dir.join("window_state.json")) {
                    if let Ok(state) = serde_json::from_str::<serde_json::Value>(&json) {
                        if let Some(window) = app.get_webview_window("main") {
                            if let (Some(x), Some(y)) = (state["x"].as_i64(), state["y"].as_i64()) {
                                let _ = window.set_position(tauri::LogicalPosition::new(x as f64, y as f64));
                            }
                            if let (Some(w), Some(h)) = (state["width"].as_f64(), state["height"].as_f64()) {
                                let _ = window.set_size(tauri::LogicalSize::new(w, h));
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
            import_history
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            // Save clipboard data
            if let Some(manager) = app_handle.try_state::<Arc<ClipboardManager>>() {
                manager.save_to_disk();
            }
            // Save window position & size
            if let Some(window) = app_handle.get_webview_window("main") {
                if let (Ok(pos), Ok(size)) = (window.outer_position(), window.outer_size()) {
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
    });
}
