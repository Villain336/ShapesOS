// Marketr — Phase 18 slice 1: Advertising section tabs (Grow pillar).
// Server component: each page passes its active tab.

import Link from "next/link";
import { LayoutDashboard, Inbox, Megaphone, BarChart3 } from "lucide-react";

const TABS = [
  { slug: "overview", label: "Overview", icon: LayoutDashboard, href: "/dashboard/media/advertising" },
  { slug: "proposals", label: "Proposals", icon: Inbox, href: "/dashboard/media/advertising/proposals" },
  { slug: "campaigns", label: "Campaigns", icon: Megaphone, href: "/dashboard/media/advertising/campaigns" },
  { slug: "reports", label: "Reports", icon: BarChart3, href: "/dashboard/media/advertising/reports" },
];

export default function AdsTabs({ active }: { active: string }) {
  return (
    <nav className="flex gap-1 border-b border-line" aria-label="Advertising sections">
      {TABS.map((t) => {
        const Icon = t.icon;
        const isActive = t.slug === active;
        return (
          <Link
            key={t.slug}
            href={t.href}
            aria-current={isActive ? "page" : undefined}
            className={`flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-semibold ${
              isActive ? "border-ink text-ink" : "border-transparent text-muted hover:text-ink"
            }`}
          >
            <Icon className="h-3.5 w-3.5" />
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
