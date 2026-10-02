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
import type { ComponentType } from "react";
import { useState } from "react";
import {
  Mail,
  Paintbrush,
  Megaphone,
  RefreshCw,
  Brain,
  Target,
  BookOpen,
  Inbox,
  Share2,
  LayoutDashboard,
  Scissors,
  Briefcase,
  PenLine,
  Home,
  Database,
  TrendingUp,
  Kanban,
  ChartColumn,
  ChartSpline,
  ChartLine,
  Folder,
  Bell,
  Check,
  ChevronDown,
  ChevronsUpDown,
  Globe,
  LogOut,
  List,
  Phone,
  Star,
  Scale,
  Handshake,
  Network,
  Box,
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

export type SidebarUser = { name?: string | null; email?: string | null };
export type SidebarWorkspace = { id: string; name: string };

/** Nav icon: Lucide. */
type NavIcon = ComponentType<{ className?: string }>;

const NAV_SECTIONS: {
  title?: string;
  items: { href: string; label: string; icon: NavIcon }[];
}[] = [
  {
    items: [
      { href: "/dashboard", label: "Overview", icon: LayoutDashboard },
      { href: "/dashboard/assistant", label: "Assistant", icon: TrendingUp },
      { href: "/dashboard/crm", label: "CRM", icon: Kanban },
      { href: "/dashboard/attribution", label: "Attribution", icon: ChartSpline },
      { href: "/dashboard/reviews", label: "Reviews", icon: Star },
      { href: "/dashboard/calls", label: "Calls", icon: Phone },
      { href: "/dashboard/reports", label: "Reports", icon: ChartColumn },
      // Phase 12 (embeds): Umami-backed analytics dashboard.
      { href: "/dashboard/analytics", label: "Analytics", icon: ChartLine },
      { href: "/dashboard/files", label: "Files", icon: Folder },
      { href: "/dashboard/alerts", label: "Alerts", icon: Bell },
      // Phase 4: Creative Studio (T2, central creative home) + Direct Mail
      // (R3/T1 mail engine — page lands with that track; nav is wired here).
      { href: "/dashboard/studio", label: "Studio", icon: Paintbrush },
      { href: "/dashboard/mail", label: "Direct Mail", icon: Mail },
      // Phase 12: social publishing via the Postiz sidecar (raw REST).
      { href: "/dashboard/social", label: "Social", icon: Share2 },
      // Phase 13C: the clipper — long videos → scored clip drafts → Postiz drafts.
      { href: "/dashboard/clips", label: "Clips", icon: Scissors },
      // Phase 5 SAFETY: media buying command center (pools, approvals, kill switches).
      { href: "/dashboard/media", label: "Media", icon: Megaphone },
      // Phase 6: authority & relevance command center (outreach, PR, listings,
      // AEO, review replies, intelligence reports).
      { href: "/dashboard/authority", label: "Authority", icon: Globe },
      // Phase 7: the flywheel (reallocation, recycling, Test Lab, CTV, DSP, launch).
      { href: "/dashboard/flywheel", label: "Flywheel", icon: RefreshCw },
      // Phase 8: the agentic substrate (Business Graph, Campaigns, Growth Memory).
      { href: "/dashboard/substrate", label: "Substrate", icon: Brain },
      // Phase 9: GrowthOS — missions, playbooks, approvals (Chief Strategy Agent).
      { href: "/dashboard/missions", label: "Missions", icon: Target },
      { href: "/dashboard/playbooks", label: "Playbooks", icon: BookOpen },
      { href: "/dashboard/approvals", label: "Approvals", icon: Inbox },
      // Phase 14: the office surface — sheets/docs/decks stored by Marketr.
      { href: "/dashboard/office", label: "Office", icon: Briefcase },
      // Wave 2: E-sign — governed signature envelopes on the Documenso rail.
      { href: "/dashboard/esign", label: "E-sign", icon: PenLine },
      // Wave 2: WFH mode — per-user remote-work mode switch.
      { href: "/dashboard/wfh", label: "WFH mode", icon: Home },
      // Business OS: Dataset Builder slice 1 — ingest business knowledge
      // into traceable datasets (Launch pillar on-ramp).
      { href: "/dashboard/datasets", label: "Datasets", icon: Database },
      // Business OS: Legal/Compliance slice 1 — per-tenant obligation map
      // (licenses, filings, tax registrations, insurance, permits).
      { href: "/dashboard/legal", label: "Legal", icon: Scale },
      // Business OS: Funding/VC slice 1 — starter network. Boardy AI ships
      // as the preloaded starter contact in every tenant's funding graph;
      // the front door is the founder's own raise workflow.
      { href: "/dashboard/funding", label: "Funding", icon: Handshake },
      // Connector Agent slice 1: the connector's Network home — people,
      // companies, relationship warmth, import provenance.
      { href: "/dashboard/connector", label: "Network", icon: Network },
      // CAD + Hardware slice 1: CAD viewer + versioning — project/model
      // registry, in-browser three.js viewer, version diffs, share links.
      { href: "/dashboard/cad", label: "CAD", icon: Box },
    ],
  },
];
// Phase 13 A1: the sidebar's separate "Settings" island (alert rules, brand
// kits, members) was deleted — all 17 settings subpages now live in the single
// SettingsNav tab strip on every settings page, including the new
// /dashboard/settings landing.

function isActive(pathname: string, href: string) {
  return href === "/dashboard" ? pathname === href : pathname.startsWith(href);
}

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
}: {
  pathname: string;
  onNavigate?: () => void;
  onNight?: boolean;
}) {
  return (
    <div className="flex flex-col gap-4">
      {NAV_SECTIONS.map((section, i) => (
        <div key={section.title ?? i}>
          {section.title ? (
            <div
              className={cn(
                "mb-1 px-3 text-xs font-semibold",
                onNight ? "text-night-muted" : "text-muted",
              )}
            >
              {section.title}
            </div>
          ) : null}
          <GlideMenu
            highlightClassName={cn("inset-x-0 rounded-sm", onNight ? "bg-night-hover" : "bg-hover")}
          >
            {section.items.map((item) => {
              const active = isActive(pathname, item.href);
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  data-menu-row
                  aria-current={active ? "page" : undefined}
                  onClick={onNavigate}
                  className={cn(
                    "relative z-10 mb-0.5 flex h-10 items-center gap-2.5 rounded-sm px-3 text-base transition-[color,background-color] duration-150 ease-aos",
                    active
                      ? onNight
                        ? "bg-paper font-semibold text-ink"
                        : "bg-ink font-semibold text-paper"
                      : onNight
                        ? "text-night-soft hover:text-night"
                        : "text-ink",
                  )}
                >
                  <Icon className="size-4 shrink-0" />
                  {item.label}
                </Link>
              );
            })}
          </GlideMenu>
        </div>
      ))}
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
}: {
  user: SidebarUser;
  workspaces: SidebarWorkspace[];
  currentWorkspaceId: string;
}) {
  const pathname = usePathname();
  const chat = useChat();
  // One sidebar everywhere: on the assistant page it adjusts, gaining a
  // contextual chat-thread section under the main nav (AI tab only).
  const showThreads =
    pathname === "/dashboard/assistant" && chat.tab === "ai" && chat.session !== null;
  return (
    <aside className="aos-night sticky top-0 hidden h-screen w-72 shrink-0 flex-col border-r border-night-line md:flex">
      <div className="flex flex-col gap-3 px-3 pt-4">
        <Link href="/dashboard" className="flex items-center gap-2 px-1" aria-label="Marketr home">
          <span className="flex size-7 items-center justify-center rounded-sm bg-night-raised text-night">
            <TrendingUp className="size-4" />
          </span>
          <span className="text-[16px] font-semibold tracking-tight text-night">Marketr</span>
        </Link>
        <WorkspaceSwitcher workspaces={workspaces} currentId={currentWorkspaceId} />
      </div>
      <nav className="flex-1 overflow-y-auto px-2 py-4" aria-label="Dashboard">
        <NavItems pathname={pathname} onNight />
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
        <UserMenu user={user} triggerClassName="w-full" onNight />
      </div>
    </aside>
  );
}

export function MobileNav({
  user,
  workspaces,
  currentWorkspaceId,
}: {
  user: SidebarUser;
  workspaces: SidebarWorkspace[];
  currentWorkspaceId: string;
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
          <DropdownMenuContent align="end" className="w-56 p-2">
            <NavItems pathname={pathname} />
            <div className="mt-2 border-t border-line pt-2">
              <WorkspaceSwitcher workspaces={workspaces} currentId={currentWorkspaceId} />
            </div>
          </DropdownMenuContent>
        </DropdownMenu>
        <UserMenu user={user} compact />
      </div>
    </header>
  );
}
