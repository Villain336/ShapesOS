// GET /api/connector/intros — list introductions (viewer role).
//   ?status=<status> — filter by lifecycle status.
//   ?mode=leads|funding — mode-scoped listing (slice 5).
//   ?inbox=1 — the approval inbox: proposed intros awaiting tenant approval.
// POST /api/connector/intros — propose an intro (editor role).
//   propose_intro is an agent action: it drafts the ask/offer copy, freezes
//   the IntroPath snapshot, enforces the per-mutual rate limit and the
//   one-active-per-pair rule. Slice 5: { mode, fundingInvestorId,
//   dataRoomOffer } — FUNDING-mode proposals link the investor CRM and may
//   mint a real data-room share link into the draft offer. Nothing sends —
//   the proposal lands in the tenant's approval inbox.
import { guardWorkspace, httpErrorResponse, readJson } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaIntroductionStore } from "@/lib/connector/introduction-store";
import { ConnectorError } from "@/lib/connector/types";
import { CONNECTOR_INTRO_STATUSES } from "@/lib/connector/introductions";
import { CONNECTOR_MODES, type ConnectorMode } from "@/lib/connector/modes";
import { introErrorResponse } from "./intro-error";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const { workspace } = await guardWorkspace();
    const url = new URL(req.url);
    const statusParam = url.searchParams.get("status");
    let status: (typeof CONNECTOR_INTRO_STATUSES)[number] | undefined;
    if (statusParam) {
      if (!(CONNECTOR_INTRO_STATUSES as readonly string[]).includes(statusParam)) {
        throw new ConnectorError("invalid_status", `status must be one of: ${CONNECTOR_INTRO_STATUSES.join(", ")}.`);
      }
      status = statusParam as (typeof CONNECTOR_INTRO_STATUSES)[number];
    }
    const store = new PrismaIntroductionStore(prisma);
    const modeParam = url.searchParams.get("mode");
    let mode: ConnectorMode | undefined;
    if (modeParam) {
      const m = modeParam.trim().toLowerCase();
      if (!(CONNECTOR_MODES as readonly string[]).includes(m)) {
        throw new ConnectorError("invalid_mode", `mode must be one of: ${CONNECTOR_MODES.join(", ")}.`);
      }
      mode = m as ConnectorMode;
    }
    const intros = await store.listIntroductions(workspace.id, {
      status,
      mode,
      awaitingApproval: url.searchParams.get("inbox") === "1",
    });
    return Response.json({ introductions: intros });
  } catch (e) {
    if (e instanceof ConnectorError) return introErrorResponse(e);
    return httpErrorResponse(e);
  }
}

export async function POST(req: Request) {
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    const body = (await readJson(req)) as {
      personAId?: unknown;
      personBId?: unknown;
      introPath?: unknown;
      draftAskMessage?: unknown;
      draftOfferMessage?: unknown;
      rateLimitOverride?: unknown;
      proposedBy?: unknown;
      // Slice 5: mode + funding plug-in.
      mode?: unknown;
      fundingInvestorId?: unknown;
      dataRoomOffer?: unknown;
    };
    const store = new PrismaIntroductionStore(prisma);
    const intro = await store.proposeIntroduction(
      workspace.id,
      {
        personAId: body.personAId,
        personBId: body.personBId,
        introPath: body.introPath,
        draftAskMessage: body.draftAskMessage,
        draftOfferMessage: body.draftOfferMessage,
        rateLimitOverride: body.rateLimitOverride,
        mode: body.mode,
        fundingInvestorId: body.fundingInvestorId,
        dataRoomOffer: body.dataRoomOffer,
      },
      {
        proposedBy:
          typeof body.proposedBy === "string" && body.proposedBy.trim()
            ? body.proposedBy.trim()
            : "connector-agent",
        proposerKind: "agent",
      },
    );
    return Response.json(intro, { status: 201 });
  } catch (e) {
    if (e instanceof ConnectorError) return introErrorResponse(e);
    return httpErrorResponse(e);
  }
}
