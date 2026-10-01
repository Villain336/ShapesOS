// Marketr — Wave 2 WFH mode: section tabs (server component).
// House pattern: Lucide icon + label, active = brand border + brand text.

import Link from "next/link";
import { Home, Bell, Timer, MessagesSquare, PartyPopper } from "lucide-react";

const TABS = [
  { slug: "mode", label: "Mode", icon: Home, href: "/dashboard/wfh" },
  { slug: "notifications", label: "Notifications", icon: Bell, href: "/dashboard/wfh/notifications" },
  { slug: "focus", label: "Focus time", icon: Timer, href: "/dashboard/wfh/focus" },
  { slug: "standups", label: "Standups", icon: MessagesSquare, href: "/dashboard/wfh/standups" },
  { slug: "rituals", label: "Rituals", icon: PartyPopper, href: "/dashboard/wfh/rituals" },
];

export default function WfhTabs({ active }: { active: string }) {
  return (
    <nav className="flex gap-1 border-b border-stone-200" aria-label="WFH mode sections">
      {TABS.map((t) => {
        const Icon = t.icon;
        const isActive = t.slug === active;
        return (
          <Link
            key={t.slug}
            href={t.href}
            className={`flex items-center gap-1.5 border-b-2 px-3 py-2 text-[13px] font-medium ${
              isActive
                ? "border-[var(--brand-600)] text-[var(--brand-700)]"
                : "border-transparent text-stone-500 hover:text-stone-800"
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
