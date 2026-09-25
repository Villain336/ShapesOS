// Marketr — Creative Studio home (Phase 4, T2).
// The central home for all creative and design work across Marketr, powered by
// Canva. v1: print/mail creative + asset library, architected so email/social
// channel templates plug in later without rework.

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { StudioApp } from "./StudioApp";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Creative Studio — Marketr",
  description: "The central home for all creative and design work across Marketr: mail/print creatives, asset library, and Canva.",
};

export default async function StudioPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  await getOrCreateWorkspace(user.id, user.email);
  return (
    <div className="flex h-full flex-col gap-4 bg-[#FAFAF7] p-4 md:p-6">
      <div>
        <h1 className="text-xl font-bold tracking-tight text-stone-900">Creative Studio</h1>
        <p className="mt-0.5 text-[13px] text-stone-500">
          The central home for all creative and design work across Marketr — powered by Canva.
          v1 ships print/mail creative plus the asset library; email and social templates plug in later.
        </p>
      </div>
      <StudioApp />
    </div>
  );
}
