/* =============================================================
 * Request-body format registry.
 *
 * WHY THIS EXISTS
 * ---------------
 * The body editor offers five raw languages (json / xml / javascript /
 * text / html) but the toolbar only ever knew how to handle JSON — it was
 * gated behind a literal `body_raw_lang === "json"` check, so picking XML
 * dropped you into a bare <textarea> with no beautify, no validation and
 * no tree.
 *
 * Adding the missing languages as more `if (lang === "xml")` branches
 * would have meant editing the same three places (format handler, status
 * pill, tree builder) for every language — textbook 霰弹式修改. Instead
 * each language now supplies its own capability object and the UI just
 * asks the registry what the current language can do
 * (以多态取代条件式). Adding a sixth language is one entry here and zero
 * changes to the components.
 * ============================================================= */

import { formatJsonText, parseJsonDetailed, type Json } from "../JsonView";
import { formatXml, minifyXml, validateXml } from "./formatXml";

/** Outcome of validating a body. Deliberately mirrors the shape the status
 *  pill renders so the component needs no per-language mapping. */
export type BodyCheck =
  | { state: "empty" }
  | { state: "valid" }
  /** `line: 0` means "position genuinely unknown" — see JsonView's locator
   *  notes. Callers must render the message alone rather than pointing at a
   *  line they can't vouch for. */
  | { state: "invalid"; message: string; line: number; column: number }
  /** The language has no validator (plain text, JS). Not an error state. */
  | { state: "unsupported" };

/** What a single raw language can do. A missing method means "not offered",
 *  which the toolbar reflects by hiding the control rather than showing a
 *  dead button. */
export interface BodyFormat {
  /** Label shown in the language bar. */
  readonly id: string;
  /** Re-indent with the given width. Absent ⇒ no beautify button. */
  readonly format?: (src: string, indent: number) => { ok: boolean; text: string };
  /** Collapse to a single line. Absent ⇒ no minify button. */
  readonly minify?: (src: string) => { ok: boolean; text: string };
  /** Syntax check. Absent ⇒ status pill reports "unsupported". */
  readonly validate?: (src: string) => BodyCheck;
  /** Build a collapsible tree. Absent ⇒ no tree view for this language. */
  readonly toTree?: (src: string) => Json | null;
  /** Monospace-highlighted? Drives the editor's font choice. */
  readonly mono: boolean;
}

/** Adapts JsonView's parse result into a `BodyCheck`. */
function checkJson(src: string): BodyCheck {
  const parsed = parseJsonDetailed(src);
  if (parsed.ok) return { state: "valid" };
  const { message, line, column } = parsed.error;
  return { state: "invalid", message, line, column };
}

/** Adapts the XML scanner's result into a `BodyCheck`. */
function checkXml(src: string, isHtml: boolean): BodyCheck {
  const res = validateXml(src, isHtml);
  if (res.ok) return { state: "valid" };
  return { state: "invalid", message: res.message, line: res.line, column: res.column };
}

/** `formatJsonText` reports failure as `{ ok: false, error }` with no `text`,
 *  while the registry contract promises `text` in both cases (so callers can
 *  apply the result unconditionally). Normalise here rather than loosening the
 *  interface: echoing the input back on failure is what makes the toolbar's
 *  "never corrupt the payload" guarantee hold. */
function jsonReformat(src: string, indent: number): { ok: boolean; text: string } {
  const res = formatJsonText(src, indent);
  return res.ok ? { ok: true, text: res.text } : { ok: false, text: src };
}

const JSON_FORMAT: BodyFormat = {
  id: "json",
  format: jsonReformat,
  minify: (src) => jsonReformat(src, 0),
  validate: checkJson,
  toTree: (src) => {
    const parsed = parseJsonDetailed(src);
    return parsed.ok ? parsed.value : null;
  },
  mono: true,
};

/** XML and HTML share the scanner; only void-element handling differs, so
 *  they're built from one factory instead of two near-identical literals
 *  (提取方法 over copy-paste). */
function makeMarkupFormat(id: string, isHtml: boolean): BodyFormat {
  return {
    id,
    format: (src, indent) => formatXml(src, indent, isHtml),
    minify: (src) => minifyXml(src, isHtml),
    validate: (src) => checkXml(src, isHtml),
    // No tree: a JSON tree is a faithful view of JSON's data model, but
    // markup carries attributes, mixed content and ordering that this
    // Json-shaped tree cannot represent without lying about the structure.
    mono: true,
  };
}

const TEXT_FORMAT: BodyFormat = { id: "text", mono: false };

/** JavaScript gets no formatter: pretty-printing JS properly needs a real
 *  parser (ASI, template literals, regex-vs-divide ambiguity), and a naive
 *  brace-indenter silently corrupts valid code. Better to offer nothing
 *  than something that mangles the payload. */
const JS_FORMAT: BodyFormat = { id: "javascript", mono: true };

const REGISTRY: Readonly<Record<string, BodyFormat>> = {
  json: JSON_FORMAT,
  xml: makeMarkupFormat("xml", false),
  html: makeMarkupFormat("html", true),
  javascript: JS_FORMAT,
  text: TEXT_FORMAT,
};

/** Languages offered in the raw-body language bar, in display order. */
export const RAW_LANGS = ["json", "xml", "html", "javascript", "text"] as const;

/** Looks up a language's capabilities, falling back to inert plain text for
 *  unknown values so a stale persisted request can never crash the editor. */
export function bodyFormatFor(lang: string | null | undefined): BodyFormat {
  return REGISTRY[lang || "json"] ?? TEXT_FORMAT;
}

/** Validates `src` through the given format, normalising the empty case once
 *  here rather than in every format implementation. */
export function checkBody(fmt: BodyFormat, src: string): BodyCheck {
  if (!src.trim()) return { state: "empty" };
  if (!fmt.validate) return { state: "unsupported" };
  return fmt.validate(src);
}
