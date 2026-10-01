// Marketr — workspace settings sub-navigation (milestone 21, part D1).
// Locked house style (Creative Studio): sub-tabs with Lucide icon + label,
// active = border-ink text-ink (never plain-text tabs).
// Client component so the active tab follows the current pathname.

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Bell,
  Bot,
  Brain,
  BrainCog,
  Cloud,
  FlaskConical,
  Gauge,
  Globe,
  Lock,
  Mail,
  Palette,
  PenLine,
  Plug,
  Scale,
  ScrollText,
  Shield,
  SlidersHorizontal,
  Terminal,
  Users,
  Wrench,
} from "lucide-react";

const LINKS = [
  { href: "/dashboard/settings/skills", label: "Skills", icon: Wrench },
  { href: "/dashboard/settings/connectors", label: "Connectors", icon: Plug },
  { href: "/dashboard/settings/mail", label: "Direct Mail", icon: Mail },
  { href: "/dashboard/settings/media", label: "Media safety", icon: Shield },
  { href: "/dashboard/settings/members", label: "Members", icon: Users },
  { href: "/dashboard/settings/providers", label: "Providers", icon: Cloud },
  { href: "/dashboard/settings/governance", label: "Governance", icon: Scale },
  { href: "/dashboard/settings/automation", label: "Automation", icon: Bot },
  // Phase 13B: agent learning surface (Memory + Personas).
  { href: "/dashboard/settings/agents", label: "Agents", icon: Brain },
  // Phase 12 (embeds): GrowthBook flags + Documenso signing requests.
  { href: "/dashboard/settings/experiments", label: "Experiments", icon: FlaskConical },
  { href: "/dashboard/settings/signing", label: "Signing", icon: PenLine },
  { href: "/dashboard/settings/security", label: "Security", icon: Lock },
  { href: "/dashboard/settings/notifications", label: "Notifications", icon: Bell },
  { href: "/dashboard/settings/defaults", label: "Defaults", icon: SlidersHorizontal },
  { href: "/dashboard/settings/api-mcp", label: "API / MCP", icon: Terminal },
  { href: "/dashboard/settings/audit", label: "Audit log", icon: ScrollText },
  { href: "/dashboard/settings/usage", label: "Usage", icon: Gauge },
  // Phase 13 A1: the two pages that used to live in the sidebar's separate
  // "Settings" island (alert rules, brand kits) are merged into this single
  // tab strip — every settings subpage is one click away from every other.
  { href: "/dashboard/settings/alerts", label: "Alert rules", icon: SlidersHorizontal },
  { href: "/dashboard/settings/brand-kits", label: "Brand kits", icon: Palette },
  // Phase 13B: company intelligence layer (Brand Voice, Knowledge, Style
  // Rules, Content) — lives under /dashboard/settings/brand/intelligence.
  { href: "/dashboard/settings/brand/intelligence", label: "Intelligence", icon: BrainCog },
  // Phase 13 Wave A (white-label ops): logo, custom domain, brand color.
  { href: "/dashboard/settings/white-label", label: "White-label", icon: Globe },
];

export default function SettingsNav() {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Workspace settings"
      className="mb-4 flex flex-wrap gap-1 border-b border-line"
    >
      {LINKS.map((l) => {
        const active = pathname === l.href || pathname.startsWith(`${l.href}/`);
        const Icon = l.icon;
        return (
          <Link
            key={l.href}
            href={l.href}
            aria-current={active ? "page" : undefined}
            className={`flex items-center gap-1.5 border-b-2 px-3 py-2 text-[13.5px] font-medium transition ${
              active
                ? "border-ink text-ink"
                : "border-transparent text-muted hover:text-ink"
            }`}
          >
            <Icon size={15} />
            {l.label}
          </Link>
        );
      })}
    </nav>
  );
}
