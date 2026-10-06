"use client";

// Marketr — route-aware content frame for the dashboard shell.
// Content pages are full width with generous gutters. Chat and the
// automations canvas run full-bleed (edge to edge, no page header).

import { usePathname } from "next/navigation";

// Phase 18.1 (WS=desk): split view fills the frame too.
const FULL_BLEED_SUFFIX = ["/chat", "/assistant", "/automations", "/crm", "/dashboard/split"];

export function DashboardMain({
  children,
  banner,
  pane = false,
}: {
  children: React.ReactNode;
  /** Workspace-wide notice (e.g. the hosted trial); content pages only. */
  banner?: React.ReactNode;
  /** Phase 18.1: rendered inside a split-view pane (no top bar above it). */
  pane?: boolean;
}) {
  const pathname = usePathname();
  const fullBleed = FULL_BLEED_SUFFIX.some((s) => pathname.endsWith(s));

  if (fullBleed) {
    return (
      // 57px = the mobile top bar (MobileNav) and, on desktop, AppTopBar.
      <main className={pane ? "h-dvh" : "h-[calc(100dvh-57px)]"}>
        {children}
      </main>
    );
  }

  return (
    <main className={pane ? "w-full px-4 py-4" : "w-full px-4 py-6 sm:px-6 sm:py-8 lg:px-10"}>
      {banner}
      {children}
    </main>
  );
}
