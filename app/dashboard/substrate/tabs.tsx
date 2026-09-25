// Marketr — Phase 8: violet sub-tab bars with Lucide icons.
// Exact pattern copied from Creative Studio (StudioApp.tsx): icon + label,
// active = border-violet-600 text-violet-700.
//
// The nav configs (icon component references, activeOn functions) MUST live
// in this client module. Server components cannot pass component references
// or functions across the "use client" boundary — React throws
// "Functions cannot be passed directly to Client Components".

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { LucideIcon } from "lucide-react";
import {
  Network,
  Megaphone,
  Brain,
  Compass,
  ScanSearch,
  Plug,
  Link2,
  Plus,
  Lightbulb,
  Search,
  ScrollText,
  RefreshCw,
  BookOpen,
} from "lucide-react";

interface SubTab {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Override active detection. Default: exact match or any child path. */
  activeOn?: (pathname: string) => boolean;
}

const defaultActive = (href: string) => (p: string) => p === href || p.startsWith(href + "/");

function SubstrateTabs({ items, label }: { items: SubTab[]; label: string }) {
  const pathname = usePathname();
  return (
    <div
      className="mb-4 flex flex-wrap gap-1 border-b border-stone-200"
      role="navigation"
      aria-label={label}
    >
      {items.map(({ href, label: tabLabel, icon: Icon, activeOn }) => {
        const active = (activeOn ?? defaultActive(href))(pathname);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={`flex items-center gap-1.5 border-b-2 px-3 py-2 text-[13.5px] font-medium transition ${
              active
                ? "border-violet-600 text-violet-700"
                : "border-transparent text-stone-500 hover:text-stone-800"
            }`}
          >
            <Icon size={15} />
            {tabLabel}
          </Link>
        );
      })}
    </div>
  );
}

/** Top-level substrate track nav: Business Graph / Campaigns / Growth Memory. */
export function SubstrateNavTabs() {
  const items: SubTab[] = [
    { href: "/dashboard/substrate/graph", label: "Business Graph", icon: Network },
    { href: "/dashboard/substrate/campaigns", label: "Campaigns", icon: Megaphone },
    { href: "/dashboard/substrate/memory", label: "Growth Memory", icon: Brain },
  ];
  return <SubstrateTabs items={items} label="Substrate sections" />;
}

/** Business Graph section nav. Explorer is active only on the exact graph route. */
export function GraphTabs() {
  const items: SubTab[] = [
    {
      href: "/dashboard/substrate/graph",
      label: "Explorer",
      icon: Compass,
      activeOn: (p) => p === "/dashboard/substrate/graph",
    },
    { href: "/dashboard/substrate/graph/er-queue", label: "ER review queue", icon: ScanSearch },
    { href: "/dashboard/substrate/graph/connectors", label: "Connectors", icon: Plug },
  ];
  return <SubstrateTabs items={items} label="Business Graph sections" />;
}

const CAMPAIGNS_BASE = "/dashboard/substrate/campaigns";

/** Campaign object section nav. Stays active on /campaigns/[id] detail pages. */
export function CampaignTabs() {
  const items: SubTab[] = [
    {
      href: CAMPAIGNS_BASE,
      label: "Campaigns",
      icon: Megaphone,
      activeOn: (p: string) =>
        p === CAMPAIGNS_BASE || new RegExp(`^${CAMPAIGNS_BASE}/[^/]+$`).test(p),
    },
    { href: `${CAMPAIGNS_BASE}/proposals`, label: "Link proposals", icon: Link2 },
    { href: `${CAMPAIGNS_BASE}/new`, label: "New campaign", icon: Plus },
  ];
  return <SubstrateTabs items={items} label="Campaign object sections" />;
}

/** Growth Memory section nav. */
export function MemoryTabs() {
  const items: SubTab[] = [
    { href: "/dashboard/substrate/memory/learnings", label: "Learnings", icon: Lightbulb },
    { href: "/dashboard/substrate/memory/recall", label: "Recall playground", icon: Search },
    { href: "/dashboard/substrate/memory/episodes", label: "Episodes", icon: ScrollText },
    { href: "/dashboard/substrate/memory/consolidation", label: "Consolidation", icon: RefreshCw },
    { href: "/dashboard/substrate/memory/playbook", label: "Playbook", icon: BookOpen },
  ];
  return <SubstrateTabs items={items} label="Growth Memory sections" />;
}
