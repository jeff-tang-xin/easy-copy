//! Screenshot module — capture, save, copy to clipboard, overlay placement.
//!
//! Split out of lib.rs to keep the main crate entry point focused on assembly.
//! All screenshot-related commands and helpers live here.

use tauri::{Emitter, Manager};

/// Geometry of the monitor a capture came from, in physical pixels.
pub struct CaptureTarget {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// Get the current cursor position in screen coordinates (physical pixels).
///
/// Uses the Windows API `GetCursorPos` directly via `extern "system"` so we
/// don't need to pull in an extra crate (the app is Windows-only anyway —
/// `clipboard-win` and `explorer.exe` are used elsewhere). Returns `None`
/// if the call fails for any reason.
#[cfg(windows)]
fn get_cursor_pos() -> Option<(i32, i32)> {
    use std::mem::MaybeUninit;

    #[repr(C)]
    struct POINT {
        x: i32,
        y: i32,
    }

    extern "system" {
        fn GetCursorPos(lpPoint: *mut POINT) -> i32;
    }

    let mut point = MaybeUninit::<POINT>::uninit();
    // SAFETY: GetCursorPos writes to the provided POINT struct; we pass a
    // valid mutable pointer and check the return value before reading.
    let ok = unsafe { GetCursorPos(point.as_mut_ptr()) };
    if ok == 0 {
        return None;
    }
    // SAFETY: GetCursorPos returned non-zero, so the struct is initialized.
    let p = unsafe { point.assume_init() };
    Some((p.x, p.y))
}

#[cfg(not(windows))]
fn get_cursor_pos() -> Option<(i32, i32)> {
    None
}

/// Primary monitor if the platform reports one, else the first enumerated.
pub fn pick_fallback_monitor() -> xcap::XCapResult<xcap::Monitor> {
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
pub fn capture_cursor_monitor(
    _app: &tauri::AppHandle,
) -> Result<(image::RgbaImage, CaptureTarget), String> {
    use xcap::Monitor;

    let cursor_pos = get_cursor_pos();
    let monitor = match cursor_pos {
        Some((x, y)) => Monitor::from_point(x, y)
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
pub fn place_overlay_on(w: &tauri::WebviewWindow, target: &CaptureTarget) {
    use tauri::{PhysicalPosition, PhysicalSize};
    // Leave fullscreen before moving: a fullscreen window ignores position changes.
    let _ = w.set_fullscreen(false);
    let _ = w.set_position(PhysicalPosition::new(target.x, target.y));
    let _ = w.set_size(PhysicalSize::new(target.width, target.height));
    let _ = w.set_fullscreen(true);
}

/// Capture the monitor under the cursor and save to a temp PNG, then open the
/// screenshot overlay on that same monitor.
pub async fn capture_and_show(app: tauri::AppHandle) -> Result<(), String> {
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

// ============================================================
// Screenshot commands
// ============================================================

#[tauri::command]
pub async fn trigger_screenshot(app: tauri::AppHandle) -> Result<(), String> {
    // Delegate to the shared capture routine so the button and the global
    // shortcut / tray produce identical behaviour (data URL, region select, etc.).
    capture_and_show(app).await
}

#[tauri::command]
pub async fn capture_screenshot(app: tauri::AppHandle) -> Result<String, String> {
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
pub async fn save_screenshot(data_url: String) -> Result<String, String> {
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
pub async fn copy_image_to_clipboard(data_url: String) -> Result<(), String> {
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

    // Own the bytes (Cow::Owned) instead of borrowing from `rgba` so the
    // arboard call can't dangle if the ImageData is held across an await
    // boundary. The image has already been decoded into a local `RgbaImage`
    // by the time we get here, so the clone cost is bounded by the capture
    // size (typically a few MB at most).
    let owned: Vec<u8> = rgba.into_raw();
    let mut clipboard = crate::clipboard::open_clipboard_retry()?;
    let img_data = arboard::ImageData {
        width: w as usize,
        height: h as usize,
        bytes: std::borrow::Cow::Owned(owned),
    };
    clipboard.set_image(img_data).map_err(|e| format!("Clipboard write failed: {}", e))
}
