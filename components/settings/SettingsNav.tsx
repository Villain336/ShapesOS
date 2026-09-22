// Marketr — workspace settings sub-navigation (milestone 21, part D1).
// app/dashboard/settings has no layout nav, so every settings page renders
// this server component at the top linking the sections.

import Link from "next/link";

const LINKS = [
  { href: "/dashboard/settings/skills", label: "Skills" },
  { href: "/dashboard/settings/connectors", label: "Connectors" },
  { href: "/dashboard/settings/members", label: "Members" },
  { href: "/dashboard/settings/providers", label: "Providers" },
  { href: "/dashboard/settings/governance", label: "Governance" },
  { href: "/dashboard/settings/security", label: "Security" },
  { href: "/dashboard/settings/notifications", label: "Notifications" },
  { href: "/dashboard/settings/defaults", label: "Defaults" },
  { href: "/dashboard/settings/audit", label: "Audit log" },
];

export default function SettingsNav() {
  return (
    <nav
      aria-label="Workspace settings"
      className="flex flex-wrap gap-1 rounded-xl border border-zinc-200 bg-white/60 p-1.5"
    >
      {LINKS.map((l) => (
        <Link
          key={l.href}
          href={l.href}
          className="rounded-md px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900"
        >
          {l.label}
        </Link>
      ))}
    </nav>
  );
}
