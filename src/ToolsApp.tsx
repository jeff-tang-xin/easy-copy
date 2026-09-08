import { useState, useMemo, useEffect, useCallback, useRef, Fragment } from "react";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTheme } from "./hooks/useTheme";
import { useToast } from "./hooks/useToast";
import { friendlyError } from "./hooks/friendlyError";
import { BodyView } from "./JsonView";
import {
  IconClock,
  IconGlobe,
  IconPuzzle,
  IconSearch,
  IconSettings,
  IconShuffle,
} from "./components/Icons";
import "./App.css";
import "./ToolsApp.css";

/* =============================================================
 * Timestamp Tab
 * ============================================================= */

function pad(n: number, w = 2) {
  return String(n).padStart(w, "0");
}

function TimestampTab({ visible }: { visible: boolean }) {
  const [now, setNow] = useState(Date.now());
  const [epochInput, setEpochInput] = useState("");
  const [dateInput, setDateInput] = useState("");
  // Shared toast hook — replaces a hand-rolled setTimeout+state pair so every
  // tool (Timestamp/Regex/Ip/Proxy) uses the same success/error styling and
  // the same de-dup behaviour.
  const { toast, showToast } = useToast();

  // 每秒刷新「当前时间」。窗口关闭走的是 win.hide()（见文件末尾 onCloseRequested），
  // 组件不会卸载，所以这里必须按可见性收敛：不可见时干脆不创建 interval，
  // 而不是在回调里空转 —— 否则窗口隐藏后仍每秒 setNow 触发整个 Tab 重渲染。
  // tick 直接写在 effect 内部（不作为外部依赖传入），这样依赖只有 visible，
  // 不会因父级重渲染而每秒重置定时器。
  useEffect(() => {
    if (!visible) return;
    // 先补跑一次：隐藏期间 now 已经停在旧值，恢复可见时若等下一次 tick
    // 会看到最多 1 秒的过期时间。
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [visible]);

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
  memory_kb: number | null;
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
  allow_lan: boolean;
}

interface ProxyState {
  port: number;
  isRunning: boolean;
  defaultTarget: string;
  routes: ProxyRoute[];
  logs: string[];
  requestLogs: ProxyLog[];
  allowLan: boolean;
}

/** 请求日志的状态码筛选档位。"err" = 连接失败（status 0 或带 error）。 */
type LogStatusFilter = "all" | "2xx" | "3xx" | "4xx" | "5xx" | "err";

const LOG_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

/** 提取启动失败中的端口占用提示。 */
function startFailureHint(msg: string, port: number): string {
  const lower = msg.toLowerCase();
  if (lower.includes("10048") || lower.includes("os error 98") || lower.includes("address in use")) {
    return `端口 ${port} 已被占用，请换一个端口，或在「进程/端口」面板结束占用该端口的进程`;
  }
  return msg;
}

function ProxyTab({
  state,
  setState,
  visible,
}: {
  state: ProxyState;
  setState: Dispatch<SetStateAction<ProxyState>>;
  visible: boolean;
}) {
  const { port, isRunning, defaultTarget, routes, logs, requestLogs, allowLan } = state;
  const [newPrefix, setNewPrefix] = useState("");
  const [newTarget, setNewTarget] = useState("");
  const [selectedLog, setSelectedLog] = useState<ProxyLog | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editPrefix, setEditPrefix] = useState("");
  const [editTarget, setEditTarget] = useState("");
  const [startError, setStartError] = useState<string | null>(null);
  const [logFilterText, setLogFilterText] = useState("");
  const [logFilterMethod, setLogFilterMethod] = useState("all");
  const [logFilterStatus, setLogFilterStatus] = useState<LogStatusFilter>("all");

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
          allowLan: cfg.allow_lan,
        }));
      } catch {
        // silent
      }
    })();
  }, []);

  // 每 2 秒轮询代理日志，让新条目自动出现。
  // 之前是「照常每 2s 唤醒 JS，再在回调里判 document.visibilityState 决定跳过」，
  // 白白唤醒定时器；现在改为不可见时根本不建 interval，恢复可见立刻补拉一次。
  // fetchLogs 写在 effect 内部，依赖只有 visible，避免父级重渲染重置轮询周期。
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    const fetchLogs = async () => {
      try {
        const logs = await invoke<ProxyLog[]>("get_proxy_logs");
        if (!cancelled) setState((s) => ({ ...s, requestLogs: logs }));
      } catch {
        // silent
      }
    };
    // 立刻补跑一次：不可见期间日志已经停更，否则要等满 2 秒才看到。
    fetchLogs();
    const interval = setInterval(fetchLogs, 2000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [visible, setState]);

  const toggleServer = async () => {
    try {
      await invoke(isRunning ? "stop_proxy" : "start_proxy", { port });
      setState((s) => ({ ...s, isRunning: !isRunning }));
      setStartError(null);
      pushLog(`代理已${isRunning ? "停止" : "启动"}，端口 ${port}`);
    } catch (e) {
      const msg = friendlyError(e, "操作失败");
      pushLog(`错误：${msg}`);
      if (!isRunning) setStartError(startFailureHint(msg, port));
    }
  };

  // 后端在代理运行时会拒绝切换：绑定地址在 listener 创建时就定死了，
  // 中途翻转标志只会让 UI 显示一个服务器并没有在用的绑定。因此这里不做
  // 「先改后提示重启」，而是运行时直接禁用开关（见下方 disabled）。
  const toggleAllowLan = async (next: boolean) => {
    try {
      await invoke("set_proxy_allow_lan", { allow: next });
      setState((s) => ({ ...s, allowLan: next }));
      pushLog(`已${next ? "开启" : "关闭"}局域网访问`);
    } catch (e) {
      pushLog(`设置局域网访问失败：${friendlyError(e, "设置失败")}`);
    }
  };

  const startEdit = (route: ProxyRoute) => {
    setEditingId(route.id);
    setEditPrefix(route.path_prefix);
    setEditTarget(route.target);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditPrefix("");
    setEditTarget("");
  };

  // 复用同一个 route.id 调 upsert_proxy_route，后端按 id 覆盖即为「编辑」。
  const saveEdit = async (route: ProxyRoute) => {
    const prefix = editPrefix.trim();
    const target = editTarget.trim();
    if (!prefix || !target) return;
    const updated: ProxyRoute = { ...route, path_prefix: prefix, target };
    try {
      await invoke("upsert_proxy_route", { route: updated });
      setState((s) => ({
        ...s,
        routes: s.routes.map((r) => (r.id === route.id ? updated : r)),
      }));
      cancelEdit();
      pushLog(`已更新规则：${prefix} → ${target}`);
    } catch (e) {
      pushLog(`更新规则失败：${friendlyError(e, "更新失败")}`);
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

  // 派生视图，不改动 requestLogs 本身，避免筛选把真实日志吃掉。
  const shownLogs = useMemo(() => {
    const kw = logFilterText.trim().toLowerCase();
    return [...requestLogs]
      .reverse()
      .filter((log) => {
        if (kw && !log.url.toLowerCase().includes(kw)) return false;
        if (logFilterMethod !== "all" && log.method.toUpperCase() !== logFilterMethod) return false;
        if (logFilterStatus !== "all") {
          const failed = log.status === 0 || !!log.error;
          if (logFilterStatus === "err") return failed;
          if (failed) return false;
          const bucket = `${Math.floor(log.status / 100)}xx`;
          if (bucket !== logFilterStatus) return false;
        }
        return true;
      });
  }, [requestLogs, logFilterText, logFilterMethod, logFilterStatus]);

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
        <label className="tools-hint" style={{ display: "flex", alignItems: "center", gap: "6px", marginTop: "8px", cursor: isRunning ? "not-allowed" : "pointer" }} title={isRunning ? "请先停止代理再修改此设置" : ""}>
          <input
            type="checkbox"
            checked={allowLan}
            disabled={isRunning}
            onChange={(e) => toggleAllowLan(e.target.checked)}
          />
          允许局域网访问
        </label>
        {allowLan && (
          <p className="tools-hint" style={{ marginTop: "4px" }}>
            其他设备可通过 http://&lt;本机IP&gt;:{port} 访问
          </p>
        )}
        {startError && <div className="proxy-start-error">{startError}</div>}
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
              {editingId === route.id ? (
                <>
                  <input
                    className="tools-input"
                    placeholder="路径前缀，例如 /api"
                    value={editPrefix}
                    onChange={(e) => setEditPrefix(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") saveEdit(route); if (e.key === "Escape") cancelEdit(); }}
                  />
                  <input
                    className="tools-input"
                    placeholder="目标，例如 http://localhost:3000"
                    value={editTarget}
                    onChange={(e) => setEditTarget(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") saveEdit(route); if (e.key === "Escape") cancelEdit(); }}
                  />
                  <button
                    className="copy-btn"
                    disabled={!editPrefix.trim() || !editTarget.trim()}
                    onClick={() => saveEdit(route)}
                  >
                    保存
                  </button>
                  <button className="copy-btn" onClick={cancelEdit}>取消</button>
                </>
              ) : (
                <>
                  <code className="tools-code">{route.path_prefix} → {route.target}</code>
                  <button className="copy-btn" onClick={() => startEdit(route)}>编辑</button>
                  <button className="copy-btn" onClick={() => toggleRoute(route.id)}>{route.enabled ? "禁用" : "启用"}</button>
                  <button className="copy-btn" onClick={() => removeRoute(route.id)}>删除</button>
                </>
              )}
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
        <div className="proxy-log-filter">
          <input
            className="tools-input"
            placeholder="搜索 URL"
            value={logFilterText}
            onChange={(e) => setLogFilterText(e.target.value)}
          />
          <select
            className="proxy-filter-select"
            value={logFilterMethod}
            onChange={(e) => setLogFilterMethod(e.target.value)}
          >
            <option value="all">全部方法</option>
            {LOG_METHODS.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
          <select
            className="proxy-filter-select"
            value={logFilterStatus}
            onChange={(e) => setLogFilterStatus(e.target.value as LogStatusFilter)}
          >
            <option value="all">全部状态</option>
            <option value="2xx">2xx</option>
            <option value="3xx">3xx</option>
            <option value="4xx">4xx</option>
            <option value="5xx">5xx</option>
            <option value="err">错误</option>
          </select>
        </div>
        <div className="req-log-list">
          {shownLogs.map((log) => {
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
          {requestLogs.length > 0 && shownLogs.length === 0 && <p className="tools-hint">无匹配的请求</p>}
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

/** 可排序列。端口视图与进程视图共用一套 key，各自只暴露自己支持的子集。 */
type ProcSortKey = "port" | "pid" | "process_name" | "state" | "memory_kb" | "name";
type SortDir = "asc" | "desc";

/** `kill_processes` 的单条结果。 */
interface KillOutcome {
  pid: number;
  success: boolean;
  error: string | null;
}

/** 端口状态 → 着色类名。UDP 无状态（空串）返回空，不着色。 */
function portStateClass(state: string): string {
  const s = state.trim().toUpperCase();
  if (!s) return "";
  if (s === "LISTENING" || s === "ESTABLISHED") return "proc-state-ok";
  if (s === "TIME_WAIT" || s === "CLOSE_WAIT" || s.startsWith("SYN_")) return "proc-state-warn";
  return "proc-state-err";
}

/** 数字列排序，null 恒排在末尾（不论升降序）。 */
function cmpNullableNum(a: number | null, b: number | null, sign: number): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;    // null 总是排在末尾
  if (b == null) return -1;
  return (a - b) * sign;
}

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
  // 自动刷新：默认关闭，间隔 5s。开启时才建 interval。
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [autoMs, setAutoMs] = useState(5000);
  // 排序状态。默认按端口/PID 升序。
  const [sortKey, setSortKey] = useState<ProcSortKey>("port");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  // 端口视图按进程聚合。
  const [groupByProc, setGroupByProc] = useState(false);
  // 批量选择的 PID 集合。
  const [selected, setSelected] = useState<number[]>([]);
  const [pendingBatch, setPendingBatch] = useState(false);
  const { toast, showToast } = useToast();
  // Monotonic request id: a slow refresh must not overwrite the results of a
  // newer one (easy to trigger by toggling 端口/进程 quickly, since the two
  // fetches take different amounts of time).
  const reqSeq = useRef(0);

  // silent=true 用于自动刷新：不亮骨架，否则列表每隔几秒闪一次。
  const refresh = useCallback(async (silent = false) => {
    const seq = ++reqSeq.current;
    if (!silent) setLoading(true);
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

  // 切换视图 / 切换分组时清空选择：选中的 PID 在新列表里可能根本不存在。
  useEffect(() => {
    setSelected([]);
    setPendingBatch(false);
  }, [view, groupByProc]);

  // 自动刷新：只有开启时才创建 interval，关闭/卸载即清理。
  // 有行处于待确认（单行或批量）时暂停，否则确认按钮会被刷新掉。
  const paused = pendingKill !== null || pendingBatch;
  useEffect(() => {
    if (!autoRefresh || paused) return;
    const id = setInterval(() => { void refresh(true); }, autoMs);
    return () => clearInterval(id);
  }, [autoRefresh, autoMs, paused, refresh]);

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

  // 批量结束：一次 invoke，按 KillOutcome[] 汇总成功/失败。
  const killMany = useCallback(
    async (pids: number[], force: boolean) => {
      if (pids.length === 0) return;
      try {
        const outcomes = await invoke<KillOutcome[]>("kill_processes", { pids, force });
        const failed = outcomes.filter((o) => !o.success);
        if (failed.length === 0) {
          showToast(`已结束 ${outcomes.length} 个进程`);
        } else {
          const head = failed
            .slice(0, 3)
            .map((o) => `${o.pid}：${o.error || "未知错误"}`)
            .join("；");
          const rest = failed.length > 3 ? `，等 ${failed.length} 项` : "";
          showToast(`部分进程结束失败 — ${head}${rest}`, "error");
        }
      } catch (e) {
        showToast(friendlyError(e, "批量结束失败"), "error");
      } finally {
        setSelected([]);
        setPendingBatch(false);
        await refresh();
      }
    },
    [refresh, showToast],
  );

  const copyText = useCallback(
    async (text: string) => {
      try {
        await navigator.clipboard.writeText(text);
        showToast(`已复制 ${text}`);
      } catch (e) {
        showToast(friendlyError(e, "复制失败"), "error");
      }
    },
    [showToast],
  );

  // 在资源管理器中定位可执行文件。系统进程常见失败，只提示不抛错。
  const revealPath = useCallback(
    async (pid: number) => {
      try {
        await invoke("reveal_process_path", { pid });
      } catch (e) {
        showToast(friendlyError(e, "无法定位该进程的文件"), "error");
      }
    },
    [showToast],
  );

  const toggleSort = useCallback((key: ProcSortKey) => {
    // 两个 setState 平铺写，不要把 setSortDir 塞进 setSortKey 的 updater —
    // updater 在 StrictMode 下会被调用两次，方向会被翻转两次等于没翻。
    setSortDir((d) => (sortKey === key ? (d === "asc" ? "desc" : "asc") : "asc"));
    setSortKey(key);
  }, [sortKey]);

  // Filtering is derived state, not stored — keeps the list and the query
  // from drifting out of sync after a refresh.
  const shownPorts = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const base = !q
      ? ports
      : ports.filter(
          (p) =>
            String(p.port).includes(q) ||
            p.process_name.toLowerCase().includes(q) ||
            String(p.pid).includes(q) ||
            p.local_addr.toLowerCase().includes(q),
        );
    // slice 后再排：base 可能就是 ports 本身，原地 sort 会改到 state。
    return base.slice().sort((a, b) => {
      const sign = sortDir === "asc" ? 1 : -1;
      switch (sortKey) {
        case "pid":
          return (a.pid - b.pid) * sign;
        case "state":
          return a.state.localeCompare(b.state) * sign;
        case "process_name":
          return a.process_name.localeCompare(b.process_name) * sign;
        case "memory_kb":
          return cmpNullableNum(a.memory_kb, b.memory_kb, sign);
        default:
          return (a.port - b.port) * sign;
      }
    });
  }, [ports, filter, sortKey, sortDir]);

  // 分组模式：按 pid 聚合，组按端口数降序；组内沿用 shownPorts 已排好的顺序。
  const portGroups = useMemo(() => {
    if (!groupByProc) return [];
    const map = new Map<number, PortInfo[]>();
    for (const p of shownPorts) {
      const list = map.get(p.pid);
      if (list) list.push(p);
      else map.set(p.pid, [p]);
    }
    return Array.from(map.entries())
      .map(([pid, rows]) => ({
        pid,
        name: rows.find((r) => r.process_name)?.process_name || "—",
        rows,
      }))
      .sort((a, b) => b.rows.length - a.rows.length);
  }, [shownPorts, groupByProc]);

  const shownProcs = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const base = !q
      ? procs
      : procs.filter(
          (p) => p.name.toLowerCase().includes(q) || String(p.pid).includes(q),
        );
    return base.slice().sort((a, b) => {
      const sign = sortDir === "asc" ? 1 : -1;
      switch (sortKey) {
        case "name":
        case "process_name":
          return a.name.localeCompare(b.name) * sign;
        case "memory_kb":
          return cmpNullableNum(a.memory_kb, b.memory_kb, sign);
        default:
          return (a.pid - b.pid) * sign;
      }
    });
  }, [procs, filter, sortKey, sortDir]);

  // 当前视图里所有可见 PID（去重），用于全选。
  const visiblePids = useMemo(
    () =>
      Array.from(
        new Set(view === "ports" ? shownPorts.map((p) => p.pid) : shownProcs.map((p) => p.pid)),
      ),
    [view, shownPorts, shownProcs],
  );

  const toggleSelect = useCallback((pid: number) => {
    setSelected((prev) => (prev.includes(pid) ? prev.filter((x) => x !== pid) : [...prev, pid]));
  }, []);

  const fmtMem = (kb: number | null) =>
    kb == null ? "—" : kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb} KB`;

  // 可排序表头：点击切换，当前列带方向类名。
  const sortTh = (key: ProcSortKey, label: string) => (
    <th
      className={`proc-sortable ${
        sortKey === key ? (sortDir === "asc" ? "proc-sort-asc" : "proc-sort-desc") : ""
      }`}
      onClick={() => toggleSort(key)}
      aria-sort={sortKey === key ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
    >
      {label}
    </th>
  );

  // 复制 + 定位两个快捷操作，两个视图共用。
  const actionBtns = (pid: number, copyValue: string) => (
    <>
      <button className="proc-action-btn" onClick={() => void copyText(copyValue)}>
        复制
      </button>
      <button className="proc-action-btn" onClick={() => void revealPath(pid)}>
        定位文件
      </button>
    </>
  );

  const selectCell = (pid: number) => (
    <td>
      <input
        type="checkbox"
        checked={selected.includes(pid)}
        onChange={() => toggleSelect(pid)}
        aria-label={`选择进程 ${pid}`}
      />
    </td>
  );

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

    const switchView = (v: ProcView) => {
    setView(v);
    setSortKey(v === "ports" ? "port" : "pid");
    setSortDir("asc");
  };

  return (
    <div className="tools-tab-content">
      <div className="tools-section">
        <div className="proc-toolbar">
          <div className="proc-switch" role="tablist" aria-label="视图切换">
            <button
              role="tab"
              aria-selected={view === "ports"}
              className={`proc-switch-btn ${view === "ports" ? "active" : ""}`}
              onClick={() => switchView("ports")}
            >
              端口
            </button>
            <button
              role="tab"
              aria-selected={view === "processes"}
              className={`proc-switch-btn ${view === "processes" ? "active" : ""}`}
              onClick={() => switchView("processes")}
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
          {/* 自动刷新 */}
          <label className="proc-auto-refresh">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
            />
            自动刷新
            <select
              value={autoMs}
              onChange={(e) => setAutoMs(Number(e.target.value))}
              disabled={!autoRefresh}
              aria-label="刷新间隔"
            >
              <option value={2000}>2s</option>
              <option value={5000}>5s</option>
              <option value={10000}>10s</option>
            </select>
          </label>
          {/* 端口视图：按进程分组 */}
          {view === "ports" && (
            <label className="proc-auto-refresh">
              <input
                type="checkbox"
                checked={groupByProc}
                onChange={(e) => setGroupByProc(e.target.checked)}
              />
              按进程分组
            </label>
          )}
        </div>

        {error && <div className="tools-error">{error}</div>}

        <div className="proc-count">
          {view === "ports"
            ? `${shownPorts.length} / ${ports.length} 个端口`
            : `${shownProcs.length} / ${procs.length} 个进程`}
        </div>

        <div className="proc-table-wrap">
          {view === "ports" ? (
            groupByProc ? (
              // 分组视图
              <table className="proc-table">
                <thead>
                  <tr>
                    <th className="proc-check-col"><input type="checkbox" checked={visiblePids.length > 0 && visiblePids.every((p) => selected.includes(p))} onChange={() => { const all = visiblePids; setSelected((prev) => (prev.length === all.length ? [] : all)); }} aria-label="全选" /></th>
                    {sortTh("port", "端口")}
                    {sortTh("state", "状态")}
                    {sortTh("pid", "PID")}
                    {sortTh("process_name", "进程")}
                    {sortTh("memory_kb", "内存")}
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {portGroups.map((g) => (
                    <Fragment key={g.pid}>
                      <tr className="proc-group-header">
                        <td colSpan={7}>
                          {g.name} ({g.pid}) — {g.rows.length} 个端口
                        </td>
                      </tr>
                      {g.rows.map((p) => (
                        <tr key={`${p.protocol}-${p.local_addr}-${p.port}-${p.foreign_addr}-${p.pid}`}>
                          {selectCell(p.pid)}
                          <td className="proc-mono proc-port">{p.port}</td>
                          <td className={portStateClass(p.state) || undefined}>{p.state || "—"}</td>
                          <td className="proc-mono">{p.pid}</td>
                          <td className="proc-name-cell" title={p.process_name}>{p.process_name || "—"}</td>
                          <td className="proc-mono">{fmtMem(p.memory_kb)}</td>
                          <td>
                            {actionBtns(p.pid, String(p.port))}
                            {killCell(p.pid, p.process_name || String(p.pid))}
                          </td>
                        </tr>
                      ))}
                    </Fragment>
                  ))}
                  {!loading && portGroups.length === 0 && (
                    <tr><td colSpan={7} className="proc-empty">无匹配端口</td></tr>
                  )}
                </tbody>
              </table>
            ) : (
              // 端口视图（展开）
              <table className="proc-table">
                <thead>
                  <tr>
                    <th className="proc-check-col"><input type="checkbox" checked={visiblePids.length > 0 && visiblePids.every((p) => selected.includes(p))} onChange={() => { const all = visiblePids; setSelected((prev) => (prev.length === all.length ? [] : all)); }} aria-label="全选" /></th>
                    <th>协议</th>
                    <th>本地地址</th>
                    {sortTh("port", "端口")}
                    {sortTh("state", "状态")}
                    {sortTh("pid", "PID")}
                    {sortTh("process_name", "进程")}
                    {sortTh("memory_kb", "内存")}
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {shownPorts.map((p) => (
                    <tr key={`${p.protocol}-${p.local_addr}-${p.port}-${p.foreign_addr}-${p.pid}`}>
                      {selectCell(p.pid)}
                      <td>{p.protocol}</td>
                      <td className="proc-mono">{p.local_addr}</td>
                      <td className="proc-mono proc-port">{p.port}</td>
                      <td className={portStateClass(p.state) || undefined}>{p.state || "—"}</td>
                      <td className="proc-mono">{p.pid}</td>
                      <td className="proc-name-cell" title={p.process_name}>{p.process_name || "—"}</td>
                      <td className="proc-mono">{fmtMem(p.memory_kb)}</td>
                      <td>
                        {actionBtns(p.pid, String(p.port))}
                        {killCell(p.pid, p.process_name || String(p.pid))}
                      </td>
                    </tr>
                  ))}
                  {!loading && shownPorts.length === 0 && (
                    <tr><td colSpan={9} className="proc-empty">无匹配端口</td></tr>
                  )}
                </tbody>
              </table>
            )
          ) : (
            <table className="proc-table">
              <thead>
                <tr>
                  <th className="proc-check-col"><input type="checkbox" checked={visiblePids.length > 0 && visiblePids.every((p) => selected.includes(p))} onChange={() => { const all = visiblePids; setSelected((prev) => (prev.length === all.length ? [] : all)); }} aria-label="全选" /></th>
                  {sortTh("name", "进程名")}
                  {sortTh("pid", "PID")}
                  {sortTh("memory_kb", "内存")}
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {shownProcs.map((p) => (
                  <tr key={p.pid}>
                    {selectCell(p.pid)}
                    <td className="proc-name-cell" title={p.name}>{p.name}</td>
                    <td className="proc-mono">{p.pid}</td>
                    <td className="proc-mono">{fmtMem(p.memory_kb)}</td>
                    <td>
                      {actionBtns(p.pid, String(p.pid))}
                      {killCell(p.pid, p.name)}
                    </td>
                  </tr>
                ))}
                {!loading && shownProcs.length === 0 && (
                  <tr><td colSpan={5} className="proc-empty">无匹配进程</td></tr>
                )}
              </tbody>
            </table>
          )}
        </div>

        {/* 批量操作栏 */}
        {selected.length > 0 && (
          <div className="proc-batch-bar">
            <span>已选 {selected.length} 项</span>
            {!pendingBatch ? (
              <>
                <button className="copy-btn proc-danger" onClick={() => { setPendingBatch(true); }}>
                  批量结束
                </button>
                <button className="copy-btn" onClick={() => { setSelected([]); setPendingBatch(false); }}>
                  取消选择
                </button>
              </>
            ) : (
              <>
                <button className="copy-btn proc-danger" onClick={() => void killMany(selected, false)}>
                  确认结束
                </button>
                <button className="copy-btn proc-danger" onClick={() => void killMany(selected, true)}>
                  强制结束
                </button>
                <button className="copy-btn" onClick={() => setPendingBatch(false)}>
                  取消
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {toast && <div className={`tools-toast tools-toast-${toast.type}`}>{toast.msg}</div>}
    </div>
  );
}

/* =============================================================
 * Main
 * ============================================================= */

type Tab = "timestamp" | "cron" | "regex" | "ip" | "proxy" | "process";

const TABS: { id: Tab; label: string; icon: ReactNode }[] = [
  { id: "timestamp", label: "时间戳", icon: <IconClock /> },
  { id: "cron",      label: "Cron",   icon: <IconSettings /> },
  { id: "regex",     label: "正则",   icon: <IconSearch /> },
  { id: "ip",        label: "IP 查询", icon: <IconGlobe /> },
  { id: "proxy",     label: "代理",   icon: <IconShuffle /> },
  { id: "process",   label: "进程端口", icon: <IconPuzzle /> },
];

export default function ToolsApp() {
  useTheme();
  const [tab, setTab] = useState<Tab>("timestamp");
  // 页面是否可见。用 state 承载而不是在渲染期读 document.visibilityState —— 后者
  // 不是响应式源，放进 effect 依赖也不会触发重跑，定时器就永远收敛不了。
  const [visible, setVisible] = useState(() => document.visibilityState === "visible");
  const [proxyState, setProxyState] = useState<ProxyState>({
    port: 10880,
    isRunning: false,
    defaultTarget: "http://localhost:8080",
    routes: [],
    logs: [],
    requestLogs: [],
    allowLan: false,
  });

  useEffect(() => {
    const onVisibility = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  // Intercept window close: hide instead of destroy so it can be reopened
  useEffect(() => {
    const win = getCurrentWindow();
    const unlistenClose = win.onCloseRequested((event) => {
      event.preventDefault();
      win.hide();
      // WebView2 下 win.hide() 不保证触发 visibilitychange，所以这里手动置为
      // 不可见，否则窗口藏起来后计时器/轮询还在跑。
      setVisible(false);
    });
    // 重新显示时（托盘/快捷键）会拿到焦点，借此恢复可见。
    // 只处理 focused === true：失焦不等于不可见（用户可能只是切到别的应用，
    // 窗口仍在屏幕上），那时把时间戳停掉会显示成过期值。
    const unlistenFocus = win.onFocusChanged(({ payload: focused }) => {
      if (focused) setVisible(true);
    });
    return () => {
      unlistenClose.then((fn) => fn());
      unlistenFocus.then((fn) => fn());
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
          allowLan: cfg.allow_lan,
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
        {tab === "timestamp" && <TimestampTab visible={visible} />}
        {tab === "cron" && <CronTab />}
        {tab === "regex" && <RegexTab />}
        {tab === "ip" && <IpTab />}
        {tab === "proxy" && (
          <ProxyTab state={proxyState} setState={setProxyState} visible={visible} />
        )}
        {tab === "process" && <ProcessTab />}
      </div>
    </div>
  );
}
