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
  Pin,
  Rocket,
  ShieldCheck,
  TrendingUp,
  TriangleAlert,
} from "lucide-react";
import { AgentCard, LeadAgentCard, LiveActivity, StatusShape } from "@/components/aos";
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
  NotesWidgetData,
} from "@/lib/desktop/loaders.server";
// Phase 18.2 (WS=content): the Notes widget's quick-note button (client).
import { QuickNoteButton } from "@/components/notes/QuickNoteButton";
import { BriefingBody } from "./BriefingBody";
// Phase 18.1 (integration): every view gets the person's translator + locale
// (app/dashboard/page.tsx → getI18n); English when rendered without one.
import { createTranslator, toolLabel, type Translator } from "@/lib/i18n";
import { DEFAULT_LOCALE, INTL_LOCALE, type Locale } from "@/lib/i18n/locales";

export interface ViewI18n {
  t: Translator;
  locale: Locale;
}

export const EN_VIEW_I18N: ViewI18n = { t: createTranslator("en"), locale: DEFAULT_LOCALE };

type ViewProps<D> = { data: D; i18n: ViewI18n };

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-1 px-1 py-1">
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

const tag = (locale: Locale) => INTL_LOCALE[locale] ?? INTL_LOCALE[DEFAULT_LOCALE];
const money = (cents: number, locale: Locale) =>
  new Intl.NumberFormat(tag(locale), { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(cents / 100);

function timeIn(iso: string, tz: string, locale: Locale): string {
  try {
    return new Intl.DateTimeFormat(tag(locale), { hour: "numeric", minute: "2-digit", timeZone: tz }).format(new Date(iso));
  } catch {
    return iso.slice(11, 16);
  }
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

function BriefingView({ data }: ViewProps<BriefingData>) {
  return <BriefingBody initial={data} />;
}

function NeedsYouView({ data, i18n: { t } }: ViewProps<NeedsYouData>) {
  if (data.items.length === 0) {
    return <Empty title={t("desk.views.needsYouEmptyTitle")}>{t("desk.views.needsYouEmptyBody")}</Empty>;
  }
  return (
    <div className="flex flex-col gap-1">
      <p className="px-2 pb-1 text-sm text-muted">
        {t("desk.views.waitingOnYou", { count: data.actionable })}
        {data.total > data.actionable ? t("desk.views.forSomeoneElse", { count: data.total - data.actionable }) : ""}
      </p>
      <ul className="flex flex-col">
        {data.items.map((i) => (
          <li key={i.key}>
            <RowLink href={i.href}>
              <StatusShape status="needs" size={11} label={t("status.needs")} className="aos-shape--edged shrink-0" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-base font-medium text-ink">{i.title}</span>
                <span className="block truncate text-sm text-muted">
                  {i.source} · {i.ago}
                  {i.canDecide ? "" : t("desk.views.viewOnly")}
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

function AgentsView({ data, i18n: { t } }: ViewProps<AgentsData>) {
  if (!data.tree) {
    return (
      <Empty title={t("desk.views.agentsEmptyTitle")} action={<NewTaskButton />}>
        {t("desk.views.agentsEmptyBody")}
      </Empty>
    );
  }
  return (
    <div className="grid h-full gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
      {/* Three branches fit the widget's default height in every language; the
          card says how many more, and "Open" shows the whole tree. */}
      <LeadAgentCard tree={data.tree} action={data.leadAction} className="shadow-none ring-1 ring-line" t={t} maxBranches={3} />
      <div className="flex min-w-0 flex-col gap-4">
        <LiveActivity counts={data.tree.counts} run={data.live?.run} chips={data.live?.chips} />
      </div>
    </div>
  );
}

function RunningView({ data, i18n: { t } }: ViewProps<RunningData>) {
  const live = data.nodes.filter((n) => n.status !== "done");
  if (data.nodes.length === 0 || live.length === 0) {
    return <Empty title={t("desk.views.runningEmptyTitle")}>{t("desk.views.runningEmptyBody")}</Empty>;
  }
  return (
    <ul className="flex flex-col" aria-label={t("desk.views.runningList")}>
      {data.nodes.map((n) => (
        <li key={n.key} className={n.depth > 0 ? "ml-4 border-l border-line pl-2" : undefined}>
          <RowLink href={n.href}>
            <span aria-hidden className="flex size-7 shrink-0 items-center justify-center rounded-key bg-ink text-xs font-extrabold text-paper">
              {n.name.trim()[0]?.toUpperCase() ?? "A"}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-base font-medium text-ink">
                {n.name}
                {n.isLead ? <span className="ml-1.5 text-sm font-normal text-muted">{t("desk.views.lead")}</span> : null}
              </span>
              <span className="block truncate text-sm text-muted">{n.line}</span>
            </span>
            <span className="flex shrink-0 items-center gap-1.5 text-sm font-semibold text-ink">
              <StatusShape status={n.status} size={10} label={t(`status.${n.status}`)} className={n.status === "needs" ? "aos-shape--edged" : undefined} />
              {t(`status.${n.status}`)}
            </span>
          </RowLink>
        </li>
      ))}
    </ul>
  );
}

function WorkView({ data, i18n: { t } }: ViewProps<{ cards: WorkCard[] }>) {
  if (data.cards.length === 0) {
    return (
      <Empty
        title={t("desk.views.workEmptyTitle")}
        action={
          <Link href="/dashboard/missions" className="text-sm font-semibold text-ink hover:underline">
            {t("desk.views.missionTemplates")}
          </Link>
        }
      >
        {t("desk.views.workEmptyBody")}
      </Empty>
    );
  }
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {data.cards.map((c) => (
        <AgentCard
          key={c.key}
          status={c.status}
          badgeLabel={t(`status.${c.status}`)}
          title={c.title}
          eyebrow={c.eyebrow}
          description={c.description}
          tools={c.tools}
          toolLabels={Object.fromEntries(c.tools.map((tool) => [tool, toolLabel(t, tool)]))}
          meta={c.meta}
          action={c.action}
        />
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

function AttentionView({ data, i18n: { t } }: ViewProps<AttentionData>) {
  if (data.rows.length === 0) {
    return <Empty title={t("desk.views.attentionEmptyTitle")}>{t("desk.views.attentionEmptyBody")}</Empty>;
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

function CalendarView({ data, i18n: { t, locale } }: ViewProps<CalendarData>) {
  const connected = data.connected.google || data.connected.outlook;
  return (
    <div className="flex flex-col gap-2">
      {data.items.length === 0 ? (
        <Empty
          title={t("desk.views.calendarEmptyTitle")}
          action={
            connected ? null : (
              <Link href="/dashboard/settings/connectors" className="text-sm font-semibold text-ink hover:underline">
                {t("desk.views.connectCalendars")}
              </Link>
            )
          }
        >
          {connected ? t("desk.views.noEventsToday") : t("desk.views.bookingsShowHere")}
        </Empty>
      ) : (
        <ul className="flex flex-col">
          {data.items.map((e) => (
            <li key={e.id}>
              <RowLink href={e.href ?? "/dashboard/calls"} external={!!e.href && e.href.startsWith("https://")}>
                <span className="aos-mono w-16 shrink-0 text-sm text-muted tabular-nums">{timeIn(e.start, data.timeZone, locale)}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-base font-medium text-ink">{e.title}</span>
                  <span className="block truncate text-sm text-muted">
                    {e.source === "booking" ? t("desk.views.sourceBooking") : e.source === "google" ? t("desk.views.sourceGoogle") : t("desk.views.sourceOutlook")}
                    {e.mock ? t("desk.views.sampleEvent") : ""}
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
          {t("desk.views.bookingsOnly")}{" "}
          <Link href="/dashboard/settings/connectors" className="font-semibold text-ink hover:underline">
            {t("desk.views.connectCalendar")}
          </Link>
        </p>
      ) : null}
    </div>
  );
}

function InboxView({ data, i18n: { t } }: ViewProps<InboxData>) {
  if (data.threads.length === 0) {
    return (
      <Empty
        title={t("desk.views.inboxEmptyTitle")}
        action={
          <Link href="/dashboard/crm/inbox" className="text-sm font-semibold text-ink hover:underline">
            {t("desk.views.openInbox")}
          </Link>
        }
      >
        {t("desk.views.inboxEmptyBody")}
      </Empty>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <p className="px-2 pb-1 text-sm text-muted">{t("desk.views.unreadConversations", { count: data.unreadThreads })}</p>
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

function PipelineView({ data, i18n: { t, locale } }: ViewProps<PipelineData>) {
  if (data.openCount === 0) {
    return (
      <Empty
        title={t("desk.views.pipelineEmptyTitle")}
        action={
          <Link href="/dashboard/crm" className="text-sm font-semibold text-ink hover:underline">
            {t("desk.views.openCrm")}
          </Link>
        }
      >
        {t("desk.views.pipelineEmptyBody")}
      </Empty>
    );
  }
  const max = Math.max(1, ...data.stages.map((s) => s.count));
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-2">
        <Stat label={t("desk.views.openLeads")} value={String(data.openCount)} href="/dashboard/crm" />
        <Stat label={t("desk.views.openValue")} value={money(data.openValueCents, locale)} href="/dashboard/crm" />
      </div>
      <ul className="flex flex-col gap-1.5" aria-label={t("desk.views.byStage")}>
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

function CashView({ data, i18n: { t, locale } }: ViewProps<CashData>) {
  return (
    <div className="grid grid-cols-2 gap-2">
      <Stat label={t("desk.views.payments30")} value={money(data.paymentsLast30dCents, locale)} href="/dashboard/ops/payments" />
      <Stat label={t("desk.views.openInvoices")} value={String(data.openInvoices)} href="/dashboard/ops/invoices" />
      <Stat label={t("desk.views.overdueInvoices")} value={String(data.overdueInvoices)} href="/dashboard/ops/invoices" />
      <Stat label={t("desk.views.waitingForApproval")} value={String(data.pendingApprovals)} href="/dashboard/approvals" />
    </div>
  );
}

function kpiValue(k: TwinData["kpis"][number], locale: Locale): string {
  if (k.value === null) return "—";
  if (k.unit === "pct") return `${Math.round(k.value)}%`;
  if (k.unit === "cents") return money(k.value, locale);
  return String(k.value);
}

function TwinView({ data, i18n: { t, locale } }: ViewProps<TwinData>) {
  if (!data.site) {
    return (
      <Empty
        title={t("desk.views.twinEmptyTitle")}
        action={
          <Link href="/dashboard/ops/twin" className="text-sm font-semibold text-ink hover:underline">
            {t("desk.views.setUpTwin")}
          </Link>
        }
      >
        {t("desk.views.twinEmptyBody")}
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
            <span className="mt-0.5 block text-xl font-bold tabular-nums stretch-heading text-ink">{kpiValue(k, locale)}</span>
            {k.hint ? <span className="block truncate text-xs text-muted">{k.hint}</span> : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function KeyNumbersView({ data, i18n: { t } }: ViewProps<KeyNumbersData>) {
  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-2 gap-2">
        {data.items.map((i) => (
          <Stat key={i.label} label={i.label} value={i.value} href={i.href} />
        ))}
      </div>
      {data.lastAutomation ? (
        <p className="px-1 text-xs text-muted">
          {t("home.lastAutomation", { name: data.lastAutomation.name, ago: data.lastAutomation.ago })}
        </p>
      ) : null}
    </div>
  );
}

function ProjectsView({ data, i18n: { t } }: ViewProps<ProjectsData>) {
  return (
    <div className="flex flex-col gap-3">
      {data.projects.length === 0 ? (
        <Empty title={t("desk.views.projectsEmptyTitle")}>{t("desk.views.projectsEmptyBody")}</Empty>
      ) : (
        <ul className="flex flex-col">
          {data.projects.map((p) => (
            <li key={p.id} className="border-b border-line last:border-b-0">
              <RowLink href={`/dashboard/projects/${p.id}`}>
                <Globe aria-hidden className="size-4 shrink-0 text-muted" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-base font-medium text-ink">{p.domain}</span>
                  <span className="block truncate text-sm text-muted">
                    {t("desk.views.projectMeta", { keywords: p.keywords, content: p.content, workflows: p.workflows, locale: p.locale })}
                  </span>
                </span>
                {p.score !== null ? (
                  <span className="flex size-11 shrink-0 flex-col items-center justify-center rounded-md bg-canvas" title={t("desk.views.visibilityScore", { score: p.score })}>
                    <span className="text-base font-semibold tabular-nums text-ink">{p.score}</span>
                    <span className="text-2xs leading-none text-subtle">{t("desk.views.score")}</span>
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

function SuggestionsView({ data, i18n: { t } }: ViewProps<SuggestionsData>) {
  if (data.items.length === 0) {
    return <Empty title={t("desk.views.suggestionsEmptyTitle")}>{t("desk.views.suggestionsEmptyBody")}</Empty>;
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
// Phase 18.2 (WS=content): Notes
// ---------------------------------------------------------------------------

function NotesView({ data, i18n: { t } }: ViewProps<NotesWidgetData>) {
  const quick = <QuickNoteButton label={t("notes.widget.quickNote")} />;
  if (data.notes.length === 0) {
    return (
      <Empty title={t("notes.widget.emptyTitle")} action={quick}>
        {t("notes.widget.emptyBody")}
      </Empty>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <ul className="flex flex-col">
        {data.notes.map((n) => (
          <li key={n.id}>
            <RowLink href={`/dashboard/notes?note=${encodeURIComponent(n.id)}`}>
              {n.pinned ? <Pin aria-hidden className="size-4 shrink-0 text-muted" /> : <FileText aria-hidden className="size-4 shrink-0 text-muted" />}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-base font-medium text-ink">{n.title}</span>
                <span className="block truncate text-sm text-muted">
                  {n.ago}
                  {n.preview ? ` · ${n.preview}` : ""}
                </span>
              </span>
            </RowLink>
          </li>
        ))}
      </ul>
      <div className="px-2 pt-1">{quick}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------

/** Every widget's view, keyed by id (the registry test checks completeness). */
export const WIDGET_VIEWS: { [K in WidgetId]: (props: ViewProps<WidgetDataMap[K]>) => ReactNode } = {
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
  notes: NotesView,
};

/** Render one widget's loaded data (or its "couldn't load" line, already translated by the loader). */
export function renderWidget<K extends WidgetId>(
  id: K,
  result: { ok: true; data: WidgetDataMap[K] } | { ok: false; error: string } | undefined,
  i18n: ViewI18n = EN_VIEW_I18N,
): ReactNode {
  if (!result) return null;
  if (!result.ok) {
    return (
      <p className="flex items-start gap-2 px-1 text-sm text-failed-text">
        <span aria-hidden className="mt-1.5 size-2 shrink-0 bg-failed" />
        {result.error}
      </p>
    );
  }
  const View = WIDGET_VIEWS[id] as (props: ViewProps<WidgetDataMap[K]>) => ReactNode;
  return <View data={result.data} i18n={i18n} />;
}
