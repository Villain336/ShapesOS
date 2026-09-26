// Marketr — workspace settings sub-navigation (milestone 21, part D1).
// Locked house style (Creative Studio): sub-tabs with Lucide icon + label,
// active = border-violet-600 text-violet-700 (never plain-text tabs).
// Client component so the active tab follows the current pathname.

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Bell,
  Bot,
  Cloud,
  Gauge,
  Lock,
  Mail,
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
  { href: "/dashboard/settings/security", label: "Security", icon: Lock },
  { href: "/dashboard/settings/notifications", label: "Notifications", icon: Bell },
  { href: "/dashboard/settings/defaults", label: "Defaults", icon: SlidersHorizontal },
  { href: "/dashboard/settings/api-mcp", label: "API / MCP", icon: Terminal },
  { href: "/dashboard/settings/audit", label: "Audit log", icon: ScrollText },
  { href: "/dashboard/settings/usage", label: "Usage", icon: Gauge },
];

export default function SettingsNav() {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Workspace settings"
      className="mb-4 flex flex-wrap gap-1 border-b border-stone-200"
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
                ? "border-violet-600 text-violet-700"
                : "border-transparent text-stone-500 hover:text-stone-800"
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
