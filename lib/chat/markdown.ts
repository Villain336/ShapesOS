// ShapesOS — Phase 22 (chat): a small markdown parser for the transcript
// (PURE: no React, no DOM, no dependencies).
//
// Why not a library: react-markdown 10 + remark-gfm are already in
// node_modules (under CopilotKit) but at the root the hoisted copy is
// react-markdown 8, and pinning 10 would upgrade five hoisted packages that
// other worktrees hard-link (the Phase 22 brief forbids that). This parser
// covers what the agent writes — paragraphs, headings, emphasis, inline code,
// links, bullet / numbered / task lists (one nesting level), fenced code,
// GFM tables, block quotes, rules — and is SAFE BY CONSTRUCTION: it never
// produces markup, so raw HTML in the model's text is text; links keep only
// http(s), mailto and in-app paths (safeHref). components/chat/Markdown.tsx
// renders the tree with React elements (no dangerouslySetInnerHTML).

export type MdInline =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "strong"; c: MdInline[] }
  | { t: "em"; c: MdInline[] }
  | { t: "link"; href: string; c: MdInline[] }
  | { t: "br" };

export type MdAlign = "left" | "center" | "right" | null;

export type MdBlock =
  | { t: "p"; c: MdInline[] }
  | { t: "h"; level: 1 | 2 | 3 | 4 | 5 | 6; c: MdInline[] }
  | { t: "ul"; items: MdBlock[][]; checks?: Array<boolean | null> }
  | { t: "ol"; start: number; items: MdBlock[][] }
  | { t: "code"; lang: string | null; v: string }
  | { t: "quote"; c: MdBlock[] }
  | { t: "table"; head: MdInline[][]; align: MdAlign[]; rows: MdInline[][][] }
  | { t: "hr" };

/** A link target the transcript may render; null = show the text only. */
export function safeHref(href: string): string | null {
  const h = href.trim();
  if (!h || /[\u0000-\u001f\s]/.test(h)) return null;
  if (h.startsWith("//") || h.includes("\\")) return null;
  if (h.startsWith("/")) return h.length <= 2000 ? h : null;
  if (/^https?:\/\//i.test(h)) return h.length <= 2000 ? h : null;
  if (/^mailto:[^\s]+@[^\s]+$/i.test(h)) return h;
  return null;
}

// ── inline ───────────────────────────────────────────────────────────────────

function pushText(out: MdInline[], v: string): void {
  if (!v) return;
  const last = out[out.length - 1];
  if (last?.t === "text") last.v += v;
  else out.push({ t: "text", v });
}

/** Parse inline markdown; `stop` is the closing delimiter of an enclosing span (returns at it). */
function parseInline(src: string, start: number, stop: string | null): { nodes: MdInline[]; end: number } {
  const out: MdInline[] = [];
  let i = start;
  let buf = "";
  const flush = () => {
    pushText(out, buf);
    buf = "";
  };
  while (i < src.length) {
    if (stop && src.startsWith(stop, i)) {
      flush();
      return { nodes: out, end: i + stop.length };
    }
    const ch = src[i]!;
    if (ch === "\\" && i + 1 < src.length && /[\\`*_\[\]()#>|~-]/.test(src[i + 1]!)) {
      buf += src[i + 1];
      i += 2;
      continue;
    }
    if (ch === "\n") {
      flush();
      out.push({ t: "br" });
      i++;
      continue;
    }
    if (ch === "`") {
      const close = src.indexOf("`", i + 1);
      if (close > i + 1 || close === i + 1) {
        const v = src.slice(i + 1, close);
        if (v.length) {
          flush();
          out.push({ t: "code", v });
          i = close + 1;
          continue;
        }
      }
      buf += ch;
      i++;
      continue;
    }
    if (ch === "[") {
      const link = parseLink(src, i);
      if (link) {
        flush();
        const href = safeHref(link.href);
        if (href) out.push({ t: "link", href, c: link.c });
        else out.push(...link.c);
        i = link.end;
        continue;
      }
      buf += ch;
      i++;
      continue;
    }
    if (ch === "*" || ch === "_") {
      const double = src[i + 1] === ch;
      const mark = double ? ch + ch : ch;
      const next = src[i + mark.length];
      // An opener must be followed by a non-space and have a closer later on the same paragraph.
      if (next && !/\s/.test(next) && (!double || true)) {
        const close = findCloser(src, i + mark.length, mark);
        if (close > 0) {
          const inner = parseInline(src.slice(0, close), i + mark.length, null).nodes;
          flush();
          out.push(double ? { t: "strong", c: inner } : { t: "em", c: inner });
          i = close + mark.length;
          continue;
        }
      }
      buf += mark;
      i += mark.length;
      continue;
    }
    buf += ch;
    i++;
  }
  flush();
  return { nodes: out, end: i };
}

function findCloser(src: string, from: number, mark: string): number {
  let i = from;
  while (i < src.length) {
    if (src[i] === "`") {
      const close = src.indexOf("`", i + 1);
      if (close > 0) {
        i = close + 1;
        continue;
      }
    }
    if (src.startsWith(mark, i) && !/\s/.test(src[i - 1] ?? " ")) {
      // "**" inside a longer run ("***") is not a closer of a single mark.
      if (mark.length === 1 && src[i + 1] === mark) {
        i += 2;
        continue;
      }
      return i;
    }
    i++;
  }
  return -1;
}

function parseLink(src: string, at: number): { c: MdInline[]; href: string; end: number } | null {
  let depth = 0;
  let i = at;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) break;
    } else if (ch === "\n") return null;
  }
  if (i >= src.length || src[i + 1] !== "(") return null;
  // The target may hold balanced parentheses ("javascript:alert(1)" is then dropped by safeHref).
  let close = -1;
  let pd = 0;
  for (let j = i + 2; j < src.length; j++) {
    const ch = src[j];
    if (ch === "(") pd++;
    else if (ch === ")") {
      if (pd === 0) {
        close = j;
        break;
      }
      pd--;
    } else if (ch === "\n") break;
  }
  if (close < 0) return null;
  const href = src.slice(i + 2, close).trim().replace(/\s+"[^"]*"$/, "");
  const label = src.slice(at + 1, i);
  if (/[\s]/.test(href) && !href.startsWith("<")) return null;
  return { c: parseInline(label, 0, null).nodes, href: href.replace(/^<|>$/g, ""), end: close + 1 };
}

export function parseInlineMarkdown(src: string): MdInline[] {
  return parseInline(src, 0, null).nodes;
}

// ── blocks ───────────────────────────────────────────────────────────────────

const FENCE = /^\s{0,3}(```+|~~~+)\s*([\w+-]*)\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const NUMBER = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;
const TASK = /^\[([ xX])\]\s+(.*)$/;

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === "\\" && s[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (ch === "|") {
      cells.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

function alignOf(cell: string): MdAlign {
  const c = cell.trim();
  const left = c.startsWith(":");
  const right = c.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  if (left) return "left";
  return null;
}

/** Parse a whole markdown document into blocks. */
export function parseMarkdown(text: string): MdBlock[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  return parseBlocks(lines);
}

function parseBlocks(lines: string[]): MdBlock[] {
  const out: MdBlock[] = [];
  let i = 0;
  let para: string[] = [];
  const flushPara = () => {
    if (!para.length) return;
    out.push({ t: "p", c: parseInlineMarkdown(para.join("\n")) });
    para = [];
  };
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      flushPara();
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      flushPara();
      const marker = fence[1]![0]!;
      const body: string[] = [];
      i++;
      while (i < lines.length && !new RegExp(`^\\s{0,3}${marker === "`" ? "`{3,}" : "~{3,}"}\\s*$`).test(lines[i]!)) {
        body.push(lines[i]!);
        i++;
      }
      i++;
      out.push({ t: "code", lang: fence[2] || null, v: body.join("\n") });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flushPara();
      out.push({ t: "h", level: heading[1]!.length as 1 | 2 | 3 | 4 | 5 | 6, c: parseInlineMarkdown(heading[2]!) });
      i++;
      continue;
    }
    if (HR.test(line)) {
      flushPara();
      out.push({ t: "hr" });
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      flushPara();
      const inner: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i]!)) {
        inner.push(QUOTE.exec(lines[i]!)![1]!);
        i++;
      }
      out.push({ t: "quote", c: parseBlocks(inner) });
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]!) && lines[i + 1]!.includes("-")) {
      flushPara();
      const head = splitRow(line).map(parseInlineMarkdown);
      const align = splitRow(lines[i + 1]!).map(alignOf);
      i += 2;
      const rows: MdInline[][][] = [];
      while (i < lines.length && lines[i]!.trim() && lines[i]!.includes("|")) {
        rows.push(splitRow(lines[i]!).map(parseInlineMarkdown));
        i++;
      }
      out.push({ t: "table", head, align, rows });
      continue;
    }
    const bullet = BULLET.exec(line);
    const number = NUMBER.exec(line);
    if ((bullet || number) && (bullet?.[1] ?? number![1]!).length <= 3) {
      flushPara();
      const list = parseList(lines, i, bullet ? "ul" : "ol");
      out.push(list.block);
      i = list.next;
      continue;
    }
    para.push(line);
    i++;
  }
  flushPara();
  return out;
}

function parseList(lines: string[], start: number, kind: "ul" | "ol"): { block: MdBlock; next: number } {
  const items: MdBlock[][] = [];
  const checks: Array<boolean | null> = [];
  let i = start;
  let first: number | null = null;
  const re = kind === "ul" ? BULLET : NUMBER;
  const baseIndent = (re.exec(lines[i]!)![1] ?? "").length;
  while (i < lines.length) {
    const m = re.exec(lines[i]!);
    if (!m || (m[1] ?? "").length !== baseIndent) break;
    const body = kind === "ul" ? m[2]! : m[3]!;
    if (kind === "ol" && first === null) first = Number(m[2]);
    const contentIndent = baseIndent + (lines[i]!.length - body.length - baseIndent);
    const itemLines: string[] = [];
    const task = kind === "ul" ? TASK.exec(body) : null;
    itemLines.push(task ? task[2]! : body);
    checks.push(task ? task[1] !== " " : null);
    i++;
    // Continuation: lines indented past the marker (nested lists, wrapped text).
    while (i < lines.length) {
      const l = lines[i]!;
      if (!l.trim()) {
        // A blank line ends the item unless the next line is still indented.
        if (i + 1 < lines.length && /^\s{2,}\S/.test(lines[i + 1]!) && (lines[i + 1]!.match(/^\s*/)?.[0].length ?? 0) >= contentIndent) {
          itemLines.push("");
          i++;
          continue;
        }
        break;
      }
      const indent = l.match(/^\s*/)?.[0].length ?? 0;
      if (indent >= contentIndent || (indent > baseIndent && (BULLET.test(l) || NUMBER.test(l)))) {
        itemLines.push(l.slice(Math.min(indent, contentIndent)));
        i++;
        continue;
      }
      break;
    }
    items.push(parseBlocks(itemLines));
  }
  if (kind === "ul") {
    const anyTask = checks.some((c) => c !== null);
    return { block: anyTask ? { t: "ul", items, checks } : { t: "ul", items }, next: i };
  }
  return { block: { t: "ol", start: first ?? 1, items }, next: i };
}

/** Plain text of a markdown tree (search snippets, titles). */
export function markdownToText(blocks: readonly MdBlock[]): string {
  const inl = (c: readonly MdInline[]): string =>
    c.map((n) => (n.t === "text" || n.t === "code" ? n.v : n.t === "br" ? "\n" : inl(n.c))).join("");
  return blocks
    .map((b) => {
      switch (b.t) {
        case "p":
        case "h":
          return inl(b.c);
        case "ul":
        case "ol":
          return b.items.map((it) => markdownToText(it)).join("\n");
        case "code":
          return b.v;
        case "quote":
          return markdownToText(b.c);
        case "table":
          return [b.head, ...b.rows].map((r) => r.map(inl).join(" | ")).join("\n");
        case "hr":
          return "";
      }
    })
    .join("\n\n");
}
