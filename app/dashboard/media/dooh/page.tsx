// Marketr — DOOH planner + concierge (Phase 5 B1).
// Planner UI: inventory, dayparts, budget with live estimate ranges
// (Blip first, Blindspot second, Adomni optional) + plans + launch packets.

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { DoohApp } from "./DoohApp";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "DOOH Planner — Marketr",
  description: "Plan digital out-of-home: Blip, Blindspot, Adomni. Estimate ranges, launch packets.",
};

export default async function DoohPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  await getOrCreateWorkspace(user.id, user.email);
  return (
    <div className="flex h-full flex-col gap-4 bg-[#FAFAF7] p-4 md:p-6">
      <div>
        <h1 className="aos-heading text-ink">DOOH Planner</h1>
        <p className="mt-0.5 text-[13px] text-muted">
          Plan digital billboards — Blip first, Blindspot second, Adomni optional. Estimates are
          planning ranges; execution happens in the client&apos;s own operator account from a
          launch packet. AdQuick API is parked — referral link to adquick.com self-serve only.
        </p>
      </div>
      <DoohApp />
    </div>
  );
}
