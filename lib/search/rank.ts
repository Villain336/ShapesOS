// ShapesOS — Phase 18.1 (WS=find): how Spotlight ranks. Pure and deterministic.
//
// Each candidate carries three raw signals from Postgres:
//   name   trigram similarity of its title to the query (0..1) and whether
//          the title/name expression contains the query (ILIKE)
//   text   ts_rank_cd of the full-text match ('simple' || 'english')
//   meaning cosine similarity of the query embedding to the record's text
//          (MiniLM, pgvector), when the record has an embedding
//
// The blend (weights sum to 1):
//
//   score = 0.45 · name + 0.35 · text + 0.20 · meaning
//
//   name    = 1                     exact title (case-insensitive)
//           = 0.75 + 0.25 · sim     title starts with the query
//           = 0.55 + 0.45 · sim     title contains the query
//           = sim                   only similar (sim ≥ 0.3), else 0
//   text    = rank / (rank + 0.1)   saturating: a strong text hit → ~1
//   meaning = (cos − 0.25) / 0.75   cos ≥ 0.25 (below that it is noise), else 0
//
// Why these weights: a person typing a name expects that record first (name
// dominates); words inside a record are the next best evidence; meaning
// rescues paraphrases ("revenue forecast" → a deck titled "Q3 outlook") but
// alone can't outrank a literal hit. Ties break by recency, then kind order,
// then id, so the same data always returns the same order.
//
// Groups (one per kind) are ordered by their best score, so the kind with
// the best match leads the Records section.

import { RECORD_KINDS, type MatchMode, type RecordKind } from "./kinds";

export const RANK_WEIGHTS = { name: 0.45, text: 0.35, meaning: 0.2 } as const;
export const MIN_TRIGRAM = 0.3;
export const MIN_COSINE = 0.25;
/** A hit needs a positive blended score (no signal at all = not a match). */
export const MIN_SCORE = 0.001;

export interface RankSignals {
  title: string;
  /** Lower-cased query text matched against names. */
  query: string;
  nameSim: number;
  nameHit: boolean;
  ftsRank: number;
  /** null = the record has no embedding (or semantic search was skipped). */
  vsim: number | null;
}

export function nameComponent(s: Pick<RankSignals, "title" | "query" | "nameSim" | "nameHit">): number {
  const title = s.title.trim().toLowerCase();
  const q = s.query.trim().toLowerCase();
  const sim = clamp01(s.nameSim);
  if (q && title === q) return 1;
  if (q && title.startsWith(q)) return 0.75 + 0.25 * sim;
  if (s.nameHit) return 0.55 + 0.45 * sim;
  return sim >= MIN_TRIGRAM ? sim : 0;
}

export function textComponent(ftsRank: number): number {
  const r = Number.isFinite(ftsRank) && ftsRank > 0 ? ftsRank : 0;
  return r / (r + 0.1);
}

export function meaningComponent(vsim: number | null): number {
  if (vsim === null || !Number.isFinite(vsim) || vsim < MIN_COSINE) return 0;
  return clamp01((vsim - MIN_COSINE) / (1 - MIN_COSINE));
}

export interface Scored {
  score: number;
  match: MatchMode[];
}

export function blend(s: RankSignals): Scored {
  const name = nameComponent(s);
  const text = textComponent(s.ftsRank);
  const meaning = meaningComponent(s.vsim);
  const score = round4(RANK_WEIGHTS.name * name + RANK_WEIGHTS.text * text + RANK_WEIGHTS.meaning * meaning);
  const match: MatchMode[] = [];
  if (name > 0) match.push("name");
  if (text > 0) match.push("text");
  if (meaning > 0) match.push("meaning");
  return { score, match };
}

export interface RankedItem {
  kind: RecordKind;
  id: string;
  score: number;
  updatedAt: Date | string | null;
}

function time(d: Date | string | null): number {
  if (!d) return 0;
  const t = d instanceof Date ? d.getTime() : Date.parse(d);
  return Number.isFinite(t) ? t : 0;
}

/** Stable order inside a group: score, newer first, then id. */
export function compareItems(a: RankedItem, b: RankedItem): number {
  return b.score - a.score || time(b.updatedAt) - time(a.updatedAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Order hits: groups by their best score (then kind order), items inside by compareItems. */
export function orderHits<T extends RankedItem>(hits: readonly T[]): T[] {
  const byKind = new Map<RecordKind, T[]>();
  for (const h of hits) byKind.set(h.kind, [...(byKind.get(h.kind) ?? []), h]);
  const groups = [...byKind.entries()].map(([kind, items]) => ({ kind, items: [...items].sort(compareItems) }));
  groups.sort((a, b) => b.items[0]!.score - a.items[0]!.score || RECORD_KINDS.indexOf(a.kind) - RECORD_KINDS.indexOf(b.kind));
  return groups.flatMap((g) => g.items);
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
