// Marketr — Connector Agent slice 5: Funding/VC plug-in.
// SPEC-CONNECTOR-AGENT.md §5/§6.
//
// Two hooks, both FUNDING-mode only:
//
// 1. Raise-workflow writeback — when a FUNDING-mode introduction linked to
//    a FundingInvestor is MADE (both acceptances + sent), the intro writes
//    back to the raise workflow: a FundingInteraction (kind "intro") on the
//    investor, and the investor's stage advances target → contacted when it
//    was still a cold target (the advance reuses the funding store's legal
//    transition path, which records its own stage_change interaction).
//
// 2. Data-room offer insertion — an investor intro draft can offer
//    data-room access as the side-B value proposition ("happy to share the
//    deck + data room"). The offer mints a REAL FundingShareLink and
//    inserts its real URL — never a placeholder. Preferred doc: the pitch
//    deck (kind pitch_deck with a current version); fallback: any doc with
//    a version; last resort: a whole-room link (docId = null).
//
// Neither hook duplicates investor data: the connector READS FundingInvestor
// rows and links introductions N:1 to them.

import type { PrismaClient } from "@prisma/client";
import { ConnectorError } from "./types";
import { PrismaFundingStore } from "../funding/prisma-store";
import type { ConnectorMode } from "./modes";

export interface WritebackResult {
  /** False when the intro is not a FUNDING-mode investor-linked intro. */
  written: boolean;
  interactionId: string | null;
  /** True when the investor advanced target → contacted by the writeback. */
  stageAdvanced: boolean;
  stageFrom: string | null;
  stageTo: string | null;
}

/**
 * Raise-workflow writeback for a completed introduction. Called from the
 * intro store's makeIntro AFTER the intro reaches `made` — never before
 * the money rule fires. Best-effort on the stage advance: if the investor
 * has already moved (or was deleted), the intro interaction still lands
 * and the advance is reported as not-applied rather than throwing.
 */
export async function writebackIntroductionMade(
  prisma: PrismaClient,
  workspaceId: string,
  introId: string,
  opts: { sentBy: string; now?: Date },
): Promise<WritebackResult> {
  const now = opts.now ?? new Date();
  const intro = await prisma.connectorIntroduction.findFirst({
    where: { id: introId, workspaceId },
    include: {
      personA: { select: { name: true } },
      personB: { select: { name: true } },
    },
  });
  if (!intro) {
    throw new ConnectorError("introduction_not_found", "Introduction not found in this workspace.");
  }
  const mode = intro.mode as ConnectorMode;
  if (mode !== "funding" || !intro.fundingInvestorId) {
    return { written: false, interactionId: null, stageAdvanced: false, stageFrom: null, stageTo: null };
  }

  const funding = new PrismaFundingStore(prisma);
  const investor = await prisma.fundingInvestor.findFirst({
    where: { id: intro.fundingInvestorId, workspaceId },
    select: { id: true, name: true, stage: true },
  });
  if (!investor) {
    // The investor row is gone (deleted after the proposal). The intro is
    // already made — record nothing rather than fail the completion.
    return { written: false, interactionId: null, stageAdvanced: false, stageFrom: null, stageTo: null };
  }

  const interaction = await funding.logInteraction(
    workspaceId,
    investor.id,
    {
      kind: "intro",
      summary: `Connector intro made: ${intro.personA.name} → ${intro.personB.name} (warm intro, double-opt-in).`,
      occurredAt: now.toISOString(),
    },
    opts.sentBy,
  );

  let stageAdvanced = false;
  const stageFrom = investor.stage;
  let stageTo: string | null = null;
  if (investor.stage === "target") {
    try {
      const updated = await funding.transitionStage(
        workspaceId,
        investor.id,
        "contacted",
        opts.sentBy || "founder",
      );
      stageAdvanced = true;
      stageTo = updated.stage;
    } catch {
      // Already moved / illegal from a concurrent update — the intro
      // interaction above is the durable record; the advance is optional.
      stageAdvanced = false;
    }
  }

  return {
    written: true,
    interactionId: interaction.id,
    stageAdvanced,
    stageFrom,
    stageTo,
  };
}

// ---------------------------------------------------------------------------
// Data-room offer insertion.
// ---------------------------------------------------------------------------

export interface DataRoomOfferResult {
  shareLinkId: string;
  /** The REAL share URL path (e.g. /r/funding/fsr_…) — never a placeholder. */
  urlPath: string;
  docTitle: string | null;
  /** True when the link covers the whole room (no single doc chosen). */
  wholeRoom: boolean;
}

export interface AttachDataRoomOfferOpts {
  /** Prefer this doc; falls back to the deck / any doc / whole room. */
  docId?: string | null;
  /** Share-link expiry in days from now (default 30). */
  expiresInDays?: number;
  /** Optional viewer-email allowlist for the minted link. */
  viewerEmails?: string[];
}

/** Pick the doc to offer: requested → pitch deck → any doc → null (whole room). */
async function pickOfferDoc(
  prisma: PrismaClient,
  workspaceId: string,
  requestedDocId: string | null,
): Promise<{ id: string; title: string } | null> {
  if (requestedDocId) {
    const doc = await prisma.fundingDataRoomDoc.findFirst({
      where: { id: requestedDocId, workspaceId },
      select: { id: true, title: true, currentVersionId: true },
    });
    if (!doc) {
      throw new ConnectorError("dataroom_doc_not_found", "Data-room document not found in this workspace.");
    }
    return { id: doc.id, title: doc.title };
  }
  const deck = await prisma.fundingDataRoomDoc.findFirst({
    where: { workspaceId, kind: "pitch_deck", currentVersionId: { not: null } },
    orderBy: { updatedAt: "desc" },
    select: { id: true, title: true },
  });
  if (deck) return { id: deck.id, title: deck.title };
  const anyDoc = await prisma.fundingDataRoomDoc.findFirst({
    where: { workspaceId, currentVersionId: { not: null } },
    orderBy: { updatedAt: "desc" },
    select: { id: true, title: true },
  });
  return anyDoc ? { id: anyDoc.id, title: anyDoc.title } : null;
}

/**
 * Mint a real data-room share link for an investor intro draft. The
 * returned urlPath is the actual token URL — the draft inserts it
 * verbatim, so "happy to share the deck + data room" always points at a
 * working link.
 */
export async function attachDataRoomOffer(
  prisma: PrismaClient,
  workspaceId: string,
  opts: AttachDataRoomOfferOpts = {},
): Promise<DataRoomOfferResult> {
  const doc = await pickOfferDoc(prisma, workspaceId, opts.docId ?? null);
  const funding = new PrismaFundingStore(prisma);
  const expiresInDays = opts.expiresInDays ?? 30;
  const link = await funding.createShareLink(
    workspaceId,
    {
      docId: doc ? doc.id : null,
      docVersionId: null,
      expiresAt: new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString(),
      viewerEmails: opts.viewerEmails ?? [],
    },
  );
  return {
    shareLinkId: link.id,
    urlPath: link.urlPath,
    docTitle: doc ? doc.title : null,
    wholeRoom: !doc,
  };
}

/**
 * The side-B value-proposition line appended to the draft offer message.
 * Pure — the copy shape is pinned by tests so the offer wording never
 * drifts into a placeholder.
 */
export function buildDataRoomOfferLine(offer: DataRoomOfferResult): string {
  const what = offer.wholeRoom
    ? "our data room"
    : `our deck and data room ("${offer.docTitle}")`;
  return `Happy to share ${what} as well: ${offer.urlPath}`;
}
