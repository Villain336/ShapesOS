// Marketr — Phase 5 BUYING PATHS: SQL stores for the buying fragment.
//
// prisma/fragments/phase5-buying.prisma is not yet merged into
// prisma/schema.prisma, so the generated Prisma client does not expose
// these models. These stores use parameterized raw SQL
// ($queryRawUnsafe/$executeRawUnsafe with bound params — no string
// interpolation of values) against the snake_case columns, so the code
// runs identically before AND after the schema merge (post-merge the
// stores can be swapped for Prisma delegates without changing callers).
//
// All queries are workspace-scoped (cross-workspace access is rejected by
// the WHERE clause, not by convention). No secrets, no PANs, no key
// material — only refs.

import { prisma } from "@/lib/prisma";
import { createId } from "./ids";

function toDate(v: unknown): Date {
  return v instanceof Date ? v : new Date(v as string);
}
function num(v: unknown): number {
  return Number(v);
}
function strArr(v: unknown): string[] {
  return Array.isArray(v) ? (v as string[]) : [];
}

/** True when the buying fragment tables exist (merged + migrated). */
export async function buyingTablesReady(): Promise<boolean> {
  try {
    await prisma.$queryRawUnsafe(`SELECT 1 FROM dooh_plans LIMIT 1`);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Buying-lifecycle audit trail (append-only)
//
// The safety track owns the hash-chained media_approval_events for the
// proposed → approved → executed transition. This table audits the buying
// track's own lifecycle: plan created, launch packet compiled, audio brief
// generated, IO brief generated, signature moved, receipt recorded.
// Append-only by convention and API surface (no UPDATE/DELETE exposure);
// defense-in-depth only — the approval events are the legal record.
// ---------------------------------------------------------------------------

export interface BuyingEvent {
  id: string;
  workspaceId: string;
  actor: string;
  action: string;
  entityType: string;
  entityId: string;
  payloadHash: string | null;
  detail: Record<string, unknown>;
  ts: Date;
}

/**
 * Append a buying-lifecycle audit event. Never throws — a failed audit
 * write must not block the business operation it describes.
 */
export async function appendBuyingEvent(
  e: Omit<BuyingEvent, "id" | "ts"> & { ts?: Date },
): Promise<void> {
  try {
    await prisma.$executeRawUnsafe(
      `INSERT INTO media_buying_events (id, workspace_id, actor, action, entity_type, entity_id, payload_hash, detail, ts)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
      createId(), e.workspaceId, e.actor, e.action, e.entityType, e.entityId,
      e.payloadHash ?? null, JSON.stringify(e.detail ?? {}), e.ts ?? new Date(),
    );
  } catch (err) {
    // Append-only audit is best-effort here (the fragment tables aren't
    // migrated yet in dev); the approval-event chain is the legal record.
    console.warn("[buying-audit] append failed (non-fatal):", err instanceof Error ? err.message : err);
  }
}

export async function listBuyingEvents(
  workspaceId: string,
  entityId?: string,
  limit = 100,
): Promise<BuyingEvent[]> {
  const where = entityId
    ? `WHERE workspace_id = $1 AND entity_id = $2`
    : `WHERE workspace_id = $1`;
  const args = entityId ? [workspaceId, entityId] : [workspaceId];
  const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
    `SELECT id, workspace_id, actor, action, entity_type, entity_id, payload_hash, detail, ts
     FROM media_buying_events ${where} ORDER BY ts ASC LIMIT ${Math.min(limit, 500)}`,
    ...args,
  );
  return rows.map((r) => ({
    id: String(r.id),
    workspaceId: String(r.workspace_id),
    actor: String(r.actor),
    action: String(r.action),
    entityType: String(r.entity_type),
    entityId: String(r.entity_id),
    payloadHash: r.payload_hash == null ? null : String(r.payload_hash),
    detail: (r.detail ?? {}) as Record<string, unknown>,
    ts: toDate(r.ts),
  }));
}

// ---------------------------------------------------------------------------
// dooh_plans
// ---------------------------------------------------------------------------

export interface DoohPlanRow {
  id: string;
  workspaceId: string;
  buyId: string | null;
  name: string;
  vendor: string;
  placementsJson: Record<string, unknown>;
  estimateJson: Record<string, unknown>;
  estimateCents: number;
  currency: string;
  creativeIds: string[];
  creativeHashes: string[];
  trackingAssignments: Record<string, unknown> | null;
  launchPacketUrl: string | null;
  status: string;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const DOOH_COLS = `id, workspace_id, buy_id, name, vendor, placements_json, estimate_json, estimate_cents, currency, creative_ids, creative_hashes, tracking_assignments, launch_packet_url, status, created_by, created_at, updated_at`;

interface DoohPlanDbRow {
  id: string; workspace_id: string; buy_id: string | null; name: string; vendor: string;
  placements_json: unknown; estimate_json: unknown; estimate_cents: unknown; currency: string;
  creative_ids: unknown; creative_hashes: unknown; tracking_assignments: unknown;
  launch_packet_url: string | null; status: string; created_by: string | null;
  created_at: unknown; updated_at: unknown;
}

function toDoohPlan(r: DoohPlanDbRow): DoohPlanRow {
  return {
    id: r.id, workspaceId: r.workspace_id, buyId: r.buy_id, name: r.name, vendor: r.vendor,
    placementsJson: (r.placements_json as Record<string, unknown>) ?? {},
    estimateJson: (r.estimate_json as Record<string, unknown>) ?? {},
    estimateCents: num(r.estimate_cents), currency: r.currency,
    creativeIds: strArr(r.creative_ids), creativeHashes: strArr(r.creative_hashes),
    trackingAssignments: (r.tracking_assignments as Record<string, unknown>) ?? null,
    launchPacketUrl: r.launch_packet_url, status: r.status, createdBy: r.created_by,
    createdAt: toDate(r.created_at), updatedAt: toDate(r.updated_at),
  };
}

export interface CreateDoohPlanInput {
  workspaceId: string;
  buyId?: string | null;
  name: string;
  vendor: string;
  placementsJson: Record<string, unknown>;
  estimateJson: Record<string, unknown>;
  estimateCents: number;
  currency?: string;
  creativeIds?: string[];
  creativeHashes?: string[];
  createdBy?: string | null;
}

export class SqlDoohPlanStore {
  async create(input: CreateDoohPlanInput): Promise<DoohPlanRow> {
    const id = createId();
    const rows = await prisma.$queryRawUnsafe<DoohPlanDbRow[]>(
      `INSERT INTO dooh_plans (${DOOH_COLS})
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11,NULL,'draft',$12,NOW(),NOW())
       RETURNING ${DOOH_COLS}`,
      id, input.workspaceId, input.buyId ?? null, input.name, input.vendor,
      JSON.stringify(input.placementsJson), JSON.stringify(input.estimateJson),
      input.estimateCents, input.currency ?? "USD",
      input.creativeIds ?? [], input.creativeHashes ?? [],
      input.createdBy ?? null,
    );
    return toDoohPlan(rows[0]);
  }

  async get(id: string, workspaceId: string): Promise<DoohPlanRow | null> {
    const rows = await prisma.$queryRawUnsafe<DoohPlanDbRow[]>(
      `SELECT ${DOOH_COLS} FROM dooh_plans WHERE id = $1 AND workspace_id = $2 LIMIT 1`,
      id, workspaceId,
    );
    return rows[0] ? toDoohPlan(rows[0]) : null;
  }

  async list(workspaceId: string, limit = 50): Promise<DoohPlanRow[]> {
    const rows = await prisma.$queryRawUnsafe<DoohPlanDbRow[]>(
      `SELECT ${DOOH_COLS} FROM dooh_plans WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT $2`,
      workspaceId, limit,
    );
    return rows.map(toDoohPlan);
  }

  async update(
    id: string, workspaceId: string,
    patch: Partial<Pick<DoohPlanRow, "status" | "launchPacketUrl" | "trackingAssignments" | "buyId">>,
  ): Promise<DoohPlanRow | null> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    let i = 1;
    if (patch.status !== undefined) { sets.push(`status = $${i++}`); vals.push(patch.status); }
    if (patch.launchPacketUrl !== undefined) { sets.push(`launch_packet_url = $${i++}`); vals.push(patch.launchPacketUrl); }
    if (patch.trackingAssignments !== undefined) { sets.push(`tracking_assignments = $${i++}::jsonb`); vals.push(patch.trackingAssignments ? JSON.stringify(patch.trackingAssignments) : null); }
    if (patch.buyId !== undefined) { sets.push(`buy_id = $${i++}`); vals.push(patch.buyId); }
    if (sets.length === 0) return this.get(id, workspaceId);
    sets.push(`updated_at = NOW()`);
    const rows = await prisma.$queryRawUnsafe<DoohPlanDbRow[]>(
      `UPDATE dooh_plans SET ${sets.join(", ")} WHERE id = $${i} AND workspace_id = $${i + 1} RETURNING ${DOOH_COLS}`,
      ...vals, id, workspaceId,
    );
    return rows[0] ? toDoohPlan(rows[0]) : null;
  }
}

// ---------------------------------------------------------------------------
// launch_packets
// ---------------------------------------------------------------------------

export interface LaunchPacketRow {
  id: string;
  workspaceId: string;
  planId: string;
  approvalId: string;
  bindingHash: string;
  packetSha256: string;
  pdfUrl: string;
  version: number;
  generatedBy: string | null;
  generatedAt: Date;
}

const PACKET_COLS = `id, workspace_id, plan_id, approval_id, binding_hash, packet_sha256, pdf_url, version, generated_by, generated_at`;

export class SqlLaunchPacketStore {
  async create(input: {
    workspaceId: string; planId: string; approvalId: string; bindingHash: string;
    packetSha256: string; pdfUrl: string; version: number; generatedBy?: string | null;
  }): Promise<LaunchPacketRow> {
    const id = createId();
    const rows = await prisma.$queryRawUnsafe<(LaunchPacketRow & Record<string, unknown>)[]>(
      `INSERT INTO launch_packets (${PACKET_COLS})
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW()) RETURNING ${PACKET_COLS}`,
      id, input.workspaceId, input.planId, input.approvalId, input.bindingHash,
      input.packetSha256, input.pdfUrl, input.version, input.generatedBy ?? null,
    );
    const r = rows[0] as unknown as Record<string, unknown>;
    return {
      id: r.id as string, workspaceId: r.workspace_id as string, planId: r.plan_id as string,
      approvalId: r.approval_id as string, bindingHash: r.binding_hash as string,
      packetSha256: r.packet_sha256 as string, pdfUrl: r.pdf_url as string,
      version: num(r.version), generatedBy: (r.generated_by as string) ?? null,
      generatedAt: toDate(r.generated_at),
    };
  }

  async listForPlan(planId: string, workspaceId: string): Promise<LaunchPacketRow[]> {
    const rows = await prisma.$queryRawUnsafe<(LaunchPacketRow & Record<string, unknown>)[]>(
      `SELECT ${PACKET_COLS} FROM launch_packets WHERE plan_id = $1 AND workspace_id = $2 ORDER BY version DESC`,
      planId, workspaceId,
    );
    return rows.map((r) => {
      const x = r as unknown as Record<string, unknown>;
      return {
        id: x.id as string, workspaceId: x.workspace_id as string, planId: x.plan_id as string,
        approvalId: x.approval_id as string, bindingHash: x.binding_hash as string,
        packetSha256: x.packet_sha256 as string, pdfUrl: x.pdf_url as string,
        version: num(x.version), generatedBy: (x.generated_by as string) ?? null,
        generatedAt: toDate(x.generated_at),
      };
    });
  }

  async nextVersion(planId: string, workspaceId: string): Promise<number> {
    const rows = await prisma.$queryRawUnsafe<{ m: unknown }[]>(
      `SELECT MAX(version) AS m FROM launch_packets WHERE plan_id = $1 AND workspace_id = $2`,
      planId, workspaceId,
    );
    return num(rows[0]?.m ?? 0) + 1;
  }

  async setPdfUrl(id: string, workspaceId: string, pdfUrl: string): Promise<void> {
    await prisma.$executeRawUnsafe(
      `UPDATE launch_packets SET pdf_url = $3 WHERE id = $1 AND workspace_id = $2`,
      id, workspaceId, pdfUrl,
    );
  }
}

// ---------------------------------------------------------------------------
// audio_buys
// ---------------------------------------------------------------------------

export interface AudioBuyRow {
  id: string;
  workspaceId: string;
  buyId: string | null;
  name: string;
  vendor: string;
  stationsJson: Record<string, unknown>;
  budgetJson: Record<string, unknown>;
  budgetCents: number;
  currency: string;
  creativeIds: string[];
  creativeHashes: string[];
  trackingAssignments: Record<string, unknown> | null;
  briefUrl: string | null;
  status: string;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const AUDIO_COLS = `id, workspace_id, buy_id, name, vendor, stations_json, budget_json, budget_cents, currency, creative_ids, creative_hashes, tracking_assignments, brief_url, status, created_by, created_at, updated_at`;

export class SqlAudioBuyStore {
  async create(input: {
    workspaceId: string; buyId?: string | null; name: string; vendor: string;
    stationsJson: Record<string, unknown>; budgetJson: Record<string, unknown>;
    budgetCents: number; currency?: string; creativeIds?: string[]; creativeHashes?: string[];
    createdBy?: string | null;
  }): Promise<AudioBuyRow> {
    const id = createId();
    const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
      `INSERT INTO audio_buys (${AUDIO_COLS})
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11,NULL,NULL,'draft',$12,NOW(),NOW())
       RETURNING ${AUDIO_COLS}`,
      id, input.workspaceId, input.buyId ?? null, input.name, input.vendor,
      JSON.stringify(input.stationsJson), JSON.stringify(input.budgetJson),
      input.budgetCents, input.currency ?? "USD",
      input.creativeIds ?? [], input.creativeHashes ?? [], input.createdBy ?? null,
    );
    return toAudioBuy(rows[0]);
  }

  async get(id: string, workspaceId: string): Promise<AudioBuyRow | null> {
    const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT ${AUDIO_COLS} FROM audio_buys WHERE id = $1 AND workspace_id = $2 LIMIT 1`,
      id, workspaceId,
    );
    return rows[0] ? toAudioBuy(rows[0]) : null;
  }

  async list(workspaceId: string, limit = 50): Promise<AudioBuyRow[]> {
    const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT ${AUDIO_COLS} FROM audio_buys WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT $2`,
      workspaceId, limit,
    );
    return rows.map(toAudioBuy);
  }

  async setBrief(id: string, workspaceId: string, briefUrl: string): Promise<void> {
    await prisma.$executeRawUnsafe(
      `UPDATE audio_buys SET brief_url = $3, status = 'briefed', updated_at = NOW() WHERE id = $1 AND workspace_id = $2`,
      id, workspaceId, briefUrl,
    );
  }
}

function toAudioBuy(r: Record<string, unknown>): AudioBuyRow {
  return {
    id: r.id as string, workspaceId: r.workspace_id as string, buyId: (r.buy_id as string) ?? null,
    name: r.name as string, vendor: r.vendor as string,
    stationsJson: (r.stations_json as Record<string, unknown>) ?? {},
    budgetJson: (r.budget_json as Record<string, unknown>) ?? {},
    budgetCents: num(r.budget_cents), currency: r.currency as string,
    creativeIds: strArr(r.creative_ids), creativeHashes: strArr(r.creative_hashes),
    trackingAssignments: (r.tracking_assignments as Record<string, unknown>) ?? null,
    briefUrl: (r.brief_url as string) ?? null, status: r.status as string,
    createdBy: (r.created_by as string) ?? null,
    createdAt: toDate(r.created_at), updatedAt: toDate(r.updated_at),
  };
}

// ---------------------------------------------------------------------------
// io_briefs
// ---------------------------------------------------------------------------

export interface IoBriefRow {
  id: string;
  workspaceId: string;
  buyId: string | null;
  name: string;
  channel: string;
  inventoryJson: Record<string, unknown>;
  ioTermsJson: Record<string, unknown>;
  maxSpendCents: number;
  currency: string;
  creativeIds: string[];
  creativeHashes: string[];
  repContact: Record<string, unknown> | null;
  signatureStatus: string;
  signedAt: Date | null;
  proofOfRunUrl: string | null;
  briefPdfUrl: string | null;
  status: string;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const IO_COLS = `id, workspace_id, buy_id, name, channel, inventory_json, io_terms_json, max_spend_cents, currency, creative_ids, creative_hashes, rep_contact, signature_status, signed_at, proof_of_run_url, brief_pdf_url, status, created_by, created_at, updated_at`;

export class SqlIoBriefStore {
  async create(input: {
    workspaceId: string; buyId?: string | null; name: string; channel: string;
    inventoryJson: Record<string, unknown>; ioTermsJson: Record<string, unknown>;
    maxSpendCents: number; currency?: string; creativeIds?: string[]; creativeHashes?: string[];
    repContact?: Record<string, unknown> | null; createdBy?: string | null;
  }): Promise<IoBriefRow> {
    const id = createId();
    const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
      `INSERT INTO io_briefs (${IO_COLS})
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11,$12::jsonb,'draft',NULL,NULL,NULL,'draft',$13,NOW(),NOW())
       RETURNING ${IO_COLS}`,
      id, input.workspaceId, input.buyId ?? null, input.name, input.channel,
      JSON.stringify(input.inventoryJson), JSON.stringify(input.ioTermsJson),
      input.maxSpendCents, input.currency ?? "USD",
      input.creativeIds ?? [], input.creativeHashes ?? [],
      input.repContact ? JSON.stringify(input.repContact) : null,
      input.createdBy ?? null,
    );
    return toIoBrief(rows[0]);
  }

  async get(id: string, workspaceId: string): Promise<IoBriefRow | null> {
    const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT ${IO_COLS} FROM io_briefs WHERE id = $1 AND workspace_id = $2 LIMIT 1`,
      id, workspaceId,
    );
    return rows[0] ? toIoBrief(rows[0]) : null;
  }

  async list(workspaceId: string, limit = 50): Promise<IoBriefRow[]> {
    const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT ${IO_COLS} FROM io_briefs WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT $2`,
      workspaceId, limit,
    );
    return rows.map(toIoBrief);
  }

  async updateSignature(
    id: string, workspaceId: string,
    patch: { signatureStatus?: string; repContact?: Record<string, unknown> | null; proofOfRunUrl?: string | null },
  ): Promise<IoBriefRow | null> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    let i = 1;
    if (patch.signatureStatus !== undefined) {
      sets.push(`signature_status = $${i++}`);
      vals.push(patch.signatureStatus);
      if (patch.signatureStatus === "signed") sets.push(`signed_at = NOW()`);
    }
    if (patch.repContact !== undefined) {
      sets.push(`rep_contact = $${i++}::jsonb`);
      vals.push(patch.repContact ? JSON.stringify(patch.repContact) : null);
    }
    if (patch.proofOfRunUrl !== undefined) {
      sets.push(`proof_of_run_url = $${i++}`);
      vals.push(patch.proofOfRunUrl);
    }
    if (sets.length === 0) return this.get(id, workspaceId);
    sets.push(`updated_at = NOW()`);
    const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
      `UPDATE io_briefs SET ${sets.join(", ")} WHERE id = $${i} AND workspace_id = $${i + 1} RETURNING ${IO_COLS}`,
      ...vals, id, workspaceId,
    );
    return rows[0] ? toIoBrief(rows[0]) : null;
  }

  async setBriefPdf(id: string, workspaceId: string, briefPdfUrl: string): Promise<void> {
    await prisma.$executeRawUnsafe(
      `UPDATE io_briefs SET brief_pdf_url = $3, updated_at = NOW() WHERE id = $1 AND workspace_id = $2`,
      id, workspaceId, briefPdfUrl,
    );
  }
}

function toIoBrief(r: Record<string, unknown>): IoBriefRow {
  return {
    id: r.id as string, workspaceId: r.workspace_id as string, buyId: (r.buy_id as string) ?? null,
    name: r.name as string, channel: r.channel as string,
    inventoryJson: (r.inventory_json as Record<string, unknown>) ?? {},
    ioTermsJson: (r.io_terms_json as Record<string, unknown>) ?? {},
    maxSpendCents: num(r.max_spend_cents), currency: r.currency as string,
    creativeIds: strArr(r.creative_ids), creativeHashes: strArr(r.creative_hashes),
    repContact: (r.rep_contact as Record<string, unknown>) ?? null,
    signatureStatus: r.signature_status as string,
    signedAt: r.signed_at ? toDate(r.signed_at) : null,
    proofOfRunUrl: (r.proof_of_run_url as string) ?? null,
    briefPdfUrl: (r.brief_pdf_url as string) ?? null,
    status: r.status as string, createdBy: (r.created_by as string) ?? null,
    createdAt: toDate(r.created_at), updatedAt: toDate(r.updated_at),
  };
}

// ---------------------------------------------------------------------------
// media_receipts
// ---------------------------------------------------------------------------

export interface MediaReceiptDbRow {
  id: string;
  workspaceId: string;
  buyId: string;
  capturedBy: string;
  platformInvoiceRef: string | null;
  amountCents: number | null;
  currency: string;
  receiptUrl: string | null;
  parsedTermsJson: Record<string, unknown> | null;
  verified: boolean;
  reconciled: boolean;
  varianceCents: number | null;
  approvalRef: string;
  capturedAt: Date;
}

const RECEIPT_COLS = `id, workspace_id, buy_id, captured_by, platform_invoice_ref, amount_cents, currency, receipt_url, parsed_terms_json, verified, reconciled, variance_cents, approval_ref, captured_at`;

function toMediaReceiptDbRow(r: Record<string, unknown>): MediaReceiptDbRow {
  return {
    id: r.id as string, workspaceId: r.workspace_id as string, buyId: r.buy_id as string,
    capturedBy: r.captured_by as string, platformInvoiceRef: (r.platform_invoice_ref as string) ?? null,
    amountCents: r.amount_cents != null ? num(r.amount_cents) : null,
    currency: r.currency as string, receiptUrl: (r.receipt_url as string) ?? null,
    parsedTermsJson: (r.parsed_terms_json as Record<string, unknown>) ?? null,
    verified: Boolean(r.verified), reconciled: Boolean(r.reconciled),
    varianceCents: r.variance_cents != null ? num(r.variance_cents) : null,
    approvalRef: r.approval_ref as string, capturedAt: toDate(r.captured_at),
  };
}

export class SqlMediaReceiptStore {
  async create(input: {
    workspaceId: string; buyId: string; capturedBy: "browser_executor" | "human_upload";
    platformInvoiceRef?: string | null; amountCents?: number | null; currency?: string;
    receiptUrl?: string | null; parsedTermsJson?: Record<string, unknown> | null; verified?: boolean;
    // REQUIRED: merged media_receipts.approval_ref is NOT NULL (zero-custody
    // invariant — every receipt traces to a safety-track approval).
    approvalRef: string;
  }): Promise<MediaReceiptDbRow> {
    const id = createId();
    const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
      `INSERT INTO media_receipts (${RECEIPT_COLS})
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,FALSE,NULL,$11,NOW()) RETURNING ${RECEIPT_COLS}`,
      id, input.workspaceId, input.buyId, input.capturedBy,
      input.platformInvoiceRef ?? null, input.amountCents ?? null, input.currency ?? "USD",
      input.receiptUrl ?? null,
      input.parsedTermsJson ? JSON.stringify(input.parsedTermsJson) : null,
      input.verified ?? false, input.approvalRef,
    );
    return toMediaReceiptDbRow(rows[0]);
  }

  async listForBuy(buyId: string, workspaceId: string): Promise<MediaReceiptDbRow[]> {
    const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT ${RECEIPT_COLS} FROM media_receipts WHERE buy_id = $1 AND workspace_id = $2 ORDER BY captured_at DESC`,
      buyId, workspaceId,
    );
    return rows.map(toMediaReceiptDbRow);
  }
}
