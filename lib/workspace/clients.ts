// ShapesOS — agency client records (Phase 3, workstream I).
//
// A Client is an agency's customer inside one workspace: a name, the email
// they sign in with to see their white-label reports, the access they get,
// and an optional report cadence. Brand kits, pipelines and reports point at
// it. Reads are any member; writes are admin+. Every write is audited in the
// workspace audit log. Deleting a client deletes its reports (Report.client
// cascades) and unlinks its brand kits and pipelines (SetNull), so the API
// asks for the client's name typed back.

import { Prisma, type ClientRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { BadRequestError, ConflictError, NotFoundError } from "@/lib/api/errors";

export const CLIENT_ROLES: ClientRole[] = ["viewer", "editor", "admin"];
export const REPORT_SCHEDULES = ["weekly", "monthly"] as const;

export interface ClientInput {
  name: string;
  loginEmail: string;
  viewerRole: ClientRole;
  reportSchedule: string | null;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Validate a create (all fields) or a patch (partial: only what's present). */
export function parseClientInput(input: unknown, partial: false): ClientInput;
export function parseClientInput(input: unknown, partial: true): Partial<ClientInput>;
export function parseClientInput(input: unknown, partial: boolean): Partial<ClientInput> {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const out: Partial<ClientInput> = {};
  if (!partial || o.name !== undefined) {
    const name = typeof o.name === "string" ? o.name.replace(/\s+/g, " ").trim() : "";
    if (!name) throw new BadRequestError("Give the client a name.");
    if (name.length > 120) throw new BadRequestError("Keep the client name under 120 characters.");
    out.name = name;
  }
  if (!partial || o.loginEmail !== undefined) {
    const email = typeof o.loginEmail === "string" ? o.loginEmail.trim().toLowerCase() : "";
    if (!EMAIL.test(email) || email.length > 254) throw new BadRequestError("Enter the email the client signs in with.");
    out.loginEmail = email;
  }
  if (!partial || o.viewerRole !== undefined) {
    const role = o.viewerRole ?? "viewer";
    if (!CLIENT_ROLES.includes(role as ClientRole)) throw new BadRequestError("Access must be viewer, editor or admin.");
    out.viewerRole = role as ClientRole;
  }
  if (!partial || o.reportSchedule !== undefined) {
    const s = o.reportSchedule;
    if (s === null || s === undefined || s === "") out.reportSchedule = null;
    else if ((REPORT_SCHEDULES as readonly unknown[]).includes(s)) out.reportSchedule = s as string;
    else throw new BadRequestError("Report schedule must be weekly, monthly, or none.");
  }
  return out;
}

function isUnique(err: unknown) {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

async function audit(workspaceId: string, actorUserId: string, action: "client_created" | "client_updated" | "client_deleted", summary: string) {
  await prisma.fileChangeLog.create({
    data: { workspaceId, filePath: "(workspace)", actor: "user", action, summary, approvedBy: actorUserId },
  });
}

export async function listClients(workspaceId: string) {
  const rows = await prisma.client.findMany({
    where: { workspaceId },
    orderBy: { name: "asc" },
    include: { _count: { select: { reports: true, brandKits: true, pipelines: true } } },
  });
  return rows.map((c) => ({
    id: c.id,
    name: c.name,
    loginEmail: c.loginEmail,
    viewerRole: c.viewerRole,
    reportSchedule: c.reportSchedule,
    reports: c._count.reports,
    brandKits: c._count.brandKits,
    pipelines: c._count.pipelines,
    createdAt: c.createdAt.toISOString(),
  }));
}

export async function createClient(workspaceId: string, actorUserId: string, input: unknown) {
  const data = parseClientInput(input, false);
  try {
    const c = await prisma.client.create({ data: { workspaceId, ...data } });
    await audit(workspaceId, actorUserId, "client_created", `Client "${c.name}" added (${c.loginEmail}, ${c.viewerRole})`);
    return c;
  } catch (err) {
    if (isUnique(err)) throw new ConflictError("A client with that sign-in email already exists.");
    throw err;
  }
}

export async function updateClient(workspaceId: string, actorUserId: string, clientId: string, input: unknown) {
  const data = parseClientInput(input, true);
  const existing = await prisma.client.findFirst({ where: { id: clientId, workspaceId } });
  if (!existing) throw new NotFoundError("Client not found.");
  try {
    const c = await prisma.client.update({ where: { id: existing.id }, data });
    const changed = Object.keys(data).join(", ") || "nothing";
    await audit(workspaceId, actorUserId, "client_updated", `Client "${c.name}" updated (${changed})`);
    return c;
  } catch (err) {
    if (isUnique(err)) throw new ConflictError("A client with that sign-in email already exists.");
    throw err;
  }
}

export async function deleteClient(workspaceId: string, actorUserId: string, clientId: string, confirmName: unknown) {
  const existing = await prisma.client.findFirst({
    where: { id: clientId, workspaceId },
    include: { _count: { select: { reports: true } } },
  });
  if (!existing) throw new NotFoundError("Client not found.");
  if (typeof confirmName !== "string" || confirmName.trim() !== existing.name) {
    throw new BadRequestError("Type the client's name exactly to confirm.");
  }
  await prisma.client.delete({ where: { id: existing.id } });
  await audit(
    workspaceId,
    actorUserId,
    "client_deleted",
    `Client "${existing.name}" deleted with ${existing._count.reports} report${existing._count.reports === 1 ? "" : "s"}`,
  );
  return { id: existing.id };
}
