// ShapesOS — Phase 3 (J): unified "needs you" inbox aggregator.
//
// Rolls every human-approval queue (lib/approvals/sources.ts) into one list
// for the signed-in member of the current workspace:
//   - workspace-scoped: every source reads only viewer.workspaceId, and the
//     RLS-protected tables run inside withWorkspaceScope (fail-closed GUC);
//   - role-aware: a queue is included only when the viewer's role can read
//     it today, and each item says whether the viewer can decide it under
//     that queue's own rule;
//   - resilient: one failing queue is reported in `errors`, never fails the
//     whole inbox.
//
// Read-only. Decisions go through each queue's own API (deep link or the
// inline action, which re-checks every rule server-side).

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getMembership, hasPermission, roleAtLeast } from "@/lib/authz";
import { withWorkspaceScope } from "@/lib/substrate/graph/rls";
import { INBOX_SOURCE_DEFS, type InboxSource } from "./sources";
import {
  INBOX_SOURCE_LABELS,
  type InboxDb,
  type InboxItem,
  type InboxResult,
  type InboxSourceKey,
  type InboxViewer,
} from "./types";

export type { InboxItem, InboxResult, InboxViewer, InboxSourceKey } from "./types";

export interface LoadInboxOptions {
  db?: InboxDb;
  /** Tenant scope for RLS tables; defaults to withWorkspaceScope. */
  scope?: <T>(workspaceId: string, fn: (tx: InboxDb) => Promise<T>) => Promise<T>;
  now?: Date;
  /** Max pending rows read per queue (default 50). */
  limitPerSource?: number;
  /** Restrict to these queues. */
  sources?: readonly InboxSourceKey[];
  /** Override the source definitions (tests). */
  defs?: readonly InboxSource[];
}

/** Queues this viewer may read (role gate mirrors each queue's own GET). */
export function visibleSources(
  viewer: Pick<InboxViewer, "role">,
  defs: readonly InboxSource[] = INBOX_SOURCE_DEFS,
): InboxSource[] {
  return defs.filter((d) => roleAtLeast(viewer.role, d.viewRole));
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Display names for requesters: members' name/email; agents read as "Agent". */
async function resolveRequesters(db: InboxDb, workspaceId: string, items: InboxItem[]): Promise<void> {
  const ids = [
    ...new Set(
      items
        .map((i) => i.requestedBy?.split(" ")[0])
        .filter((v): v is string => !!v && !v.startsWith("agent") && !v.includes("@") && !v.includes(":")),
    ),
  ];
  const members = ids.length
    ? await db.workspaceMember.findMany({
        where: { workspaceId, userId: { in: ids } },
        select: { userId: true, name: true, email: true },
      })
    : [];
  const byId = new Map(members.map((m) => [m.userId, m.name || m.email || null]));
  for (const item of items) {
    const raw = item.requestedBy;
    if (!raw) {
      item.requester = null;
    } else if (raw.startsWith("agent") || raw.startsWith("gate:") || raw === "system") {
      item.requester = "Agent";
    } else if (raw.includes("@")) {
      item.requester = raw;
    } else {
      item.requester = byId.get(raw.split(" ")[0]!) ?? "Workspace member";
    }
  }
}

/**
 * Load the unified inbox for a viewer. Items are newest first; each queue
 * contributes at most `limitPerSource` rows.
 */
export async function loadInbox(viewer: InboxViewer, opts: LoadInboxOptions = {}): Promise<InboxResult> {
  const db = opts.db ?? (prisma as unknown as InboxDb);
  const scope =
    opts.scope ??
    (<T,>(workspaceId: string, fn: (tx: InboxDb) => Promise<T>) =>
      withWorkspaceScope(workspaceId, (tx) => fn(tx as unknown as InboxDb)));
  const now = opts.now ?? new Date();
  const limit = Math.min(Math.max(opts.limitPerSource ?? 50, 1), 200);
  const only = opts.sources?.length ? new Set(opts.sources) : null;
  const defs = visibleSources(viewer, opts.defs ?? INBOX_SOURCE_DEFS).filter((d) => !only || only.has(d.key));

  const errors: InboxResult["errors"] = [];
  const perSource = await mapLimit(defs, 4, async (def) => {
    try {
      const items = await def.load({
        db,
        scoped: (fn) => scope(viewer.workspaceId, fn),
        viewer,
        now,
        limit,
      });
      return { def, items };
    } catch (e) {
      errors.push({ source: def.key, message: e instanceof Error ? e.message.slice(0, 200) : "failed to load" });
      return { def, items: [] as InboxItem[] };
    }
  });

  const items = perSource.flatMap((p) => p.items);
  items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  try {
    await resolveRequesters(db, viewer.workspaceId, items);
  } catch {
    // Names are cosmetic; the inbox still renders with raw-free fallbacks.
  }

  const sources = perSource.map(({ def, items: list }) => ({
    source: def.key,
    label: INBOX_SOURCE_LABELS[def.key],
    total: list.length,
    actionable: list.filter((i) => i.canDecide).length,
  }));
  return {
    items,
    sources,
    errors,
    total: items.length,
    actionable: items.filter((i) => i.canDecide).length,
  };
}

/** Badge numbers: everything visible, and what this viewer can decide. */
export async function countInbox(
  viewer: InboxViewer,
  opts: LoadInboxOptions = {},
): Promise<{ total: number; actionable: number }> {
  const res = await loadInbox(viewer, opts);
  return { total: res.total, actionable: res.actionable };
}

/**
 * Build the viewer from the session user + current workspace. Null when the
 * user has no membership (callers answer 403).
 */
export async function resolveInboxViewer(userId: string, workspaceId: string): Promise<InboxViewer | null> {
  const membership = await getMembership(userId, workspaceId);
  if (!membership) return null;
  const permissions = new Set<string>();
  if (await hasPermission(userId, workspaceId, "skills.install")) permissions.add("skills.install");
  return {
    userId,
    workspaceId,
    role: membership.role,
    permissions,
    hasOtherApprover: await hasOtherApprover(prisma, workspaceId, userId),
  };
}

/** Mirrors lib/integrations/actions/gate.ts: another editor+ (or the owner) exists. */
export async function hasOtherApprover(
  db: Pick<Prisma.TransactionClient, "workspace" | "workspaceMember">,
  workspaceId: string,
  userId: string,
): Promise<boolean> {
  const ws = await db.workspace.findUnique({ where: { id: workspaceId }, select: { ownerUserId: true } });
  if (ws?.ownerUserId && ws.ownerUserId !== userId) return true;
  const other = await db.workspaceMember.findFirst({
    where: { workspaceId, userId: { not: null, notIn: [userId] }, role: { in: ["editor", "admin", "owner"] } },
    select: { id: true },
  });
  return other !== null;
}
