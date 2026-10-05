// Marketr CRM — lead pipeline workspace (Phase 1, R1).
// Phase 10 (ops-core): the operations tabs moved to /dashboard/ops; old
// deep links (?tab=invoicing&invoice=…, ?tab=inventory, …) redirect there.
import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { CrmApp } from "@/components/crm/CrmApp";
import { legacyCrmRedirect } from "@/lib/ops/sections";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "CRM — ShapesOS",
  description: "Lead pipeline CRM: leads, contacts, companies, deals, pipeline board, forecast, and capture forms.",
};

export default async function CrmPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  if (!user) redirect("/login");
  const moved = legacyCrmRedirect(await searchParams);
  if (moved) redirect(moved);
  await getOrCreateWorkspace(user.id, user.email);
  return (
    <div className="h-full bg-canvas">
      <CrmApp />
    </div>
  );
}
