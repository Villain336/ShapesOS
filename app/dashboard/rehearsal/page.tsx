// ShapesOS — Phase 19B (WS=panel): /dashboard/rehearsal — Dress Rehearsal,
// the Pre Launch Panel (commercial layer, entitlement dress_rehearsal).
// Below Pro the page is an honest upsell (what it is, that it is synthetic,
// which plan has it); the API refuses the same calls with 403. Above it:
// interviews in → personas (derive / edit / veto) → page walk runs under a
// confirmed hard credit cap → the report, diff and track record. The Town
// tab waits for the next milestone.

import { redirect } from "next/navigation";
import type { WorkspaceRole } from "@prisma/client";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { getMembership, roleAtLeast } from "@/lib/authz";
import { getI18n } from "@/lib/i18n/server";
import { planOf } from "@/lib/billing/entitlements-server";
import { planHasFeature } from "@/lib/billing/entitlements";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { calibrationSummary, listInterviews, listPersonas, listRuns } from "@/lib/panel/service.server";
import { RehearsalApp, type RehearsalSources } from "@/components/rehearsal/RehearsalApp";
import { RehearsalUpsell } from "@/components/rehearsal/RehearsalUpsell";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const { t } = await getI18n();
  return { title: `${t("rehearsal.title")} — ShapesOS`, description: t("rehearsal.subtitle") };
}

async function sourcesFor(actor: { workspaceId: string; userId: string; role: WorkspaceRole }): Promise<RehearsalSources> {
  const [meetings, notes, landingPages, sites] = await Promise.all([
    import("@/lib/comms/meet/meet.server")
      .then(({ listMeetings }) => listMeetings({ workspaceId: actor.workspaceId, userId: actor.userId, role: actor.role, name: null, email: null }, 100))
      .then((ms) => ms.filter((m) => m.hasTranscript).map((m) => ({ id: m.id, label: m.title })))
      .catch(() => []),
    import("@/lib/notes/service")
      .then(({ listNotes }) => listNotes(actor, { limit: 100 }))
      .then((ns) => ns.map((n) => ({ id: n.id, label: n.title || "Untitled note" })))
      .catch(() => []),
    withWorkspaceScope(actor.workspaceId, (tx) => tx.pageDraft.findMany({ where: { workspaceId: actor.workspaceId, kind: "landing" }, orderBy: { updatedAt: "desc" }, take: 100, select: { id: true, name: true } }))
      .then((ds) => ds.map((d) => ({ id: d.id, label: d.name })))
      .catch(() => []),
    prisma.site
      .findMany({ where: { project: { workspaceId: actor.workspaceId } }, orderBy: { updatedAt: "desc" }, take: 100, select: { id: true, name: true } })
      .then((ss) => ss.map((s) => ({ id: s.id, label: s.name })))
      .catch(() => []),
  ]);
  return { meetings, notes, landingPages, sites };
}

export default async function RehearsalPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await getMembership(user.id, workspace.id);
  if (!membership) redirect("/dashboard");
  if (!planHasFeature(await planOf(workspace.id), "dress_rehearsal")) {
    return <RehearsalUpsell canManageBilling={roleAtLeast(membership.role, "admin")} />;
  }
  const actor = { workspaceId: workspace.id, userId: user.id, role: membership.role };
  const [interviews, personas, runs, calibration, sources] = await Promise.all([listInterviews(actor), listPersonas(actor), listRuns(actor), calibrationSummary(actor), sourcesFor(actor)]);
  return (
    <RehearsalApp
      canEdit={roleAtLeast(membership.role, "editor")}
      initial={{ interviews, personas, runs, calibration }}
      sources={sources}
    />
  );
}
