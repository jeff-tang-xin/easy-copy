use serde::{Deserialize, Serialize};
use chrono::Utc;
use sha2::Digest;

// ── Clipboard Item ──────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub enum ItemType {
    #[default]
    Text,
    Image,
    Files,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClipboardItem {
    pub id: String,
    pub content: String,
    pub timestamp: i64,
    pub content_type: String,
    pub pinned: bool,
    pub tags: Vec<String>,
    pub incognito: bool,
    pub hash: String,
    pub saved_as_note: bool,
    pub source_clip_id: Option<String>,
    #[serde(rename = "type", default)]
    pub item_type: ItemType,
    #[serde(default)]
    pub favorite: bool,
}

impl ClipboardItem {
    pub fn new_text(content: String) -> Self {
        let now = Utc::now().timestamp_millis();
        let hash = format!("{:x}", sha2::Sha256::digest(&content));
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            content,
            timestamp: now,
            content_type: "text/plain".into(),
            pinned: false,
            tags: vec![],
            incognito: false,
            hash,
            saved_as_note: false,
            source_clip_id: None,
            item_type: ItemType::Text,
            favorite: false,
        }
    }

    pub fn new_image(desc: String) -> Self {
        let now = Utc::now().timestamp_millis();
        let hash = format!("{:x}", sha2::Sha256::digest(&desc));
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            content: desc,
            timestamp: now,
            content_type: "image".into(),
            pinned: false,
            tags: vec![],
            incognito: false,
            hash,
            saved_as_note: false,
            source_clip_id: None,
            item_type: ItemType::Image,
            favorite: false,
        }
    }

    pub fn new_files(content: String) -> Self {
        let now = Utc::now().timestamp_millis();
        let hash = format!("{:x}", sha2::Sha256::digest(&content));
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            content,
            timestamp: now,
            content_type: "files".into(),
            pinned: false,
            tags: vec![],
            incognito: false,
            hash,
            saved_as_note: false,
            source_clip_id: None,
            item_type: ItemType::Files,
            favorite: false,
        }
    }
}

// ── Note ───────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Note {
    pub id: String,
    pub title: String,
    pub content: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub tags: Vec<String>,
    pub source_clip_id: Option<String>,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub category: Option<String>,
}

impl Note {
    pub fn new(input: NoteInput, source_clip_id: Option<String>) -> Self {
        let now = Utc::now().timestamp_millis();
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            title: input.title,
            content: input.content,
            created_at: now,
            updated_at: now,
            tags: input.tags,
            source_clip_id,
            pinned: false,
            category: input.category,
        }
    }

    pub fn apply_update(&mut self, input: NoteInput) {
        self.title = input.title;
        self.content = input.content;
        self.tags = input.tags;
        self.category = input.category;
        self.updated_at = Utc::now().timestamp_millis();
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteInput {
    pub title: String,
    pub content: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub category: Option<String>,
}

// ── App Config ─────────────────────────────────────────────────

fn default_clip_sc() -> String { "Ctrl+Shift+V".into() }
fn default_notes_sc() -> String { "Ctrl+Shift+N".into() }
fn default_tools_sc() -> String { "Ctrl+Shift+T".into() }
fn default_screenshot_sc() -> String { "Ctrl+Shift+S".into() }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    #[serde(default = "default_max_items")]
    pub max_items: usize,
    #[serde(default = "default_poll_interval")]
    pub poll_interval_ms: u64,
    #[serde(default = "default_clip_sc")]
    pub clipboard_shortcut: String,
    #[serde(default = "default_notes_sc")]
    pub notes_shortcut: String,
    #[serde(default = "default_tools_sc")]
    pub tools_shortcut: String,
    #[serde(default = "default_screenshot_sc")]
    pub screenshot_shortcut: String,
    #[serde(default = "default_true")]
    pub copy_on_double_click: bool,
}

fn default_true() -> bool { true }

fn default_max_items() -> usize { 500 }
fn default_poll_interval() -> u64 { 500 }

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            max_items: default_max_items(),
            poll_interval_ms: default_poll_interval(),
            clipboard_shortcut: default_clip_sc(),
            notes_shortcut: default_notes_sc(),
            tools_shortcut: default_tools_sc(),
            screenshot_shortcut: default_screenshot_sc(),
            copy_on_double_click: true,
        }
    }
}
