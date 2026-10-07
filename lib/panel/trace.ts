// ShapesOS — Phase 19B (WS=panel): quote tracing.
// Commercial layer (entitlement dress_rehearsal). Licence boundary: CONTRIBUTING.md (open vs commercial; company-authored).
//
// Ported from the prototype's src/reporting/verdicts.ts (traceQuote,
// filterTraceableQuotes): a quote is traceable when it shares at least
// QUOTE_TRACE_WORDS content words (4+ letters, no stopwords) with one piece
// of evidence. Quotes that trace to nothing are dropped, never shown.
//
// Added for ShapesOS: tracing to the INTERVIEWS. A persona's think-aloud is
// synthetic; the owner rule is that objections are traced to real interview
// words. traceToInterviews() finds the interview chunk that supports a quote
// and the best-matching sentence in it, so the report can show the real
// words next to the synthetic ones (or say plainly that nothing in the
// interviews supports it).

import type { ObjectionSeverity } from "./persona";

const QUOTE_STOPWORDS = new Set(
  "a,an,the,and,or,but,if,then,else,for,to,of,in,on,at,by,with,from,as,is,are,was,were,be,been,being,have,has,had,do,does,did,will,would,should,could,can,it,its,this,that,these,those,i,you,he,she,we,they,them,his,her,our,their,my,your,me,him,us,not,no,yes,so,very,just,about,into,over,after,before,between,through,during,up,down,out,off,again,once,here,there,when,where,why,how,all,any,both,each,few,more,most,other,some,such,only,own,same,than,too".split(","),
);

export function quoteTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 4 && !QUOTE_STOPWORDS.has(t)),
  );
}

/** Minimum overlapping content-word count for a quote to count as traceable. */
export const QUOTE_TRACE_WORDS = 4;

/** Evidence a quote can trace to: a think-aloud, an observation excerpt, or an interview / reflection node. */
export interface EvidenceItem {
  text: string;
  section: string;
  /** Set when the evidence came from an interview transcript (directly or via a reflection on it). */
  sourceTranscriptId?: string;
}

export function overlapCount(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const t of a) if (b.has(t)) n += 1;
  return n;
}

const tokenCache = new WeakMap<object, Set<string>>();
function tokensOf(item: EvidenceItem): Set<string> {
  let t = tokenCache.get(item);
  if (!t) {
    t = quoteTokens(item.text);
    tokenCache.set(item, t);
  }
  return t;
}

/** The first evidence item the quote traces to (4+ overlapping content words). */
export function traceQuote(quote: string, evidence: readonly EvidenceItem[]): EvidenceItem | undefined {
  const q = quoteTokens(quote);
  if (q.size === 0) return undefined;
  for (const item of evidence) {
    const toks = tokensOf(item);
    if (toks.size === 0) continue;
    if (overlapCount(q, toks) >= QUOTE_TRACE_WORDS) return item;
  }
  return undefined;
}

export interface TracedObjection {
  /** Exact quote — traceable to a step or an interview. */
  quote: string;
  /** Section where it surfaced, or "(memory)" for interview evidence. */
  section: string;
  severity: ObjectionSeverity;
  /** Transcript the quote traces to, when it traced to interview evidence. */
  sourceTranscriptId?: string;
}

/**
 * Keep the traceable quotes (with the transcript they trace to, when any);
 * drop invented ones. `onDrop` hears about each dropped quote (the runner
 * counts them for the report — the prototype only console.warn'ed).
 */
export function filterTraceableQuotes(
  quotes: ReadonlyArray<{ quote: string; section: string; severity: ObjectionSeverity }>,
  evidence: readonly EvidenceItem[],
  onDrop?: (quote: string) => void,
): TracedObjection[] {
  const kept: TracedObjection[] = [];
  for (const q of quotes) {
    const item = traceQuote(q.quote, evidence);
    if (!item) {
      onDrop?.(q.quote);
      continue;
    }
    kept.push({
      quote: q.quote,
      section: q.section || item.section,
      severity: q.severity,
      ...(item.sourceTranscriptId ? { sourceTranscriptId: item.sourceTranscriptId } : {}),
    });
  }
  return kept;
}

/** Split text into sentences (keeps speaker turns intact as far as possible). */
export function sentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"“'(])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export interface InterviewTrace {
  transcriptId: string;
  /** The interview sentence(s) that support the quote — real words. */
  excerpt: string;
  /** Content words shared with the quote. */
  overlap: number;
}

/**
 * Find the interview words behind a quote. `chunks` are interview nodes (or
 * any verbatim transcript text) of the persona's own transcripts. Returns
 * the best sentence (most shared content words, ≥ minOverlap) or null.
 */
export function traceToInterviews(
  quote: string,
  chunks: ReadonlyArray<{ transcriptId: string; content: string }>,
  minOverlap = 3,
): InterviewTrace | null {
  const q = quoteTokens(quote);
  if (q.size === 0) return null;
  let best: InterviewTrace | null = null;
  for (const c of chunks) {
    for (const s of sentences(c.content)) {
      const n = overlapCount(q, quoteTokens(s));
      if (n >= minOverlap && (!best || n > best.overlap)) best = { transcriptId: c.transcriptId, excerpt: s.slice(0, 400), overlap: n };
    }
  }
  return best;
}
