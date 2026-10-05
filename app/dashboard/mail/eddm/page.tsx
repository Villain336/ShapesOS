// Marketr — EDDM concierge workspace (Phase 4, Track T3).
import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { EddmApp } from "./EddmApp";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "EDDM Concierge — ShapesOS",
  description:
    "Every Door Direct Mail concierge: carrier routes, creative, cost estimate, drop scheduling, mailhouse handoff brief, status tracking.",
};

export default async function EddmPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  await getOrCreateWorkspace(user.id, user.email);
  return (
    <div className="flex h-full flex-col gap-4 bg-canvas p-4 md:p-6">
      <div>
        <h1 className="aos-heading">EDDM Concierge</h1>
        <p className="mt-1 text-sm text-muted">
          Every Door Direct Mail, planned end-to-end: carrier routes → creative → cost estimate →
          drop scheduling → mailhouse handoff brief → status tracking. There is no USPS EDDM API —
          your mailhouse executes the drop; ShapesOS prepares everything they need.
        </p>
      </div>
      <EddmApp />
    </div>
  );
}
