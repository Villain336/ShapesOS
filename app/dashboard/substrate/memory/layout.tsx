// Marketr — Phase 8 G3: Growth Memory section layout (SPEC-PHASE8.md §6).
// House pattern: sub-tab nav, plain cards, badges top-right, light mode.

import Link from "next/link";

const NAV = [
  { href: "/dashboard/substrate/memory/learnings", label: "Learnings" },
  { href: "/dashboard/substrate/memory/recall", label: "Recall playground" },
  { href: "/dashboard/substrate/memory/episodes", label: "Episodes" },
  { href: "/dashboard/substrate/memory/consolidation", label: "Consolidation" },
  { href: "/dashboard/substrate/memory/playbook", label: "Playbook" },
];

export default function MemoryLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Growth Memory</h1>
        <p className="text-sm text-muted-foreground">
          What the workspace has learned — searchable, attributable, and honest about its age.
        </p>
      </div>
      <nav className="flex flex-wrap gap-1 border-b pb-3" aria-label="Growth Memory sections">
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
