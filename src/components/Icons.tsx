/**
 * Shared SVG icon set for all Easy-Copy windows.
 *
 * All icons inherit `currentColor`, share a 16x16 viewBox, and are rendered
 * with consistent stroke styling. This replaces the inline component
 * definitions that used to live at the top of App.tsx (25+ components,
 * ~200 lines of SVG markup cluttering the main file).
 */

import React from "react";

export interface IconProps {
  className?: string;
  title?: string;
  strokeWidth?: number;
  size?: number;
}

const Svg: React.FC<IconProps & { children: React.ReactNode }> = ({
  children,
  className,
  size = 16,
  title,
  strokeWidth,
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth={strokeWidth ?? 1.3}
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden={title ? undefined : true}
    focusable="false"
  >
    {title && <title>{title}</title>}
    {children}
  </svg>
);

/* ── Toolbar / list icons ──────────────────────────────────────── */

export const IconSearch: React.FC<IconProps> = (p) => (
  <Svg {...p}>
    <circle cx="7" cy="7" r="5" />
    <path d="M11 11l3.5 3.5" />
  </Svg>
);

export const IconTrash: React.FC<IconProps> = (p) => (
  <Svg {...p} size={14}>
    <path d="M3 4h10M6 4V2.5h4V4M5 4l.5 9.5h5L11 4" />
  </Svg>
);

export const IconText: React.FC<IconProps> = (p) => (
  <Svg {...p} size={13}>
    <rect x="2.5" y="2" width="11" height="12" rx="1" />
    <path d="M5 5.5h6M5 7.5h6M5 9.5h4" strokeWidth={1} />
  </Svg>
);

export const IconImage: React.FC<IconProps> = (p) => (
  <Svg {...p} size={13}>
    <rect x="2" y="2" width="12" height="12" rx="1" />
    <circle cx="5.5" cy="5.5" r="1.2" fill="currentColor" stroke="none" />
    <path d="M2.5 12l3-3 2 2 3-3 3 2.5" />
  </Svg>
);

export const IconFiles: React.FC<IconProps> = (p) => (
  <Svg {...p} size={13}>
    <path d="M1.5 4h4l1.5 1.5H14.5V13.5H1.5z" />
  </Svg>
);

export const IconPower: React.FC<IconProps> = (p) => (
  <Svg {...p} size={12}>
    <path d="M8 2v6" strokeWidth={1.5} />
    <path d="M4.5 4a5.5 5.5 0 107 0" strokeWidth={1.5} />
  </Svg>
);

export const IconWarning: React.FC<IconProps> = (p) => (
  <Svg {...p} size={28} strokeWidth={2}>
    <path d="M12 2L1 22h22L12 2z" strokeLinejoin="round" />
    <path d="M12 9v5" strokeWidth={2} />
    <circle cx="12" cy="18" r="1.2" fill="currentColor" stroke="none" />
  </Svg>
);

export const IconZoomIn: React.FC<IconProps> = (p) => (
  <Svg {...p} strokeWidth={1.5}>
    <circle cx="7" cy="7" r="5" />
    <path d="M7 5v4M5 7h4M11 11l3 3" />
  </Svg>
);

export const IconZoomOut: React.FC<IconProps> = (p) => (
  <Svg {...p} strokeWidth={1.5}>
    <circle cx="7" cy="7" r="5" />
    <path d="M5 7h4M11 11l3 3" />
  </Svg>
);

export const IconZoomReset: React.FC<IconProps> = (p) => (
  <Svg {...p} strokeWidth={1.5}>
    <path d="M3 8a5 5 0 119 3" />
    <path d="M12 7v4h-4" />
  </Svg>
);

export const IconSun: React.FC<IconProps> = (p) => (
  <Svg {...p} size={14}>
    <circle cx="8" cy="8" r="3" />
    <path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.4 1.4M11.6 11.6L13 13M3 13l1.4-1.4M11.6 4.4L13 3" />
  </Svg>
);

export const IconMoon: React.FC<IconProps> = (p) => (
  <Svg {...p} size={14}>
    <path d="M13 8.5a5 5 0 11-5.5-5.5 4 4 0 005.5 5.5z" />
  </Svg>
);

export const IconAuto: React.FC<IconProps> = (p) => (
  <Svg {...p} size={14}>
    <path d="M8 1.5a6.5 6.5 0 100 13z" fill="currentColor" opacity={0.4} stroke="none" />
    <circle cx="8" cy="8" r="6.5" strokeWidth={1.2} />
  </Svg>
);

export const IconUndo: React.FC<IconProps> = (p) => (
  <Svg {...p} size={14}>
    <path d="M3 6h7a4 4 0 110 8H6" />
    <path d="M5 4L3 6l2 2" />
  </Svg>
);

export const IconIncognito: React.FC<IconProps> = (p) => (
  <Svg {...p} size={14}>
    <path d="M2 7l2-4h8l2 4" />
    <rect x="1.5" y="7" width="13" height="2" rx="0.5" fill="currentColor" stroke="none" />
    <circle cx="5" cy="11.5" r="2" />
    <circle cx="11" cy="11.5" r="2" />
  </Svg>
);

export const IconSettings: React.FC<IconProps> = (p) => (
  <Svg {...p} size={14}>
    <path d="M8 5.5a2.5 2.5 0 100 5 2.5 2.5 0 000-5z" />
    <path d="M8 1v2M8 13v2M2 8h2M12 8h2M3.5 3.5l1.4 1.4M11.1 11.1l1.4 1.4M3.5 12.5l1.4-1.4M11.1 4.9l1.4-1.4" />
  </Svg>
);

export const IconExport: React.FC<IconProps> = (p) => (
  <Svg {...p} size={14}>
    <path d="M8 2v8M5 5l3-3 3 3" />
    <path d="M3 11v2.5h10V11" />
  </Svg>
);

export const IconImport: React.FC<IconProps> = (p) => (
  <Svg {...p} size={14}>
    <path d="M8 10V2M5 7l3 3 3-3" />
    <path d="M3 11v2.5h10V11" />
  </Svg>
);

export const IconCopy: React.FC<IconProps> = (p) => (
  <Svg {...p} size={14}>
    <rect x="4" y="4" width="9" height="9" rx="1" />
    <path d="M3 11V3a1 1 0 011-1h7" />
  </Svg>
);

/* ── Tools window / tree icons ─────────────────────────────────── */

export const IconClock: React.FC<IconProps> = (p) => (
  <Svg {...p} size={14}>
    <circle cx="8" cy="8" r="6" />
    <path d="M8 4.5V8l2.5 1.5" />
  </Svg>
);

export const IconGlobe: React.FC<IconProps> = (p) => (
  <Svg {...p} size={14}>
    <circle cx="8" cy="8" r="6" />
    <path d="M2 8h12" />
    <path d="M8 2c2.2 1.7 2.2 10.3 0 12M8 2c-2.2 1.7-2.2 10.3 0 12" />
  </Svg>
);

export const IconShuffle: React.FC<IconProps> = (p) => (
  <Svg {...p} size={14}>
    <path d="M2 4h2.5l7 8H14M2 12h2.5l7-8H14" />
    <path d="M12 2l2 2-2 2M12 10l2 2-2 2" />
  </Svg>
);

export const IconPuzzle: React.FC<IconProps> = (p) => (
  <Svg {...p} size={14}>
    <path d="M6 2.5a1.5 1.5 0 013 0V4h3v3h1.5a1.5 1.5 0 010 3H12v3H9v-1.5a1.5 1.5 0 00-3 0V13H3V4h3z" />
  </Svg>
);

/* 折叠三角：默认指右，展开态由 CSS 旋转 90° 指下（见 .jv-caret.open）。
 * 尺寸取 10 是为了塞进 12px 宽的 caret 槽位，描边相应加粗才看得清。 */
export const IconChevron: React.FC<IconProps> = (p) => (
  <Svg {...p} size={10} strokeWidth={1.8}>
    <path d="M6 3l4 5-4 5" />
  </Svg>
);

export const IconCheck: React.FC<IconProps> = (p) => (
  <Svg {...p} size={14} strokeWidth={1.6}>
    <path d="M3 8.5l3.5 3.5L13 4.5" />
  </Svg>
);

export const IconFolder: React.FC<IconProps> = (p) => (
  <Svg {...p} size={14}>
    <path d="M2 4.5a1 1 0 011-1h3.2l1.3 1.6H13a1 1 0 011 1v5.4a1 1 0 01-1 1H3a1 1 0 01-1-1z" />
  </Svg>
);

export const IconHome: React.FC<IconProps> = (p) => (
  <Svg {...p} size={14}>
    <path d="M2.5 7.2L8 2.8l5.5 4.4" />
    <path d="M4 8.2v4.6a.6.6 0 00.6.6h6.8a.6.6 0 00.6-.6V8.2" />
  </Svg>
);

export const IconLock: React.FC<IconProps> = (p) => (
  <Svg {...p} size={14}>
    <rect x="3.5" y="7" width="9" height="6" rx="1" />
    <path d="M5.8 7V5.2a2.2 2.2 0 014.4 0V7" />
  </Svg>
);

export const IconPin: React.FC<IconProps> = (p) => (
  <Svg {...p} size={14}>
    <path d="M6 2h4l-.6 3.4 2.1 2.1H4.5l2.1-2.1z" />
    <path d="M8 7.5V14" />
  </Svg>
);

export const IconLink: React.FC<IconProps> = (p) => (
  <Svg {...p} size={14}>
    <path d="M6.8 9.2a2.6 2.6 0 003.9.3l1.8-1.8a2.6 2.6 0 00-3.7-3.7l-1 1" />
    <path d="M9.2 6.8a2.6 2.6 0 00-3.9-.3L3.5 8.3a2.6 2.6 0 003.7 3.7l1-1" />
  </Svg>
);

export const IconNote: React.FC<IconProps> = (p) => (
  <Svg {...p} size={14}>
    <path d="M9 2.5H4a1 1 0 00-1 1v9a1 1 0 001 1h8a1 1 0 001-1V6.5z" />
    <path d="M9 2.5v4h4" />
  </Svg>
);

export const IconWrench: React.FC<IconProps> = (p) => (
  <Svg {...p} size={14}>
    <path d="M10.4 2.4a3.6 3.6 0 00-4.2 4.9L2.6 10.9a1.2 1.2 0 001.7 1.7l3.6-3.6a3.6 3.6 0 004.9-4.2l-2 2-1.9-.5-.5-1.9z" />
  </Svg>
);

export const IconCamera: React.FC<IconProps> = (p) => (
  <Svg {...p} size={14}>
    <path d="M2.5 5.8h2.2l1-1.6h4.6l1 1.6h2.2a.8.8 0 01.8.8v5.4a.8.8 0 01-.8.8h-11a.8.8 0 01-.8-.8V6.6a.8.8 0 01.8-.8z" />
    <circle cx="8" cy="9.3" r="2.2" />
  </Svg>
);

/* ── Type helper for item-type badges ─────────────────────────── */

import type { ClipboardItem } from "../hooks/useClipboard";

export type ItemType = ClipboardItem["type"];

export const TypeIcon: React.FC<{ type: ItemType }> = ({ type }) => {
  switch (type) {
    case "Image":
      return <IconImage />;
    case "Files":
      return <IconFiles />;
    default:
      return <IconText />;
  }
};
