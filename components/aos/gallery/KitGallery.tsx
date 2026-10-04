"use client";

// ShapesOS — the Agentic OS kit gallery: every components/aos component in
// every state, laid out like the five kit pages (docs/design/kit/*.png) so
// the owner can compare them side by side. Lives at /dashboard/settings/design.

import { useMemo, useState, type ReactNode } from "react";
import {
  ArrowUp,
  CalendarDays,
  ChevronDown,
  Clock,
  Copy,
  FileText,
  Globe,
  Inbox,
  Mail,
  Paperclip,
  Pause,
  Play,
  Plus,
  Search,
  Siren,
  Trash2,
  Wrench,
  X,
  Folder,
  CreditCard,
} from "lucide-react";
import { AOS_STATUSES, STATUS_META, type AosColorStatus, type AosStatus } from "@/lib/aos/status";
import { feedback } from "@/lib/ui/feedback";
import { cn } from "@/lib/utils";
import { SidebarPanel } from "@/components/AppSidebar";
import {
  AgentAvatar,
  AgentCard,
  AgentTree,
  ApprovalCard,
  AvatarStack,
  Banner,
  CountBadge,
  CroppedShape,
  Field,
  FilterPill,
  KeyCap,
  LeadAgentCard,
  LiveActivity,
  MenuLabel,
  MenuRow,
  MenuSeparator,
  MenuSurface,
  PermissionSegmented,
  RunTimeline,
  StatusBadge,
  StatusShape,
  SwitchRow,
  ToastView,
  ToolCallBlock,
  ToolChip,
  Wordmark,
  aosButton,
  statusSurface,
  type Permission,
} from "@/components/aos";
import { DEMO_STEPS, demoTree, demoTreesByState } from "./demo-data";
import { TaskComposer } from "@/components/aos/Composer";
import { COMPOSER_TOOLS, composerAgents, formatBytes } from "@/lib/aos/composer";

// ---------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------

function KitPage({ id, title, note, children }: { id: string; title: string; note: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-h`} className="scroll-mt-20">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 id={`${id}-h`} className="text-lg font-bold stretch-heading tracking-heading text-ink">
          {title}
        </h2>
        <span className="aos-mono text-xs text-muted">{note}</span>
      </div>
      <div className="rounded-xl bg-canvas p-5 shadow-hairline sm:p-8">{children}</div>
    </section>
  );
}

function Label({ children }: { children: ReactNode }) {
  return <p className="mb-2.5 text-xs font-semibold text-muted">{children}</p>;
}

// ---------------------------------------------------------------------------
// 1. Foundations
// ---------------------------------------------------------------------------

const HEX: Record<AosColorStatus, string> = { running: "Blue #2450E0", needs: "Yellow #F7C21B", done: "Green #0F7F45", failed: "Red #D92D20" };
const TILE_TITLE: Record<AosColorStatus, string> = { running: "Running", needs: "Needs you", done: "Done", failed: "Failed" };

function FoundationTile({ status }: { status: AosColorStatus }) {
  return (
    <div className={cn("relative h-[265px] overflow-hidden rounded-md p-6", statusSurface(status))}>
      <CroppedShape status={status} variant="tile" />
      <p className="relative text-[22px] leading-tight font-extrabold stretch-display tracking-heading">{TILE_TITLE[status]}</p>
      <p className="relative mt-2 max-w-[22ch] text-md">{STATUS_META[status].description}</p>
      <p className="aos-mono absolute bottom-6 left-6 z-10 text-xs">{HEX[status]}</p>
    </div>
  );
}

const NEUTRALS = [
  { name: "Ink", hex: "#000000", cls: "bg-ink text-paper" },
  { name: "Paper", hex: "#FFFFFF", cls: "bg-paper text-ink shadow-hairline" },
  { name: "Canvas", hex: "#F3F3F1", cls: "bg-canvas text-ink shadow-[inset_0_0_0_1px_var(--aos-line-strong)]" },
  { name: "Line", hex: "#E2E2DF", cls: "bg-line text-ink" },
  { name: "Muted text", hex: "#5E5E5B", cls: "bg-muted text-paper" },
];

function Foundations() {
  return (
    <div className="flex flex-col gap-6">
      <Wordmark size={34} />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {(["running", "needs", "done", "failed"] as const).map((s) => (
          <FoundationTile key={s} status={s} />
        ))}
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {NEUTRALS.map((n) => (
          <div key={n.name} className={cn("rounded-md px-4 py-3.5", n.cls)}>
            <p className="text-sm font-semibold">{n.name}</p>
            <p className="aos-mono mt-2 text-xs">{n.hex}</p>
          </div>
        ))}
      </div>
      <div className="grid gap-8 lg:grid-cols-2">
        <div className="flex flex-col gap-5">
          <div>
            <Label>Status badges</Label>
            <div className="flex flex-wrap gap-2">
              {AOS_STATUSES.map((s) => (
                <StatusBadge key={s} status={s} />
              ))}
            </div>
          </div>
          <div>
            <Label>Tool chips</Label>
            <div className="flex flex-wrap gap-2">
              <ToolChip name="Web search" pressed />
              <ToolChip name="Email" />
              <ToolChip name="Calendar" />
              <ToolChip name="Code runner" />
              <ToolChip name="Files" />
            </div>
          </div>
          <div>
            <Label>Agents, counts and keys</Label>
            <div className="flex flex-wrap items-center gap-6">
              <AvatarStack names={["Researcher", "Writer", "Analyst", "Operator", "Planner", "Scheduler", "Strategist"]} max={4} />
              <span className="flex items-center gap-2">
                <CountBadge count={3} tone="needs" label="3 waiting on you" />
                <CountBadge count={2} tone="running" label="2 running" />
                <CountBadge count={12} tone="ink" label="12 total" />
              </span>
              <span className="flex items-center gap-1.5">
                <KeyCap>⌘</KeyCap>
                <KeyCap>K</KeyCap>
                <span className="w-2" />
                <KeyCap>Esc</KeyCap>
                <span className="w-2" />
                <KeyCap>⌘</KeyCap>
                <KeyCap>↵</KeyCap>
              </span>
            </div>
          </div>
        </div>
        <div className="flex flex-col gap-4">
          <div>
            <Label>Display: Archivo Expanded, 800</Label>
            <p className="text-3xl leading-[1.1] font-extrabold stretch-display tracking-display text-ink">Your agents, at work</p>
          </div>
          <div>
            <Label>Interface: Archivo, 400 to 600</Label>
            <p className="text-base text-ink">Researcher read 12 sources and drafted a brief. Review it before it goes to your team.</p>
          </div>
          <div>
            <Label>Tool output: JetBrains Mono</Label>
            <ToolCallBlock call={{ name: 'web.search("pricing page changes")', result: "18 results in 0.8 s" }} />
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 2. Agent blocks
// ---------------------------------------------------------------------------

function AgentBlocks() {
  const trees = useMemo(() => demoTreesByState(), []);
  const lead = useMemo(() => demoTree(), []);
  const [auto, setAuto] = useState(false);
  return (
    <div className="flex flex-col gap-8">
      <div>
        <Label>Agent cards, one per state (the band shows the current state, never who the agent is)</Label>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <AgentCard status="running" title="Researcher" description="Finds and reads sources, then writes briefs with citations." tools={["Web search", "Files", "Memory"]} meta="Step 3 of 7" action={{ label: "Open run", href: "#" }} />
          <AgentCard status="needs" title="Writer" description="Drafts emails, posts and docs in your voice, then asks before anything goes out." tools={["Email", "Files", "Calendar"]} meta="14 drafts ready" action={{ label: "Review drafts", href: "#" }} />
          <AgentCard status="failed" title="Operator" description="Keeps calendars, tickets and reminders in sync across your tools." tools={["Calendar", "Email", "Code runner"]} meta="Stopped at 9:02" action={{ label: "Reconnect", href: "#" }} />
          <AgentCard status="done" title="Analyst" description="Reads the results and says what worked." tools={["Code runner", "Files"]} meta="Finished at 9:14" action={{ label: "Open summary", href: "#" }} />
          <AgentCard status="queued" title="Planner" description="Turns a goal into a dated plan of steps." tools={["Memory", "Calendar"]} meta="Starts after the brief" action={{ label: "Open plan", href: "#" }} />
          <AgentCard status="paused" title="Scheduler" description="Puts approved work on the calendar and runs it on time." tools={["Calendar"]} meta="Paused by you" action={{ label: "Resume", href: "#" }} />
        </div>
      </div>
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <RunTimeline
          title="Weekly competitor brief"
          subtitle="Researcher started this run at 9:00"
          status="running"
          steps={DEMO_STEPS}
          completed={2}
          onPause={() => feedback.toast({ title: "Run paused", status: "done" })}
          onStop={() => feedback.toast({ title: "Run stopped", status: "failed" })}
        />
        <div className="flex flex-col gap-5">
          <ApprovalCard
            agent="Writer"
            title="Send 14 renewal emails?"
            body="Writer drafted reminders for accounts that renew in October. Nothing sends until you approve."
            items={[
              { key: "p", label: "Priya N.", detail: "Your plan renews Oct 14" },
              { key: "m", label: "Marco D.", detail: "Your plan renews Oct 16" },
              { key: "l", label: "Lena K.", detail: "Your plan renews Oct 21" },
            ]}
            totalItems={14}
            showAllHref="#"
            showAllLabel="Show all 14 drafts"
            autoApproveLabel="Let Writer send renewal emails without asking"
            autoApprove={auto}
            onAutoApproveChange={setAuto}
            editLabel="Edit drafts"
            onEdit={() => {}}
            onDeny={() => feedback.toast({ title: "Denied", description: "Writer will not send these emails.", status: "done" })}
            onApprove={() => feedback.toast({ title: "Approved and sent", description: "14 renewal emails are on their way.", status: "done" })}
          />
        </div>
      </div>
      <div>
        <Label>Lead agent with sub-agents branching beneath it (Overview)</Label>
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
          <LeadAgentCard tree={lead} action={{ label: "Open mission", href: "#" }} />
          <div className="flex flex-col gap-3">
            <Label>The same tree on the black sidebar</Label>
            <div className="aos-night rounded-lg p-3">
              <AgentTree lead={lead.lead} branches={lead.branches} tone="night" />
            </div>
          </div>
        </div>
      </div>
      <div>
        <Label>Agent tree in every lead state</Label>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {trees.map(({ status, tree }) => (
            <div key={status} className="rounded-lg bg-paper p-3 shadow-hairline">
              <div className="mb-1 flex items-center justify-between px-2.5 pt-1">
                <span className="text-xs font-semibold text-muted">Lead: {STATUS_META[status].label}</span>
                <StatusBadge status={status} size="sm" />
              </div>
              <AgentTree lead={tree.lead} branches={tree.branches} />
            </div>
          ))}
        </div>
      </div>
      <div>
        <Label>Variants the inbox, runs and missions use</Label>
        <div className="grid gap-5 lg:grid-cols-2">
          <div className="flex flex-col gap-5">
            <ApprovalCard
              mode="review"
              agent="Connector"
              title="Ask Dana to introduce Priya"
              meta="Introduction · 2h ago · Medium risk"
              body="The queue's own screen holds the draft and the send channel."
              editLabel="Edit draft"
              reviewHref="#"
            />
            <ApprovalCard
              mode="blocked"
              agent="Writer"
              title="Send 14 renewal emails"
              meta="Mission · 5m ago · Medium risk"
              blockedReason="Needs an editor or above to decide."
              openHref="#"
            />
          </div>
          <div className="flex flex-col gap-5">
            <RunTimeline
              title="Slow-season offer"
              subtitle="Strategist started this mission at 9:00"
              status="paused"
              steps={DEMO_STEPS}
              completed={2}
              resumeLabel="Resume mission"
              onResume={() => feedback.toast({ title: "Resumed", status: "running" })}
            />
            <div className="flex flex-wrap gap-2">
              <FilterPill selected onClick={() => {}} count={12}>All</FilterPill>
              <FilterPill selected={false} status="needs" count={2} onClick={() => {}}>Needs you</FilterPill>
              <FilterPill selected={false} status="running" count={3} onClick={() => {}}>Running</FilterPill>
              <FilterPill selected={false} status="failed" count={1} onClick={() => {}}>Failed</FilterPill>
              <FilterPill selected={false} count={4} onClick={() => {}}>Ad spend</FilterPill>
            </div>
            <div className="rounded-lg bg-paper p-3 shadow-hairline">
              <Label>Approvals hung under the sub-agent waiting on them</Label>
              <AgentTree
                lead={{ ...lead.lead, status: "needs", line: "2 approvals waiting on you across 1 mission" }}
                branches={lead.branches.slice(0, 1).map((b) => ({ ...b, name: "Writer", status: "needs" as const, line: "October renewal emails · 2 approvals waiting" }))}
                renderBranchContent={() => (
                  <div className="rounded-md bg-needs-tint px-3.5 py-3 text-md text-ink">Approval cards render here.</div>
                )}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 3. Toasts and banners
// ---------------------------------------------------------------------------

function ToastsAndBanners() {
  const [showInfo, setShowInfo] = useState(true);
  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
      <div className="flex flex-col gap-8">
        <div>
          <Label>Live activity</Label>
          <LiveActivity
            counts={{ running: 2, needs: 1, done: 5, failed: 1 }}
            run={{ title: "Researcher is reading sources", subtitle: "Weekly competitor brief", progress: { done: 7, total: 12 }, onStop: () => {} }}
            chips={[
              { key: "w", status: "needs", label: "Writer needs you", href: "#" },
              { key: "o", status: "failed", label: "Operator failed", href: "#" },
            ]}
            className="max-w-[440px]"
          />
        </div>
        <div>
          <Label>Banners</Label>
          <div className="flex flex-col gap-2.5">
            <Banner status="needs" title="3 approvals are waiting on you" description="Writer, Analyst and Operator paused for your approval." action={{ label: "Review all", href: "#" }} />
            <Banner status="failed" title="Operator stopped" description="Calendar access expired. Reconnect to resume its scheduled runs." action={{ label: "Reconnect", href: "#" }} />
            {showInfo ? (
              <Banner status="running" title="Agents keep working when you close this tab" description="You'll get a notification when one needs you." onDismiss={() => setShowInfo(false)} />
            ) : (
              <button type="button" className={aosButton({ variant: "secondary", size: "sm", className: "self-start" })} onClick={() => setShowInfo(true)}>
                Show the dismissed banner
              </button>
            )}
            <Banner status="done" title="Weekly brief delivered" description="Sent to 4 people at 9:41." action={{ label: "View brief", href: "#" }} />
          </div>
        </div>
      </div>
      <div>
        <Label>Toasts</Label>
        <div className="flex flex-col gap-2.5">
          <ToastView status="done" title="Brief published" description="Weekly competitor brief is in Files." action={{ label: "Open file", href: "#" }} onDismiss={() => {}} />
          <ToastView status="needs" title="Writer wants to send 14 emails" description="Drafts are ready. Nothing sends until you approve." action={{ label: "Review drafts", href: "#" }} onDismiss={() => {}} />
          <ToastView status="running" title="Researcher is reading sources" progress={{ done: 7, total: 12 }} action={{ label: "Open run", href: "#" }} onDismiss={() => {}} />
          <ToastView status="failed" title="Operator couldn't sync your calendar" description="Calendar access expired. Reconnect to resume 3 scheduled runs." action={{ label: "Reconnect", href: "#" }} onDismiss={() => {}} />
          <ToastView variant="undo" title={"Agent “Scout” deleted"} action={{ label: "Undo", onClick: () => {} }} onDismiss={() => {}} />
          <ToastView status={null} icon={Siren} title="Traffic dropped 30% on /pricing" description="Not an agent state: a neutral icon leads, never a status color." meta="Alerts · 2h ago" action={{ label: "Open", href: "#" }} onDismiss={() => {}} />
          <button
            type="button"
            className={aosButton({ variant: "primary", size: "sm", className: "mt-2 self-start" })}
            onClick={() =>
              feedback.toast({
                title: "Agent “Scout” deleted",
                status: "done",
                action: { label: "Undo", doneLabel: "Undone", onClick: () => {} },
              })
            }
          >
            Fire a real Undo toast
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 4. Sidebar and menus
// ---------------------------------------------------------------------------

function SidebarAndMenus() {
  const tree = useMemo(() => demoTree(), []);
  const common = {
    user: { name: "Jordan Lee", email: "jordan@northwind.co" },
    plan: "pro",
    workspaces: [
      { id: "p", name: "Personal workspace" },
      { id: "d", name: "Design studio" },
      { id: "s", name: "Side project" },
    ],
    currentWorkspaceId: "p",
    pathname: "/dashboard",
    needsYou: 3,
    tree: { lead: tree.lead, branches: tree.branches },
    usage: { used: 620, cap: 1000, pct: 62 },
  };
  return (
    <div className="flex flex-wrap items-start gap-6">
      <div className="aos-night h-[860px] w-72 overflow-hidden rounded-xl">
        <SidebarPanel {...common} />
      </div>
      <div className="flex items-start gap-3">
        <div className="aos-night h-[860px] w-20 overflow-hidden rounded-xl">
          <SidebarPanel {...common} collapsed />
        </div>
        <span className="relative mt-[196px] rounded-sm bg-ink px-3 py-1.5 text-sm font-semibold whitespace-nowrap text-paper">
          <span aria-hidden className="absolute top-1/2 -left-1 size-2.5 -translate-y-1/2 rotate-45 bg-ink" />
          3 approvals waiting
        </span>
      </div>
      <div className="flex min-w-[280px] flex-1 flex-col gap-5">
        <MenuSurface label="Switch workspace" className="max-w-[420px]">
          <MenuLabel>Switch workspace</MenuLabel>
          {[
            { n: "Personal", s: "4 agents", on: true },
            { n: "Design studio", s: "11 agents" },
            { n: "Side project", s: "2 agents" },
          ].map((w) => (
            <MenuRow
              key={w.n}
              className="min-h-14"
              leading={<AgentAvatar name={w.n} size="md" />}
              label={
                <span className="block">
                  <span className="block font-semibold">{w.n}</span>
                  <span className="block text-xs font-normal text-muted">{w.s}</span>
                </span>
              }
              trailing={w.on ? <span className="text-ink" aria-label="Current">✓</span> : null}
            />
          ))}
          <MenuSeparator />
          <MenuRow
            leading={
              <span className="flex size-8 items-center justify-center rounded-key bg-paper shadow-control">
                <Plus className="size-4" aria-hidden />
              </span>
            }
            label="Create workspace"
            className="font-semibold"
          />
        </MenuSurface>
        <MenuSurface label="Researcher actions" className="max-w-[340px]">
          <div className="flex items-center justify-between px-3 pt-2 pb-2.5">
            <span className="text-lg font-bold stretch-heading tracking-heading">Researcher</span>
            <StatusBadge status="running" size="sm" />
          </div>
          <MenuSeparator className="mt-0" />
          <MenuRow icon={Play} label="Run now" shortcut="⌘↵" />
          <MenuRow icon={Pause} label="Pause schedule" />
          <MenuRow icon={Wrench} label="Edit tools" />
          <MenuRow icon={Copy} label="Duplicate" shortcut="⌘D" />
          <MenuSeparator />
          <MenuRow icon={Trash2} label="Delete agent" destructive />
        </MenuSurface>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 5. Command and inputs
// ---------------------------------------------------------------------------

function PaletteMock() {
  const agentRow = (name: string, hint: string, status: AosStatus, active?: boolean) => (
    <MenuRow
      key={name}
      active={active}
      leading={<AgentAvatar name={name} size="sm" tone={active ? "paper" : "ink"} />}
      label={<span className="font-semibold">{name}</span>}
      hint={hint}
      trailing={
        <span className={cn("inline-flex shrink-0 items-center gap-1.5 text-sm font-semibold", active ? "text-paper" : "text-ink")}>
          <StatusShape status={status} size={9} tone={active ? "night" : "paper"} live={false} />
          {STATUS_META[status].label}
        </span>
      }
    />
  );
  const iconTile = (Icon: typeof Plus) => (
    <span className="flex size-6 items-center justify-center rounded-key bg-canvas">
      <Icon className="size-3.5" aria-hidden />
    </span>
  );
  return (
    <div className="overflow-hidden rounded-lg bg-paper shadow-overlay">
      <div className="flex h-14 items-center gap-3 border-b border-line px-5">
        <Search className="size-5 text-ink" aria-hidden />
        <span className="flex-1 text-lg text-subtle">Search or type a task…</span>
        <KeyCap>esc</KeyCap>
      </div>
      <div className="p-2">
        <MenuLabel>Agents</MenuLabel>
        {agentRow("Researcher", "Step 3 of 7 · reading sources", "running", true)}
        {agentRow("Writer", "14 emails waiting on you", "needs")}
        {agentRow("Analyst", "Q3 summary · 4 min ago", "done")}
        {agentRow("Operator", "Calendar access expired", "failed")}
        <MenuLabel>Actions</MenuLabel>
        <MenuRow leading={iconTile(Plus)} label={<span className="font-semibold">New task</span>} hint="Hand a goal to the lead agent" trailing={<span className="flex gap-1"><KeyCap>⌘</KeyCap><KeyCap>N</KeyCap></span>} />
        <MenuRow leading={iconTile(Clock)} label={<span className="font-semibold">Schedule a run</span>} hint="Repeat daily or weekly" trailing={<span className="flex gap-1"><KeyCap>⌘</KeyCap><KeyCap>J</KeyCap></span>} />
        <MenuRow leading={iconTile(Inbox)} label={<span className="font-semibold">Open approvals</span>} hint="3 approvals waiting" trailing={<span className="flex gap-1"><KeyCap>G</KeyCap><KeyCap>I</KeyCap></span>} />
        <MenuLabel>Tools</MenuLabel>
        <MenuRow leading={iconTile(Globe)} label={<span className="font-semibold">Web search</span>} hint="Built in" trailing={<span className="text-sm font-semibold text-muted">Connected</span>} />
        <MenuRow leading={iconTile(Mail)} label={<span className="font-semibold">Email</span>} hint="jordan@northwind.co" trailing={<span className="text-sm font-semibold text-muted">Connected</span>} />
        <MenuRow
          leading={iconTile(CalendarDays)}
          label={<span className="font-semibold">Calendar</span>}
          hint="Access expired Sep 30"
          trailing={
            <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-failed-text">
              <StatusShape status="failed" size={9} />
              Reconnect
            </span>
          }
        />
      </div>
      <div className="flex items-center gap-4 border-t border-line px-5 py-3 text-xs text-muted">
        <span className="flex items-center gap-1.5"><KeyCap>↑</KeyCap><KeyCap>↓</KeyCap> Move</span>
        <span className="flex items-center gap-1.5"><KeyCap>↵</KeyCap> Open</span>
        <span className="flex items-center gap-1.5"><KeyCap>esc</KeyCap> Clear</span>
        <span className="ml-auto">10 results</span>
      </div>
    </div>
  );
}

function Composer() {
  const [agent, setAgent] = useState<string>("researcher");
  const [prompt, setPrompt] = useState("Compare our Q3 numbers with the top three competitors and draft a one-page brief.");
  const [tools, setTools] = useState<Record<string, boolean>>({ web: true, email: false, code: true });
  const [files, setFiles] = useState([{ id: "f1", name: "q3-metrics.csv", size: "48 KB" }]);
  return (
    <TaskComposer
      agents={composerAgents()}
      agent={agent}
      onAgentChange={setAgent}
      hint="Usually takes 3–5 min"
      prompt={prompt}
      onPromptChange={setPrompt}
      error={prompt.trim() ? null : "Describe the task first."}
      files={files}
      onAddFiles={(list) => setFiles((f) => [...f, ...list.map((x, i) => ({ id: `${x.name}-${i}-${f.length}`, name: x.name, size: formatBytes(x.size) }))])}
      onRemoveFile={(id) => setFiles((f) => f.filter((x) => x.id !== id))}
      tools={COMPOSER_TOOLS.map((t) => ({ key: t.key, label: t.label, pressed: !!tools[t.key] }))}
      onToggleTool={(k) => setTools((s) => ({ ...s, [k]: !s[k] }))}
      onSend={() => feedback.toast({ title: "Composer demo", description: "In the app this hands the task to the picked agent." })}
    />
  );
}

function CommandAndInputs() {
  const [perms, setPerms] = useState<Record<string, Permission>>({ Email: "ask", "Web search": "auto", Files: "auto", Payments: "off" });
  const [sw, setSw] = useState({ bg: true, notify: true, share: false });
  const [limit, setLimit] = useState("0");
  const rows = [
    { name: "Email", hint: "Send and reply", icon: Mail },
    { name: "Web search", hint: "Search and read pages", icon: Globe },
    { name: "Files", hint: "Read and edit your files", icon: Folder },
    { name: "Payments", hint: "Spend from your card", icon: CreditCard },
  ];
  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
      <div className="flex flex-col gap-8">
        <div>
          <Label>Command palette</Label>
          <PaletteMock />
        </div>
        <div>
          <Label>Text fields</Label>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Schedule" defaultValue="Every weekday at 9:00" helper="Runs in your time zone." leading={<Clock className="size-4" aria-hidden />} />
            <Field
              label="Spending limit per run"
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              inputMode="decimal"
              leading={<span className="text-base">$</span>}
              trailing="USD"
              inputClassName="aos-mono"
              error={Number(limit) > 0 ? null : "Enter an amount above $0."}
            />
          </div>
        </div>
      </div>
      <div className="flex flex-col gap-8">
        <div>
          <Label>Composer</Label>
          <Composer />
        </div>
        <div>
          <Label>Tool permissions</Label>
          <div className="divide-y divide-line rounded-lg bg-paper shadow-hairline">
            {rows.map((r) => (
              <div key={r.name} className="flex items-center gap-3 px-4 py-3">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-sm bg-canvas">
                  <r.icon className="size-4" aria-hidden />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-md font-semibold text-ink">{r.name}</p>
                  <div className="truncate text-xs text-muted">{r.hint}</div>
                </div>
                <PermissionSegmented label={`${r.name} permission`} value={perms[r.name]!} onChange={(v) => setPerms((p) => ({ ...p, [r.name]: v }))} />
              </div>
            ))}
          </div>
          <p className="mt-4 mb-2 text-xs font-semibold text-muted">Variants: allow-list (no Off) and a locked choice</p>
          <div className="divide-y divide-line rounded-lg bg-paper shadow-hairline">
            <div className="flex flex-wrap items-center gap-3 px-4 py-3">
              <span className="aos-mono min-w-0 flex-1 truncate text-sm">search_docs</span>
              <PermissionSegmented label="search_docs permission" value={perms.search_docs ?? "auto"} options={["ask", "auto"]} onChange={(v) => setPerms((p) => ({ ...p, search_docs: v }))} />
            </div>
            <div className="flex flex-wrap items-center gap-3 px-4 py-3">
              <span className="min-w-0 flex-1 truncate text-md font-semibold">Move money</span>
              <PermissionSegmented
                label="Move money permission"
                value={perms.money ?? "off"}
                locked={{ auto: "Tier 3 actions can never run automatically." }}
                onChange={(v) => setPerms((p) => ({ ...p, money: v }))}
              />
            </div>
          </div>
        </div>
        <div>
          <Label>Run settings</Label>
          <div className="divide-y divide-line rounded-lg bg-paper shadow-hairline">
            <SwitchRow title="Run in the background" description="Keep working after you close the window" checked={sw.bg} onChange={(v) => setSw((s) => ({ ...s, bg: v }))} />
            <SwitchRow title="Notify me when done" description="Push notification and email" checked={sw.notify} onChange={(v) => setSw((s) => ({ ...s, notify: v }))} />
            <SwitchRow title="Share runs with workspace" description="Teammates can view, not edit" checked={sw.share} onChange={(v) => setSw((s) => ({ ...s, share: v }))} />
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

const PAGES = [
  { id: "foundations", title: "Foundations", note: "kit/foundations.png", el: <Foundations /> },
  { id: "agent-blocks", title: "Agent blocks", note: "kit/agent-blocks.png", el: <AgentBlocks /> },
  { id: "toasts-and-banners", title: "Toasts and banners", note: "kit/toasts-and-banners.png", el: <ToastsAndBanners /> },
  { id: "sidebar-and-menus", title: "Sidebar and menus", note: "kit/sidebar-and-menus.png", el: <SidebarAndMenus /> },
  { id: "command-and-inputs", title: "Command and inputs", note: "kit/command-and-inputs.png", el: <CommandAndInputs /> },
];

export function KitGallery() {
  return (
    <div className="flex flex-col gap-10">
      <nav aria-label="Kit pages" className="flex flex-wrap gap-2">
        {PAGES.map((p) => (
          <a key={p.id} href={`#${p.id}`} className="inline-flex h-chip items-center rounded-full bg-paper px-3.5 text-sm font-semibold text-ink shadow-control hover:shadow-outline">
            {p.title}
          </a>
        ))}
      </nav>
      {PAGES.map((p) => (
        <KitPage key={p.id} id={p.id} title={p.title} note={p.note}>
          {p.el}
        </KitPage>
      ))}
    </div>
  );
}

export default KitGallery;
