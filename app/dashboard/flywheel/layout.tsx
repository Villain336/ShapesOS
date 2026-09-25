// Marketr — Phase 7 flywheel section layout: sub-nav across the six tracks.
// Mirrors app/dashboard/authority/layout.tsx conventions.

import Link from "next/link";

const NAV = [
  { href: "/dashboard/flywheel", label: "Overview" },
  { href: "/dashboard/flywheel/reallocation", label: "Reallocation" },
  { href: "/dashboard/flywheel/recycling", label: "Recycling" },
  { href: "/dashboard/flywheel/tests", label: "Test Lab" },
  { href: "/dashboard/flywheel/ctv", label: "CTV" },
  { href: "/dashboard/flywheel/dsp", label: "DSP" },
  { href: "/dashboard/flywheel/launch", label: "Launch" },
];

export default function FlywheelLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-6">
      <nav className="flex flex-wrap gap-1 border-b pb-3" aria-label="Flywheel sections">
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
