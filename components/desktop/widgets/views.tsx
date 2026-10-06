// ShapesOS — Phase 18.1 (WS=desk): what each desktop widget shows.
//
// Server components, one per widget id (lib/desktop/widgets.ts), fed by the
// loaders in lib/desktop/loaders.server.ts and rendered by app/dashboard/
// page.tsx into the client grid (components/desktop/Desktop.tsx) as
// children. They reuse the Agentic OS kit (LeadAgentCard, LiveActivity,
// AgentCard, StatusShape) — the same cards the Overview had. Status colour
// and shape appear only for agent states; everything else is ink on paper.

import Link from "next/link";
import type { ReactNode } from "react";
import {
  Bell,
  ChevronRight,
  Crosshair,
  FileText,
  Globe,
  Kanban,
  Key,
  MessagesSquare,
  Rocket,
  ShieldCheck,
  TrendingUp,
  TriangleAlert,
} from "lucide-react";
import { AgentCard, LeadAgentCard, LiveActivity, StatusShape } from "@/components/aos";
import { STATUS_META } from "@/lib/aos/status";
import ProjectCreateForm from "@/components/ProjectCreateForm";
import { NewTaskButton } from "@/components/command-bar/NewTaskButton";
import type { WidgetId } from "@/lib/desktop/widgets";
import type {
  AgentsData,
  AttentionData,
  AttentionIcon,
  BriefingData,
  CalendarData,
  CashData,
  InboxData,
  KeyNumbersData,
  NeedsYouData,
  PipelineData,
  ProjectsData,
  RunningData,
  SuggestionIcon,
  SuggestionsData,
  TwinData,
  WidgetDataMap,
  WorkCard,
} from "@/lib/desktop/loaders.server";
import { BriefingBody } from "./BriefingBody";

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex h-full min-h-24 flex-col items-start justify-center gap-1 px-1 py-2">
      <p className="text-base font-semibold text-ink">{title}</p>
      {children ? <p className="max-w-[46ch] text-sm text-muted">{children}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

function RowLink({ href, children, external }: { href: string; children: ReactNode; external?: boolean }) {
  const cls = "group flex min-h-11 items-center gap-3 rounded-sm px-2 py-1.5 transition-[background-color] duration-150 hover:bg-hover-paper";
  return external ? (
    <a href={href} target="_blank" rel="noreferrer noopener" className={cls}>
      {children}
    </a>
  ) : (
    <Link href={href} className={cls}>
      {children}
    </Link>
  );
}

function Chevron() {
  return <ChevronRight aria-hidden className="size-4 shrink-0 text-subtle transition-transform duration-150 group-hover:translate-x-0.5" />;
}

function Stat({ label, value, href }: { label: string; value: string; href?: string }) {
  const inner = (
    <>
      <span className="block text-xs font-semibold text-muted">{label}</span>
      <span className="mt-0.5 block text-xl font-bold tabular-nums stretch-heading text-ink">{value}</span>
    </>
  );
  return href ? (
    <Link href={href} className="block rounded-md bg-canvas px-3 py-2.5 transition-[background-color] duration-150 hover:bg-hover">
      {inner}
    </Link>
  ) : (
    <div className="rounded-md bg-canvas px-3 py-2.5">{inner}</div>
  );
}

const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(cents / 100);

function timeIn(iso: string, tz: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz }).format(new Date(iso));
  } catch {
    return iso.slice(11, 16);
  }
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

function BriefingView({ data }: { data: BriefingData }) {
  return <BriefingBody initial={data} />;
}

function NeedsYouView({ data }: { data: NeedsYouData }) {
  if (data.items.length === 0) {
    return <Empty title="Nothing needs you">Approvals and questions from your agents land here first.</Empty>;
  }
  return (
    <div className="flex flex-col gap-1">
      <p className="px-2 pb-1 text-sm text-muted">
        {data.actionable} waiting on you{data.total > data.actionable ? ` · ${data.total - data.actionable} for someone else` : ""}
      </p>
      <ul className="flex flex-col">
        {data.items.map((i) => (
          <li key={i.key}>
            <RowLink href={i.href}>
              <StatusShape status="needs" size={11} label={STATUS_META.needs.label} className="aos-shape--edged shrink-0" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-base font-medium text-ink">{i.title}</span>
                <span className="block truncate text-sm text-muted">
                  {i.source} · {i.ago}
                  {i.canDecide ? "" : " · view only"}
                </span>
              </span>
              <Chevron />
            </RowLink>
          </li>
        ))}
      </ul>
    </div>
  );
}

function AgentsView({ data }: { data: AgentsData }) {
  if (!data.tree) {
    return (
      <Empty title="Hand your first goal to an agent" action={<NewTaskButton />}>
        Describe what you want done. The lead agent plans it, hands each step to a sub-agent, and asks you before anything goes out.
      </Empty>
    );
  }
  return (
    <div className="grid h-full gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
      <LeadAgentCard tree={data.tree} action={data.leadAction} className="shadow-none ring-1 ring-line" />
      <div className="flex min-w-0 flex-col gap-4">
        <LiveActivity counts={data.tree.counts} run={data.live?.run} chips={data.live?.chips} />
      </div>
    </div>
  );
}

function RunningView({ data }: { data: RunningData }) {
  const live = data.nodes.filter((n) => n.status !== "done");
  if (data.nodes.length === 0 || live.length === 0) {
    return <Empty title="Nothing running">Start a new task and it shows up here.</Empty>;
  }
  return (
    <ul className="flex flex-col" aria-label="Running now: the lead agent, then its sub-agents">
      {data.nodes.map((n) => (
        <li key={n.key} className={n.depth > 0 ? "ml-4 border-l border-line pl-2" : undefined}>
          <RowLink href={n.href}>
            <span aria-hidden className="flex size-7 shrink-0 items-center justify-center rounded-key bg-ink text-xs font-extrabold text-paper">
              {n.name.trim()[0]?.toUpperCase() ?? "A"}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-base font-medium text-ink">
                {n.name}
                {n.isLead ? <span className="ml-1.5 text-sm font-normal text-muted">lead</span> : null}
              </span>
              <span className="block truncate text-sm text-muted">{n.line}</span>
            </span>
            <span className="flex shrink-0 items-center gap-1.5 text-sm font-semibold text-ink">
              <StatusShape status={n.status} size={10} label={STATUS_META[n.status].label} className={n.status === "needs" ? "aos-shape--edged" : undefined} />
              {STATUS_META[n.status].label}
            </span>
          </RowLink>
        </li>
      ))}
    </ul>
  );
}

function WorkView({ data }: { data: { cards: WorkCard[] } }) {
  if (data.cards.length === 0) {
    return (
      <Empty title="No missions or schedules yet" action={<Link href="/dashboard/missions" className="text-sm font-semibold text-ink hover:underline">Mission templates</Link>}>
        Missions and scheduled runs show up here, the most urgent first.
      </Empty>
    );
  }
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {data.cards.map((c) => (
        <AgentCard key={c.key} status={c.status} title={c.title} eyebrow={c.eyebrow} description={c.description} tools={c.tools} meta={c.meta} action={c.action} />
      ))}
    </div>
  );
}

const ATTENTION_ICONS: Record<AttentionIcon, ReactNode> = {
  drafts: <ShieldCheck className="size-5" aria-hidden />,
  decay: <TrendingUp className="size-5" aria-hidden />,
  radar: <Crosshair className="size-5" aria-hidden />,
  alert: <Bell className="size-5" aria-hidden />,
};

function AttentionView({ data }: { data: AttentionData }) {
  if (data.rows.length === 0) {
    return <Empty title="All quiet">Nothing needs you right now. New drafts, decay alerts and competitor moves show up here.</Empty>;
  }
  return (
    <ul className="flex flex-col">
      {data.rows.map((r) => (
        <li key={r.key}>
          <RowLink href={r.href}>
            <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-canvas text-muted">{ATTENTION_ICONS[r.icon]}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-base font-medium text-ink">{r.title}</span>
              <span className="block truncate text-sm text-muted">{r.meta}</span>
            </span>
            <span className="shrink-0 text-sm font-semibold text-ink">{r.cta}</span>
            <Chevron />
          </RowLink>
        </li>
      ))}
    </ul>
  );
}

function CalendarView({ data }: { data: CalendarData }) {
  const connected = data.connected.google || data.connected.outlook;
  return (
    <div className="flex flex-col gap-2">
      {data.items.length === 0 ? (
        <Empty
          title="Nothing on the calendar today"
          action={
            connected ? null : (
              <Link href="/dashboard/settings/connectors" className="text-sm font-semibold text-ink hover:underline">
                Connect Google or Outlook Calendar
              </Link>
            )
          }
        >
          {connected ? "No bookings or events today." : "Bookings show here. Connect a calendar to see your meetings too."}
        </Empty>
      ) : (
        <ul className="flex flex-col">
          {data.items.map((e) => (
            <li key={e.id}>
              <RowLink href={e.href ?? "/dashboard/calls"} external={!!e.href && e.href.startsWith("https://")}>
                <span className="aos-mono w-16 shrink-0 text-sm text-muted tabular-nums">{timeIn(e.start, data.timeZone)}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-base font-medium text-ink">{e.title}</span>
                  <span className="block truncate text-sm text-muted">
                    {e.source === "booking" ? "Booking" : e.source === "google" ? "Google Calendar" : "Outlook Calendar"}
                    {e.mock ? " · sample event (calendar not live)" : ""}
                  </span>
                </span>
              </RowLink>
            </li>
          ))}
        </ul>
      )}
      {data.errors.map((err) => (
        <p key={err} className="flex items-start gap-2 px-2 text-sm text-failed-text">
          <span aria-hidden className="mt-1.5 size-2 shrink-0 bg-failed" />
          {err}
        </p>
      ))}
      {!connected && data.items.length > 0 ? (
        <p className="px-2 text-sm text-muted">
          Bookings only.{" "}
          <Link href="/dashboard/settings/connectors" className="font-semibold text-ink hover:underline">
            Connect a calendar
          </Link>
        </p>
      ) : null}
    </div>
  );
}

function InboxView({ data }: { data: InboxData }) {
  if (data.threads.length === 0) {
    return (
      <Empty title="Inbox zero" action={<Link href="/dashboard/crm/inbox" className="text-sm font-semibold text-ink hover:underline">Open the inbox</Link>}>
        No unread texts or emails from leads.
      </Empty>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <p className="px-2 pb-1 text-sm text-muted">
        {data.unreadThreads} unread conversation{data.unreadThreads === 1 ? "" : "s"}
      </p>
      <ul className="flex flex-col">
        {data.threads.map((t) => (
          <li key={t.leadId}>
            <RowLink href={`/dashboard/crm/inbox?lead=${encodeURIComponent(t.leadId)}`}>
              <MessagesSquare aria-hidden className="size-4 shrink-0 text-muted" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-base font-medium text-ink">{t.name}</span>
                <span className="block truncate text-sm text-muted">
                  {t.channel} · {t.ago} · {t.snippet}
                </span>
              </span>
              <span className="inline-flex h-6 min-w-6 shrink-0 items-center justify-center rounded-full bg-ink px-2 text-xs font-semibold tabular-nums text-paper">{t.unread}</span>
            </RowLink>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PipelineView({ data }: { data: PipelineData }) {
  if (data.openCount === 0) {
    return (
      <Empty title="No open leads" action={<Link href="/dashboard/crm" className="text-sm font-semibold text-ink hover:underline">Open the CRM</Link>}>
        Leads you add or capture show here by stage.
      </Empty>
    );
  }
  const max = Math.max(1, ...data.stages.map((s) => s.count));
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-2">
        <Stat label="Open leads" value={String(data.openCount)} href="/dashboard/crm" />
        <Stat label="Open value" value={money(data.openValueCents)} href="/dashboard/crm" />
      </div>
      <ul className="flex flex-col gap-1.5" aria-label="Open leads by stage">
        {data.stages.map((s) => (
          <li key={s.id} className="flex items-center gap-3 text-sm">
            <span className="w-24 shrink-0 truncate text-muted">{s.label}</span>
            <span aria-hidden className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-canvas">
              <span className="block h-full rounded-full bg-ink" style={{ width: `${Math.round((s.count / max) * 100)}%` }} />
            </span>
            <span className="w-10 shrink-0 text-right font-semibold tabular-nums text-ink">{s.count}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function CashView({ data }: { data: CashData }) {
  return (
    <div className="grid grid-cols-2 gap-2">
      <Stat label="Payments, last 30 days" value={money(data.paymentsLast30dCents)} href="/dashboard/ops/payments" />
      <Stat label="Open invoices" value={String(data.openInvoices)} href="/dashboard/ops/invoices" />
      <Stat label="Overdue invoices" value={String(data.overdueInvoices)} href="/dashboard/ops/invoices" />
      <Stat label="Waiting for approval" value={String(data.pendingApprovals)} href="/dashboard/approvals" />
    </div>
  );
}

function kpiValue(k: TwinData["kpis"][number]): string {
  if (k.value === null) return "—";
  if (k.unit === "pct") return `${Math.round(k.value)}%`;
  if (k.unit === "cents") return money(k.value);
  return String(k.value);
}

function TwinView({ data }: { data: TwinData }) {
  if (!data.site) {
    return (
      <Empty title="No twin yet" action={<Link href="/dashboard/ops/twin" className="text-sm font-semibold text-ink hover:underline">Set up a twin</Link>}>
        A live 3D twin of your warehouse, factory or store shows its numbers here.
      </Empty>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <p className="px-1 text-sm text-muted">
        <Link href={`/dashboard/ops/twin/${data.site.id}`} className="font-semibold text-ink hover:underline">
          {data.site.name}
        </Link>
      </p>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
        {data.kpis.map((k) => (
          <div key={k.key} className="rounded-md bg-canvas px-3 py-2.5">
            <span className="block truncate text-xs font-semibold text-muted">{k.label}</span>
            <span className="mt-0.5 block text-xl font-bold tabular-nums stretch-heading text-ink">{kpiValue(k)}</span>
            {k.hint ? <span className="block truncate text-xs text-muted">{k.hint}</span> : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function KeyNumbersView({ data }: { data: KeyNumbersData }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-2 gap-2">
        {data.items.map((i) => (
          <Stat key={i.label} label={i.label} value={i.value} href={i.href} />
        ))}
      </div>
      {data.lastAutomation ? (
        <p className="px-1 text-xs text-muted">
          Last automation “{data.lastAutomation.name}” ran {data.lastAutomation.ago}
        </p>
      ) : null}
    </div>
  );
}

function ProjectsView({ data }: { data: ProjectsData }) {
  return (
    <div className="flex flex-col gap-3">
      {data.projects.length === 0 ? (
        <Empty title="No projects yet">Add a domain to start keyword research, track rankings and generate content.</Empty>
      ) : (
        <ul className="flex flex-col">
          {data.projects.map((p) => (
            <li key={p.id} className="border-b border-line last:border-b-0">
              <RowLink href={`/dashboard/projects/${p.id}`}>
                <Globe aria-hidden className="size-4 shrink-0 text-muted" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-base font-medium text-ink">{p.domain}</span>
                  <span className="block truncate text-sm text-muted">
                    {p.keywords} keyword{p.keywords === 1 ? "" : "s"} · {p.content} content · {p.workflows} automation{p.workflows === 1 ? "" : "s"} · {p.locale}
                  </span>
                </span>
                {p.score !== null ? (
                  <span className="flex size-11 shrink-0 flex-col items-center justify-center rounded-md bg-canvas" title={`Visibility score ${p.score}/100`}>
                    <span className="text-base font-semibold tabular-nums text-ink">{p.score}</span>
                    <span className="text-2xs leading-none text-subtle">score</span>
                  </span>
                ) : null}
                <Chevron />
              </RowLink>
            </li>
          ))}
        </ul>
      )}
      <div id="new-project">
        <ProjectCreateForm />
      </div>
    </div>
  );
}

const SUGGESTION_ICONS: Record<SuggestionIcon, ReactNode> = {
  project: <Kanban className="size-4" aria-hidden />,
  keywords: <Key className="size-4" aria-hidden />,
  content: <FileText className="size-4" aria-hidden />,
  autopilot: <Rocket className="size-4" aria-hidden />,
  data: <TriangleAlert className="size-4" aria-hidden />,
};

function SuggestionsView({ data }: { data: SuggestionsData }) {
  if (data.items.length === 0) {
    return <Empty title="You're on top of everything">Check back after the next scheduled run.</Empty>;
  }
  return (
    <ul className="flex flex-col gap-1">
      {data.items.map((s) => (
        <li key={s.text}>
          <Link href={s.href} className="group flex items-start gap-2.5 rounded-sm px-2 py-2 transition-[background-color] duration-150 hover:bg-hover-paper">
            <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-canvas text-muted">{SUGGESTION_ICONS[s.icon]}</span>
            <span className="min-w-0">
              <span className="block text-sm leading-snug text-muted">{s.text}</span>
              <span className="mt-0.5 inline-block text-sm font-semibold text-ink">{s.cta}</span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------

/** Every widget's view, keyed by id (the registry test checks completeness). */
export const WIDGET_VIEWS: { [K in WidgetId]: (props: { data: WidgetDataMap[K] }) => ReactNode } = {
  briefing: BriefingView,
  "needs-you": NeedsYouView,
  agents: AgentsView,
  running: RunningView,
  work: WorkView,
  attention: AttentionView,
  calendar: CalendarView,
  inbox: InboxView,
  pipeline: PipelineView,
  cash: CashView,
  twin: TwinView,
  "key-numbers": KeyNumbersView,
  projects: ProjectsView,
  suggestions: SuggestionsView,
};

/** Render one widget's loaded data (or its "couldn't load" line). */
export function renderWidget<K extends WidgetId>(id: K, result: { ok: true; data: WidgetDataMap[K] } | { ok: false; error: string } | undefined): ReactNode {
  if (!result) return null;
  if (!result.ok) {
    return (
      <p className="flex items-start gap-2 px-1 text-sm text-failed-text">
        <span aria-hidden className="mt-1.5 size-2 shrink-0 bg-failed" />
        {result.error} Reload to try again.
      </p>
    );
  }
  const View = WIDGET_VIEWS[id] as (props: { data: WidgetDataMap[K] }) => ReactNode;
  return <View data={result.data} />;
}
