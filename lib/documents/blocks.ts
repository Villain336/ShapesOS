// ShapesOS Phase 11 (seotools): document blocks — the one interchange the
// DOCX writer renders (PURE).
//
// Agents (create_document), Univer docs (lib/univer/export.ts) and anything
// else that produces a document hand over either markdown-ish text
// (markdownToDocBlocks) or blocks directly. Inline markup inside text:
// **bold**, *italic* / _italic_, `code`, [label](https://url).

export interface Inline {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  link?: string;
}

export type DocBlock =
  | { type: "heading"; level: 1 | 2 | 3; text: string }
  | { type: "paragraph"; text: string; /** Exact runs (no markup parsing) — Univer export. */ runs?: Inline[] }
  | { type: "bullet"; text: string; level?: number }
  | { type: "numbered"; text: string; level?: number }
  | { type: "quote"; text: string }
  | { type: "code"; text: string }
  | { type: "table"; rows: string[][]; header?: boolean }
  | { type: "divider" }
  | { type: "pageBreak" };

export const MAX_DOC_BLOCKS = 5_000;

const SAFE_LINK = /^(https?:|mailto:)/i;

/** Split text with **bold**, *italic*, _italic_, `code` and [label](url) into runs. */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  const re = /(\*\*([^*]+)\*\*|__([^_]+)__|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|\*([^*\s][^*]*)\*|(?<![A-Za-z0-9])_([^_\s][^_]*)_(?![A-Za-z0-9]))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    if (m[2] ?? m[3]) out.push({ text: (m[2] ?? m[3])!, bold: true });
    else if (m[4]) out.push({ text: m[4], code: true });
    else if (m[5]) out.push(SAFE_LINK.test(m[6]) ? { text: m[5], link: m[6] } : { text: m[5] });
    else if (m[7] ?? m[8]) out.push({ text: (m[7] ?? m[8])!, italic: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out.filter((r) => r.text.length > 0);
}

/** Inline markup removed (for spreadsheets, titles and plain-text fallbacks). */
export function plainText(text: string): string {
  return parseInline(text).map((r) => r.text).join("");
}

function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, "|"));
}

const TABLE_SEP = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

/** Markdown-ish text → blocks: headings, lists, quotes, fences, tables, rules. */
export function markdownToDocBlocks(markdown: string): DocBlock[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: DocBlock[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) {
      blocks.push({ type: "paragraph", text: para.join(" ").trim() });
      para = [];
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trimEnd();
    const t = line.trim();
    if (!t) {
      flush();
      continue;
    }
    const fence = /^(```|~~~)/.exec(t);
    if (fence) {
      flush();
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++]);
      blocks.push({ type: "code", text: body.join("\n") });
      continue;
    }
    if (/^(<!--\s*pagebreak\s*-->|\\pagebreak)$/i.test(t)) {
      flush();
      blocks.push({ type: "pageBreak" });
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) {
      flush();
      blocks.push({ type: "divider" });
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(t);
    if (h) {
      flush();
      blocks.push({ type: "heading", level: Math.min(3, h[1].length) as 1 | 2 | 3, text: h[2].replace(/\s+#+\s*$/, "").trim() });
      continue;
    }
    if (t.startsWith("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      flush();
      const rows = [tableCells(t)];
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith("|")) rows.push(tableCells(lines[i++]));
      i--;
      blocks.push({ type: "table", rows, header: true });
      continue;
    }
    const indent = Math.min(4, Math.floor((raw.length - raw.trimStart().length) / 2));
    const bullet = /^[-*+]\s+(.*)$/.exec(t);
    if (bullet) {
      flush();
      blocks.push({ type: "bullet", text: bullet[1], level: indent });
      continue;
    }
    const num = /^\d+[.)]\s+(.*)$/.exec(t);
    if (num) {
      flush();
      blocks.push({ type: "numbered", text: num[1], level: indent });
      continue;
    }
    if (t.startsWith(">")) {
      flush();
      const q: string[] = [t.replace(/^>\s?/, "")];
      while (i + 1 < lines.length && lines[i + 1].trim().startsWith(">")) q.push(lines[++i].trim().replace(/^>\s?/, ""));
      blocks.push({ type: "quote", text: q.join(" ").trim() });
      continue;
    }
    para.push(t);
  }
  flush();
  return blocks.slice(0, MAX_DOC_BLOCKS);
}

/** Validate blocks handed over as JSON (agent tools). Throws with a readable message. */
export function coerceDocBlocks(value: unknown): DocBlock[] {
  if (!Array.isArray(value)) throw new Error("blocks must be an array.");
  return value.slice(0, MAX_DOC_BLOCKS).map((b, i) => {
    const v = (b ?? {}) as Record<string, unknown>;
    const text = typeof v.text === "string" ? v.text : "";
    switch (v.type) {
      case "heading": {
        const level = Number(v.level);
        return { type: "heading", level: (level === 2 || level === 3 ? level : 1) as 1 | 2 | 3, text };
      }
      case "paragraph":
      case "quote":
      case "code":
        return { type: v.type, text } as DocBlock;
      case "bullet":
      case "numbered":
        return { type: v.type, text, level: Math.max(0, Math.min(4, Number(v.level) || 0)) } as DocBlock;
      case "table": {
        if (!Array.isArray(v.rows)) throw new Error(`blocks[${i}]: a table needs rows.`);
        const rows = (v.rows as unknown[]).map((r) => (Array.isArray(r) ? r.map((c) => (c === null || c === undefined ? "" : String(c))) : [String(r)]));
        return { type: "table", rows, header: v.header !== false };
      }
      case "divider":
        return { type: "divider" };
      case "pageBreak":
        return { type: "pageBreak" };
      default:
        throw new Error(`blocks[${i}]: unknown type "${String(v.type)}".`);
    }
  });
}
