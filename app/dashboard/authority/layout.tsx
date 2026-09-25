// Marketr — Phase 6 authority section layout: sub-nav across the six tracks.

import Link from "next/link";

const NAV = [
  { href: "/dashboard/authority", label: "Overview" },
  { href: "/dashboard/authority/outreach", label: "Outreach" },
  { href: "/dashboard/authority/pr", label: "Digital PR" },
  { href: "/dashboard/authority/listings", label: "Listings" },
  { href: "/dashboard/authority/aeo", label: "AEO" },
  { href: "/dashboard/authority/reviews", label: "Reviews" },
  { href: "/dashboard/authority/intelligence", label: "Intelligence" },
];

export default function AuthorityLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-6">
      <nav className="flex flex-wrap gap-1 border-b pb-3" aria-label="Authority sections">
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
