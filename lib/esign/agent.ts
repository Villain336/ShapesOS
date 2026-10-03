// Marketr — E-sign module: agent-driven signing workflows (SPEC-GAP-ESIGN.md §4.4).
// The agent prepares, never sends. Every send still goes through the human
// send gate (sendEnvelope requires the bound review token — this module
// never mints one and never calls sendEnvelope). Nudges are drafted for
// approval: draft → approve → record delivery. Expiration is swept on a
// schedule; re-send clones a fresh draft that re-enters the send gate.

import { createHash, randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { appendAuditEvent, type AuditDb } from "./audit";
import { createEnvelopeDraft, EsignGateError, type DraftSignerInput } from "./envelopes";
import { instantiateTemplate } from "./templates";
import type { SignerRole } from "./vendor";

/** Envelope-level signer roles are a closed set (template roles are freeform). */
const ENVELOPE_ROLES: SignerRole[] = ["signer", "approver", "cc"];

// Full Prisma delegates throughout — the agent calls createEnvelopeDraft /
// instantiateTemplate / appendAuditEvent, all of which take the full types.
// Tests pass `db as any` (established pattern in this module).
export type AgentDb = Pick<
  PrismaClient,
  "esignEnvelope" | "esignSigner" | "esignField" | "esignTemplate" | "esignAuditEvent"
>;

export interface PrepareDraftInput {
  workspaceId: string;
  /** Who/what prepared it, e.g. "agent:pipeline" or a user id. */
  actor: string;
  title: string;
  /** Template path — drafts mint from the template's exact bytes. */
  templateId?: string;
  mergeValues?: Record<string, unknown>;
  signerBindings?: Array<{ role: string; name: string; email: string }>;
  /** Raw path — the agent supplies reviewed bytes (e.g. an accepted proposal PDF). */
  pdfBytes?: Uint8Array;
  documentName?: string;
  signers?: DraftSignerInput[];
  signingOrder?: "sequential" | "parallel";
  expiresAt?: Date | null;
  contractType?: string;
  contractRef?: string;
}

/**
 * The agent prepares a draft behind the send gate. Returns the draft and a
 * send preview — it NEVER sends. The human review dialog mints the token.
 */
export async function prepareEnvelopeDraft(db: AgentDb, input: PrepareDraftInput) {
  let envelopeId: string;
  if (input.templateId) {
    const res = await instantiateTemplate(db, {
      templateId: input.templateId,
      workspaceId: input.workspaceId,
      title: input.title,
      mergeValues: input.mergeValues ?? {},
      signerBindings: input.signerBindings ?? [],
      createdBy: input.actor,
      contractType: input.contractType,
      contractRef: input.contractRef,
    });
    envelopeId = res.envelope.id;
  } else {
    if (!input.pdfBytes) {
      throw new EsignGateError("invalid_input", "An agent draft needs a template or reviewed PDF bytes.");
    }
    if (!input.signers || input.signers.length === 0) {
      throw new EsignGateError("no_signers", "An agent draft needs at least one signer.");
    }
    const envelope = await createEnvelopeDraft(db, {
      workspaceId: input.workspaceId,
      title: input.title,
      signers: input.signers,
      signingOrder: input.signingOrder,
      expiresAt: input.expiresAt,
      documentName: input.documentName,
      pdfBytes: input.pdfBytes,
      createdBy: input.actor,
      contractType: input.contractType,
      contractRef: input.contractRef,
    });
    envelopeId = envelope.id;
  }

  await appendAuditEvent(db, {
    envelopeId,
    event: "agent_draft_prepared",
    actor: input.actor,
    payload: {
      templateId: input.templateId ?? null,
      mergeKeys: input.mergeValues ? Object.keys(input.mergeValues) : [],
      sendGate: "human-review-required",
    },
    bodyHash: createHash("sha256")
      .update(JSON.stringify(["agent_draft_prepared", envelopeId, input.actor]))
      .digest("hex"),
  });

  const envelope = await db.esignEnvelope.findFirst({
    where: { id: envelopeId },
    include: { signers: { orderBy: { orderIndex: "asc" } } },
  });
  return {
    envelopeId,
    status: "draft" as const,
    sendPreview: {
      title: input.title,
      signerCount: (envelope?.signers ?? []).length,
      signers: (envelope?.signers ?? []).map((s: { name: string; email: string }) => ({
        name: s.name,
        email: s.email,
      })),
      sendGate: "human-review-required" as const,
    },
  };
}

export interface PendingSigner {
  envelopeId: string;
  envelopeTitle: string;
  signerId: string;
  name: string;
  email: string;
  status: string;
  daysWaiting: number;
  lastNudgeAt: string | null;
}

/** Signers who haven't signed on live envelopes, oldest wait first. */
export async function listPendingSigners(
  db: AgentDb,
  input: { workspaceId: string; idleDays?: number; now?: Date },
): Promise<PendingSigner[]> {
  const now = input.now ?? new Date();
  const envelopes = await db.esignEnvelope.findMany({
    where: { workspaceId: input.workspaceId, status: { in: ["sent", "partially-signed"] } },
    include: { signers: { orderBy: { orderIndex: "asc" } } },
  });
  const out: PendingSigner[] = [];
  for (const env of envelopes) {
    const nudges = await db.esignAuditEvent.findMany({
      where: { envelopeId: env.id, event: "nudge_sent" },
      orderBy: { createdAt: "desc" },
    });
    const lastNudgeBySigner = new Map<string, Date>();
    for (const n of nudges) {
      const p = (n.payload ?? {}) as { signerId?: string };
      if (p.signerId && !lastNudgeBySigner.has(p.signerId)) lastNudgeBySigner.set(p.signerId, n.createdAt);
    }
    for (const s of env.signers as Array<{
      id: string;
      name: string;
      email: string;
      status: string;
      signedAt: Date | null;
    }>) {
      if (s.status === "signed" || s.signedAt) continue;
      const lastNudgeAt = lastNudgeBySigner.get(s.id) ?? null;
      const daysWaiting = Math.floor(
        (now.getTime() - ((s as { updatedAt?: Date }).updatedAt ?? env.createdAt).getTime()) / 86400000,
      );
      if (input.idleDays == null || daysWaiting >= input.idleDays) {
        out.push({
          envelopeId: env.id,
          envelopeTitle: env.title,
          signerId: s.id,
          name: s.name,
          email: s.email,
          status: s.status,
          daysWaiting,
          lastNudgeAt: lastNudgeAt?.toISOString() ?? null,
        });
      }
    }
  }
  return out.sort((a, b) => b.daysWaiting - a.daysWaiting);
}

/** Draft a nudge for approval. The draft is content — nothing is delivered. */
export async function draftNudge(
  db: AgentDb,
  input: {
    envelopeId: string;
    signerId: string;
    workspaceId: string;
    actor: string;
    customMessage?: string;
  },
) {
  const envelope = await db.esignEnvelope.findFirst({
    where: { id: input.envelopeId, workspaceId: input.workspaceId },
    include: { signers: true },
  });
  if (!envelope) throw new EsignGateError("unknown_envelope", "Envelope not found.");
  const signer = (envelope.signers as Array<{ id: string; name: string; email: string; status: string }>).find(
    (s) => s.id === input.signerId,
  );
  if (!signer) throw new EsignGateError("unknown_signer", "Signer not found on this envelope.");
  if (signer.status === "signed") throw new EsignGateError("already_signed", "This signer already signed.");

  const nudgeId = `nudge_${randomUUID().slice(0, 8)}`;
  const message =
    input.customMessage?.trim() ||
    `Hi ${signer.name},\n\nA friendly reminder that "${envelope.title}" is waiting for your signature. ` +
      `Please review and sign at your earliest convenience.\n\nThank you.`;

  const res = await appendAuditEvent(db, {
    envelopeId: envelope.id,
    event: "nudge_drafted",
    actor: input.actor,
    payload: { nudgeId, signerId: signer.id, email: signer.email, message, status: "draft" },
    bodyHash: createHash("sha256").update(JSON.stringify(["nudge_drafted", nudgeId])).digest("hex"),
  });
  if (!res.ok) throw new EsignGateError("duplicate_nudge", "This nudge was already drafted.");
  return { nudgeEventId: res.id, nudgeId, message };
}

/** Approve a drafted nudge. Approval releases it to the delivery rail — the
 *  rail itself is the vendor's (reminder email); delivery is recorded
 *  separately so the OS never claims a send it didn't make. */
export async function approveNudge(
  db: AgentDb,
  input: { nudgeEventId: string; workspaceId: string; actor: string },
) {
  const draft = await db.esignAuditEvent.findUnique({ where: { id: input.nudgeEventId } });
  if (!draft || draft.event !== "nudge_drafted") {
    throw new EsignGateError("unknown_nudge", "Nudge draft not found.");
  }
  const payload = (draft.payload ?? {}) as { nudgeId: string; signerId: string; message: string };
  const prior = await db.esignAuditEvent.findMany({
    where: { envelopeId: draft.envelopeId, event: "nudge_approved" },
  });
  if (prior.some((e) => (e.payload as { nudgeId?: string } | null)?.nudgeId === payload.nudgeId)) {
    throw new EsignGateError("nudge_already_released", "This nudge was already approved.");
  }
  // Workspace scoping: the draft belongs to an envelope in this workspace.
  const envelope = await db.esignEnvelope.findFirst({
    where: { id: draft.envelopeId, workspaceId: input.workspaceId },
  });
  if (!envelope) throw new EsignGateError("unknown_envelope", "Envelope not found.");

  await appendAuditEvent(db, {
    envelopeId: draft.envelopeId,
    event: "nudge_approved",
    actor: input.actor,
    payload: { nudgeId: payload.nudgeId, signerId: payload.signerId, approvedBy: input.actor },
    bodyHash: createHash("sha256").update(JSON.stringify(["nudge_approved", payload.nudgeId])).digest("hex"),
  });
  return { nudgeId: payload.nudgeId, signerId: payload.signerId, message: payload.message };
}

/** Record that the approved nudge was actually delivered (vendor rail). */
export async function recordNudgeDelivery(
  db: AgentDb,
  input: {
    nudgeId: string;
    envelopeId: string;
    workspaceId: string;
    deliveredVia: string;
    actor: string;
  },
) {
  const envelope = await db.esignEnvelope.findFirst({
    where: { id: input.envelopeId, workspaceId: input.workspaceId },
  });
  if (!envelope) throw new EsignGateError("unknown_envelope", "Envelope not found.");
  // Carry the signer through from the approval so the pending list can show recency.
  const approvals = await db.esignAuditEvent.findMany({
    where: { envelopeId: envelope.id, event: "nudge_approved" },
  });
  const approval = approvals.find(
    (e) => ((e.payload ?? {}) as { nudgeId?: string }).nudgeId === input.nudgeId,
  );
  const signerId = ((approval?.payload ?? {}) as { signerId?: string }).signerId ?? null;
  await appendAuditEvent(db, {
    envelopeId: envelope.id,
    event: "nudge_sent",
    actor: input.actor,
    payload: { nudgeId: input.nudgeId, signerId, deliveredVia: input.deliveredVia },
    bodyHash: createHash("sha256").update(JSON.stringify(["nudge_sent", input.nudgeId])).digest("hex"),
  });
  return { nudgeId: input.nudgeId, deliveredVia: input.deliveredVia };
}

/** Sweep live envelopes past their expiry into `expired`. The vendor
 *  webhook normally drives this; the sweep is the backstop. */
export async function sweepExpirations(
  db: AgentDb,
  input: { workspaceId: string; actor: string; now?: Date },
): Promise<{ expired: number; ids: string[] }> {
  const now = input.now ?? new Date();
  const stale = await db.esignEnvelope.findMany({
    where: {
      workspaceId: input.workspaceId,
      status: { in: ["sent", "partially-signed"] },
      expiresAt: { lt: now },
    },
  });
  const ids: string[] = [];
  for (const env of stale) {
    // Guarded: an envelope completed/voided since the read is never expired.
    const res = await db.esignEnvelope.updateMany({
      where: { id: env.id, status: { in: ["sent", "partially-signed"] } },
      data: { status: "expired" },
    });
    if (res.count !== 1) continue;
    await appendAuditEvent(db, {
      envelopeId: env.id,
      event: "expired",
      actor: input.actor,
      payload: { sweptAt: now.toISOString() },
      bodyHash: createHash("sha256")
        .update(JSON.stringify(["expired_sweep", env.id, now.toISOString()]))
        .digest("hex"),
    });
    ids.push(env.id);
  }
  return { expired: ids.length, ids };
}

/**
 * Re-send an expired (or declined) envelope: clone its exact source bytes,
 * signers and fields into a FRESH DRAFT that re-enters the send gate.
 * The original is untouched. Completed envelopes can never be cloned —
 * there is exactly one sealed artifact per signing.
 */
export async function cloneAsDraft(
  db: AgentDb,
  input: { envelopeId: string; workspaceId: string; actor: string },
) {
  const original = await db.esignEnvelope.findFirst({
    where: { id: input.envelopeId, workspaceId: input.workspaceId },
    include: { signers: { orderBy: { orderIndex: "asc" } }, fields: true },
  });
  if (!original) throw new EsignGateError("unknown_envelope", "Envelope not found.");
  if (!["expired", "declined"].includes(original.status)) {
    throw new EsignGateError("not_reopenable", "Only expired or declined envelopes can be re-sent as a new draft.");
  }
  if (!original.sourcePdf) throw new EsignGateError("empty_document", "The original has no source document.");

  const clone = await createEnvelopeDraft(db, {
    workspaceId: input.workspaceId,
    title: `${original.title} (re-send)`,
    signers: (original.signers as Array<{ name: string; email: string; role: string; orderIndex: number }>).map(
      (s) => ({
        name: s.name,
        email: s.email,
        // Freeform template roles don't survive to the envelope; coerce.
        role: (ENVELOPE_ROLES as string[]).includes(s.role) ? (s.role as SignerRole) : "signer",
        orderIndex: s.orderIndex,
      }),
    ),
    fields: (original.fields as Array<{
      signerId: string | null;
      fieldType: string;
      page: number | null;
      x: number | null;
      y: number | null;
      width: number | null;
      height: number | null;
      required: boolean;
    }>).map((f, i) => ({
      signerIndex:
        f.signerId != null
          ? (original.signers as Array<{ id: string }>).findIndex((s) => s.id === f.signerId)
          : i % Math.max((original.signers as unknown[]).length, 1),
      fieldType: f.fieldType as never,
      page: f.page ?? undefined,
      x: f.x ?? undefined,
      y: f.y ?? undefined,
      width: f.width ?? undefined,
      height: f.height ?? undefined,
      required: f.required,
    })),
    signingOrder: original.signingOrder as "sequential" | "parallel",
    documentName: original.documentName ?? undefined,
    pdfBytes: new Uint8Array(original.sourcePdf),
    createdBy: input.actor,
    contractType: original.contractType ?? undefined,
    contractRef: original.contractRef ?? undefined,
  });

  await appendAuditEvent(db, {
    envelopeId: clone.id,
    event: "draft_cloned",
    actor: input.actor,
    payload: { clonedFrom: original.id },
    bodyHash: createHash("sha256").update(JSON.stringify(["draft_cloned", clone.id, original.id])).digest("hex"),
  });
  return { envelopeId: clone.id, clonedFrom: original.id, status: "draft" as const };
}

/** Time-to-sign analytics, overall and per template. */
export async function signingAnalytics(
  db: AgentDb,
  input: { workspaceId: string; since?: Date },
) {
  const envelopes = await db.esignEnvelope.findMany({
    where: {
      workspaceId: input.workspaceId,
      ...(input.since ? { createdAt: { gte: input.since } } : {}),
    },
  });
  const durations: number[] = [];
  const byTemplate = new Map<string, { envelopes: number; completed: number; durations: number[] }>();

  for (const env of envelopes) {
    const key = (env.templateId as string | null) ?? "__raw__";
    const bucket = byTemplate.get(key) ?? { envelopes: 0, completed: 0, durations: [] };
    bucket.envelopes++;
    const events = await db.esignAuditEvent.findMany({
      where: { envelopeId: env.id },
      orderBy: { createdAt: "asc" },
    });
    const sent = events.find((e) => e.event === "sent");
    const completed = events.find((e) => e.event === "completed");
    if (sent && completed) {
      const hours = (completed.createdAt.getTime() - sent.createdAt.getTime()) / 3600000;
      durations.push(hours);
      bucket.durations.push(hours);
      bucket.completed++;
    }
    byTemplate.set(key, bucket);
  }

  const summarize = (ds: number[]) => {
    if (ds.length === 0) return { avgHours: null as number | null, medianHours: null as number | null };
    const sorted = [...ds].sort((a, b) => a - b);
    return {
      avgHours: ds.reduce((a, b) => a + b, 0) / ds.length,
      medianHours: sorted[Math.floor(sorted.length / 2)]!,
    };
  };

  const completedCount = [...byTemplate.values()].reduce((n, b) => n + b.completed, 0);
  return {
    envelopes: envelopes.length,
    completed: completedCount,
    completionRate: envelopes.length ? completedCount / envelopes.length : 0,
    ...summarize(durations),
    byTemplate: [...byTemplate.entries()].map(([templateId, b]) => ({
      templateId: templateId === "__raw__" ? null : templateId,
      envelopes: b.envelopes,
      completed: b.completed,
      completionRate: b.envelopes ? b.completed / b.envelopes : 0,
      ...summarize(b.durations),
    })),
  };
}
