// Marketr — Connector Agent slice 4 API: shared action handlers.
// The governed verbs of the double-opt-in lifecycle. Each Next.js route.ts
// re-exports one of these as POST. accept/decline are human-only (the
// store rejects agent actors); make_intro is legal only from
// side_b_accepted.

import { guardWorkspace, httpErrorResponse, readJson } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaIntroductionStore } from "@/lib/connector/introduction-store";
import { ConnectorError } from "@/lib/connector/types";
import type { IntroActor } from "@/lib/connector/introductions";
import { introErrorResponse } from "./intro-error";

function actorOf(body: { actor?: unknown }, fallbackIdentity: string): IntroActor {
  const a = body.actor as { kind?: unknown; identity?: unknown } | undefined;
  if (a && a.kind === "human") {
    return { kind: "human", identity: typeof a.identity === "string" ? a.identity : "" };
  }
  if (a && a.kind === "agent") {
    return { kind: "agent", identity: typeof a.identity === "string" ? a.identity : undefined };
  }
  return { kind: "human", identity: fallbackIdentity };
}

function sentViaOf(body: { sentVia?: unknown }): string {
  return typeof body.sentVia === "string" ? body.sentVia : "";
}

function noteOf(body: { note?: unknown }): string | undefined {
  return typeof body.note === "string" && body.note.trim() ? body.note.trim() : undefined;
}

function store() {
  return new PrismaIntroductionStore(prisma);
}

/** The tenant approves the draft; the ask to side A is sent (sentVia) and recorded. */
export async function handleApprove(req: Request, id: string) {
  try {
    const { workspace, user } = await guardWorkspace({ editor: true });
    const body = (await readJson(req)) as { sentVia?: unknown };
    const intro = await store().approveByTenant(workspace.id, id, {
      approvedBy: user.email ?? user.id,
      sentVia: sentViaOf(body),
    });
    return Response.json(intro);
  } catch (e) {
    if (e instanceof ConnectorError) return introErrorResponse(e);
    return httpErrorResponse(e);
  }
}

/** The tenant declines the proposal (before approval; after that: withdraw). */
export async function handleDecline(req: Request, id: string) {
  try {
    const { workspace, user } = await guardWorkspace({ editor: true });
    const body = (await readJson(req)) as { reason?: unknown };
    const intro = await store().declineByTenant(workspace.id, id, {
      declinedBy: user.email ?? user.id,
      reason: typeof body.reason === "string" ? body.reason : undefined,
    });
    return Response.json(intro);
  } catch (e) {
    if (e instanceof ConnectorError) return introErrorResponse(e);
    return httpErrorResponse(e);
  }
}

/** Side A (the mutual) accepts the ASK. Human-only. The offer to side B is sent (sentVia). */
export async function handleAcceptA(req: Request, id: string) {
  try {
    const { workspace, user } = await guardWorkspace({ editor: true });
    const body = (await readJson(req)) as { actor?: unknown; sentVia?: unknown; note?: unknown };
    const intro = await store().acceptSideA(
      workspace.id,
      id,
      actorOf(body, user.email ?? user.id),
      { sentVia: sentViaOf(body), note: noteOf(body) },
    );
    return Response.json(intro);
  } catch (e) {
    if (e instanceof ConnectorError) return introErrorResponse(e);
    return httpErrorResponse(e);
  }
}

/** Side A declines the ask. Human-only. */
export async function handleDeclineA(req: Request, id: string) {
  try {
    const { workspace, user } = await guardWorkspace({ editor: true });
    const body = (await readJson(req)) as { actor?: unknown; note?: unknown };
    const intro = await store().declineSideA(workspace.id, id, actorOf(body, user.email ?? user.id), {
      note: noteOf(body),
    });
    return Response.json(intro);
  } catch (e) {
    if (e instanceof ConnectorError) return introErrorResponse(e);
    return httpErrorResponse(e);
  }
}

/** Side B (the target) accepts the OFFER. Human-only. Only after side A accepted. */
export async function handleAcceptB(req: Request, id: string) {
  try {
    const { workspace, user } = await guardWorkspace({ editor: true });
    const body = (await readJson(req)) as { actor?: unknown; note?: unknown };
    const intro = await store().acceptSideB(workspace.id, id, actorOf(body, user.email ?? user.id), {
      note: noteOf(body),
    });
    return Response.json(intro);
  } catch (e) {
    if (e instanceof ConnectorError) return introErrorResponse(e);
    return httpErrorResponse(e);
  }
}

/** Side B declines the offer. Human-only. */
export async function handleDeclineB(req: Request, id: string) {
  try {
    const { workspace, user } = await guardWorkspace({ editor: true });
    const body = (await readJson(req)) as { actor?: unknown; note?: unknown };
    const intro = await store().declineSideB(workspace.id, id, actorOf(body, user.email ?? user.id), {
      note: noteOf(body),
    });
    return Response.json(intro);
  } catch (e) {
    if (e instanceof ConnectorError) return introErrorResponse(e);
    return httpErrorResponse(e);
  }
}

/**
 * Make the intro. THE MONEY RULE: legal only when both acceptances are
 * recorded (side_b_accepted). Sends via the tenant's connected messaging
 * account; the send is an auditable event with the exact message.
 */
export async function handleMake(req: Request, id: string) {
  try {
    const { workspace, user } = await guardWorkspace({ editor: true });
    const body = (await readJson(req)) as { message?: unknown; sentVia?: unknown };
    const intro = await store().makeIntro(workspace.id, id, {
      message: body.message,
      sentVia: sentViaOf(body),
      sentBy: user.email ?? user.id,
    });
    return Response.json(intro);
  } catch (e) {
    if (e instanceof ConnectorError) return introErrorResponse(e);
    return httpErrorResponse(e);
  }
}

/** Propose a followup draft (editor). Only after made. */
export async function handleFollowupPropose(req: Request, id: string) {
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    const body = (await readJson(req)) as { draft?: unknown; to?: unknown };
    const intro = await store().proposeFollowup(
      workspace.id,
      id,
      { draft: body.draft, to: body.to },
      { proposedBy: "connector-agent" },
    );
    return Response.json(intro);
  } catch (e) {
    if (e instanceof ConnectorError) return introErrorResponse(e);
    return httpErrorResponse(e);
  }
}

/** The tenant approves the followup draft; it sends and the intro moves to followed_up. */
export async function handleFollowupApprove(req: Request, id: string) {
  try {
    const { workspace, user } = await guardWorkspace({ editor: true });
    const body = (await readJson(req)) as { sentVia?: unknown };
    const intro = await store().approveFollowup(workspace.id, id, {
      approvedBy: user.email ?? user.id,
      sentVia: sentViaOf(body),
    });
    return Response.json(intro);
  } catch (e) {
    if (e instanceof ConnectorError) return introErrorResponse(e);
    return httpErrorResponse(e);
  }
}

/** The tenant pulls an in-flight intro. Any non-terminal state. */
export async function handleWithdraw(req: Request, id: string) {
  try {
    const { workspace, user } = await guardWorkspace({ editor: true });
    await readJson(req).catch(() => ({}));
    const intro = await store().withdrawIntroduction(workspace.id, id, {
      withdrawnBy: user.email ?? user.id,
    });
    return Response.json(intro);
  } catch (e) {
    if (e instanceof ConnectorError) return introErrorResponse(e);
    return httpErrorResponse(e);
  }
}
