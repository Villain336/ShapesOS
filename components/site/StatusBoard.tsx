// ShapesOS — the public status board (beta readiness, WS=legal): overall
// line, the four components as a dense table, open and past incidents.
// Component health is NOT an agent state, so it never takes the Agentic OS
// status colours or shapes (docs/design/DESIGN.md): neutral text pills with
// a Lucide icon, like the twin's entity states. Server component.

import type { ReactNode } from "react";
import { AlertTriangle, Check, CircleHelp, Wrench, XOctagon, type LucideIcon } from "lucide-react";
import { getI18n } from "@/lib/i18n/server";
import type { StatusSnapshot } from "@/lib/status/public";
import type { ComponentState } from "@/lib/status/derive";
import type { PublicIncident } from "@/lib/status/store";

const ICON: Record<ComponentState, LucideIcon> = {
  operational: Check,
  degraded: AlertTriangle,
  partial_outage: AlertTriangle,
  major_outage: XOctagon,
  maintenance: Wrench,
  unknown: CircleHelp,
};

function StatePill({ state, label, strong }: { state: ComponentState; label: string; strong?: boolean }) {
  const Icon = ICON[state];
  return (
    <span
      data-state={state}
      className={`inline-flex h-7 items-center gap-1.5 rounded-full bg-paper px-3 text-sm font-semibold text-ink shadow-control ${strong ? "h-control-sm px-4 text-base" : ""}`}
    >
      <Icon className="size-3.5 shrink-0" aria-hidden />
      {label}
    </span>
  );
}

export async function StatusBoard({ snapshot }: { snapshot: StatusSnapshot }) {
  const { t, format } = await getI18n();
  const stateLabel = (s: ComponentState) => t(`legal.status.state.${s}`);
  const incident = (i: PublicIncident): ReactNode => (
    <li key={i.id} className="rounded-lg bg-paper p-5 shadow-hairline" data-incident={i.id}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-base font-semibold text-ink">{i.title}</h3>
        <span className="inline-flex h-7 items-center rounded-full bg-hover-paper px-3 text-xs font-semibold text-muted">{t(`legal.status.incidentStatus.${i.status}`)}</span>
        <span className="inline-flex h-7 items-center rounded-full bg-hover-paper px-3 text-xs font-semibold text-muted">{t(`legal.status.impact.${i.impact}`)}</span>
      </div>
      <p className="mt-1 text-xs text-muted">
        {t("legal.status.started", { date: format.date(i.startedAt, "dateTime") })}
        {i.resolvedAt ? ` · ${t("legal.status.resolvedAt", { date: format.date(i.resolvedAt, "dateTime") })}` : ""}
        {i.componentKeys.length ? ` · ${t("legal.status.affected")}: ${i.componentKeys.map((k) => snapshot.components.find((c) => c.key === k)?.name ?? k).join(", ")}` : ""}
      </p>
      <ol className="mt-3 flex flex-col gap-2 border-l border-line pl-4">
        {[...i.updates].reverse().map((u, idx) => (
          <li key={`${u.at}-${idx}`} className="text-sm text-ink">
            <span className="font-semibold">{t(`legal.status.incidentStatus.${u.status}`)}</span>
            <span className="text-muted"> · {format.date(u.at, "dateTime")}</span>
            <p className="mt-0.5 text-muted">{u.message}</p>
          </li>
        ))}
      </ol>
    </li>
  );
  return (
    <div className="flex flex-col gap-8">
      <section aria-label={t("legal.status.components")} className="rounded-lg bg-paper p-5 shadow-hairline">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <StatePill state={snapshot.overall} label={t(`legal.status.overall.${snapshot.overall}`)} strong />
          <span className="text-xs text-muted">{t("legal.status.checked", { date: format.date(snapshot.generatedAt, "dateTime") })}</span>
        </div>
        <table className="mt-4 w-full text-left text-sm">
          <thead>
            <tr className="border-b border-line text-xs font-semibold text-muted">
              <th scope="col" className="py-2 pr-3 font-semibold">{t("legal.status.component")}</th>
              <th scope="col" className="py-2 pr-3 font-semibold">{t("legal.status.stateColumn")}</th>
              <th scope="col" className="py-2 font-semibold">{t("legal.status.detail")}</th>
            </tr>
          </thead>
          <tbody>
            {snapshot.components.map((c) => (
              <tr key={c.key} className="border-b border-line last:border-0" data-component={c.key}>
                <th scope="row" className="py-3 pr-3 align-top font-medium text-ink">
                  {c.name}
                  <span className="mt-0.5 block text-xs font-normal text-muted">{c.description}</span>
                </th>
                <td className="py-3 pr-3 align-top">
                  <StatePill state={c.state} label={stateLabel(c.state)} />
                </td>
                <td className="py-3 align-top text-muted">
                  {c.note ?? "—"}
                  {c.manual ? <span className="mt-0.5 block text-xs text-muted">{t("legal.status.manual")}</span> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-4 text-xs text-muted">
          {t("legal.status.derived", { seconds: snapshot.cacheSeconds })}{" "}
          <a href="/api/status" className="underline underline-offset-2 hover:text-ink">
            {t("legal.status.json")}
          </a>
        </p>
      </section>

      <section aria-labelledby="open-incidents">
        <h2 id="open-incidents" className="aos-subheading text-ink">
          {t("legal.status.openIncidents")}
        </h2>
        {snapshot.incidents.open.length ? <ul className="mt-3 flex flex-col gap-3">{snapshot.incidents.open.map(incident)}</ul> : <p className="mt-2 text-sm text-muted">{t("legal.status.noOpen")}</p>}
      </section>

      <section aria-labelledby="past-incidents">
        <h2 id="past-incidents" className="aos-subheading text-ink">
          {t("legal.status.pastIncidents")}
        </h2>
        {snapshot.incidents.recent.length ? <ul className="mt-3 flex flex-col gap-3">{snapshot.incidents.recent.map(incident)}</ul> : <p className="mt-2 text-sm text-muted">{t("legal.status.noPast")}</p>}
      </section>
    </div>
  );
}
