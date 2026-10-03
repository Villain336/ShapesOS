"use client";

// Marketr — dashboard chrome: sidebar nav (desktop) + top bar (mobile).
// Nav rows use GlideMenu's gliding highlight; workspace + user menus use
// shadcn dropdown-menu; user avatar via shadcn avatar.
//
// Agentic OS: the desktop sidebar is a black night surface (aos-night,
// 288px). Nav items are 40px rows; the current page is a white row with
// black text and aria-current="page". Icons are Lucide only.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "next-auth/react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronsUpDown,
  List,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  TrendingUp,
} from "lucide-react";
import { cn } from "@/lib/utils";
import GlideMenu from "@/components/vault/primitives/GlideMenu";
import { buttonVariants } from "@/components/vault/atoms/Button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/vault/shadcn/dropdown-menu";
import { Avatar, AvatarFallback } from "@/components/vault/shadcn/avatar";
import { useChat } from "@/components/chat/ChatContext";
import ThreadListSection from "@/components/chat/ThreadListSection";
import { activeNavHref, NAV_GROUPS, type NavItem } from "@/lib/nav/config";

export type SidebarUser = { name?: string | null; email?: string | null };
export type SidebarWorkspace = { id: string; name: string };

/**
 * Live count pills keyed by NavItem.badge. The dashboard layout fills
 * `needs-you` with the approvals count (components/approvals/NeedsYouBadge);
 * a missing key renders nothing.
 */
export type SidebarBadges = Partial<Record<NonNullable<NavItem["badge"]>, ReactNode>>;

// Navigation lives in lib/nav/config.ts (Grow / Design / Operate / Agents +
// Settings and Billing) so the sidebar and the ⌘K Go section never drift.
// Settings subpages stay in the SettingsNav tab strip on every settings page.

const COLLAPSE_KEY = "shapesos:sidebar:collapsed";

function initials(user: SidebarUser) {
  const src = user.name ?? user.email ?? "?";
  return src
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]!.toUpperCase())
    .join("");
}

function NavItems({
  pathname,
  onNavigate,
  onNight,
  collapsed,
  badges,
}: {
  pathname: string;
  onNavigate?: () => void;
  onNight?: boolean;
  collapsed?: boolean;
  badges?: SidebarBadges;
}) {
  const current = activeNavHref(pathname);
  return (
    <div className="flex flex-col gap-4">
      {NAV_GROUPS.map((group) => {
        const headingId = `nav-group-${group.id}${onNight ? "" : "-m"}`;
        return (
          <div
            key={group.id}
            role="group"
            aria-labelledby={group.title ? headingId : undefined}
            aria-label={group.title ? undefined : group.id === "account" ? "Account" : "Home"}
            className={group.id === "account" ? cn("border-t pt-3", onNight ? "border-night-line" : "border-line") : undefined}
          >
            {group.title ? (
              <div
                id={headingId}
                className={cn(
                  "mb-1 px-3 text-xs font-semibold",
                  onNight ? "text-night-muted" : "text-muted",
                  collapsed && "sr-only",
                )}
              >
                {group.title}
              </div>
            ) : null}
            <GlideMenu
              highlightClassName={cn("inset-x-0 rounded-sm", onNight ? "bg-night-hover" : "bg-hover")}
            >
              {group.items.map((item) => {
                const active = item.href === current;
                const Icon = item.icon;
                const badge = item.badge ? badges?.[item.badge] : null;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    data-menu-row
                    aria-current={active ? "page" : undefined}
                    aria-label={collapsed ? item.label : undefined}
                    title={collapsed ? item.label : undefined}
                    onClick={onNavigate}
                    className={cn(
                      "relative z-10 mb-0.5 flex h-10 items-center gap-2.5 rounded-sm text-base transition-[color,background-color] duration-150 ease-aos",
                      collapsed ? "justify-center px-0" : "px-3",
                      active
                        ? onNight
                          ? "bg-paper font-semibold text-ink"
                          : "bg-ink font-semibold text-paper"
                        : onNight
                          ? "text-night-soft hover:text-night"
                          : "text-ink",
                    )}
                  >
                    <Icon aria-hidden className="size-4 shrink-0" />
                    {collapsed ? null : <span className="min-w-0 flex-1 truncate">{item.label}</span>}
                    {badge && !collapsed ? <span className="ml-auto shrink-0">{badge}</span> : null}
                  </Link>
                );
              })}
            </GlideMenu>
          </div>
        );
      })}
    </div>
  );
}

function WorkspaceSwitcher({
  workspaces,
  currentId,
}: {
  workspaces: SidebarWorkspace[];
  currentId: string;
}) {
  const current = workspaces.find((w) => w.id === currentId) ?? workspaces[0];
  // Phase 13 Wave A (white-label ops): workspace switching is enabled.
  // Any member may switch — switching is scoping, not privilege; every API
  // route still enforces its own RBAC for the resolved workspace, and the
  // cookie is validated against the user's accessible workspaces server-side.
  const [switchingId, setSwitchingId] = useState<string | null>(null);

  async function switchTo(id: string) {
    if (id === currentId || switchingId) return;
    setSwitchingId(id);
    try {
      const res = await fetch("/api/workspaces/active", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId: id }),
      });
      if (!res.ok) throw new Error("switch failed");
      // Full reload so every server component re-resolves the workspace
      // from the new preference cookie (BrandTheme re-tints, lists refetch).
      window.location.reload();
    } catch {
      setSwitchingId(null);
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(buttonVariants({ variant: "secondary", size: "sm" }), "w-full justify-between")}
        aria-label="Switch workspace"
      >
        <span className="truncate">{current?.name ?? "Workspace"}</span>
        <ChevronsUpDown className="size-3.5 shrink-0 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel>Workspace</DropdownMenuLabel>
        {workspaces.map((w) => {
          const selected = w.id === currentId;
          const switching = w.id === switchingId;
          return (
            <DropdownMenuItem
              key={w.id}
              className="justify-between"
              title={selected ? "Current workspace" : `Switch to ${w.name}`}
              onSelect={(e) => {
                e.preventDefault();
                void switchTo(w.id);
              }}
            >
              <span className="truncate">{w.name}</span>
              {selected ? (
                <Check className="size-3.5" />
              ) : switching ? (
                <RefreshCw className="size-3.5 animate-spin opacity-60" />
              ) : null}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function UserMenu({
  user,
  triggerClassName,
  compact,
  onNight,
}: {
  user: SidebarUser;
  triggerClassName?: string;
  compact?: boolean;
  onNight?: boolean;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          "flex items-center gap-2.5 rounded-sm px-2 py-1.5 text-left transition-[background-color] duration-150 ease-aos active:scale-[0.98]",
          onNight ? "hover:bg-night-hover" : "hover:bg-hover",
          triggerClassName,
        )}
        aria-label="Account menu"
      >
        <Avatar size="sm">
          <AvatarFallback>{initials(user)}</AvatarFallback>
        </Avatar>
        {compact ? null : (
          <>
            <span className="min-w-0 flex-1">
              <span
                className={cn(
                  "block truncate text-[13px] font-medium",
                  onNight ? "text-night" : "text-ink",
                )}
              >
                {user.name ?? user.email ?? "Signed in"}
              </span>
              {user.name && user.email ? (
                <span
                  className={cn(
                    "block truncate text-xs",
                    onNight ? "text-night-muted" : "text-muted",
                  )}
                >
                  {user.email}
                </span>
              ) : null}
            </span>
            <ChevronDown className={cn("size-3.5 shrink-0", onNight ? "text-night-muted" : "text-subtle")} />
          </>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="top" className="w-56">
        <DropdownMenuLabel className="font-normal">
          <span className="block truncate text-[13px] font-medium text-foreground">
            {user.name ?? "Signed in"}
          </span>
          {user.email ? (
            <span className="block truncate text-[12px] text-muted-foreground">{user.email}</span>
          ) : null}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onClick={() => signOut({ callbackUrl: "/login" })}>
          <LogOut />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function AppSidebar({
  user,
  workspaces,
  currentWorkspaceId,
  badges,
}: {
  user: SidebarUser;
  workspaces: SidebarWorkspace[];
  currentWorkspaceId: string;
  badges?: SidebarBadges;
}) {
  const pathname = usePathname();
  const chat = useChat();
  // 288px expanded / 80px rail (Agentic OS). The choice is a per-viewer
  // convenience, so it lives in localStorage and defaults to expanded.
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(COLLAPSE_KEY) === "1");
    } catch {
      // storage unavailable: stay expanded
    }
  }, []);
  function toggleCollapsed() {
    setCollapsed((c) => {
      try {
        window.localStorage.setItem(COLLAPSE_KEY, c ? "0" : "1");
      } catch {
        // best effort
      }
      return !c;
    });
  }
  // One sidebar everywhere: on the assistant page it adjusts, gaining a
  // contextual chat-thread section under the main nav (AI tab only).
  const showThreads =
    !collapsed && pathname === "/dashboard/assistant" && chat.tab === "ai" && chat.session !== null;
  return (
    <aside
      className={cn(
        "aos-night sticky top-0 hidden h-screen shrink-0 flex-col border-r border-night-line md:flex",
        collapsed ? "w-20" : "w-72",
      )}
    >
      <div className={cn("flex flex-col gap-3 pt-4", collapsed ? "items-center px-2" : "px-3")}>
        <div className={cn("flex items-center gap-2", collapsed ? "flex-col" : "justify-between")}>
          <Link href="/dashboard" className="flex items-center gap-2 rounded-sm px-1" aria-label="Marketr home">
            <span className="flex size-7 items-center justify-center rounded-sm bg-night-raised text-night">
              <TrendingUp className="size-4" />
            </span>
            {collapsed ? null : (
              <span className="text-[16px] font-semibold tracking-tight text-night">Marketr</span>
            )}
          </Link>
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-expanded={!collapsed}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className="flex size-8 items-center justify-center rounded-full text-night-soft transition-[background-color,color] duration-150 hover:bg-night-hover hover:text-night"
          >
            {collapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
          </button>
        </div>
        {collapsed ? null : <WorkspaceSwitcher workspaces={workspaces} currentId={currentWorkspaceId} />}
      </div>
      <nav className="flex-1 overflow-y-auto px-2 py-4" aria-label="Dashboard">
        <NavItems pathname={pathname} onNight collapsed={collapsed} badges={badges} />
        {showThreads ? (
          <div className="mt-5 border-t border-night-line pt-3">
            <div className="mb-2 truncate px-3 text-xs font-semibold text-night-muted">
              Chats · {chat.session?.projectDomain}
            </div>
            <ThreadListSection />
          </div>
        ) : null}
      </nav>
      <div className="border-t border-night-line p-2">
        <UserMenu user={user} triggerClassName="w-full" onNight compact={collapsed} />
      </div>
    </aside>
  );
}

export function MobileNav({
  user,
  workspaces,
  currentWorkspaceId,
  badges,
  headerActions,
}: {
  user: SidebarUser;
  workspaces: SidebarWorkspace[];
  currentWorkspaceId: string;
  badges?: SidebarBadges;
  /** Mobile top-bar slot before the account menu (e.g. the notification bell). */
  headerActions?: ReactNode;
}) {
  const pathname = usePathname();
  return (
    <header className="sticky top-0 z-40 flex items-center justify-between border-b border-line bg-paper px-4 py-2.5 md:hidden">
      <Link href="/dashboard" className="flex items-center gap-2" aria-label="Marketr home">
        <span className="flex size-7 items-center justify-center rounded-sm bg-ink text-paper">
          <TrendingUp className="size-4" />
        </span>
        <span className="text-[16px] font-semibold tracking-tight text-ink">Marketr</span>
      </Link>
      <div className="flex items-center gap-1.5">
        <DropdownMenu>
          <DropdownMenuTrigger
            className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "px-2.5")}
            aria-label="Open navigation"
          >
            <List className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="max-h-[80vh] w-64 overflow-y-auto p-2">
            <NavItems pathname={pathname} badges={badges} />
            <div className="mt-2 border-t border-line pt-2">
              <WorkspaceSwitcher workspaces={workspaces} currentId={currentWorkspaceId} />
            </div>
          </DropdownMenuContent>
        </DropdownMenu>
        {headerActions}
        <UserMenu user={user} compact />
      </div>
    </header>
  );
}
