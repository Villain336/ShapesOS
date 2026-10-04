// Marketr — Phase 17 slice 1: the DocType auto-REST service layer.
//
// THE convention: every entity in lib/ops/entities.ts gets GET/POST/PATCH
// with workspace scoping + audit entries BY CONSTRUCTION — the entity
// definition is the only thing a new entity adds.
//
//   opsList(tx, def, actor, query)
//     → { entity, rows } — reads run freely; one audit row per request.
//   opsCreate(tx, def, actor, body, opts)
//     → { outcome: "done", row } | { outcome: "approval_required", approval, classification }
//   opsPatch(tx, def, actor, body /* { id, ...patch, approvalId? } */, opts)
//     → same result shape.
//
// Gated writes (classifyOpsWrite): without an approvalId the service
// PROPOSES a Phase 14 approval and returns 202-style approval_required
// (audit: gate_proposed); with an approvalId it VERIFIES (fail-closed) and
// executes (audit: gate_executed). Nothing gated executes without an
// approved, unexpired, binding-matching approval.
//
// All writes carry workspaceId explicitly AND run inside withWorkspaceScope
// (RLS fail-closed). Reads filter by workspaceId; cross-workspace ids 404.

import type { Prisma } from "@prisma/client";
import {
  OPS_ENTITY_MAP,
  OPS_MAX_CENTS,
  type OpsEntityDef,
} from "./entities";
import {
  OpsGateError,
  classifyOpsWrite,
  opsBindingFor,
  phase14GatePort,
  requestOpsApproval,
  verifyAndConsumeOpsApproval,
  type OpsGatePort,
  type OpsGateProposal,
  type OpsWriteClassification,
} from "./gate";

/** HTTP-mappable service error. */
export class OpsError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "OpsError";
    this.status = status;
  }
}

export class OpsNotFoundError extends OpsError {
  constructor(entity: string, id: string) {
    super(404, `${entity} "${id}" not found in workspace`);
  }
}

export interface OpsActor {
  workspaceId: string;
  userId: string;
}

export interface OpsListQuery {
  limit?: number;
  filters?: Record<string, string>;
}

export type OpsWriteResult =
  | { outcome: "done"; row: Record<string, unknown>; action: string }
  | {
      outcome: "approval_required";
      approval: OpsGateProposal;
      classification: OpsWriteClassification;
    };

export interface OpsServiceOpts {
  gatePort?: OpsGatePort;
}

// The tx is a Prisma transaction client (withWorkspaceScope). Tests pass a
// stub cast to Prisma.TransactionClient; delegates are resolved dynamically
// from the entity def.
type Tx = Prisma.TransactionClient;

interface Delegate {
  findMany(args: unknown): Promise<Array<Record<string, unknown>>>;
  findFirst(args: unknown): Promise<Record<string, unknown> | null>;
  create(args: unknown): Promise<Record<string, unknown>>;
  update(args: unknown): Promise<Record<string, unknown>>;
  updateMany(args: unknown): Promise<{ count: number }>;
  upsert(args: unknown): Promise<Record<string, unknown>>;
}

function delegateFor(tx: Tx, def: OpsEntityDef): Delegate {
  const d = (tx as unknown as Record<string, Delegate>)[def.delegate];
  if (!d || typeof d.findMany !== "function") {
    throw new OpsError(500, `Ops entity "${def.slug}" is not wired to a data delegate`);
  }
  return d;
}

function toJson(v: unknown): Record<string, unknown> {
  return v as unknown as Record<string, unknown>;
}

/** Audit by construction: one row per request, in the same transaction. Exported for the workflow runner (slice 6), which writes step/compensation audit rows. */
export async function auditOpsEvent(
  tx: Tx,
  def: OpsEntityDef,
  actor: OpsActor,
  action: string,
  entityId: string | null,
  summary: string,
): Promise<void> {
  await (tx as unknown as { opsAuditEvent: { create(a: unknown): Promise<unknown> } }).opsAuditEvent.create({
    data: {
      workspaceId: actor.workspaceId,
      entity: def.slug,
      entityId,
      action,
      actor: actor.userId,
      summary: summary.slice(0, 2000),
    },
  });
}

interface LineItem {
  qty: number;
  priceCents: number;
}

/**
 * Totals are server-computed from line items — never trusted from the
 * client. The money columns are int4: a total past OPS_MAX_CENTS is a 400
 * here, never a raw Prisma range error.
 */
function totalsFor(lineItems: LineItem[], taxCents: number) {
  const subtotalCents = lineItems.reduce((s, li) => s + li.qty * li.priceCents, 0);
  const totalCents = subtotalCents + taxCents;
  if (totalCents > OPS_MAX_CENTS) {
    throw new OpsError(400, `Total exceeds the maximum of ${OPS_MAX_CENTS} cents`);
  }
  return { subtotalCents, taxCents, totalCents };
}

/** Max rows per list page. */
export const OPS_LIST_MAX = 200;

// Phase 10 (finance): per-entity server hooks (lib/ops/finance/hooks.ts),
// loaded lazily — the finance modules import this file.
type EntityHooks = import("./finance/hooks").OpsEntityHooks;
async function entityHooks(slug: string): Promise<EntityHooks | undefined> {
  const { FINANCE_ENTITY_HOOKS } = await import("./finance/hooks");
  return FINANCE_ENTITY_HOOKS[slug];
}

/** createRows, with the entity's prepare/create hooks when it has them. */
async function materialize(
  tx: Tx,
  def: OpsEntityDef,
  actor: OpsActor,
  body: Record<string, unknown>,
): Promise<Array<Record<string, unknown>>> {
  const hooks = await entityHooks(def.slug);
  const prepared = hooks?.prepare ? await hooks.prepare(tx, actor, body, null) : body;
  // A create hook may decline (null) and leave the generic insert to run.
  const rows = hooks?.create ? await hooks.create(tx, actor, prepared) : null;
  return rows ?? createRows(tx, def, actor, prepared);
}

// ---------------------------------------------------------------------------
// GET — list. Reads run freely (logged): one audit row per request.
// ---------------------------------------------------------------------------

export async function opsList(
  tx: Tx,
  def: OpsEntityDef,
  actor: OpsActor,
  query: OpsListQuery = {},
): Promise<{ entity: string; rows: Array<Record<string, unknown>> }> {
  // Paging is validated, never passed through: ?limit=1.5 / NaN would reach
  // Prisma's `take` and 500.
  const rawLimit = query.limit ?? 50;
  if (!Number.isInteger(rawLimit) || rawLimit < 1) {
    throw new OpsError(400, `Invalid limit: must be an integer between 1 and ${OPS_LIST_MAX}`);
  }
  const limit = Math.min(rawLimit, OPS_LIST_MAX);
  const where: Record<string, unknown> = { workspaceId: actor.workspaceId };
  for (const f of def.filterable) {
    const v = query.filters?.[f];
    if (typeof v === "string" && v) where[f] = v;
  }
  const rows = await delegateFor(tx, def).findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  await auditOpsEvent(tx, def, actor, "list", null, `listed ${def.slug} (${rows.length} rows)`);
  return { entity: def.slug, rows };
}

// ---------------------------------------------------------------------------
// POST — create. Draft-creators run freely (logged); payments are money
// records, so every payment write is gated.
// ---------------------------------------------------------------------------

export async function opsCreate(
  tx: Tx,
  def: OpsEntityDef,
  actor: OpsActor,
  rawBody: unknown,
  opts: OpsServiceOpts = {},
): Promise<OpsWriteResult> {
  const parsed = def.createSchema.safeParse(rawBody);
  if (!parsed.success) {
    throw new OpsError(400, `Invalid ${def.label}: ${parsed.error.issues[0]?.message ?? "validation failed"}`);
  }
  const body = parsed.data as Record<string, unknown>;
  // approvalId travels OUTSIDE the zod contract (it's gate metadata, not
  // entity data) — read it from the raw body; safeParse strips it.
  const rawApprovalId = (rawBody as Record<string, unknown> | null)?.approvalId;
  const classification = classifyOpsWrite({ entity: def.slug, op: "create", body });
  const port = opts.gatePort ?? phase14GatePort;

  if (classification.mode === "gated") {
    // Fail-closed: no approvalId → propose and ask the human (202-style).
    const approvalId = typeof rawApprovalId === "string" ? rawApprovalId : undefined;
    const mutation = { ...body };
    delete mutation.approvalId;
    if (!approvalId) {
      const items = body.items as Array<{ amountCents: number }> | undefined;
      const summaryRow =
        def.slug === "payments" && Array.isArray(items)
          ? {
              kind: "refund",
              amountCents: items.reduce((s, i) => s + (i.amountCents || 0), 0),
              status: "pending",
              id: `(new batch of ${items.length})`,
            }
          : { ...mutation, id: "(new)" };
      const approval = await requestOpsApproval(port, {
        workspaceId: actor.workspaceId,
        slug: classification.slug!,
        entity: def.slug,
        mutation,
        actor: actor.userId,
        summary: `${classification.label}: ${def.summarize(summaryRow)}`,
      });
      await auditOpsEvent(tx, def, actor, "gate_proposed", null, `${classification.label} proposed (approval ${approval.id})`);
      return { outcome: "approval_required", approval, classification };
    }
    // Verify, then claim approved → executed in THIS transaction before
    // writing: one approval = one execution (replays fail closed).
    await verifyAndConsumeOpsApproval(port, tx, {
      workspaceId: actor.workspaceId,
      slug: classification.slug!,
      entity: def.slug,
      mutation,
      approvalId,
      actor: actor.userId,
    });
    const rows = await materialize(tx, def, actor, body);
    for (const row of rows) {
      await auditOpsEvent(tx, def, actor, "gate_executed", String(row.id), `${classification.label} (approval ${approvalId}): ${def.summarize(row)}`);
    }
    return { outcome: "done", row: rows.length === 1 ? rows[0]! : toJson({ rows }), action: "gate_executed" };
  }

  // Invoice idempotency key: a retry returns the ORIGINAL invoice (200),
  // never a unique-violation error. (createRows upserts on the key too, so
  // a concurrent duplicate also resolves to the one row.)
  if (def.slug === "invoices" && typeof body.idempotencyKey === "string") {
    const prior = await delegateFor(tx, def).findFirst({
      where: { workspaceId: actor.workspaceId, idempotencyKey: body.idempotencyKey },
    });
    if (prior) {
      await auditOpsEvent(tx, def, actor, "idempotent_replay", String(prior.id), `idempotency key reused: ${def.summarize(prior)}`);
      return { outcome: "done", row: prior, action: "idempotent_replay" };
    }
  }

  const rows = await materialize(tx, def, actor, body);
  for (const row of rows) {
    await auditOpsEvent(tx, def, actor, "create", String(row.id), `created ${def.summarize(row)}`);
  }
  return { outcome: "done", row: rows.length === 1 ? rows[0]! : toJson({ rows }), action: "create" };
}

/**
 * Record one stock move: txn row + materialized stock balance in ONE
 * transaction — inventory decrements exactly once per sale, never drifts.
 * Shared by the inventory-txns create path and PO receiving (slice 3).
 */
export async function recordInventoryTxn(
  tx: Tx,
  actor: OpsActor,
  args: {
    productId: string;
    delta: number;
    reason: "sale" | "restock" | "adjustment";
    note?: string | null;
    /** Defaults to the acting user — callers may pass "agent:<surface>". */
    actorName?: string | null;
  },
): Promise<Record<string, unknown>> {
  if (!Number.isInteger(args.delta) || args.delta === 0) {
    throw new OpsError(400, "Inventory delta must be a non-zero integer");
  }
  const products = (tx as unknown as Record<string, Delegate>)["opsProduct"];
  const txns = (tx as unknown as Record<string, Delegate>)["opsInventoryTxn"];
  const product = (await products.findFirst({
    where: { id: args.productId },
  })) as unknown as { id: string; trackInventory: boolean } | null;
  if (!product) throw new OpsNotFoundError("products", args.productId);
  if (!product.trackInventory) {
    throw new OpsError(422, `Product "${args.productId}" does not track inventory`);
  }
  const txn = await txns.create({
    data: {
      workspaceId: actor.workspaceId,
      productId: args.productId,
      delta: args.delta,
      reason: args.reason,
      actor: args.actorName ?? actor.userId,
      note: args.note ?? null,
    },
  });
  await products.update({
    where: { id: args.productId },
    data: { stockQty: { increment: args.delta } },
  });
  return txn;
}

/** Parse an ISO date string from the API contract into a Date; 400 on garbage. */
function parseDate(value: unknown, field: string): Date {
  const d = new Date(String(value ?? ""));
  if (Number.isNaN(d.getTime())) {
    throw new OpsError(400, `Invalid ${field}: must be an ISO-8601 date`);
  }
  return d;
}

/** Materialize the create: entity-specific server-side rules. */
async function createRows(
  tx: Tx,
  def: OpsEntityDef,
  actor: OpsActor,
  body: Record<string, unknown>,
): Promise<Array<Record<string, unknown>>> {
  const d = delegateFor(tx, def);
  const base = { workspaceId: actor.workspaceId };

  switch (def.slug) {
    case "orders":
    case "invoices":
    case "purchase-orders": {
      const lineItems = body.lineItems as LineItem[];
      const { subtotalCents, taxCents, totalCents } = totalsFor(lineItems, (body.taxCents as number) ?? 0);
      // Slice 2: optional explicit due date on invoices (validated ISO).
      let dueAt: Date | null = null;
      if (def.slug === "invoices" && body.dueAt != null) {
        const parsed = new Date(String(body.dueAt));
        if (Number.isNaN(parsed.getTime())) {
          throw new OpsError(400, "Invalid invoice dueAt: must be an ISO-8601 date");
        }
        dueAt = parsed;
      }
      const data = {
        ...base,
        // Initial statuses are set explicitly (not left to DB defaults)
        // so the service's contract is visible in code and in stubs.
        status: "draft",
        lineItems: toJson(lineItems),
        taxCents,
        totalCents,
        // subtotalCents exists on orders + purchase-orders, not invoices.
        ...(def.slug === "invoices" ? {} : { subtotalCents }),
        ...(def.slug === "purchase-orders"
          ? {
              supplierId: (body.supplierId as string) ?? null,
              supplierName: (body.supplierName as string) ?? null,
              // Phase 10 (finance): vendor link + RFQ stage.
              vendorId: (body.vendorId as string) ?? null,
              ...(body.rfq === true ? { status: "rfq" } : {}),
            }
          : { customerId: body.customerId ?? null }),
        ...(def.slug === "invoices" && body.idempotencyKey
          ? { idempotencyKey: body.idempotencyKey }
          : {}),
        ...(def.slug === "invoices" && dueAt ? { dueAt } : {}),
        // Phase 10 (finance): recipient override for invoice delivery.
        ...(def.slug === "invoices" && typeof body.customerEmail === "string" ? { customerEmail: body.customerEmail } : {}),
      };
      if (def.slug === "invoices" && typeof body.idempotencyKey === "string") {
        // Atomic on the (workspaceId, idempotencyKey) unique: a concurrent
        // duplicate resolves to the existing row instead of a P2002.
        return [
          await d.upsert({
            where: {
              workspaceId_idempotencyKey: { workspaceId: actor.workspaceId, idempotencyKey: body.idempotencyKey },
            },
            create: data,
            update: { idempotencyKey: body.idempotencyKey },
          }),
        ];
      }
      return [await d.create({ data })];
    }
    case "payments": {
      // Bulk refund batch → N rows in one transaction.
      const items = body.items as Array<{ orderId?: string; amountCents: number; providerRef?: string }> | undefined;
      if (Array.isArray(items)) {
        const rows: Array<Record<string, unknown>> = [];
        for (const it of items) {
          rows.push(
            await d.create({
              data: {
                ...base,
                orderId: it.orderId ?? null,
                provider: (body.provider as string) ?? "stripe",
                kind: "refund",
                amountCents: it.amountCents,
                status: "pending",
                providerRef: it.providerRef ?? null,
              },
            }),
          );
        }
        return rows;
      }
      return [
        await d.create({
          data: {
            ...base,
            orderId: (body.orderId as string) ?? null,
            provider: (body.provider as string) ?? "stripe",
            kind: (body.kind as string) ?? "charge",
            amountCents: body.amountCents as number,
            status: (body.status as string) ?? "pending",
            providerRef: (body.providerRef as string) ?? null,
          },
        }),
      ];
    }
    case "inventory-txns": {
      // Atomic stock move via the shared helper (same transaction).
      const txn = await recordInventoryTxn(tx, actor, {
        productId: body.productId as string,
        delta: body.delta as number,
        reason: body.reason as "sale" | "restock" | "adjustment",
        note: (body.note as string) ?? null,
        actorName: (body.actor as string) ?? null,
      });
      return [txn];
    }
    case "team-members": {
      // Slice 5: startDate arrives as an ISO string in the API contract;
      // the model stores a Date.
      const data: Record<string, unknown> = { ...base, ...stripInternal(body) };
      if (body.startDate != null) data.startDate = parseDate(body.startDate, "startDate");
      return [await d.create({ data })];
    }
    case "leave-requests": {
      // Slice 5: dates parsed server-side; the range is validated (end on
      // or after start); initial status is set explicitly to "requested"
      // (not left to the DB default) so the contract is visible in code.
      const startDate = parseDate(body.startDate, "startDate");
      const endDate = parseDate(body.endDate, "endDate");
      if (endDate.getTime() < startDate.getTime()) {
        throw new OpsError(400, "Leave endDate must be on or after startDate");
      }
      return [
        await d.create({
          data: {
            ...base,
            memberId: body.memberId as string,
            type: body.type as string,
            startDate,
            endDate,
            status: "requested",
          },
        }),
      ];
    }
    default:
      return [await d.create({ data: { ...base, ...stripInternal(body) } })];
  }
}

/** Fields the API contract accepts but the model doesn't store directly. */
function stripInternal(body: Record<string, unknown>): Record<string, unknown> {
  const { approvalId: _a, ...rest } = body;
  return rest;
}

// ---------------------------------------------------------------------------
// PATCH — update by id. Free updates run freely (logged); money transitions
// (invoice send, order cancel/fulfill, ...) go through the gate.
// ---------------------------------------------------------------------------

export async function opsPatch(
  tx: Tx,
  def: OpsEntityDef,
  actor: OpsActor,
  rawBody: unknown,
  opts: OpsServiceOpts = {},
): Promise<OpsWriteResult> {
  if (!def.patchable) {
    throw new OpsError(405, `${def.label} is an immutable ledger — corrections are new records, never edits`);
  }
  // Transport keys live outside the patch contract: strip `id` before
  // validation so strict patch schemas (products) don't 400 on it.
  const raw = rawBody && typeof rawBody === "object" ? (rawBody as Record<string, unknown>) : {};
  const id = raw.id;
  if (typeof id !== "string" || !id) throw new OpsError(400, "PATCH requires an \"id\"");
  const { id: _id, ...patchInput } = raw;
  const parsed = def.patchSchema.safeParse(patchInput);
  if (!parsed.success) {
    throw new OpsError(400, `Invalid ${def.label} patch: ${parsed.error.issues[0]?.message ?? "validation failed"}`);
  }
  const body = rawBody as Record<string, unknown>;
  const patch = parsed.data as Record<string, unknown>;
  const classification = classifyOpsWrite({ entity: def.slug, op: "update", body: { ...patch, id } });
  const port = opts.gatePort ?? phase14GatePort;
  const d = delegateFor(tx, def);

  // 404 for "not your workspace's row" (RLS + explicit scope).
  const existing = await d.findFirst({ where: { id, workspaceId: actor.workspaceId } });
  if (!existing) throw new OpsNotFoundError(def.slug, id);
  // Illegal moves fail before anything is proposed or written.
  assertOpsPatchAllowed(def, existing, patch);

  if (classification.mode === "gated") {
    const approvalId = body.approvalId as string | undefined;
    const mutation = { id, ...patch };
    if (!approvalId) {
      const approval = await requestOpsApproval(port, {
        workspaceId: actor.workspaceId,
        slug: classification.slug!,
        entity: def.slug,
        entityId: id,
        mutation,
        actor: actor.userId,
        summary: `${classification.label}: ${def.summarize({ ...existing, ...patch })}`,
      });
      await auditOpsEvent(tx, def, actor, "gate_proposed", id, `${classification.label} proposed (approval ${approval.id})`);
      return { outcome: "approval_required", approval, classification };
    }
    await verifyAndConsumeOpsApproval(port, tx, {
      workspaceId: actor.workspaceId,
      slug: classification.slug!,
      entity: def.slug,
      entityId: id,
      mutation,
      approvalId,
      actor: actor.userId,
    });
    const row = await applyPatch(tx, def, actor, id, await preparePatch(tx, def, actor, patch, existing), existing);
    await auditOpsEvent(tx, def, actor, "gate_executed", id, `${classification.label} (approval ${approvalId}): ${def.summarize(row)}`);
    return { outcome: "done", row, action: "gate_executed" };
  }

  const row = await applyPatch(tx, def, actor, id, await preparePatch(tx, def, actor, patch, existing), existing);
  await auditOpsEvent(tx, def, actor, "update", id, `updated ${def.summarize(row)}`);
  return { outcome: "done", row, action: "update" };
}

/** Phase 10 (finance): run the entity's prepare hook on a validated patch. */
async function preparePatch(
  tx: Tx,
  def: OpsEntityDef,
  actor: OpsActor,
  patch: Record<string, unknown>,
  existing: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const hooks = await entityHooks(def.slug);
  return hooks?.prepare ? hooks.prepare(tx, actor, patch, existing) : patch;
}

/**
 * Status machine + draft-only money edits for entities that declare
 * statusTransitions (invoices, orders, purchase orders). 409 on an illegal
 * move (e.g. draft → overdue, paid → overdue, draft PO → received) or on a
 * tax/line edit to a non-draft document.
 */
export function assertOpsPatchAllowed(
  def: OpsEntityDef,
  existing: Record<string, unknown>,
  patch: Record<string, unknown>,
): void {
  const table = def.statusTransitions;
  if (!table) return;
  const from = String(existing.status);
  if (typeof patch.status === "string") {
    const allowed = table[from] ?? [];
    if (!allowed.includes(patch.status)) {
      throw new OpsError(409, `${def.label} cannot move from ${from} to ${patch.status}`);
    }
  }
  // Phase 10 (finance): RFQ-stage POs stay editable (editableStatuses).
  const editable = def.editableStatuses ?? ["draft"];
  if ((patch.taxCents !== undefined || patch.lineItems !== undefined) && !editable.includes(from)) {
    throw new OpsError(409, `${def.label} totals can only be edited while draft (it is ${from})`);
  }
}

/** Apply the patch: entity-specific rules (compensation append, sentAt). */
async function applyPatch(
  tx: Tx,
  def: OpsEntityDef,
  actor: OpsActor,
  id: string,
  patch: Record<string, unknown>,
  existing: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const d = delegateFor(tx, def);
  const data: Record<string, unknown> = { ...patch };

  if (def.slug === "workflow-runs" && patch.compensationAppend) {
    // Append-only compensation log: never replaced through the API.
    const log = Array.isArray(existing.compensationLog) ? [...existing.compensationLog] : [];
    log.push({ ...(patch.compensationAppend as Record<string, unknown>), at: new Date().toISOString() });
    data.compensationLog = log;
    delete data.compensationAppend;
  }
  if (def.slug === "invoices" && patch.status === "sent" && !existing.sentAt) {
    const sentAt = new Date();
    data.sentAt = sentAt;
    // Slice 2: no explicit due date → net-30 from send. Drives the overdue sweep.
    if (!existing.dueAt) {
      data.dueAt = new Date(sentAt.getTime() + 30 * 24 * 3600_000);
    }
  }
  if (def.slug === "projects" && typeof patch.status === "string") {
    // Slice 4: guard the status flow — planning → active → on_hold /
    // completed / cancelled. Terminal states have no exits. Non-status
    // patches (name, milestones, lead refs) pass through untouched.
    const { assertLegalProjectTransition } = await import("./projects");
    assertLegalProjectTransition(String(existing.status), patch.status);
  }
  if (def.slug === "leave-requests" && typeof patch.status === "string") {
    // Slice 5: guard the leave flow — requested → approved/denied → taken.
    // Denied and taken are terminal. Approving records who decided and
    // when (the gate itself ran before we got here).
    const { assertLegalLeaveTransition } = await import("./hr");
    assertLegalLeaveTransition(String(existing.status), patch.status);
    if (patch.status === "approved" || patch.status === "denied") {
      data.decidedBy = actor.userId;
      data.decidedAt = new Date();
    }
  }
  if (def.statusTransitions) {
    // Draft edits to tax/lines recompute the stored totals (never stale).
    if (patch.taxCents !== undefined || patch.lineItems !== undefined) {
      const lineItems = (patch.lineItems ?? existing.lineItems ?? []) as LineItem[];
      const totals = totalsFor(lineItems, (patch.taxCents as number | undefined) ?? Number(existing.taxCents ?? 0));
      data.taxCents = totals.taxCents;
      data.totalCents = totals.totalCents;
      if (def.slug !== "invoices") data.subtotalCents = totals.subtotalCents;
      if (patch.lineItems !== undefined) data.lineItems = toJson(patch.lineItems);
    }
    if (def.slug === "purchase-orders") {
      // Slice 3: PO lifecycle. Send is gated (OPS_PO_SEND); receive is a free
      // fulfillment write that books restock txns for line items carrying a
      // productId — only on the sent → received move (transition table).
      if (patch.status === "sent" && !existing.sentAt) data.sentAt = new Date();
      if (patch.status === "received") data.receivedAt = new Date();
    }
    // Phase 10 (finance): extra columns written with the move (e.g. the
    // invoice number) — inside the same guarded write.
    const hooks = await entityHooks(def.slug);
    const moving = typeof patch.status === "string" && patch.status !== existing.status;
    const transition = moving
      ? { id, from: String(existing.status), to: String(patch.status), existing, patch }
      : null;
    if (transition && hooks?.beforeTransition) {
      Object.assign(data, (await hooks.beforeTransition(tx, actor, transition)) ?? {});
    }
    // Status-guarded write: lands only if the row is still in the status we
    // validated against. A racing transition (double receive, sweep vs
    // mark-paid) matches 0 rows → 409, and nothing below it runs.
    const claimed = await d.updateMany({
      where: { id, workspaceId: actor.workspaceId, status: existing.status },
      data,
    });
    if (claimed.count !== 1) {
      throw new OpsError(409, `${def.label} changed concurrently (no longer ${String(existing.status)}) — reload and retry`);
    }
    // Phase 10 (finance): receiving (restock of the still-outstanding
    // quantities, with a receipt record) moved to the purchase-orders
    // afterTransition hook (lib/ops/finance/hooks.ts) so partial receipts are
    // never restocked twice; it still returns { restocked } metadata.
    const moved = (await d.findFirst({ where: { id, workspaceId: actor.workspaceId } }))!;
    // Phase 10 (finance): posting / payments / receipts in the same tx.
    if (transition && hooks?.afterTransition) {
      const meta = await hooks.afterTransition(tx, actor, { ...transition, row: moved });
      if (meta) return { ...(await d.findFirst({ where: { id, workspaceId: actor.workspaceId } }))!, ...meta };
    }
    return moved;
  }
  return d.update({ where: { id, workspaceId: actor.workspaceId }, data });
}

/** Entity lookup for routes/tests. Throws OpsError 404 on unknown slugs. */
export function opsEntityDef(slug: string): OpsEntityDef {
  const def = OPS_ENTITY_MAP[slug];
  if (!def) throw new OpsError(404, `Unknown ops entity "${slug}"`);
  return def;
}

// Re-exported for the route layer's error mapping.
export { OpsGateError, opsBindingFor };
