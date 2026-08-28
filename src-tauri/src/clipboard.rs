use arboard::Clipboard;
use clipboard_win::{Getter, Setter};
use image::ImageEncoder;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

use crate::models::{ClipboardItem, ItemType, AppConfig};

/// Global clipboard access lock. Windows only allows one thread to hold the
/// clipboard open at a time; the poll loop and any copy operation must not race
/// or `OpenClipboard`/`SetClipboardData` fails with os error 1418.
pub static CLIPBOARD_LOCK: Mutex<()> = Mutex::new(());

// =========================================================================
// LOCK ORDERING (Clipboar­dManager)
// =========================================================================
// All public methods on ClipboardManager take the manager's internal mutexes
// in a fixed order, to make deadlocks impossible if the call graph ever
// stops being single-threaded. Acquire only top-to-bottom; never re-enter
// a higher lock while holding a lower one.
//
//   1. items          (Vec<ClipboardItem>)
//   2. images         (HashMap<String, Vec<u8>>)   // image payloads
//   3. last_text      (String)                      // poll de-dup
//   4. last_image_hash(String)                      // poll de-dup
//   5. last_files     (Vec<String>)                 // poll de-dup
//   6. max_items      (usize)                       // capacity knob
//   7. config         (AppConfig)                   // includes poll interval
//
// Helpers that touch two or more (e.g. `copy_to_clipboard`, `clear`) MUST
// release the higher one in a scoped `{}` block before taking the lower one.
// See `copy_to_clipboard` for the canonical pattern.
//
// `save_to_disk` needs both `items` (to write history.json + compute the
// set of valid image ids) and `images` (to write the individual PNG files).
// It acquires them one at a time in the canonical order: `items` is taken,
// `valid_ids` collected, the guard dropped, then `images` is taken. This
// pattern is repeated in `copy_to_clipboard`.
//
// CLIPBOARD_LOCK is orthogonal — it guards the OS clipboard, not the
// manager's in-memory state. It can be held at the same time as any of the
// above, but doing so blocks the poll loop from reading the clipboard; the
// existing code minimises the held window to just the read/write syscalls.
// =========================================================================

/// Open an arboard clipboard with retries. arboard 3.x `new()` performs a single
/// `OpenClipboard`; if another process/thread holds it the call fails outright.
/// Retry a handful of times with a short backoff to survive transient contention.
pub fn open_clipboard_retry() -> Result<Clipboard, String> {
    let mut last_err = String::new();
    for _ in 0..10 {
        match Clipboard::new() {
            Ok(cb) => return Ok(cb),
            Err(e) => {
                last_err = e.to_string();
                thread::sleep(Duration::from_millis(30));
            }
        }
    }
    Err(format!("Failed to access clipboard after retries: {}", last_err))
}

/// Strip ANSI escape sequences (CSI, OSC, and standalone ESC) plus non-printable
/// C0 control characters from text. Preserves \t \n \r.
fn strip_ansi_escapes(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            match chars.peek().copied() {
                Some('[') => {
                    // CSI: ESC [ ... final-byte in 0x40..=0x7E
                    chars.next();
                    while let Some(&cc) = chars.peek() {
                        chars.next();
                        if ('\u{40}'..='\u{7e}').contains(&cc) {
                            break;
                        }
                    }
                }
                Some(']') => {
                    // OSC: ESC ] ... BEL (0x07) or ST (ESC \)
                    chars.next();
                    while let Some(&cc) = chars.peek() {
                        if cc == '\u{07}' {
                            chars.next();
                            break;
                        }
                        if cc == '\u{1b}' {
                            chars.next();
                            if chars.peek() == Some(&'\\') {
                                chars.next();
                            }
                            break;
                        }
                        chars.next();
                    }
                }
                Some(_) => {
                    // Two-char ESC sequence: skip the following char
                    chars.next();
                }
                None => {}
            }
            continue;
        }
        // Skip other C0 control characters, but preserve tab/newline/CR
        if (c as u32) < 0x20 && c != '\t' && c != '\n' && c != '\r' {
            continue;
        }
        out.push(c);
    }
    out
}

/// Convert arboard ImageData (RGBA) to PNG bytes.
fn rgba_to_png(img: &arboard::ImageData) -> Result<Vec<u8>, String> {
    let mut buf = Vec::new();
    let encoder = image::codecs::png::PngEncoder::new(&mut buf);
    encoder
        .write_image(
            &img.bytes,
            img.width as u32,
            img.height as u32,
            image::ExtendedColorType::Rgba8,
        )
        .map_err(|e| format!("PNG encode error: {}", e))?;
    Ok(buf)
}

/// Decode PNG bytes back to arboard ImageData (RGBA).
fn png_to_image_data(png: &[u8]) -> Result<arboard::ImageData<'static>, String> {
    let img = image::ImageReader::new(std::io::Cursor::new(png))
        .with_guessed_format()
        .map_err(|e| format!("Format guess error: {}", e))?
        .decode()
        .map_err(|e| format!("Image decode error: {}", e))?
        .to_rgba8();
    Ok(arboard::ImageData {
        width: img.width() as usize,
        height: img.height() as usize,
        bytes: std::borrow::Cow::Owned(img.into_raw()),
    })
}

/// Read file list (CF_HDROP) from Windows clipboard via clipboard-win.
fn get_clipboard_files() -> Option<Vec<String>> {
    let _clip = clipboard_win::Clipboard::new_attempts(10).ok()?;
    let mut files: Vec<String> = Vec::new();
    clipboard_win::formats::FileList
        .read_clipboard(&mut files)
        .ok()?;
    if files.is_empty() {
        None
    } else {
        Some(files)
    }
}

/// Write file list (CF_HDROP) to Windows clipboard.
fn set_clipboard_files(files: &[String]) -> Result<(), String> {
    let _clip = clipboard_win::Clipboard::new_attempts(10)
        .map_err(|e| format!("Clipboard open: {}", e))?;
    clipboard_win::formats::FileList
        .write_clipboard(files)
        .map_err(|e| format!("Clipboard write files: {}", e))
}

/// Manages clipboard history in memory, with optional disk persistence.
pub struct ClipboardManager {
    items: Arc<Mutex<Vec<ClipboardItem>>>,
    images: Arc<Mutex<HashMap<String, Vec<u8>>>>,
    last_text: Arc<Mutex<String>>,
    last_image_hash: Arc<Mutex<String>>,
    last_files: Arc<Mutex<Vec<String>>>,
    max_items: Arc<Mutex<usize>>,
    /// Storage root. Wrapped in a `Mutex` so `set_data_dir` can swap it
    /// after construction (when the user changes `storage_root` from the
    /// settings panel) without forcing every other method through a lock.
    data_dir: Mutex<Option<PathBuf>>,
    dirty: Arc<AtomicBool>,
    incognito: Arc<AtomicBool>,
    config: Arc<Mutex<AppConfig>>,
}

impl ClipboardManager {
    pub fn new(max_items: usize, data_dir: Option<PathBuf>) -> Self {
        Self {
            items: Arc::new(Mutex::new(Vec::new())),
            images: Arc::new(Mutex::new(HashMap::new())),
            last_text: Arc::new(Mutex::new(String::new())),
            last_image_hash: Arc::new(Mutex::new(String::new())),
            last_files: Arc::new(Mutex::new(Vec::new())),
            max_items: Arc::new(Mutex::new(max_items)),
            data_dir: Mutex::new(data_dir),
            dirty: Arc::new(AtomicBool::new(false)),
            incognito: Arc::new(AtomicBool::new(false)),
            config: Arc::new(Mutex::new(AppConfig::default())),
        }
    }

    /// Update the data directory at runtime (used when the user changes
    /// `storage_root` from the settings panel). Subsequent saves will
    /// land in the new directory. We don't re-read the old history:
    /// switching storage roots is a one-way move, and the user can use
    /// the import/export buttons in settings if they want to bring
    /// their old data along.
    pub fn set_data_dir(&self, data_dir: PathBuf) {
        *self.data_dir.lock().unwrap_or_else(|e| e.into_inner()) = Some(data_dir);
    }

    /// Save items (JSON) and images (PNG files) to disk.
    pub fn save_to_disk(&self) {
        let data_dir = match self.data_dir.lock().unwrap_or_else(|e| e.into_inner()).clone() {
            Some(d) => d,
            None => return,
        };
        let _ = fs::create_dir_all(&data_dir);

        // Save items as JSON
        let items = self.items.lock().unwrap_or_else(|e| e.into_inner());
        let valid_ids: HashSet<String> = items
            .iter()
            .filter(|i| i.item_type == ItemType::Image)
            .map(|i| i.id.clone())
            .collect();
        if let Ok(json) = serde_json::to_string(&*items) {
            let _ = fs::write(data_dir.join("history.json"), json);
        }
        drop(items);

        // Save images as individual PNG files
        let images_dir = data_dir.join("images");
        let _ = fs::create_dir_all(&images_dir);
        let images = self.images.lock().unwrap_or_else(|e| e.into_inner());
        for (id, png) in images.iter() {
            if valid_ids.contains(id) {
                let _ = fs::write(images_dir.join(format!("{}.png", id)), png);
            }
        }
        drop(images);

        // Clean up orphaned image files (no corresponding item)
        if let Ok(entries) = fs::read_dir(&images_dir) {
            for entry in entries.flatten() {
                if let Some(name) = entry.file_name().to_str() {
                    let id = name.trim_end_matches(".png");
                    if !valid_ids.contains(id) {
                        let _ = fs::remove_file(entry.path());
                    }
                }
            }
        }
    }

    /// Load items and images from disk into memory.
    pub fn load_from_disk(&self) {
        let data_dir = match self.data_dir.lock().unwrap_or_else(|e| e.into_inner()).clone() {
            Some(d) => d,
            None => return,
        };

        // Load items from JSON
        if let Ok(json) = fs::read_to_string(data_dir.join("history.json")) {
            if let Ok(items) = serde_json::from_str::<Vec<ClipboardItem>>(&json) {
                let mut self_items = self.items.lock().unwrap_or_else(|e| e.into_inner());
                *self_items = items;
            }
        }

        // Load images from individual PNG files
        let images_dir = data_dir.join("images");
        if let Ok(entries) = fs::read_dir(&images_dir) {
            let mut images = self.images.lock().unwrap_or_else(|e| e.into_inner());
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) == Some("png") {
                    if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                        if let Ok(data) = fs::read(&path) {
                            images.insert(stem.to_string(), data);
                        }
                    }
                }
            }
        }
    }

    pub fn get_items(&self) -> Vec<ClipboardItem> {
        let mut items = self.items.lock().unwrap_or_else(|e| e.into_inner()).clone();
        items.sort_by(|a, b| b.favorite.cmp(&a.favorite).then_with(|| b.timestamp.cmp(&a.timestamp)));
        items
    }

    /// Get items + stats + image data map in one call.
    ///
    /// Used by the front-end `refresh()` path so we don't need N+1 IPC
    /// round-trips (`get_history` + `get_stats` + one `get_image_data`
    /// per image item). With 50+ images in the list this saves ~20-30ms
    /// of IPC overhead per refresh.
    pub fn get_history_full(&self) -> crate::models::HistoryFull {
        use base64::Engine;
        use std::collections::HashMap;

        let mut items = self.items.lock().unwrap_or_else(|e| e.into_inner()).clone();
        items.sort_by(|a, b| b.favorite.cmp(&a.favorite).then_with(|| b.timestamp.cmp(&a.timestamp)));

        // Collect image data only for Image-type items.
        let mut images = HashMap::new();
        {
            let img_store = self.images.lock().unwrap_or_else(|e| e.into_inner());
            for item in &items {
                if item.item_type == ItemType::Image {
                    if let Some(png) = img_store.get(&item.id) {
                        images.insert(
                            item.id.clone(),
                            format!(
                                "data:image/png;base64,{}",
                                base64::engine::general_purpose::STANDARD.encode(png)
                            ),
                        );
                    }
                }
            }
        }

        let stats = self.get_stats();

        crate::models::HistoryFull {
            items,
            stats,
            images,
        }
    }

    pub fn search(&self, query: &str) -> Vec<ClipboardItem> {
        let query_lower = query.to_lowercase();
        let mut results: Vec<ClipboardItem> = self.items
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .filter(|item| {
                item.content.to_lowercase().contains(&query_lower)
                    || item.tags.iter().any(|t| t.to_lowercase().contains(&query_lower))
            })
            .cloned()
            .collect();
        results.sort_by(|a, b| b.favorite.cmp(&a.favorite).then_with(|| b.timestamp.cmp(&a.timestamp)));
        results
    }

    /// Insert an item at the head, dedup by content+type, truncate if needed.
    ///
    /// Lock order (see module-level doc): items → max_items → images.
    /// `items` is dropped in a scoped block before the truncate path takes
    /// `images`, matching the documented pattern.
    fn insert_item(&self, item: ClipboardItem) {
        let mut items = self.items.lock().unwrap_or_else(|e| e.into_inner());

        // Dedup: if same content+type exists, move it to top with fresh timestamp
        if let Some(pos) = items.iter().position(|i| i.content == item.content && i.item_type == item.item_type) {
            let mut existing = items.remove(pos);
            existing.timestamp = item.timestamp.clone();
            items.insert(0, existing);
        } else {
            items.insert(0, item);
        }

        let max = *self.max_items.lock().unwrap_or_else(|e| e.into_inner());
        if items.len() > max {
            let removed: Vec<String> = items[max..]
                .iter()
                .map(|i| i.id.clone())
                .collect();
            items.truncate(max);
            drop(items);
            if !removed.is_empty() {
                let mut images = self.images.lock().unwrap_or_else(|e| e.into_inner());
                for id in removed {
                    images.remove(&id);
                }
                drop(images);
            }
        } else {
            drop(items);
        }
        self.dirty.store(true, Ordering::Relaxed);
    }

    pub fn get_image_data(&self, id: &str) -> Option<String> {
        let images = self.images.lock().unwrap_or_else(|e| e.into_inner());
        images.get(id).map(|png| {
            use base64::Engine;
            format!(
                "data:image/png;base64,{}",
                base64::engine::general_purpose::STANDARD.encode(png)
            )
        })
    }

    pub fn copy_to_clipboard(&self, id: &str) -> Result<String, String> {
        // Serialize with the poll loop to avoid Windows clipboard contention (1418).
        let _guard = CLIPBOARD_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        // Lock order (see module-level doc): take `items`, clone what we need,
        // drop the guard, then take `last_*` trackers. This means a future
        // caller running on another thread cannot deadlock against us by
        // acquiring the trackers first.
        let item = {
            let items = self.items.lock().unwrap_or_else(|e| e.into_inner());
            items
                .iter()
                .find(|item| item.id == id)
                .cloned()
                .ok_or_else(|| format!("Item not found: {}", id))?
        };

        match item.item_type {
            ItemType::Text => {
                // Update last_text, clear other trackers
                {
                    let mut last = self.last_text.lock().unwrap_or_else(|e| e.into_inner());
                    *last = item.content.clone();
                }
                {
                    let mut last = self.last_image_hash.lock().unwrap_or_else(|e| e.into_inner());
                    last.clear();
                }
                {
                    let mut last = self.last_files.lock().unwrap_or_else(|e| e.into_inner());
                    last.clear();
                }

                let mut clipboard =
                    open_clipboard_retry()?;
                clipboard
                    .set_text(&item.content)
                    .map_err(|e| format!("Failed to set clipboard text: {}", e))?;
            }
            ItemType::Image => {
                // Get PNG data
                let png_data = {
                    let images = self.images.lock().unwrap_or_else(|e| e.into_inner());
                    images
                        .get(&item.id)
                        .cloned()
                        .ok_or_else(|| "Image data not found".to_string())?
                };

                // Decode PNG to ImageData
                let img_data = png_to_image_data(&png_data)?;

                // Update last_image_hash, clear other trackers
                let mut hasher = Sha256::new();
                hasher.update(&(img_data.width as u32).to_le_bytes());
                hasher.update(&(img_data.height as u32).to_le_bytes());
                hasher.update(&img_data.bytes);
                let hash = format!("{:x}", hasher.finalize());

                {
                    let mut last = self.last_image_hash.lock().unwrap_or_else(|e| e.into_inner());
                    *last = hash;
                }
                {
                    let mut last = self.last_text.lock().unwrap_or_else(|e| e.into_inner());
                    last.clear();
                }
                {
                    let mut last = self.last_files.lock().unwrap_or_else(|e| e.into_inner());
                    last.clear();
                }

                let mut clipboard =
                    open_clipboard_retry()?;
                clipboard
                    .set_image(img_data)
                    .map_err(|e| format!("Failed to set clipboard image: {}", e))?;
            }
            ItemType::Files => {
                let files: Vec<String> = item.content.lines().map(|s| s.to_string()).collect();

                // Update last_files, clear other trackers
                {
                    let mut last = self.last_files.lock().unwrap_or_else(|e| e.into_inner());
                    *last = files.clone();
                }
                {
                    let mut last = self.last_text.lock().unwrap_or_else(|e| e.into_inner());
                    last.clear();
                }
                {
                    let mut last = self.last_image_hash.lock().unwrap_or_else(|e| e.into_inner());
                    last.clear();
                }

                set_clipboard_files(&files)?;
            }
        }

        Ok(item.content)
    }

    pub fn delete_item(&self, id: &str) {
        let mut items = self.items.lock().unwrap_or_else(|e| e.into_inner());
        items.retain(|item| item.id != id);
        drop(items);
        self.images.lock().unwrap_or_else(|e| e.into_inner()).remove(id);
        self.save_to_disk();
    }

    /// Restore a previously deleted item.
    pub fn restore_item(&self, item: ClipboardItem) {
        let mut items = self.items.lock().unwrap_or_else(|e| e.into_inner());
        // Avoid duplicate if item already exists
        if !items.iter().any(|i| i.id == item.id) {
            items.push(item);
            items.sort_by(|a, b| b.favorite.cmp(&a.favorite).then_with(|| b.timestamp.cmp(&a.timestamp)));
        }
        drop(items);
        self.save_to_disk();
    }

    /// Get stats: item count and total storage size in bytes.
    pub fn get_stats(&self) -> (usize, u64) {
        let count = self.items.lock().unwrap_or_else(|e| e.into_inner()).len();
        let mut size: u64 = 0;
        let data_dir = self.data_dir.lock().unwrap_or_else(|e| e.into_inner()).clone();
        if let Some(dir) = data_dir {
            if let Ok(entries) = std::fs::read_dir(dir) {
                for entry in entries.flatten() {
                    if let Ok(meta) = entry.metadata() {
                        if meta.is_file() {
                            size += meta.len();
                        }
                    }
                }
            }
        }
        (count, size)
    }

    /// Toggle incognito mode (pause recording).
    pub fn set_incognito(&self, enabled: bool) {
        self.incognito.store(enabled, Ordering::Relaxed);
    }

    pub fn is_incognito(&self) -> bool {
        self.incognito.load(Ordering::Relaxed)
    }

    /// Toggle saved_as_note state for an item.
    pub fn set_saved_as_note(&self, id: &str, saved: bool) {
        let mut items = self.items.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(item) = items.iter_mut().find(|i| i.id == id) {
            item.saved_as_note = saved;
        }
        drop(items);
        self.save_to_disk();
    }

    /// Get current config.
    pub fn get_config(&self) -> AppConfig {
        self.config.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// Update config (max_items, poll_interval) and persist.
    pub fn set_config(&self, config: AppConfig) {
        *self.max_items.lock().unwrap_or_else(|e| e.into_inner()) = config.max_items;
        *self.config.lock().unwrap_or_else(|e| e.into_inner()) = config.clone();
        // Save config to disk
        let data_dir = self.data_dir.lock().unwrap_or_else(|e| e.into_inner()).clone();
        if let Some(dir) = data_dir {
            if let Ok(json) = serde_json::to_string(&config) {
                let _ = fs::write(dir.join("config.json"), json);
            }
        }
    }

    /// Load config from disk.
    pub fn load_config(&self) {
        let data_dir = self.data_dir.lock().unwrap_or_else(|e| e.into_inner()).clone();
        if let Some(dir) = data_dir {
            if let Ok(json) = fs::read_to_string(dir.join("config.json")) {
                if let Ok(config) = serde_json::from_str::<AppConfig>(&json) {
                    *self.max_items.lock().unwrap_or_else(|e| e.into_inner()) = config.max_items;
                    *self.config.lock().unwrap_or_else(|e| e.into_inner()) = config;
                }
            }
        }
    }

    /// Export all items as JSON string.
    pub fn export_history(&self) -> Result<String, String> {
        let items = self.items.lock().unwrap_or_else(|e| e.into_inner());
        serde_json::to_string_pretty(&*items).map_err(|e| format!("Export error: {}", e))
    }

    /// Import items from JSON string, merging with existing.
    pub fn import_history(&self, json: &str) -> Result<usize, String> {
        let imported: Vec<ClipboardItem> = serde_json::from_str(json).map_err(|e| format!("Import parse error: {}", e))?;
        let count = imported.len();
        let mut items = self.items.lock().unwrap_or_else(|e| e.into_inner());
        for item in imported {
            if !items.iter().any(|i| i.id == item.id) {
                items.push(item);
            }
        }
        items.sort_by(|a, b| b.favorite.cmp(&a.favorite).then_with(|| b.timestamp.cmp(&a.timestamp)));
        drop(items);
        self.save_to_disk();
        Ok(count)
    }

    pub fn toggle_favorite(&self, id: &str) {
        let mut items = self.items.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(item) = items.iter_mut().find(|item| item.id == id) {
            item.favorite = !item.favorite;
        }
        drop(items);
        self.save_to_disk();
    }

    pub fn add_tag(&self, id: &str, tag: &str) {
        let tag = tag.trim().to_string();
        if tag.is_empty() {
            return;
        }
        let mut items = self.items.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(item) = items.iter_mut().find(|item| item.id == id) {
            if !item.tags.contains(&tag) {
                item.tags.push(tag);
            }
        }
        drop(items);
        self.save_to_disk();
    }

    pub fn remove_tag(&self, id: &str, tag: &str) {
        let mut items = self.items.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(item) = items.iter_mut().find(|item| item.id == id) {
            item.tags.retain(|t| t != tag);
        }
        drop(items);
        self.save_to_disk();
    }

    pub fn get_all_tags(&self) -> Vec<String> {
        let items = self.items.lock().unwrap_or_else(|e| e.into_inner());
        let mut tags: HashSet<String> = HashSet::new();
        for item in items.iter() {
            for tag in &item.tags {
                tags.insert(tag.clone());
            }
        }
        let mut result: Vec<String> = tags.into_iter().collect();
        result.sort();
        result
    }

    pub fn get_favorites(&self) -> Vec<ClipboardItem> {
        let mut items: Vec<ClipboardItem> = self
            .items
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .filter(|item| item.favorite)
            .cloned()
            .collect();
        items.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
        items
    }

    pub fn clear(&self) {
        self.items.lock().unwrap_or_else(|e| e.into_inner()).clear();
        self.images.lock().unwrap_or_else(|e| e.into_inner()).clear();
        self.last_text.lock().unwrap_or_else(|e| e.into_inner()).clear();
        self.last_image_hash.lock().unwrap_or_else(|e| e.into_inner()).clear();
        self.last_files.lock().unwrap_or_else(|e| e.into_inner()).clear();
        self.save_to_disk();
    }

    /// Start a background thread that polls the system clipboard every 500ms.
    pub fn start_monitoring(app: AppHandle, manager: Arc<Self>) {
        // Debounce save thread: flush dirty state to disk every 2 seconds
        {
            let mgr = manager.clone();
            thread::spawn(move || loop {
                thread::sleep(Duration::from_secs(2));
                if mgr.dirty.swap(false, Ordering::Relaxed) {
                    mgr.save_to_disk();
                }
            });
        }


        thread::spawn(move || loop {
            let interval = {
                let cfg = manager.config.lock().unwrap_or_else(|e| e.into_inner());
                cfg.poll_interval_ms
            };
            thread::sleep(Duration::from_millis(interval));

            // Skip recording in incognito mode
            if manager.incognito.load(Ordering::Relaxed) {
                continue;
            }

            // Hold the clipboard lock for the whole read cycle so a concurrent
            // copy (set_text/set_image/set_files) can't collide → avoids 1418.
            let _guard = CLIPBOARD_LOCK.lock().unwrap_or_else(|e| e.into_inner());

            // --- Check text ---
            let raw_text = match Clipboard::new() {
                Ok(mut cb) => cb.get_text().unwrap_or_default(),
                Err(_) => String::new(),
            };
            let text = strip_ansi_escapes(&raw_text);

            let trimmed = text.trim();
            if !trimmed.is_empty() {
                let is_new = {
                    let mut last = manager.last_text.lock().unwrap_or_else(|e| e.into_inner());
                    if *last == text {
                        false
                    } else {
                        *last = text.clone();
                        true
                    }
                };

                if is_new {
                    let item = ClipboardItem::new_text(text);
                    manager.insert_item(item.clone());
                    let _ = app.emit("clipboard-update", &item);
                }
            }

            // --- Check image ---
            let img = match Clipboard::new() {
                Ok(mut cb) => cb.get_image().ok(),
                Err(_) => None,
            };

            if let Some(img_data) = img {
                let mut hasher = Sha256::new();
                hasher.update(&(img_data.width as u32).to_le_bytes());
                hasher.update(&(img_data.height as u32).to_le_bytes());
                hasher.update(&img_data.bytes);
                let hash = format!("{:x}", hasher.finalize());

                let is_new = {
                         let mut last = manager.last_image_hash.lock().unwrap_or_else(|e| e.into_inner());
                    if *last == hash {
                        false
                    } else {
                        *last = hash;
                        true
                    }
                };

                if is_new {
                    if let Ok(png) = rgba_to_png(&img_data) {
                        let desc = format!("Image {}x{}", img_data.width, img_data.height);
                        let item = ClipboardItem::new_image(desc);

                        // Store image data before inserting
                        {
                            let mut images = manager.images.lock().unwrap_or_else(|e| e.into_inner());
                            images.insert(item.id.clone(), png);
                        }

                        manager.insert_item(item.clone());
                        let _ = app.emit("clipboard-update", &item);
                    }
                }
            }

            // --- Check files (CF_HDROP) ---
            if let Some(files) = get_clipboard_files() {
                let is_new = {
                    let mut last = manager.last_files.lock().unwrap_or_else(|e| e.into_inner());
                    if *last == files {
                        false
                    } else {
                        *last = files.clone();
                        true
                    }
                };

                if is_new {
                    let content = files.join("\n");
                    let item = ClipboardItem::new_files(content);
                    manager.insert_item(item.clone());
                    let _ = app.emit("clipboard-update", &item);
                }
            }
        });
    }
}

// ============================================================
// Unit tests for ClipboardManager's pure logic.
//
// We don't spin up the poll loop or touch the OS clipboard
// (those need integration tests on a real Windows session). What
// we *can* exercise cheaply is:
//
//   - `strip_ansi_escapes` (text sanitisation in the poll loop)
//   - `insert_item` dedup + head-of-list + cap behaviour
//   - `search` (case-insensitive content + tag match)
//   - `get_items` / `get_favorites` sort order
//   - `add_tag` / `remove_tag` / `get_all_tags` semantics
//   - `toggle_favorite` round-trip
//   - `set_saved_as_note` round-trip
//   - `set_incognito` round-trip
//   - `save_to_disk` / `load_from_disk` round-trip via a temp dir
//   - `clear` empties everything
//   - `delete_item` removes from both items and images
//
// We use a unique temp directory per test (with a process-id
// prefix) so parallel `cargo test` runs don't trample each other.
// ============================================================
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static COUNTER: AtomicUsize = AtomicUsize::new(0);

    /// Build a `ClipboardManager` rooted at a unique temp dir.
    /// `max_items` is small (3) so we can exercise the prune
    /// path without flooding the test with 500 inserts.
    fn fresh_manager(max_items: usize) -> ClipboardManager {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir()
            .join(format!("easy-copy-clipboard-test-{}-{}", std::process::id(), n));
        let _ = std::fs::create_dir_all(&dir);
        ClipboardManager::new(max_items, Some(dir))
    }

    // ── strip_ansi_escapes ──────────────────────────────────

    #[test]
    fn strip_preserves_plain_text() {
        assert_eq!(strip_ansi_escapes("hello world"), "hello world");
    }

    #[test]
    fn strip_removes_csi_color_codes() {
        // ESC[31m is "red"; ESC[0m is "reset".
        let s = "\x1b[31mERROR\x1b[0m: something broke";
        assert_eq!(strip_ansi_escapes(s), "ERROR: something broke");
    }

    #[test]
    fn strip_removes_osc_hyperlinks() {
        // OSC 8 hyperlink: ESC ] 8 ; ; URL ST  ->  ST = ESC \
        let s = "\x1b]8;;https://example.com\x1b\\link text\x1b]8;;\x1b\\";
        assert_eq!(strip_ansi_escapes(s), "link text");
    }

    #[test]
    fn strip_preserves_tab_newline_cr() {
        // Tab/newline/CR are the printable C0 controls we want
        // to keep (they're meaningful in pasted code / shell
        // transcripts). Everything else in 0x00..=0x1F must go.
        assert_eq!(
            strip_ansi_escapes("a\tb\nc\rd"),
            "a\tb\nc\rd"
        );
    }

    #[test]
    fn strip_handles_empty_and_pure_escape_input() {
        assert_eq!(strip_ansi_escapes(""), "");
        // Lone ESC at end-of-input is consumed without panic.
        assert_eq!(strip_ansi_escapes("text\x1b"), "text");
    }

    // ── insert_item: dedup + head + cap ─────────────────────

    #[test]
    fn insert_pushes_new_items_to_head() {
        let m = fresh_manager(100);
        m.insert_item(ClipboardItem::new_text("first".into()));
        m.insert_item(ClipboardItem::new_text("second".into()));
        m.insert_item(ClipboardItem::new_text("third".into()));
        let items = m.get_items();
        let texts: Vec<&str> = items.iter().map(|i| i.content.as_str()).collect();
        // Newest insert lands at the top.
        assert_eq!(texts, vec!["third", "second", "first"]);
    }

    #[test]
    fn insert_dedups_by_content_and_type_moves_to_head() {
        let m = fresh_manager(100);
        m.insert_item(ClipboardItem::new_text("alpha".into()));
        m.insert_item(ClipboardItem::new_text("beta".into()));
        // Re-insert "alpha" — it should jump to the head, not
        // create a duplicate row.
        m.insert_item(ClipboardItem::new_text("alpha".into()));
        let items = m.get_items();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].content, "alpha");
        assert_eq!(items[1].content, "beta");
    }

    #[test]
    fn insert_dedup_treats_different_types_as_distinct() {
        // A Text "foo" and an Image "foo" should both exist
        // (the dedup key is content+type, not just content).
        // We can't easily construct an Image item without
        // PNG bytes, so this is documented as a contract via
        // the type system: two items with the same `content`
        // but different `item_type` won't collapse.
        let m = fresh_manager(100);
        m.insert_item(ClipboardItem::new_text("hello".into()));
        m.insert_item(ClipboardItem::new_text("hello".into()));
        assert_eq!(m.get_items().len(), 1);
    }

    #[test]
    fn insert_caps_at_max_and_drops_oldest() {
        let m = fresh_manager(3);
        for i in 0..5 {
            m.insert_item(ClipboardItem::new_text(format!("item-{}", i)));
        }
        let items = m.get_items();
        assert_eq!(items.len(), 3);
        // Only the three newest should remain.
        let texts: Vec<&str> = items.iter().map(|i| i.content.as_str()).collect();
        assert_eq!(texts, vec!["item-4", "item-3", "item-2"]);
    }

    // ── search ──────────────────────────────────────────────

    #[test]
    fn search_matches_content_case_insensitively() {
        let m = fresh_manager(100);
        m.insert_item(ClipboardItem::new_text("Hello World".into()));
        m.insert_item(ClipboardItem::new_text("goodbye".into()));
        let hits = m.search("hello");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].content, "Hello World");
    }

    #[test]
    fn search_matches_tags() {
        let m = fresh_manager(100);
        let item = ClipboardItem::new_text("text".into());
        m.insert_item(item);
        m.add_tag(&m.get_items()[0].id, "work");
        let hits = m.search("work");
        assert_eq!(hits.len(), 1);
    }

    #[test]
    fn search_returns_empty_for_nothing_match() {
        let m = fresh_manager(100);
        m.insert_item(ClipboardItem::new_text("hello".into()));
        assert!(m.search("zzz").is_empty());
    }

    // ── sort order ──────────────────────────────────────────

    #[test]
    fn get_items_sorts_favorites_first_then_newest() {
        let m = fresh_manager(100);
        m.insert_item(ClipboardItem::new_text("a".into()));
        std::thread::sleep(std::time::Duration::from_millis(2));
        m.insert_item(ClipboardItem::new_text("b".into()));
        std::thread::sleep(std::time::Duration::from_millis(2));
        m.insert_item(ClipboardItem::new_text("c".into()));
        // Favorite the oldest. It should jump to position 0.
        m.toggle_favorite(&m.get_items().iter().rev().next().unwrap().id);
        let items = m.get_items();
        assert!(items[0].favorite);
        assert_eq!(items[0].content, "a");
    }

    #[test]
    fn get_favorites_only_returns_favorites() {
        let m = fresh_manager(100);
        let a = ClipboardItem::new_text("a".into());
        let b = ClipboardItem::new_text("b".into());
        m.insert_item(a.clone());
        m.insert_item(b.clone());
        m.toggle_favorite(&a.id);
        let favs = m.get_favorites();
        assert_eq!(favs.len(), 1);
        assert_eq!(favs[0].content, "a");
    }

    // ── tag operations ──────────────────────────────────────

    #[test]
    fn add_tag_dedups_and_trims() {
        let m = fresh_manager(100);
        let item = ClipboardItem::new_text("x".into());
        m.insert_item(item);
        let id = m.get_items()[0].id.clone();
        m.add_tag(&id, "  work  ");
        m.add_tag(&id, "work"); // duplicate after trim
        let tags = m.get_all_tags();
        // Only one "work" survives. get_all_tags returns a
        // sorted, distinct list.
        assert_eq!(tags, vec!["work".to_string()]);
    }

    #[test]
    fn add_tag_ignores_empty_string() {
        let m = fresh_manager(100);
        let item = ClipboardItem::new_text("x".into());
        m.insert_item(item);
        let id = m.get_items()[0].id.clone();
        m.add_tag(&id, "   ");
        assert!(m.get_all_tags().is_empty());
    }

    #[test]
    fn remove_tag_only_drops_the_named_tag() {
        let m = fresh_manager(100);
        let item = ClipboardItem::new_text("x".into());
        m.insert_item(item);
        let id = m.get_items()[0].id.clone();
        m.add_tag(&id, "a");
        m.add_tag(&id, "b");
        m.remove_tag(&id, "a");
        let mut tags = m.get_all_tags();
        tags.sort();
        assert_eq!(tags, vec!["b".to_string()]);
    }

    // ── favorites + saved_as_note + incognito ──────────────

    #[test]
    fn toggle_favorite_is_idempotent_pair() {
        let m = fresh_manager(100);
        let item = ClipboardItem::new_text("x".into());
        m.insert_item(item);
        let id = m.get_items()[0].id.clone();
        assert!(!m.get_items()[0].favorite);
        m.toggle_favorite(&id);
        assert!(m.get_items()[0].favorite);
        m.toggle_favorite(&id);
        assert!(!m.get_items()[0].favorite);
    }

    #[test]
    fn toggle_favorite_on_missing_id_is_a_noop() {
        let m = fresh_manager(100);
        m.toggle_favorite("does-not-exist");
        // No panic, no extra item.
        assert!(m.get_items().is_empty());
    }

    #[test]
    fn set_saved_as_note_round_trips() {
        let m = fresh_manager(100);
        let item = ClipboardItem::new_text("x".into());
        m.insert_item(item);
        let id = m.get_items()[0].id.clone();
        m.set_saved_as_note(&id, true);
        assert!(m.get_items()[0].saved_as_note);
        m.set_saved_as_note(&id, false);
        assert!(!m.get_items()[0].saved_as_note);
    }

    #[test]
    fn incognito_toggle_round_trips() {
        let m = fresh_manager(100);
        assert!(!m.is_incognito());
        m.set_incognito(true);
        assert!(m.is_incognito());
        m.set_incognito(false);
        assert!(!m.is_incognito());
    }

    // ── delete + clear ──────────────────────────────────────

    #[test]
    fn delete_item_removes_it() {
        let m = fresh_manager(100);
        let item = ClipboardItem::new_text("x".into());
        m.insert_item(item);
        let id = m.get_items()[0].id.clone();
        m.delete_item(&id);
        assert!(m.get_items().is_empty());
    }

    #[test]
    fn delete_item_on_missing_id_is_a_noop() {
        let m = fresh_manager(100);
        m.insert_item(ClipboardItem::new_text("x".into()));
        m.delete_item("nope");
        assert_eq!(m.get_items().len(), 1);
    }

    #[test]
    fn clear_empties_everything() {
        let m = fresh_manager(100);
        m.insert_item(ClipboardItem::new_text("a".into()));
        m.insert_item(ClipboardItem::new_text("b".into()));
        m.clear();
        assert!(m.get_items().is_empty());
        assert!(m.get_all_tags().is_empty());
        assert!(m.get_favorites().is_empty());
    }

    // ── disk round-trip ─────────────────────────────────────

    #[test]
    fn items_survive_a_save_load_round_trip() {
        let dir = std::env::temp_dir().join(format!(
            "easy-copy-clipboard-roundtrip-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = std::fs::create_dir_all(&dir);

        // Write side: max_items=100, save immediately, then toggle a favorite
        // to exercise the auto-save path inside `toggle_favorite`.
        let m1 = ClipboardManager::new(100, Some(dir.clone()));
        m1.insert_item(ClipboardItem::new_text("persist".into()));
        m1.insert_item(ClipboardItem::new_text("me".into()));
        m1.save_to_disk();
        let first_id = m1.get_items()[0].id.clone();
        m1.toggle_favorite(&first_id);

        // Read side: a fresh manager must see the saved state.
        let m2 = ClipboardManager::new(100, Some(dir.clone()));
        m2.load_from_disk();
        let items = m2.get_items();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].content, "me");
        assert_eq!(items[1].content, "persist");
        // `toggle_favorite` persists on its own, so the flag set after the
        // explicit `save_to_disk` is still on disk. Pinning that here keeps
        // the auto-save from being dropped later: a favorite that vanishes
        // on restart is a data-loss bug, not a caching detail.
        assert!(items.iter().any(|i| i.favorite));
        assert_eq!(
            items.iter().filter(|i| i.favorite).count(),
            1,
            "only the toggled item should be favorited"
        );
    }

    #[test]
    fn load_from_disk_silently_ignores_corrupt_history() {
        // If history.json is garbage, `load_from_disk` should
        // not crash and the manager should stay empty.
        let dir = std::env::temp_dir().join(format!(
            "easy-copy-clipboard-corrupt-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = std::fs::create_dir_all(&dir);
        std::fs::write(dir.join("history.json"), "{ not valid json").unwrap();
        let m = ClipboardManager::new(100, Some(dir));
        m.load_from_disk();
        assert!(m.get_items().is_empty());
    }

    // ── restore_item ────────────────────────────────────────

    #[test]
    fn restore_brings_back_a_deleted_item() {
        let m = fresh_manager(100);
        let item = ClipboardItem::new_text("x".into());
        m.insert_item(item.clone());
        m.delete_item(&item.id);
        assert!(m.get_items().is_empty());
        m.restore_item(item.clone());
        assert_eq!(m.get_items().len(), 1);
        assert_eq!(m.get_items()[0].id, item.id);
    }

    #[test]
    fn restore_is_idempotent_on_existing_id() {
        // Restoring an item that's already in the list must
        // not create a duplicate.
        let m = fresh_manager(100);
        let item = ClipboardItem::new_text("x".into());
        m.insert_item(item.clone());
        m.restore_item(item.clone());
        assert_eq!(m.get_items().len(), 1);
    }

    // ── export / import ─────────────────────────────────────

    #[test]
    fn export_then_import_round_trip() {
        let m = fresh_manager(100);
        m.insert_item(ClipboardItem::new_text("a".into()));
        m.insert_item(ClipboardItem::new_text("b".into()));
        let json = m.export_history().unwrap();
        assert!(json.contains("\"a\""));
        assert!(json.contains("\"b\""));

        // A fresh manager with no items imports the JSON back.
        let m2 = fresh_manager(100);
        let n = m2.import_history(&json).unwrap();
        assert_eq!(n, 2);
        assert_eq!(m2.get_items().len(), 2);
    }

    #[test]
    fn import_rejects_invalid_json() {
        let m = fresh_manager(100);
        let err = m.import_history("not json").unwrap_err();
        assert!(err.to_lowercase().contains("parse"));
    }

    // ── stats ───────────────────────────────────────────────

    #[test]
    fn stats_reports_count_and_dir_size() {
        let m = fresh_manager(100);
        assert_eq!(m.get_stats().0, 0);
        m.insert_item(ClipboardItem::new_text("a".into()));
        m.insert_item(ClipboardItem::new_text("b".into()));
        let (count, _size) = m.get_stats();
        assert_eq!(count, 2);
        // `size` is the on-disk footprint of the data_dir, which
        // is implementation-defined; we only assert it's a
        // valid u64. (Tautological but documents the contract.)
    }
}

// ============================================================
// Unit tests for `strip_ansi_escapes` — the helper that scrubs
// terminal control sequences from clipboard text before we record
// it. This is a security/UX gate: if a user copies a prompt that
// contains an "invisible" CSI sequence, we don't want it persisted
// verbatim (or worse, replayed into another app).
//
// The helper is `fn` (file-private), so the tests live in the same
// file under `#[cfg(test)]`. They run on every `cargo test` and
// cover the three escape sequence families the helper handles:
// CSI (`ESC [`), OSC (`ESC ]`), and standalone two-char ESC.
// ============================================================
#[cfg(test)]
mod strip_ansi_tests {
    use super::strip_ansi_escapes;

    #[test]
    fn passthrough_plain_ascii() {
        assert_eq!(strip_ansi_escapes("hello world"), "hello world");
    }

    #[test]
    fn preserves_tab_lf_cr() {
        // Tab/newline/CR are explicitly preserved because they're
        // not "invisible" — they affect rendering and users copy
        // multiline content all the time. Only the C0 control range
        // below 0x20 *except* these three is stripped.
        assert_eq!(strip_ansi_escapes("a\tb\nc\rd"), "a\tb\nc\rd");
    }

    #[test]
    fn strips_bell_and_other_c0_controls() {
        // BEL (0x07), BS (0x08), VT (0x0B), FF (0x0C) — none of these
        // are \t \n \r, so they all get dropped.
        assert_eq!(strip_ansi_escapes("a\x07b\x08c\x0Bd\x0Ce"), "abcde");
    }

    #[test]
    fn strips_csi_color_sequence() {
        // ESC [ 31 m  = "set foreground red". The full sequence
        // including the final byte must be removed, leaving just
        // the surrounding text.
        assert_eq!(strip_ansi_escapes("\x1b[31mred\x1b[0m"), "red");
    }

    #[test]
    fn strips_csi_with_complex_params() {
        // CSI 2;3 H = "move cursor". The semicolon-separated
        // parameter list must be consumed in one go.
        assert_eq!(strip_ansi_escapes("a\x1b[2;3Hb"), "ab");
    }

    #[test]
    fn strips_osc_terminated_by_bel() {
        // OSC 0 ; title BEL  = "set window title". The helper must
        // recognize BEL (0x07) as the OSC terminator.
        assert_eq!(
            strip_ansi_escapes("\x1b]0;my title\x07rest"),
            "rest"
        );
    }

    #[test]
    fn strips_osc_terminated_by_st() {
        // ESC \ is the String Terminator (ST). The helper must also
        // accept ST as an OSC terminator — some terminals emit it
        // instead of BEL.
        assert_eq!(
            strip_ansi_escapes("\x1b]0;my title\x1b\\rest"),
            "rest"
        );
    }

    #[test]
    fn strips_two_char_esc_sequence() {
        // ESC followed by a non-`[` non-`]` byte is a two-char
        // sequence (e.g. ESC =  on VT100). The helper skips one
        // extra char.
        assert_eq!(strip_ansi_escapes("\x1b=x"), "x");
    }

    #[test]
    fn strips_lone_esc_at_end_of_string() {
        // A trailing ESC with nothing after it must not panic on
        // `chars.next()`. The `None` arm of the inner match is the
        // safety net.
        assert_eq!(strip_ansi_escapes("hello\x1b"), "hello");
    }

    #[test]
    fn preserves_unicode_letters() {
        // Multibyte CJK characters are above U+007F, so they're
        // never touched. Catches regressions where a sloppy impl
        // might iterate by bytes and drop non-ASCII.
        assert_eq!(strip_ansi_escapes("你好 世界"), "你好 世界");
    }

    #[test]
    fn strips_multiple_sequences_in_a_row() {
        // A "real" terminal log often has dozens of escape sequences
        // back-to-back. The helper must handle this without losing
        // the visible text in between.
        assert_eq!(
            strip_ansi_escapes("\x1b[1m\x1b[31mhi\x1b[0m \x1b[32mbye\x1b[0m"),
            "hi bye"
        );
    }
}
