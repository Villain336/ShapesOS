// Marketr — Phase 8: substrate section layout (SPEC-PHASE8.md §6).
// Shared sub-tab nav across the three substrate tracks: Business Graph (G1),
// Campaign object (G2), Growth Memory (G3). Additive — each track keeps its
// own layout underneath. House pattern: sub-tab nav, light mode.

import Link from "next/link";

const NAV = [
  { href: "/dashboard/substrate/graph", label: "Business Graph" },
  { href: "/dashboard/substrate/campaigns", label: "Campaigns" },
  { href: "/dashboard/substrate/memory", label: "Growth Memory" },
];

export default function SubstrateLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-6">
      <nav className="flex flex-wrap gap-1 border-b pb-3" aria-label="Substrate sections">
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
