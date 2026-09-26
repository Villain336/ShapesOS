// Marketr — Creative recycling pipeline (Phase 7, F2).
// Trigger signals → recycling briefs with creative-hash lineage → human
// approval routes variants into the studio approval flows.

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { RecyclingApp } from "./RecyclingApp";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Creative Recycling — Marketr",
  description: "Winning creative propagates across channels — briefs, lineage, and human-gated variant approval.",
};

export default async function RecyclingPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  await getOrCreateWorkspace(user.id, user.email);
  return (
    <div className="flex h-full flex-col gap-4 bg-[#FAFAF7] p-4 md:p-6">
      <header>
        <h1 className="text-xl font-bold tracking-tight text-stone-900">Creative recycling</h1>
        <p className="mt-0.5 text-[13px] text-stone-500">
          Winners from attribution, QR scans, AEO, and direct mail become cross-channel briefs.
          Recycling proposes — a human approves every variant before it enters the studio flows.
        </p>
      </header>
      <RecyclingApp />
    </div>
  );
}
