import { useState, useEffect, useRef, useCallback } from "react";
import { getCurrentWindow, LogicalSize, LogicalPosition } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  IconCrop, IconRect, IconArrow, IconPen, IconText, IconMosaic,
  IconUndo, IconClear, IconPin, IconSticker, IconSave, IconCopy,
  IconClose, IconCheck, IconTrash,
} from "./ScreenshotIcons";
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
type Tool = "select" | "rect" | "arrow" | "pen" | "text" | "mosaic" | "none";

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
const DRAW_TOOLS: { key: Tool; Icon: (p: { size?: number }) => React.ReactElement; label: string }[] = [
  { key: "rect", Icon: IconRect, label: "矩形 (1)" },
  { key: "arrow", Icon: IconArrow, label: "箭头 (2)" },
  { key: "pen", Icon: IconPen, label: "画笔 (3)" },
  { key: "text", Icon: IconText, label: "文字 (4) — 可自动换行，选择工具下双击可重新编辑" },
  { key: "mosaic", Icon: IconMosaic, label: "马赛克 (5) — 拖拽涂抹敏感信息" },
];

interface Point { x: number; y: number; }

/** Monotonic insertion order so Undo pops the truly newest annotation
 * regardless of type (previously it popped by type priority). */
interface Ordered { seq: number; }

interface RectAnnotation extends Ordered {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  color: Color;
  size: StrokeSize;
}

interface ArrowAnnotation extends Ordered {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: Color;
  size: StrokeSize;
}

interface PenAnnotation extends Ordered {
  id: string;
  points: Point[];
  color: Color;
  size: StrokeSize;
}

interface TextAnnotation extends Ordered {
  id: string;
  x: number;
  y: number;
  text: string;
  color: Color;
  size: StrokeSize;
  /** Wrap boundary in image px. Text longer than this soft-wraps onto new lines
   * so long annotations can never run past the capture region / screen edge. */
  maxW: number;
}

/** Pixelated block region — hides sensitive content (Snipaste-style mosaic). */
interface MosaicAnnotation extends Ordered {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Source-pixel block size; larger = coarser censoring. */
  block: number;
}

/** Selected region (image-space coordinates). null = whole image. */
interface Region { x: number; y: number; w: number; h: number; }

/** The 8 resize grips rendered around a chosen region. */
const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const;
type HandleId = typeof HANDLES[number];

/** An in-flight region adjustment: move the whole box, or drag one grip. */
type RegionDrag =
  | { kind: "move"; start: Point; orig: Region }
  | { kind: "resize"; handle: HandleId; start: Point; orig: Region };

/** Minimum region side length in image pixels. */
const MIN_REGION = 8;

/** Mosaic block size (source px) per stroke-size setting — reuses the existing
 * 2/4/6 size selector so the toolbar needs no extra control. */
const MOSAIC_BLOCK: Record<StrokeSize, number> = { 2: 8, 4: 14, 6: 22 };

/** An active text editor session. `id` set = editing an existing annotation
 * in place; absent = composing a brand-new one. */
interface TextDraft {
  x: number;
  y: number;
  maxW: number;
  id?: string;
}

/** Split `text` into rendered lines: honours explicit \n, then greedy-wraps
 * each paragraph to `maxW` using the supplied (already font-configured) ctx.
 * Falls back to hard character-splitting for unbroken runs (e.g. long URLs or
 * CJK without spaces) so a single word can still never overflow. */
function wrapText(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    if (!para) { out.push(""); continue; }
    let line = "";
    // Tokenise keeping spaces attached so Latin text breaks on spaces, while CJK
    // (no spaces) degrades naturally to per-character wrapping below.
    const tokens = para.match(/\S+\s*|\s+/g) ?? [para];
    for (const tok of tokens) {
      const cand = line + tok;
      if (ctx.measureText(cand).width <= maxW || !line) {
        // Token itself may still exceed maxW (long URL / CJK run) → char-split.
        if (ctx.measureText(cand).width > maxW && !line) {
          let chunk = "";
          for (const ch of cand) {
            if (ctx.measureText(chunk + ch).width > maxW && chunk) {
              out.push(chunk);
              chunk = ch;
            } else {
              chunk += ch;
            }
          }
          line = chunk;
          continue;
        }
        line = cand;
      } else {
        out.push(line.replace(/\s+$/, ""));
        line = tok.replace(/^\s+/, "");
      }
    }
    out.push(line.replace(/\s+$/, ""));
  }
  return out;
}

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
  const [mosaics, setMosaics] = useState<MosaicAnnotation[]>([]);

  // Id of the text annotation currently highlighted for edit/delete (select tool).
  const [selectedTextId, setSelectedTextId] = useState<string | null>(null);

  // Selected capture region (image-space). null = full screenshot.
  const [region, setRegion] = useState<Region | null>(null);

  // Drag state (image-space coords)
  const [dragging, setDragging] = useState(false);
  const [dragStart, setDragStart] = useState<Point>({ x: 0, y: 0 });
  const [dragCurrent, setDragCurrent] = useState<Point>({ x: 0, y: 0 });

  // In-flight region move/resize (null = not adjusting the region).
  const [regionDrag, setRegionDrag] = useState<RegionDrag | null>(null);

  const [textInput, setTextInput] = useState<TextDraft | null>(null);
  const [textValue, setTextValue] = useState("");

  // Two stacked canvases so region drag never repaints the screenshot:
  //   baseRef    — the captured image, blitted ONCE on load.
  //   canvasRef  — annotations only, cleared + repainted per frame.
  // Dimming and the selection border are GPU-composited DOM layers (see JSX),
  // which is what removes the drag jank on high-resolution displays.
  const baseRef = useRef<HTMLCanvasElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  // Bumped once the canvases have been given their real pixel size (image
  // onload). Sizing a canvas clears it, and onload runs after React's initial
  // paint effect, so every draw path must re-run afterwards. Text is the most
  // visible victim: its coordinates are full-image, so on the default 300x150
  // canvas it lands off-bitmap and never appears at all.
  const [canvasReady, setCanvasReady] = useState(0);
  // Monotonic counter stamped onto every annotation so Undo can pop by real
  // insertion order across all four annotation lists.
  const seqRef = useRef(0);
  // Measured toolbar width, used to clamp its position near screen edges
  // (previously a hardcoded estimate that broke when the toolbar changed).
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [toolbarW, setToolbarW] = useState(560);
  // Live pen buffer + rAF handle so freehand drawing stays smooth: mousemove
  // pushes into a ref (no React re-render per point) and a rAF loop repaints.
  const penBufRef = useRef<Point[]>([]);
  const rafRef = useRef<number | null>(null);
  // Live rect/arrow/mosaic drag endpoints kept in a ref as well, so dragging
  // repaints at most once per frame instead of once per mousemove event.
  const dragStartRef = useRef<Point>({ x: 0, y: 0 });
  const dragCurRef = useRef<Point>({ x: 0, y: 0 });
  // Latest region during a move/resize drag. Written on every mousemove but
  // only flushed into React state once per frame (see scheduleRegionFlush).
  const regionRef = useRef<Region | null>(null);

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
      setMosaics([]);
      setSelectedTextId(null);
      setRegion(null);
      regionRef.current = null;
      setTool("select");
      setPhase("select");
      setTextInput(null);
      setTextValue("");
      setPinnedShot(null);
    });
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  // Load image: size BOTH canvases and blit the screenshot into the base layer
  // exactly once. The annotation layer above it starts empty.
  useEffect(() => {
    if (!imagePath) return;
    const img = new Image();
    img.onload = () => {
      imgRef.current = img;
      const base = baseRef.current;
      const over = canvasRef.current;
      if (!base || !over) return;
      // Assigning width/height RESETS the drawing context and wipes the
      // bitmap, so only touch it when the size actually changed — and always
      // repaint afterwards (below). This onload lands asynchronously, i.e. after
      // React has already run the initial scheduleRedraw() effect: without the
      // repaint the annotation layer stays blank until some unrelated state
      // change happens to rebuild drawAnnotations.
      if (base.width !== img.width || base.height !== img.height) {
        base.width = img.width;
        base.height = img.height;
      }
      if (over.width !== img.width || over.height !== img.height) {
        over.width = img.width;
        over.height = img.height;
      }
      const bctx = base.getContext("2d");
      if (bctx) {
        bctx.clearRect(0, 0, base.width, base.height);
        bctx.drawImage(img, 0, 0);
      }
      // Now that the annotation canvas has its real pixel size, repaint it.
      // Text lives at full-image coordinates, so on a default 300x150 canvas it
      // would be drawn entirely outside the visible bitmap.
      setCanvasReady((n) => n + 1);
    };
    // Payload is now a data URL (data:image/png;base64,...) and can be loaded directly.
    img.src = imagePath;
  }, [imagePath]);

  // Scratch canvas reused for mosaic downsampling (avoids allocating per frame).
  const scratchRef = useRef<HTMLCanvasElement | null>(null);

  // Pure annotation renderer — shared by the live canvas and the export path so
  // the saved/copied image always contains the exact same rect/arrow/pen/text.
  // `src` is the clean screenshot, needed because mosaic samples real pixels.
  const drawAnnotations = useCallback((ctx: CanvasRenderingContext2D, src: HTMLImageElement | null) => {
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

    // Mosaic FIRST so annotations always sit on top of censored areas.
    // Technique: downscale the source area into a tiny scratch canvas, then blit
    // it back up with smoothing OFF — gives blocky pixelation without the
    // per-pixel getImageData cost that would stall the drag loop.
    if (mosaics.length && src) {
      if (!scratchRef.current) scratchRef.current = document.createElement("canvas");
      const scratch = scratchRef.current;
      const sctx = scratch.getContext("2d");
      for (const m of mosaics) {
        const cols = Math.max(1, Math.round(m.w / m.block));
        const rows = Math.max(1, Math.round(m.h / m.block));
        if (!sctx) break;
        scratch.width = cols;
        scratch.height = rows;
        sctx.imageSmoothingEnabled = true;
        sctx.clearRect(0, 0, cols, rows);
        sctx.drawImage(src, m.x, m.y, m.w, m.h, 0, 0, cols, rows);
        const prev = ctx.imageSmoothingEnabled;
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(scratch, 0, 0, cols, rows, m.x, m.y, m.w, m.h);
        ctx.imageSmoothingEnabled = prev;
      }
    }

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
    // Texts — soft-wrapped to their stored maxW so long strings stay inside the
    // capture region instead of running off the edge of the image.
    for (const t of texts) {
      const fontPx = 12 + t.size * 4;
      ctx.font = `600 ${fontPx}px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`;
      ctx.textBaseline = "top";
      ctx.setLineDash([]);
      ctx.lineWidth = 3;
      const lineH = Math.round(fontPx * 1.32);
      const lines = wrapText(ctx, t.text, t.maxW);
      lines.forEach((ln, i) => {
        if (!ln) return;
        const ly = t.y + i * lineH;
        ctx.strokeStyle = "rgba(0,0,0,0.55)";
        ctx.strokeText(ln, t.x, ly);
        ctx.fillStyle = t.color;
        ctx.fillText(ln, t.x, ly);
      });
    }
  }, [rects, arrows, pens, texts, mosaics]);

  // Repaint the ANNOTATION layer only. The screenshot lives on a separate canvas
  // underneath and the dim mask is a DOM layer, so this never touches full-frame
  // pixels unless an annotation actually covers them — that is what keeps region
  // dragging and freehand drawing smooth on 4K displays.
  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    drawAnnotations(ctx, imgRef.current);

    // Live mosaic preview: show the pixelation in place while dragging.
    if (tool === "mosaic" && dragging) {
      const a = dragStartRef.current;
      const b = dragCurRef.current;
      const mx = Math.min(a.x, b.x);
      const my = Math.min(a.y, b.y);
      const mw = Math.abs(b.x - a.x);
      const mh = Math.abs(b.y - a.y);
      const img = imgRef.current;
      if (img && mw > 2 && mh > 2) {
        const block = MOSAIC_BLOCK[size];
        if (!scratchRef.current) scratchRef.current = document.createElement("canvas");
        const scratch = scratchRef.current;
        const sctx = scratch.getContext("2d");
        const cols = Math.max(1, Math.round(mw / block));
        const rows = Math.max(1, Math.round(mh / block));
        if (sctx) {
          scratch.width = cols;
          scratch.height = rows;
          sctx.drawImage(img, mx, my, mw, mh, 0, 0, cols, rows);
          ctx.imageSmoothingEnabled = false;
          ctx.drawImage(scratch, 0, 0, cols, rows, mx, my, mw, mh);
          ctx.imageSmoothingEnabled = true;
        }
      }
    }

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
      const { x: x1, y: y1 } = dragStartRef.current;
      const { x: x2, y: y2 } = dragCurRef.current;
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
  }, [drawAnnotations, tool, dragging, color, size, canvasReady]);

  // Coalesce repaints into one per animation frame. Multiple state updates or
  // mousemove events inside the same frame collapse into a single canvas pass.
  //
  // A pending frame is re-armed, never skipped: its callback closed over the
  // `dragging`/`rects`/... values of the render that scheduled it. mouseup flips
  // dragging→false AND appends the shape in one batch, so a stale queued frame
  // would paint the old state (live preview, no committed shape) and then clear
  // rafRef with nobody left to schedule the real repaint — rectangles and arrows
  // silently vanished until an unrelated redraw happened to fire.
  const scheduleRedraw = useCallback(() => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      redraw();
    });
  }, [redraw]);

  useEffect(() => { scheduleRedraw(); }, [scheduleRedraw]);

  // Cancel any pending pen rAF on unmount to avoid a stray redraw.
  useEffect(() => () => { if (rafRef.current != null) cancelAnimationFrame(rafRef.current); }, []);

  // Measure the toolbar so its horizontal clamping matches reality (the button
  // set changes with tool/phase, so a hardcoded width drifts).
  useEffect(() => {
    const el = toolbarRef.current;
    if (!el) return;
    const w = el.offsetWidth;
    if (w > 0 && Math.abs(w - toolbarW) > 1) setToolbarW(w);
  }, [phase, tool, region, pinned, toolbarW]);

  // Hit-test the 8 resize grips of the current region. Tolerance is expressed in
  // SCREEN pixels then converted to image space so the grab area feels the same
  // regardless of how much the screenshot is scaled to fit the viewport.
  const hitHandle = useCallback((p: Point, r: Region): HandleId | null => {
    const canvas = canvasRef.current;
    const box = canvas?.getBoundingClientRect();
    const sx = canvas && box ? canvas.width / (box.width || 1) : 1;
    const tol = 10 * sx;
    const midX = r.x + r.w / 2;
    const midY = r.y + r.h / 2;
    const pts: Record<HandleId, Point> = {
      nw: { x: r.x, y: r.y },
      n: { x: midX, y: r.y },
      ne: { x: r.x + r.w, y: r.y },
      e: { x: r.x + r.w, y: midY },
      se: { x: r.x + r.w, y: r.y + r.h },
      s: { x: midX, y: r.y + r.h },
      sw: { x: r.x, y: r.y + r.h },
      w: { x: r.x, y: midY },
    };
    for (const h of HANDLES) {
      if (Math.abs(p.x - pts[h].x) <= tol && Math.abs(p.y - pts[h].y) <= tol) return h;
    }
    return null;
  }, []);

  const insideRegion = (p: Point, r: Region) =>
    p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;

  // Measure a text annotation's on-image bounding box (wrapped), so it can be
  // hit-tested for click-to-edit and outlined when selected.
  const textBounds = useCallback((t: TextAnnotation) => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    const fontPx = 12 + t.size * 4;
    const lineH = Math.round(fontPx * 1.32);
    // Before the canvas is sized its context measures against a stale font, which
    // would make click-to-edit hit-testing miss; fall back to the wrap width.
    if (!ctx || !canvasReady) return { x: t.x, y: t.y, w: t.maxW, h: lineH };
    ctx.save();
    ctx.font = `600 ${fontPx}px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`;
    const lines = wrapText(ctx, t.text, t.maxW);
    let w = 0;
    for (const ln of lines) w = Math.max(w, ctx.measureText(ln).width);
    ctx.restore();
    return { x: t.x, y: t.y, w, h: Math.max(1, lines.length) * lineH };
  }, [canvasReady]);

  // Topmost text annotation under a point (iterates newest-first).
  const textAt = useCallback((p: Point): TextAnnotation | null => {
    for (let i = texts.length - 1; i >= 0; i--) {
      const b = textBounds(texts[i]);
      const pad = 4;
      if (p.x >= b.x - pad && p.x <= b.x + b.w + pad && p.y >= b.y - pad && p.y <= b.y + b.h + pad) {
        return texts[i];
      }
    }
    return null;
  }, [texts, textBounds]);

  // Wrap width available from an insertion point: to the right edge of the active
  // region (or the image), less a small margin. Guarantees text never overflows.
  const wrapWidthAt = useCallback((p: Point) => {
    const img = imgRef.current;
    const right = region ? region.x + region.w : (img?.width ?? 0);
    return Math.max(60, right - p.x - 8);
  }, [region]);

  // Guards the text editor against double-commit. The OK button's click and the
  // textarea's blur can both fire for a single edit session, and each carries its
  // own stale `textInput` closure — so without a lock the same annotation gets
  // appended twice, or one the user just cancelled gets resurrected.
  const submitLockRef = useRef(false);
  // True while an IME candidate window is open (pinyin/kana being composed).
  const composingRef = useRef(false);
  const textAreaRef = useRef<HTMLTextAreaElement | null>(null);
  // False until the editor has been focused for at least one frame. Blur is only
  // allowed to commit after that, so a focus steal during mount can never
  // silently close a freshly-opened editor.
  const editorReadyRef = useRef(false);

  // Focus the editor explicitly once it is laid out, instead of relying on
  // `autoFocus`. autoFocus runs during commit, which races the browser's native
  // focus handling for the very mousedown that opened the editor; doing it on the
  // next frame means we always win, and editorReadyRef gates the blur-commit
  // until then.
  useEffect(() => {
    editorReadyRef.current = false;
    if (!textInput) return;
    const id = requestAnimationFrame(() => {
      textAreaRef.current?.focus();
      editorReadyRef.current = true;
    });
    return () => cancelAnimationFrame(id);
  }, [textInput]);

  /** Discard the editor without committing, and make sure a pending blur cannot
   *  re-commit the discarded draft. */
  const cancelText = useCallback(() => {
    submitLockRef.current = true;
    setTextInput(null);
    setTextValue("");
    setSelectedTextId(null);
  }, []);

  // Open the text editor on an existing annotation (second-pass editing).
  const beginEditText = (t: TextAnnotation) => {
    submitLockRef.current = false;
    setTool("text");
    setTextInput({ x: t.x, y: t.y, maxW: t.maxW, id: t.id });
    setTextValue(t.text);
    setColor(t.color);
    setSize(t.size);
    setSelectedTextId(t.id);
  };

  // Flush the ref-held region into React state at most once per frame.
  const regionFlushRef = useRef<number | null>(null);
  const scheduleRegionFlush = useCallback(() => {
    if (regionFlushRef.current != null) return;
    regionFlushRef.current = requestAnimationFrame(() => {
      regionFlushRef.current = null;
      if (regionRef.current) setRegion(regionRef.current);
    });
  }, []);

  // Mouse handlers — behaviour depends on active tool.
  const handleMouseDown = (e: React.MouseEvent) => {
    const p = toImageCoords(e);

    // Text tool: click an existing text to edit it in place, else start a new one.
    if (tool === "text") {
      // Suppress the browser's default focus handling for this press. It would
      // move focus to <body> AFTER React has committed the editor and focused
      // the textarea, and the resulting blur tore the editor straight back down
      // (see the focus effect above) — the box looked like it never opened.
      e.preventDefault();
      const hit = textAt(p);
      if (hit) { beginEditText(hit); return; }
      submitLockRef.current = false;
      setTextInput({ x: p.x, y: p.y, maxW: wrapWidthAt(p) });
      setTextValue("");
      setSelectedTextId(null);
      return;
    }

    // Select tool: clicking a text selects it (Delete removes, dblclick edits).
    if (tool === "select") {
      const hit = textAt(p);
      if (hit) { setSelectedTextId(hit.id); return; }
      setSelectedTextId(null);
    }

    // With the select tool and an existing region, grips take priority: dragging
    // a grip resizes, dragging inside moves, dragging outside starts a new box.
    if (tool === "select" && region) {
      const h = hitHandle(p, region);
      if (h) { setRegionDrag({ kind: "resize", handle: h, start: p, orig: region }); return; }
      if (insideRegion(p, region)) { setRegionDrag({ kind: "move", start: p, orig: region }); return; }
    }

    if (tool === "pen") {
      setDragging(true);
      penBufRef.current = [p];
      scheduleRedraw();
      return;
    }
    // select / rect / arrow / mosaic all start a drag. Endpoints live in refs so
    // mousemove doesn't force a React render per event.
    if (tool === "select" || tool === "rect" || tool === "arrow" || tool === "mosaic") {
      setDragging(true);
      dragStartRef.current = p;
      dragCurRef.current = p;
      setDragStart(p);
      setDragCurrent(p);
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    const p = toImageCoords(e);

    // Region move / resize takes precedence over annotation drawing.
    if (regionDrag) {
      const img = imgRef.current;
      const maxW = img?.width ?? Number.MAX_SAFE_INTEGER;
      const maxH = img?.height ?? Number.MAX_SAFE_INTEGER;
      const dx = p.x - regionDrag.start.x;
      const dy = p.y - regionDrag.start.y;
      const o = regionDrag.orig;

      if (regionDrag.kind === "move") {
        // Translate, clamped so the box never leaves the screenshot bounds.
        const nx = Math.min(Math.max(0, o.x + dx), maxW - o.w);
        const ny = Math.min(Math.max(0, o.y + dy), maxH - o.h);
        regionRef.current = { x: nx, y: ny, w: o.w, h: o.h };
        scheduleRegionFlush();
        return;
      }

      // Resize: derive the new edges from which grip is being dragged, then
      // normalise so dragging past the opposite edge flips instead of inverting.
      let left = o.x;
      let top = o.y;
      let right = o.x + o.w;
      let bottom = o.y + o.h;
      const hd = regionDrag.handle;
      if (hd.includes("w")) left = o.x + dx;
      if (hd.includes("e")) right = o.x + o.w + dx;
      if (hd.includes("n")) top = o.y + dy;
      if (hd.includes("s")) bottom = o.y + o.h + dy;
      const nx = Math.max(0, Math.min(left, right));
      const ny = Math.max(0, Math.min(top, bottom));
      const nw = Math.min(Math.abs(right - left), maxW - nx);
      const nh = Math.min(Math.abs(bottom - top), maxH - ny);
      regionRef.current = {
        x: nx,
        y: ny,
        w: Math.max(MIN_REGION, nw),
        h: Math.max(MIN_REGION, nh),
      };
      scheduleRegionFlush();
      return;
    }

    if (!dragging) return;
    if (tool === "pen") {
      // Push into the ref buffer and repaint via rAF (throttled) — avoids a
      // React re-render + full redraw on every single mousemove event.
      penBufRef.current.push(p);
      scheduleRedraw();
    } else {
      // Rect / arrow / mosaic / region-select: refs drive the canvas preview,
      // React state only feeds the DOM preview box.
      dragCurRef.current = p;
      scheduleRedraw();
      setDragCurrent(p);
    }
  };

  const handleMouseUp = () => {
    // Finish a region move/resize without touching annotation state.
    if (regionDrag) {
      if (regionFlushRef.current != null) {
        cancelAnimationFrame(regionFlushRef.current);
        regionFlushRef.current = null;
      }
      if (regionRef.current) setRegion(regionRef.current);
      setRegionDrag(null);
      return;
    }
    if (!dragging) return;
    setDragging(false);

    const a = dragStartRef.current;
    const b = dragCurRef.current;
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    const w = Math.abs(b.x - a.x);
    const h = Math.abs(b.y - a.y);

    if (tool === "select") {
      if (w > MIN_REGION && h > MIN_REGION) {
        const r = { x, y, w, h };
        setRegion(r);
        regionRef.current = r;
        // Region chosen → reveal the annotation toolbar and switch to edit phase.
        setPhase("edit");
      }
      // A tiny drag is treated as a stray click: keep any existing region so the
      // user doesn't lose their selection by accidentally tapping the canvas.
    } else if (tool === "rect") {
      if (w > 5 && h > 5) setRects((prev) => [...prev, { id: crypto.randomUUID(), seq: ++seqRef.current, x, y, w, h, color, size }]);
    } else if (tool === "mosaic") {
      // Mosaic reuses the stroke-size selector to pick block coarseness.
      if (w > 5 && h > 5) setMosaics((prev) => [...prev, { id: crypto.randomUUID(), seq: ++seqRef.current, x, y, w, h, block: MOSAIC_BLOCK[size] }]);
    } else if (tool === "arrow") {
      const dist = Math.hypot(b.x - a.x, b.y - a.y);
      if (dist > 8) setArrows((prev) => [...prev, { id: crypto.randomUUID(), seq: ++seqRef.current, x1: a.x, y1: a.y, x2: b.x, y2: b.y, color, size }]);
    } else if (tool === "pen") {
      // Flush the rAF-buffered points into committed state on release.
      if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
      const pts = penBufRef.current;
      if (pts.length > 1) setPens((prev) => [...prev, { id: crypto.randomUUID(), seq: ++seqRef.current, points: pts, color, size }]);
      penBufRef.current = [];
    }
  };

  // Double-click = copy, or re-open a text annotation for editing when one sits
  // under the cursor. Inside a region it copies that region; with no region yet
  // it copies the whole screenshot.
  const handleDoubleClick = (e: React.MouseEvent) => {
    if (textInput) return;            // don't hijack dblclick in the text field
    if (tool !== "select") return;     // annotation tools keep their own gestures
    const p = toImageCoords(e);
    const hit = textAt(p);
    if (hit) { beginEditText(hit); return; }
    if (region && !insideRegion(p, region)) return; // dblclick outside = ignore
    handleCopy();
  };

  // Commit the text editor: updates in place when editing an existing annotation
  // (textInput.id set), otherwise appends a new one.
  const submitText = () => {
    // One edit session commits at most once (see submitLockRef).
    if (submitLockRef.current) return;
    submitLockRef.current = true;
    const draft = textInput;
    const val = textValue.trim();
    if (draft) {
      if (draft.id) {
        // Empty text on an existing annotation means "delete it".
        if (!val) {
          setTexts((prev) => prev.filter((t) => t.id !== draft.id));
        } else {
          setTexts((prev) => prev.map((t) => (
            t.id === draft.id ? { ...t, text: val, color, size } : t
          )));
        }
      } else if (val) {
        setTexts((prev) => [...prev, {
          id: crypto.randomUUID(),
          seq: ++seqRef.current,
          x: draft.x,
          y: draft.y,
          text: val,
          color,
          size,
          maxW: draft.maxW,
        }]);
      }
    }
    setTextInput(null);
    setTextValue("");
    setSelectedTextId(null);
  };

  /** Delete the currently selected text annotation (Delete / toolbar button). */
  const deleteSelectedText = () => {
    if (!selectedTextId) return;
    setTexts((prev) => prev.filter((t) => t.id !== selectedTextId));
    setSelectedTextId(null);
  };

  // Undo the most recently added annotation by real insertion order (seq),
  // so Ctrl+Z always removes the last thing the user actually drew.
  const undoLast = () => {
    const lastSeq = <T extends Ordered>(list: T[]) => (list.length ? list[list.length - 1].seq : -1);
    const rSeq = lastSeq(rects);
    const aSeq = lastSeq(arrows);
    const pSeq = lastSeq(pens);
    const tSeq = lastSeq(texts);
    const mSeq = lastSeq(mosaics);
    const newest = Math.max(rSeq, aSeq, pSeq, tSeq, mSeq);
    if (newest < 0) return;
    if (tSeq === newest) { setTexts((p) => p.slice(0, -1)); return; }
    if (mSeq === newest) { setMosaics((p) => p.slice(0, -1)); return; }
    if (pSeq === newest) { setPens((p) => p.slice(0, -1)); return; }
    if (aSeq === newest) { setArrows((p) => p.slice(0, -1)); return; }
    setRects((p) => p.slice(0, -1));
  };

  const clearAll = () => {
    setRects([]); setArrows([]); setPens([]); setTexts([]); setMosaics([]);
    setSelectedTextId(null);
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
    drawAnnotations(fctx, img); // <- mosaic / rects / arrows / pens / texts included

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
    regionRef.current = null;
    setPhase("select");
    setTool("select");
    setImagePath(null);
  };

  // Cancel / close
  const handleCancel = async () => {
    await closeOverlay();
  };

  // Keyboard shortcuts — re-bound each render so handlers see fresh state.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;

      // Never let global shortcuts act on keystrokes aimed at a text field, no
      // matter what this closure believes `textInput` to be. The editor stops its
      // own events, so reaching here with an editable target means the state and
      // the live DOM disagree (mid-teardown re-bind) — trust the DOM.
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.isContentEditable)) {
        return;
      }

      // While the text-annotation field is open, only ESC is meaningful here;
      // everything else belongs to the input itself.
      if (textInput) {
        if (e.key === "Escape") { cancelText(); }
        return;
      }

      if (e.key === "Escape") {
        // A selected text de-selects first, so ESC doesn't jump straight out.
        if (selectedTextId) { setSelectedTextId(null); return; }
        // In edit phase, ESC then goes back to region selection instead of
        // closing outright, so users can re-frame without re-triggering capture.
        if (phase === "edit") { setPhase("select"); setTool("select"); setRegion(null); regionRef.current = null; return; }
        handleCancel();
        return;
      }

      if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); undoLast(); return; }
      if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); handleSave(); return; }
      if (mod && e.key.toLowerCase() === "c") { e.preventDefault(); handleCopy(); return; }
      if (mod && e.key.toLowerCase() === "d") { e.preventDefault(); handlePin(); return; }

      // Delete / Backspace removes the selected text annotation.
      if ((e.key === "Delete" || e.key === "Backspace") && selectedTextId) {
        e.preventDefault();
        deleteSelectedText();
        return;
      }

      // Enter confirms the capture (copy) once a region exists.
      if (e.key === "Enter" && phase === "edit") { e.preventDefault(); handleCopy(); return; }

      // Bare number/letter keys switch tools — only useful in edit phase.
      if (phase !== "edit" || mod || e.altKey) return;
      switch (e.key) {
        case "1": setTool("rect"); break;
        case "2": setTool("arrow"); break;
        case "3": setTool("pen"); break;
        case "4": setTool("text"); break;
        case "5": setTool("mosaic"); break;
        case "v": case "V": setTool("select"); break;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [textInput, texts, pens, arrows, rects, mosaics, phase, region, pinned, selectedTextId]);

  // Preview shape while dragging (image-space). Mosaic shares the rect preview
  // outline so the user can see the area being censored before release.
  const previewBox = dragging && (tool === "rect" || tool === "select" || tool === "mosaic") ? {
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

  // Screen-space rect of the current region, used by the DOM dim mask and the
  // selected-text outline. Kept here so the JSX stays readable.
  const regionBox = region ? {
    left: region.x * scale.sx,
    top: region.y * scale.sy,
    width: region.w * scale.sx,
    height: region.h * scale.sy,
  } : null;

  // Bounding box (screen space) of the selected text annotation, for its outline.
  const selectedText = texts.find((t) => t.id === selectedTextId) ?? null;
  const selectedBox = selectedText ? (() => {
    const b = textBounds(selectedText);
    return {
      left: b.x * scale.sx - 3,
      top: b.y * scale.sy - 3,
      width: b.w * scale.sx + 6,
      height: b.h * scale.sy + 6,
    };
  })() : null;

  // Position the toolbar just BELOW the selected region (Snipaste-style) instead
  // of pinning it to the screen bottom. Falls back to above the region when there
  // isn't enough room underneath, and is clamped horizontally to stay on-screen.
  const TOOLBAR_H = 46;      // approx toolbar height incl. padding
  const TOOLBAR_GAP = 8;     // gap between region edge and toolbar
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
    // Horizontal: centre on the region, then clamp within the viewport using the
    // MEASURED toolbar width so edge selections never push it off-screen.
    let left = (regLeft + regRight) / 2;
    const half = toolbarW / 2;
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
        onDoubleClick={handleDoubleClick}
      >
        {/* Base layer: the screenshot, blitted once. Never repainted. */}
        <canvas ref={baseRef} className="screenshot-canvas" />
        {/* Annotation layer: cleared + repainted per frame (cheap — no image blit). */}
        <canvas ref={canvasRef} className="screenshot-canvas screenshot-canvas-overlay" />

        {/* Dim mask as a GPU-composited DOM layer. Using an outer box-shadow means
            the darkened area costs nothing to move, so dragging/resizing the
            region stays smooth even on 4K displays. */}
        {regionBox && !previewBox && (
          <div className="sc-dim-mask" style={regionBox} />
        )}

        {/* Live preview box for rect / mosaic / region select */}
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

        {/* Live W×H readout while dragging a new region */}
        {previewBox && tool === "select" && (
          <div
            className="sc-dim-label"
            style={{
              left: previewBox.x * scale.sx,
              top: Math.max(2, previewBox.y * scale.sy - 24),
            }}
          >
            {Math.round(previewBox.w)} × {Math.round(previewBox.h)}
          </div>
        )}

        {/* Outline + quick-delete for the selected text annotation. */}
        {selectedBox && !textInput && (
          <>
            <div className="sc-text-selected" style={selectedBox} />
            <button
              className="sc-text-del"
              style={{ left: selectedBox.left + selectedBox.width + 4, top: selectedBox.top }}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); deleteSelectedText(); }}
              title="删除此文字 (Delete)"
            ><IconTrash size={13} /></button>
          </>
        )}

        {/* Region grips + size readout (edit phase, select tool) — lets the user
            fine-tune the crop instead of redrawing it from scratch. */}
        {region && tool === "select" && !previewBox && (
          <>
            <div
              className="sc-region-move"
              style={{
                left: region.x * scale.sx,
                top: region.y * scale.sy,
                width: region.w * scale.sx,
                height: region.h * scale.sy,
              }}
            />
            {HANDLES.map((h) => {
              const left = region.x * scale.sx + (h.includes("e") ? region.w * scale.sx : h.includes("w") ? 0 : region.w * scale.sx / 2);
              const top = region.y * scale.sy + (h.includes("s") ? region.h * scale.sy : h.includes("n") ? 0 : region.h * scale.sy / 2);
              return <div key={h} className={`sc-handle sc-handle-${h}`} style={{ left, top }} />;
            })}
            <div
              className="sc-dim-label"
              style={{
                left: region.x * scale.sx,
                top: Math.max(2, region.y * scale.sy - 24),
              }}
            >
              {Math.round(region.w)} × {Math.round(region.h)}
            </div>
          </>
        )}

        {/* Text editor — a textarea so Shift+Enter adds explicit line breaks, sized
            to the wrap width so what you type matches what gets drawn.
            Must stay INSIDE the canvas wrapper: it is positioned with the same
            image→screen scale as the region grips, so parenting it to the outer
            flex container offset it by the toolbar/hint height and pushed it
            outside the viewport for clicks low in the image. */}
        {textInput && (
        <div
          className="text-input-popup"
          style={{ left: textInput.x * scale.sx, top: textInput.y * scale.sy }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <textarea
            ref={textAreaRef}
            rows={1}
            className="text-input-field"
            value={textValue}
            style={{
              color,
              fontSize: (12 + size * 4) * scale.sx,
              fontWeight: 600,
              width: Math.max(80, textInput.maxW * scale.sx),
              lineHeight: 1.32,
            }}
            onChange={(e) => setTextValue(e.target.value)}
            onCompositionStart={() => { composingRef.current = true; }}
            onCompositionEnd={() => { composingRef.current = false; }}
            onKeyDown={(e) => {
              // Everything typed here belongs to the editor — stop the event before it
              // reaches the window-level shortcut handler. preventDefault() alone is
              // NOT enough: submitText() flips textInput to null, React flushes that
              // synchronously and re-binds the window listener with a fresh closure,
              // and the still-bubbling keypress then hits that new listener with the
              // "editor closed" guard — Enter fell straight through to handleCopy()
              // and captured the screenshot mid-sentence.
              e.stopPropagation();
              // While an IME is composing, Enter belongs to the candidate window —
              // committing here would drop the raw pinyin onto the canvas instead
              // of the characters the user actually picked.
              if (e.nativeEvent.isComposing || composingRef.current) return;
              // Enter commits; Shift+Enter inserts a hard line break.
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submitText(); }
              if (e.key === "Escape") { e.preventDefault(); cancelText(); }
            }}
            onBlur={() => { if (editorReadyRef.current && !composingRef.current) submitText(); }}
            placeholder={textInput.id ? "编辑文字… (Enter 保存 / 清空则删除)" : "输入文字… (Enter 确认，Shift+Enter 换行)"}
          />
          <button className="text-input-ok" onMouseDown={(e) => e.preventDefault()} onClick={submitText}><IconCheck size={15} /></button>
        </div>
        )}
      </div>

      {/* Selection hint (before a region is chosen) */}
      {!showToolbar && !textInput && (
        <div className="sc-hint">拖拽鼠标框选区域 · 双击复制全屏 · Esc 取消</div>
      )}

      {/* Toolbar */}
      {showToolbar && (
      <div className="screenshot-toolbar" ref={toolbarRef} style={toolbarStyle}>
        {/* Select / adjust region — keeps the existing box so the grips can be used
            for fine-tuning instead of forcing a redraw from scratch. */}
        <button className={`sc-tool-btn ${tool === "select" ? "active" : ""}`} onClick={() => { setTool("select"); }} title="选择/调整区域 (V) — 拖边角手柄改大小，框内拖动可移动"><IconCrop /></button>
        <div className="sc-toolbar-sep" />

        {/* Annotation tools */}
        {DRAW_TOOLS.map((t) => (
          <button
            key={t.key}
            className={`sc-tool-btn ${tool === t.key ? "active" : ""}`}
            onClick={() => setTool(t.key)}
            title={t.label}
          ><t.Icon /></button>
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
        <button className="sc-tool-btn" onClick={undoLast} title="撤销 (Ctrl+Z)"><IconUndo /></button>
        <button className="sc-tool-btn" onClick={clearAll} title="清除所有标注"><IconClear /></button>
        <div className="sc-toolbar-sep" />

        {/* Pin / comparison */}
        <button className={`sc-tool-btn ${pinned ? "active" : ""}`} onClick={togglePin} title="复制后把选区固定在屏幕上方供对比"><IconPin /></button>
        <button className="sc-tool-btn" onClick={handlePin} title="贴图：把当前选区固定浮在屏幕上方 (Ctrl+D)"><IconSticker /></button>
        <div className="sc-toolbar-sep" />

        {/* Output */}
        <button className="sc-tool-btn sc-save-btn" onClick={handleSave} title="保存到文件 (Ctrl+S)"><IconSave /></button>
        <button className="sc-tool-btn sc-copy-btn" onClick={handleCopy} title="复制到剪贴板 (Ctrl+C / Enter / 双击选区)"><IconCopy /></button>
        <button className="sc-tool-btn sc-cancel-btn" onClick={handleCancel} title="取消 (Esc)"><IconClose /></button>
      </div>
      )}
    </div>
  );
}
