// Marketr — Phase 7 F4: CTV store + F4-scoped audit.
//
// Storage interface for the CTV track with a memory implementation (tests,
// verify battery). The phase-7 coordinator backs this interface with the
// prisma fragments (phase7-ctv.prisma) at merge time; routes program to the
// interface, never to Prisma directly.
//
// The F4 audit log is workspace-scoped and hash-chained (tamper-evident),
// mirroring lib/media/audit.ts: validation results, IO state transitions,
// and adapter actions are all logged. It lives in this namespace so the
// track owns its trail; the coordinator may union it with the media audit
// at merge time.

import { sha256Hex } from "@/lib/media/safety";
import { canonicalize } from "@/lib/media/approvals";
import { createId } from "@/lib/media/ids";
import { prisma } from "@/lib/prisma";

// ---------------------------------------------------------------------------
// Row types (mirror prisma/fragments/phase7-ctv.prisma)
// ---------------------------------------------------------------------------

export type CtvPlatform =
  | "vibe" | "mntn" | "roku" | "tatari" | "tvscientific"
  | "seat:ttd" | "seat:dv360" | "seat:amazon" | "seat:basis";
export type CtvMode = "api" | "concierge";
export type CtvCampaignStatus =
  | "draft" | "pending_vendor_approval" | "human_placed" | "live"
  | "reconciling" | "paused" | "complete" | "cancelled";
export type CtvIoState =
  | "draft" | "pending_vendor_approval" | "human_placed" | "live" | "reconciling" | "cancelled";

export interface CtvCampaignRow {
  id: string;
  workspaceId: string;
  name: string;
  platform: CtvPlatform;
  mode: CtvMode;
  status: CtvCampaignStatus;
  approvalObjectId: string | null;
  budgetCents: number | null;
  currency: string;
  flightStart: Date | null;
  flightEnd: Date | null;
  targetingJson: Record<string, unknown> | null;
  creativeIds: string[];
  creativeHashes: string[];
  vibeAdvertiserId: string | null;
  vibeCampaignId: string | null;
  vibeTestMode: boolean;
  vibeConfigRef: string | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CtvCreativeValidationRow {
  id: string;
  workspaceId: string;
  campaignId: string | null;
  creativeId: string;
  creativeSha256: string | null;
  ffprobeJson: Record<string, unknown>;
  pass: boolean;
  checks: { name: string; passed: boolean; detail: string; heuristic?: boolean }[];
  durationSeconds: number | null;
  publisher: string | null;
  publisherRulesVersion: string;
  validatedBy: string | null;
  createdAt: Date;
}

export interface CtvSpotRow {
  id: string;
  workspaceId: string;
  campaignId: string;
  placementLabel: string;
  showGenre: string | null;
  daypart: string | null;
  demo: string | null;
  creativeId: string | null;
  qrId: string | null;
  purlId: string | null;
  qrSvg: string | null;
  flightFrom: Date | null;
  flightTo: Date | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CtvIoRow {
  id: string;
  workspaceId: string;
  campaignId: string;
  vendor: string;
  ioPayload: Record<string, unknown>;
  state: CtvIoState;
  placedBy: string | null;
  placedAt: Date | null;
  vendorConfirmation: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CtvPixelRow {
  id: string;
  workspaceId: string;
  campaignId: string;
  pixelUrl: string;
  pixelToken: string;
  viewThroughWindowDays: number;
  impressionsCount: number;
  createdAt: Date;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// F4 audit
// ---------------------------------------------------------------------------

export type CtvAuditAction =
  | "creative_validated"
  | "campaign_created" | "campaign_paused"
  | "spot_kit_minted"
  | "io_created" | "io_state_transition" | "io_brief_generated"
  | "vibe_call" | "vibe_budget_move_rejected"
  | "concierge_pause_alerted"
  | "seat_status_checked" | "seat_action_rejected"
  | "attribution_viewed" | "pixel_impression";

export interface CtvAuditEvent {
  id: string;
  workspaceId: string;
  ts: Date;
  actor: string;
  action: CtvAuditAction;
  subjectType: "campaign" | "creative" | "spot" | "io" | "pixel" | "adapter" | "workspace";
  subjectId: string | null;
  payloadHash: string;
  prevHash: string;
  eventHash: string;
  detail: Record<string, unknown> | null;
}

export function ctvAuditEventHashFor(
  prevHash: string,
  fields: { workspaceId: string; ts: string; actor: string; action: string; subjectType: string; subjectId: string | null; payloadHash: string },
): string {
  return sha256Hex(
    prevHash + "|" + canonicalize({
      workspace_id: fields.workspaceId, ts: fields.ts, actor: fields.actor,
      action: fields.action, subject_type: fields.subjectType,
      subject_id: fields.subjectId, payload_hash: fields.payloadHash,
      track: "f4-ctv",
    }),
  );
}

// ---------------------------------------------------------------------------
// Store interface
// ---------------------------------------------------------------------------

export interface CtvStore {
  // campaigns
  createCampaign(input: Omit<CtvCampaignRow, "id" | "createdAt" | "updatedAt">): Promise<CtvCampaignRow>;
  getCampaign(workspaceId: string, id: string): Promise<CtvCampaignRow | null>;
  listCampaigns(workspaceId: string): Promise<CtvCampaignRow[]>;
  updateCampaign(workspaceId: string, id: string, patch: Partial<CtvCampaignRow>): Promise<CtvCampaignRow | null>;
  // validations
  createValidation(input: Omit<CtvCreativeValidationRow, "id" | "createdAt">): Promise<CtvCreativeValidationRow>;
  listValidations(workspaceId: string, creativeId?: string): Promise<CtvCreativeValidationRow[]>;
  // spots
  createSpot(input: Omit<CtvSpotRow, "id" | "createdAt" | "updatedAt">): Promise<CtvSpotRow>;
  listSpots(workspaceId: string, campaignId: string): Promise<CtvSpotRow[]>;
  // ios
  createIo(input: Omit<CtvIoRow, "id" | "createdAt" | "updatedAt">): Promise<CtvIoRow>;
  getIo(workspaceId: string, id: string): Promise<CtvIoRow | null>;
  updateIo(workspaceId: string, id: string, patch: Partial<CtvIoRow>): Promise<CtvIoRow | null>;
  // pixels
  createPixel(input: Omit<CtvPixelRow, "id" | "createdAt" | "updatedAt">): Promise<CtvPixelRow>;
  getPixel(workspaceId: string, id: string): Promise<CtvPixelRow | null>;
  /** Public-route lookup: pixel id only (no workspace hint on the tag). */
  getPixelAny(id: string): Promise<CtvPixelRow | null>;
  getPixelByToken(token: string): Promise<CtvPixelRow | null>;
  listPixels(workspaceId: string, campaignId: string): Promise<CtvPixelRow[]>;
  incrementImpressions(pixelId: string): Promise<void>;
  // audit
  audit(input: {
    workspaceId: string; actor: string; action: CtvAuditAction;
    subjectType: CtvAuditEvent["subjectType"]; subjectId?: string | null;
    detail?: Record<string, unknown> | null;
  }): Promise<CtvAuditEvent>;
  auditList(workspaceId: string, limit?: number): Promise<CtvAuditEvent[]>;
}

function scoped<T extends { workspaceId: string }>(rows: Map<string, T>, workspaceId: string, id: string): T | null {
  const row = rows.get(id);
  return row && row.workspaceId === workspaceId ? { ...row } : null;
}

/** Memory implementation: tests + verify battery. */
export function createMemoryCtvStore(): CtvStore {
  const campaigns = new Map<string, CtvCampaignRow>();
  const validations: CtvCreativeValidationRow[] = [];
  const spots = new Map<string, CtvSpotRow>();
  const ios = new Map<string, CtvIoRow>();
  const pixels = new Map<string, CtvPixelRow>();
  const events: CtvAuditEvent[] = [];
  const heads = new Map<string, string>();

  return {
    async createCampaign(input) {
      const now = new Date();
      const row = { ...input, id: createId(), createdAt: now, updatedAt: now };
      campaigns.set(row.id, row);
      return { ...row };
    },
    async getCampaign(workspaceId, id) { return scoped(campaigns, workspaceId, id); },
    async listCampaigns(workspaceId) {
      return [...campaigns.values()].filter((c) => c.workspaceId === workspaceId).map((c) => ({ ...c }));
    },
    async updateCampaign(workspaceId, id, patch) {
      const row = scoped(campaigns, workspaceId, id);
      if (!row) return null;
      const next = { ...row, ...patch, id: row.id, workspaceId: row.workspaceId, updatedAt: new Date() };
      campaigns.set(id, next);
      return { ...next };
    },
    async createValidation(input) {
      const row = { ...input, id: createId(), createdAt: new Date() };
      validations.push(row);
      return { ...row };
    },
    async listValidations(workspaceId, creativeId) {
      return validations
        .filter((v) => v.workspaceId === workspaceId && (!creativeId || v.creativeId === creativeId))
        .map((v) => ({ ...v }));
    },
    async createSpot(input) {
      const now = new Date();
      const row = { ...input, id: createId(), createdAt: now, updatedAt: now };
      spots.set(row.id, row);
      return { ...row };
    },
    async listSpots(workspaceId, campaignId) {
      return [...spots.values()]
        .filter((s) => s.workspaceId === workspaceId && s.campaignId === campaignId)
        .map((s) => ({ ...s }));
    },
    async createIo(input) {
      const now = new Date();
      const row = { ...input, id: createId(), createdAt: now, updatedAt: now };
      ios.set(row.id, row);
      return { ...row };
    },
    async getIo(workspaceId, id) { return scoped(ios, workspaceId, id); },
    async updateIo(workspaceId, id, patch) {
      const row = scoped(ios, workspaceId, id);
      if (!row) return null;
      const next = { ...row, ...patch, id: row.id, workspaceId: row.workspaceId, updatedAt: new Date() };
      ios.set(id, next);
      return { ...next };
    },
    async createPixel(input) {
      const now = new Date();
      const row = { ...input, id: createId(), createdAt: now, updatedAt: now };
      pixels.set(row.id, row);
      return { ...row };
    },
    async getPixel(workspaceId, id) { return scoped(pixels, workspaceId, id); },
    async getPixelByToken(token) {
      const row = [...pixels.values()].find((p) => p.pixelToken === token);
      return row ? { ...row } : null;
    },
    async getPixelAny(id) {
      const row = pixels.get(id);
      return row ? { ...row } : null;
    },
    async listPixels(workspaceId, campaignId) {
      return [...pixels.values()]
        .filter((p) => p.workspaceId === workspaceId && p.campaignId === campaignId)
        .map((p) => ({ ...p }));
    },
    async incrementImpressions(pixelId) {
      const row = pixels.get(pixelId);
      if (row) pixels.set(pixelId, { ...row, impressionsCount: row.impressionsCount + 1, updatedAt: new Date() });
    },
    async audit(input) {
      const ts = new Date();
      const payloadHash = sha256Hex(canonicalize(input.detail ?? {}));
      const prevHash = heads.get(input.workspaceId) ?? "GENESIS";
      const eventHash = ctvAuditEventHashFor(prevHash, {
        workspaceId: input.workspaceId, ts: ts.toISOString(), actor: input.actor,
        action: input.action, subjectType: input.subjectType,
        subjectId: input.subjectId ?? null, payloadHash,
      });
      const row: CtvAuditEvent = {
        id: createId(), workspaceId: input.workspaceId, ts, actor: input.actor,
        action: input.action, subjectType: input.subjectType,
        subjectId: input.subjectId ?? null, payloadHash, prevHash, eventHash,
        detail: input.detail ?? null,
      };
      events.push(row);
      heads.set(input.workspaceId, eventHash);
      return { ...row };
    },
    async auditList(workspaceId, limit = 200) {
      return events.filter((e) => e.workspaceId === workspaceId).slice(-limit).map((e) => ({ ...e }));
    },
  };
}

// ---------------------------------------------------------------------------
// Prisma-backed implementation
// ---------------------------------------------------------------------------
// Mirrors lib/flywheel/reallocation/store.ts conventions: the generated
// client is cast through `any` so the track doesn't hard-depend on the exact
// client typings. Audit events land in the shared FlywheelAuditEvent table
// (workspace-scoped, hash-chained) using the F4 CTV kinds added to the
// FlywheelAuditKind enum.


type AnyPrisma = any;

const asJson = (v: unknown): Record<string, unknown> | null =>
  v === null || v === undefined ? null : (v as Record<string, unknown>);

const serCampaign = (r: any): CtvCampaignRow => ({
  id: r.id,
  workspaceId: r.workspaceId,
  name: r.name,
  platform: r.platform as CtvPlatform,
  mode: r.mode as CtvMode,
  status: r.status as CtvCampaignStatus,
  approvalObjectId: r.approvalObjectId ?? null,
  budgetCents: r.budgetCents ?? null,
  currency: r.currency,
  flightStart: r.flightStart ?? null,
  flightEnd: r.flightEnd ?? null,
  targetingJson: asJson(r.targetingJson),
  creativeIds: r.creativeIds ?? [],
  creativeHashes: r.creativeHashes ?? [],
  vibeAdvertiserId: r.vibeAdvertiserId ?? null,
  vibeCampaignId: r.vibeCampaignId ?? null,
  vibeTestMode: r.vibeTestMode,
  vibeConfigRef: r.vibeConfigRef ?? null,
  createdBy: r.createdBy ?? null,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

const serValidation = (r: any): CtvCreativeValidationRow => ({
  id: r.id,
  workspaceId: r.workspaceId,
  campaignId: r.campaignId ?? null,
  creativeId: r.creativeId,
  creativeSha256: r.creativeSha256 ?? null,
  ffprobeJson: (r.ffprobeJson ?? {}) as Record<string, unknown>,
  pass: r.pass,
  checks: (r.checks ?? []) as CtvCreativeValidationRow["checks"],
  durationSeconds: r.durationSeconds ?? null,
  publisher: r.publisher ?? null,
  publisherRulesVersion: r.publisherRulesVersion,
  validatedBy: r.validatedBy ?? null,
  createdAt: r.createdAt,
});

const serSpot = (r: any): CtvSpotRow => ({
  id: r.id,
  workspaceId: r.workspaceId,
  campaignId: r.campaignId,
  placementLabel: r.placementLabel,
  showGenre: r.showGenre ?? null,
  daypart: r.daypart ?? null,
  demo: r.demo ?? null,
  creativeId: r.creativeId ?? null,
  qrId: r.qrId ?? null,
  purlId: r.purlId ?? null,
  qrSvg: r.qrSvg ?? null,
  flightFrom: r.flightFrom ?? null,
  flightTo: r.flightTo ?? null,
  status: r.status,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

const serIo = (r: any): CtvIoRow => ({
  id: r.id,
  workspaceId: r.workspaceId,
  campaignId: r.campaignId,
  vendor: r.vendor,
  ioPayload: (r.ioPayload ?? {}) as Record<string, unknown>,
  state: r.state as CtvIoState,
  placedBy: r.placedBy ?? null,
  placedAt: r.placedAt ?? null,
  vendorConfirmation: r.vendorConfirmation ?? null,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

const serPixel = (r: any): CtvPixelRow => ({
  id: r.id,
  workspaceId: r.workspaceId,
  campaignId: r.campaignId,
  pixelUrl: r.pixelUrl,
  pixelToken: r.pixelToken,
  viewThroughWindowDays: r.viewThroughWindowDays,
  impressionsCount: r.impressionsCount,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

/** True when the CTV tables exist and are reachable. */
export async function ctvTablesReady(): Promise<boolean> {
  try {
    await (prisma as AnyPrisma).ctvCampaign.findFirst({ select: { id: true } });
    return true;
  } catch {
    return false;
  }
}

export function createPrismaCtvStore(db: AnyPrisma = prisma): CtvStore {
  const auditEvent = async (input: {
    workspaceId: string; actor: string; action: CtvAuditAction;
    subjectType: CtvAuditEvent["subjectType"]; subjectId?: string | null;
    detail?: Record<string, unknown> | null;
  }): Promise<CtvAuditEvent> => {
    const ts = new Date();
    const detail = input.detail ?? null;
    const payloadHash = sha256Hex(canonicalize(detail ?? {}));
    const last = await db.flywheelAuditEvent.findFirst({
      where: { workspaceId: input.workspaceId },
      orderBy: { ts: "desc" },
      select: { eventHash: true },
    });
    const prevHash = last?.eventHash ?? "GENESIS";
    const eventHash = ctvAuditEventHashFor(prevHash, {
      workspaceId: input.workspaceId, ts: ts.toISOString(), actor: input.actor,
      action: input.action, subjectType: input.subjectType,
      subjectId: input.subjectId ?? null, payloadHash,
    });
    const row = await db.flywheelAuditEvent.create({
      data: {
        workspaceId: input.workspaceId,
        correlationId: `ctv:${input.action}:${input.subjectId ?? input.workspaceId}`,
        kind: input.action,
        actor: input.actor,
        payload: { ...(detail ?? {}), ctvSubjectType: input.subjectType, ctvSubjectId: input.subjectId ?? null },
        payloadHash,
        prevHash,
        eventHash,
        ts,
      },
    });
    const payload = (row.payload ?? {}) as Record<string, unknown>;
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      ts: row.ts,
      actor: row.actor,
      action: input.action,
      subjectType: input.subjectType,
      subjectId: input.subjectId ?? null,
      payloadHash: row.payloadHash,
      prevHash: row.prevHash,
      eventHash: row.eventHash,
      detail: detail,
    };
  };

  const auditList = async (workspaceId: string, limit = 200): Promise<CtvAuditEvent[]> => {
    const rows = await db.flywheelAuditEvent.findMany({
      where: { workspaceId, correlationId: { startsWith: "ctv:" } },
      orderBy: { ts: "asc" },
      take: limit,
    });
    return rows.map((row: any) => {
      const action = row.correlationId.slice(4).split(":")[0] as CtvAuditAction;
      const payload = (row.payload ?? {}) as Record<string, unknown>;
      const subjectType = (payload.ctvSubjectType ?? "workspace") as CtvAuditEvent["subjectType"];
      const subjectId = (payload.ctvSubjectId ?? null) as string | null;
      const { ctvSubjectType, ctvSubjectId, ...detail } = payload;
      return {
        id: row.id,
        workspaceId: row.workspaceId,
        ts: row.ts,
        actor: row.actor,
        action,
        subjectType,
        subjectId,
        payloadHash: row.payloadHash,
        prevHash: row.prevHash,
        eventHash: row.eventHash,
        detail: Object.keys(detail).length > 0 ? detail : null,
      } as CtvAuditEvent;
    });
  };

  return {
    async createCampaign(input) {
      return serCampaign(await db.ctvCampaign.create({ data: { ...input } }));
    },
    async getCampaign(workspaceId, id) {
      const row = await db.ctvCampaign.findFirst({ where: { id, workspaceId } });
      return row ? serCampaign(row) : null;
    },
    async listCampaigns(workspaceId) {
      const rows = await db.ctvCampaign.findMany({ where: { workspaceId }, orderBy: { createdAt: "desc" } });
      return rows.map(serCampaign);
    },
    async updateCampaign(workspaceId, id, patch) {
      const existing = await db.ctvCampaign.findFirst({ where: { id, workspaceId }, select: { id: true } });
      if (!existing) return null;
      const { id: _dropId, workspaceId: _dropWs, createdAt: _dropCa, ...data } = patch as Record<string, unknown>;
      return serCampaign(await db.ctvCampaign.update({ where: { id }, data }));
    },
    async createValidation(input) {
      return serValidation(await db.ctvCreativeValidation.create({ data: { ...input } }));
    },
    async listValidations(workspaceId, creativeId) {
      const rows = await db.ctvCreativeValidation.findMany({
        where: { workspaceId, ...(creativeId ? { creativeId } : {}) },
        orderBy: { createdAt: "desc" },
      });
      return rows.map(serValidation);
    },
    async createSpot(input) {
      return serSpot(await db.ctvSpot.create({ data: { ...input } }));
    },
    async listSpots(workspaceId, campaignId) {
      const rows = await db.ctvSpot.findMany({ where: { workspaceId, campaignId }, orderBy: { createdAt: "asc" } });
      return rows.map(serSpot);
    },
    async createIo(input) {
      return serIo(await db.ctvIo.create({ data: { ...input } }));
    },
    async getIo(workspaceId, id) {
      const row = await db.ctvIo.findFirst({ where: { id, workspaceId } });
      return row ? serIo(row) : null;
    },
    async updateIo(workspaceId, id, patch) {
      const existing = await db.ctvIo.findFirst({ where: { id, workspaceId }, select: { id: true } });
      if (!existing) return null;
      const { id: _dropId, workspaceId: _dropWs, createdAt: _dropCa, ...data } = patch as Record<string, unknown>;
      return serIo(await db.ctvIo.update({ where: { id }, data }));
    },
    async createPixel(input) {
      return serPixel(await db.ctvPixel.create({ data: { ...input } }));
    },
    async getPixel(workspaceId, id) {
      const row = await db.ctvPixel.findFirst({ where: { id, workspaceId } });
      return row ? serPixel(row) : null;
    },
    async getPixelByToken(token) {
      const row = await db.ctvPixel.findFirst({ where: { pixelToken: token } });
      return row ? serPixel(row) : null;
    },
    async getPixelAny(id) {
      const row = await db.ctvPixel.findUnique({ where: { id } });
      return row ? serPixel(row) : null;
    },
    async listPixels(workspaceId, campaignId) {
      const rows = await db.ctvPixel.findMany({ where: { workspaceId, campaignId }, orderBy: { createdAt: "asc" } });
      return rows.map(serPixel);
    },
    async incrementImpressions(pixelId) {
      await db.ctvPixel.update({ where: { id: pixelId }, data: { impressionsCount: { increment: 1 } } }).catch(() => null);
    },
    audit: auditEvent,
    auditList,
  };
}

// Singleton accessor (memory fallback). Test hook: swap the singleton
// (verify battery uses createMemoryCtvStore() directly on fresh stores).
let singleton: CtvStore | null = null;
export function getCtvStore(): CtvStore {
  if (!singleton) singleton = createMemoryCtvStore();
  return singleton;
}
/** Test hook: swap the singleton. */
export function setCtvStore(store: CtvStore | null): void {
  singleton = store;
}

// ---------------------------------------------------------------------------
// Route accessor
// ---------------------------------------------------------------------------
// Prisma-backed when the CTV tables are provisioned; memory fallback otherwise
// (mirrors the Test Lab resolveExperimentStore pattern). The verify battery
// uses createMemoryCtvStore() directly, so this resolution never touches it.

export async function resolveCtvStore(): Promise<CtvStore> {
  if (await ctvTablesReady()) return createPrismaCtvStore(prisma);
  return getCtvStore();
}
