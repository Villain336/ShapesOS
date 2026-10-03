// ShapesOS — settings navigation (Phase 3: grouped).
// Two tiers: the six setting groups as pills (the current group is the
// pressed, solid-black one), then the current group's pages as tabs
// (active = black underline). Groups and pages come from settingsSections.ts,
// shared with the /dashboard/settings index. Client component so the active
// state follows the pathname.

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { SETTINGS_GROUPS, settingsLocation } from "./settingsSections";

export default function SettingsNav() {
  const pathname = usePathname();
  const onIndex = pathname === "/dashboard/settings";
  const { group: current, page: currentPage } = settingsLocation(pathname);

  return (
    <div className="mb-4 flex flex-col gap-3">
      <nav aria-label="Settings sections" className="flex flex-wrap gap-2">
        {SETTINGS_GROUPS.map((g) => {
          const active = !onIndex && g.id === current.id;
          const Icon = g.icon;
          return (
            <Link
              key={g.id}
              href={g.pages[0]!.href}
              aria-current={active ? "true" : undefined}
              className={`inline-flex h-chip items-center gap-1.5 rounded-full px-3 text-sm font-semibold transition-colors ${
                active ? "bg-ink text-paper" : "bg-paper text-ink shadow-control hover:shadow-outline"
              }`}
            >
              <Icon size={14} aria-hidden />
              {g.label}
            </Link>
          );
        })}
      </nav>
      {!onIndex && (
        <nav aria-label={`${current.label} settings`} className="flex flex-wrap gap-1 border-b border-line">
          {current.pages.map((p) => {
            const active = currentPage?.href === p.href;
            const Icon = p.icon;
            return (
              <Link
                key={p.href}
                href={p.href}
                aria-current={active ? "page" : undefined}
                className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-md font-medium transition-colors ${
                  active ? "border-ink text-ink" : "border-transparent text-muted hover:text-ink"
                }`}
              >
                <Icon size={15} aria-hidden />
                {p.label}
              </Link>
            );
          })}
        </nav>
      )}
    </div>
  );
}
