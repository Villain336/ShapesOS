// ShapesOS — Phase 21A (WS=agentweb): the answer-and-action engine's types.

/** One result from a search provider or the workspace index. */
export interface SearchResult {
  url: string;
  title: string;
  snippet: string;
  /** ISO date when the provider knows it. */
  publishedAt?: string;
  /** brave | exa | mock | workspace | depth */
  provider: string;
}

export interface SearchOptions {
  limit?: number;
  /** Only results from the last day / week / month / year. */
  freshness?: "day" | "week" | "month" | "year";
  signal?: AbortSignal;
}

export interface SearchResponse {
  results: SearchResult[];
  /** What this call cost the platform, in micro-USD (0 for a mock). */
  costMicroUsd: number;
}

export type ProviderId = "brave" | "exa" | "mock";

export interface SearchProvider {
  readonly id: ProviderId;
  readonly label: string;
  /** True when the results are canned fixtures, not a search index. */
  readonly mock: boolean;
  /** What one call usually costs, for the per-answer cap check before the call is made. */
  readonly estimatedCostMicroUsd: number;
  isConfigured(): boolean;
  search(query: string, opts?: SearchOptions): Promise<SearchResponse>;
}

/** A source the answer can cite: ranked, with the stored text that backs claims. */
export interface Source {
  /** 1-based, assigned after ranking: the number claims cite. */
  id: number;
  url: string;
  title: string;
  /** What is stored and checked claims against (the snippet, or an excerpt of the fetched page). */
  text: string;
  publishedAt?: string;
  /** Every provider that returned it. */
  providers: string[];
  trust: number;
  freshness: number;
  score: number;
  /** Set once a receipt (capture) was stored for it. */
  captureId?: string;
}

export interface Claim {
  text: string;
  /** Source ids the claim cites. */
  cites: number[];
  /** Verbatim quotes from the cited sources the model gave as evidence. */
  evidence: string[];
  status: "supported" | "unsupported";
  /** Which cited sources back it (supported claims). */
  supportedBy?: number[];
  /** Why a claim is unsupported (plain words). */
  reason?: string;
  /** The same reason as a code, so a screen can say it in the person's language. */
  reasonCode?: "no_citation" | "bad_cite" | "figure" | "quote" | "overlap";
}

export type QueryKind = "lookup" | "research" | "compare" | "local" | "do" | "workspace";

export interface Plan {
  kind: QueryKind;
  /** Which source families to use. */
  use: Array<"web" | "workspace" | "depth">;
  /** Search queries (the question, reworded for a search index). */
  queries: string[];
  /** Does the question need recent information? */
  recent: boolean;
  /** "model" when the cheap model planned it, "rules" when a rule-based fallback did. */
  by: "model" | "rules";
}

export interface AnswerPayload {
  question: string;
  plan: Plan;
  claims: Claim[];
  sources: Source[];
  followUps: string[];
  /** Plain-language notes: a provider that failed, a cap that was hit, no model configured. */
  notes: string[];
  /** The answer stopped early (credit cap, no sources). Sources found so far are still listed. */
  partial: boolean;
  /** How the claims were written. */
  writtenBy: "model" | "extract";
  /** Sources whose page the agent could not read: the site said no, or wants payment (round 2). */
  blocked?: BlockedSource[];
}

/** A page the agent did not read, and why. The UI explains it and offers the manual path. */
export interface BlockedSource {
  sourceId: number;
  url: string;
  kind: "blocked_by_site" | "payment_required" | "disallowed";
  /** challenge | forbidden | unauthorized | rate_limited | robots | preference */
  reason?: string;
  price?: string | null;
}

/** What a depth reader may report instead of text. */
export type DepthBlock = { kind: BlockedSource["kind"]; reason?: string; price?: string | null };
