import { useState, useMemo, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./App.css";
import "./ToolsApp.css";

/* =============================================================
 * Theme hook (shared with App.tsx / NotesApp.tsx pattern)
 * Reads "easy-copy-theme" from localStorage, syncs across windows
 * via storage + focus events, sets html[data-theme] attribute.
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
      if (e.key === "easy-copy-theme" && e.newValue) {
        setThemeMode(e.newValue as any);
      }
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
 * Timestamp Tab
 * ============================================================= */

function pad(n: number, w = 2) {
  return String(n).padStart(w, "0");
}

function TimestampTab() {
  const [now, setNow] = useState(Date.now());
  const [epochInput, setEpochInput] = useState("");
  const [dateInput, setDateInput] = useState("");

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const nowDate = new Date(now);

  const epochResult = useMemo(() => {
    if (!epochInput.trim()) return null;
    const n = Number(epochInput.trim());
    if (isNaN(n)) return { error: "Invalid number" };
    // Auto-detect seconds vs milliseconds
    const ms = n < 1e12 ? n * 1000 : n;
    const d = new Date(ms);
    if (isNaN(d.getTime())) return { error: "Invalid date" };
    return {
      iso: d.toISOString(),
      local: d.toLocaleString(),
      utc: d.toUTCString(),
      relative: d.getTime() > Date.now() ? "future" : "past",
      ms: ms,
    };
  }, [epochInput]);

  const dateResult = useMemo(() => {
    if (!dateInput.trim()) return null;
    const d = new Date(dateInput.trim());
    if (isNaN(d.getTime())) return { error: "Invalid date" };
    return {
      seconds: Math.floor(d.getTime() / 1000),
      milliseconds: d.getTime(),
      iso: d.toISOString(),
    };
  }, [dateInput]);

  const copy = (text: string, _label: string) => {
    navigator.clipboard.writeText(text);
  };

  return (
    <div className="tools-tab-content">
      <div className="tools-section">
        <h3>Current Time</h3>
        <div className="tools-output-group">
          <div className="tools-output-row">
            <span className="tools-label">Unix (s)</span>
            <code className="tools-code">{Math.floor(now / 1000)}</code>
            <button className="copy-btn" onClick={() => copy(String(Math.floor(now / 1000)), "epoch")}>Copy</button>
          </div>
          <div className="tools-output-row">
            <span className="tools-label">Unix (ms)</span>
            <code className="tools-code">{now}</code>
            <button className="copy-btn" onClick={() => copy(String(now), "epoch")}>Copy</button>
          </div>
          <div className="tools-output-row">
            <span className="tools-label">ISO 8601</span>
            <code className="tools-code">{nowDate.toISOString()}</code>
            <button className="copy-btn" onClick={() => copy(nowDate.toISOString(), "iso")}>Copy</button>
          </div>
          <div className="tools-output-row">
            <span className="tools-label">Local</span>
            <code className="tools-code">{nowDate.toLocaleString()}</code>
          </div>
        </div>
      </div>

      <div className="tools-section">
        <h3>Epoch → Date</h3>
        <input
          className="tools-input"
          placeholder="Enter Unix timestamp (s or ms)…"
          value={epochInput}
          onChange={(e) => setEpochInput(e.target.value)}
        />
        {epochResult && !epochResult.error && (
          <div className="tools-output-group">
            <div className="tools-output-row">
              <span className="tools-label">ISO</span>
              <code className="tools-code">{epochResult.iso}</code>
              <button className="copy-btn" onClick={() => copy(epochResult.iso!, "iso")}>Copy</button>
            </div>
            <div className="tools-output-row">
              <span className="tools-label">Local</span>
              <code className="tools-code">{epochResult.local}</code>
            </div>
            <div className="tools-output-row">
              <span className="tools-label">UTC</span>
              <code className="tools-code">{epochResult.utc}</code>
            </div>
          </div>
        )}
        {epochResult?.error && <p className="tools-error">{epochResult.error}</p>}
      </div>

      <div className="tools-section">
        <h3>Date → Epoch</h3>
        <input
          className="tools-input"
          placeholder="e.g. 2024-01-15T10:30:00Z  or  2024/01/15 10:30:00"
          value={dateInput}
          onChange={(e) => setDateInput(e.target.value)}
        />
        {dateResult && !dateResult.error && (
          <div className="tools-output-group">
            <div className="tools-output-row">
              <span className="tools-label">Seconds</span>
              <code className="tools-code">{dateResult.seconds}</code>
              <button className="copy-btn" onClick={() => copy(String(dateResult.seconds), "epoch")}>Copy</button>
            </div>
            <div className="tools-output-row">
              <span className="tools-label">Millis</span>
              <code className="tools-code">{dateResult.milliseconds}</code>
              <button className="copy-btn" onClick={() => copy(String(dateResult.milliseconds), "epoch")}>Copy</button>
            </div>
            <div className="tools-output-row">
              <span className="tools-label">ISO</span>
              <code className="tools-code">{dateResult.iso}</code>
            </div>
          </div>
        )}
        {dateResult?.error && <p className="tools-error">{dateResult.error}</p>}
      </div>
    </div>
  );
}

/* =============================================================
 * Cron Tab
 * ============================================================= */

const CRON_FIELDS = ["min", "hour", "dom", "mon", "dow"];
const CRON_FIELD_NAMES = ["Minute", "Hour", "Day of Month", "Month", "Day of Week"];
const CRON_RANGES: [number, number][] = [
  [0, 59],   // min
  [0, 23],   // hour
  [1, 31],   // dom
  [1, 12],   // mon
  [0, 6],    // dow (0=Sun … 6=Sat)
];

const DOW_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON_NAMES = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const CRON_PRESETS: [string, [string, string, string, string, string]][] = [
  ["Every minute",       ["*", "*", "*", "*", "*"]],
  ["Every 5 min",         ["*/5", "*", "*", "*", "*"]],
  ["Every 15 min",        ["*/15", "*", "*", "*", "*"]],
  ["Every hour",          ["0", "*", "*", "*", "*"]],
  ["Daily 9:00",          ["0", "9", "*", "*", "*"]],
  ["Weekdays 9:00",       ["0", "9", "*", "*", "1-5"]],
  ["Weekly Mon 9:00",     ["0", "9", "*", "*", "1"]],
  ["Monthly 1st 00:00",   ["0", "0", "1", "*", "*"]],
];

function parseCronField(field: string, range: [number, number]): Set<number> | null {
  const result = new Set<number>();
  const parts = field.split(",");
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed === "*") {
      for (let i = range[0]; i <= range[1]; i++) result.add(i);
      continue;
    }
    // */n
    const stepMatch = trimmed.match(/^\*\/(-?\d+)$/);
    if (stepMatch) {
      const step = parseInt(stepMatch[1], 10);
      if (step <= 0) return null;
      for (let i = range[0]; i <= range[1]; i += step) result.add(i);
      continue;
    }
    // n-m/step or n-m
    const rangeMatch = trimmed.match(/^(\d+)-(\d+)(?:\/(\d+))?$/);
    if (rangeMatch) {
      let lo = parseInt(rangeMatch[1], 10);
      let hi = parseInt(rangeMatch[2], 10);
      const step = rangeMatch[3] ? parseInt(rangeMatch[3], 10) : 1;
      if (lo < range[0] || hi > range[1] || lo > hi) return null;
      for (let i = lo; i <= hi; i += step) result.add(i);
      continue;
    }
    // single value
    const singleMatch = trimmed.match(/^(\d+)$/);
    if (singleMatch) {
      const v = parseInt(singleMatch[1], 10);
      if (v < range[0] || v > range[1]) return null;
      result.add(v);
      continue;
    }
    return null; // invalid syntax
  }
  return result.size > 0 ? result : null;
}

function describeCron(fields: string[]): string {
  const [minS, hourS, domS, monS, dowS] = fields;
  const parts: string[] = [];

  if (minS === "*" && hourS === "*") {
    parts.push("Every minute");
  } else if (minS.startsWith("*/")) {
    parts.push(`Every ${minS.slice(2)} minutes`);
    if (hourS !== "*") parts.push(`at hour ${hourS}`);
  } else if (hourS === "*") {
    parts.push(`Minute ${minS} of every hour`);
  } else {
    parts.push(`At ${pad(parseInt(hourS, 10))}:${pad(parseInt(minS, 10))}`);
  }

  if (dowS !== "*") {
    if (dowS === "1-5") parts.push("on weekdays (Mon–Fri)");
    else if (dowS === "0,6") parts.push("on weekends (Sat–Sun)");
    else {
      const days = Array.from(parseCronField(dowS, [0, 6]) ?? []).map((d) => DOW_NAMES[d]).join(", ");
      parts.push(`on ${days}`);
    }
  }

  if (domS !== "*" && monS !== "*") {
    const mons = Array.from(parseCronField(monS, [1, 12]) ?? []).map((m) => MON_NAMES[m]).join(", ");
    parts.push(`on day ${domS} of ${mons}`);
  } else if (domS !== "*") {
    parts.push(`on day ${domS} of every month`);
  } else if (monS !== "*") {
    const mons = Array.from(parseCronField(monS, [1, 12]) ?? []).map((m) => MON_NAMES[m]).join(", ");
    parts.push(`in ${mons}`);
  }

  return parts.join(" ");
}

function cronNextTimes(fields: string[], count: number): Date[] | string {
  const sets = [
    parseCronField(fields[0], CRON_RANGES[0]),
    parseCronField(fields[1], CRON_RANGES[1]),
    parseCronField(fields[2], CRON_RANGES[2]),
    parseCronField(fields[3], CRON_RANGES[3]),
    parseCronField(fields[4], CRON_RANGES[4]),
  ];
  if (sets.some((s) => s === null)) return "Invalid cron expression";
  const [mins, hours, doms, mons, dows] = sets as Set<number>[];

  const result: Date[] = [];
  const start = new Date();
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1); // start from next minute

  const maxIter = 500000; // safety limit (~1 year of minutes)
  let iter = 0;
  const cursor = new Date(start);

  while (result.length < count && iter < maxIter) {
    iter++;
    if (!mins.has(cursor.getMinutes())) {
      cursor.setMinutes(cursor.getMinutes() + 1);
      continue;
    }
    if (!hours.has(cursor.getHours())) {
      cursor.setMinutes(cursor.getMinutes() + 1);
      continue;
    }
    if (!doms.has(cursor.getDate())) {
      cursor.setDate(cursor.getDate() + 1);
      cursor.setHours(0, 0, 0, 0);
      continue;
    }
    if (!mons.has(cursor.getMonth() + 1)) {
      cursor.setMonth(cursor.getMonth() + 1, 1);
      cursor.setHours(0, 0, 0, 0);
      continue;
    }
    if (!dows.has(cursor.getDay())) {
      cursor.setDate(cursor.getDate() + 1);
      cursor.setHours(0, 0, 0, 0);
      continue;
    }
    result.push(new Date(cursor));
    cursor.setMinutes(cursor.getMinutes() + 1);
  }

  if (result.length === 0) return "No future execution found";
  return result;
}

function CronTab() {
  const [fields, setFields] = useState<string[]>(["*/5", "*", "*", "*", "*"]);

  const valid = useMemo(() => {
    return fields.every((f, i) => parseCronField(f, CRON_RANGES[i]) !== null);
  }, [fields]);

  const description = useMemo(() => {
    if (!valid) return "Invalid expression";
    return describeCron(fields);
  }, [fields, valid]);

  const nextTimes = useMemo(() => {
    if (!valid) return null;
    return cronNextTimes(fields, 5);
  }, [fields, valid]);

  return (
    <div className="tools-tab-content">
      <div className="tools-section">
        <h3>Cron Expression</h3>
        <div className="cron-fields">
          {CRON_FIELDS.map((f, i) => (
            <div key={f} className="cron-field">
              <label>{CRON_FIELD_NAMES[i]}</label>
              <input
                className={`tools-input cron-input ${valid ? "" : "invalid"}`}
                value={fields[i]}
                onChange={(e) => {
                  const next = [...fields];
                  next[i] = e.target.value;
                  setFields(next);
                }}
              />
            </div>
          ))}
        </div>

        <div className="cron-presets">
          {CRON_PRESETS.map(([label, preset]) => (
            <button
              key={label}
              className="cron-preset-btn"
              onClick={() => setFields(preset)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="tools-section">
        <h3>Description</h3>
        <div className="cron-description">
          {valid ? "✅ " : "❌ "}{description}
        </div>
        <div className="cron-expression">
          <code className="tools-code">
            {fields[0]} {fields[1]} {fields[2]} {fields[3]} {fields[4]}
          </code>
        </div>
      </div>

      <div className="tools-section">
        <h3>Next 5 Executions</h3>
        {nextTimes && typeof nextTimes === "string" && (
          <p className="tools-error">{nextTimes}</p>
        )}
        {nextTimes && Array.isArray(nextTimes) && (
          <div className="tools-output-group">
            {nextTimes.map((d, i) => (
              <div key={i} className="tools-output-row">
                <span className="tools-label">#{i + 1}</span>
                <code className="tools-code">{d.toLocaleString()}</code>
                <span className="tools-sub">{d.toISOString()}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* =============================================================
 * Regex Tab
 * ============================================================= */

const REGEX_PRESETS: [string, string, string][] = [
  ["Email",      "^[\\w.+-]+@[\\w.-]+\\.[a-zA-Z]{2,}$", "gim"],
  ["URL",        "https?://[\\w.-]+(?:/[\\w./?=-]*)?", "gm"],
  ["IPv4",       "\\b(?:\d{1,3}\.){3}\d{1,3}\\b", "g"],
  ["Phone",      "\\b\d{3}[-.]?\d{3}[-.]?\d{4}\\b", "g"],
  ["Date ISO",   "\\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}", "g"],
  ["Hex Color",  "#[0-9a-fA-F]{6}\\b", "g"],
];

interface MatchInfo {
  index: number;
  matched: string;
  groups: string[];
}

function RegexTab() {
  const [pattern, setPattern] = useState("\\b\\w+@\\w+\\.\\w+\\b");
  const [flags, setFlags] = useState("g");
  const [testStr, setTestStr] = useState("Contact: alice@example.com or bob@test.org for info.\nAlso reach admin@site.co.uk");

  const { error, matches, highlighted } = useMemo(() => {
    if (!pattern) return { error: null, matches: [], highlighted: testStr };
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, flags);
    } catch (e) {
      return { error: String(e).replace(/\n.*/s, ""), matches: [], highlighted: testStr };
    }

    if (!flags.includes("g")) {
      // Single match mode
      const m = regex.exec(testStr);
      if (!m) return { error: null, matches: [], highlighted: testStr };
      const info: MatchInfo = {
        index: m.index,
        matched: m[0],
        groups: m.slice(1).filter((g) => g !== undefined),
      };
      const before = testStr.slice(0, m.index);
      const after = testStr.slice(m.index + m[0].length);
      return {
        error: null,
        matches: [info],
        highlighted: `${before}<mark class="regex-match">${escapeHtml(m[0])}</mark>${after}`,
      };
    }

    // Global match mode
    const allMatches: MatchInfo[] = [];
    let m: RegExpExecArray | null;
    let lastIndex = 0;
    let html = "";
    while ((m = regex.exec(testStr)) !== null) {
      allMatches.push({
        index: m.index,
        matched: m[0],
        groups: m.slice(1).filter((g) => g !== undefined),
      });
      html += escapeHtml(testStr.slice(lastIndex, m.index));
      html += `<mark class="regex-match">${escapeHtml(m[0])}</mark>`;
      lastIndex = m.index + m[0].length;
      if (m[0] === "") regex.lastIndex++; // avoid infinite loop on zero-width match
    }
    html += escapeHtml(testStr.slice(lastIndex));
    return { error: null, matches: allMatches, highlighted: html };
  }, [pattern, flags, testStr]);

  return (
    <div className="tools-tab-content">
      <div className="tools-section">
        <h3>Pattern</h3>
        <div className="regex-input-row">
          <span className="regex-slash">/</span>
          <input
            className="tools-input regex-pattern-input"
            value={pattern}
            onChange={(e) => setPattern(e.target.value)}
            placeholder="Enter regex pattern…"
          />
          <span className="regex-slash">/</span>
          <input
            className="tools-input regex-flags-input"
            value={flags}
            onChange={(e) => setFlags(e.target.value.replace(/[^gimsuy]/g, ""))}
            placeholder="flags"
          />
        </div>
        <div className="regex-flags-hint">
          g=global · i=case-insensitive · m=multiline · s=. matches newline · u=unicode · y=sticky
        </div>
        {error && <p className="tools-error">{error}</p>}

        <div className="cron-presets">
          {REGEX_PRESETS.map(([label, pat, fl]) => (
            <button
              key={label}
              className="cron-preset-btn"
              onClick={() => {
                setPattern(pat);
                setFlags(fl);
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="tools-section">
        <h3>Test String</h3>
        <textarea
          className="tools-textarea"
          value={testStr}
          onChange={(e) => setTestStr(e.target.value)}
          spellCheck={false}
          rows={5}
        />
      </div>

      <div className="tools-section">
        <h3>Matches ({matches.length})</h3>
        {matches.length === 0 && !error && (
          <p className="tools-hint">No matches found.</p>
        )}
        {matches.length > 0 && (
          <div className="regex-match-list">
            {matches.map((m, i) => (
              <div key={i} className="regex-match-item">
                <div className="regex-match-header">
                  <span className="tools-label">#{i + 1}</span>
                  <code className="tools-code">"{m.matched}"</code>
                  <span className="tools-sub">at index {m.index}</span>
                </div>
                {m.groups.length > 0 && (
                  <div className="regex-groups">
                    {m.groups.map((g, gi) => (
                      <span key={gi} className="regex-group">
                        ${gi + 1}: "{g}"
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="tools-section">
        <h3>Highlighted</h3>
        <pre
          className="regex-highlighted"
          dangerouslySetInnerHTML={{ __html: highlighted || escapeHtml(testStr) }}
        />
      </div>
    </div>
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/* =============================================================
 * IP Lookup Tab
 * ============================================================= */

interface IpInfo {
  ip: string;
  city?: string;
  region?: string;
  country?: string;
  country_name?: string;
  postal?: string;
  latitude?: number;
  longitude?: number;
  timezone?: string;
  org?: string;
  asn?: string;
  [k: string]: any;
}

function IpTab() {
  const [myIp, setMyIp] = useState("");
  const [queryInput, setQueryInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<IpInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Fetch my own IP on mount via the Rust backend (avoids WebView CSP / net
  // permission issues that break `fetch` in a packaged build).
  useEffect(() => {
    (async () => {
      try {
        const data = await invoke<IpInfo>("ip_lookup", { target: null });
        setMyIp(data.ip || "");
      } catch {
        // silent fail
      }
    })();
  }, []);

  const doLookup = async (ip?: string) => {
    const target = (ip || queryInput).trim();
    if (!target) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const data = await invoke<IpInfo>("ip_lookup", { target });
      if ((data as any).error) {
        setError((data as any).reason || (data as any).message || "Lookup failed");
      } else {
        setResult(data);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const copy = (text: string) => navigator.clipboard.writeText(text);

  const resultRows: { label: string; value: string }[] = result
    ? [
        { label: "IP", value: result.ip || "-" },
        { label: "City", value: result.city || "-" },
        { label: "Region", value: result.region || "-" },
        { label: "Country", value: result.country_name ? `${result.country_name} (${result.country || ""})` : "-" },
        { label: "Postal", value: result.postal || "-" },
        { label: "Latitude", value: result.latitude != null ? String(result.latitude) : "-" },
        { label: "Longitude", value: result.longitude != null ? String(result.longitude) : "-" },
        { label: "Timezone", value: result.timezone || "-" },
        { label: "Org", value: result.org || "-" },
        { label: "ASN", value: result.asn || "-" },
      ]
    : [];

  return (
    <div className="tools-tab-content">
      <div className="tools-section">
        <h3>Your IP</h3>
        <div className="tools-output-row">
          <span className="tools-label">IP</span>
          <code className="tools-code">{myIp || "Loading…"}</code>
          {myIp && (
            <button className="copy-btn" onClick={() => copy(myIp)}>Copy</button>
          )}
          {myIp && (
            <button className="copy-btn" onClick={() => { setQueryInput(myIp); doLookup(myIp); }}>Lookup ↗</button>
          )}
        </div>
      </div>

      <div className="tools-section">
        <h3>IP Lookup</h3>
        <div className="ip-query-row">
          <input
            className="tools-input"
            placeholder="Enter IP or domain…"
            value={queryInput}
            onChange={(e) => setQueryInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") doLookup(); }}
          />
          <button
            className="ip-lookup-btn"
            disabled={loading || !queryInput.trim()}
            onClick={() => doLookup()}
          >
            {loading ? "…" : "Lookup"}
          </button>
        </div>
        {error && <p className="tools-error">{error}</p>}
      </div>

      {result && (
        <div className="tools-section">
          <h3>Result</h3>
          <div className="tools-output-group">
            {resultRows.map((r) => (
              <div className="tools-output-row" key={r.label}>
                <span className="tools-label">{r.label}</span>
                <code className="tools-code">{r.value}</code>
                {r.value !== "-" && (
                  <button className="copy-btn" onClick={() => copy(r.value)}>Copy</button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* =============================================================
 * Main
 * ============================================================= */

type Tab = "timestamp" | "cron" | "regex" | "ip";

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: "timestamp", label: "Timestamp", icon: "🕐" },
  { id: "cron",      label: "Cron",      icon: "⚙️" },
  { id: "regex",     label: "Regex",     icon: "🔍" },
  { id: "ip",        label: "IP Lookup", icon: "🌐" },
];

export default function ToolsApp() {
  useTheme();
  const [tab, setTab] = useState<Tab>("timestamp");

  // Intercept window close: hide instead of destroy so it can be reopened
  useEffect(() => {
    const win = getCurrentWindow();
    const unlisten = win.onCloseRequested((event) => {
      event.preventDefault();
      win.hide();
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  return (
    <div className="tools-app">
      <div className="tools-tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`tools-tab ${tab === t.id ? "active" : ""}`}
            onClick={() => setTab(t.id)}
          >
            <span className="tools-tab-icon">{t.icon}</span>
            <span>{t.label}</span>
          </button>
        ))}
      </div>
      <div className="tools-content">
        {tab === "timestamp" && <TimestampTab />}
        {tab === "cron" && <CronTab />}
        {tab === "regex" && <RegexTab />}
        {tab === "ip" && <IpTab />}
      </div>
    </div>
  );
}
