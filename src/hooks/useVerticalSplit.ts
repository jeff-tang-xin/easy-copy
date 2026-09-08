/* =============================================================
 * useVerticalSplit — draggable horizontal divider between two
 * stacked panes (request editor on top, response below).
 *
 * The split is stored as a **percentage** of the container height,
 * not pixels: the window is resizable, and a pixel split silently
 * turns into "response pane eats everything" (or vanishes) as soon
 * as the user maximises or restores the window. A ratio survives
 * both. It is persisted to localStorage so the layout the user
 * settled on is still there next launch — same storage convention
 * as `useTheme`.
 *
 * Dragging listens on `window`, not on the handle: the pointer
 * routinely outruns a 5px-tall element, and handle-local listeners
 * drop the drag the moment that happens. Pointer capture would also
 * work, but window listeners keep the teardown in one place.
 * ============================================================= */
import { useCallback, useEffect, useRef, useState } from "react";

const STORAGE_KEY = "easy-copy-api-split";

/** Keep both panes usable: neither may be squeezed below this share. */
const MIN_PCT = 15;
const MAX_PCT = 85;
const DEFAULT_PCT = 50;

const clamp = (v: number) => Math.min(MAX_PCT, Math.max(MIN_PCT, v));

function readStored(): number {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return DEFAULT_PCT;
  const n = Number(raw);
  // A corrupt or hand-edited value must not wedge the layout.
  return Number.isFinite(n) ? clamp(n) : DEFAULT_PCT;
}

export interface VerticalSplit {
  /** Top pane height as a percentage of the container. */
  topPct: number;
  /** Attach to the element that spans both panes. */
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** True while a drag is in flight (for styling the handle). */
  dragging: boolean;
  /** Wire to the handle's `onMouseDown`. */
  onHandleMouseDown: (e: React.MouseEvent) => void;
  /** Wire to the handle's `onKeyDown` — arrows nudge, Home recentres. */
  onHandleKeyDown: (e: React.KeyboardEvent) => void;
  /** Restore the 50/50 default (double-click the handle). */
  reset: () => void;
}

export function useVerticalSplit(): VerticalSplit {
  const [topPct, setTopPct] = useState<number>(readStored);
  const [dragging, setDragging] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Persist lazily: writing on every mousemove would hammer
  // localStorage (a synchronous, disk-backed API) during a drag.
  useEffect(() => {
    if (dragging) return;
    localStorage.setItem(STORAGE_KEY, String(topPct));
  }, [dragging, topPct]);

  const onHandleMouseDown = useCallback((e: React.MouseEvent) => {
    // Left button only; a right-click here should open no drag.
    if (e.button !== 0) return;
    e.preventDefault();
    setDragging(true);
  }, []);

  useEffect(() => {
    if (!dragging) return;

    const onMove = (e: MouseEvent) => {
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      if (rect.height <= 0) return;
      setTopPct(clamp(((e.clientY - rect.top) / rect.height) * 100));
    };
    const stop = () => setDragging(false);

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", stop);
    // Releasing outside the window never fires mouseup; without this the
    // divider would stay glued to the cursor after the user comes back.
    window.addEventListener("blur", stop);

    // Text selection and iframe/CodeMirror hover states fight the drag,
    // so suppress them for its duration and restore afterwards.
    // 用单个 class 切换代替逐条写 body.style.*：后者每次赋值都可能触发
    // 一次样式重算，而拖拽是每帧都在跑的高频路径。改成一次 classList 变更
    // 让浏览器只做一趟批量处理，也顺带省去手工保存/还原原值的样板代码
    // （原先的 prevSelect/prevCursor 在拖拽期间若被其他代码改写就会还原错）。
    document.body.classList.add("dragging");

    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", stop);
      window.removeEventListener("blur", stop);
      document.body.classList.remove("dragging");
    };
  }, [dragging]);

  const onHandleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Keyboard parity: a mouse-only divider is unreachable for anyone
    // navigating by keyboard, and the handle is focusable.
    const step = e.shiftKey ? 10 : 2;
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setTopPct((p) => clamp(p - step));
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setTopPct((p) => clamp(p + step));
    } else if (e.key === "Home") {
      e.preventDefault();
      setTopPct(DEFAULT_PCT);
    }
  }, []);

  const reset = useCallback(() => setTopPct(DEFAULT_PCT), []);

  return { topPct, containerRef, dragging, onHandleMouseDown, onHandleKeyDown, reset };
}
