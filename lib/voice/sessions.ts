// Marketr — Phase 13D Worker A: CallSession lifecycle + the four gates.
//
// ALL four gates are enforced in ONE function: `requestSession()`. There is
// NO code path that creates a live (queued/in_progress) session without
// passing them, and even then the session stops at `rehearsal` unless
// LIVE_DIALING=1 AND a human approved the session (see lib/voice/livekit.ts).
//
// Gates:
//   (a) agent kill switch OFF (and agent active)
//   (b) ContactConsent opted-in for the channel → proof snapshotted into
//       consentProof (first-class audit record)
//   (c) script status === 'approved' — drafts never dial
//   (d) AI disclosure present in the script opening
//
// A refused request is NEVER silently dropped: it is persisted as a
// status='blocked' session with blockReason + auditTrail, so the refusal is
// itself auditable.
//
// Status machine: rehearsal → queued → in_progress → completed | cancelled;
// blocked is terminal; cancelled is terminal. Every transition appends to
// auditTrail via `transitionSession()`. Rehearsal is the default and the
// safe end state — it means "ran through the gates in simulation".

import { Prisma, type CallSession, type VoiceAgent, type CallScript } from "@prisma/client";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import {
  checkOutboundConsent,
  type ConsentChannel,
  type ConsentDecision,
} from "./consent";
import { hasAiDisclosure, canAttachToLiveSession } from "./scripts";
import { isAgentLiveBlocked } from "./agents";

const json = (v: unknown): Prisma.InputJsonValue => v as Prisma.InputJsonValue;

export type SessionStatus =
  | "rehearsal"
  | "queued"
  | "in_progress"
  | "completed"
  | "cancelled"
  | "blocked";

export type BlockReason =
  | "kill_switch_on"
  | "agent_paused"
  | "agent_archived"
  | "no_consent_record"
  | "consent_pending"
  | "consent_unknown"
  | "consent_opted_out"
  | "script_not_approved"
  | "disclosure_missing"
  | "live_dialing_not_enabled";

export interface AuditEntry {
  ts: string;
  actor: string;
  action: string;
  detail?: string;
}

export interface TranscriptTurn {
  role: "agent" | "prospect" | "system";
  text: string;
  ts: string;
}

export interface RequestSessionInput {
  agentId: string;
  leadId: string;
  scriptId: string;
  channel: ConsentChannel;
  /** When true AND LIVE_DIALING=1, the session goes live (queued). */
  requestLive?: boolean;
  /** Human approver id — required for any live request. */
  approvedBy?: string;
}

export interface RequestSessionResult {
  session: CallSession;
  blocked: boolean;
  blockReason?: BlockReason;
  consent: ConsentDecision;
}

/** Pure, DB-free: append an entry to an audit trail array. */
export function appendAuditEntry(
  trail: AuditEntry[],
  entry: Omit<AuditEntry, "ts"> & { ts?: string },
): AuditEntry[] {
  return [
    ...trail,
    { ts: entry.ts ?? new Date().toISOString(), actor: entry.actor, action: entry.action, detail: entry.detail },
  ];
}

/** Pure: legal status transitions. Rehearsal sessions end as completed. */
const LEGAL_TRANSITIONS: Record<SessionStatus, SessionStatus[]> = {
  rehearsal: ["in_progress", "completed", "cancelled"],
  queued: ["in_progress", "cancelled", "blocked"],
  in_progress: ["completed", "cancelled", "blocked"],
  completed: [],
  cancelled: [],
  blocked: [],
};

/** Pure, DB-free: is this transition legal? Test-covered. */
export function isLegalTransition(from: SessionStatus, to: SessionStatus): boolean {
  return LEGAL_TRANSITIONS[from]?.includes(to) ?? false;
}

// ---------------------------------------------------------------------------
// The gate: requestSession()
// ---------------------------------------------------------------------------

/**
 * Evaluate the four gates for (agent, lead, script, channel). Every
 * refusal path records a blocked session — nothing is silently dropped.
 *
 * Live policy: even when all gates pass, the session lands in `rehearsal`
 * unless `requestLive=true` AND `approvedBy` is set AND
 * process.env.LIVE_DIALING === "1". In rehearsal mode NO LiveKit room is
 * created and nothing dials — the LiveKit scaffold (lib/voice/livekit.ts)
 * only attaches to sessions that are explicitly live-approved.
 */
export async function requestSession(
  workspaceId: string,
  input: RequestSessionInput,
  opts?: { actorUserId?: string },
): Promise<RequestSessionResult> {
  const actor = opts?.actorUserId ?? "system";
  const auditBase: AuditEntry[] = [
    { ts: new Date().toISOString(), actor, action: "session_requested", detail: `channel=${input.channel}` },
  ];

  const fail = async (
    blockReason: BlockReason,
    consent: ConsentDecision,
  ): Promise<RequestSessionResult> => {
    const session = await withWorkspaceScope(workspaceId, (tx) =>
      tx.callSession.create({
        data: {
          workspaceId,
          agentId: input.agentId,
          leadId: input.leadId,
          scriptId: input.scriptId,
          channel: input.channel,
          direction: "outbound",
          consentProof: json(consent.proof),
          status: "blocked",
          blockReason,
          outcome: "refused_no_consent",
          auditTrail: json(
            appendAuditEntry(auditBase, {
              actor: "gate",
              action: "session_blocked",
              detail: `block_reason=${blockReason}`,
            }),
          ),
        },
      }),
    );
    return { session, blocked: true, blockReason, consent };
  };

  // --- gate (a): agent live + kill switch off ---
  const agent = await withWorkspaceScope(workspaceId, (tx) =>
    tx.voiceAgent.findFirst({
      where: { id: input.agentId, workspaceId },
    }),
  );
  if (!agent) throw new Error("Voice agent not found.");
  const consent = await checkOutboundConsent(workspaceId, input.leadId, input.channel);
  const agentBlock = isAgentLiveBlocked(agent);
  if (agentBlock.blocked) {
    return fail(agentBlock.reason as BlockReason, consent);
  }

  // --- gate (b): consent ---
  if (!consent.allowed) {
    return fail(consent.blockReason as BlockReason, consent);
  }

  // --- gate (c): script approved ---
  const script = await withWorkspaceScope(workspaceId, (tx) =>
    tx.callScript.findFirst({
      where: { id: input.scriptId, workspaceId },
    }),
  );
  if (!script || !canAttachToLiveSession(script)) {
    return fail("script_not_approved", consent);
  }

  // --- gate (d): AI disclosure in the opening ---
  const opening = ((script.body as { opening?: unknown })?.opening ?? "") as string;
  if (!hasAiDisclosure(String(opening))) {
    return fail("disclosure_missing", consent);
  }

  // --- live policy: rehearsal unless explicitly live-enabled + approved ---
  const liveRequested = input.requestLive === true;
  const liveEnabled = process.env.LIVE_DIALING === "1";
  const humanApproved = !!input.approvedBy?.trim();
  const goesLive = liveRequested && humanApproved && liveEnabled;
  const status: SessionStatus = goesLive ? "queued" : "rehearsal";
  const auditTrail = appendAuditEntry(auditBase, {
    actor: "gate",
    action: "gates_passed",
    detail: `mode=${status}${goesLive ? ` approved_by=${input.approvedBy}` : ""}`,
  });

  const session = await withWorkspaceScope(workspaceId, (tx) =>
    tx.callSession.create({
      data: {
        workspaceId,
        agentId: input.agentId,
        leadId: input.leadId,
        scriptId: input.scriptId,
        channel: input.channel,
        direction: "outbound",
        consentProof: json(consent.proof),
        status,
        auditTrail: json(auditTrail),
        startedAt: status === "rehearsal" ? new Date() : null,
      },
    }),
  );
  return { session, blocked: false, consent };
}

/** Fetch with transcript + audit trail + relations (the session detail view). */
export async function getSession(
  workspaceId: string,
  sessionId: string,
): Promise<
  | (CallSession & {
      agent: Pick<VoiceAgent, "id" | "name" | "killSwitch">;
      lead: { id: string; name: string; email: string | null; phone: string | null };
      script: Pick<CallScript, "id" | "name" | "version" | "status"> | null;
    })
  | null
> {
  return withWorkspaceScope(workspaceId, (tx) =>
    tx.callSession.findFirst({
      where: { id: sessionId, workspaceId },
      include: {
        agent: { select: { id: true, name: true, killSwitch: true } },
        lead: { select: { id: true, name: true, email: true, phone: true } },
        script: { select: { id: true, name: true, version: true, status: true } },
      },
    }),
  );
}

export interface SessionListItem {
  id: string;
  channel: string;
  status: string;
  outcome: string | null;
  blockReason: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
  createdAt: Date;
  agent: { id: string; name: string };
  lead: { id: string; name: string };
}

export async function listSessions(
  workspaceId: string,
  opts?: { agentId?: string; status?: string; leadId?: string; take?: number },
): Promise<SessionListItem[]> {
  return withWorkspaceScope(workspaceId, (tx) =>
    tx.callSession.findMany({
      where: {
        workspaceId,
        ...(opts?.agentId ? { agentId: opts.agentId } : {}),
        ...(opts?.status ? { status: opts.status } : {}),
        ...(opts?.leadId ? { leadId: opts.leadId } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: Math.min(opts?.take ?? 100, 500),
      select: {
        id: true,
        channel: true,
        status: true,
        outcome: true,
        blockReason: true,
        startedAt: true,
        endedAt: true,
        createdAt: true,
        agent: { select: { id: true, name: true } },
        lead: { select: { id: true, name: true } },
      },
    }),
  );
}

/**
 * Move a session through the status machine. Illegal transitions throw —
 * the audit trail can never be forged into an impossible sequence.
 */
export async function transitionSession(
  workspaceId: string,
  sessionId: string,
  to: SessionStatus,
  opts?: { actorUserId?: string; detail?: string },
): Promise<CallSession> {
  const current = await withWorkspaceScope(workspaceId, (tx) =>
    tx.callSession.findFirst({ where: { id: sessionId, workspaceId } }),
  );
  if (!current) throw new Error("Call session not found.");
  const from = current.status as SessionStatus;
  if (!isLegalTransition(from, to))
    throw new Error(`Illegal session transition: ${from} → ${to}.`);
  const trail = (current.auditTrail ?? []) as unknown as AuditEntry[];
  const actor = opts?.actorUserId ?? "system";
  const auditTrail = appendAuditEntry(trail, {
    actor,
    action: `status_${to}`,
    detail: opts?.detail ?? `from=${from}`,
  });
  return withWorkspaceScope(workspaceId, (tx) =>
    tx.callSession.update({
      where: { id: sessionId, workspaceId },
      data: {
        status: to,
        auditTrail: json(auditTrail),
        ...(to === "in_progress" ? { startedAt: current.startedAt ?? new Date() } : {}),
        ...(to === "completed" || to === "cancelled" ? { endedAt: new Date() } : {}),
      },
    }),
  );
}

/** Append a transcript turn. Turns are append-only. */
export async function appendTranscriptTurn(
  workspaceId: string,
  sessionId: string,
  turn: Omit<TranscriptTurn, "ts"> & { ts?: string },
): Promise<CallSession> {
  const current = await withWorkspaceScope(workspaceId, (tx) =>
    tx.callSession.findFirst({ where: { id: sessionId, workspaceId } }),
  );
  if (!current) throw new Error("Call session not found.");
  const transcript = (current.transcript ?? []) as unknown as TranscriptTurn[];
  return withWorkspaceScope(workspaceId, (tx) =>
    tx.callSession.update({
      where: { id: sessionId, workspaceId },
      data: {
        transcript: json([
          ...transcript,
          { role: turn.role, text: turn.text, ts: turn.ts ?? new Date().toISOString() },
        ]),
      },
    }),
  );
}

/** Record an outcome (qualified | booked | callback | not_interested | …). */
export async function setOutcome(
  workspaceId: string,
  sessionId: string,
  outcome: string,
  opts?: { actorUserId?: string },
): Promise<CallSession> {
  const current = await withWorkspaceScope(workspaceId, (tx) =>
    tx.callSession.findFirst({ where: { id: sessionId, workspaceId } }),
  );
  if (!current) throw new Error("Call session not found.");
  const trail = (current.auditTrail ?? []) as unknown as AuditEntry[];
  return withWorkspaceScope(workspaceId, (tx) =>
    tx.callSession.update({
      where: { id: sessionId, workspaceId },
      data: {
        outcome,
        auditTrail: json(
          appendAuditEntry(trail, {
            actor: opts?.actorUserId ?? "system",
            action: "outcome_set",
            detail: `outcome=${outcome}`,
          }),
        ),
      },
    }),
  );
}

/**
 * Attach a recording ref. TWO-PARTY-CONSENT GATING: throws unless
 * recordingConsent=true on the session. Recording consent is captured
 * during the call (prospect's explicit "yes, you may record").
 */
export async function attachRecording(
  workspaceId: string,
  sessionId: string,
  recordingRef: string,
): Promise<CallSession> {
  const current = await withWorkspaceScope(workspaceId, (tx) =>
    tx.callSession.findFirst({ where: { id: sessionId, workspaceId } }),
  );
  if (!current) throw new Error("Call session not found.");
  if (!current.recordingConsent)
    throw new Error(
      "Recording consent not granted: cannot attach a recording without the prospect's explicit consent (two-party-consent gating).",
    );
  const trail = (current.auditTrail ?? []) as unknown as AuditEntry[];
  return withWorkspaceScope(workspaceId, (tx) =>
    tx.callSession.update({
      where: { id: sessionId, workspaceId },
      data: {
        recordingRef,
        auditTrail: json(
          appendAuditEntry(trail, {
            actor: "system",
            action: "recording_attached",
            detail: "recording_consent=true verified",
          }),
        ),
      },
    }),
  );
}

/** Record the prospect's recording consent (mid-call, explicit). */
export async function grantRecordingConsent(
  workspaceId: string,
  sessionId: string,
  opts?: { actorUserId?: string },
): Promise<CallSession> {
  const current = await withWorkspaceScope(workspaceId, (tx) =>
    tx.callSession.findFirst({ where: { id: sessionId, workspaceId } }),
  );
  if (!current) throw new Error("Call session not found.");
  const trail = (current.auditTrail ?? []) as unknown as AuditEntry[];
  return withWorkspaceScope(workspaceId, (tx) =>
    tx.callSession.update({
      where: { id: sessionId, workspaceId },
      data: {
        recordingConsent: true,
        auditTrail: json(
          appendAuditEntry(trail, {
            actor: opts?.actorUserId ?? "system",
            action: "recording_consent_granted",
            detail: "prospect explicitly consented to recording",
          }),
        ),
      },
    }),
  );
}
