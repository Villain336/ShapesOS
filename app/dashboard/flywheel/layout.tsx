// Marketr — Phase 7 flywheel section layout: sub-nav across the seven tracks.
// Mirrors app/dashboard/authority/layout.tsx conventions.

import { SectionNav, type SectionNavItem } from "../_components/SectionNav";

const NAV: SectionNavItem[] = [
  { href: "/dashboard/flywheel", label: "Overview", icon: "overview" },
  { href: "/dashboard/flywheel/reallocation", label: "Reallocation", icon: "reallocation" },
  { href: "/dashboard/flywheel/recycling", label: "Recycling", icon: "recycling" },
  { href: "/dashboard/flywheel/tests", label: "Test Lab", icon: "tests" },
  { href: "/dashboard/flywheel/ctv", label: "CTV", icon: "ctv" },
  { href: "/dashboard/flywheel/dsp", label: "DSP", icon: "dsp" },
  { href: "/dashboard/flywheel/launch", label: "Launch", icon: "launch" },
];

export default function FlywheelLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col gap-4">
      <SectionNav items={NAV} ariaLabel="Flywheel sections" />
      {children}
    </div>
  );
}
