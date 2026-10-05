"use client";

// ShapesOS — dashboard chrome: the Agentic OS sidebar (desktop) and the
// mobile top bar + drawer (kit: docs/design/kit/sidebar-and-menus.png).
//
// Black night surface, 288px expanded / 80px rail. Top: logo mark +
// ShapesOS + workspace name with the switcher chevron, then the white "New
// task" pill and the round search button (opens ⌘K). The nav (lib/nav/config
// — every destination stays reachable; the long list scrolls) has a white
// current row and pill counts (Approvals = the needs-you count). Below it,
// "Running now": the lead agent with its sub-agents branching beneath
// (lib/aos/agents), then the usage meter and the user row. The collapsed
// rail keeps icons, the needs-you dot and the running shapes, with tooltips.

import Link from "next/link";
import { AGENT_ACTIVITY_CHANGED_EVENT } from "@/lib/aos/events";
import { usePathname, useRouter } from "next/navigation";
import { signOut } from "next-auth/react";
import { useCallback, useEffect, useId, useState, type ReactNode } from "react";
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import { Dialog } from "@base-ui/react/dialog";
import {
  Check,
  ChevronsUpDown,
  CreditCard,
  LogOut,
  Menu as MenuIcon,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  RefreshCw,
  Search,
  Settings,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/vault/shadcn/dropdown-menu";
import { useChat } from "@/components/chat/ChatContext";
import ThreadListSection from "@/components/chat/ThreadListSection";
import { useNeedsYouCount } from "@/components/approvals/NeedsYouBadge";
import { OPEN_COMMAND_BAR_EVENT } from "@/components/command-bar/lib";
import { openNewTask } from "@/components/command-bar/NewTaskDialog";
import { LogoMark } from "@/components/aos/LogoMark";
import { AgentTree } from "@/components/aos/AgentTree";
import { CountBadge } from "@/components/aos/AgentAvatar";
import { StatusShape } from "@/components/aos/StatusShape";
import { activeNavHref, NAV_GROUPS } from "@/lib/nav/config";
import { visibleBranches, type AgentNode } from "@/lib/aos/agents";
import { STATUS_META } from "@/lib/aos/status";

export type SidebarUser = { name?: string | null; email?: string | null };
export type SidebarWorkspace = { id: string; name: string };
export type SidebarTree = { lead: AgentNode; branches: AgentNode[] } | null;
export type SidebarUsage = { used: number; cap: number; pct: number } | null;

const COLLAPSE_KEY = "shapesos:sidebar:collapsed";
const ACTIVITY_POLL_MS = 45_000;
const MAX_RUNNING_ROWS = 4;

function initials(user: SidebarUser) {
  const src = user.name ?? user.email ?? "?";
  return src
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]!.toUpperCase())
    .join("");
}

export function planLabel(plan: string | null | undefined): string | null {
  if (!plan) return null;
  const words = plan.replace(/_/g, "-").split("-").join(" ");
  return `${words[0]!.toUpperCase()}${words.slice(1)} plan`;
}

export function openCommandBar() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(OPEN_COMMAND_BAR_EVENT));
}

/** Live lead → sub-agent tree + usage: server-rendered first, then polled while visible. */
export function useAgentActivity(initial: { tree: SidebarTree; usage: SidebarUsage }) {
  const [state, setState] = useState(initial);
  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/agents/activity", { cache: "no-store" });
      if (!res.ok) return;
      const body = (await res.json()) as { tree: SidebarTree; usage: SidebarUsage };
      setState({ tree: body.tree ?? null, usage: body.usage ?? null });
    } catch {
      // keep the last good state
    }
  }, []);
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const timer = window.setInterval(tick, ACTIVITY_POLL_MS);
    document.addEventListener("visibilitychange", tick);
    // Phase 16: a delegation card saw sub-agents move — refresh now.
    window.addEventListener(AGENT_ACTIVITY_CHANGED_EVENT, tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
      window.removeEventListener(AGENT_ACTIVITY_CHANGED_EVENT, tick);
    };
  }, [refresh]);
  return state;
}

// ---------------------------------------------------------------------------
// Rail tooltip (collapsed sidebar)
// ---------------------------------------------------------------------------

function RailTip({ label, children }: { label: string; children: React.ReactElement<Record<string, unknown>> }) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger render={children} />
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Positioner side="right" sideOffset={14} className="z-50">
          <TooltipPrimitive.Popup className="relative rounded-sm bg-ink px-3 py-1.5 text-sm font-semibold whitespace-nowrap text-paper shadow-raised">
            {label}
            <TooltipPrimitive.Arrow className="data-[side=right]:-left-1 data-[side=right]:top-1/2! size-2.5 -translate-y-1/2 rotate-45 bg-ink" />
          </TooltipPrimitive.Popup>
        </TooltipPrimitive.Positioner>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

// ---------------------------------------------------------------------------
// Workspace switcher (header trigger + menu)
// ---------------------------------------------------------------------------

function WorkspaceMenu({
  workspaces,
  currentId,
  canManageBilling,
  collapsed,
}: {
  workspaces: SidebarWorkspace[];
  currentId: string;
  canManageBilling?: boolean;
  collapsed?: boolean;
}) {
  const router = useRouter();
  const current = workspaces.find((w) => w.id === currentId) ?? workspaces[0];
  // Any member may switch — switching is scoping, not privilege; every API
  // route still enforces its own RBAC, and the cookie is validated against
  // the user's accessible workspaces server-side.
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
      // Full reload so every server component re-resolves the workspace.
      window.location.reload();
    } catch {
      setSwitchingId(null);
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Switch workspace (current: ${current?.name ?? "Workspace"})`}
        className={cn(
          "flex items-center rounded-sm text-left transition-[background-color] duration-150 hover:bg-night-hover",
          collapsed ? "size-12 justify-center" : "w-full gap-3 px-2 py-1.5",
        )}
      >
        <LogoMark size={collapsed ? 28 : 30} />
        {collapsed ? null : (
          <>
            <span className="min-w-0 flex-1">
              <span className="block text-[17px] leading-5 font-extrabold stretch-display tracking-heading text-paper">ShapesOS</span>
              <span className="block truncate text-xs text-night-muted">{current?.name ?? "Workspace"}</span>
            </span>
            <ChevronsUpDown className="size-4 shrink-0 text-night-soft" aria-hidden />
          </>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={6} className="w-72 rounded-lg bg-paper p-1.5 text-ink shadow-raised ring-0">
        <DropdownMenuLabel className="px-3 pt-2 pb-1 text-xs font-semibold text-muted">Switch workspace</DropdownMenuLabel>
        {workspaces.map((w) => {
          const selected = w.id === currentId;
          const switching = w.id === switchingId;
          return (
            <DropdownMenuItem
              key={w.id}
              className="min-h-12 gap-3 rounded-sm px-3 text-base font-semibold"
              onClick={(e) => {
                e.preventDefault();
                void switchTo(w.id);
              }}
            >
              <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-key bg-ink text-sm font-extrabold text-paper">
                {w.name.trim()[0]?.toUpperCase() ?? "W"}
              </span>
              <span className="min-w-0 flex-1 truncate">{w.name}</span>
              {selected ? (
                <Check className="size-4" aria-label="Current workspace" />
              ) : switching ? (
                <RefreshCw className="size-4 animate-spin text-muted" aria-hidden />
              ) : null}
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator className="mx-2 my-1.5 bg-line" />
        <DropdownMenuItem className="min-h-12 gap-3 rounded-sm px-3 text-base font-semibold" onClick={() => router.push("/dashboard/settings/workspace#ws-new")}>
          <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-key bg-paper shadow-control">
            <Plus className="size-4" />
          </span>
          Create workspace
        </DropdownMenuItem>
        <DropdownMenuItem className="min-h-11 gap-3 rounded-sm px-3 text-base" onClick={() => router.push("/dashboard/settings/workspace")}>
          <Settings className="ml-2 size-4" aria-hidden />
          Workspace settings
        </DropdownMenuItem>
        {canManageBilling ? (
          <DropdownMenuItem className="min-h-11 gap-3 rounded-sm px-3 text-base" onClick={() => router.push("/dashboard/billing")}>
            <CreditCard className="ml-2 size-4" aria-hidden />
            Billing
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ---------------------------------------------------------------------------
// User row
// ---------------------------------------------------------------------------

function UserRow({
  user,
  plan,
  collapsed,
  canManageBilling,
}: {
  user: SidebarUser;
  plan: string | null;
  collapsed?: boolean;
  canManageBilling?: boolean;
}) {
  const router = useRouter();
  const avatar = (
    <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-full bg-paper text-xs font-extrabold text-ink">
      {initials(user)}
    </span>
  );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Account menu"
        className={cn(
          "flex items-center rounded-sm text-left transition-[background-color] duration-150 hover:bg-night-hover",
          collapsed ? "size-12 justify-center" : "w-full gap-3 px-2 py-2",
        )}
      >
        {avatar}
        {collapsed ? null : (
          <>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-base leading-5 font-semibold text-paper">{user.name ?? user.email ?? "Signed in"}</span>
              <span className="block truncate text-xs text-night-muted">{plan ?? user.email}</span>
            </span>
            <SlidersHorizontal className="size-4 shrink-0 text-night-soft" aria-hidden />
          </>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" sideOffset={8} className="w-60 rounded-lg bg-paper p-1.5 text-ink shadow-raised ring-0">
        <DropdownMenuLabel className="px-3 py-2 font-normal">
          <span className="block truncate text-md font-semibold text-ink">{user.name ?? "Signed in"}</span>
          {user.email ? <span className="block truncate text-xs text-muted">{user.email}</span> : null}
        </DropdownMenuLabel>
        <DropdownMenuSeparator className="mx-2 my-1 bg-line" />
        <DropdownMenuItem className="min-h-11 gap-3 rounded-sm px-3 text-base" onClick={() => router.push("/dashboard/settings")}>
          <Settings className="size-4" aria-hidden />
          Settings
        </DropdownMenuItem>
        {canManageBilling ? (
          <DropdownMenuItem className="min-h-11 gap-3 rounded-sm px-3 text-base" onClick={() => router.push("/dashboard/billing")}>
            <CreditCard className="size-4" aria-hidden />
            Billing
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator className="mx-2 my-1 bg-line" />
        <DropdownMenuItem
          className="min-h-11 gap-3 rounded-sm px-3 text-base text-failed-text data-highlighted:bg-failed-tint"
          onClick={() => signOut({ callbackUrl: "/login" })}
        >
          <LogOut className="size-4" aria-hidden />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ---------------------------------------------------------------------------
// Nav
// ---------------------------------------------------------------------------

function NavList({
  pathname,
  collapsed,
  needsYou,
  onNavigate,
}: {
  pathname: string;
  collapsed: boolean;
  needsYou: number;
  onNavigate?: () => void;
}) {
  const current = activeNavHref(pathname);
  const uid = useId();
  return (
    <div className="flex flex-col gap-3">
      {NAV_GROUPS.map((group) => {
        const headingId = `${uid}-nav-${group.id}`;
        return (
          <div
            key={group.id}
            role="group"
            aria-labelledby={group.title && !collapsed ? headingId : undefined}
            aria-label={group.title ? (collapsed ? group.title : undefined) : group.id === "account" ? "Account" : "Home"}
            className={cn(group.id === "account" && "border-t border-night-line pt-3", collapsed && group.title && "border-t border-night-line pt-3")}
          >
            {group.title && !collapsed ? (
              <div id={headingId} className="mb-1 px-3 text-xs font-semibold text-night-muted">
                {group.title}
              </div>
            ) : null}
            <ul className={cn("flex flex-col gap-0.5", collapsed && "items-center")}>
              {group.items.map((item) => {
                const active = item.href === current;
                const Icon = item.icon;
                const count = item.badge === "needs-you" ? needsYou : 0;
                if (collapsed) {
                  const tip = count > 0 ? `${item.label}: ${count} waiting on you` : item.label;
                  return (
                    <li key={item.href}>
                      <RailTip label={tip}>
                        <Link
                          href={item.href}
                          aria-label={tip}
                          aria-current={active ? "page" : undefined}
                          onClick={onNavigate}
                          className={cn(
                            "relative flex size-11 items-center justify-center rounded-full transition-[background-color,color] duration-150",
                            active ? "bg-paper text-ink" : "text-night-soft hover:bg-night-hover hover:text-paper",
                          )}
                        >
                          <Icon aria-hidden className="size-[18px]" />
                          {count > 0 ? (
                            <span aria-hidden className="absolute top-2 right-2 size-2 rounded-full bg-needs ring-2 ring-ink" />
                          ) : null}
                        </Link>
                      </RailTip>
                    </li>
                  );
                }
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      aria-current={active ? "page" : undefined}
                      onClick={onNavigate}
                      className={cn(
                        "flex h-10 items-center gap-3 rounded-full px-3 text-base transition-[background-color,color] duration-150",
                        active ? "bg-paper font-semibold text-ink" : "text-night-soft hover:bg-night-hover hover:text-paper",
                      )}
                    >
                      <Icon aria-hidden className="size-[18px] shrink-0" />
                      <span className="min-w-0 flex-1 truncate">{item.label}</span>
                      {count > 0 ? (
                        <CountBadge count={count} tone="needs" label={`${count} approval${count === 1 ? "" : "s"} waiting on you`} />
                      ) : null}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Running now + usage
// ---------------------------------------------------------------------------

function RunningNow({ tree, collapsed, onNavigate }: { tree: SidebarTree; collapsed: boolean; onNavigate?: () => void }) {
  const headingId = `${useId()}-running`;
  const live = tree ? [tree.lead, ...tree.branches].filter((n) => n.status !== "done").length : 0;
  if (collapsed) {
    if (!tree) return null;
    const nodes = [tree.lead, ...visibleBranches(tree.branches, MAX_RUNNING_ROWS - 1).shown];
    return (
      <ul aria-label="Running now" className="flex flex-col items-center gap-1 border-t border-night-line pt-3">
        {nodes.map((n) => {
          const tip = `${n.name}${n.isLead ? " (lead)" : ""}: ${n.line}`;
          return (
            <li key={n.key}>
              <RailTip label={tip}>
                <Link
                  href={n.href ?? "/dashboard/runs"}
                  aria-label={`${tip}. ${STATUS_META[n.status].label}`}
                  onClick={onNavigate}
                  className="flex size-10 items-center justify-center rounded-full hover:bg-night-hover"
                >
                  <StatusShape status={n.status} size={n.isLead ? 13 : 11} tone="night" />
                </Link>
              </RailTip>
            </li>
          );
        })}
      </ul>
    );
  }
  return (
    <section aria-labelledby={headingId} className="border-t border-night-line px-2 pt-3">
      <div className="mb-1 flex items-center justify-between px-2">
        <h2 id={headingId} className="text-xs font-semibold text-night-muted">
          Running now
        </h2>
        {tree ? <span className="text-xs font-semibold text-night-muted tabular-nums">{live}</span> : null}
      </div>
      {tree ? (
        <AgentTree lead={tree.lead} branches={tree.branches} tone="night" maxBranches={MAX_RUNNING_ROWS - 1} onNavigate={onNavigate} />
      ) : (
        <p className="px-2 pb-2 text-xs text-night-muted">Nothing running. Start a new task and it shows up here.</p>
      )}
    </section>
  );
}

function UsageMeterBox({ usage }: { usage: NonNullable<SidebarUsage> }) {
  return (
    <Link
      href="/dashboard/settings/usage"
      className="block rounded-md bg-night-hover px-4 py-3 transition-[background-color] duration-150 hover:bg-night-raised"
      aria-label={`Usage this month: ${usage.pct}% (${usage.used.toLocaleString()} of ${usage.cap.toLocaleString()} credits)`}
    >
      <span className="flex items-center justify-between text-xs">
        <span className="text-night-soft">Usage this month</span>
        <span className="font-semibold text-paper tabular-nums">{usage.pct}%</span>
      </span>
      <span aria-hidden className="mt-2 block h-1 overflow-hidden rounded-full bg-night-line">
        <span className="block h-full rounded-full bg-paper" style={{ width: `${usage.pct}%` }} />
      </span>
    </Link>
  );
}

// ---------------------------------------------------------------------------
// The panel (shared by the desktop sidebar, the mobile drawer and the gallery)
// ---------------------------------------------------------------------------

export interface SidebarPanelProps {
  user: SidebarUser;
  plan?: string | null;
  workspaces: SidebarWorkspace[];
  currentWorkspaceId: string;
  canManageBilling?: boolean;
  pathname: string;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  needsYou: number;
  tree: SidebarTree;
  usage: SidebarUsage;
  onNavigate?: () => void;
  /** Contextual section under the nav (assistant chat threads). */
  extra?: ReactNode;
  /** Mobile drawer: a close button next to the workspace switcher. */
  onClose?: () => void;
}

export function SidebarPanel({
  user,
  plan,
  workspaces,
  currentWorkspaceId,
  canManageBilling,
  pathname,
  collapsed = false,
  onToggleCollapsed,
  needsYou,
  tree,
  usage,
  onNavigate,
  extra,
  onClose,
}: SidebarPanelProps) {
  const planText = planLabel(plan);
  const toggle = onToggleCollapsed ? (
    <button
      type="button"
      onClick={onToggleCollapsed}
      aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      aria-expanded={!collapsed}
      className="flex size-9 shrink-0 items-center justify-center rounded-full text-night-soft transition-[background-color,color] duration-150 hover:bg-night-hover hover:text-paper"
    >
      {collapsed ? <PanelLeftOpen className="size-4" aria-hidden /> : <PanelLeftClose className="size-4" aria-hidden />}
    </button>
  ) : null;

  return (
    <TooltipPrimitive.Provider delay={150}>
      <div className="flex h-full min-h-0 flex-col">
        <div className={cn("flex flex-col gap-4 pt-4", collapsed ? "items-center px-2" : "px-3")}>
          <div className={cn("flex items-center gap-1", collapsed ? "justify-center" : "w-full")}>
            <div className={cn(!collapsed && "min-w-0 flex-1")}>
              <WorkspaceMenu workspaces={workspaces} currentId={currentWorkspaceId} canManageBilling={canManageBilling} collapsed={collapsed} />
            </div>
            {onClose ? (
              <button
                type="button"
                onClick={onClose}
                aria-label="Close navigation"
                className="flex size-9 shrink-0 items-center justify-center rounded-full text-night-soft hover:bg-night-hover hover:text-paper"
              >
                <X className="size-4" aria-hidden />
              </button>
            ) : null}
          </div>
          {collapsed ? (
            <RailTip label="New task (⌘N)">
              <button
                type="button"
                onClick={() => {
                  onNavigate?.();
                  openNewTask();
                }}
                aria-label="New task"
                aria-haspopup="dialog"
                className="aos-press flex size-11 items-center justify-center rounded-full bg-paper text-ink"
              >
                <Plus className="size-5" aria-hidden />
              </button>
            </RailTip>
          ) : (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  onNavigate?.();
                  openNewTask();
                }}
                aria-haspopup="dialog"
                title="New task (⌘N)"
                className="aos-press flex h-11 flex-1 items-center justify-center gap-2 rounded-full bg-paper text-base font-semibold text-ink"
              >
                <Plus className="size-4" aria-hidden />
                New task
              </button>
              <button
                type="button"
                onClick={() => {
                  onNavigate?.();
                  openCommandBar();
                }}
                aria-label="Search (⌘K)"
                title="Search (⌘K)"
                className="aos-press flex size-11 shrink-0 items-center justify-center rounded-full bg-night-raised text-paper hover:bg-night-line"
              >
                <Search className="size-4" aria-hidden />
              </button>
            </div>
          )}
        </div>
        <nav aria-label="Dashboard" className={cn("thin-scroll mt-3 min-h-0 flex-1 overflow-y-auto pb-3", collapsed ? "px-2" : "px-3")}>
          <NavList pathname={pathname} collapsed={collapsed} needsYou={needsYou} onNavigate={onNavigate} />
          {extra && !collapsed ? <div className="mt-4 border-t border-night-line pt-3">{extra}</div> : null}
        </nav>
        <div className={cn("shrink-0", collapsed && "px-2")}>
          <RunningNow tree={tree} collapsed={collapsed} onNavigate={onNavigate} />
        </div>
        <div className={cn("flex shrink-0 flex-col gap-2 pt-3 pb-3", collapsed ? "items-center px-2" : "px-3")}>
          {usage && !collapsed ? <UsageMeterBox usage={usage} /> : null}
          <div className={cn("flex items-center gap-1", collapsed && "flex-col")}>
            <UserRow user={user} plan={planText} collapsed={collapsed} canManageBilling={canManageBilling} />
            {toggle}
          </div>
        </div>
      </div>
    </TooltipPrimitive.Provider>
  );
}

// ---------------------------------------------------------------------------
// Desktop sidebar
// ---------------------------------------------------------------------------

export interface DashboardChromeProps {
  user: SidebarUser;
  plan?: string | null;
  workspaces: SidebarWorkspace[];
  currentWorkspaceId: string;
  canManageBilling?: boolean;
  /** Server-rendered first paint of "Running now" and the usage meter. */
  initialTree?: SidebarTree;
  initialUsage?: SidebarUsage;
}

export function AppSidebar(props: DashboardChromeProps) {
  const pathname = usePathname();
  const chat = useChat();
  const { actionable } = useNeedsYouCount();
  const { tree, usage } = useAgentActivity({ tree: props.initialTree ?? null, usage: props.initialUsage ?? null });
  // 288px expanded / 80px rail. A per-viewer convenience: localStorage.
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
  // On the assistant page the sidebar gains the chat-thread list (AI tab).
  const showThreads = !collapsed && pathname === "/dashboard/assistant" && chat.tab === "ai" && chat.session !== null;
  return (
    <aside className={cn("aos-night sticky top-0 hidden h-screen shrink-0 md:block", collapsed ? "w-20" : "w-72")}>
      <SidebarPanel
        {...props}
        pathname={pathname}
        collapsed={collapsed}
        onToggleCollapsed={toggleCollapsed}
        needsYou={actionable}
        tree={tree}
        usage={usage}
        extra={
          showThreads ? (
            <>
              <div className="mb-2 truncate px-3 text-xs font-semibold text-night-muted">Chats · {chat.session?.projectDomain}</div>
              <ThreadListSection />
            </>
          ) : null
        }
      />
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Mobile: top bar + black drawer with the same panel
// ---------------------------------------------------------------------------

export function MobileNav({
  headerActions,
  ...props
}: DashboardChromeProps & {
  /** Top-bar slot before the menu button (e.g. the notification bell). */
  headerActions?: ReactNode;
}) {
  const pathname = usePathname();
  const { actionable } = useNeedsYouCount();
  const { tree, usage } = useAgentActivity({ tree: props.initialTree ?? null, usage: props.initialUsage ?? null });
  const [open, setOpen] = useState(false);
  const lead = tree?.lead ?? null;
  return (
    <header className="sticky top-0 z-40 flex h-14 items-center justify-between border-b border-line bg-paper px-4 md:hidden">
      <Link href="/dashboard" className="flex items-center gap-2.5" aria-label="ShapesOS home">
        <LogoMark size={26} />
        <span className="text-[17px] font-extrabold stretch-display tracking-heading text-ink">ShapesOS</span>
      </Link>
      <div className="flex items-center gap-1.5">
        {lead ? (
          <Link
            href={lead.href ?? "/dashboard"}
            aria-label={`${lead.name}: ${STATUS_META[lead.status].label}. ${lead.line}`}
            className="flex size-10 items-center justify-center rounded-full hover:bg-hover"
          >
            <StatusShape status={lead.status} size={12} />
          </Link>
        ) : null}
        {headerActions}
        <Dialog.Root open={open} onOpenChange={setOpen}>
          <Dialog.Trigger
            aria-label="Open navigation"
            className="relative flex size-10 items-center justify-center rounded-full text-ink hover:bg-hover"
          >
            <MenuIcon className="size-5" aria-hidden />
            {actionable > 0 ? <span aria-hidden className="absolute top-2 right-2 size-2 rounded-full bg-needs ring-2 ring-paper" /> : null}
          </Dialog.Trigger>
          <Dialog.Portal>
            <Dialog.Backdrop className="fixed inset-0 z-50 bg-ink/40 transition-opacity duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0" />
            <Dialog.Popup className="aos-night fixed inset-y-0 left-0 z-50 w-[min(20rem,88vw)] shadow-overlay transition-transform duration-200 ease-aos data-ending-style:-translate-x-full data-starting-style:-translate-x-full">
              <Dialog.Title className="sr-only">Navigation</Dialog.Title>
              <SidebarPanel
                {...props}
                pathname={pathname}
                needsYou={actionable}
                tree={tree}
                usage={usage}
                onNavigate={() => setOpen(false)}
                onClose={() => setOpen(false)}
              />
            </Dialog.Popup>
          </Dialog.Portal>
        </Dialog.Root>
      </div>
    </header>
  );
}
