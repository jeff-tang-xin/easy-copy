/**
 * Inline SVG icon set for the screenshot overlay toolbar.
 *
 * Replaces the previous emoji glyphs (✂ ▭ ↗ ✎ 💾 📋 …). Emoji render
 * inconsistently across platforms/fonts — different metrics, colour fonts that
 * ignore `currentColor`, and vertical misalignment inside the button box. These
 * icons inherit `currentColor` and share a single 24x24 viewBox so every toolbar
 * button lines up exactly.
 */

interface IconProps {
  /** Rendered size in px (width & height). Default 18. */
  size?: number;
  className?: string;
}

/** Shared wrapper: consistent viewBox, stroke config and colour inheritance. */
function Svg({ size = 18, className, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/** Crop / re-select region. */
export const IconCrop = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 2v14a2 2 0 0 0 2 2h14" />
    <path d="M18 22V8a2 2 0 0 0-2-2H2" />
  </Svg>
);

/** Rectangle annotation. */
export const IconRect = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="5" width="18" height="14" rx="2" />
  </Svg>
);

/** Arrow annotation. */
export const IconArrow = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 19 19 5" />
    <path d="M12 5h7v7" />
  </Svg>
);

/** Freehand pen annotation. */
export const IconPen = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 19l7-7 3 3-7 7-3-3z" />
    <path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" />
    <path d="M2 2l7.586 7.586" />
    <circle cx="11" cy="11" r="2" />
  </Svg>
);

/** Text annotation. */
export const IconText = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 7V5h16v2" />
    <path d="M12 5v14" />
    <path d="M9 19h6" />
  </Svg>
);

/** Mosaic / pixelate — grid of alternating filled cells. */
export const IconMosaic = (p: IconProps) => (
  <Svg {...p} >
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <rect x="6" y="6" width="4" height="4" fill="currentColor" stroke="none" />
    <rect x="14" y="6" width="4" height="4" fill="currentColor" stroke="none" />
    <rect x="10" y="10" width="4" height="4" fill="currentColor" stroke="none" />
    <rect x="6" y="14" width="4" height="4" fill="currentColor" stroke="none" />
    <rect x="14" y="14" width="4" height="4" fill="currentColor" stroke="none" />
  </Svg>
);

/** Undo last annotation. */
export const IconUndo = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 7v6h6" />
    <path d="M3.5 13a9 9 0 1 0 2.1-9.4L3 7" />
  </Svg>
);

/** Clear all annotations. */
export const IconClear = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M5.6 5.6l12.8 12.8" />
  </Svg>
);

/** Pin (keep on top after copy). */
export const IconPin = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 17v5" />
    <path d="M9 3h6l-1 6 3 3H7l3-3-1-6z" />
  </Svg>
);

/** Sticker / float the selection on screen. */
export const IconSticker = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <circle cx="8.5" cy="8.5" r="1.5" />
    <path d="M21 15l-5-5L5 21" />
  </Svg>
);

/** Save to file. */
export const IconSave = (p: IconProps) => (
  <Svg {...p}>
    <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
    <path d="M17 21v-8H7v8" />
    <path d="M7 3v5h8" />
  </Svg>
);

/** Copy to clipboard. */
export const IconCopy = (p: IconProps) => (
  <Svg {...p}>
    <rect x="9" y="9" width="12" height="12" rx="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </Svg>
);

/** Cancel / close. */
export const IconClose = (p: IconProps) => (
  <Svg {...p}>
    <path d="M18 6 6 18" />
    <path d="M6 6l12 12" />
  </Svg>
);

/** Confirm (text input OK). */
export const IconCheck = (p: IconProps) => (
  <Svg {...p}>
    <path d="M20 6 9 17l-5-5" />
  </Svg>
);

/** Delete selected annotation. */
export const IconTrash = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 6h18" />
    <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    <path d="M10 11v6M14 11v6" />
  </Svg>
);
