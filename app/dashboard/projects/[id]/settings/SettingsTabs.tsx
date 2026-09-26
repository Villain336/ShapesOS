"use client";

// Marketr — project settings tab nav. Server-rendered links with the active
// tab derived from the pathname; no tab state to keep in sync.

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Database,
  FolderOpen,
  Send,
  Settings2,
  Sparkles,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";

const TABS = [
  { slug: "general", label: "General", icon: Settings2 },
  { slug: "skills", label: "Skills", icon: Sparkles },
  { slug: "data", label: "Data", icon: Database },
  { slug: "files", label: "Files", icon: FolderOpen },
  { slug: "automation", label: "Automation", icon: Zap },
  { slug: "publishing", label: "Publishing", icon: Send },
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
        const Icon = tab.icon;
        return (
          <Link
            key={tab.slug}
            href={`${base}/${tab.slug}`}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-[13.5px] font-medium transition-colors",
              active
                ? "border-accent text-accent-ink"
                : "border-transparent text-ink-2 hover:text-ink",
            )}
          >
            <Icon size={15} />
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
