// Marketr — Phase 5 A1: Prisma-backed MediaStore.
//
// This is the adapter the store.ts header promised: once the A1 Prisma
// fragment merged into prisma/schema.prisma, this PrismaMediaStore
// implements the exact MediaStore interface backed by the real tables —
// no lib/media code changes required. getMediaStore() in store.ts returns
// this implementation when DATABASE_URL is set (real DB), and the memory
// store otherwise (tests / no-DB environments).
//
// HARD RULES (same as the memory store): recordSpendEntry / recordReceipt
// throw on empty approvalRef (zero-custody invariant). Autopilot never
// buys; this store cannot be a backdoor.

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type {
  CallNumber,
  CallWebhookEvent,
  LiftSnapshot,
  MediaReceipt,
  MediaSpendEntry,
  MediaStore,
  PromoCode,
  RedemptionEvent,
  ScanEvent,
  TrackingLink,
} from "./store";
import { MissingApprovalRefError } from "./store";

function requireApprovalRef(approvalRef: unknown, what: string): void {
  if (typeof approvalRef !== "string" || !approvalRef.trim()) {
    throw new MissingApprovalRefError();
  }
}

function toTrackingLink(r: Record<string, unknown>): TrackingLink {
  return {
    id: r.id as string,
    workspaceId: r.workspaceId as string,
    buyId: (r.buyId as string) ?? null,
    placementRef: r.placementRef as string,
    slug: r.slug as string,
    destinationUrl: r.destinationUrl as string,
    utm: (r.utmJson as Record<string, string>) ?? {},
    engine: r.engine as TrackingLink["engine"],
    status: r.status as TrackingLink["status"],
    scansCount: r.scansCount as number,
    createdAt: r.createdAt as Date,
    updatedAt: r.updatedAt as Date,
  };
}

function toScanEvent(r: Record<string, unknown>): ScanEvent {
  return {
    id: r.id as string,
    linkId: r.linkId as string,
    occurredAt: r.occurredAt as Date,
    userAgent: (r.userAgent as string) ?? null,
    ipHash: (r.ipHash as string) ?? null,
    referer: (r.referer as string) ?? null,
  };
}

function toPromoCode(r: Record<string, unknown>): PromoCode {
  return {
    id: r.id as string,
    workspaceId: r.workspaceId as string,
    buyId: (r.buyId as string) ?? null,
    code: r.code as string,
    channelRef: r.channelRef as string,
    redemptionsCount: r.redemptionsCount as number,
    maxRedemptions: (r.maxRedemptions as number) ?? null,
    status: r.status as PromoCode["status"],
    createdAt: r.createdAt as Date,
  };
}

function toCallNumber(r: Record<string, unknown>): CallNumber {
  return {
    id: r.id as string,
    workspaceId: r.workspaceId as string,
    buyId: (r.buyId as string) ?? null,
    provider: r.provider as CallNumber["provider"],
    numberE164: r.numberE164 as string,
    stationRef: r.stationRef as string,
    status: r.status as CallNumber["status"],
    callsCount: r.callsCount as number,
    totalDurationSec: r.totalDurationSec as number,
    firstCallAt: (r.firstCallAt as Date) ?? null,
    lastCallAt: (r.lastCallAt as Date) ?? null,
    createdAt: r.createdAt as Date,
  };
}

function toMediaReceipt(r: Record<string, unknown>): MediaReceipt {
  return {
    id: r.id as string,
    workspaceId: r.workspaceId as string,
    buyId: r.buyId as string,
    // The merged media_receipts table allows NULL invoice refs/amounts
    // (human uploads); the interface contract requires strings — callers
    // must supply them when recording through this ledger.
    platformInvoiceRef: (r.platformInvoiceRef as string) ?? "",
    amountCents: (r.amountCents as number) ?? 0,
    capturedAt: r.capturedAt as Date,
    reconciled: r.reconciled as boolean,
    varianceCents: (r.varianceCents as number) ?? null,
    approvalRef: r.approvalRef as string,
  };
}

function toMediaSpendEntry(r: Record<string, unknown>): MediaSpendEntry {
  return {
    id: r.id as string,
    workspaceId: r.workspaceId as string,
    buyId: r.buyId as string,
    kind: r.kind as MediaSpendEntry["kind"],
    amountCents: r.amountCents as number,
    approvalRef: r.approvalRef as string,
    note: (r.note as string) ?? null,
    createdAt: r.createdAt as Date,
  };
}

export class PrismaMediaStore implements MediaStore {
  // -- Links ---------------------------------------------------------------
  async createTrackingLink(
    input: Omit<TrackingLink, "id" | "scansCount" | "createdAt" | "updatedAt">,
  ): Promise<TrackingLink> {
    const r = await prisma.trackingLink.create({
      data: {
        workspaceId: input.workspaceId,
        buyId: input.buyId,
        placementRef: input.placementRef,
        slug: input.slug,
        destinationUrl: input.destinationUrl,
        utmJson: input.utm ?? {},
        engine: input.engine,
        status: input.status,
      },
    });
    return toTrackingLink(r as unknown as Record<string, unknown>);
  }

  async getTrackingLinkBySlug(workspaceId: string, slug: string): Promise<TrackingLink | null> {
    const r = await prisma.trackingLink.findUnique({
      where: { workspaceId_slug: { workspaceId, slug } },
    });
    return r ? toTrackingLink(r as unknown as Record<string, unknown>) : null;
  }

  async getTrackingLinkBySlugAny(slug: string): Promise<TrackingLink[]> {
    const rows = await prisma.trackingLink.findMany({
      where: { slug: { equals: slug, mode: "insensitive" } },
    });
    return rows.map((r) => toTrackingLink(r as unknown as Record<string, unknown>));
  }

  async listTrackingLinks(workspaceId: string, buyId?: string): Promise<TrackingLink[]> {
    const rows = await prisma.trackingLink.findMany({
      where: { workspaceId, ...(buyId === undefined ? {} : { buyId }) },
      orderBy: { createdAt: "asc" },
    });
    return rows.map((r) => toTrackingLink(r as unknown as Record<string, unknown>));
  }

  async updateTrackingLink(id: string, patch: Partial<TrackingLink>): Promise<TrackingLink> {
    const data: Record<string, unknown> = {};
    if (patch.buyId !== undefined) data.buyId = patch.buyId;
    if (patch.placementRef !== undefined) data.placementRef = patch.placementRef;
    if (patch.slug !== undefined) data.slug = patch.slug;
    if (patch.destinationUrl !== undefined) data.destinationUrl = patch.destinationUrl;
    if (patch.utm !== undefined) data.utmJson = patch.utm;
    if (patch.engine !== undefined) data.engine = patch.engine;
    if (patch.status !== undefined) data.status = patch.status;
    const r = await prisma.trackingLink.update({ where: { id }, data });
    return toTrackingLink(r as unknown as Record<string, unknown>);
  }

  async recordScanEvent(
    linkId: string,
    evt: Omit<ScanEvent, "id" | "linkId">,
  ): Promise<ScanEvent> {
    const r = await prisma.scanEvent.create({
      data: {
        linkId,
        occurredAt: evt.occurredAt,
        userAgent: evt.userAgent,
        ipHash: evt.ipHash,
        referer: evt.referer,
      },
    });
    return toScanEvent(r as unknown as Record<string, unknown>);
  }

  async listScanEvents(linkId: string): Promise<ScanEvent[]> {
    const rows = await prisma.scanEvent.findMany({
      where: { linkId },
      orderBy: { occurredAt: "asc" },
    });
    return rows.map((r) => toScanEvent(r as unknown as Record<string, unknown>));
  }

  async incrementScans(linkId: string): Promise<TrackingLink> {
    const r = await prisma.trackingLink.update({
      where: { id: linkId },
      data: { scansCount: { increment: 1 } },
    });
    return toTrackingLink(r as unknown as Record<string, unknown>);
  }

  // -- Promo codes ----------------------------------------------------------
  async createPromoCode(
    input: Omit<PromoCode, "id" | "redemptionsCount" | "createdAt">,
  ): Promise<PromoCode> {
    const r = await prisma.promoCode.create({
      data: {
        workspaceId: input.workspaceId,
        buyId: input.buyId,
        code: input.code,
        channelRef: input.channelRef,
        maxRedemptions: input.maxRedemptions,
        status: input.status,
      },
    });
    return toPromoCode(r as unknown as Record<string, unknown>);
  }

  async getPromoCode(workspaceId: string, code: string): Promise<PromoCode | null> {
    const r = await prisma.promoCode.findUnique({
      where: { workspaceId_code: { workspaceId, code } },
    });
    return r ? toPromoCode(r as unknown as Record<string, unknown>) : null;
  }

  async listPromoCodes(workspaceId: string, buyId?: string): Promise<PromoCode[]> {
    const rows = await prisma.promoCode.findMany({
      where: { workspaceId, ...(buyId === undefined ? {} : { buyId }) },
      orderBy: { createdAt: "asc" },
    });
    return rows.map((r) => toPromoCode(r as unknown as Record<string, unknown>));
  }

  async recordRedemption(promoCodeId: string, orderRef?: string | null): Promise<RedemptionEvent> {
    const promo = await prisma.promoCode.findUnique({ where: { id: promoCodeId } });
    if (!promo) throw new Error(`PromoCode not found: ${promoCodeId}`);
    if (promo.status !== "active") throw new Error(`Promo code ${promo.code} is ${promo.status}`);
    if (promo.maxRedemptions !== null && promo.redemptionsCount >= promo.maxRedemptions) {
      throw new Error(`Promo code ${promo.code} has hit its redemption cap`);
    }
    await prisma.promoCode.update({
      where: { id: promoCodeId },
      data: { redemptionsCount: { increment: 1 } },
    });
    const r = await prisma.redemptionEvent.create({
      data: { promoCodeId, occurredAt: new Date(), orderRef: orderRef ?? null },
    });
    return {
      id: r.id,
      promoCodeId: r.promoCodeId,
      occurredAt: r.occurredAt,
      orderRef: r.orderRef,
    };
  }

  async listRedemptions(promoCodeId: string): Promise<RedemptionEvent[]> {
    const rows = await prisma.redemptionEvent.findMany({
      where: { promoCodeId },
      orderBy: { occurredAt: "asc" },
    });
    return rows.map((r) => ({
      id: r.id,
      promoCodeId: r.promoCodeId,
      occurredAt: r.occurredAt,
      orderRef: r.orderRef,
    }));
  }

  // -- Call numbers ---------------------------------------------------------
  async createCallNumber(
    input: Omit<CallNumber, "id" | "callsCount" | "totalDurationSec" | "firstCallAt" | "lastCallAt" | "createdAt">,
  ): Promise<CallNumber> {
    const r = await prisma.mediaCallNumber.create({
      data: {
        workspaceId: input.workspaceId,
        buyId: input.buyId,
        provider: input.provider,
        numberE164: input.numberE164,
        stationRef: input.stationRef,
        status: input.status,
      },
    });
    return toCallNumber(r as unknown as Record<string, unknown>);
  }

  async getCallNumberByE164(workspaceId: string, numberE164: string): Promise<CallNumber | null> {
    const r = await prisma.mediaCallNumber.findUnique({
      where: { workspaceId_numberE164: { workspaceId, numberE164 } },
    });
    return r ? toCallNumber(r as unknown as Record<string, unknown>) : null;
  }

  async listCallNumbers(workspaceId: string, buyId?: string): Promise<CallNumber[]> {
    const rows = await prisma.mediaCallNumber.findMany({
      where: { workspaceId, ...(buyId === undefined ? {} : { buyId }) },
      orderBy: { createdAt: "asc" },
    });
    return rows.map((r) => toCallNumber(r as unknown as Record<string, unknown>));
  }

  async applyCallEvent(numberId: string, durationSec: number, occurredAt: Date): Promise<CallNumber> {
    const current = await prisma.mediaCallNumber.findUnique({ where: { id: numberId } });
    if (!current) throw new Error(`CallNumber not found: ${numberId}`);
    const r = await prisma.mediaCallNumber.update({
      where: { id: numberId },
      data: {
        callsCount: { increment: 1 },
        totalDurationSec: { increment: Math.max(0, durationSec) },
        firstCallAt: current.firstCallAt ?? occurredAt,
        lastCallAt: occurredAt,
      },
    });
    return toCallNumber(r as unknown as Record<string, unknown>);
  }

  async insertCallWebhookEvent(
    input: Omit<CallWebhookEvent, "id" | "processedAt">,
  ): Promise<boolean> {
    try {
      await prisma.callWebhookEvent.create({
        data: {
          workspaceId: input.workspaceId,
          provider: input.provider,
          eventId: input.eventId,
          eventType: input.eventType,
          payload: (input.payload ?? {}) as object,
        },
      });
      return true;
    } catch (err) {
      // Unique violation on (provider, eventId) = duplicate delivery.
      if (err instanceof Error && /unique|duplicate|P2002/i.test(err.message)) return false;
      throw err;
    }
  }

  async markCallWebhookProcessed(provider: string, eventId: string): Promise<void> {
    await prisma.callWebhookEvent.update({
      where: { provider_eventId: { provider, eventId } },
      data: { processedAt: new Date() },
    });
  }

  async hasCallWebhookEvent(provider: string, eventId: string): Promise<boolean> {
    const r = await prisma.callWebhookEvent.findUnique({
      where: { provider_eventId: { provider, eventId } },
    });
    return r !== null;
  }

  // -- Lift -----------------------------------------------------------------
  async saveLiftSnapshot(input: Omit<LiftSnapshot, "id" | "capturedAt">): Promise<LiftSnapshot> {
    const r = await prisma.liftSnapshot.create({
      data: {
        workspaceId: input.workspaceId,
        buyId: input.buyId,
        source: input.source,
        baselineJson: input.baselineJson as object,
        flightJson: input.flightJson as object,
        holdoutJson:
          input.holdoutJson === null || input.holdoutJson === undefined
            ? Prisma.JsonNull
            : (input.holdoutJson as object),
      },
    });
    return {
      id: r.id,
      workspaceId: r.workspaceId,
      buyId: r.buyId,
      source: r.source as LiftSnapshot["source"],
      baselineJson: r.baselineJson,
      flightJson: r.flightJson,
      holdoutJson: r.holdoutJson,
      capturedAt: r.capturedAt,
    };
  }

  async listLiftSnapshots(workspaceId: string, buyId: string): Promise<LiftSnapshot[]> {
    const rows = await prisma.liftSnapshot.findMany({
      where: { workspaceId, buyId },
      orderBy: { capturedAt: "asc" },
    });
    return rows.map((r) => ({
      id: r.id,
      workspaceId: r.workspaceId,
      buyId: r.buyId,
      source: r.source as LiftSnapshot["source"],
      baselineJson: r.baselineJson,
      flightJson: r.flightJson,
      holdoutJson: r.holdoutJson,
      capturedAt: r.capturedAt,
    }));
  }

  // -- Spend ledger + receipts (approvalRef mandatory) ----------------------
  async recordSpendEntry(input: Omit<MediaSpendEntry, "id" | "createdAt">): Promise<MediaSpendEntry> {
    requireApprovalRef(input.approvalRef, "recordSpendEntry");
    const r = await prisma.mediaSpendEntry.create({
      data: {
        workspaceId: input.workspaceId,
        buyId: input.buyId,
        kind: input.kind,
        amountCents: input.amountCents,
        approvalRef: input.approvalRef,
        note: input.note,
      },
    });
    return toMediaSpendEntry(r as unknown as Record<string, unknown>);
  }

  async listSpendEntries(workspaceId: string, buyId: string): Promise<MediaSpendEntry[]> {
    const rows = await prisma.mediaSpendEntry.findMany({
      where: { workspaceId, buyId },
      orderBy: { createdAt: "asc" },
    });
    return rows.map((r) => toMediaSpendEntry(r as unknown as Record<string, unknown>));
  }

  async recordReceipt(
    input: Omit<MediaReceipt, "id" | "capturedAt" | "reconciled" | "varianceCents"> & { varianceCents?: number | null },
  ): Promise<MediaReceipt> {
    requireApprovalRef(input.approvalRef, "recordReceipt");
    // The attribution-ledger path captures receipts outside the buying
    // flow's captured_by provenance — "human_upload" is the honest bucket
    // for this interface (vs "browser_executor" DOM-verified captures).
    const r = await prisma.mediaReceipt.create({
      data: {
        workspaceId: input.workspaceId,
        buyId: input.buyId,
        capturedBy: "human_upload",
        platformInvoiceRef: input.platformInvoiceRef || null,
        amountCents: input.amountCents,
        approvalRef: input.approvalRef,
        varianceCents: input.varianceCents ?? null,
      },
    });
    return toMediaReceipt(r as unknown as Record<string, unknown>);
  }

  async listReceipts(workspaceId: string, buyId: string): Promise<MediaReceipt[]> {
    const rows = await prisma.mediaReceipt.findMany({
      where: { workspaceId, buyId },
      orderBy: { capturedAt: "asc" },
    });
    return rows.map((r) => toMediaReceipt(r as unknown as Record<string, unknown>));
  }

  async markReceiptReconciled(id: string, varianceCents: number): Promise<MediaReceipt> {
    const r = await prisma.mediaReceipt.update({
      where: { id },
      data: { reconciled: true, varianceCents },
    });
    return toMediaReceipt(r as unknown as Record<string, unknown>);
  }
}

/** True when the phase-5 attribution tables exist (fragment merged + migrated). */
export async function attributionTablesReady(): Promise<boolean> {
  try {
    await prisma.$queryRawUnsafe(`SELECT 1 FROM tracking_links LIMIT 1`);
    return true;
  } catch {
    return false;
  }
}
