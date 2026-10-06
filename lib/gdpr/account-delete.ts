// ShapesOS — delete my account (Phase 4a, GDPR Art. 17 erasure).
//
// Sign-in is Auth.js JWT with no user table, so "the account" is the
// sign-in subject id and everything keyed to it. Deleting it:
//
//   1. refuses, naming each workspace, while the user is the only owner of
//      a workspace that has other members (transfer ownership or remove them
//      first), or owns a workspace that would be deleted but still has a
//      paid subscription;
//   2. deletes every workspace the user is the only member of, through the
//      same purge as Settings → General (purgeWorkspace: RESTRICT children,
//      cascade, lifecycle record);
//   3. leaves every other workspace: the membership row goes, ownership of
//      the workspace row passes to another owner, and the workspace's audit
//      log records that a member left;
//   4. deletes personal rows that exist only for this user: notifications,
//      MCP keys and OAuth grants, private AI chat threads, permission grants,
//      work-from-home records, pending invites addressed to their email, the
//      email + password account and its sign-in links (Phase 6);
//   5. pseudonymizes every remaining reference to the user id (created_by,
//      approved_by, actor, …; catalog-driven) to "deleted-user-<random>",
//      and the email in audit-log summaries to "[deleted user]".
//
// Not rewritten, by design: hash-chained audit tables (rewriting an actor
// breaks the chain's tamper evidence), the append-only usage ledger, and the
// workspace lifecycle trail (KEEP_REFERENCES).
// Those keep the opaque subject id; with the account gone nothing in
// ShapesOS maps it back to a person. The caller signs the user out.

import { randomBytes } from "node:crypto";
import type { WorkspaceRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { BadRequestError, ConflictError } from "@/lib/api/errors";
import { LIVE_SUBSCRIPTION, purgeWorkspace, readSubscription } from "@/lib/workspace/lifecycle";
import { WORKSPACE_GUC } from "@/lib/substrate/memory/rls";
import { USER_GUC } from "@/lib/desktop/scope";
import { isUserRefColumn, loadCatalog, q, type Catalog } from "./catalog";
import { emailFromUserId } from "@/lib/auth/email/tokens";

// ── Pure rules (unit-tested) ────────────────────────────────────────────────

/** Typed confirmation: the account email (any case), or the phrase when there is no email. */
export const DELETE_ACCOUNT_PHRASE = "delete my account";

export function accountConfirmationText(email: string | null | undefined): string {
  const e = email?.trim();
  return e ? e : DELETE_ACCOUNT_PHRASE;
}

export function accountConfirmationMatches(typed: unknown, email: string | null | undefined): boolean {
  if (typeof typed !== "string" || !typed.trim()) return false;
  return typed.trim().toLowerCase() === accountConfirmationText(email).toLowerCase();
}

export interface WorkspaceFacts {
  id: string;
  name: string;
  ownerUserId: string;
  /** Claimed members (user_id set), including this user when a member. */
  members: { userId: string; role: WorkspaceRole }[];
  subscription: { status: string; cancelAtPeriodEnd: boolean } | null;
}

export interface DeletionPlan {
  blockers: { workspaceId: string; workspaceName: string; reason: "sole_owner_with_members" | "paid_subscription" }[];
  deleteWorkspaces: { id: string; name: string }[];
  leaveWorkspaces: { id: string; name: string; newOwnerUserId: string | null }[];
}

export function planAccountDeletion(userId: string, workspaces: WorkspaceFacts[]): DeletionPlan {
  const plan: DeletionPlan = { blockers: [], deleteWorkspaces: [], leaveWorkspaces: [] };
  for (const w of workspaces) {
    const me = w.members.find((m) => m.userId === userId);
    const others = w.members.filter((m) => m.userId !== userId);
    const iOwn = w.ownerUserId === userId || me?.role === "owner";
    if (others.length === 0) {
      const sub = w.subscription;
      if (sub && LIVE_SUBSCRIPTION.has(sub.status) && !sub.cancelAtPeriodEnd) {
        plan.blockers.push({ workspaceId: w.id, workspaceName: w.name, reason: "paid_subscription" });
      } else {
        plan.deleteWorkspaces.push({ id: w.id, name: w.name });
      }
      continue;
    }
    const otherOwners = others.filter((m) => m.role === "owner");
    if (iOwn && otherOwners.length === 0) {
      plan.blockers.push({ workspaceId: w.id, workspaceName: w.name, reason: "sole_owner_with_members" });
      continue;
    }
    const newOwnerUserId = w.ownerUserId === userId ? (otherOwners[0]?.userId ?? null) : null;
    plan.leaveWorkspaces.push({ id: w.id, name: w.name, newOwnerUserId });
  }
  return plan;
}

export function blockerMessage(plan: DeletionPlan): string | null {
  if (!plan.blockers.length) return null;
  const owner = plan.blockers.filter((b) => b.reason === "sole_owner_with_members").map((b) => `"${b.workspaceName}"`);
  const paid = plan.blockers.filter((b) => b.reason === "paid_subscription").map((b) => `"${b.workspaceName}"`);
  const parts: string[] = [];
  if (owner.length) {
    parts.push(
      `You're the only owner of ${owner.join(", ")}, which ${owner.length === 1 ? "has" : "have"} other members. Make another member an owner, or remove them, first.`,
    );
  }
  if (paid.length) parts.push(`${paid.join(", ")} still ${paid.length === 1 ? "has" : "have"} a paid subscription. Cancel it in Billing first.`);
  return parts.join(" ");
}

/** Per-user tables whose rows are deleted outright (in this order: children first). */
export const PERSONAL_TABLES: readonly { table: string; column: string }[] = [
  { table: "notifications", column: "user_id" },
  { table: "mcp_oauth_tokens", column: "user_id" },
  { table: "mcp_oauth_codes", column: "user_id" },
  { table: "mcp_oauth_clients", column: "user_id" },
  { table: "mcp_api_keys", column: "user_id" },
  { table: "ai_chat_threads", column: "user_id" },
  { table: "permission_grants", column: "user_id" },
  { table: "wfh_calendar_connections", column: "user_id" },
  { table: "wfh_digest_items", column: "user_id" },
  { table: "wfh_expenses", column: "user_id" },
  { table: "wfh_expense_categories", column: "user_id" },
  { table: "wfh_focus_blocks", column: "user_id" },
  { table: "wfh_learning_signals", column: "user_id" },
  { table: "wfh_mode_history", column: "user_id" },
  { table: "wfh_ritual_participations", column: "user_id" },
  { table: "wfh_ritual_subscriptions", column: "user_id" },
  { table: "wfh_standup_reactions", column: "user_id" },
  { table: "wfh_work_modes", column: "user_id" },
  // Phase 4a identity: sign-in factors. user_security is re-created below as
  // a bare tombstone (account_deleted_at) so older sessions are refused.
  { table: "user_recovery_codes", column: "user_id" },
  { table: "user_passkeys", column: "user_id" },
  { table: "auth_challenges", column: "user_id" },
  // Phase 6: the email + password account (its single-use links are keyed by
  // address and deleted just before; see EMAIL_TOKEN_TABLE).
  { table: "email_accounts", column: "user_id" },
  // Phase 18.1 (WS=desk): focus state, voice + shortcut overrides (per person).
  { table: "user_desk_state", column: "user_id" },
  { table: "user_security", column: "user_id" },
];

/**
 * Phase 6: one-time email links (verify / magic link / reset) are keyed by
 * address, not subject: deleted for the address of the user's email account
 * (and of an "email:" subject, which may have links before its row exists).
 */
export const EMAIL_TOKEN_TABLE = "email_auth_tokens";

/**
 * Per-user rows in FORCE-RLS tables: deleted inside each remaining
 * workspace's scope (solo workspaces cascade with the workspace itself).
 */
export const PERSONAL_RLS_TABLES: readonly { table: string; column: string }[] = [
  { table: "push_devices", column: "user_id" },
  { table: "conversation_reads", column: "user_id" },
  // Phase 18.1 (WS=desk): owner-only (workspace + app.user_id) — the delete
  // pass sets the person GUC to the subject too.
  { table: "user_desktop_layouts", column: "user_id" },
  { table: "user_recent_items", column: "user_id" },
  { table: "desktop_briefings", column: "user_id" },
];

/**
 * Tables whose person references are kept as they are:
 *   workspaces / workspace_members  handled explicitly (ownership, membership)
 *   workspace_lifecycle_events      the platform's own record of who created
 *                                   and deleted workspaces (also what stops a
 *                                   deleted-and-recreated account from taking
 *                                   a second hosted trial); opaque subject id only
 */
export const KEEP_REFERENCES: readonly string[] = ["workspaces", "workspace_members", "workspace_lifecycle_events"];

/** Columns pseudonymized on account deletion (catalog-driven; pure). */
export function pseudonymizeTargets(catalog: Catalog): { table: string; columns: string[]; rls: boolean }[] {
  const skip = new Set([...PERSONAL_TABLES.map((p) => p.table), ...PERSONAL_RLS_TABLES.map((p) => p.table), ...KEEP_REFERENCES]);
  const out: { table: string; columns: string[]; rls: boolean }[] = [];
  for (const name of [...catalog.keys()].sort()) {
    if (skip.has(name)) continue;
    const t = catalog.get(name)!;
    if (t.hashChained || t.hasTriggers) continue; // tamper-evident / append-only: kept as is
    const columns = t.columns.filter((c) => isUserRefColumn(c.name, c.type)).map((c) => c.name);
    if (!columns.length) continue;
    out.push({ table: name, columns, rls: t.rls });
  }
  return out;
}

export function newPseudonym(): string {
  return `deleted-user-${randomBytes(6).toString("hex")}`;
}

// ── Execution ────────────────────────────────────────────────────────────────

async function workspaceFacts(userId: string): Promise<WorkspaceFacts[]> {
  const workspaces = await prisma.workspace.findMany({
    where: { OR: [{ ownerUserId: userId }, { members: { some: { userId } } }] },
    select: {
      id: true,
      name: true,
      ownerUserId: true,
      members: { where: { userId: { not: null } }, select: { userId: true, role: true } },
    },
  });
  const out: WorkspaceFacts[] = [];
  for (const w of workspaces) {
    out.push({
      id: w.id,
      name: w.name,
      ownerUserId: w.ownerUserId,
      members: w.members.map((m) => ({ userId: m.userId!, role: m.role })),
      subscription: await readSubscription(w.id),
    });
  }
  return out;
}

/** What deleting the account would do, for the confirmation UI. */
export async function previewAccountDeletion(userId: string): Promise<DeletionPlan> {
  return planAccountDeletion(userId, await workspaceFacts(userId));
}

export interface AccountDeletionResult {
  deletedWorkspaces: string[];
  leftWorkspaces: string[];
  personalRowsDeleted: number;
  referencesPseudonymized: number;
}

export async function deleteAccount(opts: {
  userId: string;
  email?: string | null;
  confirm: unknown;
}): Promise<AccountDeletionResult> {
  const { userId } = opts;
  if (!accountConfirmationMatches(opts.confirm, opts.email)) {
    throw new BadRequestError(`Type ${accountConfirmationText(opts.email)} to confirm.`);
  }
  const facts = await workspaceFacts(userId);
  const plan = planAccountDeletion(userId, facts);
  const blocked = blockerMessage(plan);
  if (blocked) throw new ConflictError(blocked, { code: "account_delete_blocked" });

  const pseudonym = newPseudonym();
  // Every workspace the user touched, for RLS-scoped rewrites (read before
  // memberships go).
  const scopeWorkspaces = facts.map((f) => f.id).filter((id) => !plan.deleteWorkspaces.some((d) => d.id === id));

  // 2. Workspaces only this user is in: the regular purge.
  for (const w of plan.deleteWorkspaces) {
    await purgeWorkspace({ workspaceId: w.id, workspaceName: w.name, actorUserId: userId, detail: { reason: "account_deleted" } });
  }

  // 3. Leave the rest.
  for (const w of plan.leaveWorkspaces) {
    await prisma.$transaction(async (tx) => {
      await tx.workspaceMember.deleteMany({ where: { workspaceId: w.id, userId } });
      if (w.newOwnerUserId) {
        await tx.workspace.update({ where: { id: w.id }, data: { ownerUserId: w.newOwnerUserId } });
      }
      await tx.fileChangeLog.create({
        data: {
          workspaceId: w.id,
          filePath: "(workspace)",
          actor: "user",
          action: "member_removed",
          summary: w.newOwnerUserId
            ? "A member deleted their account and left the workspace; ownership passed to another owner"
            : "A member deleted their account and left the workspace",
          approvedBy: pseudonym,
        },
      });
    });
  }

  // 4 + 5. Personal rows and remaining references, in one transaction.
  const catalog = await loadCatalog();
  const email = opts.email?.trim() || null;
  let personalRowsDeleted = 0;
  let referencesPseudonymized = 0;
  await prisma.$transaction(
    async (tx) => {
      if (catalog.has(EMAIL_TOKEN_TABLE) && catalog.has("email_accounts")) {
        const subjectEmail = emailFromUserId(userId) ?? "";
        personalRowsDeleted += await tx.$executeRaw`
          DELETE FROM "email_auth_tokens"
           WHERE "email" IN (SELECT "email" FROM "email_accounts" WHERE "user_id" = ${userId})
              OR "email" = ${subjectEmail}`;
      }
      for (const p of PERSONAL_TABLES) {
        if (!catalog.has(p.table)) continue;
        personalRowsDeleted += await tx.$executeRawUnsafe(`DELETE FROM ${q(p.table)} WHERE ${q(p.column)} = $1`, userId);
      }
      if (email) {
        // Pending invites addressed to this person.
        personalRowsDeleted += await tx.$executeRaw`
          DELETE FROM "workspace_members" WHERE "user_id" IS NULL AND lower("email") = lower(${email})`;
        referencesPseudonymized += await tx.$executeRaw`
          UPDATE "file_change_log" SET "summary" = replace("summary", ${email}, '[deleted user]')
           WHERE "summary" ILIKE ${`%${email.replace(/[\\%_]/g, (c) => `\\${c}`)}%`}`;
      }
      // Phase 18.1: owner-only tables answer only to their member (app.user_id).
      await tx.$queryRaw`SELECT set_config(${USER_GUC}, ${userId}, true)`;
      for (const p of PERSONAL_RLS_TABLES) {
        if (!catalog.has(p.table)) continue;
        for (const ws of scopeWorkspaces) {
          await tx.$queryRaw`SELECT set_config(${WORKSPACE_GUC}, ${ws}, true)`;
          personalRowsDeleted += await tx.$executeRawUnsafe(`DELETE FROM ${q(p.table)} WHERE ${q(p.column)} = $1`, userId);
        }
      }
      // Tombstone: no secrets, no email, only when the account was deleted.
      await tx.userSecurity.upsert({
        where: { userId },
        create: { userId, accountDeletedAt: new Date() },
        update: { accountDeletedAt: new Date() },
      });
      for (const target of pseudonymizeTargets(catalog)) {
        const set = target.columns.map((c) => `${q(c)} = CASE WHEN ${q(c)} = $1 THEN $2 ELSE ${q(c)} END`).join(", ");
        const where = target.columns.map((c) => `${q(c)} = $1`).join(" OR ");
        if (!target.rls) {
          referencesPseudonymized += await tx.$executeRawUnsafe(`UPDATE ${q(target.table)} SET ${set} WHERE ${where}`, userId, pseudonym);
          continue;
        }
        // RLS tables answer only inside a workspace scope: one pass per
        // workspace the user was in (the policy limits each pass to it).
        for (const ws of scopeWorkspaces) {
          await tx.$queryRaw`SELECT set_config(${WORKSPACE_GUC}, ${ws}, true)`;
          referencesPseudonymized += await tx.$executeRawUnsafe(
            `UPDATE ${q(target.table)} SET ${set} WHERE ${where}`,
            userId,
            pseudonym,
          );
        }
      }
    },
    { maxWait: 10_000, timeout: 120_000 },
  );

  return {
    deletedWorkspaces: plan.deleteWorkspaces.map((w) => w.id),
    leftWorkspaces: plan.leaveWorkspaces.map((w) => w.id),
    personalRowsDeleted,
    referencesPseudonymized,
  };
}
