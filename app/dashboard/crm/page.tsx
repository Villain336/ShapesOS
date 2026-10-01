// Marketr CRM — lead pipeline workspace (Phase 1, R1).
import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { CrmApp } from "@/components/crm/CrmApp";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "CRM — Marketr",
  description: "Lead pipeline CRM: leads, pipeline board, forecast, and capture forms.",
};

export default async function CrmPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  await getOrCreateWorkspace(user.id, user.email);
  return (
    <div className="h-full bg-canvas">
      <CrmApp />
    </div>
  );
}
