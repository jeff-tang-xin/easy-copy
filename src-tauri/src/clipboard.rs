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
    data_dir: Option<PathBuf>,
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
            data_dir,
            dirty: Arc::new(AtomicBool::new(false)),
            incognito: Arc::new(AtomicBool::new(false)),
            config: Arc::new(Mutex::new(AppConfig::default())),
        }
    }

    /// Save items (JSON) and images (PNG files) to disk.
    pub fn save_to_disk(&self) {
        let data_dir = match &self.data_dir {
            Some(d) => d,
            None => return,
        };
        let _ = fs::create_dir_all(data_dir);

        // Save items as JSON
        let items = self.items.lock().unwrap();
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
        let images = self.images.lock().unwrap();
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
        let data_dir = match &self.data_dir {
            Some(d) => d,
            None => return,
        };

        // Load items from JSON
        if let Ok(json) = fs::read_to_string(data_dir.join("history.json")) {
            if let Ok(items) = serde_json::from_str::<Vec<ClipboardItem>>(&json) {
                let mut self_items = self.items.lock().unwrap();
                *self_items = items;
            }
        }

        // Load images from individual PNG files
        let images_dir = data_dir.join("images");
        if let Ok(entries) = fs::read_dir(&images_dir) {
            let mut images = self.images.lock().unwrap();
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
        let mut items = self.items.lock().unwrap().clone();
        items.sort_by(|a, b| b.favorite.cmp(&a.favorite).then_with(|| b.timestamp.cmp(&a.timestamp)));
        items
    }

    pub fn search(&self, query: &str) -> Vec<ClipboardItem> {
        let query_lower = query.to_lowercase();
        let mut results: Vec<ClipboardItem> = self.items
            .lock()
            .unwrap()
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
    fn insert_item(&self, item: ClipboardItem) {
        let mut items = self.items.lock().unwrap();

        // Dedup: if same content+type exists, move it to top with fresh timestamp
        if let Some(pos) = items.iter().position(|i| i.content == item.content && i.item_type == item.item_type) {
            let mut existing = items.remove(pos);
            existing.timestamp = item.timestamp.clone();
            items.insert(0, existing);
        } else {
            items.insert(0, item);
        }

        let max = *self.max_items.lock().unwrap();
        if items.len() > max {
            let removed: Vec<String> = items[max..]
                .iter()
                .map(|i| i.id.clone())
                .collect();
            items.truncate(max);
            drop(items);
            if !removed.is_empty() {
                let mut images = self.images.lock().unwrap();
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
        let images = self.images.lock().unwrap();
        images.get(id).map(|png| {
            use base64::Engine;
            format!(
                "data:image/png;base64,{}",
                base64::engine::general_purpose::STANDARD.encode(png)
            )
        })
    }

    pub fn copy_to_clipboard(&self, id: &str) -> Result<String, String> {
        let item = {
            let items = self.items.lock().unwrap();
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
                    let mut last = self.last_text.lock().unwrap();
                    *last = item.content.clone();
                }
                {
                    let mut last = self.last_image_hash.lock().unwrap();
                    last.clear();
                }
                {
                    let mut last = self.last_files.lock().unwrap();
                    last.clear();
                }

                let mut clipboard =
                    Clipboard::new().map_err(|e| format!("Failed to access clipboard: {}", e))?;
                clipboard
                    .set_text(&item.content)
                    .map_err(|e| format!("Failed to set clipboard text: {}", e))?;
            }
            ItemType::Image => {
                // Get PNG data
                let png_data = {
                    let images = self.images.lock().unwrap();
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
                    let mut last = self.last_image_hash.lock().unwrap();
                    *last = hash;
                }
                {
                    let mut last = self.last_text.lock().unwrap();
                    last.clear();
                }
                {
                    let mut last = self.last_files.lock().unwrap();
                    last.clear();
                }

                let mut clipboard =
                    Clipboard::new().map_err(|e| format!("Failed to access clipboard: {}", e))?;
                clipboard
                    .set_image(img_data)
                    .map_err(|e| format!("Failed to set clipboard image: {}", e))?;
            }
            ItemType::Files => {
                let files: Vec<String> = item.content.lines().map(|s| s.to_string()).collect();

                // Update last_files, clear other trackers
                {
                    let mut last = self.last_files.lock().unwrap();
                    *last = files.clone();
                }
                {
                    let mut last = self.last_text.lock().unwrap();
                    last.clear();
                }
                {
                    let mut last = self.last_image_hash.lock().unwrap();
                    last.clear();
                }

                set_clipboard_files(&files)?;
            }
        }

        Ok(item.content)
    }

    pub fn delete_item(&self, id: &str) {
        let mut items = self.items.lock().unwrap();
        items.retain(|item| item.id != id);
        drop(items);
        self.images.lock().unwrap().remove(id);
        self.save_to_disk();
    }

    /// Restore a previously deleted item.
    pub fn restore_item(&self, item: ClipboardItem) {
        let mut items = self.items.lock().unwrap();
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
        let count = self.items.lock().unwrap().len();
        let mut size: u64 = 0;
        if let Some(ref dir) = self.data_dir {
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

    /// Get current config.
    pub fn get_config(&self) -> AppConfig {
        self.config.lock().unwrap().clone()
    }

    /// Update config (max_items, poll_interval) and persist.
    pub fn set_config(&self, config: AppConfig) {
        *self.max_items.lock().unwrap() = config.max_items;
        *self.config.lock().unwrap() = config.clone();
        // Save config to disk
        if let Some(ref dir) = self.data_dir {
            if let Ok(json) = serde_json::to_string(&config) {
                let _ = fs::write(dir.join("config.json"), json);
            }
        }
    }

    /// Load config from disk.
    pub fn load_config(&self) {
        if let Some(ref dir) = self.data_dir {
            if let Ok(json) = fs::read_to_string(dir.join("config.json")) {
                if let Ok(config) = serde_json::from_str::<AppConfig>(&json) {
                    *self.max_items.lock().unwrap() = config.max_items;
                    *self.config.lock().unwrap() = config;
                }
            }
        }
    }

    /// Export all items as JSON string.
    pub fn export_history(&self) -> Result<String, String> {
        let items = self.items.lock().unwrap();
        serde_json::to_string_pretty(&*items).map_err(|e| format!("Export error: {}", e))
    }

    /// Import items from JSON string, merging with existing.
    pub fn import_history(&self, json: &str) -> Result<usize, String> {
        let imported: Vec<ClipboardItem> = serde_json::from_str(json).map_err(|e| format!("Import parse error: {}", e))?;
        let count = imported.len();
        let mut items = self.items.lock().unwrap();
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
        let mut items = self.items.lock().unwrap();
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
        let mut items = self.items.lock().unwrap();
        if let Some(item) = items.iter_mut().find(|item| item.id == id) {
            if !item.tags.contains(&tag) {
                item.tags.push(tag);
            }
        }
        drop(items);
        self.save_to_disk();
    }

    pub fn remove_tag(&self, id: &str, tag: &str) {
        let mut items = self.items.lock().unwrap();
        if let Some(item) = items.iter_mut().find(|item| item.id == id) {
            item.tags.retain(|t| t != tag);
        }
        drop(items);
        self.save_to_disk();
    }

    pub fn get_all_tags(&self) -> Vec<String> {
        let items = self.items.lock().unwrap();
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
            .unwrap()
            .iter()
            .filter(|item| item.favorite)
            .cloned()
            .collect();
        items.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
        items
    }

    pub fn clear(&self) {
        self.items.lock().unwrap().clear();
        self.images.lock().unwrap().clear();
        self.last_image_hash.lock().unwrap().clear();
        self.last_files.lock().unwrap().clear();
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
                let cfg = manager.config.lock().unwrap();
                cfg.poll_interval_ms
            };
            thread::sleep(Duration::from_millis(interval));

            // Skip recording in incognito mode
            if manager.incognito.load(Ordering::Relaxed) {
                continue;
            }

            // --- Check text ---
            let text = match Clipboard::new() {
                Ok(mut cb) => cb.get_text().unwrap_or_default(),
                Err(_) => continue,
            };

            let trimmed = text.trim();
            if !trimmed.is_empty() {
                let is_new = {
                    let mut last = manager.last_text.lock().unwrap();
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
                    let mut last = manager.last_image_hash.lock().unwrap();
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
                            let mut images = manager.images.lock().unwrap();
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
                    let mut last = manager.last_files.lock().unwrap();
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
