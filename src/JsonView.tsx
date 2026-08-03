import { useMemo, useState } from "react";

/* =============================================================
 * JsonView — dependency-free JSON syntax highlighter.
 *
 * Built by hand instead of pulling in a highlighter lib: the payloads here are
 * proxy logs (small, already parsed once) and the whole point is theme-aware
 * colors driven by the app's CSS variables, which off-the-shelf themes fight.
 * ============================================================= */

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** Token kinds map 1:1 to `.jv-*` CSS classes in ToolsApp.css. */
type TokenKind = "key" | "string" | "number" | "boolean" | "null" | "punct";

/** A body arrives as a *string* over IPC. If it happens to hold JSON we want to
 *  render it as a real tree rather than a one-line blob full of \" escapes —
 *  that blob is exactly what makes response bodies unreadable today. */
export function tryParseJson(raw: string): { ok: true; value: Json } | { ok: false } {
  const t = raw.trim();
  if (!t) return { ok: false };
  // Cheap gate: only attempt a parse on things that can structurally be JSON,
  // so we don't turn the plain string "42" or "null" into a fake tree.
  if (!/^[[{]/.test(t)) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(t) as Json };
  } catch {
    return { ok: false };
  }
}

function Token({ kind, text }: { kind: TokenKind; text: string }) {
  return <span className={`jv-${kind}`}>{text}</span>;
}

/** Renders a URL-ish string value as a real link-looking token. Proxy logs are
 *  full of targets and Location headers; being able to eyeball them helps. */
function StringValue({ value }: { value: string }) {
  const isUrl = /^https?:\/\//.test(value);
  return <span className={isUrl ? "jv-string jv-url" : "jv-string"}>"{value}"</span>;
}

function Primitive({ value }: { value: Json }) {
  if (value === null) return <Token kind="null" text="null" />;
  switch (typeof value) {
    case "boolean":
      return <Token kind="boolean" text={String(value)} />;
    case "number":
      return <Token kind="number" text={String(value)} />;
    default:
      return <StringValue value={value as string} />;
  }
}

interface NodeProps {
  /** Object key this node sits under, if any. */
  name?: string;
  value: Json;
  /** Depth drives indentation; also decides what starts collapsed. */
  depth: number;
  /** Render a trailing comma (i.e. not the last entry of its parent). */
  comma: boolean;
}

function JsonNode({ name, value, depth, comma }: NodeProps) {
  const isContainer = value !== null && typeof value === "object";
  const entries: [string, Json][] = !isContainer
    ? []
    : Array.isArray(value)
      ? value.map((v, i) => [String(i), v])
      : Object.entries(value as { [k: string]: Json });

  // Deep structures collapse by default so the top-level shape stays scannable;
  // proxy detail is only ever 2 levels of real interest (request / response).
  const [open, setOpen] = useState(depth < 3);

  const pad = { paddingLeft: depth === 0 ? 0 : 14 };

  if (!isContainer) {
    return (
      <div className="jv-row" style={pad}>
        {name !== undefined && (
          <>
            <Token kind="key" text={`"${name}"`} />
            <Token kind="punct" text=": " />
          </>
        )}
        <Primitive value={value} />
        {comma && <Token kind="punct" text="," />}
      </div>
    );
  }

  const [openBrace, closeBrace] = Array.isArray(value) ? ["[", "]"] : ["{", "}"];
  const count = entries.length;

  if (count === 0) {
    return (
      <div className="jv-row" style={pad}>
        {name !== undefined && (
          <>
            <Token kind="key" text={`"${name}"`} />
            <Token kind="punct" text=": " />
          </>
        )}
        <Token kind="punct" text={openBrace + closeBrace} />
        {comma && <Token kind="punct" text="," />}
      </div>
    );
  }

  return (
    <div style={pad}>
      <div className="jv-row jv-clickable" onClick={() => setOpen((o) => !o)}>
        <span className={`jv-caret ${open ? "open" : ""}`}>▶</span>
        {name !== undefined && (
          <>
            <Token kind="key" text={`"${name}"`} />
            <Token kind="punct" text=": " />
          </>
        )}
        <Token kind="punct" text={openBrace} />
        {!open && (
          <>
            <span className="jv-summary">
              {count} {count === 1 ? "item" : "items"}
            </span>
            <Token kind="punct" text={closeBrace} />
            {comma && <Token kind="punct" text="," />}
          </>
        )}
      </div>
      {open && (
        <>
          {entries.map(([k, v], i) => (
            <JsonNode
              key={k}
              name={Array.isArray(value) ? undefined : k}
              value={v}
              depth={depth + 1}
              comma={i < count - 1}
            />
          ))}
          <div className="jv-row">
            <Token kind="punct" text={closeBrace} />
            {comma && <Token kind="punct" text="," />}
          </div>
        </>
      )}
    </div>
  );
}

/** Collapsible, colorized JSON tree. */
export function JsonView({ data }: { data: Json }) {
  return (
    <div className="json-view">
      <JsonNode value={data} depth={0} comma={false} />
    </div>
  );
}

/** Colorized view for a raw body string: renders a JSON tree when the payload
 *  really is JSON, and falls back to readable pre-wrapped text otherwise. */
export function BodyView({ body }: { body: string | null }) {
  const parsed = useMemo(() => (body === null ? null : tryParseJson(body)), [body]);

  if (body === null) return <div className="jv-empty">— no body —</div>;
  if (body.trim() === "") return <div className="jv-empty">— empty body —</div>;
  if (parsed && parsed.ok) return <JsonView data={parsed.value} />;
  return <pre className="jv-raw">{body}</pre>;
}
