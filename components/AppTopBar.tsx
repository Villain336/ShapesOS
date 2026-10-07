"use client";

// ShapesOS — Phase 3 (J): desktop app header. A slim white bar above the
// page content (h-14 + 1px line = 57px, the same height as the mobile top
// bar, so full-bleed pages subtract one constant). Holds the "needs you"
// shortcut with its count and the notification bell. On mobile the header
// is MobileNav (components/AppSidebar.tsx), which can mount the same
// <NotificationBell /> and <NeedsYouBadge />.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Columns2, Inbox } from "lucide-react";
import { cn } from "@/lib/utils";
import { NeedsYouPill, useNeedsYouCount } from "@/components/approvals/NeedsYouBadge";
import { NotificationBell } from "@/components/notifications/NotificationBell";
// Phase 18.1 (WS=desk): Control Center (pause all agents, focus, auto-approve,
// voice, spend today) and the split-view button sit in this bar.
import { ControlCenter } from "@/components/desk/ControlCenter";
import { splitHref } from "@/components/desk/events";
import { useInPane } from "@/components/desk/useInPane";
// Phase 18.1 (WS=find): i18n + the top bar is the page's banner landmark.
import { useI18n } from "@/components/i18n/I18nProvider";
// Phase 19A (WS=server): the top bar and its Needs-you shortcut are cursor targets.
import { cursorTarget, SHELL_TARGETS } from "@/lib/cursor/registry";

export function AppTopBar() {
  const pathname = usePathname();
  const { actionable } = useNeedsYouCount();
  const { t } = useI18n(); // p18-find i18n
  const onApprovals = pathname.startsWith("/dashboard/approvals");
  const onSplit = pathname === "/dashboard/split";
  const inPane = useInPane();
  if (inPane) return null;
  return (
    <header aria-label={t("a11y.banner")} {...cursorTarget(SHELL_TARGETS.topbar, t("a11y.banner"), "region")} className="sticky top-0 z-30 hidden h-14 items-center justify-end gap-1.5 border-b border-line bg-paper px-6 md:flex">
      {/* Phase 18.1 (WS=desk): this page next to the Assistant (⌥⇧S). */}
      {onSplit ? null : (
        <Link
          href={splitHref(pathname)}
          // Split view loads two panes; never prefetch it from every page.
          prefetch={false}
          aria-label={t("desk.split.openHere")}
          title={t("desk.split.openHint")}
          className="inline-flex size-10 items-center justify-center rounded-full text-ink transition-[background-color] duration-150 ease-aos hover:bg-hover"
        >
          <Columns2 className="size-[18px]" aria-hidden />
        </Link>
      )}
      <Link
        href="/dashboard/approvals"
        aria-current={onApprovals ? "page" : undefined}
        {...cursorTarget(SHELL_TARGETS.needsYou, t("topbar.needsYou"), "link")}
        className={cn(
          "inline-flex h-10 items-center gap-2 rounded-full px-3 text-sm font-semibold text-ink transition-[background-color] duration-150 ease-aos hover:bg-hover",
          onApprovals && "bg-hover",
        )}
      >
        <Inbox className="size-4" aria-hidden />
        {t("topbar.needsYou")}
        <NeedsYouPill count={actionable} />
      </Link>
      <NotificationBell />
      {/* Phase 18.1 (WS=desk): Control Center. */}
      <ControlCenter />
    </header>
  );
}

export default AppTopBar;
