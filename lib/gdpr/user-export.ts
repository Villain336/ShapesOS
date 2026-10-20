// ShapesOS — personal data export for the signed-in user (Phase 4a, GDPR
// Art. 15 access / Art. 20 portability).
//
//   { "format": "shapesos.user-export", "version": 1, "exportedAt": …,
//     "account": { id, email, name },
//     "memberships": [ { workspaceId, workspaceName, role, joinedAt } ],
//     "pendingInvites": [ { workspaceId, workspaceName, role, invitedAt } ],
//     "authored": { "<table>": [ {row}, … ] },
//     "manifest": { … } }
//
// "authored" is every row, in the workspaces the user belongs to, where a
// person-reference column (user_id, created_by, actor, *_by, …; see
// lib/gdpr/catalog.ts) holds this user's id, plus rows in tables that aren't
// workspace-owned at all. Workspace rows are read under that workspace's RLS
// scope. Secrets are left out exactly as in the workspace export. There is
// no user table (sign-in is Auth.js JWT), so the account block is what the
// session knows; an email account's record (Phase 6, email_accounts) comes
// through "authored" by its user_id, without password_hash (a secret column).

import { prisma } from "@/lib/prisma";
import {
  SECRET_TABLES,
  exportableColumns,
  isUserRefColumn,
  loadCatalog,
  q,
  workspaceScopePredicate,
  type Catalog,
} from "./catalog";
import { scopedRows } from "./stream";

export const USER_EXPORT_FORMAT = "shapesos.user-export";

/** Tables the account/membership blocks already cover. */
const HANDLED = new Set(["workspaces", "workspace_members"]);

export interface UserRefTable {
  table: string;
  userColumns: string[];
  /** Workspace predicate on alias t with $1 = workspace id, or null when not workspace-owned. */
  scope: string | null;
}

/** Tables with person-reference columns (pure given a catalog). */
export function userRefTables(catalog: Catalog): UserRefTable[] {
  const out: UserRefTable[] = [];
  for (const name of [...catalog.keys()].sort()) {
    if (HANDLED.has(name) || SECRET_TABLES.includes(name)) continue;
    const t = catalog.get(name)!;
    const userColumns = t.columns.filter((c) => isUserRefColumn(c.name, c.type)).map((c) => c.name);
    if (!userColumns.length) continue;
    out.push({ table: name, userColumns, scope: workspaceScopePredicate(catalog, name) });
  }
  return out;
}

export function userPredicate(columns: string[], param: number): string {
  return `(${columns.map((c) => `t.${q(c)} = $${param}`).join(" OR ")})`;
}

export interface SessionAccount {
  id: string;
  email?: string | null;
  name?: string | null;
}

export async function* userExport(account: SessionAccount, now = new Date()): AsyncGenerator<string> {
  const userId = account.id;
  const email = account.email?.trim().toLowerCase() || null;
  const catalog = await loadCatalog();

  const memberRows = await prisma.workspaceMember.findMany({
    where: { userId },
    select: { workspaceId: true, role: true, createdAt: true, workspace: { select: { name: true } } },
    orderBy: { createdAt: "asc" },
  });
  const owned = await prisma.workspace.findMany({
    where: { ownerUserId: userId },
    select: { id: true, name: true, createdAt: true },
  });
  const memberships = memberRows.map((m) => ({
    workspaceId: m.workspaceId,
    workspaceName: m.workspace.name,
    role: m.role,
    joinedAt: m.createdAt.toISOString(),
  }));
  for (const w of owned) {
    if (!memberships.some((m) => m.workspaceId === w.id)) {
      memberships.push({ workspaceId: w.id, workspaceName: w.name, role: "owner", joinedAt: w.createdAt.toISOString() });
    }
  }
  const invites = email
    ? await prisma.workspaceMember.findMany({
        where: { userId: null, email: { equals: email, mode: "insensitive" } },
        select: { workspaceId: true, role: true, createdAt: true, workspace: { select: { name: true } } },
      })
    : [];

  yield `{"format":${JSON.stringify(USER_EXPORT_FORMAT)},"version":1,"exportedAt":${JSON.stringify(now.toISOString())}`;
  yield `,"account":${JSON.stringify({ id: userId, email: account.email ?? null, name: account.name ?? null })}`;
  yield `,"memberships":${JSON.stringify(memberships)}`;
  yield `,"pendingInvites":${JSON.stringify(
    invites.map((i) => ({ workspaceId: i.workspaceId, workspaceName: i.workspace.name, role: i.role, invitedAt: i.createdAt.toISOString() })),
  )}`;
  yield `,"authored":{`;

  const workspaceIds = memberships.map((m) => m.workspaceId);
  const manifest: Record<string, { rows: number; matchedColumns: string[]; omittedColumns: string[] }> = {};
  let firstTable = true;
  for (const ref of userRefTables(catalog)) {
    const t = catalog.get(ref.table)!;
    const { include, omitted } = exportableColumns(t);
    const passes: { predicate: string; params: unknown[]; guc: string | null }[] = ref.scope
      ? workspaceIds.map((ws) => ({ predicate: `${ref.scope} AND ${userPredicate(ref.userColumns, 2)}`, params: [ws, userId], guc: ws }))
      : [{ predicate: userPredicate(ref.userColumns, 1), params: [userId], guc: null }];
    let n = 0;
    for (const pass of passes) {
      // Phase 18.1: the subject is also the person GUC, so owner-only tables (the desk) export too.
      for await (const row of scopedRows({ table: t, columns: include, predicate: pass.predicate, params: pass.params, gucWorkspaceId: pass.guc, gucUserId: userId })) {
        if (n === 0) {
          yield `${firstTable ? "" : ","}${JSON.stringify(ref.table)}:[`;
          firstTable = false;
        }
        yield `${n === 0 ? "" : ","}${row}`;
        n++;
      }
    }
    if (n > 0) {
      yield "]";
      manifest[ref.table] = { rows: n, matchedColumns: ref.userColumns, omittedColumns: omitted };
    }
  }
  yield "}";
  yield `,"manifest":${JSON.stringify({
    authored: manifest,
    notes: [
      "\"authored\" holds rows in your current workspaces (and in tables not tied to a workspace) that reference your account id.",
      "Credential ciphertext, token hashes, passwords and signing secrets are never exported.",
      "A workspace's own data is exported by its owners and admins from Settings → General.",
    ],
  })}}`;
}
