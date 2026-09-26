// Marketr — Phase 10 M3: first-party correlation layer.
//
// AI-visibility estimates are anchored against the user's OWN data:
//   1. GSC AI Overview impressions (coordinates with M1's gsc_snapshot —
//      reads the schema, never duplicates it). M1 flags AIO rows on the
//      aggregated row objects ({ aiOverview: true }); this reader sums them.
//   2. GA4 AI-referrer traffic (chat.openai.com, perplexity.ai,
//      gemini.google.com, …). Reuses the GA4 connector adapter; the adapter
//      is MOCK-ONLY today, so rows come back labeled and empty rather than
//      fabricated.
//   3. AI crawler activity in the user's own server logs (GPTBot,
//      OAI-SearchBot, ClaudeBot, Claude-User, PerplexityBot, Bytespider) —
//      a preceding indicator of citing. Log-parser utility + shipping docs
//      (docs/ai-visibility-log-shipping.md). Marketr never scrapes to get this.

import { withWorkspaceScope, type TxClient } from "@/lib/substrate/graph/rls";

// ---------------------------------------------------------------------------
// 1. GSC AI Overview impressions (M1 gsc_snapshot).
// ---------------------------------------------------------------------------

export interface GscAioRow {
  query?: string;
  page?: string;
  clicks?: number;
  impressions?: number;
  /** M1's AIO flag on the aggregated row object. */
  aiOverview?: boolean;
  position?: number;
}

export interface GscAioWindow {
  windowStart: string;
  windowEnd: string;
  granularity: string;
  impressions: number;
  clicks: number;
  queries: number;
}

export interface GscAioReport {
  windows: GscAioWindow[];
  totalImpressions: number;
  totalClicks: number;
  /** True when M1 has not flagged any AIO rows yet — honest empty, not zero-truth. */
  noAioRowsFlagged: boolean;
  note: string;
}

function rowsOf(snapshot: { rows: unknown }): GscAioRow[] {
  return Array.isArray(snapshot.rows) ? (snapshot.rows as GscAioRow[]) : [];
}

/** Sum AI-Overview-flagged rows across GSC snapshots. Reads M1's schema as-is. */
export async function gscAiOverviewReport(
  workspaceId: string,
  projectId: string,
  limit = 12,
): Promise<GscAioReport> {
  const snapshots = await withWorkspaceScope(workspaceId, (tx: TxClient) =>
    tx.gscSnapshot.findMany({
      where: { workspaceId, projectId },
      orderBy: { windowStart: "desc" },
      take: limit,
      select: { windowStart: true, windowEnd: true, granularity: true, rows: true },
    }),
  );
  const windows: GscAioWindow[] = [];
  let totalImpressions = 0;
  let totalClicks = 0;
  let flagged = 0;
  for (const s of snapshots) {
    const aio = rowsOf(s).filter((r) => r.aiOverview === true);
    flagged += aio.length;
    const impressions = aio.reduce((n, r) => n + (r.impressions ?? 0), 0);
    const clicks = aio.reduce((n, r) => n + (r.clicks ?? 0), 0);
    totalImpressions += impressions;
    totalClicks += clicks;
    windows.push({
      windowStart: s.windowStart.toISOString(),
      windowEnd: s.windowEnd.toISOString(),
      granularity: s.granularity,
      impressions,
      clicks,
      queries: new Set(aio.map((r) => r.query).filter(Boolean)).size,
    });
  }
  return {
    windows,
    totalImpressions,
    totalClicks,
    noAioRowsFlagged: flagged === 0,
    note:
      flagged === 0
        ? "No AI-Overview-flagged rows in GSC snapshots yet — M1 flags them when the SERP-feature pull reports AIO presence. This is honest absence of data, not zero impressions."
        : "AI-Overview rows as flagged by M1's SERP-feature detection on GSC snapshots.",
  };
}

// ---------------------------------------------------------------------------
// 2. GA4 AI-referrer traffic.
// ---------------------------------------------------------------------------

/** Known AI-assistant referrer hosts. */
export const AI_REFERRER_HOSTS = [
  "chat.openai.com",
  "chatgpt.com",
  "perplexity.ai",
  "gemini.google.com",
  "claude.ai",
  "copilot.microsoft.com",
] as const;

export interface Ga4SourceRow {
  host: string;
  sessions: number;
  users?: number;
  /** True when the row came from the mock adapter. */
  mock?: boolean;
}

export interface AiReferrerSummary {
  totalSessions: number;
  perHost: { host: string; sessions: number }[];
  /** True when the GA4 adapter is still mock-only — the numbers are demo-shaped. */
  fromMock: boolean;
  note: string;
}

/**
 * Filter GA4 source rows to AI-assistant referrers. Pure — the rows come from
 * the GA4 connector adapter (mock today, labeled honestly).
 */
export function summarizeAiReferrers(rows: Ga4SourceRow[]): AiReferrerSummary {
  const wanted = new Set<string>(AI_REFERRER_HOSTS);
  const perHost = new Map<string, number>();
  let fromMock = false;
  for (const r of rows) {
    if (r.mock) fromMock = true;
    const host = r.host.toLowerCase().replace(/^www\./, "");
    if (wanted.has(host)) {
      perHost.set(host, (perHost.get(host) ?? 0) + (r.sessions ?? 0));
    }
  }
  const list = [...perHost.entries()]
    .map(([host, sessions]) => ({ host, sessions }))
    .sort((a, b) => b.sessions - a.sessions);
  return {
    totalSessions: list.reduce((n, h) => n + h.sessions, 0),
    perHost: list,
    fromMock,
    note: fromMock
      ? "GA4 connector is MOCK-ONLY today — these rows are demo-shaped. Connect GA4 (official API) for live AI-referrer traffic."
      : "Live AI-referrer sessions from the GA4 connector.",
  };
}

// ---------------------------------------------------------------------------
// 3. AI crawler activity in the user's own server logs.
// ---------------------------------------------------------------------------

/** AI crawlers / fetchers that precede citation, by user-agent token. */
export const AI_CRAWLER_TOKENS: { token: RegExp; name: string }[] = [
  { token: /GPTBot/i, name: "GPTBot" },
  { token: /OAI-SearchBot/i, name: "OAI-SearchBot" },
  { token: /ClaudeBot/i, name: "ClaudeBot" },
  { token: /Claude-User/i, name: "Claude-User" },
  { token: /PerplexityBot/i, name: "PerplexityBot" },
  { token: /Bytespider/i, name: "Bytespider" },
  { token: /Google-Extended/i, name: "Google-Extended" },
  { token: /ChatGPT-User/i, name: "ChatGPT-User" },
  { token: /anthropic-ai/i, name: "Anthropic-AI" },
  { token: /cohere-ai/i, name: "Cohere-AI" },
];

/** Identify an AI crawler in a log line. Returns the bot name or null. */
export function detectAiCrawler(line: string): string | null {
  for (const { token, name } of AI_CRAWLER_TOKENS) {
    if (token.test(line)) return name;
  }
  return null;
}

export interface CrawlerLogSummary {
  totalLines: number;
  aiBotLines: number;
  perBot: { bot: string; hits: number; samplePaths: string[] }[];
  /** Distinct dates seen (YYYY-MM-DD), for windowing. */
  dates: string[];
}

const DATE_RE = /(\d{4}-\d{2}-\d{2})/;
const PATH_RE = /"([A-Z]+)\s+(\S+)\s+HTTP\/[\d.]+"/;

/**
 * Parse server-log lines (Common Log Format or combined) for AI crawler
 * activity. Pure + streaming-friendly — callers feed lines however they ship
 * them (upload, syslog tail, CDN export).
 */
export function parseServerLog(lines: Iterable<string>): CrawlerLogSummary {
  const perBot = new Map<string, { hits: number; paths: Set<string> }>();
  const dates = new Set<string>();
  let totalLines = 0;
  let aiBotLines = 0;
  for (const line of lines) {
    totalLines += 1;
    const bot = detectAiCrawler(line);
    const date = line.match(DATE_RE)?.[1];
    if (date) dates.add(date);
    if (!bot) continue;
    aiBotLines += 1;
    let e = perBot.get(bot);
    if (!e) {
      e = { hits: 0, paths: new Set() };
      perBot.set(bot, e);
    }
    e.hits += 1;
    const path = line.match(PATH_RE)?.[2];
    if (path) e.paths.add(path.split("?")[0]);
  }
  return {
    totalLines,
    aiBotLines,
    perBot: [...perBot.entries()]
      .map(([bot, e]) => ({ bot, hits: e.hits, samplePaths: [...e.paths].slice(0, 5) }))
      .sort((a, b) => b.hits - a.hits),
    dates: [...dates].sort(),
  };
}
