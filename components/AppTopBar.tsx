"use client";

// ShapesOS — Phase 3 (J): desktop app header. A slim white bar above the
// page content (h-14 + 1px line = 57px, the same height as the mobile top
// bar, so full-bleed pages subtract one constant). Holds the "needs you"
// shortcut with its count and the notification bell. On mobile the header
// is MobileNav (components/AppSidebar.tsx), which can mount the same
// <NotificationBell /> and <NeedsYouBadge />.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Inbox } from "lucide-react";
import { cn } from "@/lib/utils";
import { NeedsYouPill, useNeedsYouCount } from "@/components/approvals/NeedsYouBadge";
import { NotificationBell } from "@/components/notifications/NotificationBell";

export function AppTopBar() {
  const pathname = usePathname();
  const { actionable } = useNeedsYouCount();
  const onApprovals = pathname.startsWith("/dashboard/approvals");
  return (
    <header className="sticky top-0 z-30 hidden h-14 items-center justify-end gap-1.5 border-b border-line bg-paper px-6 md:flex">
      <Link
        href="/dashboard/approvals"
        aria-current={onApprovals ? "page" : undefined}
        className={cn(
          "inline-flex h-10 items-center gap-2 rounded-full px-3 text-sm font-semibold text-ink transition-[background-color] duration-150 ease-aos hover:bg-hover",
          onApprovals && "bg-hover",
        )}
      >
        <Inbox className="size-4" aria-hidden />
        Needs you
        <NeedsYouPill count={actionable} />
      </Link>
      <NotificationBell />
    </header>
  );
}

export default AppTopBar;
