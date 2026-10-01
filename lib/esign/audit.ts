// Marketr — E-sign module: hash-chained audit events (SPEC-GAP-ESIGN.md §4.4).
// Every governed action and every ingested vendor webhook event appends one
// row. Each row's hash chains to the previous row's hash, so tampering with
// any event breaks the chain. bodyHash is unique: identical deliveries
// (webhook replays, double-submits) are no-ops, never double-applied.

import { createHash } from "node:crypto";

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Stable stringify: sorted keys, so the same payload always hashes the same. */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Chain one event into the log. previousHash is null for the envelope's first
 * event (the "created" row).
 */
export function chainEventHash(
  previousHash: string | null,
  event: string,
  canonicalPayload: string,
  createdAtIso: string,
): string {
  return sha256Hex(`${previousHash ?? "GENESIS"}|${event}|${createdAtIso}|${canonicalPayload}`);
}

export interface AuditDb {
  esignAuditEvent: {
    findFirst(args: {
      where: { envelopeId: string };
      orderBy: { createdAt: "desc" };
      select: { hash: true };
    }): Promise<{ hash: string } | null>;
    create(args: { data: Record<string, unknown> }): Promise<{ id: string }>;
  };
}

export interface AppendAuditEventInput {
  envelopeId: string;
  event: string;
  actor: string;
  /** Canonical payload for hashing; stored as JSON alongside. */
  payload: unknown;
  /**
   * Idempotency key. For webhooks: sha256 of the raw body. For governed
   * actions: sha256 of the canonical action payload. Unique in the DB —
   * replays throw a unique-violation which we translate to { deduped: true }.
   */
  bodyHash: string;
  createdAt?: Date;
}

export type AppendAuditEventResult =
  | { ok: true; id: string; hash: string }
  | { ok: false; deduped: true };

/** Prisma unique-violation code (P2002). */
function isUniqueViolation(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    (e as { code?: unknown }).code === "P2002"
  );
}

export async function appendAuditEvent(
  db: AuditDb,
  input: AppendAuditEventInput,
): Promise<AppendAuditEventResult> {
  const createdAt = input.createdAt ?? new Date();
  const canonical = canonicalJson(input.payload ?? null);
  const prev = await db.esignAuditEvent.findFirst({
    where: { envelopeId: input.envelopeId },
    orderBy: { createdAt: "desc" },
    select: { hash: true },
  });
  const hash = chainEventHash(prev?.hash ?? null, input.event, canonical, createdAt.toISOString());
  try {
    const row = await db.esignAuditEvent.create({
      data: {
        envelopeId: input.envelopeId,
        event: input.event,
        actor: input.actor,
        hash,
        previousHash: prev?.hash ?? null,
        bodyHash: input.bodyHash,
        payload: (input.payload ?? null) as object,
        createdAt,
      },
    });
    return { ok: true, id: row.id, hash };
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, deduped: true };
    throw e;
  }
}

/** Verify a chain of (hash, previousHash) pairs. Pure — for tests and the evidence pack. */
export function verifyAuditChain(
  rows: Array<{ hash: string; previousHash: string | null }>,
): boolean {
  for (let i = 0; i < rows.length; i++) {
    const expectedPrev = i === 0 ? null : rows[i - 1]!.hash;
    if (rows[i]!.previousHash !== expectedPrev) return false;
  }
  return true;
}
