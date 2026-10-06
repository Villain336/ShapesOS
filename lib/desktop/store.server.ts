// ShapesOS — Phase 18.1 (WS=desk): the member's desk, persisted.
//
// One user_desktop_layouts row per (workspace, member) holds the widget grid,
// the dock pins and the briefing opt-in; user_recent_items the recents. Every
// call runs inside withUserScope (owner-only FORCE RLS), keyed to the session
// subject the route resolved — never to an id read from the request.
// Writes are validated (lib/desktop/layout.ts, nav-overlay.ts, recents.ts);
// reads are sanitized so a stale row can never break Home.

import { Prisma } from "@prisma/client";
import { withUserScope } from "./scope";
import { defaultLayoutFor, sanitizeLayout, validateLayout, type DesktopLayout, type LayoutIssue } from "./layout";
import { sanitizeNavPrefs, type NavPrefs } from "./nav-overlay";
import { RECENTS_KEEP, RECENTS_SHOWN, classifyRecent, normalizeRecentHref, recentTitle, type RecentItem } from "./recents";

export interface DeskState {
  layout: DesktopLayout;
  /** True when the member arranged it (false = their role's default). */
  customized: boolean;
  nav: NavPrefs;
  briefingEnabled: boolean;
}

export class LayoutRejected extends Error {
  readonly status = 400;
  constructor(readonly issues: LayoutIssue[]) {
    super(issues[0]?.message ?? "That layout is not valid.");
    this.name = "LayoutRejected";
  }
}

export async function getDesk(workspaceId: string, userId: string, role: string | null | undefined): Promise<DeskState> {
  const row = await withUserScope(workspaceId, userId, (tx) =>
    tx.userDesktopLayout.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: { layout: true, nav: true, briefingEnabled: true },
    }),
  );
  return {
    layout: row?.layout ? sanitizeLayout(row.layout, role) : defaultLayoutFor(role),
    customized: !!row?.layout,
    nav: sanitizeNavPrefs(row?.nav ?? { pinned: [] }, role),
    briefingEnabled: row?.briefingEnabled ?? false,
  };
}

async function upsertDesk(
  workspaceId: string,
  userId: string,
  data: { layout?: Prisma.InputJsonValue; nav?: Prisma.InputJsonValue; briefingEnabled?: boolean },
): Promise<void> {
  await withUserScope(workspaceId, userId, (tx) =>
    tx.userDesktopLayout.upsert({
      where: { workspaceId_userId: { workspaceId, userId } },
      create: { workspaceId, userId, ...data },
      update: data,
    }),
  );
}

/** Save a layout the member arranged; refused (LayoutRejected) unless fully valid. */
export async function saveLayout(workspaceId: string, userId: string, role: string | null | undefined, input: unknown): Promise<DesktopLayout> {
  const v = validateLayout(input, role);
  if (!v.ok) throw new LayoutRejected(v.issues);
  await upsertDesk(workspaceId, userId, { layout: v.layout as unknown as Prisma.InputJsonValue });
  return v.layout;
}

/** Back to the role's default (the stored layout is cleared, not copied). */
export async function resetLayout(workspaceId: string, userId: string, role: string | null | undefined): Promise<DesktopLayout> {
  await withUserScope(workspaceId, userId, (tx) =>
    tx.userDesktopLayout.updateMany({ where: { workspaceId, userId }, data: { layout: Prisma.DbNull } }),
  );
  return defaultLayoutFor(role);
}

/** Save the dock pins (sanitized: unknown hrefs and gated items are dropped). */
export async function saveNav(workspaceId: string, userId: string, role: string | null | undefined, input: unknown): Promise<NavPrefs> {
  const nav = sanitizeNavPrefs(input, role);
  await upsertDesk(workspaceId, userId, { nav: nav as unknown as Prisma.InputJsonValue });
  return nav;
}

export async function setBriefingEnabled(workspaceId: string, userId: string, enabled: boolean): Promise<void> {
  await upsertDesk(workspaceId, userId, { briefingEnabled: enabled });
}

// ---------------------------------------------------------------------------
// Recents
// ---------------------------------------------------------------------------

/**
 * Remember a visit (one row per href, visitedAt bumped) and prune to the
 * newest RECENTS_KEEP. Returns null when the page is not worth remembering.
 */
export async function recordRecent(
  workspaceId: string,
  userId: string,
  input: { href: unknown; title?: unknown },
  now: Date = new Date(),
): Promise<RecentItem | null> {
  const href = normalizeRecentHref(input.href);
  if (!href) return null;
  const title = recentTitle(href, input.title);
  const kind = classifyRecent(href);
  return withUserScope(workspaceId, userId, async (tx) => {
    const row = await tx.userRecentItem.upsert({
      where: { workspaceId_userId_href: { workspaceId, userId, href } },
      create: { workspaceId, userId, href, title, kind, visitedAt: now },
      update: { title, kind, visitedAt: now },
      select: { href: true, title: true, kind: true, visitedAt: true },
    });
    const stale = await tx.userRecentItem.findMany({
      where: { workspaceId, userId },
      orderBy: [{ visitedAt: "desc" }, { id: "desc" }],
      skip: RECENTS_KEEP,
      select: { id: true },
    });
    if (stale.length) await tx.userRecentItem.deleteMany({ where: { id: { in: stale.map((s) => s.id) } } });
    return { href: row.href, title: row.title, kind: row.kind as RecentItem["kind"], visitedAt: row.visitedAt.toISOString() };
  });
}

export async function listRecents(workspaceId: string, userId: string, limit = RECENTS_SHOWN): Promise<RecentItem[]> {
  const rows = await withUserScope(workspaceId, userId, (tx) =>
    tx.userRecentItem.findMany({
      where: { workspaceId, userId },
      orderBy: [{ visitedAt: "desc" }, { id: "desc" }],
      take: Math.min(Math.max(limit, 1), RECENTS_KEEP),
      select: { href: true, title: true, kind: true, visitedAt: true },
    }),
  );
  // A page renamed out of the nav since: keep it (it is still a real place),
  // but re-derive its label so it never shows a stale app name.
  return rows
    .filter((r) => normalizeRecentHref(r.href) === r.href)
    .map((r) => ({ href: r.href, title: r.title, kind: (r.kind === "record" ? "record" : "app") as RecentItem["kind"], visitedAt: r.visitedAt.toISOString() }));
}
