// Marketr — Wave 2 WFH mode: section tabs (server component).
// Agentic OS: Lucide icon + label, active = ink underline + ink text.

import Link from "next/link";
import { Home, Bell, Timer, MessagesSquare, PartyPopper, Receipt, Sun } from "lucide-react";

const TABS = [
  { slug: "day", label: "Day", icon: Sun, href: "/dashboard/wfh/day" },
  { slug: "mode", label: "Mode", icon: Home, href: "/dashboard/wfh" },
  { slug: "notifications", label: "Notifications", icon: Bell, href: "/dashboard/wfh/notifications" },
  { slug: "focus", label: "Focus time", icon: Timer, href: "/dashboard/wfh/focus" },
  { slug: "standups", label: "Standups", icon: MessagesSquare, href: "/dashboard/wfh/standups" },
  { slug: "rituals", label: "Rituals", icon: PartyPopper, href: "/dashboard/wfh/rituals" },
  { slug: "expenses", label: "Expenses", icon: Receipt, href: "/dashboard/wfh/expenses" },
];

export default function WfhTabs({ active }: { active: string }) {
  return (
    <nav className="flex gap-1 border-b border-line" aria-label="WFH mode sections">
      {TABS.map((t) => {
        const Icon = t.icon;
        const isActive = t.slug === active;
        return (
          <Link
            key={t.slug}
            href={t.href}
            className={`flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium ${
              isActive
                ? "border-ink text-ink"
                : "border-transparent text-muted hover:text-ink"
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
