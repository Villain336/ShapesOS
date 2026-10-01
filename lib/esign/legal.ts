// Marketr — E-sign module: legal/compliance binding (SPEC-GAP-ESIGN.md §4.3).
// The legal/compliance module arrives next phase with real Contract objects.
// Until then, envelopes carry generic refs (contractType/contractRef) and
// this module provides the governed verbs the legal module will call:
// linkContract (bind an envelope to a contract object), flipContractExecuted
// (record the executed-state flip — only on a completed, sealed envelope),
// and buildEvidencePack (the one package for counsel: sealed PDF hash +
// hash-chained log + signer identity evidence).

import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { appendAuditEvent, type AuditDb } from "./audit";
import { EsignGateError } from "./envelopes";
import { verifyAuditChain } from "./vault";

export type LegalDb = Pick<PrismaClient, "esignEnvelope" | "esignVaultEntry"> & AuditDb;

/**
 * Bind an envelope to a contract object (generic refs until the legal
 * module lands). Governed: workspace-scoped, audited.
 */
export async function linkContract(
  db: LegalDb,
  input: { envelopeId: string; workspaceId: string; contractType: string; contractRef: string; actor: string },
) {
  if (!input.contractType.trim() || !input.contractRef.trim()) {
    throw new EsignGateError("invalid_input", "A contract type and reference are required.");
  }
  const envelope = await db.esignEnvelope.findFirst({
    where: { id: input.envelopeId, workspaceId: input.workspaceId },
  });
  if (!envelope) throw new EsignGateError("unknown_envelope", "Envelope not found.");
  const updated = await db.esignEnvelope.update({
    where: { id: envelope.id },
    data: { contractType: input.contractType.trim(), contractRef: input.contractRef.trim() },
  });
  await appendAuditEvent(db, {
    envelopeId: envelope.id,
    event: "contract_linked",
    actor: input.actor,
    payload: { contractType: updated.contractType, contractRef: updated.contractRef },
    bodyHash: createHash("sha256")
      .update(JSON.stringify(["contract_linked", envelope.id, updated.contractType, updated.contractRef]))
      .digest("hex"),
  });
  return updated;
}

/**
 * Record the contract's executed-state flip. Only a completed envelope with
 * a mirrored sealed PDF can flip a contract to executed — the flip is the
 * legal module's write, and this is the evidence it stands on.
 */
export async function flipContractExecuted(
  db: LegalDb,
  input: { envelopeId: string; workspaceId: string; actor: string },
) {
  const envelope = await db.esignEnvelope.findFirst({
    where: { id: input.envelopeId, workspaceId: input.workspaceId },
  });
  if (!envelope) throw new EsignGateError("unknown_envelope", "Envelope not found.");
  if (envelope.status !== "completed") {
    throw new EsignGateError("not_completed", "Only a completed envelope can flip a contract to executed.");
  }
  if (!envelope.sealedPdfHash) {
    throw new EsignGateError("no_sealed_pdf", "No sealed PDF — there is nothing to execute on.");
  }
  if (!envelope.contractRef) {
    throw new EsignGateError("no_contract_link", "Link a contract before flipping it to executed.");
  }
  await appendAuditEvent(db, {
    envelopeId: envelope.id,
    event: "contract_executed",
    actor: input.actor,
    payload: {
      contractType: envelope.contractType,
      contractRef: envelope.contractRef,
      sealedPdfHash: envelope.sealedPdfHash,
    },
    bodyHash: createHash("sha256")
      .update(JSON.stringify(["contract_executed", envelope.id, envelope.contractRef, envelope.sealedPdfHash]))
      .digest("hex"),
  });
  return { contractType: envelope.contractType, contractRef: envelope.contractRef };
}

/** The evidence pack: everything counsel needs, nothing invented. */
export async function buildEvidencePack(
  db: LegalDb,
  input: { envelopeId: string; workspaceId: string },
) {
  const envelope = await db.esignEnvelope.findFirst({
    where: { id: input.envelopeId, workspaceId: input.workspaceId },
    include: {
      signers: { orderBy: { orderIndex: "asc" } },
      events: { orderBy: { createdAt: "asc" } },
      vaultEntry: true,
    },
  });
  if (!envelope) throw new EsignGateError("unknown_envelope", "Envelope not found.");

  const chain = verifyAuditChain(
    envelope.events.map((e) => ({
      event: e.event,
      hash: e.hash,
      previousHash: e.previousHash,
      payload: e.payload,
      createdAt: e.createdAt,
    })),
  );

  return {
    envelope: {
      id: envelope.id,
      title: envelope.title,
      status: envelope.status,
      vendor: envelope.vendor,
      vendorRef: envelope.vendorRef,
      documentName: envelope.documentName,
      sourcePdfHash: envelope.sourcePdfHash,
      sealedPdfHash: envelope.sealedPdfHash,
      sealedPdfFetchedAt: envelope.sealedPdfFetchedAt?.toISOString() ?? null,
      contractType: envelope.contractType,
      contractRef: envelope.contractRef,
      expiresAt: envelope.expiresAt?.toISOString() ?? null,
      createdAt: envelope.createdAt.toISOString(),
    },
    integrity: {
      chainOk: chain.ok,
      eventsChecked: chain.checked,
      failedAt: chain.failedAt ?? null,
    },
    signers: envelope.signers.map((s) => ({
      name: s.name,
      email: s.email,
      role: s.role,
      orderIndex: s.orderIndex,
      status: s.status,
      signedAt: s.signedAt?.toISOString() ?? null,
      identityEvidence: s.identityEvidence,
    })),
    auditLog: envelope.events.map((e) => ({
      event: e.event,
      actor: e.actor,
      hash: e.hash,
      previousHash: e.previousHash,
      createdAt: e.createdAt.toISOString(),
    })),
    vault: envelope.vaultEntry
      ? {
          storedAt: envelope.vaultEntry.storedAt.toISOString(),
          sealedPdfHash: envelope.vaultEntry.sealedPdfHash,
          auditHeadHash: envelope.vaultEntry.auditHeadHash,
          retentionUntil: envelope.vaultEntry.retentionUntil?.toISOString() ?? null,
          legalHold: envelope.vaultEntry.legalHold,
        }
      : null,
    // The sealed PDF itself travels as a separate download (it can be large);
    // its hash here binds the download to this pack.
    sealedPdfDownload: envelope.sealedPdf ? `/api/esign/envelopes/${envelope.id}/evidence/pdf` : null,
  };
}
