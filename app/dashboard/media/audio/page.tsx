// Marketr — Streaming audio planner + briefs (Phase 5 B2).
// Concierge planning + self-serve execution: Spotify Ads Manager, Acast,
// AudioGo. The brief hands the client a budget and spot plan; Marketr
// never touches the spend.

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { AudioApp } from "./AudioApp";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Streaming Audio — Marketr",
  description: "Plan streaming-audio buys: Spotify Ads Manager, Acast, AudioGo. Generated briefs.",
};

export default async function AudioPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  await getOrCreateWorkspace(user.id, user.email);
  return (
    <div className="flex h-full flex-col gap-4 bg-[#FAFAF7] p-4 md:p-6">
      <div>
        <h1 className="aos-heading text-ink">Streaming Audio</h1>
        <p className="mt-0.5 text-[13px] text-muted">
          The executable leg — plan in Marketr, launch in the client&apos;s own account. Spotify Ads
          Manager (min €15/day, €250 lifetime) · Acast ($250 min) · AudioGo ($250 min). Fake/test
          mode by default; no real spend without an explicit per-buy approval.
        </p>
      </div>
      <AudioApp />
    </div>
  );
}
