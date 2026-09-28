// Marketr — Phase 13D: consent management page.
import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { ConsentApp } from "./ConsentApp";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Consent — Marketr",
  description: "Per-lead, per-channel consent for voice outreach.",
};

export default async function ConsentPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  await getOrCreateWorkspace(user.id, user.email);
  return (
    <div className="flex h-full flex-col gap-4 bg-[#FAFAF7] p-4 md:p-6">
      <ConsentApp />
    </div>
  );
}
