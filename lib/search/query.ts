// ShapesOS — Phase 18.1 (WS=find): Spotlight query parsing. Pure, client-safe.
//
//   "q3 report in:files -draft"  →  text "q3 report", kinds [file, file_content],
//                                    fts "q3 report -draft", name "q3 report"
//
// Grammar (search-engine style, the same words websearch_to_tsquery reads):
//   word            must appear (name contains it, or the text has it)
//   "a phrase"      the words in this order (full text); a name match uses it too
//   -word           must not appear (full text only)
//   a or b          either (full text)
//   kind:x / in:x / type:x   narrow to record kinds (lib/search/kinds.ts
//                   KIND_ALIASES); unknown kinds are kept as plain words.

import { KIND_ALIASES, RECORD_KINDS, type RecordKind } from "./kinds";

export const MIN_QUERY_LENGTH = 2;
export const MAX_QUERY_LENGTH = 100;

/** Trim, drop control characters, collapse whitespace, cap length. Null when too short. */
export function normalizeQuery(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const q = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_QUERY_LENGTH);
  return q.length >= MIN_QUERY_LENGTH ? q : null;
}

export interface ParsedQuery {
  /** The normalized input. */
  raw: string;
  /** What names are matched against (no operators, no filters). */
  name: string;
  /** What websearch_to_tsquery gets (phrases, -exclusions and OR kept). */
  fts: string;
  /** Kinds named by kind:/in:/type: filters (empty = every kind). */
  kinds: RecordKind[];
  /** Positive terms (for snippets and highlighting). */
  terms: string[];
  phrases: string[];
  excluded: string[];
}

const FILTER_RE = /^(kind|in|type):([a-z_]+)$/i;

/** Split on spaces, keeping "quoted phrases" together. */
function tokenize(q: string): string[] {
  const out: string[] = [];
  const re = /-?"[^"]*"?|\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(q))) out.push(m[0]);
  return out;
}

export function parseQuery(raw: unknown): ParsedQuery | null {
  const q = normalizeQuery(raw);
  if (!q) return null;
  const kinds = new Set<RecordKind>();
  const name: string[] = [];
  const fts: string[] = [];
  const terms: string[] = [];
  const phrases: string[] = [];
  const excluded: string[] = [];
  for (const tok of tokenize(q)) {
    const f = FILTER_RE.exec(tok);
    if (f) {
      const key = f[2]!.toLowerCase();
      const mapped = KIND_ALIASES[key] ?? ((RECORD_KINDS as readonly string[]).includes(key) ? [key as RecordKind] : null);
      if (mapped) {
        for (const k of mapped) kinds.add(k);
        continue;
      }
    }
    if (tok.startsWith("-") && tok.length > 1) {
      const word = tok.slice(1).replace(/"/g, "");
      if (word) excluded.push(word);
      fts.push(tok);
      continue;
    }
    if (tok.startsWith('"')) {
      const phrase = tok.replace(/"/g, "").trim();
      if (phrase) {
        phrases.push(phrase);
        name.push(phrase);
        fts.push(`"${phrase}"`);
      }
      continue;
    }
    if (tok.toLowerCase() === "or") {
      fts.push("or");
      continue;
    }
    terms.push(tok);
    name.push(tok);
    fts.push(tok);
  }
  const nameText = name.join(" ").trim();
  const ftsText = fts.join(" ").trim();
  if (!nameText && phrases.length === 0 && terms.length === 0) {
    // Only filters / exclusions: nothing to look for.
    return null;
  }
  return { raw: q, name: nameText, fts: ftsText, kinds: [...kinds], terms, phrases, excluded };
}

/** ILIKE pattern with %, _ and \ escaped (default ESCAPE is backslash). */
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}
