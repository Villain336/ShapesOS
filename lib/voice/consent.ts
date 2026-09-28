// Marketr — Phase 13D Worker A: outbound consent gating.
//
// HARD RULE (FCC 2024 AI-robocall ruling; spec §compliance): outbound AI voice
// calls may ONLY go to opted-in prospects. No consent → no dial. There are no
// bypass flags, no "implied" consent, no exceptions — the gate is the
// `evaluateConsent` pure function below, and `requestSession` (sessions.ts)
// calls it on every request. ContactConsent is the single source of truth;
// the snapshot saved into CallSession.consentProof is the audit record.
//
// Status vocabulary (lib/messaging/consent.ts): unknown | pending |
// opted_in | opted_out. Only "opted_in" passes.

import type { ContactConsent } from "@prisma/client";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";

export type ConsentChannel = "voice" | "sms" | "chat";
export type ConsentStatus = "unknown" | "pending" | "opted_in" | "opted_out";

export interface ConsentProof {
  leadId: string;
  channel: ConsentChannel;
  status: ConsentStatus;
  consentRecordId: string | null;
  consentedAt: string | null;
  optedOutAt: string | null;
  source: string | null;
  checkedAt: string;
  legalBasis: "FCC-2024-AI-robocall: prior express consent";
}

export interface ConsentDecision {
  allowed: boolean;
  blockReason?: string;
  proof: ConsentProof;
}

/**
 * Pure, DB-free consent evaluation. Test-covered (no-consent → hard refusal,
 * opted-out → refusal, pending/unknown → refusal; only opted_in passes).
 */
export function evaluateConsent(
  record: Pick<
    ContactConsent,
    "id" | "leadId" | "channel" | "status" | "consentedAt" | "optedOutAt" | "source"
  > | null,
  workspaceId: string,
  leadId: string,
  channel: ConsentChannel,
): ConsentDecision {
  const proof: ConsentProof = {
    leadId,
    channel,
    status: (record?.status ?? "unknown") as ConsentStatus,
    consentRecordId: record?.id ?? null,
    consentedAt: record?.consentedAt ? record.consentedAt.toISOString() : null,
    optedOutAt: record?.optedOutAt ? record.optedOutAt.toISOString() : null,
    source: record?.source ?? null,
    checkedAt: new Date().toISOString(),
    legalBasis: "FCC-2024-AI-robocall: prior express consent",
  };
  if (!record) {
    return {
      allowed: false,
      blockReason: "no_consent_record",
      proof,
    };
  }
  switch (record.status) {
    case "opted_in":
      return { allowed: true, proof };
    case "opted_out":
      return { allowed: false, blockReason: "consent_opted_out", proof };
    case "pending":
      return { allowed: false, blockReason: "consent_pending", proof };
    default:
      return { allowed: false, blockReason: "consent_unknown", proof };
  }
}

/**
 * Read the ContactConsent row for (workspace, lead, channel) and decide.
 * This is the ONLY path to "may we dial this lead on this channel" — every
 * outbound session request funnels through here. There is deliberately no
 * `force` / `skipCheck` parameter.
 */
export async function checkOutboundConsent(
  workspaceId: string,
  leadId: string,
  channel: ConsentChannel,
): Promise<ConsentDecision> {
  const record = await withWorkspaceScope(workspaceId, (tx) =>
    tx.contactConsent.findUnique({
      where: {
        workspaceId_leadId_channel: { workspaceId, leadId, channel },
      },
      select: {
        id: true,
        leadId: true,
        channel: true,
        status: true,
        consentedAt: true,
        optedOutAt: true,
        source: true,
      },
    }),
  );
  return evaluateConsent(record, workspaceId, leadId, channel);
}

/**
 * Record or update a consent row (opt-in / opt-out management surface for
 * the consent page). Writing opted_out stamps optedOutAt; opting back in
 * clears it and stamps consentedAt.
 */
export async function upsertConsent(
  workspaceId: string,
  leadId: string,
  channel: ConsentChannel,
  status: Extract<ConsentStatus, "opted_in" | "opted_out">,
  source?: string,
): Promise<ContactConsent> {
  const now = new Date();
  return withWorkspaceScope(workspaceId, (tx) =>
    tx.contactConsent.upsert({
      where: { workspaceId_leadId_channel: { workspaceId, leadId, channel } },
      update: {
        status,
        source: source ?? undefined,
        consentedAt: status === "opted_in" ? now : undefined,
        optedOutAt: status === "opted_out" ? now : null,
      },
      create: {
        workspaceId,
        leadId,
        channel,
        status,
        source,
        consentedAt: status === "opted_in" ? now : null,
        optedOutAt: status === "opted_out" ? now : null,
      },
    }),
  );
}

/** Consent status per lead for a channel, for the consent management table. */
export async function listLeadConsent(
  workspaceId: string,
  opts?: { channel?: ConsentChannel; status?: ConsentStatus },
): Promise<
  Array<{
    id: string;
    leadId: string;
    channel: string;
    status: string;
    source: string | null;
    consentedAt: Date | null;
    optedOutAt: Date | null;
    lead: { name: string; email: string | null; phone: string | null };
  }>
> {
  return withWorkspaceScope(workspaceId, (tx) =>
    tx.contactConsent.findMany({
      where: {
        workspaceId,
        ...(opts?.channel ? { channel: opts.channel } : {}),
        ...(opts?.status ? { status: opts.status } : {}),
      },
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        leadId: true,
        channel: true,
        status: true,
        source: true,
        consentedAt: true,
        optedOutAt: true,
        lead: { select: { name: true, email: true, phone: true } },
      },
    }),
  );
}
