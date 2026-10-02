// Marketr — Connector Agent slice 6 API: shared Boardy action handlers.
// The governed verbs of the escalation rail. Approve/decline/send/cancel
// are human-only (the store rejects agent actors); send is legal ONLY from
// "approved" (the approval gate — not_approved otherwise). Reply triage is
// legal only from "sent" and flags the thread as priority.
import { guardWorkspace, httpErrorResponse, readJson } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaBoardyRailStore } from "@/lib/connector/boardy-rail";
import { ConnectorError } from "@/lib/connector/types";
import type { IntroActor } from "@/lib/connector/introductions";
import { introErrorResponse } from "../intros/intro-error";

function store() {
  return new PrismaBoardyRailStore(prisma);
}

function humanOf(user: { email?: string | null; id?: string }): IntroActor {
  return { kind: "human", identity: user.email ?? user.id ?? "tenant" };
}

function strOf(body: Record<string, unknown>, key: string): string {
  return typeof body[key] === "string" ? (body[key] as string) : "";
}

/** The tenant approves the draft per instance (human-only). */
export async function handleBoardyApprove(req: Request, id: string) {
  try {
    const { workspace, user } = await guardWorkspace({ editor: true });
    await readJson(req).catch(() => ({}));
    const request = await store().approveBoardyRequest(workspace.id, id, {
      actor: humanOf(user),
    });
    return Response.json({ request });
  } catch (e) {
    if (e instanceof ConnectorError) return introErrorResponse(e);
    return httpErrorResponse(e);
  }
}

/** The tenant declines the draft (human-only). */
export async function handleBoardyDecline(req: Request, id: string) {
  try {
    const { workspace, user } = await guardWorkspace({ editor: true });
    const body = (await readJson(req)) as Record<string, unknown>;
    const request = await store().declineBoardyRequest(workspace.id, id, {
      actor: humanOf(user),
      reason: strOf(body, "reason") || undefined,
    });
    return Response.json({ request });
  } catch (e) {
    if (e instanceof ConnectorError) return introErrorResponse(e);
    return httpErrorResponse(e);
  }
}

/**
 * Send the approved request (human-only). The approval gate: throws
 * not_approved unless the tenant approved first. Sends from the tenant's
 * own address via their connected account (sentVia) to boardy@boardy.ai.
 */
export async function handleBoardySend(req: Request, id: string) {
  try {
    const { workspace, user } = await guardWorkspace({ editor: true });
    const body = (await readJson(req)) as Record<string, unknown>;
    const request = await store().sendBoardyRequest(workspace.id, id, {
      actor: humanOf(user),
      sentVia: strOf(body, "sentVia"),
    });
    return Response.json({ request });
  } catch (e) {
    if (e instanceof ConnectorError) return introErrorResponse(e);
    return httpErrorResponse(e);
  }
}

/** Cancel a draft or approved request (human-only). */
export async function handleBoardyCancel(req: Request, id: string) {
  try {
    const { workspace, user } = await guardWorkspace({ editor: true });
    const body = (await readJson(req)) as Record<string, unknown>;
    const request = await store().cancelBoardyRequest(workspace.id, id, {
      actor: humanOf(user),
      reason: strOf(body, "reason") || undefined,
    });
    return Response.json({ request });
  } catch (e) {
    if (e instanceof ConnectorError) return introErrorResponse(e);
    return httpErrorResponse(e);
  }
}

/** Triage Boardy's reply as a priority thread (legal only from sent). */
export async function handleBoardyReply(req: Request, id: string) {
  try {
    const { workspace, user } = await guardWorkspace({ editor: true });
    const body = (await readJson(req)) as Record<string, unknown>;
    const request = await store().markBoardyRequestReplied(workspace.id, id, {
      summary: strOf(body, "summary") || undefined,
      triagedBy: user.email ?? user.id ?? "tenant",
    });
    return Response.json({ request });
  } catch (e) {
    if (e instanceof ConnectorError) return introErrorResponse(e);
    return httpErrorResponse(e);
  }
}
