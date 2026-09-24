// Marketr — R6 prospecting & enrichment workspace.
import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { ProspectsApp } from "./ProspectsApp";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Prospects — Marketr",
  description: "Prospect lists, waterfall enrichment, AI research, and CRM conversion.",
};

export default async function ProspectsPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  await getOrCreateWorkspace(user.id, user.email);
  return (
    <div className="h-full bg-[#FAFAF7]">
      <ProspectsApp />
    </div>
  );
}
