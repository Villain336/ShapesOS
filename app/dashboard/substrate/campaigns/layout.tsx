// Marketr — Phase 8 G2 campaign object section layout: sub-nav.
// Mirrors app/dashboard/flywheel/layout.tsx conventions (house pattern:
// sub-tab nav, plain cards, badges top-right, light mode).

import Link from "next/link";

const NAV = [
  { href: "/dashboard/substrate/campaigns", label: "Campaigns" },
  { href: "/dashboard/substrate/campaigns/proposals", label: "Link proposals" },
  { href: "/dashboard/substrate/campaigns/new", label: "New campaign" },
];

export default function CampaignsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-6">
      <nav className="flex flex-wrap gap-1 border-b pb-3" aria-label="Campaign object sections">
        {NAV.map((n) => (
          <Link
            key={n.href}
            href={n.href}
            className="rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            {n.label}
          </Link>
        ))}
      </nav>
      {children}
    </div>
  );
}
