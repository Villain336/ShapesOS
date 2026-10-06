"use client";

// ShapesOS — Phase 18.3 (WS=trust): the audit timeline (Settings → Privacy
// and security → Security center). Filters (who, source, dates), cursor
// paging ("Load more"), CSV export, and the tamper-evident trails' chain
// check. Reads GET /api/trust/timeline (admin+); nothing here writes.

import { useId, useState } from "react";
import Link from "next/link";
import { Download, ExternalLink, ShieldAlert, ShieldCheck, ShieldQuestion } from "lucide-react";
import { aosButton } from "@/components/aos/button";
import { useI18n } from "@/components/i18n/I18nProvider";
import type { MessageKey } from "@/lib/i18n";
import { HASH_CHAINED_SOURCES, TIMELINE_SOURCES, type TimelineEntry } from "@/lib/audit-timeline/normalize";
import { ActorCell } from "./ActorCell";
import { cardCls, fieldCls, labelCls, rowCls, tableCls, tableWrapCls, tdCls, thCls } from "./kit";

interface ChainResult {
  source: string;
  ok: boolean | null;
  checked: number;
  brokenAt?: string;
}

export function AuditTimeline({ initial, initialNext }: { initial: TimelineEntry[]; initialNext: string | null }) {
  const { t, format } = useI18n();
  const id = useId();
  const [entries, setEntries] = useState(initial);
  const [next, setNext] = useState(initialNext);
  const [actor, setActor] = useState("");
  const [source, setSource] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chains, setChains] = useState<ChainResult[] | null>(null);
  const [verifying, setVerifying] = useState(false);

  const query = (cursor?: string | null) => {
    const q = new URLSearchParams();
    if (actor) q.set("actor", actor);
    if (source) q.set("source", source);
    if (from) q.set("from", from);
    if (to) q.set("to", to);
    if (cursor) q.set("cursor", cursor);
    return q;
  };

  async function load(cursor: string | null) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/trust/timeline?${query(cursor).toString()}`, { cache: "no-store" });
      const body = (await res.json().catch(() => ({}))) as { entries?: TimelineEntry[]; next?: string | null; error?: string };
      if (!res.ok || !body.entries) throw new Error(body.error ?? `HTTP ${res.status}`);
      setEntries((prev) => (cursor ? [...prev, ...body.entries!] : body.entries!));
      setNext(body.next ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("trust.center.loadError"));
    } finally {
      setLoading(false);
    }
  }

  async function verify() {
    setVerifying(true);
    try {
      const res = await fetch("/api/trust/timeline/chains", { cache: "no-store" });
      const body = (await res.json().catch(() => ({}))) as { chains?: ChainResult[] };
      setChains(body.chains ?? []);
    } finally {
      setVerifying(false);
    }
  }

  const sourceLabel = (s: string) => t(`trust.center.sources.${s}` as MessageKey);

  return (
    <div className="flex flex-col gap-4">
      <form
        aria-label={t("trust.center.filters.label")}
        className={`${cardCls} grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-[repeat(4,minmax(0,1fr))_auto] lg:items-end`}
        onSubmit={(e) => {
          e.preventDefault();
          void load(null);
        }}
      >
        <label className={labelCls} htmlFor={`${id}-actor`}>
          {t("trust.center.filters.actor")}
          <select id={`${id}-actor`} value={actor} onChange={(e) => setActor(e.target.value)} className={fieldCls}>
            <option value="">{t("trust.center.filters.actors.all")}</option>
            <option value="person">{t("trust.center.filters.actors.person")}</option>
            <option value="agent">{t("trust.center.filters.actors.agent")}</option>
            <option value="system">{t("trust.center.filters.actors.system")}</option>
          </select>
        </label>
        <label className={labelCls} htmlFor={`${id}-source`}>
          {t("trust.center.filters.source")}
          <select id={`${id}-source`} value={source} onChange={(e) => setSource(e.target.value)} className={fieldCls}>
            <option value="">{t("trust.center.filters.allSources")}</option>
            {TIMELINE_SOURCES.map((s) => (
              <option key={s} value={s}>
                {sourceLabel(s)}
              </option>
            ))}
          </select>
        </label>
        <label className={labelCls} htmlFor={`${id}-from`}>
          {t("trust.center.filters.from")}
          <input id={`${id}-from`} type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={fieldCls} />
        </label>
        <label className={labelCls} htmlFor={`${id}-to`}>
          {t("trust.center.filters.to")}
          <input id={`${id}-to`} type="date" value={to} onChange={(e) => setTo(e.target.value)} className={fieldCls} />
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <button type="submit" disabled={loading} className={aosButton({ variant: "primary" })}>
            {t("trust.center.filters.apply")}
          </button>
          <a href={`/api/trust/timeline?${query().toString()}&format=csv`} download className={aosButton({ variant: "secondary" })}>
            <Download size={16} aria-hidden />
            {t("trust.center.exportCsv")}
          </a>
        </div>
      </form>

      {error ? (
        <p role="alert" className="flex items-center gap-2 text-sm text-failed-text">
          <span aria-hidden className="size-2 shrink-0 bg-failed" />
          {error}
        </p>
      ) : null}

      <div className={tableWrapCls}>
        <table className={tableCls} data-testid="audit-timeline">
          <caption className="sr-only">{t("trust.center.title")}</caption>
          <thead>
            <tr className="border-b border-line">
              <th scope="col" className={thCls}>{t("trust.center.columns.when")}</th>
              <th scope="col" className={thCls}>{t("trust.center.columns.who")}</th>
              <th scope="col" className={thCls}>{t("trust.center.columns.action")}</th>
              <th scope="col" className={thCls}>{t("trust.center.columns.target")}</th>
              <th scope="col" className={thCls}>{t("trust.center.columns.source")}</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.key} className={rowCls} data-source={e.source} data-actor-kind={e.actor.kind}>
                <td className={`${tdCls} whitespace-nowrap text-muted`}>{format.date(e.at, "dateTime")}</td>
                <td className={tdCls}>
                  <ActorCell kind={e.actor.kind} label={e.actor.label} kindLabel={t(`trust.center.actorKinds.${e.actor.kind}`)} />
                </td>
                <td className={tdCls}>
                  <span className="block font-medium text-ink">{e.action}</span>
                  {e.summary ? <span className="block max-w-md text-xs text-muted">{e.summary}</span> : null}
                </td>
                <td className={`${tdCls} text-ink`}>
                  {e.link ? (
                    <Link href={e.link} className="inline-flex items-center gap-1 underline-offset-2 hover:underline">
                      {e.target ?? t("trust.center.open")}
                      <ExternalLink size={12} aria-hidden />
                    </Link>
                  ) : (
                    (e.target ?? "—")
                  )}
                </td>
                <td className={`${tdCls} whitespace-nowrap text-muted`}>{sourceLabel(e.source)}</td>
              </tr>
            ))}
            {entries.length === 0 && !loading ? (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-sm text-muted">
                  {t("trust.center.empty")}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      {next ? (
        <div>
          <button type="button" onClick={() => void load(next)} disabled={loading} className={aosButton({ variant: "secondary" })}>
            {loading ? t("common.loading") : t("trust.center.loadMore")}
          </button>
        </div>
      ) : null}

      <section aria-labelledby={`${id}-chains`} className={`${cardCls} flex flex-col gap-3 p-4 sm:p-5`}>
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 id={`${id}-chains`} className="aos-subheading">
              {t("trust.center.chains.title")}
            </h2>
            <p className="mt-0.5 text-sm text-muted">{t("trust.center.chains.help")}</p>
          </div>
          <button type="button" onClick={() => void verify()} disabled={verifying} className={aosButton({ variant: "secondary", size: "sm" })}>
            <ShieldCheck size={16} aria-hidden />
            {verifying ? t("trust.center.chains.verifying") : t("trust.center.chains.verify")}
          </button>
        </div>
        <ul className="divide-y divide-line" aria-live="polite">
          {HASH_CHAINED_SOURCES.map((s) => {
            const r = chains?.find((c) => c.source === s);
            const Icon = !r || r.ok === null ? ShieldQuestion : r.ok ? ShieldCheck : ShieldAlert;
            const text = !r || r.ok === null
              ? t("trust.center.chains.notChecked")
              : r.checked === 0
                ? t("trust.center.chains.none")
                : r.ok
                  ? t("trust.center.chains.verified", { count: r.checked })
                  : t("trust.center.chains.broken", { at: r.brokenAt ?? "?" });
            return (
              <li key={s} className="flex min-h-row items-center gap-3 py-2" data-chain={s} data-chain-ok={r?.ok === null || !r ? "unknown" : String(r.ok)}>
                <Icon size={16} className="shrink-0 text-ink" aria-hidden />
                <span className="min-w-0 flex-1 font-medium text-ink">{sourceLabel(s)}</span>
                <span className={`text-sm ${r && r.ok === false ? "font-semibold text-ink" : "text-muted"}`}>{text}</span>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
