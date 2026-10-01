// Marketr — Clips home (Phase 13C "Clipper").
// Source library → scored clip drafts → brand-styled captions → Postiz drafts.

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { ClipsApp } from "./ClipsApp";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Clips — Marketr",
  description: "Turn long videos into viral shorts: scored clip drafts, brand-styled captions, approved-to-Postiz handoff.",
};

export default async function ClipsPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  await getOrCreateWorkspace(user.id, user.email);
  return (
    <div className="flex h-full flex-col gap-4 bg-canvas p-4 md:p-6">
      <div>
        <h1 className="aos-heading">Clips</h1>
        <p className="mt-0.5 text-[13px] text-muted">
          Turn long videos into viral shorts — scored, captioned in your brand, approved by you.
        </p>
      </div>
      <ClipsApp />
    </div>
  );
}
