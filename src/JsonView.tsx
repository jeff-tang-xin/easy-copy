import { useCallback, useMemo, useState } from "react";
import "./JsonView.css";

/* =============================================================
 * JsonView — dependency-free JSON syntax highlighter.
 *
 * Built by hand instead of pulling in a highlighter lib: the payloads here are
 * proxy logs (small, already parsed once) and the whole point is theme-aware
 * colors driven by the app's CSS variables, which off-the-shelf themes fight.
 * ============================================================= */

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** Token kinds map 1:1 to `.jv-*` CSS classes in JsonView.css. */
type TokenKind = "key" | "string" | "number" | "boolean" | "null" | "punct";

/** Where a malformed document broke, in human coordinates. `JSON.parse` only
 *  gives a character offset (and not even that, consistently, across engines),
 *  which is useless when you're staring at a 200-line request body. */
export interface JsonParseError {
  /** Engine message, trimmed of its noisy embedded snippet where possible. */
  message: string;
  /** 1-based. **0 means the location is genuinely unknown** — render the
   *  message alone rather than pointing at a line you can't vouch for. */
  line: number;
  /** 1-based. 0 when unknown. */
  column: number;
}

/** Converts a character offset into 1-based line/column. */
function offsetToLineCol(text: string, offset: number): { line: number; column: number } {
  // Clamp: engines report an offset one past the end for truncated input.
  const at = Math.max(0, Math.min(offset, text.length));
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < at; i++) {
    if (text[i] === "\n") {
      line += 1;
      lineStart = i + 1;
    }
  }
  return { line, column: at - lineStart + 1 };
}

/** Best-effort error location, deliberately *conservative*.
 *
 *  Only two sources are trusted:
 *    1. An explicit offset/line-column the engine put in the message.
 *    2. "Unexpected end of JSON input", where the break is by definition EOF.
 *
 *  Everything else returns `line: 0` (unknown). That matters because V8 — which
 *  is what WebView2 runs — omits the offset for the single most common typo
 *  (`Unexpected token ',' ... is not valid JSON`) and instead embeds a short
 *  snippet. Two heuristics for recovering a line from that snippet were built
 *  and measured against real engine output: locating the snippet in the source
 *  mis-reported the line on nested duplicates, and a prefix binary search was
 *  invalid outright because `JSON.parse("{")` fails hard rather than with
 *  end-of-input, so the "first failing prefix" isn't monotonic. Both produced
 *  confidently wrong line numbers, which is strictly worse than admitting the
 *  position is unknown — a wrong pointer sends you hunting the wrong line. */
function locateJsonError(raw: string, message: string): { line: number; column: number } {
  const pos = /position\s+(\d+)/.exec(message);
  if (pos) return offsetToLineCol(raw, Number(pos[1]));
  // Firefox/SpiderMonkey phrases it as "at line 3 column 5 of the JSON data".
  const lc = /line\s+(\d+)\s+column\s+(\d+)/.exec(message);
  if (lc) return { line: Number(lc[1]), column: Number(lc[2]) };
  if (/unexpected end of/i.test(message)) return offsetToLineCol(raw, raw.length);
  return { line: 0, column: 0 };
}

/** V8 splices a source snippet into the message, which reads terribly in a
 *  narrow status pill. Keep the diagnosis, drop the echoed source and the raw
 *  character offset (the caller renders line/column instead, which duplicates
 *  it in friendlier units). */
function cleanJsonErrorMessage(message: string): string {
  const tok = /^(Unexpected token '.')/.exec(message);
  const core = tok
    ? tok[1]
    : message.replace(/\s*,?\s*(?:\.\.\.)?".*?"(?:\.\.\.)?\s*is not valid JSON\s*$/, "").trim() || message;
  return core.replace(/\s*(?:in JSON\s*)?at position\s+\d+\s*$/, "").trim() || core;
}

/** Parses JSON and, on failure, reports *where* it broke when that can be
 *  determined reliably.
 *
 *  Unlike `tryParseJson` this does not require the payload to start with `[`
 *  or `{` — the request-body editor validates whatever the user typed, and
 *  a bare `"abc"` or `42` is legal JSON there. */
export function parseJsonDetailed(
  raw: string
): { ok: true; value: Json } | { ok: false; error: JsonParseError } {
  try {
    return { ok: true, value: JSON.parse(raw) as Json };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const { line, column } = locateJsonError(raw, message);
    return { ok: false, error: { message: cleanJsonErrorMessage(message), line, column } };
  }
}

/** A body arrives as a *string* over IPC. If it happens to hold JSON we want to
 *  render it as a real tree rather than a one-line blob full of \" escapes —
 *  that blob is exactly what makes response bodies unreadable today. */
export function tryParseJson(raw: string): { ok: true; value: Json } | { ok: false } {
  const t = raw.trim();
  if (!t) return { ok: false };
  // Cheap gate: only attempt a parse on things that can structurally be JSON,
  // so we don't turn the plain string "42" or "null" into a fake tree.
  if (!/^[[{]/.test(t)) return { ok: false };
  const parsed = parseJsonDetailed(t);
  return parsed.ok ? { ok: true, value: parsed.value } : { ok: false };
}

/** Re-serializes `raw` with the given indent (0 = minify). Returns the original
 *  text untouched when it isn't valid JSON, so callers can wire this straight to
 *  a button without guarding first. */
export function formatJsonText(
  raw: string,
  indent: number
): { ok: true; text: string } | { ok: false; error: JsonParseError } {
  const parsed = parseJsonDetailed(raw);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  return {
    ok: true,
    text: indent > 0 ? JSON.stringify(parsed.value, null, indent) : JSON.stringify(parsed.value),
  };
}

/** Splits `text` on every case-insensitive occurrence of `query` and wraps the
 *  matches, so searching a large response actually shows you where the hits
 *  are instead of just counting them. Returns the plain string when there's
 *  nothing to highlight, which keeps the common path allocation-free. */
function highlight(text: string, query: string): React.ReactNode {
  if (!query) return text;
  const q = query.toLowerCase();
  const hay = text.toLowerCase();
  // `indexOf` in a loop rather than a RegExp: the query is user input and
  // would otherwise need escaping, and this avoids that class of bug entirely.
  let from = 0;
  let at = hay.indexOf(q, from);
  if (at < 0) return text;
  const out: React.ReactNode[] = [];
  let key = 0;
  while (at >= 0) {
    if (at > from) out.push(text.slice(from, at));
    out.push(
      <mark key={key++} className="jv-hit">
        {text.slice(at, at + q.length)}
      </mark>
    );
    from = at + q.length;
    at = hay.indexOf(q, from);
  }
  if (from < text.length) out.push(text.slice(from));
  return out;
}

function Token({ kind, text, query }: { kind: TokenKind; text: string; query?: string }) {
  return <span className={`jv-${kind}`}>{query ? highlight(text, query) : text}</span>;
}

/** Renders a URL-ish string value as a real link-looking token. Proxy logs are
 *  full of targets and Location headers; being able to eyeball them helps. */
function StringValue({ value, query }: { value: string; query?: string }) {
  const isUrl = /^https?:\/\//.test(value);
  return (
    <span className={isUrl ? "jv-string jv-url" : "jv-string"}>
      "{query ? highlight(value, query) : value}"
    </span>
  );
}

function Primitive({ value, query }: { value: Json; query?: string }) {
  if (value === null) return <Token kind="null" text="null" />;
  switch (typeof value) {
    case "boolean":
      return <Token kind="boolean" text={String(value)} />;
    case "number":
      return <Token kind="number" text={String(value)} query={query} />;
    default:
      return <StringValue value={value as string} query={query} />;
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
  /** Active search term, highlighted in keys and values. */
  query?: string;
  /** Bumped by "expand all" / "collapse all" to force every node's open
   *  state. Encoded as `[generation, open]` so a node can tell a *new*
   *  command from the one it has already applied — without this, a node the
   *  user manually toggled after an "expand all" would be yanked back open
   *  on the next unrelated re-render. */
  force?: [number, boolean];
  /** JSONPath-ish trail to this node, used by the copy-path button. */
  path: string;
}

function JsonNode({ name, value, depth, comma, query, force, path }: NodeProps) {
  const isContainer = value !== null && typeof value === "object";
  const entries: [string, Json][] = !isContainer
    ? []
    : Array.isArray(value)
      ? value.map((v, i) => [String(i), v])
      : Object.entries(value as { [k: string]: Json });

  // Deep structures collapse by default so the top-level shape stays scannable;
  // proxy detail is only ever 2 levels of real interest (request / response).
  const [open, setOpen] = useState(depth < 3);
  // Which force-generation this node has already consumed.
  const [seenGen, setSeenGen] = useState(0);
  if (force && force[0] !== seenGen) {
    // Applying a new expand/collapse-all command. Setting state during render
    // is legal for this "derive state from props" case and avoids the extra
    // paint an effect would cost on a big tree.
    setSeenGen(force[0]);
    setOpen(force[1]);
  }

  const copyPath = (e: React.MouseEvent) => {
    e.stopPropagation();
    void navigator.clipboard.writeText(path).catch(() => {});
  };

  const keyTokens =
    name !== undefined ? (
      <>
        <Token kind="key" text={`"${name}"`} query={query} />
        <Token kind="punct" text=": " />
      </>
    ) : null;

  if (!isContainer) {
    return (
      <div className="jv-row">
        {keyTokens}
        <Primitive value={value} query={query} />
        {comma && <Token kind="punct" text="," />}
        <button className="jv-copy-path" onClick={copyPath} title={`复制路径 ${path}`}>
          ⧉
        </button>
      </div>
    );
  }

  const [openBrace, closeBrace] = Array.isArray(value) ? ["[", "]"] : ["{", "}"];
  const count = entries.length;

  if (count === 0) {
    return (
      <div className="jv-row">
        {keyTokens}
        <Token kind="punct" text={openBrace + closeBrace} />
        {comma && <Token kind="punct" text="," />}
      </div>
    );
  }

  return (
    <div>
      <div className="jv-row jv-clickable" onClick={() => setOpen((o) => !o)}>
        <span className={`jv-caret ${open ? "open" : ""}`}>▶</span>
        {keyTokens}
        <Token kind="punct" text={openBrace} />
        {!open && (
          <>
            <span className="jv-summary">{count} 项</span>
            <Token kind="punct" text={closeBrace} />
            {comma && <Token kind="punct" text="," />}
          </>
        )}
        <button className="jv-copy-path" onClick={copyPath} title={`复制路径 ${path}`}>
          ⧉
        </button>
      </div>
      {open && (
        <>
          {/* Indentation comes from this wrapper rather than a depth-derived
            * padding on every row. That switch is what lets the nesting
            * guide-line render at all — a flat run of padded siblings has no
            * element spanning the subtree to hang the line on — and it drops
            * the per-row inline style object as a side benefit. */}
          <div className="jv-children">
            {entries.map(([k, v], i) => (
              <JsonNode
                key={k}
                name={Array.isArray(value) ? undefined : k}
                value={v}
                depth={depth + 1}
                comma={i < count - 1}
                query={query}
                force={force}
                path={Array.isArray(value) ? `${path}[${k}]` : `${path}.${k}`}
              />
            ))}
          </div>
          <div className="jv-row">
            <Token kind="punct" text={closeBrace} />
            {comma && <Token kind="punct" text="," />}
          </div>
        </>
      )}
    </div>
  );
}

/** Counts case-insensitive occurrences of `query` across every key and scalar
 *  value, so the toolbar can report "N 处匹配" honestly instead of guessing. */
function countMatches(value: Json, query: string): number {
  if (!query) return 0;
  const q = query.toLowerCase();
  const hits = (s: string): number => {
    // Lowercase once per string, not once per iteration — this walks every
    // key and scalar in the document.
    const low = s.toLowerCase();
    let n = 0;
    let from = 0;
    let at = low.indexOf(q, from);
    while (at >= 0) {
      n += 1;
      from = at + q.length;
      at = low.indexOf(q, from);
    }
    return n;
  };
  const walk = (v: Json): number => {
    if (v === null) return hits("null");
    if (Array.isArray(v)) return v.reduce<number>((acc, x) => acc + walk(x), 0);
    if (typeof v === "object") {
      return Object.entries(v).reduce<number>(
        (acc, [k, x]) => acc + hits(k) + walk(x),
        0
      );
    }
    return hits(String(v));
  };
  return walk(value);
}

interface JsonViewProps {
  data: Json;
  /** Show the expand/collapse/search toolbar. */
  toolbar?: boolean;
  /** Show a line-number gutter. */
  lineNumbers?: boolean;
}

/** Collapsible, colorized JSON tree. */
export function JsonView({ data, toolbar = false, lineNumbers = false }: JsonViewProps) {
  const [query, setQuery] = useState("");
  // Single piece of state: `[generation, open]`. It was briefly two (`gen` plus
  // `force`), updated by calling `setForce` inside the `setGen` updater — an
  // impure updater that StrictMode's double-invoke would desynchronize.
  const [force, setForce] = useState<[number, boolean] | undefined>(undefined);

  const setAll = useCallback((open: boolean) => {
    setForce((prev) => [(prev?.[0] ?? 0) + 1, open]);
  }, []);

  const matches = useMemo(() => countMatches(data, query), [data, query]);

  const tree = (
    <div className={`json-view${lineNumbers ? " jv-numbered" : ""}`}>
      <JsonNode value={data} depth={0} comma={false} query={query} force={force} path="$" />
    </div>
  );

  if (!toolbar) return tree;

  return (
    <div>
      <div className="jv-toolbar">
        <button className="jv-tool-btn" onClick={() => setAll(true)}>展开全部</button>
        <button className="jv-tool-btn" onClick={() => setAll(false)}>折叠全部</button>
        <input
          className="jv-search"
          placeholder="搜索键或值…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {query && (
          <span className="jv-search-count">
            {matches > 0 ? `${matches} 处匹配` : "无匹配"}
          </span>
        )}
      </div>
      {tree}
    </div>
  );
}

/** Colorized view for a raw body string: renders a JSON tree when the payload
 *  really is JSON, and falls back to readable pre-wrapped text otherwise. */
export function BodyView({ body }: { body: string | null }) {
  const parsed = useMemo(() => (body === null ? null : tryParseJson(body)), [body]);

  if (body === null) return <div className="jv-empty">— 无内容 —</div>;
  if (body.trim() === "") return <div className="jv-empty">— 空响应 —</div>;
  if (parsed && parsed.ok) return <JsonView data={parsed.value} />;
  return <pre className="jv-raw">{body}</pre>;
}
