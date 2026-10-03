// Marketr — Phase 9 M3: command-bar sidekick, pure logic.
//
// React/DOM-free on purpose: every function here is unit-testable via
// `npx tsx --test` without a browser. CommandBar.tsx wires these up to UI.

export type SectionId = "go" | "do" | "ask";

export const SECTION_ORDER: SectionId[] = ["go", "do", "ask"];

export const SECTION_LABELS: Record<SectionId, string> = {
  go: "Go",
  do: "Do",
  ask: "Ask",
};

/** A palette command. `action` decides what CommandBar.tsx does on Enter. */
export interface CommandItem {
  id: string;
  section: SectionId;
  title: string;
  subtitle?: string;
  keywords?: string;
  hotkey?: string;
  action: "go" | "missions-page" | "playbooks-page" | "template" | "playbook-run" | "ask";
  href?: string;
  templateId?: string;
  goal?: string;
  playbookId?: string;
}

// ---------------------------------------------------------------------------
// Fuzzy matching (typo-tolerant)
// ---------------------------------------------------------------------------

/** Damerau–Levenshtein distance (adjacent transposition counts as 1). */
export function damerauLevenshtein(a: string, b: string): number {
  const s = a.toLowerCase();
  const t = b.toLowerCase();
  const m = s.length;
  const n = t.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const d: number[][] = Array.from({ length: m + 1 }, (_, i) => [i]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && s[i - 1] === t[j - 2] && s[i - 2] === t[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + cost);
      }
    }
  }
  return d[m][n];
}

/**
 * fuzzyScore — typo-tolerant match of `query` against `text`.
 * Returns null when there is no match, otherwise a score (higher = better).
 *
 * Strategy: exact substring first (strongest), then word-level
 * Damerau–Levenshtein so a transposed/misspelled word still matches
 * ("reprots" → "Reports"), then a plain subsequence fallback for
 * multi-word queries ("gglbsn" → "Google Business").
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase().trim();
  const t = text.toLowerCase();
  if (!q) return 0;
  if (t.includes(q)) {
    // Earlier occurrence + longer query + word-boundary start = better.
    const idx = t.indexOf(q);
    const boundary = idx === 0 || /[\s\-_/:]/.test(t[idx - 1]) ? 25 : 0;
    return 1000 - idx + q.length * 10 + boundary;
  }
  const words = t.split(/[\s\-_/:()]+/).filter(Boolean);
  const allowed = q.length <= 4 ? 1 : 2;
  let best = -1;
  for (const w of words) {
    // Skip words much shorter than the query — cheap prune.
    if (w.length < q.length - allowed) continue;
    const dist = damerauLevenshtein(q, w.slice(0, Math.max(w.length, q.length + allowed)));
    if (dist <= allowed && dist < best || (best === -1 && dist <= allowed)) {
      best = dist;
    }
  }
  if (best !== -1) return 500 - best * 60;
  // Subsequence fallback (no typo tolerance, ordered letters only).
  let qi = 0;
  let ti = 0;
  let score = 100;
  while (qi < q.length && ti < t.length) {
    if (q[qi] === t[ti]) {
      score += ti === 0 || /[\s\-_/:]/.test(t[ti - 1]) ? 6 : 2;
      qi++;
    } else {
      score -= 1;
    }
    ti++;
  }
  return qi === q.length ? Math.max(score, 1) : null;
}

// ---------------------------------------------------------------------------
// Frecency (frequent + recent), persisted in localStorage by the component
// ---------------------------------------------------------------------------

export interface FrecencyEntry {
  count: number;
  lastUsed: number; // epoch ms
}

export type FrecencyMap = Record<string, FrecencyEntry>;

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const FRECENCY_KEY = "marketr:command-bar:frecency:v1";

/** Score: usage count dominates; recency decays exponentially (~7-day scale). */
export function frecencyScore(entry: FrecencyEntry | undefined, now: number): number {
  if (!entry) return 0;
  const ageDays = Math.max(0, (now - entry.lastUsed) / 86_400_000);
  return entry.count * 10 + Math.exp(-ageDays / 7) * 20;
}

export function recordUse(map: FrecencyMap, id: string, now: number): FrecencyMap {
  const prev = map[id];
  return {
    ...map,
    [id]: { count: (prev?.count ?? 0) + 1, lastUsed: now },
  };
}

export function loadFrecency(storage: StorageLike): FrecencyMap {
  try {
    const raw = storage.getItem(FRECENCY_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as FrecencyMap;
    if (typeof parsed !== "object" || parsed === null) return {};
    return parsed;
  } catch {
    return {};
  }
}

export function saveFrecency(storage: StorageLike, map: FrecencyMap): void {
  try {
    storage.setItem(FRECENCY_KEY, JSON.stringify(map));
  } catch {
    // localStorage may be unavailable (private mode, quota) — frecency is
    // best-effort; the bar still works without it.
  }
}

// ---------------------------------------------------------------------------
// Ranking + grouping
// ---------------------------------------------------------------------------

function searchableText(item: CommandItem): string {
  return [item.title, item.subtitle ?? "", item.keywords ?? ""].join(" ");
}

/**
 * rankCommands — filter + order items for a query.
 * Empty query: everything, ordered by frecency within each section.
 * Non-empty: fuzzy filter, ordered by fuzzy score then frecency.
 * Sections always keep Go → Do → Ask order.
 */
export function rankCommands<T extends CommandItem>(
  items: T[],
  query: string,
  frec: FrecencyMap,
  now: number,
): T[] {
  const q = query.trim();
  const scored = items
    .map((item) => {
      const fs = q ? fuzzyScore(q, searchableText(item)) : 0;
      return { item, fs, fr: frecencyScore(frec[item.id], now) };
    })
    .filter((s) => s.fs !== null);
  scored.sort((a, b) => {
    const sectionDelta =
      SECTION_ORDER.indexOf(a.item.section) - SECTION_ORDER.indexOf(b.item.section);
    if (sectionDelta !== 0) return sectionDelta;
    if (q && (b.fs ?? 0) !== (a.fs ?? 0)) return (b.fs ?? 0) - (a.fs ?? 0);
    return b.fr - a.fr;
  });
  return scored.map((s) => s.item);
}

/**
 * capIdleSection — with an empty query, keep only the first `limit` items of
 * `section` (already frecency-ordered by rankCommands) so a long Go list
 * doesn't push Do/Ask off screen. Any non-empty query returns `items` as-is,
 * so every item stays reachable by typing.
 */
export function capIdleSection<T extends CommandItem>(
  items: T[],
  query: string,
  section: SectionId,
  limit: number,
): T[] {
  if (query.trim()) return items;
  let seen = 0;
  return items.filter((i) => i.section !== section || seen++ < limit);
}

export interface CommandGroup<T extends CommandItem = CommandItem> {
  section: SectionId;
  label: string;
  items: T[];
}

/** Group an already-ranked list into Go/Do/Ask sections, dropping empties. */
export function groupBySection<T extends CommandItem>(items: T[]): CommandGroup<T>[] {
  const groups: CommandGroup<T>[] = [];
  for (const section of SECTION_ORDER) {
    const sectionItems = items.filter((i) => i.section === section);
    if (sectionItems.length > 0) {
      groups.push({ section, label: SECTION_LABELS[section], items: sectionItems });
    }
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Keyboard contract helpers (pure; CommandBar.tsx wires them to keydown)
// ---------------------------------------------------------------------------

/** Move the active index with wrap-around. */
export function moveSelection(active: number, dir: 1 | -1, count: number): number {
  if (count <= 0) return 0;
  return (active + dir + count) % count;
}

/** Backspace on an empty query pops a nested page (Esc always closes). */
export function shouldPopOnBackspace(query: string, isNested: boolean): boolean {
  return query === "" && isNested;
}

// ---------------------------------------------------------------------------
// Audit payload builders
// ---------------------------------------------------------------------------

/**
 * Canonical rendered prompt for a templated action. The client sends this
 * string; /api/command/audit hashes it via logCommand() and NEVER stores it
 * in full (SPEC-PHASE9.md §P9B).
 */
export function renderMissionPrompt(templateId: string, goal: string): string {
  return `Start mission from template "${templateId}" with goal "${goal}".`;
}

export interface AuditPayload {
  kind: "template" | "ask" | "go" | "do";
  templateId?: string;
  /** Rendered prompt (hashed server-side) or FULL prompt for kind=ask. */
  prompt?: string;
  resultSummary?: string;
}

export function buildTemplateAuditPayload(
  templateId: string,
  goal: string,
  resultSummary?: string,
): AuditPayload {
  return {
    kind: "template",
    templateId,
    prompt: renderMissionPrompt(templateId, goal),
    ...(resultSummary ? { resultSummary } : {}),
  };
}

export function buildAskAuditPayload(query: string, resultSummary?: string): AuditPayload {
  return {
    kind: "ask",
    prompt: query,
    ...(resultSummary ? { resultSummary } : {}),
  };
}

export function buildGoAuditPayload(href: string): AuditPayload {
  return { kind: "go", prompt: `Open ${href}`, resultSummary: `Opened ${href}` };
}

export function buildDoAuditPayload(label: string, detail?: string): AuditPayload {
  return {
    kind: "do",
    prompt: detail ? `${label}: ${detail}` : label,
    resultSummary: label,
  };
}

// ---------------------------------------------------------------------------
// Async budget: suggestions hidden when slower than the budget
// ---------------------------------------------------------------------------

export class AsyncBudgetExceeded extends Error {
  constructor(public readonly budgetMs: number) {
    super(`Async suggestion exceeded ${budgetMs}ms budget`);
    this.name = "AsyncBudgetExceeded";
  }
}

/** Race a promise against a budget; reject with AsyncBudgetExceeded if late. */
export function withTimeout<T>(promise: Promise<T>, budgetMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new AsyncBudgetExceeded(budgetMs)), budgetMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

// ---------------------------------------------------------------------------
// Mission template catalog (SPEC-PHASE9.md §P9C — templates by business type)
// ---------------------------------------------------------------------------

export interface MissionTemplate {
  id: string;
  label: string;
  businessType: string;
  goal: string;
}

export const MISSION_TEMPLATES: MissionTemplate[] = [
  { id: "home-services:booked-jobs", label: "Booked-job growth", businessType: "Home Services", goal: "Grow booked jobs this quarter" },
  { id: "home-services:review-velocity", label: "Review velocity", businessType: "Home Services", goal: "Accelerate review volume and rating" },
  { id: "home-services:slow-season-fill", label: "Slow-season fill", businessType: "Home Services", goal: "Fill the slow-season schedule" },
  { id: "local-services:quote-requests", label: "Quote-request volume", businessType: "Local Services", goal: "Increase quote-request volume" },
  { id: "local-services:gbp-visibility", label: "Google Business visibility", businessType: "Local Services", goal: "Improve Google Business Profile visibility" },
  { id: "saas:trial-starts", label: "Trial starts", businessType: "SaaS", goal: "Increase trial starts" },
  { id: "saas:trial-to-paid", label: "Trial → paid conversion", businessType: "SaaS", goal: "Improve trial-to-paid conversion" },
  { id: "saas:churn-reduction", label: "Churn reduction", businessType: "SaaS", goal: "Reduce churn" },
  { id: "ecommerce:repeat-purchase", label: "Repeat purchase rate", businessType: "Ecommerce", goal: "Lift repeat purchase rate" },
  { id: "ecommerce:cart-recovery", label: "Cart recovery", businessType: "Ecommerce", goal: "Recover abandoned carts" },
  { id: "professional-services:consult-bookings", label: "Consultation bookings", businessType: "Professional Services", goal: "Increase consultation bookings" },
  { id: "professional-services:proposal-win-rate", label: "Proposal win rate", businessType: "Professional Services", goal: "Improve proposal win rate" },
];
