// Marketr — Phase 18 slice 1: campaigns placeholder.
// The unified campaign surface lands with the platform connector slices
// (2–5). Slice 1 ships the ontology + approval plumbing.

import { redirect } from "next/navigation";
import { Megaphone } from "lucide-react";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import AdsTabs from "../_components/AdsTabs";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Campaigns — Marketr",
  description: "Unified campaigns across all ad platforms.",
};

export default async function CampaignsPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "viewer");
  if (!membership) redirect("/dashboard");

  return (
    <div className="flex h-full flex-col gap-4 bg-[#FAFAF7] p-4 md:p-6">
      <div>
        <h1 className="text-xl font-bold tracking-tight text-stone-900">Campaigns</h1>
        <p className="mt-0.5 text-[13px] text-stone-500">
          One campaign object model across Amazon Ads, StackAdapt, Walmart Connect, and Spotify.
        </p>
      </div>
      <AdsTabs active="campaigns" />
      <div className="flex flex-col items-center gap-2 rounded-lg border border-stone-200 bg-white px-6 py-12 text-center">
        <Megaphone className="h-8 w-8 text-stone-300" />
        <p className="text-[14px] font-medium text-stone-700">Campaign connectors land in slices 2–5</p>
        <p className="max-w-sm text-[13px] text-stone-500">
          Amazon Ads, StackAdapt, Walmart Connect, and the Spotify guided flow each light up this surface in their own slice. The proposal inbox is live now.
        </p>
      </div>
    </div>
  );
}
