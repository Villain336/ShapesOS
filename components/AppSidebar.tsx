"use client";

// Marketr — dashboard chrome: sidebar nav (desktop) + top bar (mobile).
// Nav rows use GlideMenu's gliding highlight; workspace + user menus use
// shadcn dropdown-menu; user avatar via shadcn avatar.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "next-auth/react";
import {
  ChartBar,
  Bell,
  ChartLineUp,
  Check,
  CaretDown,
  CaretUpDown,
  FolderSimple,
  SquaresFour,
  SignOut,
  List,
  Palette,
  SlidersHorizontal,
  TrendUp,
  Users,
  Kanban,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";import { cn } from "@/lib/utils";
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

const NAV_SECTIONS: {
  title?: string;
  items: { href: string; label: string; icon: PhosphorIcon }[];
}[] = [
  {
    items: [
      { href: "/dashboard", label: "Projects", icon: SquaresFour },
      { href: "/dashboard/assistant", label: "Marketr", icon: TrendUp },
      { href: "/dashboard/crm", label: "CRM", icon: Kanban },
      { href: "/dashboard/attribution", label: "Attribution", icon: ChartLineUp },
      { href: "/dashboard/reports", label: "Reports", icon: ChartBar },
      { href: "/dashboard/files", label: "Files", icon: FolderSimple },
      { href: "/dashboard/alerts", label: "Alerts", icon: Bell },
    ],
  },
  {
    title: "Settings",
    items: [
      { href: "/dashboard/settings/alerts", label: "Alert rules", icon: SlidersHorizontal },
      { href: "/dashboard/settings/brand-kits", label: "Brand kits", icon: Palette },
      { href: "/dashboard/settings/members", label: "Members", icon: Users },
    ],
  },
];

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

function NavItems({ pathname, onNavigate }: { pathname: string; onNavigate?: () => void }) {
  return (
    <div className="flex flex-col gap-4">
      {NAV_SECTIONS.map((section, i) => (
        <div key={section.title ?? i}>
          {section.title ? (
            <div className="mb-1 px-3 text-[12px] font-medium text-ink-3">
              {section.title}
            </div>
          ) : null}
          <GlideMenu highlightClassName="inset-x-0 rounded-full bg-hover">
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
                    "relative z-10 mb-0.5 flex items-center gap-2.5 rounded-full px-3 py-2 text-[13.5px] transition-[color,background-color] duration-150 ease-[cubic-bezier(0.2,0,0,1)]",
                    active
                      ? "bg-accent-tint font-medium text-accent-ink"
                      : "text-ink-2 hover:text-ink",
                  )}
                >
                  <Icon className="size-4 shrink-0" weight="duotone" />
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
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(buttonVariants({ variant: "secondary", size: "sm" }), "w-full justify-between")}
        aria-label="Switch workspace"
      >
        <span className="truncate">{current?.name ?? "Workspace"}</span>
        <CaretUpDown className="size-3.5 shrink-0 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel>Workspace</DropdownMenuLabel>
        {workspaces.map((w) => {
          const selected = w.id === currentId;
          return (
            <DropdownMenuItem
              key={w.id}
              disabled={!selected}
              className="justify-between"
              title={selected ? "Current workspace" : "Workspace switching is not enabled"}
            >
              <span className="truncate">{w.name}</span>
              {selected ? <Check className="size-3.5" /> : null}
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
}: {
  user: SidebarUser;
  triggerClassName?: string;
  compact?: boolean;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          "flex items-center gap-2.5 rounded-control px-2 py-1.5 text-left transition-[background-color] duration-150 ease-[cubic-bezier(0.2,0,0,1)] hover:bg-hover active:scale-[0.98]",
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
              <span className="block truncate text-[13px] font-medium text-ink">
                {user.name ?? user.email ?? "Signed in"}
              </span>
              {user.name && user.email ? (
                <span className="block truncate text-[12px] text-ink-3">{user.email}</span>
              ) : null}
            </span>
            <CaretDown className="size-3.5 shrink-0 text-ink-3" />
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
          <SignOut weight="duotone" />
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
    <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-line bg-surface md:flex">
      <div className="flex flex-col gap-3 px-3 pt-4">
        <Link href="/dashboard" className="flex items-center gap-2 px-1" aria-label="Marketr home">
          <span className="flex size-7 items-center justify-center rounded-control bg-ink text-page">
            <TrendUp className="size-4" weight="duotone" />
          </span>
          <span className="text-[16px] font-semibold tracking-tight text-ink">Marketr</span>
        </Link>
        <WorkspaceSwitcher workspaces={workspaces} currentId={currentWorkspaceId} />
      </div>
      <nav className="flex-1 overflow-y-auto px-2 py-4" aria-label="Dashboard">
        <NavItems pathname={pathname} />
        {showThreads ? (
          <div className="mt-5 border-t border-line pt-3">
            <div className="mb-2 truncate px-3 text-[12px] font-medium text-ink-3">
              Chats · {chat.session?.projectDomain}
            </div>
            <ThreadListSection />
          </div>
        ) : null}
      </nav>
      <div className="border-t border-line p-2">
        <UserMenu user={user} triggerClassName="w-full" />
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
    <header className="sticky top-0 z-40 flex items-center justify-between border-b border-line bg-surface px-4 py-2.5 md:hidden">
      <Link href="/dashboard" className="flex items-center gap-2" aria-label="Marketr home">
        <span className="flex size-7 items-center justify-center rounded-control bg-ink text-page">
          <TrendUp className="size-4" weight="duotone" />
        </span>
        <span className="text-[16px] font-semibold tracking-tight text-ink">Marketr</span>
      </Link>
      <div className="flex items-center gap-1.5">
        <DropdownMenu>
          <DropdownMenuTrigger
            className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "px-2.5")}
            aria-label="Open navigation"
          >
            <List className="size-4" weight="duotone" />
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
