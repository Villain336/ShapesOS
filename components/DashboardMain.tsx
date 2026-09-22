"use client";

// Marketr — route-aware content frame for the dashboard shell.
// Content pages are full width with generous gutters. Chat and the
// automations canvas run full-bleed (edge to edge, no page header).

import { usePathname } from "next/navigation";

const FULL_BLEED_SUFFIX = ["/chat", "/assistant", "/automations"];

export function DashboardMain({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const fullBleed = FULL_BLEED_SUFFIX.some((s) => pathname.endsWith(s));

  if (fullBleed) {
    return (
      <main className="h-[calc(100dvh-57px)] md:h-dvh">
        {children}
      </main>
    );
  }

  return (
    <main className="w-full px-4 py-6 sm:px-6 sm:py-8 lg:px-10">{children}</main>
  );
}
