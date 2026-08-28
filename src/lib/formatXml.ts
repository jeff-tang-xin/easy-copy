/**
 * 零依赖的 XML / HTML 美化与压缩模块（纯函数，无任何 import）。
 *
 * 为什么不用 DOMParser + XMLSerializer：
 *  1. DOMParser 在遇到非法 XML 时只给出一段浏览器自造的 parsererror HTML，
 *     拿不到稳定的行列号，而工具面板需要把错误定位给用户看；
 *  2. 序列化会重排属性、丢掉注释里的原始空白、把 CDATA 展平成转义文本；
 *  3. text/html 与 text/xml 两种 mimeType 对片段（没有 <html> 根）的补全行为
 *     完全不同，同一份输入在两个模式下结果不可预测。
 * 所以这里手写一个轻量扫描器：只做词法切分，不建 DOM，输出时逐 token 拼字符串，
 * 原文里的敏感区域（注释 / CDATA / 声明 / pre 类元素）整段搬运，做到"不认识就别动"。
 */

/** 格式化结果。ok=false 时 text 保持输入原样，避免把半成品写回编辑器。 */
export interface XmlFormatResult {
  ok: boolean;
  text: string;
  /** 仅在 ok === false 时有意义；1-based，0 表示位置未知 */
  line: number;
  column: number;
  message: string;
}

/**
 * HTML void 元素：规范规定它们没有内容也不需要闭合标签，
 * 所以 `<br>`（没有斜杠）也必须按自闭合处理，否则后面所有兄弟节点都会被
 * 错误地缩进到 br 里面去，并且在文件末尾误报"标签未闭合"。
 */
const HTML_VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

/**
 * 这些元素内部的空白有语义（pre/textarea）或内容根本不是标记语言
 * （script/style 里的 `a < b`、`</div>` 字符串会把普通扫描器带偏），
 * 因此一旦进入就用"找配对结束标签"的方式整段原样截取。
 */
const HTML_RAW_TEXT_ELEMENTS = new Set(["pre", "textarea", "script", "style"]);

/**
 * HTML 里可以隐式闭合的元素：遇到同名或指定的后继开标签时，
 * 上一个未闭合的同类元素自动结束。这里只覆盖最常见的一批，
 * 目的不是做完整的 HTML5 tree construction，而是保证 `<ul><li>a<li>b</ul>`
 * 这类真实网页片段不会被判成错误。
 */
const HTML_IMPLIED_END: Record<string, Set<string>> = {
  li: new Set(["li"]),
  dt: new Set(["dt", "dd"]),
  dd: new Set(["dt", "dd"]),
  p: new Set([
    "address",
    "article",
    "aside",
    "blockquote",
    "div",
    "dl",
    "fieldset",
    "footer",
    "form",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "header",
    "hr",
    "main",
    "nav",
    "ol",
    "p",
    "pre",
    "section",
    "table",
    "ul",
  ]),
  option: new Set(["option", "optgroup"]),
  optgroup: new Set(["optgroup"]),
  thead: new Set(["tbody", "tfoot"]),
  tbody: new Set(["tbody", "tfoot"]),
  tr: new Set(["tr"]),
  td: new Set(["td", "th", "tr"]),
  th: new Set(["td", "th", "tr"]),
};

/** 超过这个长度的纯文本不再内联在开闭标签之间，避免出现超长行。 */
const INLINE_TEXT_MAX = 80;

/** 词法单元。raw 一律保存原文切片，输出时能直接搬运。 */
type Token =
  | { kind: "open"; name: string; raw: string; start: number; selfClosing: boolean }
  | { kind: "close"; name: string; raw: string; start: number }
  | { kind: "text"; raw: string; start: number }
  | { kind: "comment"; raw: string; start: number }
  | { kind: "cdata"; raw: string; start: number }
  | { kind: "decl"; raw: string; start: number };

/** 扫描过程中的致命错误：带上原始 offset，最后统一换算成行列。 */
interface ScanError {
  offset: number;
  message: string;
}

type ScanResult = { ok: true; tokens: Token[] } | { ok: false; error: ScanError };

/** offset → 1-based 行列。offset 越界时钳制到合法范围，保证永远返回可用数字。 */
function toLineColumn(src: string, offset: number): { line: number; column: number } {
  const limit = Math.max(0, Math.min(offset, src.length));
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < limit; i += 1) {
    if (src.charCodeAt(i) === 10 /* \n */) {
      line += 1;
      lineStart = i + 1;
    }
  }
  return { line, column: limit - lineStart + 1 };
}

function fail(src: string, error: ScanError): XmlFormatResult {
  const pos = toLineColumn(src, error.offset);
  // text 返回原始输入：格式化失败时不能让调用方拿到被截断的半成品。
  return { ok: false, text: src, line: pos.line, column: pos.column, message: error.message };
}

function isWhitespaceOnly(text: string): boolean {
  return text.trim().length === 0;
}

/** 把连续空白（含换行）折叠成单个空格，这是混合内容里唯一安全的规范化。 */
function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ");
}

/** 标签名首字符：XML 允许字母、下划线、冒号（命名空间前缀）。 */
function isNameStart(ch: string): boolean {
  return /[A-Za-z_:]/.test(ch);
}

function isNameChar(ch: string): boolean {
  return /[A-Za-z0-9_:.\-]/.test(ch);
}

/** 从 from 处读出标签名，返回名字与结束位置（不含结束位置字符）。 */
function readName(src: string, from: number): { name: string; end: number } {
  let i = from;
  while (i < src.length && isNameChar(src[i])) {
    i += 1;
  }
  return { name: src.slice(from, i), end: i };
}

/**
 * 找到标签的结束 `>`，返回其下标；找不到返回 -1。
 *
 * 踩坑点：必须跟踪引号状态。`<a title="a > b">` 里的第一个 `>` 在双引号内，
 * 如果直接 indexOf(">") 会把标签切断成 `<a title="a >`，
 * 后面的 ` b">` 变成文本，属性丢失且极易连锁误报。
 * 单引号同理（`title='a > b'`），且引号内的另一种引号不算引号边界。
 */
function findTagEnd(src: string, from: number): number {
  let quote = "";
  for (let i = from; i < src.length; i += 1) {
    const ch = src[i];
    if (quote) {
      if (ch === quote) {
        quote = "";
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ">") {
      return i;
    }
  }
  return -1;
}

/**
 * 判断开标签的原文是否以 `/>` 结尾。
 * 不能简单看倒数第二个字符，因为 `<a href="x/">` 的斜杠在引号里，
 * 但那种情况下斜杠不会紧贴 `>`——真正安全的做法是跳过尾部空白后看一个字符，
 * 并且确认这个斜杠不在引号内（findTagEnd 已经保证 `>` 在引号外，
 * 故紧贴 `>` 的 `/` 必然也在引号外）。
 */
function endsSelfClosing(tagBody: string): boolean {
  let i = tagBody.length - 1;
  while (i >= 0 && /\s/.test(tagBody[i])) {
    i -= 1;
  }
  return i >= 0 && tagBody[i] === "/";
}

/**
 * 把源码切成 token 序列。这里只做词法层的合法性检查
 * （未结束的注释 / CDATA / 标签、`<` 后跟非法字符），
 * 标签配对留给 buildDocument 处理，职责分开后两边都好读。
 */
function scan(src: string, isHtml: boolean): ScanResult {
  const tokens: Token[] = [];
  let i = 0;

  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt < 0) {
      tokens.push({ kind: "text", raw: src.slice(i), start: i });
      break;
    }
    if (lt > i) {
      tokens.push({ kind: "text", raw: src.slice(i, lt), start: i });
    }

    // 注释：内部可以出现任意 < 与 >，只有 --> 能终止它，所以整段搬运。
    if (src.startsWith("<!--", lt)) {
      const end = src.indexOf("-->", lt + 4);
      if (end < 0) {
        return { ok: false, error: { offset: lt, message: "注释未闭合，缺少 -->" } };
      }
      tokens.push({ kind: "comment", raw: src.slice(lt, end + 3), start: lt });
      i = end + 3;
      continue;
    }

    // CDATA：内容按定义是纯字符数据，绝对不能转义或重排，原样保留。
    if (src.startsWith("<![CDATA[", lt)) {
      const end = src.indexOf("]]>", lt + 9);
      if (end < 0) {
        return { ok: false, error: { offset: lt, message: "CDATA 段未闭合，缺少 ]]>" } };
      }
      tokens.push({ kind: "cdata", raw: src.slice(lt, end + 3), start: lt });
      i = end + 3;
      continue;
    }

    // 处理指令与 XML 声明：<?xml ... ?> / <?php ... ?>，同样整段保留。
    if (src.startsWith("<?", lt)) {
      const end = src.indexOf("?>", lt + 2);
      if (end < 0) {
        return { ok: false, error: { offset: lt, message: "处理指令未闭合，缺少 ?>" } };
      }
      tokens.push({ kind: "decl", raw: src.slice(lt, end + 2), start: lt });
      i = end + 2;
      continue;
    }

    // DOCTYPE 等 <! 开头的声明：内部可能带引号（<!DOCTYPE x SYSTEM "a>b">），
    // 所以复用带引号跟踪的 findTagEnd 而不是 indexOf。
    if (src.startsWith("<!", lt)) {
      const end = findTagEnd(src, lt + 2);
      if (end < 0) {
        return { ok: false, error: { offset: lt, message: "声明未闭合，缺少 >" } };
      }
      tokens.push({ kind: "decl", raw: src.slice(lt, end + 1), start: lt });
      i = end + 1;
      continue;
    }

    // 结束标签
    if (src[lt + 1] === "/") {
      const named = readName(src, lt + 2);
      if (!named.name || !isNameStart(src[lt + 2] ?? "")) {
        return { ok: false, error: { offset: lt + 2, message: "结束标签缺少合法的标签名" } };
      }
      const end = findTagEnd(src, named.end);
      if (end < 0) {
        return {
          ok: false,
          error: { offset: lt, message: `结束标签 </${named.name} 未闭合，缺少 >` },
        };
      }
      tokens.push({
        kind: "close",
        name: normalizeName(named.name, isHtml),
        raw: src.slice(lt, end + 1),
        start: lt,
      });
      i = end + 1;
      continue;
    }

    // 开标签 / 自闭合标签
    if (!isNameStart(src[lt + 1] ?? "")) {
      // 裸露的 `<`（如 `a < b`）在 XML 里是硬错误，必须写成 &lt;。
      return {
        ok: false,
        error: { offset: lt, message: "`<` 后出现非法字符，标签名必须以字母、下划线或冒号开头" },
      };
    }
    const named = readName(src, lt + 1);
    const end = findTagEnd(src, named.end);
    if (end < 0) {
      return { ok: false, error: { offset: lt, message: `标签 <${named.name} 未闭合，缺少 >` } };
    }
    const raw = src.slice(lt, end + 1);
    const name = normalizeName(named.name, isHtml);
    const selfClosing = endsSelfClosing(src.slice(named.end, end)) || (isHtml && isVoid(name));
    tokens.push({ kind: "open", name, raw, start: lt, selfClosing });
    i = end + 1;

    // script/style/pre/textarea：内部内容不按标记语言解析，整段吃到配对结束标签。
    if (isHtml && !selfClosing && HTML_RAW_TEXT_ELEMENTS.has(name)) {
      const consumed = consumeRawText(src, i, name);
      if (!consumed.ok) {
        return { ok: false, error: consumed.error };
      }
      if (consumed.text) {
        tokens.push({ kind: "text", raw: consumed.text, start: i });
      }
      tokens.push({ kind: "close", name, raw: consumed.closeRaw, start: consumed.closeStart });
      i = consumed.next;
    }
  }

  return { ok: true, tokens };
}

/** HTML 标签名大小写不敏感，统一转小写后配对逻辑才不会把 `<DIV></div>` 判成错。 */
function normalizeName(name: string, isHtml: boolean): string {
  return isHtml ? name.toLowerCase() : name;
}

function isVoid(name: string): boolean {
  return HTML_VOID_ELEMENTS.has(name);
}

type RawTextResult =
  | { ok: true; text: string; closeRaw: string; closeStart: number; next: number }
  | { ok: false; error: ScanError };

/** 从 from 开始找 `</name`，中间内容不做任何解析地取出。 */
function consumeRawText(src: string, from: number, name: string): RawTextResult {
  const lower = src.toLowerCase();
  const needle = `</${name}`;
  const found = lower.indexOf(needle, from);
  if (found < 0) {
    return { ok: false, error: { offset: from, message: `<${name}> 缺少对应的结束标签` } };
  }
  const end = findTagEnd(src, found + needle.length);
  if (end < 0) {
    return { ok: false, error: { offset: found, message: `结束标签 </${name} 未闭合，缺少 >` } };
  }
  return {
    ok: true,
    text: src.slice(from, found),
    closeRaw: src.slice(found, end + 1),
    closeStart: found,
    next: end + 1,
  };
}

/** 文档树节点。element 保留开闭标签原文，输出时直接搬运，属性不会被重排。 */
type Node =
  | {
      kind: "element";
      name: string;
      openRaw: string;
      closeRaw: string;
      selfClosing: boolean;
      /** true 表示子内容是 pre/script/style/textarea 的原始文本，禁止重新缩进 */
      preserve: boolean;
      children: Node[];
    }
  | { kind: "text"; raw: string }
  | { kind: "verbatim"; raw: string };

interface OpenFrame {
  name: string;
  openRaw: string;
  start: number;
  preserve: boolean;
  children: Node[];
}

type BuildResult = { ok: true; roots: Node[] } | { ok: false; error: ScanError };

/**
 * 由 token 序列组装文档树，同时完成标签配对校验。
 * 用显式栈而不是递归：输入可能是几万行的机器生成 XML，递归容易爆栈。
 */
function buildDocument(tokens: Token[], isHtml: boolean): BuildResult {
  const roots: Node[] = [];
  const stack: OpenFrame[] = [];

  const currentChildren = (): Node[] => (stack.length ? stack[stack.length - 1].children : roots);

  const closeFrame = (closeRaw: string): void => {
    const frame = stack.pop();
    if (!frame) {
      return;
    }
    currentChildren().push({
      kind: "element",
      name: frame.name,
      openRaw: frame.openRaw,
      closeRaw,
      selfClosing: false,
      preserve: frame.preserve,
      children: frame.children,
    });
  };

  for (const token of tokens) {
    switch (token.kind) {
      case "open": {
        // HTML 隐式闭合：<li>a<li>b 里第二个 <li> 会终结第一个，
        // 不处理的话整篇文档会被越缩越深，且末尾误报未闭合。
        if (isHtml) {
          while (stack.length) {
            const top = stack[stack.length - 1].name;
            if (HTML_IMPLIED_END[top]?.has(token.name)) {
              closeFrame("");
            } else {
              break;
            }
          }
        }
        if (token.selfClosing) {
          // 自闭合不入栈，因此不产生缩进层级。
          currentChildren().push({
            kind: "element",
            name: token.name,
            openRaw: token.raw,
            closeRaw: "",
            selfClosing: true,
            preserve: false,
            children: [],
          });
        } else {
          stack.push({
            name: token.name,
            openRaw: token.raw,
            start: token.start,
            preserve: isHtml && HTML_RAW_TEXT_ELEMENTS.has(token.name),
            children: [],
          });
        }
        break;
      }
      case "close": {
        // </br> 这类 void 元素的多余结束标签：浏览器会忽略，这里也忽略，
        // 否则常见的手写 HTML 会被判成"有闭无开"。
        if (isHtml && isVoid(token.name)) {
          break;
        }
        const depth = findOpenDepth(stack, token.name);
        if (depth < 0) {
          return {
            ok: false,
            error: {
              offset: token.start,
              message: `结束标签 </${token.name}> 没有对应的开始标签`,
            },
          };
        }
        if (depth !== stack.length - 1) {
          const unclosed = stack[stack.length - 1];
          if (!isHtml) {
            return {
              ok: false,
              error: {
                offset: token.start,
                message: `结束标签 </${token.name}> 与最近的开始标签 <${unclosed.name}> 不匹配`,
              },
            };
          }
          // HTML 容错：把中间没闭合的元素依次收掉再闭合目标元素。
          while (stack.length - 1 > depth) {
            closeFrame("");
          }
        }
        closeFrame(token.raw);
        break;
      }
      case "text": {
        currentChildren().push({ kind: "text", raw: token.raw });
        break;
      }
      default: {
        // 注释 / CDATA / 声明：一律原样搬运，独占一行。
        currentChildren().push({ kind: "verbatim", raw: token.raw });
        break;
      }
    }
  }

  if (stack.length) {
    const unclosed = stack[stack.length - 1];
    return {
      ok: false,
      error: { offset: unclosed.start, message: `标签 <${unclosed.name}> 没有对应的结束标签` },
    };
  }
  return { ok: true, roots };
}

/** 在栈中自顶向下找同名开标签，返回其下标；找不到返回 -1。 */
function findOpenDepth(stack: OpenFrame[], name: string): number {
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    if (stack[i].name === name) {
      return i;
    }
  }
  return -1;
}

/** 丢弃纯空白文本节点：XML 的排版空白不携带信息，保留会让缩进无法重建。 */
function meaningfulChildren(children: Node[]): Node[] {
  return children.filter((child) => child.kind !== "text" || !isWhitespaceOnly(child.raw));
}

/** 判断能否内联成一行：唯一子节点是短文本时才内联，如 <title>Hello</title>。 */
function canInline(children: Node[]): boolean {
  if (children.length !== 1) {
    return false;
  }
  const only = children[0];
  if (only.kind !== "text") {
    return false;
  }
  const text = collapseWhitespace(only.raw).trim();
  return text.length <= INLINE_TEXT_MAX;
}

/**
 * 混合内容：既有有意义的文本、又有元素的子节点序列（如 `<p>a <b>c</b> d</p>`）。
 *
 * 这类内容里标签之间的空白是**有语义的**：把 `<c>text <i>x</i> tail</c>`
 * 拆成多行缩进，会在 text 前后引入原本不存在的换行与空格，渲染时多出空白，
 * 再次压缩也无法还原（实测 round-trip 得到 `<c> text <i>x</i> tail </c>`）。
 * 所以一旦识别为混合内容就整段原样单行输出，宁可行长一点也不改变语义。
 */
function hasMixedContent(children: Node[]): boolean {
  let text = false;
  let element = false;
  for (const child of children) {
    if (child.kind === "text") {
      text = true;
    } else if (child.kind === "element") {
      element = true;
    }
    if (text && element) {
      return true;
    }
  }
  return false;
}

/** 递归还原子树原文，用于混合内容与 preserve 元素的整段搬运。 */
function inlineRaw(nodes: Node[]): string {
  let out = "";
  for (const node of nodes) {
    if (node.kind === "element") {
      out += node.openRaw;
      if (!node.selfClosing) {
        out += inlineRaw(node.children) + closeTagOf(node);
      }
    } else {
      out += node.raw;
    }
  }
  return out;
}

/** 美化输出：缩进只由元素层级决定，原文的换行位置全部丢弃后重建。 */
function printNodes(nodes: Node[], depth: number, pad: string, out: string[]): void {
  const prefix = pad.repeat(depth);
  for (const node of meaningfulChildren(nodes)) {
    if (node.kind === "verbatim") {
      out.push(prefix + node.raw);
      continue;
    }
    if (node.kind === "text") {
      // 混合内容里的文本：折叠空白后按当前层级另起一行。
      out.push(prefix + collapseWhitespace(node.raw).trim());
      continue;
    }
    if (node.selfClosing) {
      out.push(prefix + node.openRaw);
      continue;
    }
    if (node.preserve) {
      // pre/script/style/textarea：内部原样输出，一个字符都不动。
      const inner = node.children.map((child) => rawOf(child)).join("");
      out.push(prefix + node.openRaw + inner + closeTagOf(node));
      continue;
    }
    const kids = meaningfulChildren(node.children);
    if (kids.length === 0) {
      out.push(prefix + node.openRaw + closeTagOf(node));
      continue;
    }
    if (canInline(kids)) {
      const text = collapseWhitespace(rawOf(kids[0])).trim();
      out.push(prefix + node.openRaw + text + closeTagOf(node));
      continue;
    }
    // 混合内容整段单行输出：换行会改变渲染结果，见 hasMixedContent 注释。
    if (hasMixedContent(kids)) {
      out.push(prefix + node.openRaw + inlineRaw(node.children).trim() + closeTagOf(node));
      continue;
    }
    out.push(prefix + node.openRaw);
    printNodes(kids, depth + 1, pad, out);
    out.push(prefix + closeTagOf(node));
  }
}

/** 缺失的结束标签（HTML 隐式闭合场景）补成规范形式，保证输出可再次解析。 */
function closeTagOf(node: Extract<Node, { kind: "element" }>): string {
  return node.closeRaw || `</${node.name}>`;
}

function rawOf(node: Node): string {
  return node.kind === "element" ? node.openRaw : node.raw;
}

/** 压缩输出：去掉标签之间的排版空白，但保留文本节点内部至少一个空格。 */
function printMinified(nodes: Node[], out: string[]): void {
  for (const node of meaningfulChildren(nodes)) {
    if (node.kind === "verbatim") {
      out.push(node.raw);
      continue;
    }
    if (node.kind === "text") {
      // 折叠但不 trim：`<b> x </b>` 里的空格可能是词间分隔，删掉会把单词粘连。
      out.push(collapseWhitespace(node.raw));
      continue;
    }
    if (node.selfClosing) {
      out.push(node.openRaw);
      continue;
    }
    out.push(node.openRaw);
    if (node.preserve) {
      out.push(node.children.map((child) => rawOf(child)).join(""));
    } else if (hasMixedContent(meaningfulChildren(node.children))) {
      // 混合内容：标签间空白有语义，只折叠不删除，也不递归重排。
      out.push(collapseWhitespace(inlineRaw(node.children)));
    } else {
      printMinified(node.children, out);
    }
    out.push(closeTagOf(node));
  }
}

/** 三个导出函数共用的前置流程：空白短路 + 扫描 + 建树。 */
type PrepareResult = { ok: true; roots: Node[] } | { ok: false; result: XmlFormatResult };

function prepare(src: string, isHtml: boolean): PrepareResult {
  if (isWhitespaceOnly(src)) {
    // 空输入不算错误，直接给空结果，免得每个调用方都自己判空。
    return { ok: false, result: { ok: true, text: "", line: 0, column: 0, message: "" } };
  }
  const scanned = scan(src, isHtml);
  if (!scanned.ok) {
    return { ok: false, result: fail(src, scanned.error) };
  }
  const built = buildDocument(scanned.tokens, isHtml);
  if (!built.ok) {
    return { ok: false, result: fail(src, built.error) };
  }
  return { ok: true, roots: built.roots };
}

function success(text: string): XmlFormatResult {
  return { ok: true, text, line: 0, column: 0, message: "" };
}

/**
 * 美化：按 indent 个空格重建缩进。
 * indent 钳制到 0..8，防止调用方传入 NaN 或巨大值产生不可用的输出。
 */
export function formatXml(src: string, indent: number, isHtml?: boolean): XmlFormatResult {
  const prepared = prepare(src, isHtml === true);
  if (!prepared.ok) {
    return prepared.result;
  }
  const width = Number.isFinite(indent) ? Math.max(0, Math.min(8, Math.trunc(indent))) : 2;
  const lines: string[] = [];
  printNodes(prepared.roots, 0, " ".repeat(width), lines);
  return success(lines.join("\n"));
}

/** 压缩：删除标签之间的排版空白，注释与 CDATA 仍原样保留。 */
export function minifyXml(src: string, isHtml?: boolean): XmlFormatResult {
  const prepared = prepare(src, isHtml === true);
  if (!prepared.ok) {
    return prepared.result;
  }
  const parts: string[] = [];
  printMinified(prepared.roots, parts);
  return success(parts.join(""));
}

/** 只校验不改内容：成功时 text 回传原文，方便"校验通过"后继续编辑。 */
export function validateXml(src: string, isHtml?: boolean): XmlFormatResult {
  const prepared = prepare(src, isHtml === true);
  if (!prepared.ok) {
    return prepared.result;
  }
  return success(src);
}
