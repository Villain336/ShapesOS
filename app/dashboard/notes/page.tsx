// ShapesOS — Phase 18.2 (WS=content): Notes (/dashboard/notes).
// Any member: their own notes plus the workspace's shared notes
// (lib/notes/service.ts). ?note=<id> opens one (Spotlight and record links
// land here).

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { getMembership } from "@/lib/authz";
import { getI18n } from "@/lib/i18n/server";
import { getNote, listNotes, noteFacets } from "@/lib/notes/service";
import { NotesApp } from "@/components/notes/NotesApp";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const { t } = await getI18n();
  return { title: `${t("notes.title")} — ShapesOS`, description: t("notes.subtitle") };
}

export default async function NotesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await getMembership(user.id, workspace.id);
  if (!membership) redirect("/dashboard");
  const actor = { workspaceId: workspace.id, userId: user.id, role: membership.role };
  const sp = await searchParams;
  const noteId = typeof sp.note === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(sp.note) ? sp.note : null;
  const [notes, facets, note] = await Promise.all([
    listNotes(actor, { limit: 150 }),
    noteFacets(actor),
    noteId ? getNote(actor, noteId) : Promise.resolve(null),
  ]);
  return <NotesApp initialNotes={notes} initialFacets={facets} initialNote={note} />;
}
