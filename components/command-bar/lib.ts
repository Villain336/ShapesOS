// Marketr — Phase 9 M3: command-bar sidekick, pure logic.
//
// React/DOM-free on purpose: every function here is unit-testable via
// `npx tsx --test` without a browser. CommandBar.tsx wires these up to UI.

import { LEAD_AGENT, SUB_AGENTS, isSubAgentKey, type AgentNode, type SubAgentKey } from "@/lib/aos/agents";
import { STATUS_META, type AosStatus } from "@/lib/aos/status";

/**
 * Window event that opens the palette from anywhere (the sidebar's search
 * button): `window.dispatchEvent(new Event(OPEN_COMMAND_BAR_EVENT))`.
 */
export const OPEN_COMMAND_BAR_EVENT = "shapes:command-bar-open";

/**
 * Window event that opens the New task composer (components/aos/composer):
 * `window.dispatchEvent(new CustomEvent(OPEN_COMPOSER_EVENT, { detail: { agent } }))`.
 * `agent` is "lead" (default) or a sub-agent key.
 */
export const OPEN_COMPOSER_EVENT = "shapes:composer-open";

// Phase 4a: "records" = workspace records found by /api/search/records.
// Phase 4d: the kit palette leads with Agents (lead first, then sub-agents),
// Actions (with keycaps) and Tools (connection state); Go/Records follow.
export type SectionId = "agents" | "actions" | "tools" | "go" | "records" | "do" | "ask";

export const SECTION_ORDER: SectionId[] = ["agents", "actions", "tools", "go", "records", "do", "ask"];

export const SECTION_LABELS: Record<SectionId, string> = {
  agents: "Agents",
  actions: "Actions",
  tools: "Tools",
  go: "Go",
  records: "Records",
  do: "Do",
  ask: "Ask",
};

/** Agent/run state carried by an Agents row (lib/aos/status AosStatus). */
export type CommandStatus = AosStatus;

/** A palette command. `action` decides what CommandBar.tsx does on Enter. */
export interface CommandItem {
  id: string;
  section: SectionId;
  title: string;
  subtitle?: string;
  keywords?: string;
  hotkey?: string;
  action:
    | "go"
    | "missions-page"
    | "playbooks-page"
    | "template"
    | "playbook-run"
    | "ask"
    /** Open the New task composer (agentKey picks the agent). */
    | "new-task"
    /** Phase 18.1: show every Spotlight result (more per kind). */
    | "search-everything"
    /** Phase 18.1: a record's actions page (Open / Ask about this / Act on it). */
    | "record-actions"
    /** Phase 18.1: hand the record to the lead agent with a question / an action. */
    | "record-ask"
    | "record-act"
    /** Phase 18.3 (WS=flow): open the share sheet for the record (Send to… / Open with). */
    | "record-share";
  href?: string;
  templateId?: string;
  goal?: string;
  playbookId?: string;
  /** Agents rows: the agent's current state (color + shape + label). */
  status?: CommandStatus;
  /** Agents rows: "lead" or a sub-agent key; for new-task, the preselected agent. */
  agentKey?: string;
  /** Tools rows: connection state shown on the right. */
  toolState?: "connected" | "reconnect";
  /** Phase 18.1 (Spotlight): the record behind a Records row. */
  record?: RecordResult;
  /** Records rows: an excerpt around the match (⟦marks⟧ = matched words). */
  snippet?: string | null;
  /** Records rows: how it matched (name / text / meaning). */
  match?: string[];
  /** record-act rows: the action. */
  recordAction?: RecordActionResult;
}

// ---------------------------------------------------------------------------
// Keycaps
// ---------------------------------------------------------------------------

/**
 * Split a shortcut label into keycaps: "⌘N" → ["⌘","N"], "G I" → ["G","I"]
 * (a sequence), "⌥1" → ["⌥","1"], "⌘↵" → ["⌘","↵"].
 */
export function hotkeyParts(hotkey: string | undefined): string[] {
  const h = (hotkey ?? "").trim();
  if (!h) return [];
  if (/\s/.test(h)) return h.split(/\s+/);
  return Array.from(h);
}

/** True when the keyboard target is somewhere the user types (no single-key shortcuts there). */
export function isTypingTarget(target: { tagName?: string; isContentEditable?: boolean } | null): boolean {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = (target.tagName ?? "").toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/** "G then I" within this window opens approvals. */
export const SEQUENCE_WINDOW_MS = 1200;

// ---------------------------------------------------------------------------
// Agents section: the lead first, then its sub-agents (lib/aos/agents)
// ---------------------------------------------------------------------------

export interface PaletteTree {
  lead: AgentNode;
  branches: AgentNode[];
}

function agentHint(node: AgentNode): string {
  const p = node.progress;
  if (p && p.total > 0 && node.status === "running") {
    return `Step ${Math.min(p.done + 1, p.total)} of ${p.total} · ${node.line}`;
  }
  return node.line;
}

/**
 * Agents rows. With live work: the lead, then every branch in delegation
 * order, each with its one-line state and status; a row opens its work.
 * With nothing running: the lead and the sub-agents as hand-off targets
 * (Enter opens the composer with that agent picked) and no status, since an
 * idle agent has no state to show.
 */
export function agentCommandItems(tree: PaletteTree | null): CommandItem[] {
  if (tree) {
    return [tree.lead, ...tree.branches].map((n) => {
      const sub = !n.isLead && isSubAgentKey(n.key);
      return {
        id: `agent:${n.key}`,
        section: "agents" as const,
        title: n.name,
        subtitle: agentHint(n),
        keywords: [n.isLead ? "lead agent strategist orchestrator" : "sub-agent", STATUS_META[n.status].label, n.missionName ?? ""].join(" "),
        status: n.status,
        agentKey: n.isLead ? "lead" : sub ? n.key : undefined,
        ...(n.href ? { action: "go" as const, href: n.href } : { action: "new-task" as const }),
      };
    });
  }
  const idle: CommandItem[] = [
    {
      id: "agent:lead",
      section: "agents",
      title: LEAD_AGENT.name,
      subtitle: "Lead agent · nothing running",
      keywords: "lead agent strategist orchestrator hand off task",
      action: "new-task",
      agentKey: "lead",
    },
  ];
  for (const [key, profile] of Object.entries(SUB_AGENTS) as Array<[SubAgentKey, (typeof SUB_AGENTS)[SubAgentKey]]>) {
    idle.push({
      id: `agent:${key}`,
      section: "agents",
      title: profile.name,
      subtitle: profile.description.replace(/\.$/, ""),
      keywords: "sub-agent hand off task",
      action: "new-task",
      agentKey: key,
    });
  }
  return idle;
}

// ---------------------------------------------------------------------------
// Tools section: connection state from /api/connectors (real data only)
// ---------------------------------------------------------------------------

export interface ConnectorSummary {
  key: string;
  displayName: string;
  description: string | null;
  connections: Array<{ status: string; meta?: Record<string, unknown> | null }>;
}

export const CONNECTORS_HREF = "/dashboard/settings/connectors";

function metaLabel(meta: Record<string, unknown> | null | undefined): string | null {
  for (const k of ["label", "email", "account"]) {
    const v = meta?.[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

/**
 * One row per connector that has a connection: Connected when any
 * connection is active, Reconnect when its only connections need re-auth or
 * were revoked. Connectors never connected are left out (the catalog is
 * long); with none at all, a single "Connect a tool" row.
 */
export function toolCommandItems(connectors: readonly ConnectorSummary[]): CommandItem[] {
  const rows: CommandItem[] = [];
  for (const c of connectors) {
    if (!c.connections.length) continue;
    const active = c.connections.find((x) => x.status === "active");
    const state = active ? "connected" : "reconnect";
    const reauth = c.connections.some((x) => x.status === "needs_reauth");
    const hint = active
      ? (metaLabel(active.meta) ?? c.description ?? "")
      : reauth
        ? "Access expired"
        : "Access revoked";
    rows.push({
      id: `tool:${c.key}`,
      section: "tools",
      title: c.displayName,
      subtitle: hint || undefined,
      keywords: `tool connector connection ${state === "connected" ? "connected" : "reconnect expired"}`,
      action: "go",
      href: CONNECTORS_HREF,
      toolState: state,
    });
  }
  rows.sort((a, b) => (a.toolState === b.toolState ? a.title.localeCompare(b.title) : a.toolState === "connected" ? -1 : 1));
  if (rows.length === 0) {
    rows.push({
      id: "tool:connect",
      section: "tools",
      title: "Connect a tool",
      subtitle: "No tools connected yet",
      keywords: "tool connector connect integration",
      action: "go",
      href: CONNECTORS_HREF,
    });
  }
  return rows;
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

// ---------------------------------------------------------------------------
// Records (Phase 4a): server-side record search merged into the palette
// ---------------------------------------------------------------------------

/** Wait this long after the last keystroke before searching records. */
export const RECORD_SEARCH_DEBOUNCE_MS = 200;
/** Same floor as lib/search/records.ts MIN_QUERY_LENGTH. */
export const RECORD_MIN_QUERY = 2;

export function shouldSearchRecords(query: string, isRootPage: boolean): boolean {
  return isRootPage && query.trim().length >= RECORD_MIN_QUERY;
}

export interface RecordActionResult {
  id: string;
  tool: string;
  instruction: string;
}

export interface RecordResult {
  kind: string;
  id: string;
  title: string;
  subtitle: string | null;
  href: string;
  /** Phase 18.1 (Spotlight) — present from /api/search/records. */
  score?: number;
  match?: string[];
  snippet?: string | null;
  ref?: { fileId?: string; docId?: string; leadId?: string; threadId?: string };
  actions?: RecordActionResult[];
}

/** Same-app dashboard links only (results come from our API, but be strict). */
function safeRecordHref(href: string): string | null {
  return href.startsWith("/dashboard") && !href.startsWith("//") && !href.includes("\\") ? href : null;
}

/** Search results → palette items ("go" actions in the Records section). */
export function recordCommandItems(results: RecordResult[], kindLabels: Record<string, string> = {}): CommandItem[] {
  const out: CommandItem[] = [];
  for (const r of results) {
    const href = safeRecordHref(r.href);
    if (!href) continue;
    const label = kindLabels[r.kind] ?? r.kind;
    out.push({
      id: `record:${r.kind}:${r.id}`,
      section: "records",
      title: r.title,
      subtitle: r.subtitle ? `${label} · ${r.subtitle}` : label,
      keywords: label,
      action: "go",
      href,
      record: { ...r, href },
      ...(r.snippet ? { snippet: r.snippet } : {}),
      ...(r.match?.length ? { match: r.match } : {}),
    });
  }
  return out;
}

/**
 * Phase 18.1: the kind runs inside an (already grouped) Records list, for
 * the per-kind sub-headings: [{ kind, start, count }] in display order.
 */
export function recordKindRuns(items: readonly CommandItem[]): Array<{ kind: string; start: number; count: number }> {
  const runs: Array<{ kind: string; start: number; count: number }> = [];
  items.forEach((item, i) => {
    const kind = item.record?.kind ?? "";
    const last = runs[runs.length - 1];
    if (last && last.kind === kind) last.count++;
    else runs.push({ kind, start: i, count: 1 });
  });
  return runs;
}

/** A snippet with ⟦marks⟧ → text segments ({ text, hit }) for rendering emphasis. */
export function snippetSegments(snippet: string | null | undefined): Array<{ text: string; hit: boolean }> {
  if (!snippet) return [];
  const out: Array<{ text: string; hit: boolean }> = [];
  const re = /⟦([^⟧]*)⟧/g;
  let at = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(snippet))) {
    if (m.index > at) out.push({ text: snippet.slice(at, m.index), hit: false });
    if (m[1]) out.push({ text: m[1], hit: true });
    at = m.index + m[0].length;
  }
  if (at < snippet.length) out.push({ text: snippet.slice(at), hit: false });
  return out.filter((s) => s.text.length > 0);
}

/** Per-kind result count: the default, and with "Search everything". */
export const RECORD_LIMIT = 5;
export const RECORD_LIMIT_EVERYTHING = 20;

/**
 * The message handed to the lead agent for "Ask about this" / "Act on it":
 * the person's words, then the record reference the agent reads with
 * search_workspace({ record: "<kind>:<id>" }).
 */
export function recordTaskMessage(lead: string, r: Pick<RecordResult, "kind" | "id" | "title" | "href" | "snippet">): string {
  const lines = [lead.trim(), "", `Record: ${r.kind}:${r.id} — ${r.title} (${r.href})`];
  if (r.snippet) lines.push(`Matched: ${r.snippet.replace(/[⟦⟧]/g, "")}`);
  lines.push("Read it with search_workspace before answering.");
  return lines.join("\n");
}

/**
 * Merge extra items (records) into an already-ranked list so the flat order
 * matches the visual section order (keyboard ↑/↓ walks what you see).
 * Stable: order inside each section is preserved.
 */
export function mergeBySection<T extends CommandItem>(ranked: T[], extra: T[]): T[] {
  return [...ranked, ...extra]
    .map((item, i) => ({ item, i }))
    .sort((a, b) => SECTION_ORDER.indexOf(a.item.section) - SECTION_ORDER.indexOf(b.item.section) || a.i - b.i)
    .map((x) => x.item);
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
 * in full (docs/specs/SPEC-PHASE9.md §P9B).
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
// Mission template catalog (docs/specs/SPEC-PHASE9.md §P9C — templates by business type)
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
