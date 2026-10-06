// ShapesOS — Phase 18.1 (WS=desk): Switch app (⌘K → "Switch app").
// The ⌃Tab switcher's list as a page: the member's recent apps and records,
// then their pins. Viewer+ (the member's own recents; owner-only RLS).

import { redirect } from "next/navigation";
import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { getMembership } from "@/lib/authz";
import { getDesk, listRecents } from "@/lib/desktop/store.server";
import { SwitchList } from "@/components/desk/SwitchList";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Switch app — ShapesOS",
  description: "Jump back to a recent app or record.",
};

export default async function SwitchPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const me = await getMembership(user.id, workspace.id);
  if (!me) redirect("/dashboard");
  const [desk, recents] = await Promise.all([getDesk(workspace.id, user.id, me.role), listRecents(workspace.id, user.id, 12)]);
  return (
    <div className="mx-auto flex w-full max-w-[640px] flex-col gap-4">
      <div>
        <h1 className="aos-heading">Switch app</h1>
        <p className="mt-1 text-sm text-muted">Where you were last. Pick one, or open it beside another page in split view.</p>
      </div>
      <SwitchList role={me.role} initialDock={{ pinned: desk.nav.pinned, recents }} />
    </div>
  );
}
