// ShapesOS — Settings → Clients (Phase 3, workstream I): agency client
// records. Any member can see the list; admins manage it (API-enforced).

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { getMembership } from "@/lib/authz";
import SettingsNav from "@/components/settings/SettingsNav";
import ClientsManager from "@/components/workspace/ClientsManager";

export const dynamic = "force-dynamic";

export const metadata = { title: "Clients — ShapesOS" };

export default async function ClientsSettingsPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await getMembership(user.id, workspace.id))) redirect("/dashboard");

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="aos-heading">Clients</h1>
        <p className="mt-0.5 text-sm text-muted">
          {workspace.name}: the businesses you run marketing for, who signs in to see their reports, and how often
          reports go out.
        </p>
      </div>
      <SettingsNav />
      <ClientsManager />
    </div>
  );
}
