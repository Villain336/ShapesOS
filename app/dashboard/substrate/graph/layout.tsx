// Marketr — Phase 8 G1: Business Graph section layout (SPEC-PHASE8.md §6).
// House pattern: sub-tab nav, plain cards, badges top-right, light mode.

import Link from "next/link";

const NAV = [
  { href: "/dashboard/substrate/graph", label: "Explorer" },
  { href: "/dashboard/substrate/graph/er-queue", label: "ER review queue" },
  { href: "/dashboard/substrate/graph/connectors", label: "Connectors" },
];

export default function GraphLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-6">
      <nav className="flex flex-wrap gap-1 border-b pb-3" aria-label="Business Graph sections">
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
