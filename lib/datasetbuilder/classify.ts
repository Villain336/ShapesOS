// Marketr — Dataset Builder slice 2: classification domain types + engines.
// Spec: BUSINESS-OS-FEATURE-SPECS.md §1 Slice 2 (Structure).
//
// Auto-classify chunks into the six dataset types. Every classification
// carries a confidence score + engine lineage; anything below the
// auto-apply threshold routes to a ReviewItem (draft-for-approval, the OS
// trust ladder) instead of being force-fit into a type.

import { DatasetBuilderError } from "./types";

export type DatasetType =
  | "faq"
  | "product_catalog"
  | "policy"
  | "process_sop"
  | "company_fact"
  | "pricing";

export const DATASET_TYPES: DatasetType[] = [
  "faq",
  "product_catalog",
  "policy",
  "process_sop",
  "company_fact",
  "pricing",
];

export const DATASET_TYPE_LABELS: Record<DatasetType, string> = {
  faq: "FAQs",
  product_catalog: "Products / catalog",
  policy: "Policies",
  process_sop: "Processes / SOPs",
  company_fact: "Company facts",
  pricing: "Pricing",
};

export type ClassificationStatus = "applied" | "pending_review" | "rejected";

export type ReviewItemStatus = "pending" | "approved" | "rejected";

export interface ClassificationInput {
  workspaceId: string;
  /** Chunk being classified — must reference a live chunk. */
  chunkId: string;
  datasetType: DatasetType;
  /** 0–1. Below threshold → pending_review + ReviewItem, never auto-applied. */
  confidence: number;
  engine: string;
  engineVersion: string;
  status?: ClassificationStatus;
}

export interface ClassificationRecord {
  id: string;
  workspaceId: string;
  chunkId: string;
  datasetType: DatasetType;
  confidence: number;
  engine: string;
  engineVersion: string;
  status: ClassificationStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface ReviewItemInput {
  workspaceId: string;
  /** The pending_review classification awaiting a human decision. */
  classificationId: string;
  note?: string;
}

export interface ReviewItemRecord {
  id: string;
  workspaceId: string;
  classificationId: string;
  status: ReviewItemStatus;
  note: string | null;
  decidedBy: string | null;
  decidedAt: Date | null;
  createdAt: Date;
}

/** A pending review bundled with everything the reviewer needs to decide. */
export interface ReviewItemDetail {
  review: ReviewItemRecord;
  classification: ClassificationRecord;
  chunkText: string;
  documentName: string;
  sourceName: string;
}

export type ReviewAction = "approve" | "reassign" | "reject";

export interface ReviewDecision {
  action: ReviewAction;
  /** Required when action is "reassign". */
  datasetType?: DatasetType;
  note?: string;
  decidedBy?: string;
}

export interface TypeBreakdown {
  workspaceId: string;
  /** Counts of applied classifications per type. */
  byType: Record<DatasetType, number>;
  /** Chunks with no classification at all. */
  unclassified: number;
  /** Classifications awaiting human review. */
  pendingReview: number;
}

/** Confidence at or above this auto-applies; below it → ReviewItem. */
export const DEFAULT_CLASSIFICATION_THRESHOLD = 0.6;

/** What a classification engine returns for one chunk of text. */
export interface ClassificationOutput {
  type: DatasetType;
  /** 0–1 confidence. */
  confidence: number;
}

export interface ClassificationEngine {
  readonly name: string;
  readonly version: string;
  classify(text: string): Promise<ClassificationOutput>;
}

// ------------------------------------------------- rules classifier ---

interface Signal {
  re: RegExp;
  /** Heavier signals count more than incidental keyword hits. */
  weight: number;
}

const SIGNALS: Record<DatasetType, Signal[]> = {
  faq: [
    { re: /\?/g, weight: 1 },
    { re: /^(q:|a:|question:|answer:)/im, weight: 3 },
    { re: /\b(how do i|how to|how can i|what is|what are|can i|do you|does it|frequently asked)\b/i, weight: 2 },
  ],
  product_catalog: [
    { re: /\bsku\b/i, weight: 3 },
    { re: /\b(in stock|out of stock|dimensions|model number|specifications|\bspecs\b)\b/i, weight: 2 },
    { re: /\b(weight|warranty|color options|features:)\b/i, weight: 1 },
  ],
  policy: [
    { re: /\b(policy|policies|terms of service|privacy policy)\b/i, weight: 2 },
    { re: /\b(must not|shall not|prohibited|is prohibited|we reserve the right|compliance|violation)\b/i, weight: 2 },
    { re: /\b(required|not permitted|effective date)\b/i, weight: 1 },
  ],
  process_sop: [
    { re: /\bstep\s+\d+/i, weight: 3 },
    { re: /\b(procedure|\bsop\b|checklist|workflow|playbook)\b/i, weight: 2 },
    { re: /\b(first,|then,|next,|finally,|after that)\b/i, weight: 1 },
  ],
  company_fact: [
    { re: /\b(founded|headquarters|headquartered)\b/i, weight: 2 },
    { re: /\b(our mission|about us|we are|team of \d+|\d+ employees)\b/i, weight: 2 },
    { re: /\bsince (19|20)\d{2}\b/i, weight: 2 },
    { re: /\b(ceo|founded by)\b/i, weight: 1 },
  ],
  pricing: [
    { re: /\$\d[\d,]*/, weight: 3 },
    { re: /\b(price|pricing|per month|\/mo\b|per year|\/yr\b)\b/i, weight: 2 },
    { re: /\b(plan|tier|free trial|enterprise|billed annually|one-time)\b/i, weight: 1 },
  ],
};

function scoreType(text: string, signals: Signal[]): number {
  let points = 0;
  for (const s of signals) {
    // Fresh regex per test — the /g flag mutates lastIndex.
    const re = new RegExp(s.re.source, s.re.flags);
    let hits = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      hits += 1;
      if (!re.global) break;
      // Guard against zero-width infinite loops.
      if (m[0].length === 0) re.lastIndex += 1;
    }
    if (hits > 0) points += Math.min(hits, 2) * s.weight;
  }
  // 0–1 scale: ~6 weighted points is a confident match.
  return Math.min(1, points / 6);
}

/**
 * Deterministic rules classifier — the default engine. No network, no keys.
 * Needs roughly two independent signals to clear the auto-apply threshold;
 * single-signal or ambiguous text routes to human review.
 */
export class RulesClassificationEngine implements ClassificationEngine {
  readonly name = "rules";
  readonly version = "rules-v1";

  async classify(text: string): Promise<ClassificationOutput> {
    const trimmed = text.trim();
    if (!trimmed) return { type: "company_fact", confidence: 0.2 };

    const scores = DATASET_TYPES.map((t) => ({
      type: t,
      score: scoreType(trimmed, SIGNALS[t]),
    })).sort((a, b) => b.score - a.score);

    const [best, second] = scores;
    let confidence = 0.35 + 0.6 * best.score;
    // Ambiguous: the runner-up is nearly as strong — don't force-fit.
    if (second.score >= best.score - 0.17 && best.score > 0) {
      confidence *= 0.7;
    }
    return {
      type: best.type,
      confidence: Math.round(confidence * 100) / 100,
    };
  }
}

/**
 * Frontier-API classification stub. Fail-closed like the slice-1 engines:
 * no key, no call. A later slice can implement the call.
 */
export class FrontierClassificationEngine implements ClassificationEngine {
  readonly name = "frontier-api";
  readonly version = "frontier-v1";
  private readonly apiKey: string | null;

  constructor(apiKey?: string) {
    this.apiKey = apiKey ?? process.env.EXTRACTION_API_KEY ?? null;
  }

  async classify(_text: string): Promise<ClassificationOutput> {
    if (!this.apiKey) {
      throw new DatasetBuilderError(
        "ENGINE_NOT_CONFIGURED",
        "frontier classification API key is not configured (EXTRACTION_API_KEY)",
      );
    }
    throw new DatasetBuilderError(
      "ENGINE_NOT_CONFIGURED",
      "frontier classification execution lands in a later slice",
    );
  }
}
