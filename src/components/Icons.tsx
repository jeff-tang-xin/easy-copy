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
