// ShapesOS — Phase 11 (bizsync): Settings → Connectors → Business sync.
// Admin+ only (server-gated, like the Connectors page). Sync status, last
// run, errors, and the mappings a person confirms for Shopify, QuickBooks,
// Xero and (Phase 14) Gusto employees.

import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import SettingsNav from "@/components/settings/SettingsNav";
import BizSyncManager from "@/components/settings/BizSyncManager";

export const dynamic = "force-dynamic";

export default async function BusinessSyncPage({ searchParams }: { searchParams: Promise<{ provider?: string }> }) {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "admin");
  if (!membership) redirect("/dashboard");
  const { provider } = await searchParams;
  const initial = provider === "quickbooks" || provider === "xero" || provider === "shopify" || provider === "gusto" ? provider : undefined;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/dashboard/settings/connectors" className="inline-flex items-center gap-1 text-[13px] font-semibold text-muted hover:text-ink">
          <ArrowLeft size={14} aria-hidden="true" /> Connectors
        </Link>
        <h1 className="aos-heading mt-1">Business sync</h1>
        <p className="mt-0.5 text-[13px] text-muted">
          {workspace.name} — Shopify, QuickBooks, Xero and Gusto: what is mapped, when it last ran, and what needs you.
        </p>
      </div>
      <SettingsNav />
      <BizSyncManager workspaceId={workspace.id} initialProvider={initial} />
    </div>
  );
}
