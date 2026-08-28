import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import type { Dispatch, SetStateAction } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTheme } from "./hooks/useTheme";
import { useToast } from "./hooks/useToast";
import { friendlyError } from "./hooks/friendlyError";
import { BodyView } from "./JsonView";
import "./App.css";
import "./ToolsApp.css";

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
  // Shared toast hook — replaces a hand-rolled setTimeout+state pair so every
  // tool (Timestamp/Regex/Ip/Proxy) uses the same success/error styling and
  // the same de-dup behaviour.
  const { toast, showToast } = useToast();

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const nowDate = new Date(now);

  const epochResult = useMemo(() => {
    if (!epochInput.trim()) return null;
    const n = Number(epochInput.trim());
    if (isNaN(n)) return { error: "请输入有效数字" };
    // Auto-detect seconds vs milliseconds
    const ms = n < 1e12 ? n * 1000 : n;
    const d = new Date(ms);
    if (isNaN(d.getTime())) return { error: "无法解析为有效日期" };
    return {
      iso: d.toISOString(),
      local: d.toLocaleString(),
      utc: d.toUTCString(),
      relative: d.getTime() > Date.now() ? "未来" : "过去",
      ms: ms,
    };
  }, [epochInput]);

  const dateResult = useMemo(() => {
    if (!dateInput.trim()) return null;
    const d = new Date(dateInput.trim());
    if (isNaN(d.getTime())) return { error: "无法解析为有效日期" };
    return {
      seconds: Math.floor(d.getTime() / 1000),
      milliseconds: d.getTime(),
      iso: d.toISOString(),
    };
  }, [dateInput]);

  const copy = async (text: string, _label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      showToast("已复制");
    } catch (e) {
      showToast(friendlyError(e, "复制失败"), "error");
    }
  };

  return (
    <div className="tools-tab-content">
      <div className="tools-section">
        <h3>当前时间</h3>
        <div className="tools-output-group">
          <div className="tools-output-row">
            <span className="tools-label">Unix（秒）</span>
            <code className="tools-code">{Math.floor(now / 1000)}</code>
            <button className="copy-btn" onClick={() => copy(String(Math.floor(now / 1000)), "epoch")}>复制</button>
          </div>
          <div className="tools-output-row">
            <span className="tools-label">Unix（毫秒）</span>
            <code className="tools-code">{now}</code>
            <button className="copy-btn" onClick={() => copy(String(now), "epoch")}>复制</button>
          </div>
          <div className="tools-output-row">
            <span className="tools-label">ISO 8601</span>
            <code className="tools-code">{nowDate.toISOString()}</code>
            <button className="copy-btn" onClick={() => copy(nowDate.toISOString(), "iso")}>复制</button>
          </div>
          <div className="tools-output-row">
            <span className="tools-label">本地时间</span>
            <code className="tools-code">{nowDate.toLocaleString()}</code>
          </div>
        </div>
      </div>

      <div className="tools-section">
        <h3>时间戳 → 日期</h3>
        <input
          className="tools-input"
          placeholder="输入 Unix 时间戳（秒或毫秒）…"
          value={epochInput}
          onChange={(e) => setEpochInput(e.target.value)}
        />
        {epochResult && !epochResult.error && (
          <div className="tools-output-group">
            <div className="tools-output-row">
              <span className="tools-label">ISO</span>
              <code className="tools-code">{epochResult.iso}</code>
              <button className="copy-btn" onClick={() => copy(epochResult.iso!, "iso")}>复制</button>
            </div>
            <div className="tools-output-row">
              <span className="tools-label">本地</span>
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
        <h3>日期 → 时间戳</h3>
        <input
          className="tools-input"
          placeholder="例如 2024-01-15T10:30:00Z 或 2024/01/15 10:30:00"
          value={dateInput}
          onChange={(e) => setDateInput(e.target.value)}
        />
        {dateResult && !dateResult.error && (
          <div className="tools-output-group">
            <div className="tools-output-row">
              <span className="tools-label">秒</span>
              <code className="tools-code">{dateResult.seconds}</code>
              <button className="copy-btn" onClick={() => copy(String(dateResult.seconds), "epoch")}>复制</button>
            </div>
            <div className="tools-output-row">
              <span className="tools-label">毫秒</span>
              <code className="tools-code">{dateResult.milliseconds}</code>
              <button className="copy-btn" onClick={() => copy(String(dateResult.milliseconds), "epoch")}>复制</button>
            </div>
            <div className="tools-output-row">
              <span className="tools-label">ISO</span>
              <code className="tools-code">{dateResult.iso}</code>
            </div>
          </div>
        )}
        {dateResult?.error && <p className="tools-error">{dateResult.error}</p>}
      </div>

      {toast && <div className={`tools-toast tools-toast-${toast.type}`}>{toast.msg}</div>}
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
    fieldNames: ["分钟", "小时", "日", "月", "星期"],
    ranges: [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]],
    presets: [
      ["每分钟",       ["*", "*", "*", "*", "*"]],
      ["每 5 分钟",     ["*/5", "*", "*", "*", "*"]],
      ["每 15 分钟",    ["*/15", "*", "*", "*", "*"]],
      ["每小时",        ["0", "*", "*", "*", "*"]],
      ["每天 9:00",     ["0", "9", "*", "*", "*"]],
      ["工作日 9:00",   ["0", "9", "*", "*", "1-5"]],
      ["每周一 9:00",   ["0", "9", "*", "*", "1"]],
      ["每月 1 日 00:00", ["0", "0", "1", "*", "*"]],
    ],
  },
  "6field": {
    fields: ["sec", "min", "hour", "dom", "mon", "dow"],
    fieldNames: ["秒", "分钟", "小时", "日", "月", "星期"],
    ranges: [[0, 59], [0, 59], [0, 23], [1, 31], [1, 12], [0, 6]],
    presets: [
      ["每 10 秒",     ["*/10", "*", "*", "*", "*", "*"]],
      ["每 30 秒",     ["*/30", "*", "*", "*", "*", "*"]],
      ["每秒",         ["*", "*", "*", "*", "*", "*"]],
      ["每 5 秒",      ["*/5", "*", "*", "*", "*", "*"]],
      ["每天 9:00:00", ["0", "0", "9", "*", "*", "*"]],
      ["工作日 9:00:00", ["0", "0", "9", "*", "*", "1-5"]],
      ["每小时 :00:30", ["30", "0", "*", "*", "*", "*"]],
      ["每月 1 日 00:00:00", ["0", "0", "0", "1", "*", "*"]],
    ],
  },
};

const DOW_NAMES = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const MON_NAMES = ["", "1 月", "2 月", "3 月", "4 月", "5 月", "6 月", "7 月", "8 月", "9 月", "10 月", "11 月", "12 月"];

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
      parts.push(`每 ${secS.slice(2)} 秒`);
    } else {
      parts.push(`在第 ${secS} 秒`);
    }
  } else if (secS === "*") {
    parts.push("每秒");
  }

  if (minS === "*" && hourS === "*") {
    if (!secS || secS === "0") parts.push("每分钟");
  } else if (minS.startsWith("*/")) {
    parts.push(`每 ${minS.slice(2)} 分钟`);
    if (hourS !== "*") parts.push(`在 ${hourS} 时`);
  } else if (hourS === "*") {
    parts.push(`每小时的第 ${minS} 分`);
  } else {
    parts.push(`在 ${pad(parseInt(hourS, 10))}:${pad(parseInt(minS, 10))}${secS && secS !== "0" ? `:${pad(parseInt(secS, 10))}` : ""}`);
  }

  if (dowS !== "*") {
    if (dowS === "1-5") parts.push("（周一至周五）");
    else if (dowS === "0,6") parts.push("（周六、周日）");
    else {
      const days = Array.from(parseCronField(dowS, [0, 6]) ?? []).map((d) => DOW_NAMES[d]).join("、");
      parts.push(`${days}`);
    }
  }

  if (domS !== "*" && monS !== "*") {
    const mons = Array.from(parseCronField(monS, [1, 12]) ?? []).map((m) => MON_NAMES[m]).join("、");
    parts.push(`${mons} ${domS} 日`);
  } else if (domS !== "*") {
    parts.push(`每月 ${domS} 日`);
  } else if (monS !== "*") {
    const mons = Array.from(parseCronField(monS, [1, 12]) ?? []).map((m) => MON_NAMES[m]).join("、");
    parts.push(`${mons}`);
  }

  return parts.join("，");
}

function cronNextTimes(fields: string[], count: number, hasSeconds: boolean): Date[] | string {
  const ranges = CRON_CONFIGS[hasSeconds ? "6field" : "5field"].ranges;
  const sets = fields.map((f, i) => parseCronField(f, ranges[i]));
  if (sets.some((s) => s === null)) return "Cron 表达式无效";

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

    if (result.length === 0) return "未找到未来执行时间";
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

  if (result.length === 0) return "未找到未来执行时间";
  return result;
}

function CronTab() {
  const [mode, setMode] = useState<CronMode>("5field");
  const cfg = CRON_CONFIGS[mode];
  const [fields, setFields] = useState<string[]>(cfg.presets[0][1]);

  const valid = useMemo(() => {
    const ranges = CRON_CONFIGS[mode].ranges;
    if (fields.length !== ranges.length) return false;
    return fields.every((f, i) => parseCronField(f, ranges[i]) !== null);
  }, [fields, mode]);

  const description = useMemo(() => {
    if (!valid) return "表达式无效";
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
        <h3>Cron 表达式</h3>
        <div className="cron-mode-switch">
          <button
            className={`cron-mode-btn ${mode === "5field" ? "active" : ""}`}
            onClick={() => switchMode("5field")}
          >
            5 字段（标准）
          </button>
          <button
            className={`cron-mode-btn ${mode === "6field" ? "active" : ""}`}
            onClick={() => switchMode("6field")}
          >
            6 字段（含秒）
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
        <h3>说明</h3>
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
        <h3>未来 5 次执行</h3>
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
  ["邮箱",      "^[\\w.+-]+@[\\w.-]+\\.[a-zA-Z]{2,}$", "gim"],
  ["URL",        "https?://[\\w.-]+(?:/[\\w./?=-]*)?", "gm"],
  ["IPv4",       "\\b(?:\\d{1,3}\\.){3}\\d{1,3}\\b", "g"],
  ["手机号",     "\\b1[3-9]\\d{9}\\b", "g"],
  ["ISO 日期",   "\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}", "g"],
  ["十六进制颜色", "#[0-9a-fA-F]{6}\\b", "g"],
];

interface MatchInfo {
  index: number;
  matched: string;
  groups: string[];
}

function RegexTab() {
  const [pattern, setPattern] = useState("\\b\\w+@\\w+\\.\\w+\\b");
  const [flags, setFlags] = useState("g");
  const [testStr, setTestStr] = useState("联系我们：alice@example.com 或 bob@test.org。\n也可联系 admin@site.co.uk");
  // Same shared toast as the other tools — keeps a single CSS class in use and
  // gives us structured success/error tinting.
  const { toast } = useToast();

  const { error, matches, highlighted } = useMemo(() => {
    if (!pattern) return { error: null, matches: [], highlighted: testStr };
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, flags);
    } catch (e) {
      // Surface a short, readable message — the JS error contains a long
      // stack trace we don't want in the UI.
      return { error: `正则表达式无效：${friendlyError(e, "正则语法错误")}`, matches: [], highlighted: testStr };
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
        <h3>正则表达式</h3>
        <div className="regex-input-row">
          <span className="regex-slash">/</span>
          <input
            className="tools-input regex-pattern-input"
            value={pattern}
            onChange={(e) => setPattern(e.target.value)}
            placeholder="输入正则表达式…"
          />
          <span className="regex-slash">/</span>
          <input
            className="tools-input regex-flags-input"
            value={flags}
            onChange={(e) => setFlags(e.target.value.replace(/[^gimsuy]/g, ""))}
            placeholder="标志"
            title="g=全局 i=忽略大小写 m=多行 s=.匹配换行 u=Unicode y=粘性"
          />
        </div>
        <div className="regex-flags-hint">
          g=全局 · i=忽略大小写 · m=多行 · s=点号匹配换行 · u=Unicode · y=粘性
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
        <h3>测试字符串</h3>
        <textarea
          className="tools-textarea"
          value={testStr}
          onChange={(e) => setTestStr(e.target.value)}
          spellCheck={false}
          rows={5}
        />
      </div>

      <div className="tools-section">
        <h3>匹配结果（{matches.length}）</h3>
        {matches.length === 0 && !error && (
          <p className="tools-hint">未找到匹配。</p>
        )}
        {matches.length > 0 && (
          <div className="regex-match-list">
            {matches.map((m, i) => (
              <div key={i} className="regex-match-item">
                <div className="regex-match-header">
                  <span className="tools-label">#{i + 1}</span>
                  <code className="tools-code">"{m.matched}"</code>
                  <span className="tools-sub">位置 {m.index}</span>
                </div>
                {m.groups.length > 0 && (
                  <div className="regex-groups">
                    {m.groups.map((g, gi) => (
                      <span key={gi} className="regex-group">
                        ${gi + 1}："{g}"
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
        <h3>高亮预览</h3>
        <pre
          className="regex-highlighted"
          dangerouslySetInnerHTML={{ __html: highlighted || escapeHtml(testStr) }}
        />
      </div>

      {toast && <div className={`tools-toast tools-toast-${toast.type}`}>{toast.msg}</div>}
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

/** One bound socket, as returned by the `list_ports` command. */
interface PortInfo {
  protocol: string;
  local_addr: string;
  port: number;
  foreign_addr: string;
  state: string;
  pid: number;
  process_name: string;
}

/** One running process, as returned by the `list_processes` command. */
interface ProcessInfo {
  pid: number;
  name: string;
  memory_kb: number | null;
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
  // Skipped when the tab is hidden so the app doesn't keep invoking IPC in
  // the background — once the user comes back the next tick re-syncs.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (document.visibilityState === "visible") {
        try {
          const logs = await invoke<ProxyLog[]>("get_proxy_logs");
          if (!cancelled) setState((s) => ({ ...s, requestLogs: logs }));
        } catch {
          // silent
        }
      }
    };
    const interval = setInterval(tick, 2000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const toggleServer = async () => {
    try {
      await invoke(isRunning ? "stop_proxy" : "start_proxy", { port });
      setState((s) => ({ ...s, isRunning: !isRunning }));
      pushLog(`代理已${isRunning ? "停止" : "启动"}，端口 ${port}`);
    } catch (e) {
      pushLog(`错误：${friendlyError(e, "操作失败")}`);
    }
  };

  const saveDefaultTarget = async (target: string) => {
    try {
      await invoke("set_proxy_default_target", { target });
    } catch (e) {
      pushLog(`保存默认目标失败：${friendlyError(e, "保存失败")}`);
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
      pushLog(`已添加规则：${prefix} → ${target}`);
    } catch (e) {
      pushLog(`添加规则失败：${friendlyError(e, "添加失败")}`);
    }
  };

  const removeRoute = async (id: string) => {
    try {
      await invoke("delete_proxy_route", { routeId: id });
      setState((s) => ({ ...s, routes: s.routes.filter((r) => r.id !== id) }));
    } catch (e) {
      pushLog(`删除规则失败：${friendlyError(e, "删除失败")}`);
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
      pushLog(`切换规则失败：${friendlyError(e, "切换失败")}`);
    }
  };

  return (
    <div className="tools-tab-content">
      <div className="tools-section">
        <h3>代理服务器</h3>
        <div className="ip-query-row">
          <input
            className="tools-input"
            type="number"
            placeholder="端口"
            value={port}
            disabled={isRunning}
            onChange={(e) => setState((s) => ({ ...s, port: Number(e.target.value) }))}
          />
          <button className={isRunning ? "stop-btn" : "start-btn"} onClick={toggleServer}>{isRunning ? "停止代理" : "启动代理"}</button>
        </div>
        <p style={{ marginTop: "8px", fontSize: "13px", opacity: 0.8 }}>状态：{isRunning ? "运行中" : "已停止"}</p>
      </div>
      <div className="tools-section">
        <h3>默认目标</h3>
        <p style={{ fontSize: "13px", opacity: 0.7, marginBottom: "6px" }}>
          未匹配下方任何规则的请求将转发到此地址。
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
        <h3>转发规则</h3>
        <p style={{ fontSize: "13px", opacity: 0.7, marginBottom: "6px" }}>
          请求路径以此前缀开头时，将转发到对应目标（nginx 风格前缀匹配）。
        </p>
        <div className="ip-query-row">
          <input className="tools-input" placeholder="路径前缀，例如 /api" value={newPrefix} onChange={(e) => setNewPrefix(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") addRoute(); }} />
          <input className="tools-input" placeholder="目标，例如 http://localhost:3000" value={newTarget} onChange={(e) => setNewTarget(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") addRoute(); }} />
          <button onClick={addRoute}>添加规则</button>
        </div>
        <div style={{ marginTop: "12px" }}>
          {routes.map((route) => (
            <div key={route.id} className="tools-output-row" style={{ marginBottom: "4px", opacity: route.enabled ? 1 : 0.5 }}>
              <code className="tools-code">{route.path_prefix} → {route.target}</code>
              <button className="copy-btn" onClick={() => toggleRoute(route.id)}>{route.enabled ? "禁用" : "启用"}</button>
              <button className="copy-btn" onClick={() => removeRoute(route.id)}>删除</button>
            </div>
          ))}
          {routes.length === 0 && <p className="tools-hint">暂无规则</p>}
        </div>
      </div>
      <div className="tools-section">
        <h3>请求日志</h3>
        <p className="tools-hint" style={{ marginBottom: "6px" }}>
          点击一条请求可查看完整的请求与响应详情。
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
          {requestLogs.length === 0 && <p className="tools-hint">暂无请求记录</p>}
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
                pushLog(`清空日志失败：${friendlyError(e, "清空失败")}`);
              }
            }}
          >
            清空日志
          </button>
        )}
      </div>
      <div className="tools-section">
        <h3>活动日志</h3>
        <div className="activity-log">
          {logs.map((log, i) => (
            <div className="activity-row" key={i}>{log}</div>
          ))}
          {logs.length === 0 && <p className="tools-hint">暂无活动</p>}
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
  if (rows.length === 0) return <div className="jv-empty">— 暂无请求头 —</div>;
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
              复制 JSON
            </button>
            <button className="copy-btn" onClick={onClose}>关闭</button>
          </div>
        </div>

        <div className="log-modal-tabs">
          {(["overview", "request", "response"] as DetailTab[]).map((t) => (
            <button
              key={t}
              className={`log-modal-tab ${tab === t ? "active" : ""}`}
              onClick={() => setTab(t)}
            >
              {t === "overview" ? "概览" : t === "request" ? "请求" : "响应"}
            </button>
          ))}
        </div>

        <div className="log-modal-body">
          {tab === "overview" && (
            <div className="kv-grid">
              <div className="kv-k">状态</div>
              <div className="kv-v">
                <span className={`log-status ${statusClass}`}>{log.status || "ERR"}</span>
              </div>
              <div className="kv-k">方法</div>
              <div className="kv-v mono">{log.method}</div>
              <div className="kv-k">URL</div>
              <div className="kv-v mono breakable">{log.url}</div>
              <div className="kv-k">路由</div>
              <div className="kv-v mono">{log.route_match ?? <span className="jv-empty">默认</span>}</div>
              <div className="kv-k">耗时</div>
              <div className="kv-v mono">{log.duration_ms} 毫秒</div>
              <div className="kv-k">时间</div>
              <div className="kv-v mono">{new Date(log.timestamp).toLocaleString()}</div>
              {log.error && (
                <>
                  <div className="kv-k">错误</div>
                  <div className="kv-v log-error">{log.error}</div>
                </>
              )}
            </div>
          )}

          {tab === "request" && (
            <>
              <div className="log-block-title">
                请求头 <span className="log-count">{log.request_headers.length}</span>
              </div>
              <HeaderTable rows={log.request_headers} />
              <div className="log-block-title">
                请求体 <span className="log-count">{bodyLabel(log.request_body)}</span>
              </div>
              <BodyView body={log.request_body} />
            </>
          )}

          {tab === "response" && (
            <>
              {log.error && <div className="log-error-banner">{log.error}</div>}
              <div className="log-block-title">
                响应头 <span className="log-count">{log.response_headers.length}</span>
              </div>
              <HeaderTable rows={log.response_headers} />
              <div className="log-block-title">
                响应体 <span className="log-count">{bodyLabel(log.response_body)}</span>
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
  const [myIpError, setMyIpError] = useState<string | null>(null);
  const [queryInput, setQueryInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<IpInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Shared toast hook — matches the rest of the Tools window and routes copy
  // failures through the shared error-to-Chinese mapper.
  const { toast, showToast } = useToast();

  // Fetch my own IP on mount via the Rust backend (avoids WebView CSP / net
  // permission issues that break `fetch` in a packaged build).
  // Surfaces failures instead of swallowing them: a silent catch left the UI
  // stuck on "加载中…" forever with no hint that the lookup had failed.
  const loadMyIp = useCallback(async () => {
    setMyIpError(null);
    try {
      const data = await invoke<IpInfo>("ip_lookup", { target: null });
      setMyIp(data.ip || "");
      if (!data.ip) setMyIpError("未获取到 IP");
    } catch (e) {
      setMyIp("");
      setMyIpError(friendlyError(e, "获取失败"));
    }
  }, []);

  useEffect(() => {
    void loadMyIp();
  }, [loadMyIp]);

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      showToast("已复制");
    } catch (e) {
      showToast(friendlyError(e, "复制失败"), "error");
    }
  };

  const doLookup = async (ip?: string) => {
    const target = (ip || queryInput).trim();
    if (!target) return;
    // Ignore re-entry while a lookup is in flight: two concurrent requests
    // would race and the slower one could overwrite the newer result.
    if (loading) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      // Business failures (invalid IP, provider down) come back as a rejected
      // promise from the Rust side, so `catch` is the only failure path.
      setResult(await invoke<IpInfo>("ip_lookup", { target }));
    } catch (e) {
      setError(friendlyError(e, "查询失败"));
    } finally {
      setLoading(false);
    }
  };

  const resultRows: { label: string; value: string }[] = result
    ? [
        { label: "IP", value: result.ip || "-" },
        { label: "城市", value: result.city || "-" },
        { label: "省份/州", value: result.region || "-" },
        { label: "国家/地区", value: result.country_name ? `${result.country_name}（${result.country || ""}）` : "-" },
        { label: "邮编", value: result.postal || "-" },
        { label: "纬度", value: result.latitude != null ? String(result.latitude) : "-" },
        { label: "经度", value: result.longitude != null ? String(result.longitude) : "-" },
        { label: "时区", value: result.timezone || "-" },
        { label: "组织", value: result.org || "-" },
        { label: "ASN", value: result.asn || "-" },
      ]
    : [];

  return (
    <div className="tools-tab-content">
      <div className="tools-section">
        <h3>本机 IP</h3>
        <div className="tools-output-row">
          <span className="tools-label">IP</span>
          <code className="tools-code">
            {myIp || (myIpError ? `— ${myIpError}` : "加载中…")}
          </code>
          {myIp && (
            <button className="copy-btn" onClick={() => copy(myIp)}>复制</button>
          )}
          {myIp && (
            <button className="copy-btn" onClick={() => { setQueryInput(myIp); doLookup(myIp); }}>查询 ↗</button>
          )}
          {!myIp && myIpError && (
            <button className="copy-btn" onClick={() => void loadMyIp()}>重试</button>
          )}
        </div>
      </div>

      <div className="tools-section">
        <h3>IP 归属地查询</h3>
        <div className="ip-query-row">
          <input
            className="tools-input"
            placeholder="输入 IP 或域名…"
            value={queryInput}
            onChange={(e) => setQueryInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") doLookup(); }}
          />
          <button
            className="ip-lookup-btn"
            disabled={loading || !queryInput.trim()}
            onClick={() => doLookup()}
          >
            {loading ? "查询中…" : "查询"}
          </button>
        </div>
        {error && <p className="tools-error">{error}</p>}
      </div>

      {result && (
        <div className="tools-section">
          <h3>查询结果</h3>
          <div className="tools-output-group">
            {resultRows.map((r) => (
              <div className="tools-output-row" key={r.label}>
                <span className="tools-label">{r.label}</span>
                <code className="tools-code">{r.value}</code>
                {r.value !== "-" && (
                  <button className="copy-btn" onClick={() => copy(r.value)}>复制</button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {toast && <div className={`tools-toast tools-toast-${toast.type}`}>{toast.msg}</div>}
    </div>
  );
}

/* =============================================================
 * Process & Port manager
 * ============================================================= */

type ProcView = "ports" | "processes";

function ProcessTab() {
  const [view, setView] = useState<ProcView>("ports");
  const [ports, setPorts] = useState<PortInfo[]>([]);
  const [procs, setProcs] = useState<ProcessInfo[]>([]);
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Two-step confirm: a mis-click on "结束" could kill the user's editor,
  // so the row must be armed before the kill actually fires.
  const [pendingKill, setPendingKill] = useState<number | null>(null);
  const { toast, showToast } = useToast();
  // Monotonic request id: a slow refresh must not overwrite the results of a
  // newer one (easy to trigger by toggling 端口/进程 quickly, since the two
  // fetches take different amounts of time).
  const reqSeq = useRef(0);

  const refresh = useCallback(async () => {
    const seq = ++reqSeq.current;
    setLoading(true);
    setError(null);
    try {
      if (view === "ports") {
        const rows = await invoke<PortInfo[]>("list_ports");
        if (seq !== reqSeq.current) return;
        setPorts(rows);
      } else {
        const rows = await invoke<ProcessInfo[]>("list_processes");
        if (seq !== reqSeq.current) return;
        setProcs(rows);
      }
      setPendingKill(null);
    } catch (e) {
      if (seq !== reqSeq.current) return;
      setError(friendlyError(e, "获取失败"));
    } finally {
      // Only the newest request owns the spinner, otherwise a stale response
      // clears it while the current fetch is still running.
      if (seq === reqSeq.current) setLoading(false);
    }
  }, [view]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const kill = useCallback(
    async (pid: number, label: string, force: boolean) => {
      try {
        await invoke("kill_process", { pid, force });
        showToast(`已结束 ${label} (${pid})`);
        // Re-list rather than splicing locally: killing a parent can take
        // several children with it, so the local guess would be wrong.
        await refresh();
      } catch (e) {
        showToast(friendlyError(e, "结束失败"), "error");
      }
    },
    [refresh, showToast],
  );

  // Filtering is derived state, not stored — keeps the list and the query
  // from drifting out of sync after a refresh.
  const shownPorts = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return ports;
    return ports.filter(
      (p) =>
        String(p.port).includes(q) ||
        p.process_name.toLowerCase().includes(q) ||
        String(p.pid).includes(q) ||
        p.local_addr.toLowerCase().includes(q),
    );
  }, [ports, filter]);

  const shownProcs = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return procs;
    return procs.filter(
      (p) => p.name.toLowerCase().includes(q) || String(p.pid).includes(q),
    );
  }, [procs, filter]);

  const fmtMem = (kb: number | null) =>
    kb == null ? "—" : kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb} KB`;

  const killCell = (pid: number, label: string) =>
    pendingKill === pid ? (
      <span className="proc-confirm">
        <button className="copy-btn proc-danger" onClick={() => kill(pid, label, false)}>
          结束
        </button>
        <button className="copy-btn proc-danger" onClick={() => kill(pid, label, true)}>
          强制
        </button>
        <button className="copy-btn" onClick={() => setPendingKill(null)}>
          取消
        </button>
      </span>
    ) : (
      <button
        className="copy-btn proc-danger"
        onClick={() => setPendingKill(pid)}
        aria-label={`结束进程 ${label}`}
      >
        结束…
      </button>
    );

  return (
    <div className="tools-tab-content">
      <div className="tools-section">
        <div className="proc-toolbar">
          <div className="proc-switch" role="tablist" aria-label="视图切换">
            <button
              role="tab"
              aria-selected={view === "ports"}
              className={`proc-switch-btn ${view === "ports" ? "active" : ""}`}
              onClick={() => setView("ports")}
            >
              端口
            </button>
            <button
              role="tab"
              aria-selected={view === "processes"}
              className={`proc-switch-btn ${view === "processes" ? "active" : ""}`}
              onClick={() => setView("processes")}
            >
              进程
            </button>
          </div>
          <input
            className="tools-input proc-filter"
            placeholder={view === "ports" ? "过滤端口 / PID / 进程名…" : "过滤进程名 / PID…"}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            aria-label="过滤"
          />
          <button className="tools-btn" onClick={() => void refresh()} disabled={loading}>
            {loading ? "刷新中…" : "刷新"}
          </button>
        </div>

        {error && <div className="tools-error">{error}</div>}

        <div className="proc-count">
          {view === "ports"
            ? `${shownPorts.length} / ${ports.length} 个端口`
            : `${shownProcs.length} / ${procs.length} 个进程`}
        </div>

        <div className="proc-table-wrap">
          {view === "ports" ? (
            <table className="proc-table">
              <thead>
                <tr>
                  <th>协议</th>
                  <th>本地地址</th>
                  <th>端口</th>
                  <th>状态</th>
                  <th>PID</th>
                  <th>进程</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {shownPorts.map((p) => (
                  <tr key={`${p.protocol}-${p.local_addr}-${p.port}-${p.foreign_addr}-${p.pid}`}>
                    <td>{p.protocol}</td>
                    <td className="proc-mono">{p.local_addr}</td>
                    <td className="proc-mono proc-port">{p.port}</td>
                    <td>{p.state}</td>
                    <td className="proc-mono">{p.pid}</td>
                    <td>{p.process_name || "—"}</td>
                    <td>{killCell(p.pid, p.process_name || String(p.pid))}</td>
                  </tr>
                ))}
                {!loading && shownPorts.length === 0 && (
                  <tr>
                    <td colSpan={7} className="proc-empty">无匹配端口</td>
                  </tr>
                )}
              </tbody>
            </table>
          ) : (
            <table className="proc-table">
              <thead>
                <tr>
                  <th>进程名</th>
                  <th>PID</th>
                  <th>内存</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {shownProcs.map((p) => (
                  <tr key={p.pid}>
                    <td>{p.name}</td>
                    <td className="proc-mono">{p.pid}</td>
                    <td className="proc-mono">{fmtMem(p.memory_kb)}</td>
                    <td>{killCell(p.pid, p.name)}</td>
                  </tr>
                ))}
                {!loading && shownProcs.length === 0 && (
                  <tr>
                    <td colSpan={4} className="proc-empty">无匹配进程</td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {toast && <div className={`tools-toast tools-toast-${toast.type}`}>{toast.msg}</div>}
    </div>
  );
}

/* =============================================================
 * Main
 * ============================================================= */

type Tab = "timestamp" | "cron" | "regex" | "ip" | "proxy" | "process";

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: "timestamp", label: "时间戳", icon: "🕐" },
  { id: "cron",      label: "Cron",   icon: "⚙️" },
  { id: "regex",     label: "正则",   icon: "🔍" },
  { id: "ip",        label: "IP 查询", icon: "🌐" },
  { id: "proxy",     label: "代理",   icon: "🔀" },
  { id: "process",   label: "进程端口", icon: "🧩" },
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
        {tab === "process" && <ProcessTab />}
      </div>
    </div>
  );
}
