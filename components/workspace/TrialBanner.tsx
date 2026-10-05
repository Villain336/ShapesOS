// ShapesOS — hosted trial notice above dashboard pages (Phase 3, I).
// Neutral (white, hairline): a trial is a billing state, not an agent
// state, so it never borrows the status colors. One action at the end.
// Admins get "Choose a plan" (the existing billing flow); everyone else is
// told who can fix it.

import Link from "next/link";
import { ArrowRight } from "lucide-react";

export function TrialBanner({
  trial,
  canManageBilling,
}: {
  trial: { daysLeft: number; endsOn: string | null; expired: boolean };
  canManageBilling: boolean;
}) {
  const text = trial.expired
    ? "Your ShapesOS trial has ended. Credit-using actions are paused; everything you made is still here."
    : `${trial.daysLeft} day${trial.daysLeft === 1 ? "" : "s"} left in your ShapesOS trial${trial.endsOn ? ` (ends ${trial.endsOn})` : ""}.`;
  return (
    <div
      role={trial.expired ? "alert" : "status"}
      className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-paper px-4 py-3 shadow-hairline"
    >
      <p className="text-md text-ink">{text}</p>
      {canManageBilling ? (
        <Link
          href="/dashboard/billing"
          className="inline-flex h-control-sm items-center gap-1.5 rounded-full bg-ink px-4 text-sm font-semibold text-paper aos-press"
        >
          Choose a plan
          <ArrowRight size={14} aria-hidden />
        </Link>
      ) : (
        <p className="text-sm text-muted">Ask a workspace admin to choose a plan.</p>
      )}
    </div>
  );
}
