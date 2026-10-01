// Marketr — E-sign module: the legal vault.
// A vault entry anchors a completed envelope's sealed artifact: the sealed
// PDF hash + the audit chain's head hash are captured at vault time, so any
// later tampering is detectable. Retention policy lives here; a legal hold
// blocks purging. The audit chain is re-verified on the way in — a broken
// chain can never be vaulted.

import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { appendAuditEvent, canonicalJson, chainEventHash, type AuditDb } from "./audit";
import { EsignGateError } from "./envelopes";

export type VaultDb = Pick<PrismaClient, "esignEnvelope" | "esignVaultEntry"> & AuditDb;

export interface ChainEvent {
  event: string;
  hash: string;
  previousHash: string | null;
  payload: unknown;
  createdAt: Date;
}

/** Recompute the hash chain over ordered events. */
export function verifyAuditChain(events: ChainEvent[]): { ok: boolean; checked: number; failedAt?: number } {
  let prev: string | null = null;
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    if (e.previousHash !== prev) return { ok: false, checked: i, failedAt: i };
    const recomputed = chainEventHash(prev, e.event, canonicalJson(e.payload ?? null), e.createdAt.toISOString());
    if (recomputed !== e.hash) return { ok: false, checked: i, failedAt: i };
    prev = e.hash;
  }
  return { ok: true, checked: events.length };
}

export async function storeInVault(
  db: VaultDb,
  input: { envelopeId: string; workspaceId: string; retentionDays?: number; actor: string },
) {
  const envelope = await db.esignEnvelope.findFirst({
    where: { id: input.envelopeId, workspaceId: input.workspaceId },
    include: {
      signers: true,
      events: { orderBy: { createdAt: "asc" } },
      vaultEntry: true,
    },
  });
  if (!envelope) throw new EsignGateError("unknown_envelope", "Envelope not found.");
  if (envelope.vaultEntry) return envelope.vaultEntry;
  if (envelope.status !== "completed") {
    throw new EsignGateError("not_completed", "Only completed envelopes can enter the vault.");
  }
  if (!envelope.sealedPdf || !envelope.sealedPdfHash) {
    throw new EsignGateError("no_sealed_pdf", "The sealed PDF is missing — the vault anchors evidence, not promises.");
  }

  const chain = verifyAuditChain(
    envelope.events.map((e) => ({
      event: e.event,
      hash: e.hash,
      previousHash: e.previousHash,
      payload: e.payload,
      createdAt: e.createdAt,
    })),
  );
  if (!chain.ok) {
    throw new EsignGateError("broken_chain", `Audit chain verification failed at event #${chain.failedAt}.`);
  }

  const head = envelope.events[envelope.events.length - 1]!;
  const entry = await db.esignVaultEntry.create({
    data: {
      workspaceId: input.workspaceId,
      envelopeId: envelope.id,
      sealedPdfHash: envelope.sealedPdfHash,
      auditHeadHash: head.hash,
      eventCount: envelope.events.length,
      signerCount: envelope.signers.length,
      retentionUntil:
        input.retentionDays && input.retentionDays > 0
          ? new Date(Date.now() + input.retentionDays * 24 * 60 * 60 * 1000)
          : null,
    },
  });

  await appendAuditEvent(db, {
    envelopeId: envelope.id,
    event: "vault_stored",
    actor: input.actor,
    payload: {
      vaultEntryId: entry.id,
      sealedPdfHash: envelope.sealedPdfHash,
      auditHeadHash: head.hash,
      retentionUntil: entry.retentionUntil?.toISOString() ?? null,
    },
    bodyHash: createHash("sha256")
      .update(JSON.stringify(["vault_stored", envelope.id, entry.id, head.hash]))
      .digest("hex"),
  });

  return entry;
}

export async function setLegalHold(
  db: VaultDb,
  input: { entryId: string; workspaceId: string; reason: string; actor: string },
) {
  if (!input.reason.trim()) throw new EsignGateError("missing_reason", "A legal hold needs a reason.");
  const entry = await db.esignVaultEntry.findFirst({
    where: { id: input.entryId, workspaceId: input.workspaceId },
  });
  if (!entry) throw new EsignGateError("unknown_vault_entry", "Vault entry not found.");
  const updated = await db.esignVaultEntry.update({
    where: { id: entry.id },
    data: { legalHold: true, legalHoldReason: input.reason.trim() },
  });
  await appendAuditEvent(db, {
    envelopeId: entry.envelopeId,
    event: "legal_hold_set",
    actor: input.actor,
    payload: { vaultEntryId: entry.id, reason: input.reason.trim() },
    bodyHash: createHash("sha256")
      .update(JSON.stringify(["legal_hold_set", entry.id, Date.now()]))
      .digest("hex"),
  });
  return updated;
}

export async function releaseLegalHold(
  db: VaultDb,
  input: { entryId: string; workspaceId: string; actor: string },
) {
  const entry = await db.esignVaultEntry.findFirst({
    where: { id: input.entryId, workspaceId: input.workspaceId },
  });
  if (!entry) throw new EsignGateError("unknown_vault_entry", "Vault entry not found.");
  const updated = await db.esignVaultEntry.update({
    where: { id: entry.id },
    data: { legalHold: false, legalHoldReason: null },
  });
  await appendAuditEvent(db, {
    envelopeId: entry.envelopeId,
    event: "legal_hold_released",
    actor: input.actor,
    payload: { vaultEntryId: entry.id },
    bodyHash: createHash("sha256")
      .update(JSON.stringify(["legal_hold_released", entry.id, Date.now()]))
      .digest("hex"),
  });
  return updated;
}

/**
 * Retention enforcement. Entries past retention with NO legal hold have
 * their sealed bytes purged (the retention policy working as designed).
 * Legal holds block purging — always.
 */
export async function purgeExpired(
  db: VaultDb,
  input: { workspaceId: string; actor: string },
): Promise<{ purged: number; blockedByHold: number }> {
  const now = new Date();
  const candidates = await db.esignVaultEntry.findMany({
    where: {
      workspaceId: input.workspaceId,
      purgedAt: null,
      retentionUntil: { lt: now },
    },
  });
  let purged = 0;
  let blockedByHold = 0;
  for (const entry of candidates) {
    if (entry.legalHold) {
      blockedByHold++;
      continue;
    }
    await db.esignEnvelope.update({
      where: { id: entry.envelopeId },
      data: { sealedPdf: null, sealedPdfHash: null },
    });
    await db.esignVaultEntry.update({
      where: { id: entry.id },
      data: { purgedAt: now },
    });
    await appendAuditEvent(db, {
      envelopeId: entry.envelopeId,
      event: "retention_purged",
      actor: input.actor,
      payload: { vaultEntryId: entry.id, retentionUntil: entry.retentionUntil?.toISOString() ?? null },
      bodyHash: createHash("sha256")
        .update(JSON.stringify(["retention_purged", entry.id, now.toISOString()]))
        .digest("hex"),
    });
    purged++;
  }
  return { purged, blockedByHold };
}
