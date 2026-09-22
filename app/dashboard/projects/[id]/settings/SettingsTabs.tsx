"use client";

// Marketr — project settings tab nav. Server-rendered links with the active
// tab derived from the pathname; no tab state to keep in sync.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const TABS = [
  { slug: "general", label: "General" },
  { slug: "skills", label: "Skills" },
  { slug: "data", label: "Data" },
  { slug: "files", label: "Files" },
  { slug: "automation", label: "Automation" },
  { slug: "publishing", label: "Publishing" },
] as const;

export default function SettingsTabs({ projectId }: { projectId: string }) {
  const pathname = usePathname();
  const base = `/dashboard/projects/${projectId}/settings`;

  return (
    <nav
      aria-label="Project settings"
      className="-mb-px flex gap-1 overflow-x-auto border-b border-line"
    >
      {TABS.map((tab) => {
        const active = pathname === `${base}/${tab.slug}`;
        return (
          <Link
            key={tab.slug}
            href={`${base}/${tab.slug}`}
            aria-current={active ? "page" : undefined}
            className={cn(
              "shrink-0 border-b-2 px-3 py-2 text-[13.5px] transition-colors",
              active
                ? "border-accent font-medium text-ink"
                : "border-transparent text-ink-2 hover:border-line-strong hover:text-ink",
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
