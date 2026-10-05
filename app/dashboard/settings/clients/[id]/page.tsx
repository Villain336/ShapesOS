// ShapesOS — Phase 10 (portal): Settings → Clients → one client's portal
// access: the portal switch, which CRM records the client sees, and their
// portal sessions (admin+; the API enforces it).

import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { getMembership, roleAtLeast } from "@/lib/authz";
import SettingsNav from "@/components/settings/SettingsNav";
import ClientPortalAccess from "@/components/workspace/ClientPortalAccess";

export const dynamic = "force-dynamic";

export const metadata = { title: "Client portal access — ShapesOS" };

export default async function ClientPortalSettingsPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const me = await getMembership(user.id, workspace.id);
  if (!me) redirect("/dashboard");
  if (!roleAtLeast(me.role, "admin")) redirect("/dashboard/settings/clients");
  const { id } = await params;
  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/dashboard/settings/clients" className="inline-flex items-center gap-1.5 text-sm font-semibold text-muted hover:text-ink">
          <ArrowLeft size={14} aria-hidden /> Clients
        </Link>
        <h1 className="aos-heading mt-2">Client portal access</h1>
        <p className="mt-0.5 text-sm text-muted">
          What this client sees when they sign in at <span className="aos-mono">/portal</span>. Nothing is visible until you link it here.
        </p>
      </div>
      <SettingsNav />
      <ClientPortalAccess clientId={id} />
    </div>
  );
}
