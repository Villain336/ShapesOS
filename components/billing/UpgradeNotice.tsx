// ShapesOS — "not in your plan" notice (Phase 4a entitlements).
// Neutral (white, hairline) like the trial banner: a plan limit is a billing
// state, not an agent state, so it never borrows the status colors. One
// action at the end: admins go to Billing; everyone else is told who can.

import Link from "next/link";
import { ArrowRight } from "lucide-react";

export function UpgradeNotice({
  message,
  canManageBilling = true,
}: {
  message: string;
  canManageBilling?: boolean;
}) {
  return (
    <div
      role="status"
      className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-paper px-4 py-3 shadow-hairline"
    >
      <p className="text-sm text-ink">{message}</p>
      {canManageBilling ? (
        <Link
          href="/dashboard/billing"
          className="inline-flex h-control-sm items-center gap-1.5 rounded-full bg-ink px-4 text-sm font-semibold text-paper aos-press"
        >
          See plans
          <ArrowRight size={14} aria-hidden />
        </Link>
      ) : (
        <p className="text-sm text-muted">Ask a workspace admin to upgrade.</p>
      )}
    </div>
  );
}
