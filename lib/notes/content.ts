// ShapesOS — Phase 18.2 (WS=content): a note's content (PURE, client-safe).
//
// Notes are UniverDoc rows of kind "note" whose snapshot is the Tiptap block
// editor's JSON ({ type: "doc", content: [...] }) — the same editor and the
// same document model the rest of the app uses, no third document store
// (decision recorded in lib/notes/service.ts). This file is the contract for
// that JSON:
//   validateNoteDoc()  the gate every write goes through (shape, size, depth)
//   noteText()         the plain text (Spotlight, agents' read_note, previews)
//   textToNoteDoc()    plain text / light Markdown → a note doc (createNote's
//                      `body`, voice-note transcripts, agent-written notes)
//   deriveNoteTitle()  first meaningful line when no title is given

export const NOTE_KIND = "note" as const;

/** A note's serialized size cap (the JSON, bytes). */
export const NOTE_MAX_BYTES = 1_000_000;
/** Nesting depth cap (lists in lists in quotes …). */
export const NOTE_MAX_DEPTH = 48;
export const NOTE_TITLE_MAX = 200;
export const NOTE_TAG_MAX = 12;
export const NOTE_TAG_LEN = 40;
export const NOTE_FOLDER_LEN = 120;

export interface NoteNode {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
  content?: NoteNode[];
}

export interface NoteDoc {
  type: "doc";
  content: NoteNode[];
}

export type NoteValidation = { ok: true; doc: NoteDoc } | { ok: false; error: string };

/** An empty note (one empty paragraph, what the editor starts with). */
export function emptyNoteDoc(): NoteDoc {
  return { type: "doc", content: [{ type: "paragraph" }] };
}

function checkNode(n: unknown, depth: number): string | null {
  if (depth > NOTE_MAX_DEPTH) return "the note is nested too deeply";
  if (!n || typeof n !== "object" || Array.isArray(n)) return "every block must be an object";
  const node = n as Record<string, unknown>;
  if (typeof node.type !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(node.type)) return "every block needs a type";
  if (node.text !== undefined && typeof node.text !== "string") return "text must be a string";
  if (node.attrs !== undefined && (typeof node.attrs !== "object" || node.attrs === null || Array.isArray(node.attrs))) return "attrs must be an object";
  if (node.marks !== undefined) {
    if (!Array.isArray(node.marks)) return "marks must be a list";
    for (const m of node.marks) {
      if (!m || typeof m !== "object" || typeof (m as { type?: unknown }).type !== "string") return "every mark needs a type";
    }
  }
  if (node.content !== undefined) {
    if (!Array.isArray(node.content)) return "content must be a list";
    for (const c of node.content) {
      const e = checkNode(c, depth + 1);
      if (e) return e;
    }
  }
  return null;
}

/** The gate every note write goes through. Invalid content never persists. */
export function validateNoteDoc(value: unknown): NoteValidation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: "a note must be a document object" };
  const doc = value as Record<string, unknown>;
  if (doc.type !== "doc") return { ok: false, error: 'a note document has type "doc"' };
  if (!Array.isArray(doc.content)) return { ok: false, error: "a note document needs a content list" };
  let size: number;
  try {
    size = new TextEncoder().encode(JSON.stringify(value)).length;
  } catch {
    return { ok: false, error: "the note is not serializable" };
  }
  if (size > NOTE_MAX_BYTES) return { ok: false, error: `the note is larger than ${Math.round(NOTE_MAX_BYTES / 1000)} KB` };
  for (const c of doc.content) {
    const e = checkNode(c, 1);
    if (e) return { ok: false, error: e };
  }
  return { ok: true, doc: value as unknown as NoteDoc };
}

const BLOCK_TYPES = new Set([
  "paragraph",
  "heading",
  "blockquote",
  "codeBlock",
  "listItem",
  "taskItem",
  "horizontalRule",
  "tableRow",
]);

/**
 * The note's plain text: one line per block, list items prefixed ("- ",
 * "1. ", "[ ] " / "[x] "), headings as "# ". Bounded by maxChars.
 */
export function noteText(value: unknown, maxChars = 200_000): string {
  const v = validateNoteDoc(value);
  if (!v.ok) return "";
  const lines: string[] = [];
  let total = 0;
  const inline = (n: NoteNode): string => {
    if (n.type === "text") return n.text ?? "";
    if (n.type === "hardBreak") return "\n";
    if (n.type === "mention") return String(n.attrs?.label ?? n.attrs?.id ?? "");
    return (n.content ?? []).map(inline).join("");
  };
  const push = (s: string) => {
    if (total >= maxChars) return;
    const clipped = s.slice(0, maxChars - total);
    lines.push(clipped);
    total += clipped.length + 1;
  };
  const walk = (nodes: NoteNode[], prefix: string, ordered: boolean) => {
    let i = 1;
    for (const n of nodes) {
      if (total >= maxChars) return;
      switch (n.type) {
        case "bulletList":
          walk(n.content ?? [], `${prefix}  `, false);
          break;
        case "orderedList":
          walk(n.content ?? [], `${prefix}  `, true);
          break;
        case "taskList":
          walk(n.content ?? [], `${prefix}  `, false);
          break;
        case "listItem":
        case "taskItem": {
          const mark = n.type === "taskItem" ? (n.attrs?.checked ? "[x] " : "[ ] ") : ordered ? `${i}. ` : "- ";
          const [first, ...rest] = n.content ?? [];
          push(`${prefix.slice(2)}${mark}${first ? inline(first) : ""}`);
          walk(rest, prefix, false);
          i++;
          break;
        }
        case "heading":
          push(`${"#".repeat(Math.min(6, Math.max(1, Number(n.attrs?.level ?? 1))))} ${inline(n)}`);
          break;
        case "horizontalRule":
          push("---");
          break;
        case "blockquote":
          walk(n.content ?? [], prefix, false);
          break;
        case "table":
          for (const row of n.content ?? []) push((row.content ?? []).map((cell) => inline(cell).trim()).join(" | "));
          break;
        default:
          if (BLOCK_TYPES.has(n.type) || n.content) push(inline(n));
          else if (n.text) push(n.text);
      }
    }
  };
  walk(v.doc.content, "", false);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function textNode(text: string): NoteNode[] {
  return text ? [{ type: "text", text }] : [];
}

/**
 * Plain text or light Markdown → a note doc. Understands "# " headings,
 * "- " / "* " bullets, "1. " numbered items, "[ ] " / "[x] " tasks (also
 * "- [ ] "), "> " quotes and "---" rules; everything else is a paragraph per
 * line. Never throws; an empty string gives an empty note.
 */
export function textToNoteDoc(text: string): NoteDoc {
  const content: NoteNode[] = [];
  let list: { type: "bulletList" | "orderedList" | "taskList"; items: NoteNode[] } | null = null;
  const flush = () => {
    if (list) content.push({ type: list.type, content: list.items });
    list = null;
  };
  const addItem = (type: "bulletList" | "orderedList" | "taskList", item: NoteNode) => {
    if (!list || list.type !== type) {
      flush();
      list = { type, items: [] };
    }
    list.items.push(item);
  };
  for (const raw of String(text ?? "").replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.replace(/\s+$/, "");
    let m: RegExpExecArray | null;
    if ((m = /^(?:[-*]\s+)?\[( |x|X)\]\s+(.*)$/.exec(line))) {
      addItem("taskList", { type: "taskItem", attrs: { checked: m[1] !== " " }, content: [{ type: "paragraph", content: textNode(m[2]!) }] });
    } else if ((m = /^[-*]\s+(.*)$/.exec(line))) {
      addItem("bulletList", { type: "listItem", content: [{ type: "paragraph", content: textNode(m[1]!) }] });
    } else if ((m = /^\d{1,3}[.)]\s+(.*)$/.exec(line))) {
      addItem("orderedList", { type: "listItem", content: [{ type: "paragraph", content: textNode(m[1]!) }] });
    } else {
      flush();
      if ((m = /^(#{1,3})\s+(.*)$/.exec(line))) content.push({ type: "heading", attrs: { level: m[1]!.length }, content: textNode(m[2]!) });
      else if (/^-{3,}$/.test(line)) content.push({ type: "horizontalRule" });
      else if ((m = /^>\s?(.*)$/.exec(line))) content.push({ type: "blockquote", content: [{ type: "paragraph", content: textNode(m[1]!) }] });
      else if (line.trim() === "") {
        // Collapse runs of blank lines to one empty paragraph.
        const last = content[content.length - 1];
        if (last && !(last.type === "paragraph" && !last.content?.length)) content.push({ type: "paragraph" });
      } else content.push({ type: "paragraph", content: textNode(line) });
    }
  }
  flush();
  while (content.length > 1 && content[content.length - 1]!.type === "paragraph" && !content[content.length - 1]!.content?.length) content.pop();
  return { type: "doc", content: content.length ? content : [{ type: "paragraph" }] };
}

/** The first meaningful line (markers stripped), or the fallback. */
export function deriveNoteTitle(text: string, fallback = "Untitled note"): string {
  for (const raw of String(text ?? "").split("\n")) {
    let line = raw.replace(/\s+/g, " ").trim();
    // Strip leading markers ("- [ ] ", "# ", "> 1. " …), however many.
    for (let prev = ""; prev !== line; ) {
      prev = line;
      line = line.replace(/^(#{1,6}|[-*]|\d{1,3}[.)]|\[[ xX]\]|>)\s+/, "").trim();
    }
    if (line && line !== "---") return line.length > 80 ? `${line.slice(0, 79).trimEnd()}…` : line;
  }
  return fallback;
}

/** Tags: trimmed, lowercased, deduplicated, bounded; "#" stripped. */
export function normalizeTags(tags: unknown): string[] {
  const list = Array.isArray(tags) ? tags : typeof tags === "string" ? tags.split(",") : [];
  const out: string[] = [];
  for (const t of list) {
    const v = String(t ?? "").replace(/^#/, "").trim().toLowerCase().replace(/\s+/g, "-").slice(0, NOTE_TAG_LEN);
    if (v && /^[\p{L}\p{N}_-]+$/u.test(v) && !out.includes(v)) out.push(v);
    if (out.length >= NOTE_TAG_MAX) break;
  }
  return out;
}

/** A folder name: one level, trimmed; null when empty. */
export function normalizeFolder(folder: unknown): string | null {
  if (typeof folder !== "string") return null;
  const v = folder.replace(/[/\\]+/g, " ").replace(/\s+/g, " ").trim().slice(0, NOTE_FOLDER_LEN);
  return v || null;
}
