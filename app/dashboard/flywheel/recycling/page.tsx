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
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Creative recycling</h1>
          <p className="text-sm text-muted-foreground">
            Winners from attribution, QR scans, AEO, and direct mail become cross-channel briefs.
            Recycling proposes — a human approves every variant before it enters the studio flows.
          </p>
        </div>
      </div>
      <RecyclingApp />
    </div>
  );
}
