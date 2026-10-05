// ShapesOS — SCIM 2.0 Users and Groups over workspace memberships (Phase 4a;
// RFC 7643 resources, RFC 7644 operations).
//
// Mapping:
//   SCIM User   = a workspace_members row with an email (id = member id,
//                 userName = email). Created users are pending members
//                 (userId null) until the person signs in through the SSO
//                 provider with a verified matching email (lib/scim/link.ts)
//                 or claims an invite link.
//   active=false (deprovision): the member's userId is parked in
//                 scim_suspended_user_id and userId nulled — every access path
//                 keys on userId, so access ends at once; the resource stays
//                 for the IdP, and active=true restores it.
//   SCIM Group  = scim_groups row mapped to ONE workspace role (admin, editor
//                 or viewer — derived from the displayName). A member's role is
//                 the highest role among their groups (viewer with none).
//
// Guard rails:
//   - Owners are never changed by SCIM (no role change, deprovision or delete)
//     and SCIM never mints owners — the same stance as SSO auto-provisioning.
//   - Everything runs inside withWorkspaceScope(ctx.workspaceId) and every
//     workspace_members query filters on that workspace: an id from another
//     workspace is simply "not found".

import type { Prisma, WorkspaceMember, WorkspaceRole } from "@prisma/client";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { ROLE_RANK } from "@/lib/authz";
import {
  SCHEMA_GROUP,
  SCHEMA_USER,
  ScimError,
  listResponse,
  parseEqFilter,
  scimBool,
} from "./http";
import type { ScimContext } from "./auth";
import { checkSeatForNewMember, syncSeatsBestEffort } from "@/lib/billing/seats-server";
import { seatProvisioningRefusal } from "@/lib/billing/seats";

type Tx = Prisma.TransactionClient;

export const SCIM_DEFAULT_ROLE: WorkspaceRole = "viewer";
const SCIM_ROLES: WorkspaceRole[] = ["admin", "editor", "viewer"];
const MAX_NAME = 200;

interface ScimProfile {
  givenName?: string;
  familyName?: string;
  formatted?: string;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function str(v: unknown, max = MAX_NAME): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s ? s.slice(0, max) : undefined;
}

function normalizeEmail(v: string): string {
  return v.trim().toLowerCase();
}

function assertEmail(userName: string): string {
  const e = normalizeEmail(userName);
  if (e.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
    throw new ScimError(400, "userName must be the user's email address.", "invalidValue");
  }
  return e;
}

function location(base: string, kind: "Users" | "Groups", id: string): string {
  return `${base}/api/scim/v2/${kind}/${encodeURIComponent(id)}`;
}

/** Derive a group's workspace role from its name ("ShapesOS Admins" → admin). */
export function roleForGroupName(displayName: string): WorkspaceRole | null {
  const m = /\b(admin|editor|viewer)s?\b/i.exec(displayName);
  return m ? (m[1].toLowerCase() as WorkspaceRole) : null;
}

/** Highest role among the groups; viewer when in none. */
export function roleFromGroups(roles: WorkspaceRole[]): WorkspaceRole {
  let best: WorkspaceRole = SCIM_DEFAULT_ROLE;
  for (const r of roles) {
    if (r === "owner") continue;
    if (ROLE_RANK[r] > ROLE_RANK[best]) best = r;
  }
  return best;
}

async function ownerUserIdOf(tx: Tx, workspaceId: string): Promise<string | null> {
  const ws = await tx.workspace.findUnique({ where: { id: workspaceId }, select: { ownerUserId: true } });
  return ws?.ownerUserId ?? null;
}

/** Owners (by role, or the workspace's legacy owner subject) are off-limits to SCIM writes. */
async function assertMutable(tx: Tx, member: WorkspaceMember): Promise<void> {
  if (member.role === "owner") throw new ScimError(403, "Workspace owners can't be changed through SCIM.", "mutability");
  const owner = await ownerUserIdOf(tx, member.workspaceId);
  const subject = member.userId ?? member.scimSuspendedUserId;
  if (owner && subject && owner === subject) {
    throw new ScimError(403, "Workspace owners can't be changed through SCIM.", "mutability");
  }
}

async function findMember(tx: Tx, ctx: ScimContext, id: string): Promise<WorkspaceMember> {
  const m = await tx.workspaceMember.findFirst({ where: { id, workspaceId: ctx.workspaceId, email: { not: null } } });
  if (!m) throw new ScimError(404, `User ${id} not found.`);
  return m;
}

/** Set the member's role from their groups (owners untouched). */
async function recomputeRole(tx: Tx, workspaceId: string, memberId: string): Promise<void> {
  const member = await tx.workspaceMember.findFirst({ where: { id: memberId, workspaceId } });
  if (!member || member.role === "owner") return;
  const groups = await tx.scimGroupMember.findMany({
    where: { memberId, workspaceId },
    select: { group: { select: { role: true } } },
  });
  const role = roleFromGroups(groups.map((g) => g.group.role));
  if (role !== member.role) {
    await tx.workspaceMember.update({ where: { id: member.id, workspaceId }, data: { role } });
  }
}

async function audit(
  tx: Tx,
  workspaceId: string,
  action: "scim_user_provisioned" | "scim_user_updated" | "scim_user_deprovisioned" | "scim_user_deleted" | "scim_group_changed",
  summary: string,
): Promise<void> {
  await tx.fileChangeLog.create({
    data: { projectId: null, workspaceId, filePath: "(scim)", actor: "system", action, summary: summary.slice(0, 500) },
  });
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

type MemberWithGroups = WorkspaceMember & { scimGroups?: Array<{ group: { id: string; displayName: string } }> };

export function toScimUser(m: MemberWithGroups, base: string): Record<string, unknown> {
  const profile = (m.scimProfile ?? {}) as ScimProfile;
  const name: Record<string, string> = {};
  if (profile.givenName) name.givenName = profile.givenName;
  if (profile.familyName) name.familyName = profile.familyName;
  const formatted = profile.formatted ?? m.name ?? undefined;
  if (formatted) name.formatted = formatted;
  return {
    schemas: [SCHEMA_USER],
    id: m.id,
    ...(m.scimExternalId ? { externalId: m.scimExternalId } : {}),
    userName: m.email,
    ...(Object.keys(name).length ? { name } : {}),
    ...(m.name ? { displayName: m.name } : {}),
    emails: m.email ? [{ value: m.email, type: "work", primary: true }] : [],
    active: !m.scimDeactivatedAt,
    groups: (m.scimGroups ?? []).map((g) => ({
      value: g.group.id,
      display: g.group.displayName,
      $ref: location(base, "Groups", g.group.id),
    })),
    meta: {
      resourceType: "User",
      created: m.createdAt.toISOString(),
      lastModified: m.updatedAt.toISOString(),
      location: location(base, "Users", m.id),
    },
  };
}

const withGroups = { scimGroups: { select: { group: { select: { id: true, displayName: true } } } } } as const;

export async function listUsers(
  ctx: ScimContext,
  base: string,
  q: { filter: string | null; startIndex: number; count: number },
): Promise<Record<string, unknown>> {
  const f = parseEqFilter(q.filter, ["userName", "externalId", "emails.value"]);
  const where: Prisma.WorkspaceMemberWhereInput = { workspaceId: ctx.workspaceId, email: { not: null } };
  if (f?.attr === "userName" || f?.attr === "emails.value") where.email = { equals: normalizeEmail(f.value), mode: "insensitive" };
  if (f?.attr === "externalId") where.scimExternalId = f.value;
  return withWorkspaceScope(ctx.workspaceId, async (tx) => {
    const [total, rows] = await Promise.all([
      tx.workspaceMember.count({ where: { ...where, workspaceId: ctx.workspaceId } }),
      tx.workspaceMember.findMany({
        where: { ...where, workspaceId: ctx.workspaceId },
        orderBy: { createdAt: "asc" },
        skip: q.startIndex - 1,
        take: q.count,
        include: withGroups,
      }),
    ]);
    return listResponse(rows.map((r) => toScimUser(r, base)), total, q.startIndex);
  });
}

export async function getUser(ctx: ScimContext, base: string, id: string): Promise<Record<string, unknown>> {
  return withWorkspaceScope(ctx.workspaceId, async (tx) => {
    await findMember(tx, ctx, id);
    const m = await tx.workspaceMember.findFirstOrThrow({ where: { id, workspaceId: ctx.workspaceId }, include: withGroups });
    return toScimUser(m, base);
  });
}

interface UserAttrs {
  email?: string;
  displayName?: string | null;
  externalId?: string | null;
  profile?: ScimProfile;
  active?: boolean;
}

function userAttrsFrom(body: Record<string, unknown>, requireUserName: boolean): UserAttrs {
  const out: UserAttrs = {};
  const userName = str(body.userName, 320);
  if (userName) out.email = assertEmail(userName);
  else if (requireUserName) throw new ScimError(400, "userName is required.", "invalidValue");
  if ("displayName" in body) out.displayName = str(body.displayName) ?? null;
  if ("externalId" in body) out.externalId = str(body.externalId, 255) ?? null;
  if (body.name && typeof body.name === "object") {
    const n = body.name as Record<string, unknown>;
    out.profile = { givenName: str(n.givenName), familyName: str(n.familyName), formatted: str(n.formatted) };
  }
  if ("active" in body) {
    const a = scimBool(body.active);
    if (a === undefined) throw new ScimError(400, "active must be a boolean.", "invalidValue");
    out.active = a;
  }
  return out;
}

function displayNameOf(attrs: UserAttrs): string | null | undefined {
  if (attrs.displayName !== undefined) return attrs.displayName;
  const p = attrs.profile;
  if (!p) return undefined;
  return p.formatted ?? ([p.givenName, p.familyName].filter(Boolean).join(" ") || null);
}

/** Apply active=true/false transitions (deprovision parks the userId). */
function activeTransition(member: WorkspaceMember, active: boolean | undefined, now: Date): Prisma.WorkspaceMemberUpdateInput {
  if (active === false && !member.scimDeactivatedAt) {
    return {
      scimDeactivatedAt: now,
      scimSuspendedUserId: member.userId ?? member.scimSuspendedUserId,
      userId: null,
      inviteToken: null,
      inviteExpiresAt: null,
    };
  }
  if (active === true && member.scimDeactivatedAt) {
    return { scimDeactivatedAt: null, scimSuspendedUserId: null, userId: member.scimSuspendedUserId };
  }
  return {};
}

async function applyUserUpdate(tx: Tx, ctx: ScimContext, member: WorkspaceMember, attrs: UserAttrs): Promise<void> {
  await assertMutable(tx, member);
  if (attrs.email && attrs.email !== (member.email ?? "").toLowerCase()) {
    const clash = await tx.workspaceMember.findFirst({
      where: { workspaceId: ctx.workspaceId, email: { equals: attrs.email, mode: "insensitive" }, id: { not: member.id } },
      select: { id: true },
    });
    if (clash) throw new ScimError(409, "Another user in this workspace has that userName.", "uniqueness");
  }
  // Reactivation must not collide with a membership the person got meanwhile.
  if (attrs.active === true && member.scimDeactivatedAt && member.scimSuspendedUserId) {
    const other = await tx.workspaceMember.findFirst({
      where: { workspaceId: ctx.workspaceId, userId: member.scimSuspendedUserId },
      select: { id: true },
    });
    if (other) throw new ScimError(409, "That person already has another membership in this workspace.", "uniqueness");
  }
  const now = new Date();
  const name = displayNameOf(attrs);
  const data: Prisma.WorkspaceMemberUpdateInput = {
    scimManaged: true,
    ...(attrs.email ? { email: attrs.email } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(attrs.externalId !== undefined ? { scimExternalId: attrs.externalId } : {}),
    ...(attrs.profile ? { scimProfile: attrs.profile as Prisma.InputJsonValue } : {}),
    ...activeTransition(member, attrs.active, now),
  };
  await tx.workspaceMember.update({ where: { id: member.id, workspaceId: ctx.workspaceId }, data });
  const label = attrs.email ?? member.email ?? member.id;
  if (attrs.active === false && !member.scimDeactivatedAt) {
    await audit(tx, ctx.workspaceId, "scim_user_deprovisioned", `SCIM deprovisioned ${label}`);
  } else {
    await audit(tx, ctx.workspaceId, "scim_user_updated", `SCIM updated ${label}${attrs.active === true && member.scimDeactivatedAt ? " (reactivated)" : ""}`);
  }
}

export async function createUser(ctx: ScimContext, base: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const attrs = userAttrsFrom(body, true);
  // Phase 15.3 (pricing): an identity provider can't confirm a seat charge.
  // Within the included seats (or extra seats an admin already approved) the
  // user is provisioned; past them SCIM is refused (403) — never charged.
  const seat = await checkSeatForNewMember(ctx.workspaceId, { confirmed: false });
  const refusal = seatProvisioningRefusal(seat);
  if (refusal) throw new ScimError(403, refusal);
  const created = await withWorkspaceScope(ctx.workspaceId, async (tx) => {
    const existing = await tx.workspaceMember.findFirst({
      where: { workspaceId: ctx.workspaceId, email: { equals: attrs.email!, mode: "insensitive" } },
      select: { id: true },
    });
    if (existing) throw new ScimError(409, "A user with that userName already exists in this workspace.", "uniqueness");
    const now = new Date();
    const created = await tx.workspaceMember.create({
      data: {
        workspaceId: ctx.workspaceId,
        email: attrs.email!,
        name: displayNameOf(attrs) ?? null,
        role: SCIM_DEFAULT_ROLE,
        scimManaged: true,
        scimExternalId: attrs.externalId ?? null,
        scimProfile: (attrs.profile ?? undefined) as Prisma.InputJsonValue | undefined,
        scimDeactivatedAt: attrs.active === false ? now : null,
      },
      include: withGroups,
    });
    await audit(tx, ctx.workspaceId, "scim_user_provisioned", `SCIM provisioned ${attrs.email} as ${SCIM_DEFAULT_ROLE}`);
    return toScimUser(created, base);
  });
  if (seat.kind === "within_approved") await syncSeatsBestEffort(ctx.workspaceId);
  return created;
}

export async function replaceUser(
  ctx: ScimContext,
  base: string,
  id: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const attrs = userAttrsFrom(body, true);
  // PUT replaces: attributes left out are cleared (active defaults to true).
  if (attrs.displayName === undefined) attrs.displayName = null;
  if (attrs.externalId === undefined) attrs.externalId = null;
  if (attrs.active === undefined) attrs.active = true;
  return withWorkspaceScope(ctx.workspaceId, async (tx) => {
    const member = await findMember(tx, ctx, id);
    await applyUserUpdate(tx, ctx, member, attrs);
    const m = await tx.workspaceMember.findFirstOrThrow({ where: { id, workspaceId: ctx.workspaceId }, include: withGroups });
    return toScimUser(m, base);
  });
}

interface PatchOp {
  op: string;
  path?: string;
  value?: unknown;
}

function patchOps(body: Record<string, unknown>): PatchOp[] {
  const ops = body.Operations ?? body.operations;
  if (!Array.isArray(ops) || ops.length === 0 || ops.length > 100) {
    throw new ScimError(400, "PATCH needs 1–100 Operations.", "invalidSyntax");
  }
  return ops.map((o) => {
    if (!o || typeof o !== "object") throw new ScimError(400, "Each operation must be an object.", "invalidSyntax");
    const r = o as Record<string, unknown>;
    const op = typeof r.op === "string" ? r.op.toLowerCase() : "";
    if (op !== "add" && op !== "replace" && op !== "remove") {
      throw new ScimError(400, `Unsupported op ${String(r.op)}.`, "invalidSyntax");
    }
    return { op, path: typeof r.path === "string" ? r.path.trim() : undefined, value: r.value };
  });
}

/** Fold PATCH operations on a User into attribute changes. */
export function userPatchToAttrs(ops: PatchOp[]): UserAttrs {
  const attrs: UserAttrs = {};
  const setAttr = (path: string, value: unknown, remove: boolean) => {
    const p = path.toLowerCase();
    if (p === "active") {
      const a = remove ? undefined : scimBool(value);
      if (a === undefined) throw new ScimError(400, "active must be a boolean.", "invalidValue");
      attrs.active = a;
    } else if (p === "username") {
      const v = str(value, 320);
      if (!v || remove) throw new ScimError(400, "userName can't be removed.", "mutability");
      attrs.email = assertEmail(v);
    } else if (p === "displayname") {
      attrs.displayName = remove ? null : (str(value) ?? null);
    } else if (p === "externalid") {
      attrs.externalId = remove ? null : (str(value, 255) ?? null);
    } else if (p === "name.givenname" || p === "name.familyname" || p === "name.formatted") {
      attrs.profile = attrs.profile ?? {};
      const key = p === "name.givenname" ? "givenName" : p === "name.familyname" ? "familyName" : "formatted";
      attrs.profile[key] = remove ? undefined : str(value);
    } else if (p === "name") {
      const n = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
      attrs.profile = remove ? {} : { givenName: str(n.givenName), familyName: str(n.familyName), formatted: str(n.formatted) };
    } else if (p === "emails" || /^emails\[.*\]\.value$/.test(p) || /^emails\[.*\]$/.test(p)) {
      if (remove) return; // userName stays the canonical email
      const v = Array.isArray(value)
        ? str((value.find((e) => (e as { primary?: unknown })?.primary) ?? value[0] as { value?: unknown })?.value, 320)
        : typeof value === "object" && value
          ? str((value as { value?: unknown }).value, 320)
          : str(value, 320);
      if (v) attrs.email = assertEmail(v);
    } else {
      throw new ScimError(400, `Unsupported attribute path ${path}.`, "invalidPath");
    }
  };
  for (const op of ops) {
    const remove = op.op === "remove";
    if (op.path) {
      setAttr(op.path, op.value, remove);
    } else {
      if (remove) throw new ScimError(400, "remove needs a path.", "noTarget");
      if (!op.value || typeof op.value !== "object" || Array.isArray(op.value)) {
        throw new ScimError(400, "An operation without a path needs an object value.", "invalidValue");
      }
      for (const [k, v] of Object.entries(op.value as Record<string, unknown>)) {
        if (k === "schemas" || k === "id" || k === "meta") continue;
        setAttr(k, v, false);
      }
    }
  }
  return attrs;
}

export async function patchUser(
  ctx: ScimContext,
  base: string,
  id: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const attrs = userPatchToAttrs(patchOps(body));
  return withWorkspaceScope(ctx.workspaceId, async (tx) => {
    const member = await findMember(tx, ctx, id);
    await applyUserUpdate(tx, ctx, member, attrs);
    const m = await tx.workspaceMember.findFirstOrThrow({ where: { id, workspaceId: ctx.workspaceId }, include: withGroups });
    return toScimUser(m, base);
  });
}

export async function deleteUser(ctx: ScimContext, id: string): Promise<void> {
  await withWorkspaceScope(ctx.workspaceId, async (tx) => {
    const member = await findMember(tx, ctx, id);
    await assertMutable(tx, member);
    await tx.workspaceMember.delete({ where: { id: member.id, workspaceId: ctx.workspaceId } });
    await audit(tx, ctx.workspaceId, "scim_user_deleted", `SCIM removed ${member.email ?? member.id}`);
  });
  // Phase 15.3 (pricing): one seat fewer can lower the extra-seat quantity.
  await syncSeatsBestEffort(ctx.workspaceId);
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

type GroupWithMembers = Prisma.ScimGroupGetPayload<{ include: { members: { include: { member: { select: { id: true; email: true } } } } } }>;

const groupInclude = { members: { include: { member: { select: { id: true, email: true } } } } } as const;

export function toScimGroup(g: GroupWithMembers, base: string): Record<string, unknown> {
  return {
    schemas: [SCHEMA_GROUP],
    id: g.id,
    displayName: g.displayName,
    ...(g.externalId ? { externalId: g.externalId } : {}),
    members: g.members.map((m) => ({
      value: m.memberId,
      ...(m.member.email ? { display: m.member.email } : {}),
      $ref: location(base, "Users", m.memberId),
    })),
    meta: {
      resourceType: "Group",
      created: g.createdAt.toISOString(),
      lastModified: g.updatedAt.toISOString(),
      location: location(base, "Groups", g.id),
    },
  };
}

function groupNameAndRole(raw: unknown): { displayName: string; role: WorkspaceRole } {
  const displayName = str(raw);
  if (!displayName) throw new ScimError(400, "displayName is required.", "invalidValue");
  const role = roleForGroupName(displayName);
  if (!role || !SCIM_ROLES.includes(role)) {
    throw new ScimError(
      400,
      "Group displayName must name a ShapesOS role: admin, editor or viewer (e.g. \"ShapesOS Admins\").",
      "invalidValue",
    );
  }
  return { displayName, role };
}

function memberIdsFrom(value: unknown): string[] {
  const arr = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  const ids = arr.map((v) => (v && typeof v === "object" ? str((v as { value?: unknown }).value, 120) : str(v, 120)));
  if (ids.some((id) => !id)) throw new ScimError(400, "Each member needs a value (the user id).", "invalidValue");
  if (ids.length > 1000) throw new ScimError(400, "Too many members in one request.", "tooMany");
  return [...new Set(ids as string[])];
}

/** Members must be users of THIS workspace — another workspace's id is rejected. */
async function assertMembersInWorkspace(tx: Tx, ctx: ScimContext, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const found = await tx.workspaceMember.findMany({
    where: { id: { in: ids }, workspaceId: ctx.workspaceId },
    select: { id: true },
  });
  if (found.length !== ids.length) {
    throw new ScimError(400, "One or more members are not users of this workspace.", "invalidValue");
  }
}

async function findGroup(tx: Tx, ctx: ScimContext, id: string): Promise<GroupWithMembers> {
  const g = await tx.scimGroup.findFirst({ where: { id, workspaceId: ctx.workspaceId }, include: groupInclude });
  if (!g) throw new ScimError(404, `Group ${id} not found.`);
  return g;
}

async function setGroupMembers(tx: Tx, ctx: ScimContext, groupId: string, add: string[], remove: string[]): Promise<void> {
  await assertMembersInWorkspace(tx, ctx, add);
  if (remove.length) {
    await tx.scimGroupMember.deleteMany({ where: { groupId, workspaceId: ctx.workspaceId, memberId: { in: remove } } });
  }
  if (add.length) {
    await tx.scimGroupMember.createMany({
      data: add.map((memberId) => ({ groupId, memberId, workspaceId: ctx.workspaceId })),
      skipDuplicates: true,
    });
  }
  for (const id of new Set([...add, ...remove])) await recomputeRole(tx, ctx.workspaceId, id);
}

export async function listGroups(
  ctx: ScimContext,
  base: string,
  q: { filter: string | null; startIndex: number; count: number; excludeMembers?: boolean },
): Promise<Record<string, unknown>> {
  const f = parseEqFilter(q.filter, ["displayName", "externalId"]);
  const where: Prisma.ScimGroupWhereInput = { workspaceId: ctx.workspaceId };
  if (f?.attr === "displayName") where.displayName = { equals: f.value, mode: "insensitive" };
  if (f?.attr === "externalId") where.externalId = f.value;
  return withWorkspaceScope(ctx.workspaceId, async (tx) => {
    const [total, rows] = await Promise.all([
      tx.scimGroup.count({ where: { ...where, workspaceId: ctx.workspaceId } }),
      tx.scimGroup.findMany({ where: { ...where, workspaceId: ctx.workspaceId }, orderBy: { createdAt: "asc" }, skip: q.startIndex - 1, take: q.count, include: groupInclude }),
    ]);
    const resources = rows.map((g) => {
      const r = toScimGroup(g, base);
      if (q.excludeMembers) delete r.members;
      return r;
    });
    return listResponse(resources, total, q.startIndex);
  });
}

export async function getGroup(ctx: ScimContext, base: string, id: string): Promise<Record<string, unknown>> {
  return withWorkspaceScope(ctx.workspaceId, async (tx) => toScimGroup(await findGroup(tx, ctx, id), base));
}

export async function createGroup(ctx: ScimContext, base: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { displayName, role } = groupNameAndRole(body.displayName);
  const members = memberIdsFrom(body.members);
  return withWorkspaceScope(ctx.workspaceId, async (tx) => {
    const clash = await tx.scimGroup.findFirst({
      where: { workspaceId: ctx.workspaceId, displayName: { equals: displayName, mode: "insensitive" } },
      select: { id: true },
    });
    if (clash) throw new ScimError(409, "A group with that displayName already exists.", "uniqueness");
    const g = await tx.scimGroup.create({
      data: { workspaceId: ctx.workspaceId, displayName, role, externalId: str(body.externalId, 255) ?? null },
    });
    await setGroupMembers(tx, ctx, g.id, members, []);
    await audit(tx, ctx.workspaceId, "scim_group_changed", `SCIM created group "${displayName}" (${role}) with ${members.length} member(s)`);
    return toScimGroup(await findGroup(tx, ctx, g.id), base);
  });
}

export async function replaceGroup(
  ctx: ScimContext,
  base: string,
  id: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { displayName, role } = groupNameAndRole(body.displayName);
  const members = memberIdsFrom(body.members);
  return withWorkspaceScope(ctx.workspaceId, async (tx) => {
    const g = await findGroup(tx, ctx, id);
    await tx.scimGroup.update({
      where: { id: g.id, workspaceId: ctx.workspaceId },
      data: { displayName, role, externalId: str(body.externalId, 255) ?? null },
    });
    const current = g.members.map((m) => m.memberId);
    await setGroupMembers(
      tx,
      ctx,
      g.id,
      members.filter((m) => !current.includes(m)),
      current.filter((m) => !members.includes(m)),
    );
    // A role change on the group re-ranks everyone still in it.
    if (role !== g.role) for (const m of members) await recomputeRole(tx, ctx.workspaceId, m);
    await audit(tx, ctx.workspaceId, "scim_group_changed", `SCIM replaced group "${displayName}" (${role}), ${members.length} member(s)`);
    return toScimGroup(await findGroup(tx, ctx, g.id), base);
  });
}

/** `members[value eq "id"]` → "id". */
function memberIdFromPath(path: string): string | null {
  const m = /^members\[\s*value\s+eq\s+"([^"]+)"\s*\]$/i.exec(path);
  return m ? m[1] : null;
}

export async function patchGroup(
  ctx: ScimContext,
  base: string,
  id: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const ops = patchOps(body);
  return withWorkspaceScope(ctx.workspaceId, async (tx) => {
    const g = await findGroup(tx, ctx, id);
    let members = g.members.map((m) => m.memberId);
    let displayName = g.displayName;
    let role = g.role;
    let externalId = g.externalId;
    for (const op of ops) {
      const path = (op.path ?? "").toLowerCase();
      if (!op.path) {
        if (op.op === "remove") throw new ScimError(400, "remove needs a path.", "noTarget");
        const v = (op.value && typeof op.value === "object" ? op.value : {}) as Record<string, unknown>;
        if ("displayName" in v) ({ displayName, role } = groupNameAndRole(v.displayName));
        if ("externalId" in v) externalId = str(v.externalId, 255) ?? null;
        if ("members" in v) {
          const ids = memberIdsFrom(v.members);
          members = op.op === "add" ? [...new Set([...members, ...ids])] : ids;
        }
      } else if (path === "displayname") {
        ({ displayName, role } = groupNameAndRole(op.value));
      } else if (path === "externalid") {
        externalId = op.op === "remove" ? null : (str(op.value, 255) ?? null);
      } else if (path === "members") {
        const ids = memberIdsFrom(op.value);
        if (op.op === "add") members = [...new Set([...members, ...ids])];
        else if (op.op === "replace") members = ids;
        else members = ids.length ? members.filter((m) => !ids.includes(m)) : [];
      } else if (memberIdFromPath(op.path) && op.op === "remove") {
        const target = memberIdFromPath(op.path)!;
        members = members.filter((m) => m !== target);
      } else {
        throw new ScimError(400, `Unsupported attribute path ${op.path}.`, "invalidPath");
      }
    }
    if (displayName !== g.displayName) {
      const clash = await tx.scimGroup.findFirst({
        where: { workspaceId: ctx.workspaceId, displayName: { equals: displayName, mode: "insensitive" }, id: { not: g.id } },
        select: { id: true },
      });
      if (clash) throw new ScimError(409, "A group with that displayName already exists.", "uniqueness");
    }
    await tx.scimGroup.update({ where: { id: g.id, workspaceId: ctx.workspaceId }, data: { displayName, role, externalId } });
    const current = g.members.map((m) => m.memberId);
    await setGroupMembers(
      tx,
      ctx,
      g.id,
      members.filter((m) => !current.includes(m)),
      current.filter((m) => !members.includes(m)),
    );
    if (role !== g.role) for (const m of members) await recomputeRole(tx, ctx.workspaceId, m);
    await audit(tx, ctx.workspaceId, "scim_group_changed", `SCIM updated group "${displayName}" (${role}), ${members.length} member(s)`);
    return toScimGroup(await findGroup(tx, ctx, g.id), base);
  });
}

export async function deleteGroup(ctx: ScimContext, id: string): Promise<void> {
  await withWorkspaceScope(ctx.workspaceId, async (tx) => {
    const g = await findGroup(tx, ctx, id);
    const members = g.members.map((m) => m.memberId);
    await tx.scimGroup.delete({ where: { id: g.id, workspaceId: ctx.workspaceId } });
    for (const m of members) await recomputeRole(tx, ctx.workspaceId, m);
    await audit(tx, ctx.workspaceId, "scim_group_changed", `SCIM deleted group "${g.displayName}"`);
  });
}
