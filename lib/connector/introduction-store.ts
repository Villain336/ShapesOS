// Marketr — Connector Agent slice 4: Introduction store (Prisma).
// The double-opt-in lifecycle, enforced at the store layer:
//
// - Every method takes workspaceId first; every query is scoped to it.
//   A row id from another tenant throws not_found — never a cross-tenant
//   read or write.
// - State transitions go through assertIntroTransition +
//   assertIntroPreconditions (lib/connector/introductions.ts) — every
//   illegal transition throws invalid_transition.
// - accept/decline are HUMAN actions only: requireHumanActor rejects any
//   agent actor (code agent_cannot_act), including the tenant's own agent.
// - make_intro is legal ONLY from side_b_accepted — nothing sends before
//   both acceptances are recorded on the Introduction object.
// - propose_intro enforces the per-mutual rate limit (boundaries honored;
//   tenant override per instance, recorded on the row).
// - Drafts are data: sends happen only via the tenant's connected messaging
//   account (sentVia), only after tenant approval + dual acceptance, and
//   every send is an auditable event on the Introduction.
// - One active Introduction per pair: the partial unique index on
//   (workspace_id, person_a_id, person_b_id) WHERE status is active raises
//   P2002, wrapped as intro_already_active. Terminal intros (declined,
//   expired, withdrawn) free the pair for a future proposal.

import type { PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { ConnectorError } from "./types";
import {
  attachDataRoomOffer,
  buildDataRoomOfferLine,
  writebackIntroductionMade,
} from "./funding-plugin";
import { DEFAULT_CONNECTOR_MODE, type ConnectorMode } from "./modes";
import {
  assertIntroPreconditions,
  assertIntroTransition,
  DEFAULT_INTRO_EXPIRY_DAYS,
  introAskWindow,
  isIntroExpired,
  requireHumanActor,
  validateFollowupInput,
  validateIntroSendInput,
  validateProposeIntroductionInput,
  type ConnectorIntroActorKind,
  type ConnectorIntroAuditKind,
  type ConnectorIntroductionDetailView,
  type ConnectorIntroductionEventView,
  type ConnectorIntroductionStatus,
  type ConnectorIntroductionView,
  type FollowupInput,
  type IntroActor,
  type IntroSendInput,
  type ProposeIntroductionInput,
} from "./introductions";
import { notifyApprovalNeeded } from "@/lib/notifications/producers";

const DAY_MS = 24 * 60 * 60 * 1000;

/** createdAt must be after this for a proposal to still be actionable. */
function expiryCutoff(now: Date): Date {
  return new Date(now.getTime() - DEFAULT_INTRO_EXPIRY_DAYS * DAY_MS);
}

type PersonRef = { id: string; name: string; handles: string[] };

type FundingInvestorRef = { id: string; name: string; firm: string | null };

type IntroductionRow = {
  id: string;
  personAId: string;
  personBId: string;
  personA: PersonRef;
  personB: PersonRef;
  status: ConnectorIntroductionStatus;
  // Slice 5: mode + funding plug-in.
  mode: ConnectorMode;
  fundingInvestorId: string | null;
  fundingInvestor: FundingInvestorRef | null;
  dataRoomShareLinkId: string | null;
  introPathSnapshot: unknown;
  draftAskMessage: string;
  draftOfferMessage: string;
  tenantApproved: boolean;
  tenantApprovedBy: string | null;
  tenantApprovedAt: Date | null;
  sideAAcceptedBy: string | null;
  sideAAcceptedAt: Date | null;
  sideBAcceptedBy: string | null;
  sideBAcceptedAt: Date | null;
  madeMessage: string | null;
  madeSentVia: string | null;
  madeSentBy: string | null;
  madeSentAt: Date | null;
  declinedBy: string | null;
  declinedAt: Date | null;
  declineReason: string | null;
  withdrawnBy: string | null;
  withdrawnAt: Date | null;
  expiredAt: Date | null;
  rateLimitOverrideMaxAsks: number | null;
  rateLimitOverrideWindowDays: number | null;
  followupCount: number;
  pendingFollowupDraft: string | null;
  pendingFollowupTo: string | null;
  createdAt: Date;
  updatedAt: Date;
};

const PERSON_REF_SELECT = { id: true, name: true, handles: true } as const;
const FUNDING_INVESTOR_REF_SELECT = { id: true, name: true, firm: true } as const;

// Slice 5: every introduction read pulls the funding-investor lineage
// (needed for the writeback display + tenant isolation check).
const INTRO_INCLUDES = {
  personA: { select: PERSON_REF_SELECT },
  personB: { select: PERSON_REF_SELECT },
  fundingInvestor: { select: FUNDING_INVESTOR_REF_SELECT },
} as const;

function toIntroductionView(row: IntroductionRow): ConnectorIntroductionView {
  return {
    id: row.id,
    personA: { id: row.personA.id, name: row.personA.name, handles: row.personA.handles },
    personB: { id: row.personB.id, name: row.personB.name, handles: row.personB.handles },
    status: row.status,
    // Slice 5: mode + funding plug-in.
    mode: row.mode ?? DEFAULT_CONNECTOR_MODE,
    fundingInvestorId: row.fundingInvestorId,
    fundingInvestor: row.fundingInvestor
      ? { id: row.fundingInvestor.id, name: row.fundingInvestor.name, firm: row.fundingInvestor.firm }
      : null,
    dataRoomShareLinkId: row.dataRoomShareLinkId,
    introPathSnapshot: (row.introPathSnapshot ?? {}) as Record<string, unknown>,
    draftAskMessage: row.draftAskMessage,
    draftOfferMessage: row.draftOfferMessage,
    tenantApproved: row.tenantApproved,
    tenantApprovedBy: row.tenantApprovedBy,
    tenantApprovedAt: row.tenantApprovedAt,
    sideAAcceptedBy: row.sideAAcceptedBy,
    sideAAcceptedAt: row.sideAAcceptedAt,
    sideBAcceptedBy: row.sideBAcceptedBy,
    sideBAcceptedAt: row.sideBAcceptedAt,
    madeMessage: row.madeMessage,
    madeSentVia: row.madeSentVia,
    madeSentBy: row.madeSentBy,
    madeSentAt: row.madeSentAt,
    declinedBy: row.declinedBy,
    declinedAt: row.declinedAt,
    declineReason: row.declineReason,
    withdrawnBy: row.withdrawnBy,
    withdrawnAt: row.withdrawnAt,
    expiredAt: row.expiredAt,
    rateLimitOverrideMaxAsks: row.rateLimitOverrideMaxAsks,
    rateLimitOverrideWindowDays: row.rateLimitOverrideWindowDays,
    followupCount: row.followupCount,
    pendingFollowupDraft: row.pendingFollowupDraft,
    pendingFollowupTo: row.pendingFollowupTo,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toEventView(row: {
  id: string;
  kind: ConnectorIntroAuditKind;
  actorKind: ConnectorIntroActorKind;
  actorIdentity: string;
  message: string | null;
  createdAt: Date;
}): ConnectorIntroductionEventView {
  return {
    id: row.id,
    kind: row.kind,
    actorKind: row.actorKind,
    actorIdentity: row.actorIdentity,
    message: row.message,
    createdAt: row.createdAt,
  };
}

export class PrismaIntroductionStore {
  constructor(private prisma: PrismaClient) {}

  // ------------------------------------------------------------------
  // Reads — always tenant-scoped.
  // ------------------------------------------------------------------

  private async getIntroOrThrow(
    workspaceId: string,
    introId: string,
  ): Promise<IntroductionRow> {
    const row = await this.prisma.connectorIntroduction.findFirst({
      where: { id: introId, workspaceId },
      include: { ...INTRO_INCLUDES },
    });
    if (!row) {
      throw new ConnectorError("introduction_not_found", "Introduction not found in this workspace.");
    }
    return row as IntroductionRow;
  }

  async getIntroductionDetail(
    workspaceId: string,
    introId: string,
  ): Promise<ConnectorIntroductionDetailView> {
    const row = await this.getIntroOrThrow(workspaceId, introId);
    const events = await this.prisma.connectorIntroductionEvent.findMany({
      where: { introductionId: introId, workspaceId },
      orderBy: { createdAt: "asc" },
    });
    return {
      ...toIntroductionView(row),
      events: events.map((e) => toEventView(e as Parameters<typeof toEventView>[0])),
    };
  }

  async listIntroductions(
    workspaceId: string,
    opts: {
      status?: ConnectorIntroductionStatus;
      /** The approval inbox: proposed intros the tenant has not approved yet. */
      awaitingApproval?: boolean;
      /** Slice 5: mode-scoped listing (LEADS vs FUNDING proposals). */
      mode?: ConnectorMode;
      limit?: number;
    } = {},
  ): Promise<ConnectorIntroductionView[]> {
    const where: Record<string, unknown> = { workspaceId };
    if (opts.status) where["status"] = opts.status;
    if (opts.mode) where["mode"] = opts.mode;
    if (opts.awaitingApproval) {
      where["status"] = "proposed";
      where["tenantApproved"] = false;
    }
    const rows = await this.prisma.connectorIntroduction.findMany({
      where,
      include: {
        ...INTRO_INCLUDES,
      },
      orderBy: { createdAt: "desc" },
      take: Math.min(Math.max(opts.limit ?? 100, 1), 500),
    });
    return rows.map((r) => toIntroductionView(r as IntroductionRow));
  }

  /**
   * Guarded transition. The write lands only while the row is still in the
   * state this call validated (same status + `guard`); zero rows means a
   * concurrent request moved it on first → intro_conflict (HTTP 409). Two
   * concurrent accepts therefore produce one acceptance and one offer.
   */
  private async transition(
    workspaceId: string,
    intro: IntroductionRow,
    guard: Prisma.ConnectorIntroductionWhereInput,
    data: Prisma.ConnectorIntroductionUpdateManyMutationInput,
  ): Promise<IntroductionRow> {
    const res = await this.prisma.connectorIntroduction.updateMany({
      where: { id: intro.id, workspaceId, status: intro.status, ...guard },
      data,
    });
    if (res.count !== 1) {
      const current = await this.getIntroOrThrow(workspaceId, intro.id);
      throw new ConnectorError(
        current.status === "proposed" && isIntroExpired(current.createdAt, new Date(), DEFAULT_INTRO_EXPIRY_DAYS)
          ? "intro_expired"
          : "intro_conflict",
        `This introduction changed while you were acting on it (now ${current.status}). Reload and try again.`,
      );
    }
    return this.getIntroOrThrow(workspaceId, intro.id);
  }

  /**
   * Expiry enforced at action time, not only by the cron sweep: a proposal
   * past its window is flipped to expired (guarded) and the action refused.
   */
  private async expireIfPastWindow(workspaceId: string, intro: IntroductionRow, now: Date): Promise<void> {
    if (intro.status !== "proposed" || !isIntroExpired(intro.createdAt, now, DEFAULT_INTRO_EXPIRY_DAYS)) return;
    const res = await this.prisma.connectorIntroduction.updateMany({
      where: { id: intro.id, workspaceId, status: "proposed" },
      data: { status: "expired", expiredAt: now },
    });
    if (res.count === 1) {
      await this.recordEvent(
        workspaceId,
        intro.id,
        "expired",
        "system",
        "action-time-expiry",
        `Proposal expired after ${DEFAULT_INTRO_EXPIRY_DAYS} days without resolution (caught when acted on).`,
      );
    }
    throw new ConnectorError(
      "intro_expired",
      `This introduction proposal expired after ${DEFAULT_INTRO_EXPIRY_DAYS} days. Propose it again if it is still wanted.`,
    );
  }

  private async recordEvent(
    workspaceId: string,
    introductionId: string,
    kind: ConnectorIntroAuditKind,
    actorKind: ConnectorIntroActorKind,
    actorIdentity: string,
    message: string | null,
  ): Promise<void> {
    await this.prisma.connectorIntroductionEvent.create({
      data: {
        workspaceId,
        introductionId,
        kind,
        actorKind,
        actorIdentity,
        message,
      },
    });
  }

  // ------------------------------------------------------------------
  // propose_intro — agent drafts; nothing sends. Lands in the approval
  // inbox. Enforces the per-mutual rate limit and the one-active-per-pair
  // rule.
  // ------------------------------------------------------------------

  async proposeIntroduction(
    workspaceId: string,
    input: ProposeIntroductionInput,
    opts: {
      /** Who proposed: agent identity (e.g. "connector-agent") or a human. */
      proposedBy: string;
      proposerKind: "agent" | "tenant";
      now?: Date;
    },
  ): Promise<ConnectorIntroductionView> {
    const now = opts.now ?? new Date();
    const { errors, value } = validateProposeIntroductionInput(input);
    if (!value) {
      throw new ConnectorError("invalid_introduction", errors.join(" "));
    }

    const [personA, personB, fundingInvestor] = await Promise.all([
      this.prisma.connectorPerson.findFirst({
        where: { id: value.personAId, workspaceId },
        include: { relationship: { select: { boundaries: true } } },
      }),
      this.prisma.connectorPerson.findFirst({
        where: { id: value.personBId, workspaceId },
        select: { id: true, name: true },
      }),
      // Slice 5: the linked investor must belong to this workspace.
      // Tenant isolation is enforced here, not trusted from the request.
      value.fundingInvestorId
        ? this.prisma.fundingInvestor.findFirst({
            where: { id: value.fundingInvestorId, workspaceId },
            select: { id: true, name: true, firm: true },
          })
        : Promise.resolve(null),
    ]);
    if (!personA || !personB) {
      throw new ConnectorError(
        "person_not_found",
        "Both sides of the introduction must be people in this workspace.",
      );
    }
    if (value.fundingInvestorId && !fundingInvestor) {
      throw new ConnectorError(
        "funding_investor_not_found",
        "The linked funding investor was not found in this workspace.",
      );
    }

    // The path snapshot must actually be the path between these two
    // people: the mutual is side A, the target is side B.
    const snap = value.introPath as {
      mutual?: { id?: string };
      target?: { id?: string };
    };
    if (snap.mutual?.id !== value.personAId || snap.target?.id !== value.personBId) {
      throw new ConnectorError(
        "intro_path_mismatch",
        "The IntroPath snapshot must link personA (mutual) → personB (target).",
      );
    }

    // Rate limit: max one intro ask per mutual per window. Boundaries are
    // honored; a tenant override (per instance) replaces the parsed window.
    const window = value.rateLimitOverride ?? introAskWindow(personA.relationship?.boundaries ?? null);
    if ("blocked" in window) {
      throw new ConnectorError(
        "intro_blocked_by_boundaries",
        `${personA.name}'s boundaries block intro asks entirely.`,
      );
    }
    const windowStart = new Date(now.getTime() - window.windowDays * DAY_MS);
    const recentAsks = await this.prisma.connectorIntroduction.count({
      where: {
        workspaceId,
        personAId: value.personAId,
        createdAt: { gte: windowStart },
      },
    });
    if (recentAsks >= window.maxAsks) {
      throw new ConnectorError(
        "intro_rate_limited",
        `Rate limit: at most ${window.maxAsks} intro ask(s) to ${personA.name} per ${window.windowDays} days. Last ${window.windowDays}-day asks: ${recentAsks}.`,
      );
    }

    let row: IntroductionRow;

    // Slice 5: data-room offer — mint a REAL share link and append the
    // offer line to the draft offer message. The draft is still
    // tenant-approved before anything sends (the money rule holds), and
    // the link URL is the actual token URL, never a placeholder.
    let draftOfferMessage = value.draftOfferMessage;
    let dataRoomShareLinkId: string | null = null;
    if (value.dataRoomOffer) {
      const offer = await attachDataRoomOffer(this.prisma, workspaceId, {
        docId: value.dataRoomOffer.docId,
        expiresInDays: value.dataRoomOffer.expiresInDays,
        viewerEmails: value.dataRoomOffer.viewerEmails,
      });
      dataRoomShareLinkId = offer.shareLinkId;
      draftOfferMessage = `${draftOfferMessage}\n\n${buildDataRoomOfferLine(offer)}`;
    }

    try {
      row = (await this.prisma.connectorIntroduction.create({
        data: {
          workspaceId,
          personAId: value.personAId,
          personBId: value.personBId,
          mode: value.mode,
          fundingInvestorId: value.fundingInvestorId,
          dataRoomShareLinkId,
          introPathSnapshot: value.introPath as Prisma.InputJsonValue,
          draftAskMessage: value.draftAskMessage,
          draftOfferMessage,
          rateLimitOverrideMaxAsks: value.rateLimitOverride?.maxAsks ?? null,
          rateLimitOverrideWindowDays: value.rateLimitOverride?.windowDays ?? null,
        },
        include: {
          ...INTRO_INCLUDES,
        },
      })) as IntroductionRow;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        throw new ConnectorError(
          "intro_already_active",
          "An active introduction already exists for this pair. Withdraw, decline, or expire it before proposing again — no campaigns, no bulk.",
        );
      }
      throw e;
    }

    await this.recordEvent(
      workspaceId,
      row.id,
      "proposed",
      opts.proposerKind,
      opts.proposedBy,
      `Proposed intro [mode: ${value.mode}]: ${personA.name} (side A, the ask) → ${personB.name} (side B, the offer).${value.fundingInvestorId && fundingInvestor ? ` Linked investor: ${fundingInvestor.name}${fundingInvestor.firm ? ` (${fundingInvestor.firm})` : ""}.` : ""}${dataRoomShareLinkId ? " Data-room offer attached." : ""} Draft ask: ${value.draftAskMessage}`,
    );
    // Phase 3 (J): best-effort "needs you" notification (never throws).
    await notifyApprovalNeeded({
      workspaceId,
      source: "intro",
      sourceId: row.id,
      title: `Ask ${personA.name} to introduce ${personB.name}`,
      href: "/dashboard/connector",
      requestedBy: opts.proposedBy,
    });
    return toIntroductionView(row);
  }

  // ------------------------------------------------------------------
  // Tenant approval gate (v1: every draft is tenant-approved). Approval
  // sends the ask to side A via the tenant's connected messaging account —
  // recorded as an auditable event. Decline kills the proposal.
  // ------------------------------------------------------------------

  async approveByTenant(
    workspaceId: string,
    introId: string,
    opts: { approvedBy: string; sentVia: string },
  ): Promise<ConnectorIntroductionView> {
    const intro = await this.getIntroOrThrow(workspaceId, introId);
    assertIntroTransition(intro.status, "tenant_approve");
    const now = new Date();
    await this.expireIfPastWindow(workspaceId, intro, now);
    if (intro.tenantApproved) {
      throw new ConnectorError("already_approved", "This introduction was already approved.");
    }
    const approvedBy = requireHumanActor({ kind: "human", identity: opts.approvedBy }, "tenant_approve");
    const sentVia = opts.sentVia.trim();
    if (!sentVia) {
      throw new ConnectorError(
        "invalid_send_channel",
        "sentVia is required — the ask sends via the tenant's connected messaging account.",
      );
    }

    const updated = await this.transition(workspaceId, intro, { tenantApproved: false, createdAt: { gt: expiryCutoff(now) } }, {
        tenantApproved: true,
        tenantApprovedBy: approvedBy,
        tenantApprovedAt: now,
    });

    await this.recordEvent(
      workspaceId,
      introId,
      "tenant_approved",
      "tenant",
      approvedBy,
      `Tenant approved the draft ask. Draft: ${intro.draftAskMessage}`,
    );
    await this.recordEvent(
      workspaceId,
      introId,
      "ask_sent_to_side_a",
      "tenant",
      `${approvedBy} via ${sentVia}`,
      `Ask sent to ${intro.personA.name} (side A): ${intro.draftAskMessage}`,
    );
    return toIntroductionView(updated);
  }

  async declineByTenant(
    workspaceId: string,
    introId: string,
    opts: { declinedBy: string; reason?: string },
  ): Promise<ConnectorIntroductionView> {
    const intro = await this.getIntroOrThrow(workspaceId, introId);
    assertIntroTransition(intro.status, "tenant_decline");
    if (intro.tenantApproved) {
      throw new ConnectorError(
        "decline_after_approval",
        "The ask was already approved and sent — use withdraw to pull it back.",
      );
    }
    const declinedBy = requireHumanActor({ kind: "human", identity: opts.declinedBy }, "tenant_decline");
    const reason = typeof opts.reason === "string" && opts.reason.trim() ? opts.reason.trim() : null;
    const now = new Date();

    const updated = await this.transition(workspaceId, intro, { tenantApproved: false }, {
        status: "declined",
        declinedBy,
        declinedAt: now,
        declineReason: reason,
    });

    await this.recordEvent(
      workspaceId,
      introId,
      "tenant_declined",
      "tenant",
      declinedBy,
      reason ?? "Tenant declined the proposal.",
    );
    return toIntroductionView(updated);
  }

  // ------------------------------------------------------------------
  // Side A: the mutual accepts/declines THE ASK. Human-only. Requires
  // tenant approval first. Accepting sends the offer to side B (recorded).
  // ------------------------------------------------------------------

  async acceptSideA(
    workspaceId: string,
    introId: string,
    actor: IntroActor,
    opts: { sentVia: string; note?: string },
  ): Promise<ConnectorIntroductionView> {
    const intro = await this.getIntroOrThrow(workspaceId, introId);
    assertIntroTransition(intro.status, "side_a_accept");
    assertIntroPreconditions({
      event: "side_a_accept",
      tenantApproved: intro.tenantApproved,
      pendingFollowupDraft: false,
    });
    const identity = requireHumanActor(actor, "side_a_accept");
    const sentVia = opts.sentVia.trim();
    if (!sentVia) {
      throw new ConnectorError(
        "invalid_send_channel",
        "sentVia is required — the offer sends via the tenant's connected messaging account.",
      );
    }
    const now = new Date();
    await this.expireIfPastWindow(workspaceId, intro, now);

    const updated = await this.transition(workspaceId, intro, { tenantApproved: true, createdAt: { gt: expiryCutoff(now) } }, {
        status: "side_a_accepted",
        sideAAcceptedBy: identity,
        sideAAcceptedAt: now,
    });

    const note = typeof opts.note === "string" && opts.note.trim() ? ` Note: ${opts.note.trim()}` : "";
    await this.recordEvent(
      workspaceId,
      introId,
      "side_a_accepted",
      "side_a",
      identity,
      `${intro.personA.name} accepted the ask.${note}`,
    );
    await this.recordEvent(
      workspaceId,
      introId,
      "offer_sent_to_side_b",
      "tenant",
      `tenant via ${sentVia}`,
      `Offer sent to ${intro.personB.name} (side B): ${intro.draftOfferMessage}`,
    );
    return toIntroductionView(updated);
  }

  async declineSideA(
    workspaceId: string,
    introId: string,
    actor: IntroActor,
    opts: { note?: string } = {},
  ): Promise<ConnectorIntroductionView> {
    const intro = await this.getIntroOrThrow(workspaceId, introId);
    assertIntroTransition(intro.status, "side_a_decline");
    assertIntroPreconditions({
      event: "side_a_decline",
      tenantApproved: intro.tenantApproved,
      pendingFollowupDraft: false,
    });
    const identity = requireHumanActor(actor, "side_a_decline");
    const note = typeof opts.note === "string" && opts.note.trim() ? opts.note.trim() : null;
    const now = new Date();

    const updated = await this.transition(workspaceId, intro, { tenantApproved: true }, {
        status: "declined",
        sideAAcceptedBy: null,
        declinedBy: identity,
        declinedAt: now,
        declineReason: note ?? "Side A declined the ask.",
    });

    await this.recordEvent(
      workspaceId,
      introId,
      "side_a_declined",
      "side_a",
      identity,
      note ?? `${intro.personA.name} declined the ask.`,
    );
    return toIntroductionView(updated);
  }

  // ------------------------------------------------------------------
  // Side B: the target accepts/declines THE OFFER. Human-only. Only
  // reachable after side A accepted.
  // ------------------------------------------------------------------

  async acceptSideB(
    workspaceId: string,
    introId: string,
    actor: IntroActor,
    opts: { note?: string } = {},
  ): Promise<ConnectorIntroductionView> {
    const intro = await this.getIntroOrThrow(workspaceId, introId);
    assertIntroTransition(intro.status, "side_b_accept");
    const identity = requireHumanActor(actor, "side_b_accept");
    const now = new Date();

    const updated = await this.transition(workspaceId, intro, {}, {
        status: "side_b_accepted",
        sideBAcceptedBy: identity,
        sideBAcceptedAt: now,
    });

    const note = typeof opts.note === "string" && opts.note.trim() ? ` Note: ${opts.note.trim()}` : "";
    await this.recordEvent(
      workspaceId,
      introId,
      "side_b_accepted",
      "side_b",
      identity,
      `${intro.personB.name} accepted the offer.${note}`,
    );
    return toIntroductionView(updated);
  }

  async declineSideB(
    workspaceId: string,
    introId: string,
    actor: IntroActor,
    opts: { note?: string } = {},
  ): Promise<ConnectorIntroductionView> {
    const intro = await this.getIntroOrThrow(workspaceId, introId);
    assertIntroTransition(intro.status, "side_b_decline");
    const identity = requireHumanActor(actor, "side_b_decline");
    const note = typeof opts.note === "string" && opts.note.trim() ? opts.note.trim() : null;
    const now = new Date();

    const updated = await this.transition(workspaceId, intro, {}, {
        status: "declined",
        declinedBy: identity,
        declinedAt: now,
        declineReason: note ?? "Side B declined the offer.",
    });

    await this.recordEvent(
      workspaceId,
      introId,
      "side_b_declined",
      "side_b",
      identity,
      note ?? `${intro.personB.name} declined the offer.`,
    );
    return toIntroductionView(updated);
  }

  // ------------------------------------------------------------------
  // make_intro — THE MONEY RULE. Executes ONLY when both acceptances are
  // recorded on the Introduction object (status side_b_accepted). Sends
  // the intro via the tenant's connected messaging account; the send is
  // an auditable event with the exact message that went out.
  // ------------------------------------------------------------------

  async makeIntro(
    workspaceId: string,
    introId: string,
    input: IntroSendInput & { sentBy: string },
  ): Promise<ConnectorIntroductionView> {
    const intro = await this.getIntroOrThrow(workspaceId, introId);
    assertIntroTransition(intro.status, "make");
    const { errors, value } = validateIntroSendInput(input);
    if (!value) {
      throw new ConnectorError("invalid_send", errors.join(" "));
    }
    const sentBy = requireHumanActor(
      { kind: "human", identity: input.sentBy },
      "make_intro",
    );
    const now = new Date();

    const updated = await this.transition(workspaceId, intro, {}, {
        status: "made",
        madeMessage: value.message,
        madeSentVia: value.sentVia,
        madeSentBy: sentBy,
        madeSentAt: now,
    });

    await this.recordEvent(
      workspaceId,
      introId,
      "intro_sent",
      "tenant",
      `${sentBy} via ${value.sentVia}`,
      `Intro made: ${intro.personA.name} ↔ ${intro.personB.name}. Message: ${value.message}`,
    );

    // Slice 5: raise-workflow writeback. Only fires for FUNDING-mode
    // intros linked to a FundingInvestor — and only here, after the
    // money rule has fired. Best-effort: a writeback failure never
    // unmakes a completed intro; the failure is recorded as lineage.
    if (intro.mode === "funding" && intro.fundingInvestorId) {
      try {
        const result = await writebackIntroductionMade(this.prisma, workspaceId, introId, {
          sentBy,
          now,
        });
        if (result.written) {
          const investorName = intro.fundingInvestor?.name ?? intro.fundingInvestorId;
          await this.recordEvent(
            workspaceId,
            introId,
            "funding_writeback",
            "system",
            "connector-funding-plugin",
            `Raise workflow writeback: "intro" interaction logged on investor ${investorName} (interaction ${result.interactionId}).${result.stageAdvanced ? ` Stage: ${result.stageFrom} → ${result.stageTo}.` : ""}`,
          );
        }
      } catch (e) {
        await this.recordEvent(
          workspaceId,
          introId,
          "funding_writeback_failed",
          "system",
          "connector-funding-plugin",
          `Raise workflow writeback failed: ${e instanceof Error ? e.message : "unknown error"}. The intro itself is complete.`,
        );
      }
    }

    return toIntroductionView(updated);
  }

  // ------------------------------------------------------------------
  // Followup — the post-intro nudge. Only after made. Only once per
  // Introduction unless the tenant approves more (each followup is a
  // tenant-approved draft in v1). Never to a party that declined (declined
  // is terminal, so the transition table enforces it).
  // ------------------------------------------------------------------

  async proposeFollowup(
    workspaceId: string,
    introId: string,
    input: FollowupInput,
    opts: { proposedBy: string },
  ): Promise<ConnectorIntroductionView> {
    const intro = await this.getIntroOrThrow(workspaceId, introId);
    assertIntroTransition(intro.status, "followup_propose");
    assertIntroPreconditions({
      event: "followup_propose",
      tenantApproved: intro.tenantApproved,
      pendingFollowupDraft: intro.pendingFollowupDraft != null,
    });
    const { errors, value } = validateFollowupInput(input);
    if (!value) {
      throw new ConnectorError("invalid_followup", errors.join(" "));
    }

    const updated = await this.transition(workspaceId, intro, { pendingFollowupDraft: null }, {
        pendingFollowupDraft: value.draft,
        pendingFollowupTo: value.to,
    });

    await this.recordEvent(
      workspaceId,
      introId,
      "followup_proposed",
      "agent",
      opts.proposedBy,
      `Followup draft (to ${value.to}): ${value.draft}`,
    );
    return toIntroductionView(updated);
  }

  async approveFollowup(
    workspaceId: string,
    introId: string,
    opts: { approvedBy: string; sentVia: string },
  ): Promise<ConnectorIntroductionView> {
    const intro = await this.getIntroOrThrow(workspaceId, introId);
    assertIntroTransition(intro.status, "followup_approve");
    assertIntroPreconditions({
      event: "followup_approve",
      tenantApproved: intro.tenantApproved,
      pendingFollowupDraft: intro.pendingFollowupDraft != null,
    });
    const approvedBy = requireHumanActor({ kind: "human", identity: opts.approvedBy }, "followup_approve");
    const sentVia = opts.sentVia.trim();
    if (!sentVia) {
      throw new ConnectorError(
        "invalid_send_channel",
        "sentVia is required — the followup sends via the tenant's connected messaging account.",
      );
    }
    const draft = intro.pendingFollowupDraft as string;
    const to = intro.pendingFollowupTo as string;
    const recipients =
      to === "side_a"
        ? intro.personA.name
        : to === "side_b"
          ? intro.personB.name
          : `${intro.personA.name} and ${intro.personB.name}`;

    const updated = await this.transition(workspaceId, intro, { followupCount: intro.followupCount, pendingFollowupDraft: draft }, {
        status: "followed_up",
        followupCount: intro.followupCount + 1,
        pendingFollowupDraft: null,
        pendingFollowupTo: null,
    });

    await this.recordEvent(
      workspaceId,
      introId,
      "followup_sent",
      "tenant",
      `${approvedBy} via ${sentVia}`,
      `Followup #${intro.followupCount + 1} sent to ${recipients}: ${draft}`,
    );
    return toIntroductionView(updated);
  }

  // ------------------------------------------------------------------
  // Withdraw — the tenant pulls an in-flight intro. Any non-terminal.
  // ------------------------------------------------------------------

  async withdrawIntroduction(
    workspaceId: string,
    introId: string,
    opts: { withdrawnBy: string },
  ): Promise<ConnectorIntroductionView> {
    const intro = await this.getIntroOrThrow(workspaceId, introId);
    assertIntroTransition(intro.status, "withdraw");
    const withdrawnBy = requireHumanActor({ kind: "human", identity: opts.withdrawnBy }, "withdraw");
    const now = new Date();

    const updated = await this.transition(workspaceId, intro, {}, {
        status: "withdrawn",
        withdrawnBy,
        withdrawnAt: now,
    });

    await this.recordEvent(
      workspaceId,
      introId,
      "withdrawn",
      "tenant",
      withdrawnBy,
      `Tenant withdrew the introduction (was ${intro.status}).`,
    );
    return toIntroductionView(updated);
  }

  // ------------------------------------------------------------------
  // Expiry sweep — unanswered proposals past their window move to
  // expired (terminal). Only the proposed state expires.
  // ------------------------------------------------------------------

  async sweepExpiredIntroductions(
    workspaceId: string,
    opts: { expiryDays?: number; now?: Date } = {},
  ): Promise<{ expired: number; ids: string[] }> {
    const expiryDays = opts.expiryDays ?? DEFAULT_INTRO_EXPIRY_DAYS;
    const now = opts.now ?? new Date();
    const candidates = await this.prisma.connectorIntroduction.findMany({
      where: { workspaceId, status: "proposed" },
      select: { id: true, createdAt: true },
    });
    const expiredIds = candidates
      .filter((c) => isIntroExpired(c.createdAt, now, expiryDays))
      .map((c) => c.id);

    const swept: string[] = [];
    for (const id of expiredIds) {
      // Guarded: an intro accepted/approved since the read is never expired.
      const res = await this.prisma.connectorIntroduction.updateMany({
        where: { id, workspaceId, status: "proposed" },
        data: { status: "expired", expiredAt: now },
      });
      if (res.count !== 1) continue;
      swept.push(id);
      await this.recordEvent(
        workspaceId,
        id,
        "expired",
        "system",
        "expiry-sweep",
        `Proposal expired after ${expiryDays} days without resolution.`,
      );
    }
    return { expired: swept.length, ids: swept };
  }
}
