// Marketr — internal-linking suggestion engine (milestone 15).
//
// Pure logic: no DB, no network, no side effects. Callers (the weekly cron,
// manual refresh) gather the project's known pages + known internal links
// and call suggestInternalLinks(). Suggestions are *supervised* — the UI
// writes an Issue to the fix-agent inbox on "apply"; pages are never
// auto-edited.
//
// Known pages come from M5 ranking URLs (with their best position and the
// keyword phrases ranking them) plus M7 site pages. Known edges come from
// whatever link data is available (extractInternalHrefs() parses HTML when a
// crawl or site working copy is at hand). Missing edges are honest: pages
// with no known inbound links surface as orphans.

export type SuggestionReason =
  | "orphan"
  | "high_value_underlinked"
  | "keyword_relevant";

export const REASON_LABELS: Record<SuggestionReason, string> = {
  orphan: "Orphan page",
  high_value_underlinked: "High-value page, under-linked",
  keyword_relevant: "Keyword-relevant opportunity",
};

export interface InternalPage {
  /** Canonical page URL. */
  url: string;
  title?: string | null;
  /** Keyword phrases this page ranks for / targets (anchor candidates). */
  targetKeywords: string[];
  /** Best tracked organic position, null when unranked/unknown. */
  bestRank: number | null;
}

export interface InternalEdge {
  from: string;
  to: string;
}

export interface SuggestionDraft {
  sourceUrl: string;
  targetUrl: string;
  suggestedAnchor: string;
  reason: SuggestionReason;
  score: number; // 0–100
  detail: string;
}

export const MAX_SUGGESTIONS = 50;
/** Minimum shared content tokens for a keyword_relevant suggestion. */
export const MIN_TOKEN_OVERLAP = 2;
/** "High value" = ranking at or above this position. */
export const HIGH_VALUE_MAX_RANK = 10;

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "of", "to", "in", "on", "for", "with",
  "is", "are", "be", "by", "at", "from", "as", "it", "its", "this", "that",
  "how", "what", "why", "when", "your", "you", "we", "our", "their", "my",
  "vs", "guide", "tips",
]);

/** Normalize a URL for graph identity: lowercase host+path, strip trailing slash, query, hash. */
export function normalizeInternalUrl(raw: string): string {
  const t = raw.trim();
  if (!t) return "";
  try {
    const u = new URL(t, "https://placeholder.invalid");
    let host = u.hostname.toLowerCase().replace(/^www\./, "");
    if (u.hostname === "placeholder.invalid") {
      // Relative URL — keep the path as identity.
      host = "";
    }
    // Paths are lowercased for identity: ranking data rarely distinguishes
    // /Blog from /blog, and case splits would fragment the graph.
    let path = u.pathname.toLowerCase().replace(/\/+$/, "");
    if (path === "") path = "/";
    return `${host}${path}`;
  } catch {
    return t.toLowerCase().replace(/\/+$/, "");
  }
}

/** Lowercase alphanumeric tokens, stopwords removed, naive singularization. */
export function contentTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || STOPWORDS.has(raw)) continue;
    let w = raw;
    if (w.length > 4 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
    out.add(w);
  }
  return out;
}

function pageTokens(p: InternalPage): Set<string> {
  const t = new Set<string>();
  for (const kw of p.targetKeywords) for (const tok of contentTokens(kw)) t.add(tok);
  if (p.title) for (const tok of contentTokens(p.title)) t.add(tok);
  return t;
}

function overlapSize(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const t of a) if (b.has(t)) n += 1;
  return n;
}

/** Best anchor for linking TO page b FROM page a: b's keyword with max token overlap. */
function pickAnchor(aTokens: Set<string>, b: InternalPage): string {
  let best = "";
  let bestScore = -1;
  for (const kw of b.targetKeywords) {
    const s = overlapSize(aTokens, contentTokens(kw));
    if (s > bestScore) {
      bestScore = s;
      best = kw;
    }
  }
  return best || b.title || b.url;
}

export interface LinkGraph {
  /** normalized url -> set of normalized urls linking to it */
  inbound: Map<string, Set<string>>;
  /** normalized url -> set of normalized urls it links to */
  outbound: Map<string, Set<string>>;
  /** normalized url -> original page */
  pages: Map<string, InternalPage>;
}

export function buildLinkGraph(pages: InternalPage[], edges: InternalEdge[]): LinkGraph {
  const graph: LinkGraph = { inbound: new Map(), outbound: new Map(), pages: new Map() };
  for (const p of pages) {
    const n = normalizeInternalUrl(p.url);
    if (!n) continue;
    graph.pages.set(n, p);
    if (!graph.inbound.has(n)) graph.inbound.set(n, new Set());
    if (!graph.outbound.has(n)) graph.outbound.set(n, new Set());
  }
  for (const e of edges) {
    const from = normalizeInternalUrl(e.from);
    const to = normalizeInternalUrl(e.to);
    if (!from || !to || from === to) continue; // skip self-links
    if (!graph.pages.has(from) || !graph.pages.has(to)) continue; // internal only
    graph.inbound.get(to)!.add(from);
    graph.outbound.get(from)!.add(to);
  }
  return graph;
}

/**
 * Compute internal-link suggestions for a link graph. Returns at most
 * MAX_SUGGESTIONS drafts sorted by score desc, deduped by (source, target).
 */
export function suggestInternalLinks(pages: InternalPage[], edges: InternalEdge[]): SuggestionDraft[] {
  const graph = buildLinkGraph(pages, edges);
  const tokenCache = new Map<string, Set<string>>();
  const tokensOf = (n: string): Set<string> => {
    let t = tokenCache.get(n);
    if (!t) {
      t = pageTokens(graph.pages.get(n)!);
      tokenCache.set(n, t);
    }
    return t;
  };

  const drafts: SuggestionDraft[] = [];
  /** (source,target) -> index in drafts; one card per pair, highest score wins. */
  const seen = new Map<string, number>();
  const push = (d: SuggestionDraft) => {
    const key = `${d.sourceUrl}\n${d.targetUrl}`;
    const idx = seen.get(key);
    if (idx === undefined) {
      seen.set(key, drafts.length);
      drafts.push(d);
    } else if (d.score > drafts[idx].score) {
      drafts[idx] = d;
    }
  };

  const nodes = [...graph.pages.keys()];

  for (const target of nodes) {
    const page = graph.pages.get(target)!;
    const inbound = graph.inbound.get(target)!;
    const tTokens = tokensOf(target);

    // 1. Orphan pages: no known inbound internal links.
    if (inbound.size === 0 && nodes.length > 1) {
      const src = bestSource(target, nodes, graph, tokensOf);
      if (src) {
        const anchor = pickAnchor(tokensOf(src), page);
        push({
          sourceUrl: graph.pages.get(src)!.url,
          targetUrl: page.url,
          suggestedAnchor: anchor,
          reason: "orphan",
          score: 70,
          detail: `No known internal links point to this page. Link from a topically related page using "${anchor}".`,
        });
      }
    }

    // 2. High-value pages (ranking top 10) with few inbound links.
    if (page.bestRank != null && page.bestRank <= HIGH_VALUE_MAX_RANK && inbound.size < 2 && nodes.length > 1) {
      const src = bestSource(target, nodes, graph, tokensOf);
      if (src && normalizeInternalUrl(graph.pages.get(src)!.url) !== target) {
        const anchor = pickAnchor(tokensOf(src), page);
        const score = Math.max(40, 88 - inbound.size * 8);
        push({
          sourceUrl: graph.pages.get(src)!.url,
          targetUrl: page.url,
          suggestedAnchor: anchor,
          reason: "high_value_underlinked",
          score,
          detail: `Ranks #${page.bestRank} but has only ${inbound.size} known inbound internal link${inbound.size === 1 ? "" : "s"}. Strengthen it with a link using "${anchor}".`,
        });
      }
    }

    // 3. Keyword-relevant opportunities: page A shares topical tokens with
    //    page B's target keywords but doesn't link to B yet.
    for (const source of nodes) {
      if (source === target) continue;
      if (graph.outbound.get(source)!.has(target)) continue;
      const overlap = overlapSize(tokensOf(source), tTokens);
      if (overlap < MIN_TOKEN_OVERLAP) continue;
      const sPage = graph.pages.get(source)!;
      const anchor = pickAnchor(tokensOf(source), page);
      push({
        sourceUrl: sPage.url,
        targetUrl: page.url,
        suggestedAnchor: anchor,
        reason: "keyword_relevant",
        score: Math.min(95, 55 + overlap * 8),
        detail: `Shares ${overlap} topical terms with this page's keywords but doesn't link to it. Add a contextual link using "${anchor}".`,
      });
    }
  }

  drafts.sort((a, b) => b.score - a.score);
  return drafts.slice(0, MAX_SUGGESTIONS);
}

/** Best source page for target: most token overlap, not already linking, not self. */
function bestSource(
  target: string,
  nodes: string[],
  graph: LinkGraph,
  tokensOf: (n: string) => Set<string>,
): string | null {
  let best: string | null = null;
  let bestScore = 0;
  const tTokens = tokensOf(target);
  for (const n of nodes) {
    if (n === target) continue;
    if (graph.outbound.get(n)!.has(target)) continue;
    const s = overlapSize(tokensOf(n), tTokens);
    if (s > bestScore) {
      bestScore = s;
      best = n;
    }
  }
  return bestScore >= 1 ? best : null;
}

/**
 * Extract same-host hrefs from an HTML string (for future crawls / site
 * working copies). Returns absolute URLs on the base host only.
 */
export function extractInternalHrefs(html: string, baseUrl: string): string[] {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return [];
  }
  const host = base.hostname.replace(/^www\./, "");
  const out = new Set<string>();
  const re = /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const raw = (m[1] ?? m[2] ?? m[3] ?? "").trim();
    if (!raw || raw.startsWith("#") || raw.startsWith("mailto:") || raw.startsWith("tel:") || raw.startsWith("javascript:")) continue;
    try {
      const u = new URL(raw, base);
      if (u.hostname.replace(/^www\./, "") !== host) continue;
      u.hash = "";
      out.add(u.toString());
    } catch {
      // skip unparseable hrefs
    }
  }
  return [...out];
}
