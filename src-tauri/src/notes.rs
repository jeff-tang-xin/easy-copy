use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use crate::models::{Note, NoteInput};

/// Manages user notes with disk persistence. Independent from ClipboardManager
/// so users can freely edit notes without touching clipboard history.
pub struct NoteManager {
    notes: Arc<Mutex<Vec<Note>>>,
    data_dir: Option<PathBuf>,
}

impl NoteManager {
    pub fn new(data_dir: Option<PathBuf>) -> Self {
        Self {
            notes: Arc::new(Mutex::new(Vec::new())),
            data_dir,
        }
    }

    fn notes_file(&self) -> Option<PathBuf> {
        self.data_dir.as_ref().map(|d| d.join("notes.json"))
    }

    /// Load notes from `notes.json`. Silently starts empty on any error
    /// (missing file, corrupt JSON, permission issue).
    pub fn load(&self) {
        let path = match self.notes_file() {
            Some(p) => p,
            None => return,
        };
        let json = match fs::read_to_string(&path) {
            Ok(j) => j,
            Err(_) => return,
        };
        if let Ok(loaded) = serde_json::from_str::<Vec<Note>>(&json) {
            *self.notes.lock().unwrap_or_else(|e| e.into_inner()) = loaded;
        }
    }

    /// Write notes to `notes.json`. Best-effort, errors ignored.
    fn save(&self) {
        let path = match self.notes_file() {
            Some(p) => p,
            None => return,
        };
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let notes = self.notes.lock().unwrap_or_else(|e| e.into_inner());
        if let Ok(json) = serde_json::to_string_pretty(&*notes) {
            let _ = fs::write(path, json);
        }
    }

    /// Return notes sorted by (pinned desc, updated_at desc).
    pub fn list(&self) -> Vec<Note> {
        let mut items: Vec<Note> = self.notes.lock().unwrap_or_else(|e| e.into_inner()).clone();
        items.sort_by(|a, b| {
            b.pinned
                .cmp(&a.pinned)
                .then_with(|| b.updated_at.cmp(&a.updated_at))
        });
        items
    }

    pub fn create(&self, input: NoteInput, source_clip_id: Option<String>) -> Note {
        let note = Note::new(input, source_clip_id);
        self.notes.lock().unwrap_or_else(|e| e.into_inner()).push(note.clone());
        self.save();
        note
    }

    pub fn update(&self, id: &str, input: NoteInput) -> Option<Note> {
        let mut notes = self.notes.lock().unwrap_or_else(|e| e.into_inner());
        let found = notes.iter_mut().find(|n| n.id == id).map(|n| {
            n.apply_update(input);
            n.clone()
        });
        drop(notes);
        if found.is_some() {
            self.save();
        }
        found
    }

    pub fn delete(&self, id: &str) {
        let mut notes = self.notes.lock().unwrap_or_else(|e| e.into_inner());
        let before = notes.len();
        notes.retain(|n| n.id != id);
        let changed = notes.len() != before;
        drop(notes);
        if changed {
            self.save();
        }
    }

    pub fn toggle_pin(&self, id: &str) {
        let mut notes = self.notes.lock().unwrap_or_else(|e| e.into_inner());
        let mut changed = false;
        if let Some(n) = notes.iter_mut().find(|n| n.id == id) {
            n.pinned = !n.pinned;
            n.updated_at = chrono::Utc::now().timestamp_millis();
            changed = true;
        }
        drop(notes);
        if changed {
            self.save();
        }
    }

    /// Convenience: get a single note by id.
    #[allow(dead_code)]
    pub fn get(&self, id: &str) -> Option<Note> {
        self.notes.lock().unwrap_or_else(|e| e.into_inner()).iter().find(|n| n.id == id).cloned()
    }

    /// Distinct, sorted list of categories across all notes.
    pub fn list_categories(&self) -> Vec<String> {
        let notes = self.notes.lock().unwrap_or_else(|e| e.into_inner());
        let mut set: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
        for n in notes.iter() {
            if let Some(c) = &n.category {
                if !c.is_empty() {
                    set.insert(c.clone());
                }
            }
        }
        set.into_iter().collect()
    }

    /// Rename a category across all notes. Empty `from` targets uncategorized notes;
    /// empty `to` clears the category (moves them to uncategorized).
    /// Returns the number of notes affected.
    pub fn rename_category(&self, from: &str, to: &str) -> usize {
        let from = from.trim().to_string();
        let to_trim = to.trim().to_string();
        let new_val = if to_trim.is_empty() { None } else { Some(to_trim) };
        let mut notes = self.notes.lock().unwrap_or_else(|e| e.into_inner());
        let mut count = 0usize;
        let now = chrono::Utc::now().timestamp_millis();
        for n in notes.iter_mut() {
            let matches = match &n.category {
                Some(v) => v.trim() == from,
                None => from.is_empty(),
            };
            if matches {
                n.category = new_val.clone();
                n.updated_at = now;
                count += 1;
            }
        }
        drop(notes);
        if count > 0 {
            self.save();
        }
        count
    }

    /// Delete a category: clears `category` on all matching notes (notes themselves are kept).
    /// Returns number of notes affected.
    pub fn delete_category(&self, name: &str) -> usize {
        let name = name.trim().to_string();
        if name.is_empty() {
            return 0;
        }
        let mut notes = self.notes.lock().unwrap_or_else(|e| e.into_inner());
        let mut count = 0usize;
        let now = chrono::Utc::now().timestamp_millis();
        for n in notes.iter_mut() {
            if n.category.as_deref().map(|s| s.trim()) == Some(name.as_str()) {
                n.category = None;
                n.updated_at = now;
                count += 1;
            }
        }
        drop(notes);
        if count > 0 {
            self.save();
        }
        count
    }
}
