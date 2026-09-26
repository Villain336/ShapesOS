// Marketr — CTV/commercials buying path (Phase 7 F4).
// Validator → per-spot QR/pURL kit → concierge IO → Vibe adapter →
// probabilistic attribution. Every spend action sits behind a Phase 5
// per-buy approval object.

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { CtvApp } from "@/components/flywheel/CtvApp";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "CTV Buying Path — Marketr",
  description: "CTV/commercials buying path: creative validator, QR/pURL kit, concierge IO, Vibe adapter, probabilistic attribution.",
};

export default async function CtvPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "viewer");
  if (!membership) redirect("/dashboard");

  return (
    <div className="flex h-full flex-col gap-4 bg-[#FAFAF7] p-4 md:p-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-stone-900">CTV buying path</h1>
          <p className="mt-0.5 text-[13px] text-stone-500">
            Validator → per-spot QR/pURL kit → concierge IO → Vibe API → probabilistic attribution.
            Every spend action sits behind a Phase 5 per-buy approval object.
          </p>
        </div>
      </header>
      <CtvApp />
    </div>
  );
}
