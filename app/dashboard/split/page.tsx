// ShapesOS — Phase 18.1 (WS=desk): split view.
// /dashboard/split?left=<path>&right=<path>&ratio=<20–80>
// Any dashboard page or record next to the Assistant or another record.
// The panes are this app's own pages (lib/desktop/split.ts validates them);
// each pane enforces its own page's access as usual. Viewer+.

import { redirect } from "next/navigation";
import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { getMembership } from "@/lib/authz";
import { listRecents } from "@/lib/desktop/store.server";
import { parseSplit } from "@/lib/desktop/split";
import { SplitView } from "@/components/desk/SplitView";
import { getI18n } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const { t } = await getI18n();
  return { title: `${t("desk.split.title")} — ShapesOS`, description: t("desk.split.metaDescription") };
}

export default async function SplitPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const me = await getMembership(user.id, workspace.id);
  if (!me) redirect("/dashboard");
  const sp = await searchParams;
  const one = (k: string) => {
    const v = sp[k];
    return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
  };
  const initial = parseSplit({ get: one });
  const recents = await listRecents(workspace.id, user.id).catch(() => []);
  return <SplitView initial={initial} recents={recents} role={me.role} />;
}
