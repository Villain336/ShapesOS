// Marketr — shared dashboard section sub-nav (client).
// Studio-style bottom-border tabs with a Lucide icon + label; the active
// tab is border-violet-600 text-violet-700. Icon mapping lives here so
// server layouts only pass serializable href/label/icon keys.

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Mail,
  Newspaper,
  MapPin,
  Sparkles,
  Star,
  Brain,
  ArrowLeftRight,
  Recycle,
  FlaskConical,
  Tv,
  Radio,
  Rocket,
  type LucideIcon,
} from "lucide-react";

const ICONS: Record<string, LucideIcon> = {
  overview: LayoutDashboard,
  outreach: Mail,
  pr: Newspaper,
  listings: MapPin,
  aeo: Sparkles,
  reviews: Star,
  intelligence: Brain,
  reallocation: ArrowLeftRight,
  recycling: Recycle,
  tests: FlaskConical,
  ctv: Tv,
  dsp: Radio,
  launch: Rocket,
};

export interface SectionNavItem {
  href: string;
  label: string;
  icon: string;
}

export function SectionNav({ items, ariaLabel }: { items: SectionNavItem[]; ariaLabel: string }) {
  const pathname = usePathname();
  return (
    <nav className="mb-4 flex gap-1 border-b border-stone-200" aria-label={ariaLabel}>
      {items.map((n) => {
        const active = pathname === n.href;
        const Icon = ICONS[n.icon] ?? LayoutDashboard;
        return (
          <Link
            key={n.href}
            href={n.href}
            aria-current={active ? "page" : undefined}
            className={`flex items-center gap-1.5 border-b-2 px-3 py-2 text-[13.5px] font-medium transition ${
              active
                ? "border-violet-600 text-violet-700"
                : "border-transparent text-stone-500 hover:text-stone-800"
            }`}
          >
            <Icon size={15} />
            {n.label}
          </Link>
        );
      })}
    </nav>
  );
}
