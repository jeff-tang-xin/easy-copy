import { useState, useEffect, useRef, useCallback } from "react";
import { getCurrentWindow, LogicalSize, LogicalPosition } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./App.css";
import "./ScreenshotApp.css";

/* =============================================================
 * Theme hook (shared pattern)
 * ============================================================= */
function useTheme() {
  const [themeMode, setThemeMode] = useState<"auto" | "light" | "dark">(
    () =>
      (localStorage.getItem("easy-copy-theme") as any) ||
      (localStorage.getItem("theme") as any) ||
      "auto"
  );
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia("(prefers-color-scheme: dark)").matches
  );
  const theme = themeMode === "auto" ? (systemDark ? "dark" : "light") : themeMode;

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const fn = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener("change", fn);
    return () => mq.removeEventListener("change", fn);
  }, []);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === "easy-copy-theme" && e.newValue) setThemeMode(e.newValue as any);
    };
    window.addEventListener("storage", onStorage);
    const onFocus = () => {
      const cur = localStorage.getItem("easy-copy-theme");
      if (cur && cur !== themeMode) setThemeMode(cur as any);
    };
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("focus", onFocus);
    };
  }, [themeMode]);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);
}

/* =============================================================
 * Types
 * ============================================================= */
type Tool = "select" | "rect" | "arrow" | "pen" | "text" | "none";

/** Overlay phase: 'select' = waiting for the user to drag a region (toolbar
 * hidden), 'edit' = a region exists → annotation toolbar is shown. */
type Phase = "select" | "edit";

/** Accent colours the user can choose for annotations. */
const COLORS = ["#ef4444", "#f59e0b", "#22c55e", "#3b82f6", "#a855f7", "#111827", "#ffffff"] as const;
type Color = typeof COLORS[number];

/** Line thickness presets. */
const STROKE_SIZES = [2, 4, 6] as const;
type StrokeSize = typeof STROKE_SIZES[number];

/** Annotation tools shown in the toolbar (icon-only, tooltip on hover). */
const DRAW_TOOLS: { key: Tool; icon: string; label: string }[] = [
  { key: "rect", icon: "▭", label: "矩形" },
  { key: "arrow", icon: "↗", label: "箭头" },
  { key: "pen", icon: "✎", label: "画笔" },
  { key: "text", icon: "T", label: "文字" },
];

interface Point { x: number; y: number; }

interface RectAnnotation {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  color: Color;
  size: StrokeSize;
}

interface ArrowAnnotation {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: Color;
  size: StrokeSize;
}

interface PenAnnotation {
  id: string;
  points: Point[];
  color: Color;
  size: StrokeSize;
}

interface TextAnnotation {
  id: string;
  x: number;
  y: number;
  text: string;
  color: Color;
  size: StrokeSize;
}

/** Selected region (image-space coordinates). null = whole image. */
interface Region { x: number; y: number; w: number; h: number; }

/* =============================================================
 * ScreenshotApp
 * ============================================================= */
export default function ScreenshotApp() {
  useTheme();

  const [imagePath, setImagePath] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool>("select");
  // Overlay flow phase: start in 'select' (drag to pick region, toolbar hidden),
  // move to 'edit' once a region exists (annotation toolbar appears).
  const [phase, setPhase] = useState<Phase>("select");
  const [pinned, setPinned] = useState(false);
  // When true the overlay collapses to just the selected region, floating on top
  // of other apps for side-by-side comparison (does NOT cover the full screen).
  const [pinnedShot, setPinnedShot] = useState<{ url: string; w: number; h: number } | null>(null);
  // Current drawing style
  const [color, setColor] = useState<Color>("#ef4444");
  const [size, setSize] = useState<StrokeSize>(4);

  // Annotations
  const [rects, setRects] = useState<RectAnnotation[]>([]);
  const [arrows, setArrows] = useState<ArrowAnnotation[]>([]);
  const [pens, setPens] = useState<PenAnnotation[]>([]);
  const [texts, setTexts] = useState<TextAnnotation[]>([]);

  // Selected capture region (image-space). null = full screenshot.
  const [region, setRegion] = useState<Region | null>(null);

  // Drag state (image-space coords)
  const [dragging, setDragging] = useState(false);
  const [dragStart, setDragStart] = useState<Point>({ x: 0, y: 0 });
  const [dragCurrent, setDragCurrent] = useState<Point>({ x: 0, y: 0 });

  const [textInput, setTextInput] = useState<Point | null>(null);
  const [textValue, setTextValue] = useState("");

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  // Live pen buffer + rAF handle so freehand drawing stays smooth: mousemove
  // pushes into a ref (no React re-render per point) and a rAF loop repaints.
  const penBufRef = useRef<Point[]>([]);
  const rafRef = useRef<number | null>(null);

  // Convert a mouse event to image-space coordinates.
  const toImageCoords = useCallback((e: React.MouseEvent): Point => {
    const canvas = canvasRef.current;
    const rect = canvas?.getBoundingClientRect();
    if (!canvas || !rect) return { x: 0, y: 0 };
    const sx = canvas.width / (rect.width || 1);
    const sy = canvas.height / (rect.height || 1);
    return {
      x: (e.clientX - rect.left) * sx,
      y: (e.clientY - rect.top) * sy,
    };
  }, []);

  // Listen for screenshot-captured event
  useEffect(() => {
    const unlisten = listen<string>("screenshot-captured", (e) => {
      // Reset all state for a fresh capture
      setImagePath(e.payload);
      setRects([]);
      setArrows([]);
      setPens([]);
      setTexts([]);
      setRegion(null);
      setTool("select");
      setPhase("select");
      setTextInput(null);
      setTextValue("");
      setPinnedShot(null);
    });
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  // Load image onto canvas
  useEffect(() => {
    if (!imagePath) return;
    const img = new Image();
    img.onload = () => {
      imgRef.current = img;
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext("2d");
      if (ctx) ctx.drawImage(img, 0, 0);
    };
    // Payload is now a data URL (data:image/png;base64,...) and can be loaded directly.
    img.src = imagePath;
  }, [imagePath]);

  // Pure annotation renderer — shared by the live canvas and the export path so
  // the saved/copied image always contains the exact same rect/arrow/pen/text.
  const drawAnnotations = useCallback((ctx: CanvasRenderingContext2D) => {
    const drawArrow = (a: { x1: number; y1: number; x2: number; y2: number; color: string; size: number }) => {
      const { x1, y1, x2, y2 } = a;
      const angle = Math.atan2(y2 - y1, x2 - x1);
      const len = Math.hypot(x2 - x1, y2 - y1);
      // Arrowhead scales with both stroke size and line length, but is clamped so
      // short lines don't get an oversized head. Wider spread (Math.PI/7) reads cleaner.
      const head = Math.min(Math.max(10, a.size * 3.5), len * 0.4);
      const spread = Math.PI / 7;
      // Stop the shaft short of the tip so the line doesn't poke through the head.
      const bx = x2 - head * 0.85 * Math.cos(angle);
      const by = y2 - head * 0.85 * Math.sin(angle);
      ctx.strokeStyle = a.color;
      ctx.fillStyle = a.color;
      ctx.lineWidth = a.size;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(bx, by);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - head * Math.cos(angle - spread), y2 - head * Math.sin(angle - spread));
      ctx.lineTo(x2 - head * Math.cos(angle + spread), y2 - head * Math.sin(angle + spread));
      ctx.closePath();
      ctx.fill();
    };

    // Rects
    for (const r of rects) {
      ctx.strokeStyle = r.color;
      ctx.lineWidth = r.size;
      ctx.setLineDash([]);
      ctx.strokeRect(r.x, r.y, r.w, r.h);
    }
    // Arrows
    for (const a of arrows) drawArrow(a);
    // Pen strokes (committed) + the in-progress live buffer.
    const drawPenPath = (pts: Point[], col: string, sz: number) => {
      if (pts.length < 2) {
        // Single dot → draw a small filled circle so a tap still shows.
        if (pts.length === 1) {
          ctx.fillStyle = col;
          ctx.beginPath();
          ctx.arc(pts[0].x, pts[0].y, sz / 2, 0, Math.PI * 2);
          ctx.fill();
        }
        return;
      }
      ctx.strokeStyle = col;
      ctx.lineWidth = sz;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      // Quadratic smoothing through midpoints for a nicer, less jagged line.
      for (let i = 1; i < pts.length - 1; i++) {
        const mx = (pts[i].x + pts[i + 1].x) / 2;
        const my = (pts[i].y + pts[i + 1].y) / 2;
        ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
      }
      const last = pts[pts.length - 1];
      ctx.lineTo(last.x, last.y);
      ctx.stroke();
    };
    for (const p of pens) drawPenPath(p.points, p.color, p.size);
    // Texts
    for (const t of texts) {
      const fontPx = 12 + t.size * 4;
      ctx.font = `600 ${fontPx}px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`;
      ctx.textBaseline = "top";
      ctx.setLineDash([]);
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(0,0,0,0.55)";
      ctx.strokeText(t.text, t.x, t.y);
      ctx.fillStyle = t.color;
      ctx.fillText(t.text, t.x, t.y);
    }
  }, [rects, arrows, pens, texts]);

  // Redraw canvas: base image, then dim non-selected area, then annotations.
  // Optionally overlay a live preview (in-progress pen/arrow/rect) so drawing
  // feels immediate without committing to state on every mouse move.
  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(img, 0, 0);

    // Dim everything outside the selected region so the crop is obvious.
    if (region) {
      ctx.save();
      ctx.fillStyle = "rgba(0,0,0,0.5)";
      // top / bottom / left / right bands around the region
      ctx.fillRect(0, 0, canvas.width, region.y);
      ctx.fillRect(0, region.y + region.h, canvas.width, canvas.height - region.y - region.h);
      ctx.fillRect(0, region.y, region.x, region.h);
      ctx.fillRect(region.x + region.w, region.y, canvas.width - region.x - region.w, region.h);
      // region border
      ctx.strokeStyle = "#3b82f6";
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(region.x, region.y, region.w, region.h);
      ctx.restore();
    }

    // Annotations drawn LAST so they sit on top of the dim overlay.
    drawAnnotations(ctx);

    // Live pen preview straight from the ref buffer (no per-point setState).
    if (tool === "pen" && dragging && penBufRef.current.length) {
      const pts = penBufRef.current;
      ctx.strokeStyle = color;
      ctx.lineWidth = size;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.setLineDash([]);
      if (pts.length === 1) {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(pts[0].x, pts[0].y, size / 2, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length - 1; i++) {
          const mx = (pts[i].x + pts[i + 1].x) / 2;
          const my = (pts[i].y + pts[i + 1].y) / 2;
          ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
        }
        const last = pts[pts.length - 1];
        ctx.lineTo(last.x, last.y);
        ctx.stroke();
      }
    }

    // Live arrow preview while dragging so the user can aim before release.
    if (tool === "arrow" && dragging) {
      const { x: x1, y: y1 } = dragStart;
      const { x: x2, y: y2 } = dragCurrent;
      if (Math.hypot(x2 - x1, y2 - y1) > 2) {
        const angle = Math.atan2(y2 - y1, x2 - x1);
        const len = Math.hypot(x2 - x1, y2 - y1);
        const head = Math.min(Math.max(10, size * 3.5), len * 0.4);
        const spread = Math.PI / 7;
        const bx = x2 - head * 0.85 * Math.cos(angle);
        const by = y2 - head * 0.85 * Math.sin(angle);
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.lineWidth = size;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(bx, by);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x2, y2);
        ctx.lineTo(x2 - head * Math.cos(angle - spread), y2 - head * Math.sin(angle - spread));
        ctx.lineTo(x2 - head * Math.cos(angle + spread), y2 - head * Math.sin(angle + spread));
        ctx.closePath();
        ctx.fill();
      }
    }
  }, [drawAnnotations, region, tool, dragging, color, size, dragStart, dragCurrent]);

  useEffect(() => { redraw(); }, [redraw]);

  // Cancel any pending pen rAF on unmount to avoid a stray redraw.
  useEffect(() => () => { if (rafRef.current != null) cancelAnimationFrame(rafRef.current); }, []);

  // Mouse handlers — behaviour depends on active tool.
  const handleMouseDown = (e: React.MouseEvent) => {
    const p = toImageCoords(e);
    if (tool === "text") {
      setTextInput(p);
      setTextValue("");
      return;
    }
    if (tool === "pen") {
      setDragging(true);
      penBufRef.current = [p];
      redraw();
      return;
    }
    // select / rect / arrow all start a drag
    if (tool === "select" || tool === "rect" || tool === "arrow") {
      setDragging(true);
      setDragStart(p);
      setDragCurrent(p);
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!dragging) return;
    const p = toImageCoords(e);
    if (tool === "pen") {
      // Push into the ref buffer and repaint via rAF (throttled) — avoids a
      // React re-render + full redraw on every single mousemove event.
      penBufRef.current.push(p);
      if (rafRef.current == null) {
        rafRef.current = requestAnimationFrame(() => {
          rafRef.current = null;
          redraw();
        });
      }
    } else {
      setDragCurrent(p);
    }
  };

  const handleMouseUp = () => {
    if (!dragging) return;
    setDragging(false);

    const x = Math.min(dragStart.x, dragCurrent.x);
    const y = Math.min(dragStart.y, dragCurrent.y);
    const w = Math.abs(dragCurrent.x - dragStart.x);
    const h = Math.abs(dragCurrent.y - dragStart.y);

    if (tool === "select") {
      if (w > 8 && h > 8) {
        setRegion({ x, y, w, h });
        // Region chosen → reveal the annotation toolbar and switch to edit phase.
        setPhase("edit");
      } else {
        setRegion(null); // tiny drag → clear region (whole image)
      }
    } else if (tool === "rect") {
      if (w > 5 && h > 5) setRects((prev) => [...prev, { id: crypto.randomUUID(), x, y, w, h, color, size }]);
    } else if (tool === "arrow") {
      const dist = Math.hypot(dragCurrent.x - dragStart.x, dragCurrent.y - dragStart.y);
      if (dist > 8) setArrows((prev) => [...prev, { id: crypto.randomUUID(), x1: dragStart.x, y1: dragStart.y, x2: dragCurrent.x, y2: dragCurrent.y, color, size }]);
    } else if (tool === "pen") {
      // Flush the rAF-buffered points into committed state on release.
      if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
      const pts = penBufRef.current;
      if (pts.length > 1) setPens((prev) => [...prev, { id: crypto.randomUUID(), points: pts, color, size }]);
      penBufRef.current = [];
    }
  };

  // Text submit
  const submitText = () => {
    if (textInput && textValue.trim()) {
      setTexts((prev) => [...prev, { id: crypto.randomUUID(), x: textInput.x, y: textInput.y, text: textValue.trim(), color, size }]);
    }
    setTextInput(null);
    setTextValue("");
  };

  // Undo the most recently added annotation (any type, by insertion time is
  // approximated by removing from whichever list has the newest item — here we
  // simply pop from a priority: text > pen > arrow > rect for simplicity).
  const undoLast = () => {
    if (texts.length) { setTexts((p) => p.slice(0, -1)); return; }
    if (pens.length) { setPens((p) => p.slice(0, -1)); return; }
    if (arrows.length) { setArrows((p) => p.slice(0, -1)); return; }
    if (rects.length) { setRects((p) => p.slice(0, -1)); return; }
  };

  const clearAll = () => {
    setRects([]); setArrows([]); setPens([]); setTexts([]);
  };

  // Pin / unpin toggle (deferred pin: pins after next Copy). Keeps existing
  // behaviour; the new “固定对比” button (handlePin) pins immediately.
  const togglePin = async () => {
    const win = getCurrentWindow();
    if (pinned) {
      await win.setAlwaysOnTop(false);
      setPinned(false);
    } else {
      await win.setAlwaysOnTop(true);
      setPinned(true);
    }
  };

  // Collapse the fullscreen overlay into a small floating window that only shows
  // the selected region, so it can sit next to another app for comparison.
  // The pinned window is positioned near the original selection (offset a little)
  // so it feels anchored to what the user grabbed.
  const enterPinnedMode = async (dataUrl: string) => {
    const w = region ? Math.round(region.w) : (imgRef.current?.width ?? 400);
    const h = region ? Math.round(region.h) : (imgRef.current?.height ?? 300);
    setPinnedShot({ url: dataUrl, w, h });
    const win = getCurrentWindow();
    try {
      await win.setFullscreen(false);
      await win.setAlwaysOnTop(true);
      await win.setSize(new LogicalSize(w + 2, h + 34));
      // Place the pinned window at the selection's on-screen origin (best-effort;
      // region coords are image-space ≈ screen-space for the primary monitor).
      if (region) {
        try {
          await win.setPosition(new LogicalPosition(Math.round(region.x), Math.round(region.y)));
        } catch { /* keep default position */ }
      }
    } catch { /* best-effort */ }
  };

  // Leave pinned mode and close the overlay entirely.
  const exitPinnedMode = async () => {
    setPinnedShot(null);
    const win = getCurrentWindow();
    try { await win.setAlwaysOnTop(false); } catch { /* ignore */ }
    await closeOverlay();
  };

  // Produce the final PNG data URL, cropping to the selected region if any.
  const exportDataUrl = (): string | null => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img) return null;

    // Render a CLEAN frame (base image + annotations, NO dim overlay / selection
    // border) onto an offscreen canvas, then crop to the region if one is set.
    const full = document.createElement("canvas");
    full.width = canvas.width;
    full.height = canvas.height;
    const fctx = full.getContext("2d");
    if (!fctx) return canvas.toDataURL("image/png");
    fctx.drawImage(img, 0, 0);
    drawAnnotations(fctx); // <- rects / arrows / pens / texts included

    if (!region) return full.toDataURL("image/png");

    // Crop selected region out of the clean frame.
    const off = document.createElement("canvas");
    off.width = Math.round(region.w);
    off.height = Math.round(region.h);
    const octx = off.getContext("2d");
    if (!octx) return full.toDataURL("image/png");
    octx.drawImage(
      full,
      region.x, region.y, region.w, region.h,
      0, 0, region.w, region.h,
    );
    return off.toDataURL("image/png");
  };

  // Save to file
  // Save to file, then close the overlay (the whole point is a quick capture).
  const handleSave = async () => {
    const dataUrl = exportDataUrl();
    if (!dataUrl) return;
    try {
      await invoke<string>("save_screenshot", { dataUrl });
      await closeOverlay();
    } catch (e) {
      alert(`Save failed: ${e}`);
    }
  };

  // Copy to clipboard, then close the overlay immediately.
  const handleCopy = async () => {
    const dataUrl = exportDataUrl();
    if (!dataUrl) return;
    try {
      await invoke("copy_image_to_clipboard", { dataUrl });
      // If pinned, keep the selected region floating on screen for comparison
      // instead of closing the overlay entirely.
      if (pinned) { enterPinnedMode(dataUrl); } else { await closeOverlay(); }
    } catch (e) {
      alert(`Copy failed: ${e}`);
    }
  };

  // Pin the selected region directly (no clipboard round-trip). This is the
  // “固定到旁边对比” one-click flow: crop → float on top of other apps.
  const handlePin = async () => {
    const dataUrl = exportDataUrl();
    if (!dataUrl) return;
    await enterPinnedMode(dataUrl);
  };

  // Shared teardown: reset state and hide the window (kept alive for reuse).
  const closeOverlay = async () => {
    const win = getCurrentWindow();
    await win.hide();
    // Restore the window back to a fullscreen overlay for the NEXT capture
    // (pinned mode shrank & un-fullscreened it). Best-effort.
    try {
      await win.setAlwaysOnTop(true);
      await win.setFullscreen(true);
    } catch { /* ignore */ }
    clearAll();
    setRegion(null);
    setPhase("select");
    setTool("select");
    setImagePath(null);
  };

  // Cancel / close
  const handleCancel = async () => {
    await closeOverlay();
  };

  // ESC to cancel — re-bind so the handler always sees fresh state.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (textInput) { setTextInput(null); setTextValue(""); return; }
        // In edit phase, ESC first goes back to region selection instead of
        // closing outright, so users can re-frame without re-triggering capture.
        if (phase === "edit") { setPhase("select"); setTool("select"); setRegion(null); return; }
        handleCancel();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        undoLast();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [textInput, texts, pens, arrows, rects, phase]);

  // Preview shape while dragging (image-space)
  const previewBox = dragging && (tool === "rect" || tool === "select") ? {
    x: Math.min(dragStart.x, dragCurrent.x),
    y: Math.min(dragStart.y, dragCurrent.y),
    w: Math.abs(dragCurrent.x - dragStart.x),
    h: Math.abs(dragCurrent.y - dragStart.y),
  } : null;

  // Scale factor for overlay positioning
  const getScale = () => {
    const canvas = canvasRef.current;
    const rect = canvas?.getBoundingClientRect();
    if (!canvas || !rect) return { sx: 1, sy: 1, ox: 0, oy: 0 };
    return {
      sx: rect.width / canvas.width,
      sy: rect.height / canvas.height,
      ox: rect.left,
      oy: rect.top,
    };
  };

  const scale = getScale();
  const cursorClass = tool === "text" ? "cursor-text" : tool === "none" ? "" : "cursor-cross";
  // Toolbar only appears once the user has picked a region (edit phase). Before
  // that we show a lightweight hint so the flow is: capture → drag → toolbar.
  const showToolbar = phase === "edit";

  // Position the toolbar just BELOW the selected region (Snipaste-style) instead
  // of pinning it to the screen bottom. Falls back to above the region when there
  // isn't enough room underneath, and is clamped horizontally to stay on-screen.
  const TOOLBAR_H = 46;      // approx toolbar height incl. padding
  const TOOLBAR_GAP = 8;     // gap between region edge and toolbar
  const EST_TOOLBAR_W = 560; // approx toolbar width for clamping
  const toolbarStyle: React.CSSProperties = (() => {
    if (!region) {
      return { left: "50%", bottom: 28, transform: "translateX(-50%)" };
    }
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const regLeft = region.x * scale.sx;
    const regRight = (region.x + region.w) * scale.sx;
    const regBottom = (region.y + region.h) * scale.sy;
    const regTop = region.y * scale.sy;
    // Prefer below; if it would overflow the viewport bottom, put it above.
    let top = regBottom + TOOLBAR_GAP;
    if (top + TOOLBAR_H > vh - 4) {
      top = regTop - TOOLBAR_H - TOOLBAR_GAP;
      // If also no room above (tiny/edge region), tuck it inside the bottom.
      if (top < 4) top = Math.max(4, vh - TOOLBAR_H - 4);
    }
    // Horizontal: centre on the region, then clamp within the viewport.
    let left = (regLeft + regRight) / 2;
    const half = EST_TOOLBAR_W / 2;
    left = Math.min(Math.max(left, half + 4), vw - half - 4);
    return { left, top, transform: "translateX(-50%)" };
  })();

  // Pinned floating mode: render ONLY the captured region, draggable, on top of
  // other apps for comparison. No fullscreen overlay / toolbar here.
  if (pinnedShot) {
    return (
      <div className="sc-pin-window">
        <div className="sc-pin-bar" data-tauri-drag-region>
          <span className="sc-pin-title">📌 对比</span>
          <button className="sc-pin-close" onClick={exitPinnedMode} title="关闭">✕</button>
        </div>
        <img className="sc-pin-img" src={pinnedShot.url} alt="pinned screenshot" draggable={false} />
      </div>
    );
  }

  return (
    <div className="screenshot-app">
      {/* Canvas area */}
      <div
        className={`screenshot-canvas-wrapper ${cursorClass}`}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      >
        <canvas ref={canvasRef} className="screenshot-canvas" />
        {/* Live preview box for rect / region select */}
        {previewBox && (
          <div
            className={tool === "select" ? "screenshot-region-preview" : "screenshot-rect-preview"}
            style={{
              left: previewBox.x * scale.sx,
              top: previewBox.y * scale.sy,
              width: previewBox.w * scale.sx,
              height: previewBox.h * scale.sy,
              borderColor: tool === "rect" ? color : undefined,
            }}
          />
        )}
      </div>

      {/* Text input popup — renders WYSIWYG (matches chosen colour & size). */}
      {textInput && (
        <div className="text-input-popup" style={{ left: textInput.x * scale.sx, top: textInput.y * scale.sy }}>
          <input
            autoFocus
            className="text-input-field"
            value={textValue}
            style={{ color, fontSize: (12 + size * 4) * scale.sx, fontWeight: 600 }}
            onChange={(e) => setTextValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") submitText(); if (e.key === "Escape") { setTextInput(null); setTextValue(""); } }}
            onBlur={() => { setTimeout(() => { if (textValue.trim()) submitText(); }, 120); }}
            placeholder="输入文字… (Enter 确认)"
          />
          <button className="text-input-ok" onMouseDown={(e) => e.preventDefault()} onClick={submitText}>✓</button>
        </div>
      )}

      {/* Selection hint (before a region is chosen) */}
      {!showToolbar && !textInput && (
        <div className="sc-hint">拖拽鼠标框选区域 · Esc 取消</div>
      )}

      {/* Toolbar */}
      {showToolbar && (
      <div className="screenshot-toolbar" style={toolbarStyle}>
        {/* Re-select region */}
        <button className={`sc-tool-btn ${tool === "select" ? "active" : ""}`} onClick={() => { setTool("select"); setPhase("select"); setRegion(null); }} title="重新选择区域（拖拽框选）">✂</button>
        <div className="sc-toolbar-sep" />

        {/* Annotation tools */}
        {DRAW_TOOLS.map((t) => (
          <button
            key={t.key}
            className={`sc-tool-btn ${tool === t.key ? "active" : ""}`}
            onClick={() => setTool(t.key)}
            title={t.label}
          >{t.icon}</button>
        ))}
        <div className="sc-toolbar-sep" />

        {/* Colour palette */}
        <div className="sc-color-row">
          {COLORS.map((c) => (
            <button
              key={c}
              className={`sc-color-dot ${color === c ? "active" : ""}`}
              style={{ background: c }}
              onClick={() => setColor(c)}
              title={c}
            />
          ))}
        </div>
        <div className="sc-toolbar-sep" />

        {/* Stroke size */}
        <div className="sc-size-row">
          {STROKE_SIZES.map((s) => (
            <button
              key={s}
              className={`sc-size-btn ${size === s ? "active" : ""}`}
              onClick={() => setSize(s)}
              title={`线宽 ${s}px`}
            >
              <span className="sc-size-dot" style={{ width: s + 2, height: s + 2 }} />
            </button>
          ))}
        </div>
        <div className="sc-toolbar-sep" />

        {/* Edit ops */}
        <button className="sc-tool-btn" onClick={undoLast} title="撤销 (Ctrl+Z)">↶</button>
        <button className="sc-tool-btn" onClick={clearAll} title="清除所有标注">⊘</button>
        <div className="sc-toolbar-sep" />

        {/* Pin / comparison */}
        <button className={`sc-tool-btn ${pinned ? "active" : ""}`} onClick={togglePin} title="复制后把选区固定在屏幕上方供对比">📌</button>
        <button className="sc-tool-btn" onClick={handlePin} title="直接把当前选区固定浮在屏幕上方，方便与其他应用对比">🖼</button>
        <div className="sc-toolbar-sep" />

        {/* Output */}
        <button className="sc-tool-btn sc-save-btn" onClick={handleSave} title="保存到文件">💾</button>
        <button className="sc-tool-btn sc-copy-btn" onClick={handleCopy} title="复制到剪贴板">📋</button>
        <button className="sc-tool-btn sc-cancel-btn" onClick={handleCancel} title="取消 (Esc)">✕</button>
      </div>
      )}
    </div>
  );
}
