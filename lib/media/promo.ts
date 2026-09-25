// Marketr — Phase 5 A1: promo/vanity-code generator.
//
// Unique code per station/spot/publication (radio/print/audio attribution).
// Redemption tracking writes to the ledger; codes are workspace-scoped and
// unique per workspace.

import { randomBytes } from "node:crypto";
import type { MediaStore, PromoCode } from "./store";

export interface GeneratePromoInput {
  workspaceId: string;
  buyId?: string | null;
  /** One code per entry, e.g. "WXYZ-morning-drive", "gazette-full-page". */
  channelRefs: string[];
  /** Prefix stamped on every code, e.g. "FALL". */
  prefix?: string;
  /** Max redemptions per code (null = unlimited). */
  maxRedemptions?: number | null;
}

const CODE_RE = /^[A-Z0-9][A-Z0-9-]{2,31}$/;

function randomSuffix(len = 4): string {
  return randomBytes(len).toString("hex").toUpperCase().slice(0, len);
}

export function assertPromoCode(code: string): void {
  if (!CODE_RE.test(code)) throw new Error(`Invalid promo code "${code}"`);
}

/** Deterministic code shape: PREFIX-CHANNELREF-SUFFIX (channelRef sanitized). */
export function buildPromoCode(prefix: string | undefined, channelRef: string): string {
  const clean = channelRef
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 16);
  const parts = [prefix?.toUpperCase().replace(/[^A-Z0-9]/g, ""), clean || "PROMO", randomSuffix()]
    .filter(Boolean)
    .join("-");
  return parts.slice(0, 32);
}

export interface PromoService {
  generate(input: GeneratePromoInput): Promise<PromoCode[]>;
  redeem(workspaceId: string, code: string, orderRef?: string | null): Promise<{ promo: PromoCode; orderRef: string | null }>;
  list(workspaceId: string, buyId?: string): Promise<PromoCode[]>;
}

export function createPromoService(store: MediaStore): PromoService {
  return {
    async generate(input: GeneratePromoInput): Promise<PromoCode[]> {
      if (!input.channelRefs.length) throw new Error("channelRefs must be non-empty");
      const out: PromoCode[] = [];
      for (const ref of input.channelRefs) {
        // Uniqueness: retry suffix until the workspace has no collision.
        let code = buildPromoCode(input.prefix, ref);
        let guard = 0;
        while ((await store.getPromoCode(input.workspaceId, code)) && guard < 25) {
          code = buildPromoCode(input.prefix, `${ref}-${randomSuffix(2)}`);
          guard++;
        }
        if (await store.getPromoCode(input.workspaceId, code)) {
          throw new Error(`Could not mint a unique promo code for "${ref}"`);
        }
        assertPromoCode(code);
        out.push(
          await store.createPromoCode({
            workspaceId: input.workspaceId,
            buyId: input.buyId ?? null,
            code,
            channelRef: ref,
            maxRedemptions: input.maxRedemptions ?? null,
            status: "active",
          }),
        );
      }
      return out;
    },

    async redeem(workspaceId: string, code: string, orderRef: string | null = null) {
      const promo = await store.getPromoCode(workspaceId, code);
      if (!promo) throw new Error(`Promo code not found: ${code}`);
      await store.recordRedemption(promo.id, orderRef);
      return { promo: (await store.getPromoCode(workspaceId, code))!, orderRef };
    },

    async list(workspaceId: string, buyId?: string): Promise<PromoCode[]> {
      return store.listPromoCodes(workspaceId, buyId);
    },
  };
}

/** Rollup for the report card: redemptions per channel. */
export function promoRollup(promos: PromoCode[]): {
  codes: number;
  totalRedemptions: number;
  byChannel: { channelRef: string; code: string; redemptions: number }[];
} {
  const byChannel = promos
    .map((p) => ({ channelRef: p.channelRef, code: p.code, redemptions: p.redemptionsCount }))
    .sort((a, b) => b.redemptions - a.redemptions);
  return {
    codes: promos.length,
    totalRedemptions: byChannel.reduce((n, c) => n + c.redemptions, 0),
    byChannel,
  };
}
