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
import { forgetOfflineData } from "@/lib/offline/client";
import { useCallback, useEffect, useId, useState, type ReactNode } from "react";
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import { Dialog } from "@base-ui/react/dialog";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronsUpDown,
  History,
  Pin,
  PinOff,
  CreditCard,
  LogOut,
  LayoutDashboard,
  Menu as MenuIcon,
  MessageSquare,
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
import { activeNavHref, NAV_GROUPS, pathMatches, visibleNavGroups, type NavItem } from "@/lib/nav/config";
// Phase 18.1 (WS=desk): the dock — pins + recents over the one nav list.
import { pinnedNavItems } from "@/lib/desktop/nav-overlay";
import { appForHref } from "@/lib/desktop/recents";
import { useDock, type DockState } from "@/components/desk/useDock";
import { openAppSwitcher } from "@/components/desk/events";
import { useInPane, useLocalFlag, writeLocalFlag } from "@/components/desk/useInPane";
import { visibleBranches, type AgentNode } from "@/lib/aos/agents";
// Phase 18.1 (WS=find, i18n): shell strings and nav labels in the person's
// language. Edits in this file are limited to t() calls and the localized
// nav overlay (lib/nav/i18n.ts) — WS=desk owns the dock/pins changes here.
import { useMemo } from "react";
import { useI18n } from "@/components/i18n/I18nProvider";
import { localizeNavGroups } from "@/lib/nav/i18n";
import { navText } from "@/lib/i18n";
// Phase 18.2 (WS=comms): the Messages row shows its unread count.
import { useMessagesUnread } from "@/components/comms/useMessagesUnread";
// Member-requested (Oct 2026): one-click light/dark switch, bottom of the sidebar.
import { ThemeToggle } from "@/components/preferences/ThemeToggle";

export type SidebarUser = { name?: string | null; email?: string | null };
export type SidebarWorkspace = { id: string; name: string };
export type SidebarTree = { lead: AgentNode; branches: AgentNode[] } | null;
export type SidebarUsage = { used: number; cap: number; pct: number } | null;

const COLLAPSE_KEY = "shapesos:sidebar:collapsed";
const GROUPS_FOLDED_KEY = "shapesos:sidebar:groups-folded";
// Oct 2026 (approved redesign): the two destinations pinned above the nav
// groups. Labels are shell strings (lib/i18n/messages).
const PINNED_ROWS = [
  { href: "/dashboard/assistant", labelKey: "shell.pinnedChat", icon: MessageSquare },
  { href: "/dashboard", labelKey: "shell.pinnedFeed", icon: LayoutDashboard },
] as const;
// The pinned rows own these destinations; the same items stay in the nav
// config for hotkeys, ⌘K search and active-route matching, but each route
// renders once (pinned row), never twice (pinned + group row both lit).
const PINNED_HREFS: ReadonlySet<string> = new Set(PINNED_ROWS.map((row) => row.href));
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
  const { t } = useI18n(); // p18-find i18n
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
        aria-label={t("shell.switchWorkspaceCurrent", { name: current?.name ?? t("shell.workspace") })}
        className={cn(
          "flex items-center rounded-sm text-left transition-[background-color] duration-150 hover:bg-night-hover",
          collapsed ? "size-12 justify-center" : "w-full gap-3 px-2 py-1.5",
        )}
      >
        <LogoMark size={collapsed ? 28 : 30} />
        {collapsed ? null : (
          <>
            <span className="min-w-0 flex-1">
              <span className="block text-[1.0625rem] leading-5 font-extrabold stretch-display tracking-heading text-night-text">ShapesOS</span>
              <span className="block truncate text-xs text-night-muted">{current?.name ?? t("shell.workspace")}</span>
            </span>
            <ChevronsUpDown className="size-4 shrink-0 text-night-soft" aria-hidden />
          </>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={6} className="w-72 rounded-lg bg-paper p-1.5 text-ink shadow-raised ring-0">
        <DropdownMenuLabel className="px-3 pt-2 pb-1 text-xs font-semibold text-muted">{t("shell.switchWorkspace")}</DropdownMenuLabel>
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
                <Check className="size-4" aria-label={t("shell.currentWorkspace")} />
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
          {t("shell.createWorkspace")}
        </DropdownMenuItem>
        <DropdownMenuItem className="min-h-11 gap-3 rounded-sm px-3 text-base" onClick={() => router.push("/dashboard/settings/workspace")}>
          <Settings className="ml-2 size-4" aria-hidden />
          {t("shell.workspaceSettings")}
        </DropdownMenuItem>
        {canManageBilling ? (
          <DropdownMenuItem className="min-h-11 gap-3 rounded-sm px-3 text-base" onClick={() => router.push("/dashboard/billing")}>
            <CreditCard className="ml-2 size-4" aria-hidden />
            {t("shell.billing")}
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
  const { t } = useI18n(); // p18-find i18n
  const avatar = (
    <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-full bg-paper text-xs font-extrabold text-ink shadow-hairline">
      {initials(user)}
    </span>
  );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={t("shell.accountMenu")}
        className={cn(
          "flex items-center rounded-sm text-left transition-[background-color] duration-150 hover:bg-night-hover",
          collapsed ? "size-12 justify-center" : "w-full gap-3 px-2 py-2",
        )}
      >
        {avatar}
        {collapsed ? null : (
          <>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-base leading-5 font-semibold text-night-text">{user.name ?? user.email ?? t("shell.signedIn")}</span>
              <span className="block truncate text-xs text-night-muted">{plan ?? user.email}</span>
            </span>
            <SlidersHorizontal className="size-4 shrink-0 text-night-soft" aria-hidden />
          </>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" sideOffset={8} className="w-60 rounded-lg bg-paper p-1.5 text-ink shadow-raised ring-0">
        <DropdownMenuLabel className="px-3 py-2 font-normal">
          <span className="block truncate text-md font-semibold text-ink">{user.name ?? t("shell.signedIn")}</span>
          {user.email ? <span className="block truncate text-xs text-muted">{user.email}</span> : null}
        </DropdownMenuLabel>
        <DropdownMenuSeparator className="mx-2 my-1 bg-line" />
        <DropdownMenuItem className="min-h-11 gap-3 rounded-sm px-3 text-base" onClick={() => router.push("/dashboard/settings")}>
          <Settings className="size-4" aria-hidden />
          {t("shell.settings")}
        </DropdownMenuItem>
        {canManageBilling ? (
          <DropdownMenuItem className="min-h-11 gap-3 rounded-sm px-3 text-base" onClick={() => router.push("/dashboard/billing")}>
            <CreditCard className="size-4" aria-hidden />
            {t("shell.billing")}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator className="mx-2 my-1 bg-line" />
        <DropdownMenuItem
          className="min-h-11 gap-3 rounded-sm px-3 text-base text-failed-text data-highlighted:bg-failed-tint"
          // Phase 18.3 (WS=flow): forget this person's offline copies, queue and Web Push first.
          onClick={() => void forgetOfflineData().finally(() => signOut({ callbackUrl: "/login" }))}
        >
          <LogOut className="size-4" aria-hidden />
          {t("shell.signOut")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ---------------------------------------------------------------------------
// Nav
// ---------------------------------------------------------------------------

/** One nav row: the link, its count pill, and (expanded) the pin toggle. */
function NavRow({
  item,
  active,
  collapsed,
  count: countProp,
  pinned,
  onTogglePin,
  onNavigate,
}: {
  item: NavItem;
  active: boolean;
  collapsed: boolean;
  count: number;
  pinned?: boolean;
  onTogglePin?: (href: string) => void;
  onNavigate?: () => void;
}) {
  const Icon = item.icon;
  const { t } = useI18n(); // p18-find i18n
  // Phase 18.2 (WS=comms): an "unread-messages" row counts unread Messages
  // (a plain count, not "waiting on you": it never takes the needs colour).
  const unreadRow = item.badge === "unread-messages";
  const unread = useMessagesUnread(unreadRow);
  const count = unreadRow ? unread : countProp;
  const countLabel = unreadRow ? t("comms.messages.unreadLabel", { count }) : t("shell.approvalsWaiting", { count });
  if (collapsed) {
    const tip = count > 0 ? (unreadRow ? `${item.label}: ${countLabel}` : t("shell.waitingOnYou", { label: item.label, count })) : item.label;
    return (
      <li>
        <RailTip label={tip}>
          <Link
            href={item.href}
            aria-label={tip}
            aria-current={active ? "page" : undefined}
            onClick={onNavigate}
            className={cn(
              "relative flex size-11 items-center justify-center rounded-full transition-[background-color,color] duration-150",
              active ? "bg-paper text-ink shadow-hairline" : "text-night-soft hover:bg-night-hover hover:text-night-text",
            )}
          >
            <Icon aria-hidden className="size-[18px]" />
            {count > 0 ? <span aria-hidden className={cn("absolute top-2 right-2 size-2 rounded-full ring-2 ring-night", unreadRow ? "bg-paper" : "bg-needs")} /> : null}
          </Link>
        </RailTip>
      </li>
    );
  }
  return (
    <li className="group/row relative">
      <Link
        href={item.href}
        aria-current={active ? "page" : undefined}
        onClick={onNavigate}
        className={cn(
          "flex h-10 items-center gap-3 rounded-full px-3 text-base transition-[background-color,color] duration-150",
          onTogglePin && "pr-10",
          active ? "bg-paper font-semibold text-ink shadow-hairline" : "text-night-soft hover:bg-night-hover hover:text-night-text",
        )}
      >
        <Icon aria-hidden className="size-[18px] shrink-0" />
        <span className="min-w-0 flex-1 truncate">{item.label}</span>
        {count > 0 ? <CountBadge count={count} tone={unreadRow ? (active ? "ink" : "paper") : "needs"} label={countLabel} /> : null}
      </Link>
      {onTogglePin ? (
        <button
          type="button"
          onClick={() => onTogglePin(item.href)}
          aria-label={pinned ? t("desk.dock.unpin", { label: item.label }) : t("desk.dock.pin", { label: item.label })}
          aria-pressed={pinned}
          title={pinned ? t("desk.dock.unpinHint") : t("desk.dock.pinHint")}
          className={cn(
            "absolute top-1/2 right-1.5 flex size-7 -translate-y-1/2 items-center justify-center rounded-full opacity-0 transition-opacity duration-150 group-hover/row:opacity-100 focus-visible:opacity-100",
            active ? "text-ink hover:bg-hover" : "text-night-soft hover:bg-night-raised hover:text-night-text",
          )}
        >
          {pinned ? <PinOff className="size-3.5" aria-hidden /> : <Pin className="size-3.5" aria-hidden />}
        </button>
      ) : null}
    </li>
  );
}

const RECENTS_COLLAPSE_KEY = "shapesos:sidebar:recents-collapsed";

/** Phase 18.1: the dock — the member's pins (in their order) and recents. */
function DockSections({
  pathname,
  collapsed,
  needsYou,
  role,
  dock,
  onNavigate,
}: {
  pathname: string;
  collapsed: boolean;
  needsYou: number;
  role: string | null | undefined;
  dock: ReturnType<typeof useDock>;
  onNavigate?: () => void;
}) {
  const uid = useId();
  const [editing, setEditing] = useState(false);
  const recentsCollapsed = useLocalFlag(RECENTS_COLLAPSE_KEY);
  const current = activeNavHref(pathname);
  const { t, messages } = useI18n(); // p18-find i18n: pins carry the localized labels
  const localized = useMemo(() => localizeNavGroups(NAV_GROUPS, messages), [messages]);
  const pins = pinnedNavItems({ pinned: dock.pinned }, role, localized);
  const recents = dock.recents.filter((r) => r.href !== pathname);
  if (collapsed) {
    if (pins.length === 0) return null;
    return (
      <div role="group" aria-label={t("desk.dock.pinned")} className="border-t border-night-line pt-3">
        <ul className="flex flex-col items-center gap-0.5">
          {pins.map((item) => (
            <NavRow key={item.href} item={item} active={item.href === current} collapsed count={item.badge === "needs-you" ? needsYou : 0} onNavigate={onNavigate} />
          ))}
        </ul>
      </div>
    );
  }
  return (
    <>
      {pins.length ? (
        <div role="group" aria-labelledby={`${uid}-pinned`} data-testid="dock-pinned">
          <div className="mb-1 flex items-center justify-between px-3">
            <span id={`${uid}-pinned`} className="text-xs font-semibold text-night-muted">
              {t("desk.dock.pinned")}
            </span>
            <button
              type="button"
              onClick={() => setEditing((e) => !e)}
              aria-pressed={editing}
              className="rounded-full px-2 py-0.5 text-xs font-semibold text-night-soft hover:bg-night-hover hover:text-night-text"
            >
              {editing ? t("desk.dock.done") : t("desk.dock.reorder")}
            </button>
          </div>
          <ul className="flex flex-col gap-0.5">
            {pins.map((item, i) =>
              editing ? (
                <li key={item.href} className="flex h-10 items-center gap-2 rounded-full px-3 text-base text-night-soft">
                  <item.icon aria-hidden className="size-[18px] shrink-0" />
                  <span className="min-w-0 flex-1 truncate text-paper">{item.label}</span>
                  <button type="button" onClick={() => dock.move(item.href, -1)} disabled={i === 0} aria-label={t("desk.dock.moveUp", { label: item.label })} className="flex size-7 items-center justify-center rounded-full hover:bg-night-raised hover:text-paper disabled:opacity-30">
                    <ArrowUp className="size-3.5" aria-hidden />
                  </button>
                  <button type="button" onClick={() => dock.move(item.href, 1)} disabled={i === pins.length - 1} aria-label={t("desk.dock.moveDown", { label: item.label })} className="flex size-7 items-center justify-center rounded-full hover:bg-night-raised hover:text-paper disabled:opacity-30">
                    <ArrowDown className="size-3.5" aria-hidden />
                  </button>
                  <button type="button" onClick={() => dock.toggle(item.href)} aria-label={t("desk.dock.unpin", { label: item.label })} className="flex size-7 items-center justify-center rounded-full hover:bg-night-raised hover:text-paper">
                    <PinOff className="size-3.5" aria-hidden />
                  </button>
                </li>
              ) : (
                <NavRow
                  key={item.href}
                  item={item}
                  active={item.href === current}
                  collapsed={false}
                  count={item.badge === "needs-you" ? needsYou : 0}
                  pinned
                  onTogglePin={dock.toggle}
                  onNavigate={onNavigate}
                />
              ),
            )}
          </ul>
        </div>
      ) : null}
      {recents.length ? (
        <div role="group" aria-labelledby={`${uid}-recent`} data-testid="dock-recents">
          <div className="mb-1 flex items-center justify-between px-3">
            <button
              type="button"
              id={`${uid}-recent`}
              onClick={() => writeLocalFlag(RECENTS_COLLAPSE_KEY, !recentsCollapsed)}
              aria-expanded={!recentsCollapsed}
              className="flex items-center gap-1 rounded-full text-xs font-semibold text-night-muted hover:text-paper"
            >
              {t("desk.dock.recent")}
              <ChevronDown aria-hidden className={cn("size-3 transition-transform duration-150", recentsCollapsed && "-rotate-90")} />
            </button>
            <button
              type="button"
              onClick={() => {
                onNavigate?.();
                openAppSwitcher();
              }}
              title={t("desk.dock.switchHint")}
              className="rounded-full px-2 py-0.5 text-xs font-semibold text-night-soft hover:bg-night-hover hover:text-night-text"
            >
              {t("desk.dock.switch")}
            </button>
          </div>
          {recentsCollapsed ? null : (
            <ul className="flex flex-col gap-0.5">
              {recents.map((r) => {
                const app = appForHref(r.href);
                const Icon = app?.icon ?? History;
                return (
                  <li key={r.href}>
                    <Link
                      href={r.href}
                      onClick={onNavigate}
                      className="flex h-9 items-center gap-3 rounded-full px-3 text-sm text-night-soft transition-[background-color,color] duration-150 hover:bg-night-hover hover:text-night-text"
                    >
                      <Icon aria-hidden className="size-4 shrink-0" />
                      <span className="min-w-0 flex-1 truncate">{r.kind === "app" ? (navText(messages, r.href).label ?? r.title) : r.title}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
      {dock.error ? <p className="px-3 text-xs text-failed-night">{dock.error}</p> : null}
    </>
  );
}

function NavList({
  pathname,
  collapsed,
  needsYou,
  role,
  dock,
  onNavigate,
}: {
  pathname: string;
  collapsed: boolean;
  needsYou: number;
  role?: string | null;
  dock: ReturnType<typeof useDock>;
  onNavigate?: () => void;
}) {
  const current = activeNavHref(pathname);
  const uid = useId();
  const { t, messages } = useI18n(); // p18-find i18n
  // Phase 18.1: the nav as this member's role sees it (gated items hidden),
  // in the person's language (lib/nav/i18n overlay).
  const groups = useMemo(() => localizeNavGroups(visibleNavGroups(role), messages), [role, messages]);
  const pinnedSet = new Set(dock.pinned);
  // Oct 2026 (approved redesign): titled groups fold away; the choice is a
  // per-viewer convenience kept in localStorage.
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(GROUPS_FOLDED_KEY);
      if (raw) setFolded(new Set(JSON.parse(raw) as string[]));
    } catch {
      // storage unavailable: groups stay open
    }
  }, []);
  function toggleGroup(id: string) {
    setFolded((prev) => {
      const nextSet = new Set(prev);
      if (nextSet.has(id)) nextSet.delete(id);
      else nextSet.add(id);
      try {
        window.localStorage.setItem(GROUPS_FOLDED_KEY, JSON.stringify([...nextSet]));
      } catch {
        // best effort
      }
      return nextSet;
    });
  }
  return (
    <div className="flex flex-col gap-3">
      {/* Oct 2026 (approved redesign): Chat and Feed pinned above the nav.
          Shortcuts to existing destinations (/dashboard/assistant and
          /dashboard); the full groups below keep their own rows. */}
      <ul className={cn("flex flex-col gap-0.5", collapsed && "items-center")} aria-label={t("shell.pinnedChat")}>
        {PINNED_ROWS.map((row) => (
          <NavRow
            key={row.href}
            item={{ href: row.href, label: t(row.labelKey), icon: row.icon, description: "" }}
            active={row.href === "/dashboard" ? pathname === "/dashboard" : pathMatches(pathname, row.href)}
            collapsed={collapsed}
            count={0}
            onNavigate={onNavigate}
          />
        ))}
      </ul>
      {groups.map((group) => {
        const headingId = `${uid}-nav-${group.id}`;
        const isFolded = !collapsed && group.title != null && folded.has(group.id);
        return (
          <div key={group.id} className="contents">
            <div
              role="group"
              aria-labelledby={group.title && !collapsed ? headingId : undefined}
              aria-label={group.title ? (collapsed ? group.title : undefined) : group.id === "account" ? t("shell.groupAccount") : t("shell.groupHome")}
              className={cn(group.id === "account" && "border-t border-night-line pt-3", collapsed && group.title && "border-t border-night-line pt-3")}
            >
              {group.title && !collapsed ? (
                <button
                  type="button"
                  id={headingId}
                  onClick={() => toggleGroup(group.id)}
                  aria-expanded={!isFolded}
                  aria-label={isFolded ? t("shell.groupExpand", { group: group.title }) : t("shell.groupCollapse", { group: group.title })}
                  className="mb-1 flex w-full items-center justify-between rounded-sm px-3 py-0.5 text-xs font-semibold text-night-muted transition-colors hover:text-night-text"
                >
                  <span>{group.title}</span>
                  <ChevronDown className={cn("size-3.5 transition-transform duration-150", isFolded && "-rotate-90")} aria-hidden />
                </button>
              ) : null}
              {!isFolded ? (
                <ul className={cn("flex flex-col gap-0.5", collapsed && "items-center")}>
                  {group.items
                    .filter((item) => !PINNED_HREFS.has(item.href))
                    .map((item) => (
                    <NavRow
                      key={item.href}
                      item={item}
                      active={item.href === current}
                      collapsed={collapsed}
                      count={item.badge === "needs-you" ? needsYou : 0}
                      pinned={pinnedSet.has(item.href)}
                      onTogglePin={collapsed ? undefined : dock.toggle}
                      onNavigate={onNavigate}
                    />
                  ))}
                </ul>
              ) : null}
            </div>
            {/* Phase 18.1: the dock sits right under Home (Overview). */}
            {group.id === "home" ? <DockSections pathname={pathname} collapsed={collapsed} needsYou={needsYou} role={role} dock={dock} onNavigate={onNavigate} /> : null}
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
  const { t } = useI18n(); // p18-find i18n
  const live = tree ? [tree.lead, ...tree.branches].filter((n) => n.status !== "done").length : 0;
  if (collapsed) {
    if (!tree) return null;
    const nodes = [tree.lead, ...visibleBranches(tree.branches, MAX_RUNNING_ROWS - 1).shown];
    return (
      <ul aria-label={t("shell.runningNow")} className="flex flex-col items-center gap-1 border-t border-night-line pt-3">
        {nodes.map((n) => {
          const tip = `${n.name}${n.isLead ? t("shell.leadSuffix") : ""}: ${n.line}`;
          return (
            <li key={n.key}>
              <RailTip label={tip}>
                <Link
                  href={n.href ?? "/dashboard/runs"}
                  aria-label={`${tip}. ${t(`status.${n.status}`)}`}
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
          {t("shell.runningNow")}
        </h2>
        {tree ? <span className="text-xs font-semibold text-night-muted tabular-nums">{live}</span> : null}
      </div>
      {tree ? (
        <AgentTree lead={tree.lead} branches={tree.branches} tone="night" maxBranches={MAX_RUNNING_ROWS - 1} onNavigate={onNavigate} t={t} />
      ) : (
        <p className="px-2 pb-2 text-xs text-night-muted">{t("shell.nothingRunning")}</p>
      )}
    </section>
  );
}

function UsageMeterBox({ usage }: { usage: NonNullable<SidebarUsage> }) {
  const { t, format } = useI18n(); // p18-find i18n
  return (
    <Link
      href="/dashboard/settings/usage"
      className="block rounded-md bg-night-hover px-4 py-3 transition-[background-color] duration-150 hover:bg-night-raised"
      aria-label={t("shell.usageAria", { pct: usage.pct, used: format.number(usage.used), cap: format.number(usage.cap) })}
    >
      <span className="flex items-center justify-between text-xs">
        <span className="text-night-soft">{t("shell.usageThisMonth")}</span>
        <span className="font-semibold text-night-text tabular-nums">{usage.pct}%</span>
      </span>
      <span aria-hidden className="mt-2 block h-1 overflow-hidden rounded-full bg-night-line">
        <span className="block h-full rounded-full bg-night-text" style={{ width: `${usage.pct}%` }} />
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
  /** Phase 18.1: the member's role here (nav gating) and their dock. */
  role?: string | null;
  initialDock?: DockState | null;
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
  role,
  initialDock,
}: SidebarPanelProps) {
  const { t } = useI18n(); // p18-find i18n
  const planBase = planLabel(plan);
  const planText = planBase ? t("shell.planLabel", { plan: planBase.replace(/ plan$/, "") }) : null;
  const dock = useDock(initialDock ?? null);
  const toggle = onToggleCollapsed ? (
    <button
      type="button"
      onClick={onToggleCollapsed}
      aria-label={collapsed ? t("shell.expandSidebar") : t("shell.collapseSidebar")}
      aria-expanded={!collapsed}
      className="flex size-9 shrink-0 items-center justify-center rounded-full text-night-soft transition-[background-color,color] duration-150 hover:bg-night-hover hover:text-night-text"
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
                aria-label={t("shell.closeNavigation")}
                className="flex size-9 shrink-0 items-center justify-center rounded-full text-night-soft hover:bg-night-hover hover:text-night-text"
              >
                <X className="size-4" aria-hidden />
              </button>
            ) : null}
          </div>
          {collapsed ? (
            <RailTip label={t("shell.newTaskHint")}>
              <button
                type="button"
                onClick={() => {
                  onNavigate?.();
                  openNewTask();
                }}
                aria-label={t("shell.newTask")}
                aria-haspopup="dialog"
                className="aos-press flex size-11 items-center justify-center rounded-full bg-paper text-ink shadow-hairline"
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
                title={t("shell.newTaskHint")}
                className="aos-press flex h-11 flex-1 items-center justify-center gap-2 rounded-full bg-paper text-base font-semibold text-ink shadow-hairline"
              >
                <Plus className="size-4" aria-hidden />
                {t("shell.newTask")}
              </button>
              <button
                type="button"
                onClick={() => {
                  onNavigate?.();
                  openCommandBar();
                }}
                aria-label={t("shell.search")}
                title={t("shell.search")}
                className="aos-press flex size-11 shrink-0 items-center justify-center rounded-full bg-night-raised text-night-text hover:bg-night-line"
              >
                <Search className="size-4" aria-hidden />
              </button>
            </div>
          )}
        </div>
        <nav data-shell-nav aria-label={t("shell.dashboardNav")} className={cn("thin-scroll mt-3 min-h-0 flex-1 overflow-y-auto pb-3", collapsed ? "px-2" : "px-3")}>
          <NavList pathname={pathname} collapsed={collapsed} needsYou={needsYou} role={role} dock={dock} onNavigate={onNavigate} />
          {extra && !collapsed ? <div className="mt-4 border-t border-night-line pt-3">{extra}</div> : null}
        </nav>
        <div className={cn("shrink-0", collapsed && "px-2")}>
          <RunningNow tree={tree} collapsed={collapsed} onNavigate={onNavigate} />
        </div>
        <div className={cn("flex shrink-0 flex-col gap-2 pt-3 pb-3", collapsed ? "items-center px-2" : "px-3")}>
          {usage && !collapsed ? <UsageMeterBox usage={usage} /> : null}
          <div className={cn("flex items-center gap-1", collapsed && "flex-col")}>
            <UserRow user={user} plan={planText} collapsed={collapsed} canManageBilling={canManageBilling} />
            <ThemeToggle />
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
  /** Phase 18.1 (WS=desk): role for nav gating; the dock's first paint. */
  role?: string | null;
  initialDock?: DockState | null;
}

export function AppSidebar(props: DashboardChromeProps) {
  const pathname = usePathname();
  const inPane = useInPane();
  const { t } = useI18n(); // p18-find i18n
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
  // Phase 18.1: never inside a split-view pane.
  if (inPane) return null;
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
              <div className="mb-2 truncate px-3 text-xs font-semibold text-night-muted">{t("shell.chatsFor", { project: chat.session?.projectDomain ?? "" })}</div>
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
  const { t } = useI18n(); // p18-find i18n
  const lead = tree?.lead ?? null;
  const inPane = useInPane();
  if (inPane) return null;
  return (
    <header className="sticky top-0 z-40 flex h-14 items-center justify-between border-b border-line bg-paper px-4 md:hidden">
      <Link href="/dashboard" className="flex items-center gap-2.5" aria-label={t("shell.home")}>
        <LogoMark size={26} />
        <span className="text-[1.0625rem] font-extrabold stretch-display tracking-heading text-ink">ShapesOS</span>
      </Link>
      <div className="flex items-center gap-1.5">
        {lead ? (
          <Link
            href={lead.href ?? "/dashboard"}
            aria-label={`${lead.name}: ${t(`status.${lead.status}`)}. ${lead.line}`}
            className="flex size-10 items-center justify-center rounded-full hover:bg-hover"
          >
            <StatusShape status={lead.status} size={12} />
          </Link>
        ) : null}
        {headerActions}
        <Dialog.Root open={open} onOpenChange={setOpen}>
          <Dialog.Trigger
            aria-label={t("shell.openNavigation")}
            className="relative flex size-10 items-center justify-center rounded-full text-ink hover:bg-hover"
          >
            <MenuIcon className="size-5" aria-hidden />
            {actionable > 0 ? <span aria-hidden className="absolute top-2 right-2 size-2 rounded-full bg-needs ring-2 ring-paper" /> : null}
          </Dialog.Trigger>
          <Dialog.Portal>
            <Dialog.Backdrop className="fixed inset-0 z-50 bg-night/40 transition-opacity duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0" />
            <Dialog.Popup className="aos-night fixed inset-y-0 left-0 z-50 w-[min(20rem,88vw)] shadow-overlay transition-transform duration-200 ease-aos data-ending-style:-translate-x-full data-starting-style:-translate-x-full">
              <Dialog.Title className="sr-only">{t("shell.navigation")}</Dialog.Title>
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
