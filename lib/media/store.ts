// Marketr — Phase 5 A1 (offline attribution): storage interfaces + in-memory store.
//
// WHY THIS FILE EXISTS: the A1 Prisma fragment
// (prisma/fragments/phase5-attribution.prisma) WAS merged into
// prisma/schema.prisma (Phase 5 integration). Every lib/media module depends
// ONLY on the MediaStore interface below — the interface is async because the
// Prisma-backed implementation needs it; the memory store keeps the same
// contract. MemoryMediaStore is the fake-mode runtime store used in tests
// and no-DB environments; PrismaMediaStore (lib/media/prisma-store.ts)
// backs the real tables. getMediaStore() picks: DATABASE_URL set → Prisma,
// otherwise memory — no lib/media caller changes needed for the switch.
//
// HARD RULE (zero-custody posture): the spend ledger is never writable
// without an approval reference. recordSpendEntry / recordReceipt throw on
// empty approvalRef. Autopilot never buys; this store cannot be a backdoor.

import { randomBytes } from "node:crypto";

/** cuid()-compatible id generator (prefix "c" + base36 random). */
export function newId(prefix = "c"): string {
  return `${prefix}${randomBytes(12).toString("hex").slice(0, 20)}`;
}

// ---------------------------------------------------------------------------
// Entities (shape-mirror the prisma/fragments/phase5-attribution.prisma models)
// ---------------------------------------------------------------------------

export type LinkEngineKind = "marketr" | "dub";
export type LinkStatus = "active" | "paused" | "archived";

export interface TrackingLink {
  id: string;
  workspaceId: string;
  buyId: string | null;
  placementRef: string;
  slug: string;
  destinationUrl: string;
  utm: Record<string, string>;
  engine: LinkEngineKind;
  status: LinkStatus;
  scansCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface ScanEvent {
  id: string;
  linkId: string;
  occurredAt: Date;
  userAgent: string | null;
  /** SHA-256 of the IP + daily salt — never the raw IP (privacy). */
  ipHash: string | null;
  referer: string | null;
}

export interface PromoCode {
  id: string;
  workspaceId: string;
  buyId: string | null;
  code: string;
  channelRef: string;
  redemptionsCount: number;
  maxRedemptions: number | null;
  status: "active" | "paused" | "expired";
  createdAt: Date;
}

export interface RedemptionEvent {
  id: string;
  promoCodeId: string;
  occurredAt: Date;
  orderRef: string | null;
}

export interface CallNumber {
  id: string;
  workspaceId: string;
  buyId: string | null;
  provider: "callrail" | "fake";
  numberE164: string;
  stationRef: string;
  status: "active" | "released";
  callsCount: number;
  totalDurationSec: number;
  firstCallAt: Date | null;
  lastCallAt: Date | null;
  createdAt: Date;
}

export interface CallWebhookEvent {
  id: string;
  workspaceId: string;
  provider: string;
  eventId: string;
  eventType: string;
  payload: unknown;
  processedAt: Date | null;
}

export interface LiftSnapshot {
  id: string;
  workspaceId: string;
  buyId: string;
  source: "gsc" | "gtrends" | "ga4" | "gbp";
  baselineJson: unknown;
  flightJson: unknown;
  holdoutJson: unknown;
  capturedAt: Date;
}

export interface MediaReceipt {
  id: string;
  workspaceId: string;
  buyId: string;
  platformInvoiceRef: string;
  amountCents: number;
  capturedAt: Date;
  reconciled: boolean;
  varianceCents: number | null;
  approvalRef: string;
}

export type SpendKind = "estimate" | "encumbrance" | "spend" | "release" | "adjust";

export interface MediaSpendEntry {
  id: string;
  workspaceId: string;
  buyId: string;
  kind: SpendKind;
  amountCents: number;
  /** REQUIRED — the safety track's approval id this spend traces to. */
  approvalRef: string;
  note: string | null;
  createdAt: Date;
}

// ---------------------------------------------------------------------------
// Store interface
// ---------------------------------------------------------------------------

export interface MediaStore {
  // Links
  createTrackingLink(input: Omit<TrackingLink, "id" | "scansCount" | "createdAt" | "updatedAt">): Promise<TrackingLink>;
  getTrackingLinkBySlug(workspaceId: string, slug: string): Promise<TrackingLink | null>;
  /** Global slug lookup (scan ingress resolves without a workspace hint). */
  getTrackingLinkBySlugAny(slug: string): Promise<TrackingLink[]>;
  listTrackingLinks(workspaceId: string, buyId?: string): Promise<TrackingLink[]>;
  updateTrackingLink(id: string, patch: Partial<TrackingLink>): Promise<TrackingLink>;
  recordScanEvent(linkId: string, evt: Omit<ScanEvent, "id" | "linkId">): Promise<ScanEvent>;
  listScanEvents(linkId: string): Promise<ScanEvent[]>;
  incrementScans(linkId: string): Promise<TrackingLink>;

  // Promo codes
  createPromoCode(input: Omit<PromoCode, "id" | "redemptionsCount" | "createdAt">): Promise<PromoCode>;
  getPromoCode(workspaceId: string, code: string): Promise<PromoCode | null>;
  listPromoCodes(workspaceId: string, buyId?: string): Promise<PromoCode[]>;
  recordRedemption(promoCodeId: string, orderRef?: string | null): Promise<RedemptionEvent>;
  listRedemptions(promoCodeId: string): Promise<RedemptionEvent[]>;

  // CallRail numbers
  createCallNumber(input: Omit<CallNumber, "id" | "callsCount" | "totalDurationSec" | "firstCallAt" | "lastCallAt" | "createdAt">): Promise<CallNumber>;
  getCallNumberByE164(workspaceId: string, numberE164: string): Promise<CallNumber | null>;
  listCallNumbers(workspaceId: string, buyId?: string): Promise<CallNumber[]>;
  applyCallEvent(numberId: string, durationSec: number, occurredAt: Date): Promise<CallNumber>;
  /** Idempotency ledger for webhooks. Returns true when newly inserted. */
  insertCallWebhookEvent(input: Omit<CallWebhookEvent, "id" | "processedAt">): Promise<boolean>;
  markCallWebhookProcessed(provider: string, eventId: string): Promise<void>;
  hasCallWebhookEvent(provider: string, eventId: string): Promise<boolean>;

  // Lift
  saveLiftSnapshot(input: Omit<LiftSnapshot, "id" | "capturedAt">): Promise<LiftSnapshot>;
  listLiftSnapshots(workspaceId: string, buyId: string): Promise<LiftSnapshot[]>;

  // Spend ledger + receipts (approvalRef mandatory)
  recordSpendEntry(input: Omit<MediaSpendEntry, "id" | "createdAt">): Promise<MediaSpendEntry>;
  listSpendEntries(workspaceId: string, buyId: string): Promise<MediaSpendEntry[]>;
  recordReceipt(input: Omit<MediaReceipt, "id" | "capturedAt" | "reconciled" | "varianceCents"> & { varianceCents?: number | null }): Promise<MediaReceipt>;
  listReceipts(workspaceId: string, buyId: string): Promise<MediaReceipt[]>;
  markReceiptReconciled(id: string, varianceCents: number): Promise<MediaReceipt>;
}

export class MissingApprovalRefError extends Error {
  constructor() {
    super("Spend ledger writes require a non-empty approvalRef (zero-custody invariant)");
    this.name = "MissingApprovalRefError";
  }
}

// ---------------------------------------------------------------------------
// In-memory implementation (fake-mode default runtime)
// ---------------------------------------------------------------------------

export class MemoryMediaStore implements MediaStore {
  private links = new Map<string, TrackingLink>();
  private scans = new Map<string, ScanEvent[]>();
  private promos = new Map<string, PromoCode>();
  private redemptions = new Map<string, RedemptionEvent[]>();
  private numbers = new Map<string, CallNumber>();
  private callEvents = new Set<string>(); // `${provider}:${eventId}`
  private callEventRows = new Map<string, CallWebhookEvent>();
  private lifts: LiftSnapshot[] = [];
  private spend: MediaSpendEntry[] = [];
  private receipts = new Map<string, MediaReceipt>();

  // -- Links ---------------------------------------------------------------
  async createTrackingLink(input: Omit<TrackingLink, "id" | "scansCount" | "createdAt" | "updatedAt">): Promise<TrackingLink> {
    const now = new Date();
    const row: TrackingLink = { ...input, id: newId(), scansCount: 0, createdAt: now, updatedAt: now };
    this.links.set(row.id, row);
    return row;
  }
  async getTrackingLinkBySlug(workspaceId: string, slug: string): Promise<TrackingLink | null> {
    for (const l of this.links.values()) {
      if (l.workspaceId === workspaceId && l.slug.toLowerCase() === slug.toLowerCase()) return l;
    }
    return null;
  }
  async getTrackingLinkBySlugAny(slug: string): Promise<TrackingLink[]> {
    const key = slug.toLowerCase();
    return [...this.links.values()].filter((l) => l.slug.toLowerCase() === key);
  }
  async listTrackingLinks(workspaceId: string, buyId?: string): Promise<TrackingLink[]> {
    return [...this.links.values()].filter(
      (l) => l.workspaceId === workspaceId && (buyId === undefined || l.buyId === buyId),
    );
  }
  async updateTrackingLink(id: string, patch: Partial<TrackingLink>): Promise<TrackingLink> {
    const row = this.links.get(id);
    if (!row) throw new Error(`TrackingLink not found: ${id}`);
    const next = { ...row, ...patch, id: row.id, updatedAt: new Date() };
    this.links.set(id, next);
    return next;
  }
  async recordScanEvent(linkId: string, evt: Omit<ScanEvent, "id" | "linkId">): Promise<ScanEvent> {
    const row: ScanEvent = { ...evt, id: newId(), linkId };
    const arr = this.scans.get(linkId) ?? [];
    arr.push(row);
    this.scans.set(linkId, arr);
    return row;
  }
  async listScanEvents(linkId: string): Promise<ScanEvent[]> {
    return [...(this.scans.get(linkId) ?? [])];
  }
  async incrementScans(linkId: string): Promise<TrackingLink> {
    const row = this.links.get(linkId);
    if (!row) throw new Error(`TrackingLink not found: ${linkId}`);
    row.scansCount += 1;
    row.updatedAt = new Date();
    return row;
  }

  // -- Promo codes ----------------------------------------------------------
  async createPromoCode(input: Omit<PromoCode, "id" | "redemptionsCount" | "createdAt">): Promise<PromoCode> {
    const row: PromoCode = { ...input, id: newId(), redemptionsCount: 0, createdAt: new Date() };
    this.promos.set(row.id, row);
    return row;
  }
  async getPromoCode(workspaceId: string, code: string): Promise<PromoCode | null> {
    for (const p of this.promos.values()) {
      if (p.workspaceId === workspaceId && p.code.toLowerCase() === code.toLowerCase()) return p;
    }
    return null;
  }
  async listPromoCodes(workspaceId: string, buyId?: string): Promise<PromoCode[]> {
    return [...this.promos.values()].filter(
      (p) => p.workspaceId === workspaceId && (buyId === undefined || p.buyId === buyId),
    );
  }
  async recordRedemption(promoCodeId: string, orderRef: string | null = null): Promise<RedemptionEvent> {
    const promo = this.promos.get(promoCodeId);
    if (!promo) throw new Error(`PromoCode not found: ${promoCodeId}`);
    if (promo.status !== "active") throw new Error(`Promo code ${promo.code} is ${promo.status}`);
    if (promo.maxRedemptions !== null && promo.redemptionsCount >= promo.maxRedemptions) {
      throw new Error(`Promo code ${promo.code} has hit its redemption cap`);
    }
    promo.redemptionsCount += 1;
    const row: RedemptionEvent = { id: newId(), promoCodeId, occurredAt: new Date(), orderRef };
    const arr = this.redemptions.get(promoCodeId) ?? [];
    arr.push(row);
    this.redemptions.set(promoCodeId, arr);
    return row;
  }
  async listRedemptions(promoCodeId: string): Promise<RedemptionEvent[]> {
    return [...(this.redemptions.get(promoCodeId) ?? [])];
  }

  // -- Call numbers ---------------------------------------------------------
  async createCallNumber(input: Omit<CallNumber, "id" | "callsCount" | "totalDurationSec" | "firstCallAt" | "lastCallAt" | "createdAt">): Promise<CallNumber> {
    const row: CallNumber = {
      ...input, id: newId(), callsCount: 0, totalDurationSec: 0,
      firstCallAt: null, lastCallAt: null, createdAt: new Date(),
    };
    this.numbers.set(row.id, row);
    return row;
  }
  async getCallNumberByE164(workspaceId: string, numberE164: string): Promise<CallNumber | null> {
    for (const n of this.numbers.values()) {
      if (n.workspaceId === workspaceId && n.numberE164 === numberE164) return n;
    }
    return null;
  }
  async listCallNumbers(workspaceId: string, buyId?: string): Promise<CallNumber[]> {
    return [...this.numbers.values()].filter(
      (n) => n.workspaceId === workspaceId && (buyId === undefined || n.buyId === buyId),
    );
  }
  async applyCallEvent(numberId: string, durationSec: number, occurredAt: Date): Promise<CallNumber> {
    const row = this.numbers.get(numberId);
    if (!row) throw new Error(`CallNumber not found: ${numberId}`);
    row.callsCount += 1;
    row.totalDurationSec += Math.max(0, durationSec);
    if (!row.firstCallAt) row.firstCallAt = occurredAt;
    row.lastCallAt = occurredAt;
    return row;
  }
  async insertCallWebhookEvent(input: Omit<CallWebhookEvent, "id" | "processedAt">): Promise<boolean> {
    const key = `${input.provider}:${input.eventId}`;
    if (this.callEvents.has(key)) return false;
    this.callEvents.add(key);
    this.callEventRows.set(key, { ...input, id: newId(), processedAt: null });
    return true;
  }
  async markCallWebhookProcessed(provider: string, eventId: string): Promise<void> {
    const row = this.callEventRows.get(`${provider}:${eventId}`);
    if (row) row.processedAt = new Date();
  }
  async hasCallWebhookEvent(provider: string, eventId: string): Promise<boolean> {
    return this.callEvents.has(`${provider}:${eventId}`);
  }

  // -- Lift -----------------------------------------------------------------
  async saveLiftSnapshot(input: Omit<LiftSnapshot, "id" | "capturedAt">): Promise<LiftSnapshot> {
    const row: LiftSnapshot = { ...input, id: newId(), capturedAt: new Date() };
    this.lifts.push(row);
    return row;
  }
  async listLiftSnapshots(workspaceId: string, buyId: string): Promise<LiftSnapshot[]> {
    return this.lifts.filter((l) => l.workspaceId === workspaceId && l.buyId === buyId);
  }

  // -- Spend ledger + receipts ----------------------------------------------
  async recordSpendEntry(input: Omit<MediaSpendEntry, "id" | "createdAt">): Promise<MediaSpendEntry> {
    if (!input.approvalRef || !input.approvalRef.trim()) throw new MissingApprovalRefError();
    const row: MediaSpendEntry = { ...input, id: newId(), createdAt: new Date() };
    this.spend.push(row);
    return row;
  }
  async listSpendEntries(workspaceId: string, buyId: string): Promise<MediaSpendEntry[]> {
    return this.spend.filter((s) => s.workspaceId === workspaceId && s.buyId === buyId);
  }
  async recordReceipt(input: Omit<MediaReceipt, "id" | "capturedAt" | "reconciled" | "varianceCents"> & { varianceCents?: number | null }): Promise<MediaReceipt> {
    if (!input.approvalRef || !input.approvalRef.trim()) throw new MissingApprovalRefError();
    const row: MediaReceipt = {
      ...input, id: newId(), capturedAt: new Date(),
      reconciled: false, varianceCents: input.varianceCents ?? null,
    };
    this.receipts.set(row.id, row);
    return row;
  }
  async listReceipts(workspaceId: string, buyId: string): Promise<MediaReceipt[]> {
    return [...this.receipts.values()].filter((r) => r.workspaceId === workspaceId && r.buyId === buyId);
  }
  async markReceiptReconciled(id: string, varianceCents: number): Promise<MediaReceipt> {
    const row = this.receipts.get(id);
    if (!row) throw new Error(`MediaReceipt not found: ${id}`);
    row.reconciled = true;
    row.varianceCents = varianceCents;
    return row;
  }
}

// Process-local singleton for routes/UI/dev (fake-mode default). The Prisma
// adapter replaces this when the fragment merges into schema.prisma.
// [Phase 5 integration] The fragment IS merged now: when DATABASE_URL is set
// the Prisma-backed store (lib/media/prisma-store.ts) is the default; the
// memory store is used only when no database is configured (tests, dev
// without a DB). Lazily required so processes without a DB never load the
// Prisma client.
let singleton: MediaStore | null = null;
export function getMediaStore(): MediaStore {
  if (!singleton) {
    if (process.env.DATABASE_URL) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { PrismaMediaStore } = require("./prisma-store") as {
        PrismaMediaStore: new () => MediaStore;
      };
      singleton = new PrismaMediaStore();
    } else {
      singleton = new MemoryMediaStore();
    }
  }
  return singleton;
}

/** Force the memory store (tests that must not touch the DB). */
export function useMemoryMediaStore(): MediaStore {
  singleton = new MemoryMediaStore();
  return singleton;
}

/** Test helper: drop the singleton so batteries start clean. */
export function resetMediaStore(): void {
  singleton = null;
}
