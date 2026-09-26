// Marketr — Phase 6 authority section layout: sub-nav across the seven tracks.

import { SectionNav, type SectionNavItem } from "../_components/SectionNav";

const NAV: SectionNavItem[] = [
  { href: "/dashboard/authority", label: "Overview", icon: "overview" },
  { href: "/dashboard/authority/outreach", label: "Outreach", icon: "outreach" },
  { href: "/dashboard/authority/pr", label: "Digital PR", icon: "pr" },
  { href: "/dashboard/authority/listings", label: "Listings", icon: "listings" },
  { href: "/dashboard/authority/aeo", label: "AEO", icon: "aeo" },
  { href: "/dashboard/authority/reviews", label: "Reviews", icon: "reviews" },
  { href: "/dashboard/authority/intelligence", label: "Intelligence", icon: "intelligence" },
];

export default function AuthorityLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col gap-4">
      <SectionNav items={NAV} ariaLabel="Authority sections" />
      {children}
    </div>
  );
}
