import React, { lazy, Suspense } from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";

// Same bundle serves every window; lazy-load each window's root so opening the
// clipboard window doesn't also download Notes/Tools/Screenshot code. Vite
// splits each dynamic import into its own chunk automatically.
const App = lazy(() => import("./App"));
const NotesApp = lazy(() => import("./NotesApp"));
const ToolsApp = lazy(() => import("./ToolsApp"));
const ScreenshotApp = lazy(() => import("./ScreenshotApp"));

// Pick the root component by window label. Tauri creates each webview with its
// own label ("main" / "notes" / "tools" / "screenshot").
let label = "main";
try {
  label = getCurrentWindow().label;
} catch {
  // Non-Tauri context (e.g. plain `vite dev` in a browser tab) → fall back to main
}

const Root = label === "notes" ? NotesApp : label === "tools" ? ToolsApp : label === "screenshot" ? ScreenshotApp : App;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Suspense fallback={null}>
      <Root />
    </Suspense>
  </React.StrictMode>,
);
