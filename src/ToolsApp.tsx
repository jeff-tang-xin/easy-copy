import { useState, useMemo, useEffect } from "react";
import type { Dispatch, SetStateAction } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { BodyView } from "./JsonView";
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

// Two modes: 5-field (standard Unix cron) and 6-field (with seconds, Quartz-style)
type CronMode = "5field" | "6field";

interface CronConfig {
  fields: string[];
  fieldNames: string[];
  ranges: [number, number][];
  presets: [string, string[]][];
}

const CRON_CONFIGS: Record<CronMode, CronConfig> = {
  "5field": {
    fields: ["min", "hour", "dom", "mon", "dow"],
    fieldNames: ["Minute", "Hour", "Day of Month", "Month", "Day of Week"],
    ranges: [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]],
    presets: [
      ["Every minute",       ["*", "*", "*", "*", "*"]],
      ["Every 5 min",         ["*/5", "*", "*", "*", "*"]],
      ["Every 15 min",        ["*/15", "*", "*", "*", "*"]],
      ["Every hour",          ["0", "*", "*", "*", "*"]],
      ["Daily 9:00",          ["0", "9", "*", "*", "*"]],
      ["Weekdays 9:00",       ["0", "9", "*", "*", "1-5"]],
      ["Weekly Mon 9:00",     ["0", "9", "*", "*", "1"]],
      ["Monthly 1st 00:00",   ["0", "0", "1", "*", "*"]],
    ],
  },
  "6field": {
    fields: ["sec", "min", "hour", "dom", "mon", "dow"],
    fieldNames: ["Second", "Minute", "Hour", "Day of Month", "Month", "Day of Week"],
    ranges: [[0, 59], [0, 59], [0, 23], [1, 31], [1, 12], [0, 6]],
    presets: [
      ["Every 10 sec",       ["*/10", "*", "*", "*", "*", "*"]],
      ["Every 30 sec",       ["*/30", "*", "*", "*", "*", "*"]],
      ["Every sec",           ["*", "*", "*", "*", "*", "*"]],
      ["Every 5 sec",         ["*/5", "*", "*", "*", "*", "*"]],
      ["Daily 9:00:00",       ["0", "0", "9", "*", "*", "*"]],
      ["Weekdays 9:00:00",    ["0", "0", "9", "*", "*", "1-5"]],
      ["Hourly at :00:30",   ["30", "0", "*", "*", "*", "*"]],
      ["Monthly 1st 00:00:00", ["0", "0", "0", "1", "*", "*"]],
    ],
  },
};

const DOW_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON_NAMES = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function parseCronField(field: string, range: [number, number]): Set<number> | null {
  const result = new Set<number>();
  const parts = field.split(",");
  for (const part of parts) {
    const trimmed = part.trim();
    // "*" or "?" (Quartz no-specific-value, treated as wildcard)
    if (trimmed === "*" || trimmed === "?") {
      for (let i = range[0]; i <= range[1]; i++) result.add(i);
      continue;
    }
    // */n  or  ?/n
    const stepMatch = trimmed.match(/^[*?]\/(\d+)$/);
    if (stepMatch) {
      const step = parseInt(stepMatch[1], 10);
      if (step <= 0) return null;
      for (let i = range[0]; i <= range[1]; i += step) result.add(i);
      continue;
    }
    // n/step  (e.g. "0/5" -> from n to range max, every step)
    const baseStepMatch = trimmed.match(/^(\d+)\/(\d+)$/);
    if (baseStepMatch) {
      const lo = parseInt(baseStepMatch[1], 10);
      const step = parseInt(baseStepMatch[2], 10);
      if (step <= 0 || lo < range[0] || lo > range[1]) return null;
      for (let i = lo; i <= range[1]; i += step) result.add(i);
      continue;
    }
    // n-m/step or n-m
    const rangeMatch = trimmed.match(/^(\d+)-(\d+)(?:\/(\d+))?$/);
    if (rangeMatch) {
      const lo = parseInt(rangeMatch[1], 10);
      const hi = parseInt(rangeMatch[2], 10);
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

function describeCron(fields: string[], hasSeconds: boolean): string {
  // Treat "?" (Quartz no-specific-value) as "*" for description purposes
  const f = fields.map((s) => (s === "?" ? "*" : s));
  // 6-field: [sec, min, hour, dom, mon, dow]; 5-field: [min, hour, dom, mon, dow]
  const offset = hasSeconds ? 1 : 0;
  const secS = hasSeconds ? f[0] : undefined;
  const [minS, hourS, domS, monS, dowS] = f.slice(offset, offset + 5);
  const parts: string[] = [];

  if (secS && secS !== "0" && secS !== "*") {
    if (secS.startsWith("*/")) {
      parts.push(`Every ${secS.slice(2)} seconds`);
    } else {
      parts.push(`At second ${secS}`);
    }
  } else if (secS === "*") {
    parts.push("Every second");
  }

  if (minS === "*" && hourS === "*") {
    if (!secS || secS === "0") parts.push("Every minute");
  } else if (minS.startsWith("*/")) {
    parts.push(`Every ${minS.slice(2)} minutes`);
    if (hourS !== "*") parts.push(`at hour ${hourS}`);
  } else if (hourS === "*") {
    parts.push(`Minute ${minS} of every hour`);
  } else {
    parts.push(`At ${pad(parseInt(hourS, 10))}:${pad(parseInt(minS, 10))}${secS && secS !== "0" ? `:${pad(parseInt(secS, 10))}` : ""}`);
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

function cronNextTimes(fields: string[], count: number, hasSeconds: boolean): Date[] | string {
  const ranges = CRON_CONFIGS[hasSeconds ? "6field" : "5field"].ranges;
  const sets = fields.map((f, i) => parseCronField(f, ranges[i]));
  if (sets.some((s) => s === null)) return "Invalid cron expression";

  if (hasSeconds) {
    const [secs, mins, hours, doms, mons, dows] = sets as Set<number>[];
    const result: Date[] = [];
    const start = new Date();
    start.setMilliseconds(0);
    start.setSeconds(start.getSeconds() + 1); // start from next second

    const maxIter = 5000000; // safety limit (~58 days of seconds)
    let iter = 0;
    const cursor = new Date(start);

    while (result.length < count && iter < maxIter) {
      iter++;
      if (!secs.has(cursor.getSeconds())) {
        cursor.setSeconds(cursor.getSeconds() + 1);
        continue;
      }
      if (!mins.has(cursor.getMinutes())) {
        cursor.setMinutes(cursor.getMinutes() + 1, 0);
        continue;
      }
      if (!hours.has(cursor.getHours())) {
        cursor.setHours(cursor.getHours() + 1, 0, 0);
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
      cursor.setSeconds(cursor.getSeconds() + 1);
    }

    if (result.length === 0) return "No future execution found";
    return result;
  }

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
      cursor.setHours(cursor.getHours() + 1, 0, 0);
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
  const [mode, setMode] = useState<CronMode>("5field");
  const cfg = CRON_CONFIGS[mode];
  const [fields, setFields] = useState<string[]>(cfg.presets[0][1]);

  const valid = useMemo(() => {
    return fields.length === cfg.ranges.length &&
      fields.every((f, i) => parseCronField(f, cfg.ranges[i]) !== null);
  }, [fields, cfg]);

  const description = useMemo(() => {
    if (!valid) return "Invalid expression";
    return describeCron(fields, mode === "6field");
  }, [fields, valid, mode]);

  const nextTimes = useMemo(() => {
    if (!valid) return null;
    return cronNextTimes(fields, 5, mode === "6field");
  }, [fields, valid, mode]);

  const switchMode = (m: CronMode) => {
    setMode(m);
    setFields(CRON_CONFIGS[m].presets[0][1]);
  };

  return (
    <div className="tools-tab-content">
      <div className="tools-section">
        <h3>Cron Expression</h3>
        <div className="cron-mode-switch">
          <button
            className={`cron-mode-btn ${mode === "5field" ? "active" : ""}`}
            onClick={() => switchMode("5field")}
          >
            5-Field (Standard)
          </button>
          <button
            className={`cron-mode-btn ${mode === "6field" ? "active" : ""}`}
            onClick={() => switchMode("6field")}
          >
            6-Field (with Seconds)
          </button>
        </div>
        <div className="cron-fields">
          {cfg.fields.map((f, i) => (
            <div key={f} className="cron-field">
              <label>{cfg.fieldNames[i]}</label>
              <input
                className={`tools-input cron-input ${valid ? "" : "invalid"}`}
                value={fields[i] ?? ""}
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
          {cfg.presets.map(([label, preset]) => (
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
            {fields.join(" ")}
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

interface ProxyRoute {
  id: string;
  path_prefix: string;
  target: string;
  enabled: boolean;
}

interface ProxyLog {
  id: string;
  timestamp: number;
  method: string;
  url: string;
  route_match: string | null;
  status: number;
  duration_ms: number;
  request_headers: [string, string][];
  request_body: string | null;
  response_headers: [string, string][];
  response_body: string | null;
  error: string | null;
}

interface ProxyConfig {
  default_target: string;
  port: number;
  running: boolean;
  routes: ProxyRoute[];
}

interface ProxyState {
  port: number;
  isRunning: boolean;
  defaultTarget: string;
  routes: ProxyRoute[];
  logs: string[];
  requestLogs: ProxyLog[];
}

function ProxyTab({
  state,
  setState,
}: {
  state: ProxyState;
  setState: Dispatch<SetStateAction<ProxyState>>;
}) {
  const { port, isRunning, defaultTarget, routes, logs, requestLogs } = state;
  const [newPrefix, setNewPrefix] = useState("");
  const [newTarget, setNewTarget] = useState("");
  const [selectedLog, setSelectedLog] = useState<ProxyLog | null>(null);

  const pushLog = (msg: string) =>
    setState((s) => ({
      ...s,
      logs: [`[${new Date().toLocaleTimeString()}] ${msg}`, ...s.logs],
    }));

  // Sync from backend whenever this tab mounts, so the UI reflects the real
  // proxy state even after switching panels (which unmounts the component).
  useEffect(() => {
    (async () => {
      try {
        const cfg = await invoke<ProxyConfig>("get_proxy_status");
        setState((s) => ({
          ...s,
          port: cfg.port,
          isRunning: cfg.running,
          defaultTarget: cfg.default_target,
          routes: cfg.routes,
        }));
      } catch {
        // silent
      }
    })();
  }, []);

  // Poll proxy logs every 2 seconds so new entries appear automatically.
  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const logs = await invoke<ProxyLog[]>("get_proxy_logs");
        setState((s) => ({ ...s, requestLogs: logs }));
      } catch {
        // silent
      }
    }, 2000);
    return () => clearInterval(interval);
  }, []);

  const toggleServer = async () => {
    try {
      await invoke(isRunning ? "stop_proxy" : "start_proxy", { port });
      setState((s) => ({ ...s, isRunning: !isRunning }));
      pushLog(`Proxy ${isRunning ? "stopped" : "started"} on port ${port}`);
    } catch (e) {
      pushLog(`Error: ${String(e)}`);
    }
  };

  const saveDefaultTarget = async (target: string) => {
    try {
      await invoke("set_proxy_default_target", { target });
    } catch (e) {
      pushLog(`Error saving default target: ${String(e)}`);
    }
  };

  const addRoute = async () => {
    const prefix = newPrefix.trim();
    const target = newTarget.trim();
    if (!prefix || !target) return;
    const route: ProxyRoute = {
      id: `route_${Date.now()}`,
      path_prefix: prefix,
      target,
      enabled: true,
    };
    try {
      await invoke("upsert_proxy_route", { route });
      setState((s) => ({ ...s, routes: [...s.routes, route] }));
      setNewPrefix("");
      setNewTarget("");
      pushLog(`Rule added: ${prefix} → ${target}`);
    } catch (e) {
      pushLog(`Error adding rule: ${String(e)}`);
    }
  };

  const removeRoute = async (id: string) => {
    try {
      await invoke("delete_proxy_route", { routeId: id });
      setState((s) => ({ ...s, routes: s.routes.filter((r) => r.id !== id) }));
    } catch (e) {
      pushLog(`Error removing rule: ${String(e)}`);
    }
  };

  const toggleRoute = async (id: string) => {
    try {
      await invoke("toggle_proxy_route", { routeId: id });
      setState((s) => ({
        ...s,
        routes: s.routes.map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r)),
      }));
    } catch (e) {
      pushLog(`Error toggling rule: ${String(e)}`);
    }
  };

  return (
    <div className="tools-tab-content">
      <div className="tools-section">
        <h3>Proxy Server</h3>
        <div className="ip-query-row">
          <input
            className="tools-input"
            type="number"
            placeholder="Port"
            value={port}
            disabled={isRunning}
            onChange={(e) => setState((s) => ({ ...s, port: Number(e.target.value) }))}
          />
          <button className={isRunning ? "stop-btn" : "start-btn"} onClick={toggleServer}>{isRunning ? "Stop Proxy" : "Start Proxy"}</button>
        </div>
        <p style={{ marginTop: "8px", fontSize: "13px", opacity: 0.8 }}>Status: {isRunning ? "Running" : "Stopped"}</p>
      </div>
      <div className="tools-section">
        <h3>Default Target</h3>
        <p style={{ fontSize: "13px", opacity: 0.7, marginBottom: "6px" }}>
          Requests matching no rule below are forwarded here.
        </p>
        <input
          className="tools-input"
          placeholder="http://localhost:8080"
          value={defaultTarget}
          onChange={(e) => setState((s) => ({ ...s, defaultTarget: e.target.value }))}
          onBlur={(e) => saveDefaultTarget(e.target.value.trim())}
        />
      </div>
      <div className="tools-section">
        <h3>Forwarding Rules</h3>
        <p style={{ fontSize: "13px", opacity: 0.7, marginBottom: "6px" }}>
          If a request path starts with the prefix it is forwarded to the target (nginx-style prefix match).
        </p>
        <div className="ip-query-row">
          <input className="tools-input" placeholder="Path prefix, e.g. /api" value={newPrefix} onChange={(e) => setNewPrefix(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") addRoute(); }} />
          <input className="tools-input" placeholder="Target, e.g. http://localhost:3000" value={newTarget} onChange={(e) => setNewTarget(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") addRoute(); }} />
          <button onClick={addRoute}>Add Rule</button>
        </div>
        <div style={{ marginTop: "12px" }}>
          {routes.map((route) => (
            <div key={route.id} className="tools-output-row" style={{ marginBottom: "4px", opacity: route.enabled ? 1 : 0.5 }}>
              <code className="tools-code">{route.path_prefix} → {route.target}</code>
              <button className="copy-btn" onClick={() => toggleRoute(route.id)}>{route.enabled ? "Disable" : "Enable"}</button>
              <button className="copy-btn" onClick={() => removeRoute(route.id)}>Remove</button>
            </div>
          ))}
          {routes.length === 0 && <p className="tools-hint">No rules configured</p>}
        </div>
      </div>
      <div className="tools-section">
        <h3>Request Logs</h3>
        <p className="tools-hint" style={{ marginBottom: "6px" }}>
          Click a request to inspect full request/response details.
        </p>
        <div className="req-log-list">
          {[...requestLogs].reverse().map((log) => {
            const statusClass =
              log.status >= 500 ? "err" : log.status >= 400 ? "warn" : log.status > 0 ? "ok" : "err";
            const selected = selectedLog?.id === log.id;
            return (
              <div
                key={log.id}
                onClick={() => setSelectedLog(log)}
                className={`req-log-row ${selected ? "selected" : ""}`}
                title={log.url}
              >
                <span className={`log-status ${statusClass}`}>{log.status || "ERR"}</span>
                <span className={`log-method m-${log.method.toLowerCase()}`}>{log.method}</span>
                <span className="req-log-url">{log.url}</span>
                {log.route_match && <span className="req-log-route">{log.route_match}</span>}
                <span className="req-log-dur">{log.duration_ms}ms</span>
              </div>
            );
          })}
          {requestLogs.length === 0 && <p className="tools-hint">No requests yet</p>}
        </div>
        {requestLogs.length > 0 && (
          <button
            className="copy-btn"
            style={{ marginTop: "8px" }}
            onClick={async () => {
              try {
                await invoke("clear_proxy_logs");
                setState((s) => ({ ...s, requestLogs: [] }));
              } catch (e) {
                pushLog(`Error clearing logs: ${String(e)}`);
              }
            }}
          >
            Clear Logs
          </button>
        )}
      </div>
      <div className="tools-section">
        <h3>Activity Log</h3>
        <div className="activity-log">
          {logs.map((log, i) => (
            <div className="activity-row" key={i}>{log}</div>
          ))}
          {logs.length === 0 && <p className="tools-hint">No activity yet</p>}
        </div>
      </div>

      {selectedLog && (
        <ProxyLogDetail log={selectedLog} onClose={() => setSelectedLog(null)} />
      )}
    </div>
  );
}

/** Header table — headers are key/value pairs, so a table beats a JSON blob. */
function HeaderTable({ rows }: { rows: [string, string][] }) {
  if (rows.length === 0) return <div className="jv-empty">— no headers —</div>;
  return (
    <div className="hdr-table">
      {rows.map(([k, v], i) => (
        <div className="hdr-row" key={`${k}-${i}`}>
          <span className="hdr-key">{k}</span>
          <span className="hdr-val">{v}</span>
        </div>
      ))}
    </div>
  );
}

type DetailTab = "overview" | "request" | "response";

/* Modal showing the full request/response detail for a single proxy log entry.
 * Split into tabs with syntax-highlighted bodies: the previous single <pre> of
 * JSON.stringify output rendered bodies as one-line escaped blobs, which is the
 * one thing you actually come here to read. */
function ProxyLogDetail({ log, onClose }: { log: ProxyLog; onClose: () => void }) {
  const [tab, setTab] = useState<DetailTab>("overview");

  const detail = {
    request: {
      method: log.method,
      url: log.url,
      route_match: log.route_match,
      headers: Object.fromEntries(log.request_headers),
      body: log.request_body,
    },
    response: {
      status: log.status,
      duration_ms: log.duration_ms,
      timestamp: new Date(log.timestamp).toISOString(),
      headers: Object.fromEntries(log.response_headers),
      body: log.response_body,
      error: log.error,
    },
  };
  const json = JSON.stringify(detail, null, 2);

  const statusClass =
    log.status >= 500 ? "err" : log.status >= 400 ? "warn" : log.status > 0 ? "ok" : "err";

  // Close on ESC — a modal that only closes by mouse is a papercut.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const bodyLabel = (b: string | null) => {
    if (b === null) return "";
    const bytes = new TextEncoder().encode(b).length;
    return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
  };

  return (
    <div className="log-modal-backdrop" onClick={onClose}>
      <div className="log-modal" onClick={(e) => e.stopPropagation()}>
        <div className="log-modal-head">
          <div className="log-modal-title">
            <span className={`log-status ${statusClass}`}>{log.status || "ERR"}</span>
            <span className="log-method">{log.method}</span>
            <span className="log-url" title={log.url}>{log.url}</span>
          </div>
          <div className="log-modal-actions">
            <button className="copy-btn" onClick={() => navigator.clipboard.writeText(json)}>
              Copy JSON
            </button>
            <button className="copy-btn" onClick={onClose}>Close</button>
          </div>
        </div>

        <div className="log-modal-tabs">
          {(["overview", "request", "response"] as DetailTab[]).map((t) => (
            <button
              key={t}
              className={`log-modal-tab ${tab === t ? "active" : ""}`}
              onClick={() => setTab(t)}
            >
              {t === "overview" ? "Overview" : t === "request" ? "Request" : "Response"}
            </button>
          ))}
        </div>

        <div className="log-modal-body">
          {tab === "overview" && (
            <div className="kv-grid">
              <div className="kv-k">Status</div>
              <div className="kv-v">
                <span className={`log-status ${statusClass}`}>{log.status || "ERR"}</span>
              </div>
              <div className="kv-k">Method</div>
              <div className="kv-v mono">{log.method}</div>
              <div className="kv-k">URL</div>
              <div className="kv-v mono breakable">{log.url}</div>
              <div className="kv-k">Route</div>
              <div className="kv-v mono">{log.route_match ?? <span className="jv-empty">default</span>}</div>
              <div className="kv-k">Duration</div>
              <div className="kv-v mono">{log.duration_ms} ms</div>
              <div className="kv-k">Time</div>
              <div className="kv-v mono">{new Date(log.timestamp).toLocaleString()}</div>
              {log.error && (
                <>
                  <div className="kv-k">Error</div>
                  <div className="kv-v log-error">{log.error}</div>
                </>
              )}
            </div>
          )}

          {tab === "request" && (
            <>
              <div className="log-block-title">
                Headers <span className="log-count">{log.request_headers.length}</span>
              </div>
              <HeaderTable rows={log.request_headers} />
              <div className="log-block-title">
                Body <span className="log-count">{bodyLabel(log.request_body)}</span>
              </div>
              <BodyView body={log.request_body} />
            </>
          )}

          {tab === "response" && (
            <>
              {log.error && <div className="log-error-banner">{log.error}</div>}
              <div className="log-block-title">
                Headers <span className="log-count">{log.response_headers.length}</span>
              </div>
              <HeaderTable rows={log.response_headers} />
              <div className="log-block-title">
                Body <span className="log-count">{bodyLabel(log.response_body)}</span>
              </div>
              <BodyView body={log.response_body} />
            </>
          )}
        </div>
      </div>
    </div>
  );
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

type Tab = "timestamp" | "cron" | "regex" | "ip" | "proxy";

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: "timestamp", label: "Timestamp", icon: "🕐" },
  { id: "cron",      label: "Cron",      icon: "⚙️" },
  { id: "regex",     label: "Regex",     icon: "🔍" },
  { id: "ip",        label: "IP Lookup", icon: "🌐" },
  { id: "proxy",     label: "Proxy",     icon: "🔀" },
];

export default function ToolsApp() {
  useTheme();
  const [tab, setTab] = useState<Tab>("timestamp");
  const [proxyState, setProxyState] = useState<ProxyState>({
    port: 10880,
    isRunning: false,
    defaultTarget: "http://localhost:8080",
    routes: [],
    logs: [],
    requestLogs: [],
  });

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

  // Sync proxy state from backend whenever the proxy tab is shown
  // (after switching away and back, the component gets remounted, so we
  // refresh from the real backend state).
  useEffect(() => {
    if (tab !== "proxy") return;
    (async () => {
      try {
        const cfg = await invoke<ProxyConfig>("get_proxy_status");
        setProxyState((s) => ({
          ...s,
          port: cfg.port,
          isRunning: cfg.running,
          defaultTarget: cfg.default_target,
          routes: cfg.routes,
        }));
      } catch {
        // silent
      }
    })();
  }, [tab]);

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
        {tab === "proxy" && <ProxyTab state={proxyState} setState={setProxyState} />}
      </div>
    </div>
  );
}
