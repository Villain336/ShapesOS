// Marketr — Radio/newspaper IO-brief concierge (Phase 5 B3).
// Broadcast radio and print stay rep-driven: Marketr generates the
// IAB/AAAA-style IO brief, tracks signature state, and closes the loop
// with proof-of-run. Magazines are planning-only in v1.

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { RadioPrintApp } from "./RadioPrintApp";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Radio & Print IOs — ShapesOS",
  description: "IO-brief concierge for broadcast radio and print. Signature tracking and proof-of-run.",
};

export default async function RadioPrintPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  await getOrCreateWorkspace(user.id, user.email);
  return (
    <div className="flex h-full flex-col gap-4 bg-canvas p-4 md:p-6">
      <div>
        <h1 className="aos-heading text-ink">Radio &amp; Print IOs</h1>
        <p className="mt-0.5 text-[13px] text-muted">
          Rep-driven inventory needs a concierge, not a checkout. Generate the IO brief with the
          maximum amount to be spent as the binding term, track the signature back from the rep,
          and attach proof-of-run. Magazines are planning-only in v1.
        </p>
      </div>
      <RadioPrintApp />
    </div>
  );
}
