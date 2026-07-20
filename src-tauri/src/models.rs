use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum ItemType {
    Text,
    Image,
    Files,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClipboardItem {
    pub id: String,
    #[serde(rename = "type")]
    pub item_type: ItemType,
    pub content: String,
    pub timestamp: DateTime<Utc>,
    pub favorite: bool,
    #[serde(default)]
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub max_items: usize,
    pub poll_interval_ms: u64,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            max_items: 500,
            poll_interval_ms: 500,
        }
    }
}

impl ClipboardItem {
    pub fn new_text(content: String) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            item_type: ItemType::Text,
            content,
            timestamp: Utc::now(),
            favorite: false,
            tags: Vec::new(),
        }
    }

    pub fn new_image(content: String) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            item_type: ItemType::Image,
            content,
            timestamp: Utc::now(),
            favorite: false,
            tags: Vec::new(),
        }
    }

    pub fn new_files(content: String) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            item_type: ItemType::Files,
            content,
            timestamp: Utc::now(),
            favorite: false,
            tags: Vec::new(),
        }
    }
}
