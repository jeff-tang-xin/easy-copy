# Easy-Copy

A powerful clipboard manager built with Tauri v2 + React 19 + TypeScript. Runs in the background, records everything you copy, and lets you search and paste instantly via a global hotkey.

## Features

### Core

- **Clipboard Monitoring** — Background thread polls the system clipboard every 500ms (configurable), captures text, images, and multi-file content
- **Global Hotkey** — Press `Ctrl+Shift+V` anywhere to toggle the main window. Hotkey registration failure no longer crashes the app — falls back to tray icon
- **Instant Search** — Case-insensitive search across content and tags, with match highlighting
- **Keyboard Navigation** — `↑`/`↓` to select, `Enter` to copy, `Esc` to hide — fully mouse-free
- **System Tray** — Click the tray icon to toggle the window, right-click for quick actions

### Persistence & Data

- **Disk Persistence** — History is saved to `history.json` with images stored as individual files; auto-restore on startup
- **Debounced Saving** — Frequent copies are batched — saves at most every 2s instead of on every clipboard change
- **Configurable Limits** — Set max history items (50–5000) and poll interval (200–5000ms) in Settings
- **Storage Stats** — Footer shows live item count and total disk usage
- **Export / Import** — Back up or transfer your full history as a JSON file

### Organization

- **Favorites** — Star important items; favorites are pinned to the top and sorted by time
- **Custom Tags** — Add tags to any item; tags are searchable, shown as colorful badges, with autocomplete suggestions
- **Date Grouping** — Items grouped by Today / Yesterday / This Week / date with sticky headers
- **Duplicate Detection** — Repeated content is moved to the top instead of creating duplicates, preserving favorites and tags
- **Delete with Undo** — Deleted items show an Undo toast for 3 seconds before being permanently removed

### UI / UX

- **Dark / Light / Auto Theme** — Cycle through themes; Auto follows the OS preference in real time
- **Tokyo Night Palette** — Refined dark/light color scheme with SVG vector icons throughout
- **Right-Click Context Menu** — Copy, toggle favorite, add tag, or delete from a native-style menu
- **Incognito Mode** — Pause clipboard recording temporarily with a single toggle
- **Settings Panel** — Configure max items, poll interval, export/import — all in one dialog
- **Window Position Memory** — Window position and size are restored on next launch
- **File Path Detection** — Multi-file content shows individual clickable paths; executable files (`.exe`, `.bat`, `.sh`, `.py`…) show a confirmation dialog before opening
- **URL Auto-Detection** — Links in text content are clickable and open in the default browser
- **Image Preview & Zoom** — Double-click an image to open a full-screen viewer with scroll-zoom, drag-to-pan, and control bar
- **Clear Confirmation** — Prevents accidental history wipe with a confirmation dialog

### Auto-Start

- **Boot Auto-Start** — Optional toggle to launch Easy-Copy on system startup (via `tauri-plugin-autostart`)

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Rust + Tauri v2 |
| Frontend | React 19 + TypeScript + Vite 7 |
| Package Manager | pnpm (frontend) + Cargo (backend) |
| Key Crates | arboard, tauri-plugin-global-shortcut, tauri-plugin-autostart, chrono, uuid, tokio, serde |

## Project Structure

```
Easy-Copy/
├── src/                      # React frontend
│   ├── App.tsx               # Main UI: search, list, tags, settings, context menu
│   └── App.css               # Tokyo Night dark/light theme styles
├── src-tauri/
│   ├── src/
│   │   ├── lib.rs            # Tauri entry: commands, tray, hotkey, window state
│   │   ├── clipboard.rs      # Clipboard polling, history CRUD, persistence, tags
│   │   └── models.rs         # ClipboardItem, AppConfig data models
│   ├── Cargo.toml            # Rust dependencies
│   ├── tauri.conf.json       # Window, bundle, icon configuration
│   └── capabilities/         # Tauri permission declarations
└── package.json              # Frontend dependencies & scripts
```

## Getting Started

### Prerequisites

- [Rust](https://rustup.rs/) (stable)
- [Node.js](https://nodejs.org/) 18+
- [pnpm](https://pnpm.io/) (`npm install -g pnpm`)

### Development

```bash
pnpm install          # Install frontend dependencies
cd src-tauri && cargo build && cd ..  # Verify backend compiles
pnpm tauri dev        # Launch dev server + Tauri app
```

### Build

```bash
pnpm tauri build      # Production build → installer in src-tauri/target/release/bundle/
```

### Useful Commands

```bash
pnpm dev              # Frontend-only dev server
cd src-tauri && cargo build   # Backend-only compile
cd src-tauri && cargo clippy  # Lint
cd src-tauri && cargo fmt     # Format
```

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+Shift+V` | Toggle window (global) |
| `↑` / `↓` | Navigate items |
| `Enter` | Copy selected item |
| `Esc` | Hide window |

## License

MIT
