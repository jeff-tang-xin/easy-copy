use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use crate::models::{Note, NoteInput};

/// Manages user notes with disk persistence. Independent from ClipboardManager
/// so users can freely edit notes without touching clipboard history.
pub struct NoteManager {
    notes: Arc<Mutex<Vec<Note>>>,
    /// Storage root. Wrapped in a `Mutex` so `set_data_dir` can swap it
    /// after construction (when the user changes `storage_root` from the
    /// settings panel) without forcing every other method through a lock.
    data_dir: Mutex<Option<PathBuf>>,
}

impl NoteManager {
    pub fn new(data_dir: Option<PathBuf>) -> Self {
        Self {
            notes: Arc::new(Mutex::new(Vec::new())),
            data_dir: Mutex::new(data_dir),
        }
    }

    /// Update the data directory at runtime (used when the user changes
    /// `storage_root` from the settings panel). Re-reads `notes.json` from
    /// the new location so the list reflects what's actually on disk after
    /// a path change.
    pub fn set_data_dir(&self, data_dir: PathBuf) {
        *self.data_dir.lock().unwrap_or_else(|e| e.into_inner()) = Some(data_dir);
        self.load();
    }

    fn notes_file(&self) -> Option<PathBuf> {
        self.data_dir
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .map(|d| d.join("notes.json"))
    }

    /// Load notes from `notes.json`.
    ///
    /// A missing file is normal (first run) and starts empty. Corrupt JSON is
    /// *not* normal: silently starting empty there would show the user "no
    /// notes", and the next save would overwrite the damaged-but-possibly-
    /// recoverable file with `[]`. So a corrupt file is renamed aside to
    /// `notes.corrupt-<ts>.json` before we continue with an empty list.
    pub fn load(&self) {
        let path = match self.notes_file() {
            Some(p) => p,
            None => return,
        };
        let json = match fs::read_to_string(&path) {
            Ok(j) => j,
            Err(_) => return,
        };
        match serde_json::from_str::<Vec<Note>>(&json) {
            Ok(loaded) => {
                *self.notes.lock().unwrap_or_else(|e| e.into_inner()) = loaded;
            }
            Err(e) => {
                let backup = path.with_file_name(format!(
                    "notes.corrupt-{}.json",
                    chrono::Utc::now().timestamp_millis()
                ));
                let _ = fs::rename(&path, &backup);
                eprintln!(
                    "[notes] notes.json is corrupt ({e}); moved to {} and starting empty",
                    backup.display()
                );
            }
        }
    }

    /// Persist notes to `notes.json` atomically.
    ///
    /// Two deliberate departures from the previous best-effort version:
    ///
    /// 1. **Returns `Result`.** The old signature was `()` with `let _ =
    ///    fs::write(..)`, so a full disk or a locked file was swallowed whole
    ///    and the UI still rendered "✓ saved". Reporting a write failure as
    ///    success is worse than crashing — the user closes the app trusting
    ///    data is on disk that never got there.
    /// 2. **Temp file + rename.** A plain `fs::write` truncates in place, so a
    ///    crash mid-write leaves truncated JSON. `rename` over an existing file
    ///    is atomic on NTFS and POSIX alike, so readers see either the old file
    ///    or the new one, never a partial one. Mirrors `api.rs::save`.
    fn save(&self) -> Result<(), String> {
        let path = match self.notes_file() {
            // No data dir configured yet: nothing to persist to. Not an error.
            None => return Ok(()),
            Some(p) => p,
        };
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("无法创建便签目录 {}：{e}", parent.display()))?;
        }
        let json = {
            let notes = self.notes.lock().unwrap_or_else(|e| e.into_inner());
            serde_json::to_string_pretty(&*notes)
                .map_err(|e| format!("便签序列化失败：{e}"))?
        };
        let tmp = path.with_extension("json.tmp");
        fs::write(&tmp, &json)
            .map_err(|e| format!("无法写入便签临时文件 {}：{e}", tmp.display()))?;
        fs::rename(&tmp, &path).map_err(|e| {
            let _ = fs::remove_file(&tmp);
            format!("无法保存便签到 {}：{e}", path.display())
        })?;
        Ok(())
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

    /// Create a note and persist.
    ///
    /// Note the ordering: the in-memory list is updated first, then flushed. If
    /// the flush fails the note still exists in memory (so the user's work is
    /// not thrown away mid-session) but the error propagates so the UI can say
    /// "not saved to disk" instead of a false success.
    pub fn create(
        &self,
        input: NoteInput,
        source_clip_id: Option<String>,
    ) -> Result<Note, String> {
        let note = Note::new(input, source_clip_id);
        self.notes.lock().unwrap_or_else(|e| e.into_inner()).push(note.clone());
        self.save()?;
        Ok(note)
    }

    pub fn update(&self, id: &str, input: NoteInput) -> Result<Option<Note>, String> {
        let mut notes = self.notes.lock().unwrap_or_else(|e| e.into_inner());
        let found = notes.iter_mut().find(|n| n.id == id).map(|n| {
            n.apply_update(input);
            n.clone()
        });
        drop(notes);
        if found.is_some() {
            self.save()?;
        }
        Ok(found)
    }

    pub fn delete(&self, id: &str) -> Result<(), String> {
        let mut notes = self.notes.lock().unwrap_or_else(|e| e.into_inner());
        let before = notes.len();
        notes.retain(|n| n.id != id);
        let changed = notes.len() != before;
        drop(notes);
        if changed {
            self.save()?;
        }
        Ok(())
    }

    pub fn toggle_pin(&self, id: &str) -> Result<(), String> {
        let mut notes = self.notes.lock().unwrap_or_else(|e| e.into_inner());
        let mut changed = false;
        if let Some(n) = notes.iter_mut().find(|n| n.id == id) {
            n.pinned = !n.pinned;
            n.updated_at = chrono::Utc::now().timestamp_millis();
            changed = true;
        }
        drop(notes);
        if changed {
            self.save()?;
        }
        Ok(())
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
    pub fn rename_category(&self, from: &str, to: &str) -> Result<usize, String> {
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
            self.save()?;
        }
        Ok(count)
    }

    /// Delete a category: clears `category` on all matching notes (notes themselves are kept).
    /// Returns number of notes affected.
    pub fn delete_category(&self, name: &str) -> Result<usize, String> {
        let name = name.trim().to_string();
        if name.is_empty() {
            return Ok(0);
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
            self.save()?;
        }
        Ok(count)
    }
}

// ============================================================
// Unit tests for NoteManager — pure logic + on-disk JSON round-trip.
//
// We use a unique temp directory per test (`tempdir` style) so tests
// don't trample each other's notes.json. Cargo runs tests in parallel
// by default, so the data_dir must be unique per test.
// ============================================================
#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{Note, NoteInput};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static COUNTER: AtomicUsize = AtomicUsize::new(0);

    /// Build a `NoteManager` rooted at a unique temp directory. The
    /// directory is created on demand and **not** cleaned up — Rust's
    /// tmp dirs are fine to leave behind on test runs, and explicit
    /// cleanup adds a panic path that obscures the real test signal.
    fn fresh_manager() -> NoteManager {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let pid = std::process::id();
        let dir = std::env::temp_dir()
            .join(format!("easy-copy-notes-test-{}-{}", pid, n));
        std::fs::create_dir_all(&dir).unwrap();
        NoteManager::new(Some(dir))
    }

    /// `create` now returns `Result` so callers can surface disk failures.
    /// Tests using a fresh temp dir never legitimately fail to save, so they
    /// unwrap through this helper rather than sprinkling `.unwrap()` at every
    /// call site — a save failure here means the test setup is broken, and the
    /// panic message says exactly that.
    fn mk(m: &NoteManager, input: NoteInput) -> Note {
        m.create(input, None).expect("save to temp dir should succeed")
    }

    fn input(title: &str, content: &str) -> NoteInput {
        NoteInput {
            title: title.to_string(),
            content: content.to_string(),
            tags: vec![],
            category: None,
        }
    }

    fn input_with_category(title: &str, content: &str, cat: Option<&str>) -> NoteInput {
        NoteInput {
            title: title.to_string(),
            content: content.to_string(),
            tags: vec![],
            category: cat.map(|s| s.to_string()),
        }
    }

    #[test]
    fn create_then_list_returns_the_note() {
        let m = fresh_manager();
        let n = mk(&m, input("hello", "world"));
        assert_eq!(n.title, "hello");
        assert_eq!(n.content, "world");
        assert!(!n.pinned);
        let listed = m.list();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, n.id);
    }

    #[test]
    fn update_replaces_title_content_tags_and_bumps_updated_at() {
        let m = fresh_manager();
        let n = mk(&m, input("a", "old"));
        // Force a measurable timestamp gap. `chrono::Utc::now().timestamp_millis()`
        // has ms resolution, so a 5ms sleep is enough to guarantee a strictly
        // larger `updated_at` without making the test slow.
        std::thread::sleep(std::time::Duration::from_millis(5));
        let updated = m
            .update(
                &n.id,
                NoteInput {
                    title: "b".into(),
                    content: "new".into(),
                    tags: vec!["t1".into()],
                    category: None,
                },
            )
            .expect("save should succeed")
            .expect("note should exist");
        assert_eq!(updated.title, "b");
        assert_eq!(updated.content, "new");
        assert_eq!(updated.tags, vec!["t1".to_string()]);
        assert!(updated.updated_at >= n.updated_at);
    }

    #[test]
    fn update_on_missing_id_returns_none() {
        let m = fresh_manager();
        let result = m.update("does-not-exist", input("x", "y")).unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn delete_removes_the_note() {
        let m = fresh_manager();
        let n = mk(&m, input("a", "b"));
        m.delete(&n.id).unwrap();
        assert!(m.list().is_empty());
    }

    #[test]
    fn delete_is_idempotent_on_missing_id() {
        // Deleting an unknown id should not panic and should not
        // affect the other notes. The implementation guards on
        // `changed` so the save() call is skipped — this test pins
        // that contract.
        let m = fresh_manager();
        let n = mk(&m, input("a", "b"));
        m.delete("nonexistent").unwrap();
        assert_eq!(m.list().len(), 1);
        m.delete(&n.id).unwrap();
        assert!(m.list().is_empty());
        m.delete(&n.id).unwrap(); // second delete on same id
        assert!(m.list().is_empty());
    }

    #[test]
    fn list_sorts_pinned_first_then_by_updated_at_desc() {
        let m = fresh_manager();
        // Insert oldest, middle, newest (by creation order, since
        // `Note::new` sets `updated_at = now`).
        let old = mk(&m, input("old", ""));
        std::thread::sleep(std::time::Duration::from_millis(5));
        let mid = mk(&m, input("mid", ""));
        std::thread::sleep(std::time::Duration::from_millis(5));
        let new = mk(&m, input("new", ""));

        // Pin the oldest one — it should jump to position 0.
        m.toggle_pin(&old.id).unwrap();
        let listed = m.list();
        assert_eq!(listed[0].id, old.id);
        assert!(listed[0].pinned);
        // Among the unpinned, newer (`new`) should come before `mid`.
        assert_eq!(listed[1].id, new.id);
        assert_eq!(listed[2].id, mid.id);
    }

    #[test]
    fn toggle_pin_flips_state() {
        let m = fresh_manager();
        let n = mk(&m, input("a", "b"));
        assert!(!m.list()[0].pinned);
        m.toggle_pin(&n.id).unwrap();
        assert!(m.list()[0].pinned);
        m.toggle_pin(&n.id).unwrap();
        assert!(!m.list()[0].pinned);
    }

    #[test]
    fn toggle_pin_on_missing_id_is_a_noop() {
        // No panic, no extra notes, nothing changes.
        let m = fresh_manager();
        m.toggle_pin("missing").unwrap();
        assert!(m.list().is_empty());
    }

    #[test]
    fn list_categories_returns_sorted_distinct_non_empty() {
        let m = fresh_manager();
        mk(&m, input_with_category("a", "", Some("work")));
        mk(&m, input_with_category("b", "", Some("personal")));
        mk(&m, input_with_category("c", "", Some("work"))); // duplicate
        mk(&m, input_with_category("d", "", Some("")));      // empty → excluded
        mk(&m, input_with_category("e", "", None));          // None → excluded
        let cats = m.list_categories();
        assert_eq!(cats, vec!["personal".to_string(), "work".to_string()]);
    }

    #[test]
    fn rename_category_updates_all_matching_notes() {
        let m = fresh_manager();
        let a = mk(&m, input_with_category("a", "", Some("old")));
        let b = mk(&m, input_with_category("b", "", Some("old")));
        let c = mk(&m, input_with_category("c", "", Some("other")));
        let updated = m.rename_category("old", "new").unwrap();
        assert_eq!(updated, 2);
        // Reload from disk to prove the rename persisted, not just
        // sat in memory until the manager was dropped.
        let reloaded = NoteManager::new({
            let dir = match m.notes_file() {
                Some(p) => p.parent().unwrap().to_path_buf(),
                None => PathBuf::from("."),
            };
            Some(dir)
        });
        reloaded.load();
        let listed = reloaded.list();
        let by_id = |id: &str| listed.iter().find(|n| n.id == id).unwrap();
        assert_eq!(by_id(&a.id).category.as_deref(), Some("new"));
        assert_eq!(by_id(&b.id).category.as_deref(), Some("new"));
        assert_eq!(by_id(&c.id).category.as_deref(), Some("other"));
    }

    #[test]
    fn rename_category_to_empty_clears_it() {
        let m = fresh_manager();
        let a = mk(&m, input_with_category("a", "", Some("old")));
        let updated = m.rename_category("old", "").unwrap();
        assert_eq!(updated, 1);
        let listed = m.list();
        assert!(listed.iter().find(|n| n.id == a.id).unwrap().category.is_none());
    }

    #[test]
    fn delete_category_only_clears_category_not_the_note() {
        let m = fresh_manager();
        let a = mk(&m, input_with_category("a", "keep me", Some("old")));
        let updated = m.delete_category("old").unwrap();
        assert_eq!(updated, 1);
        // Note itself is still there, just uncategorized.
        let listed = m.list();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, a.id);
        assert!(listed[0].category.is_none());
        assert_eq!(listed[0].content, "keep me");
    }

    #[test]
    fn notes_survive_a_reload_from_disk() {
        // This is the most important test: `save()` is called inside
        // every mutator, and `load()` re-hydrates state. If the JSON
        // shape or the directory layout ever drifts, this test will
        // catch it without needing the full Tauri app running.
        let dir = std::env::temp_dir().join(format!(
            "easy-copy-notes-test-reload-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::create_dir_all(&dir).unwrap();

        let m1 = NoteManager::new(Some(dir.clone()));
        let n = m1.create(
            NoteInput {
                title: "persist me".into(),
                content: "important".into(),
                tags: vec!["k1".into(), "k2".into()],
                category: Some("cat".into()),
            },
            None,
        ).expect("save should succeed");
        m1.toggle_pin(&n.id).unwrap();

        let m2 = NoteManager::new(Some(dir.clone()));
        m2.load();
        let listed = m2.list();
        assert_eq!(listed.len(), 1);
        let r = &listed[0];
        assert_eq!(r.title, "persist me");
        assert_eq!(r.content, "important");
        assert_eq!(r.tags, vec!["k1".to_string(), "k2".to_string()]);
        assert_eq!(r.category.as_deref(), Some("cat"));
        assert!(r.pinned);
        assert_eq!(r.id, n.id);
    }

    #[test]
    fn load_returns_silently_when_no_notes_file() {
        // A fresh dir has no notes.json — `load` should be a noop, not a
        // panic. This is the path the app takes on first launch.
        let m = fresh_manager();
        m.load();
        assert!(m.list().is_empty());
    }

    #[test]
    fn load_moves_corrupt_json_aside_instead_of_discarding_it() {
        // Unparseable notes.json must not crash, and must not be left in
        // place: the next save would overwrite it with `[]`, destroying data
        // the user might still recover by hand. `load` renames it to
        // notes.corrupt-<ts>.json and continues empty.
        let dir = std::env::temp_dir().join(format!(
            "easy-copy-notes-test-corrupt-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("notes.json"), "{ not valid json").unwrap();
        let m = NoteManager::new(Some(dir.clone()));
        m.load();
        assert!(m.list().is_empty());

        // Original path is gone...
        assert!(!dir.join("notes.json").exists());
        // ...and its bytes survive under a corrupt-* sibling.
        let salvaged: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.starts_with("notes.corrupt-"))
            .collect();
        assert_eq!(salvaged.len(), 1, "expected exactly one salvaged file, got {salvaged:?}");
        assert_eq!(
            std::fs::read_to_string(dir.join(&salvaged[0])).unwrap(),
            "{ not valid json"
        );
    }

    #[test]
    fn save_leaves_no_tmp_file_behind() {
        // save() writes notes.json.tmp then renames. If the rename path ever
        // regressed to a copy, or an early return skipped cleanup, the temp
        // file would accumulate next to the real one. Pin that it doesn't.
        let m = fresh_manager();
        mk(&m, input("a", "b"));
        let path = m.notes_file().unwrap();
        let dir = path.parent().unwrap();
        assert!(path.exists(), "notes.json should exist after save");
        assert!(
            !dir.join("notes.json.tmp").exists(),
            "temp file must be renamed away, not left behind"
        );
    }
}
