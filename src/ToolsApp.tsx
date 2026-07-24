import { useState, useMemo, useEffect } from "react";
import type { Dispatch, SetStateAction } from "react";
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
          {routes.length === 0 && <p style={{ fontSize: "13px", opacity: 0.6 }}>No rules configured</p>}
        </div>
      </div>
      <div className="tools-section">
        <h3>Request Logs</h3>
        <p style={{ fontSize: "13px", opacity: 0.7, marginBottom: "6px" }}>
          Click a request to inspect full request/response details.
        </p>
        <div style={{ maxHeight: "260px", overflowY: "auto", fontFamily: "monospace", fontSize: "12px" }}>
          {[...requestLogs].reverse().map((log) => {
            const statusColor =
              log.status >= 500 ? "#e5484d" : log.status >= 400 ? "#f5a623" : "#30a46c";
            return (
              <div
                key={log.id}
                onClick={() => setSelectedLog(log)}
                style={{
                  padding: "4px 6px",
                  marginBottom: "2px",
                  cursor: "pointer",
                  borderRadius: "4px",
                  display: "flex",
                  gap: "8px",
                  alignItems: "center",
                  background: "rgba(255,255,255,0.03)",
                }}
              >
                <span style={{ color: statusColor, fontWeight: 600, minWidth: "34px" }}>{log.status}</span>
                <span style={{ minWidth: "46px", opacity: 0.8 }}>{log.method}</span>
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{log.url}</span>
                <span style={{ opacity: 0.6 }}>{log.duration_ms}ms</span>
              </div>
            );
          })}
          {requestLogs.length === 0 && <p style={{ fontSize: "13px", opacity: 0.6 }}>No requests yet</p>}
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
        <div style={{ maxHeight: "120px", overflowY: "auto", fontFamily: "monospace", fontSize: "12px" }}>
          {logs.map((log, i) => (
            <div key={i} style={{ padding: "2px 0" }}>{log}</div>
          ))}
          {logs.length === 0 && <p style={{ fontSize: "13px", opacity: 0.6 }}>No activity yet</p>}
        </div>
      </div>

      {selectedLog && (
        <ProxyLogDetail log={selectedLog} onClose={() => setSelectedLog(null)} />
      )}
    </div>
  );
}

/* Modal showing the full request/response JSON for a single proxy log entry. */
function ProxyLogDetail({ log, onClose }: { log: ProxyLog; onClose: () => void }) {
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
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#1c1c1e",
          border: "1px solid rgba(255,255,255,0.15)",
          borderRadius: "8px",
          padding: "16px",
          width: "min(720px, 90vw)",
          maxHeight: "80vh",
          overflowY: "auto",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
          <h3 style={{ margin: 0 }}>
            {log.method} {log.status} · {log.duration_ms}ms
          </h3>
          <div style={{ display: "flex", gap: "8px" }}>
            <button className="copy-btn" onClick={() => navigator.clipboard.writeText(json)}>Copy JSON</button>
            <button className="copy-btn" onClick={onClose}>Close</button>
          </div>
        </div>
        <pre
          style={{
            fontFamily: "monospace",
            fontSize: "12px",
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
            margin: 0,
          }}
        >
          {json}
        </pre>
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
