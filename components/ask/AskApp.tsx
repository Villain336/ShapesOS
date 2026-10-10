"use client";

// ShapesOS — Phase 21A (WS=agentweb): Ask, the answer-and-action engine's page.
//
// A question in, a sourced answer out. The answer is claims; each claim cites
// numbered sources, and a claim no stored snippet supports is shown as
// unsupported with the reason. The sources table says which provider returned
// each result, how far it is trusted, and opens its receipt (the stored capture:
// address, time, hashes, excerpt, and whether the signature still checks out).
// A mock provider is labelled. "Unsupported" is a neutral badge: colour and
// shape are reserved for agent states (DESIGN.md).
// Actions on a result (Notes, Drive, CRM, monitor a page) run through the same
// tool gates the agents use; "Draft an email" opens Mail with the draft filled in.

import { useCallback, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { BookmarkPlus, ChevronDown, ChevronUp, FileDown, FileText, Info, Loader2, Mail, Radar, Search, Settings2, ShieldCheck, UserPlus, X } from "lucide-react";
import { aosButton, FilterPill, NeutralBadge } from "@/components/aos";
import { Switch } from "@/components/aos/Controls";
import { useI18n } from "@/components/i18n/I18nProvider";
import { toast, toastError } from "@/lib/ui/feedback";
import type { MessageKey } from "@/lib/i18n";
import type { AnswerPayload, Claim, ProviderId, Source } from "@/lib/answer/types";
import type { AgentwebConfig } from "@/lib/agentweb/settings";

interface Usage {
  credits: number;
  capCredits: number;
  providerMicroUsd: number;
  modelMicroUsd: number;
  mock: boolean;
}
interface Shown {
  id: string;
  status: string;
  payload: AnswerPayload;
  usage: Usage;
}
interface HistoryItem {
  id: string;
  question: string;
  status: string;
  mock: boolean;
  createdAt: string;
}
interface ReceiptData {
  id: string;
  url: string;
  fetchedAt: string;
  domHash: string;
  textHash: string;
  excerpt: string;
  body: string | null;
  via: string;
  provider: string | null;
  signedWith: "hmac-sha256" | "none";
  verified: boolean;
  retentionUntil: string;
}

export interface AskAppProps {
  history: HistoryItem[];
  initial: Shown | null;
  config: AgentwebConfig;
  providers: Array<{ id: ProviderId; configured: boolean; mock: boolean }>;
  canAct: boolean;
  isAdmin: boolean;
  showCosts: boolean;
}

const usd = (micro: number) => `$${(micro / 1e6).toFixed(4)}`;

async function api<T>(url: string, init?: RequestInit): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    const res = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
    const json = (await res.json().catch(() => ({}))) as T & { error?: string; summary?: string };
    return res.ok ? { ok: true, data: json } : { ok: false, error: json.error ?? json.summary ?? `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Network error" };
  }
}

export function AskApp({ history: initialHistory, initial, config, providers, canAct, isAdmin, showCosts }: AskAppProps) {
  const { t, format } = useI18n();
  const [question, setQuestion] = useState(initial?.payload.question ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState<Shown | null>(initial);
  const [history, setHistory] = useState(initialHistory);
  const [activeSource, setActiveSource] = useState<number | null>(null);
  const [receipt, setReceipt] = useState<{ loading: boolean; data: ReceiptData | null; failed: boolean } | null>(null);
  const [acting, setActing] = useState<string | null>(null);
  const rowRefs = useRef<Record<number, HTMLTableRowElement | null>>({});
  const mockOnly = !providers.some((p) => !p.mock && p.configured);

  const ask = useCallback(
    async (q: string) => {
      const text = q.trim();
      if (text.length < 3) {
        setError(t("askApp.tooShort"));
        return;
      }
      setBusy(true);
      setError(null);
      setReceipt(null);
      setActiveSource(null);
      const res = await api<{ id: string; status: string; payload: AnswerPayload; usage: Usage }>("/api/answer", { method: "POST", body: JSON.stringify({ question: text }) });
      setBusy(false);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setShown(res.data);
      window.history.replaceState(window.history.state, "", `/dashboard/ask?answer=${encodeURIComponent(res.data.id)}`);
      setHistory((h) => [{ id: res.data.id, question: text, status: res.data.status, mock: res.data.usage.mock, createdAt: new Date().toISOString() }, ...h].slice(0, 15));
    },
    [t],
  );

  async function openReceipt(id: string) {
    setReceipt({ loading: true, data: null, failed: false });
    const res = await api<ReceiptData>(`/api/answer/captures/${encodeURIComponent(id)}`);
    setReceipt(res.ok ? { loading: false, data: res.data, failed: false } : { loading: false, data: null, failed: true });
  }

  async function act(action: string, sourceId?: number) {
    if (!shown) return;
    const key = `${action}:${sourceId ?? ""}`;
    setActing(key);
    const res = await api<{ link?: string; status?: string; summary?: string }>("/api/answer/act", { method: "POST", body: JSON.stringify({ answerId: shown.id, action, sourceId }) });
    setActing(null);
    if (!res.ok) {
      toastError(t("askApp.actions.failed"), res.error);
      return;
    }
    if (res.data.link) {
      window.location.assign(res.data.link);
      return;
    }
    toast({ title: t("askApp.actions.saved"), description: res.data.summary?.slice(0, 160) });
  }

  function jumpTo(id: number) {
    setActiveSource(id);
    rowRefs.current[id]?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  const p = shown?.payload;
  const sources = p?.sources ?? [];
  const mockShown = shown?.usage.mock ?? false;

  return (
    <div className="flex flex-col gap-6">
      <div className="min-w-0">
        <h1 className="aos-heading">{t("askApp.title")}</h1>
        <p className="mt-1 max-w-[72ch] text-md text-muted">{t("askApp.subtitle")}</p>
      </div>

      {mockOnly || mockShown ? (
        <p className="flex items-start gap-2 rounded-md border border-line bg-canvas px-3 py-2 text-sm text-muted" role="note">
          <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>
            <strong className="font-semibold text-ink">{t("askApp.mock.label")}.</strong> {t("askApp.mock.body")}
          </span>
        </p>
      ) : null}

      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void ask(question);
        }}
      >
        <label className="relative block min-w-[14rem] flex-1">
          <span className="sr-only">{t("askApp.formLabel")}</span>
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" aria-hidden />
          <input
            type="search"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder={t("askApp.placeholder")}
            maxLength={500}
            className="h-control w-full rounded-md border-[1.5px] border-control bg-paper pr-3 pl-9 text-md text-ink outline-none placeholder:text-subtle focus:border-focus focus:shadow-[0_0_0_3px_var(--aos-focus-halo)]"
          />
        </label>
        <button type="submit" disabled={busy} className={aosButton({ variant: "primary", size: "md" })}>
          {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
          {busy ? t("askApp.asking") : t("askApp.submit")}
        </button>
      </form>
      {error ? (
        <p role="alert" className="text-sm font-semibold text-failed-text">
          {error}
        </p>
      ) : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,18rem)]">
        <div className="flex min-w-0 flex-col gap-4">
          {p ? (
            <section aria-labelledby="ask-answer" aria-busy={busy} className="flex flex-col gap-3 rounded-lg bg-paper p-4 shadow-hairline sm:p-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 id="ask-answer" className="aos-subheading">
                  {t("askApp.answer.title")}
                </h2>
                <span className="text-xs text-muted">
                  {t("askApp.answer.cost", { credits: shown!.usage.credits, cap: shown!.usage.capCredits })}
                  {showCosts ? ` · ${t("askApp.answer.costDev", { provider: usd(shown!.usage.providerMicroUsd), model: usd(shown!.usage.modelMicroUsd) })}` : ""}
                </span>
              </div>
              <p className="text-sm text-muted">{p.writtenBy === "model" ? t("askApp.answer.writtenModel") : t("askApp.answer.writtenExtract")}</p>
              {p.partial ? <p className="rounded-md border border-line bg-canvas px-3 py-2 text-sm text-ink">{t("askApp.answer.partial")}</p> : null}

              {p.claims.length === 0 ? (
                <p className="py-4 text-md text-muted">{t("askApp.answer.empty")}</p>
              ) : (
                <ol className="flex flex-col divide-y divide-line">
                  {p.claims.map((c, i) => (
                    <ClaimRow key={i} claim={c} sources={sources} onCite={jumpTo} />
                  ))}
                </ol>
              )}

              {p.notes.length ? (
                <div>
                  <h3 className="text-sm font-semibold text-ink">{t("askApp.answer.notes")}</h3>
                  <ul className="mt-1 list-disc pl-5 text-sm text-muted">
                    {p.notes.map((n, i) => (
                      <li key={i}>{n}</li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {p.followUps.length ? (
                <div role="group" aria-label={t("askApp.answer.followUps")} className="flex flex-wrap gap-1.5">
                  {p.followUps.map((f) => (
                    <FilterPill
                      key={f}
                      selected={false}
                      onClick={() => {
                        setQuestion(f);
                        void ask(f);
                      }}
                    >
                      {f}
                    </FilterPill>
                  ))}
                </div>
              ) : null}

              <div role="group" aria-label={t("askApp.actions.label")} className="flex flex-wrap gap-2 border-t border-line pt-3">
                <button type="button" disabled={!canAct || acting !== null} onClick={() => void act("save_note")} className={aosButton({ variant: "secondary", size: "sm" })}>
                  <BookmarkPlus className="size-4" aria-hidden />
                  {t("askApp.actions.saveNote")}
                </button>
                <button type="button" disabled={!canAct || acting !== null} onClick={() => void act("save_drive")} className={aosButton({ variant: "secondary", size: "sm" })}>
                  <FileDown className="size-4" aria-hidden />
                  {t("askApp.actions.saveDrive")}
                </button>
                <button type="button" disabled={!canAct || acting !== null} onClick={() => void act("draft_email", activeSource ?? undefined)} className={aosButton({ variant: "secondary", size: "sm" })}>
                  <Mail className="size-4" aria-hidden />
                  {t("askApp.actions.draftEmail")}
                </button>
              </div>
            </section>
          ) : null}

          {p ? (
            <section aria-labelledby="ask-sources" className="flex flex-col gap-2 rounded-lg bg-paper p-4 shadow-hairline sm:p-5">
              <h2 id="ask-sources" className="aos-subheading">
                {t("askApp.sources.title")}
              </h2>
              {sources.length === 0 ? (
                <p className="py-3 text-md text-muted">{t("askApp.sources.empty")}</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[34rem] text-left text-sm">
                    <caption className="sr-only">{t("askApp.sources.title")}</caption>
                    <thead>
                      <tr className="text-xs text-muted">
                        <th scope="col" className="w-8 py-2 pr-2 font-semibold">#</th>
                        <th scope="col" className="py-2 pr-3 font-semibold">{t("askApp.sources.source")}</th>
                        <th scope="col" className="py-2 pr-3 font-semibold">{t("askApp.sources.returnedBy")}</th>
                        <th scope="col" className="py-2 pr-3 font-semibold">{t("askApp.sources.trust")}</th>
                        <th scope="col" className="py-2 pr-3 font-semibold">{t("askApp.sources.published")}</th>
                        <th scope="col" className="py-2 font-semibold">{t("askApp.sources.receipt")}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {sources.map((s) => (
                        <SourceRow
                          key={s.id}
                          source={s}
                          active={activeSource === s.id}
                          canAct={canAct}
                          busy={acting !== null}
                          rowRef={(el) => {
                            rowRefs.current[s.id] = el;
                          }}
                          onReceipt={() => s.captureId && void openReceipt(s.captureId)}
                          onAct={(a) => void act(a, s.id)}
                          format={format.date}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          ) : null}

          {receipt ? <ReceiptPanel state={receipt} onClose={() => setReceipt(null)} /> : null}
        </div>

        <aside className="flex min-w-0 flex-col gap-4 self-start">
          <section aria-labelledby="ask-history" className="flex flex-col gap-2 rounded-lg bg-paper p-4 shadow-hairline">
            <h2 id="ask-history" className="aos-subheading">
              {t("askApp.history.title")}
            </h2>
            {history.length === 0 ? (
              <p className="text-sm text-muted">{t("askApp.history.empty")}</p>
            ) : (
              <ul className="-mx-1 flex flex-col">
                {history.map((h) => (
                  <li key={h.id}>
                    <Link href={`/dashboard/ask?answer=${encodeURIComponent(h.id)}`} className="flex flex-col gap-0.5 rounded-sm px-2.5 py-2 hover:bg-hover-paper" aria-current={shown?.id === h.id ? "page" : undefined}>
                      <span className="line-clamp-2 text-md font-semibold text-ink">{h.question}</span>
                      <span className="text-xs text-muted">
                        {format.date(h.createdAt, "dateTime")}
                        {h.status === "partial" ? ` · ${t("askApp.history.partial")}` : ""}
                        {h.mock ? ` · ${t("askApp.history.mock")}` : ""}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <SettingsPanel config={config} providers={providers} isAdmin={isAdmin} />
        </aside>
      </div>
    </div>
  );
}

function ClaimRow({ claim, sources, onCite }: { claim: Claim; sources: Source[]; onCite: (id: number) => void }) {
  const { t } = useI18n();
  const unsupported = claim.status === "unsupported";
  return (
    <li className="flex flex-col gap-1.5 py-3">
      <p className={`text-md ${unsupported ? "text-muted" : "text-ink"}`}>
        {claim.text}
        {claim.cites.map((id) => {
          const s = sources.find((x) => x.id === id);
          return (
            <button
              key={id}
              type="button"
              onClick={() => onCite(id)}
              aria-label={`${t("askApp.answer.citations")}: ${id}${s ? `, ${s.title}` : ""}`}
              className="mx-0.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-paper px-1.5 align-baseline text-xs font-semibold text-ink shadow-control hover:shadow-outline"
            >
              {id}
            </button>
          );
        })}
      </p>
      {unsupported ? (
        <p className="flex flex-wrap items-center gap-2 text-sm text-muted">
          <NeutralBadge label={t("askApp.answer.unsupported")} size="sm" />
          <span>{claim.reasonCode ? t(`askApp.answer.reason.${claim.reasonCode}` as MessageKey) : (claim.reason ?? "")}</span>
        </p>
      ) : null}
    </li>
  );
}

function SourceRow({
  source: s,
  active,
  canAct,
  busy,
  rowRef,
  onReceipt,
  onAct,
  format,
}: {
  source: Source;
  active: boolean;
  canAct: boolean;
  busy: boolean;
  rowRef: (el: HTMLTableRowElement | null) => void;
  onReceipt: () => void;
  onAct: (a: "add_crm" | "monitor_page") => void;
  format: (d: string, style?: "date") => string;
}) {
  const { t } = useI18n();
  const web = /^https?:\/\//i.test(s.url);
  let host = "";
  try {
    host = web ? new URL(s.url).hostname.replace(/^www\./, "") : t("askApp.sources.workspace");
  } catch {
    host = s.url;
  }
  return (
    <tr ref={rowRef} className={active ? "bg-hover-paper" : "hover:bg-hover-paper"} aria-current={active ? "true" : undefined}>
      <td className="py-2.5 pr-2 align-top font-semibold text-ink">{s.id}</td>
      <td className="py-2.5 pr-3 align-top">
        <a href={s.url} {...(web ? { target: "_blank", rel: "noopener noreferrer" } : {})} className="block max-w-[28ch] truncate text-md font-semibold text-ink underline-offset-2 hover:underline">
          {s.title}
        </a>
        <span className="block truncate text-xs text-muted">{host}</span>
        {web && canAct ? (
          <span className="mt-1 flex flex-wrap gap-1" role="group" aria-label={t("askApp.actions.sourceActions")}>
            <button type="button" disabled={busy} onClick={() => onAct("add_crm")} className={aosButton({ variant: "quiet", size: "xs", className: "h-7 px-2.5 text-xs" })}>
              <UserPlus className="size-3.5" aria-hidden />
              {t("askApp.actions.addCrm")}
            </button>
            <button type="button" disabled={busy} onClick={() => onAct("monitor_page")} className={aosButton({ variant: "quiet", size: "xs", className: "h-7 px-2.5 text-xs" })}>
              <Radar className="size-3.5" aria-hidden />
              {t("askApp.actions.monitor")}
            </button>
          </span>
        ) : null}
      </td>
      <td className="py-2.5 pr-3 align-top">
        <span className="flex flex-wrap gap-1">
          {s.providers.map((p) => (
            <NeutralBadge key={p} label={t(`askApp.sources.providers.${p}` as MessageKey)} size="sm" />
          ))}
        </span>
      </td>
      <td className="py-2.5 pr-3 align-top text-muted">{Math.round(s.trust * 100)}%</td>
      <td className="py-2.5 pr-3 align-top text-muted">{s.publishedAt ? format(s.publishedAt, "date") : "—"}</td>
      <td className="py-2.5 align-top">
        {s.captureId ? (
          <button type="button" onClick={onReceipt} className={aosButton({ variant: "secondary", size: "xs", className: "h-7 px-2.5 text-xs" })}>
            <FileText className="size-3.5" aria-hidden />
            {t("askApp.sources.openReceipt")}
          </button>
        ) : (
          <span className="text-xs text-subtle">{t("askApp.sources.noReceipt")}</span>
        )}
      </td>
    </tr>
  );
}

function ReceiptPanel({ state, onClose }: { state: { loading: boolean; data: ReceiptData | null; failed: boolean }; onClose: () => void }) {
  const { t, format } = useI18n();
  const d = state.data;
  return (
    <section aria-labelledby="ask-receipt" className="flex flex-col gap-3 rounded-lg bg-paper p-4 shadow-hairline sm:p-5">
      <div className="flex items-center justify-between gap-2">
        <h2 id="ask-receipt" className="aos-subheading flex items-center gap-2">
          <ShieldCheck className="size-5 text-muted" aria-hidden />
          {t("askApp.receipt.title")}
        </h2>
        <button type="button" onClick={onClose} aria-label={t("askApp.receipt.close")} className="flex size-9 items-center justify-center rounded-full hover:bg-hover">
          <X className="size-4" aria-hidden />
        </button>
      </div>
      {state.loading ? (
        <p className="flex items-center gap-2 text-sm text-muted">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          {t("askApp.receipt.loading")}
        </p>
      ) : state.failed || !d ? (
        <p role="alert" className="text-sm text-muted">
          {t("askApp.receipt.unavailable")}
        </p>
      ) : (
        <dl className="grid grid-cols-1 gap-x-4 gap-y-2.5 text-sm sm:grid-cols-[10rem_minmax(0,1fr)]">
          <dt className="font-semibold text-muted">{t("askApp.receipt.address")}</dt>
          <dd className="font-mono text-xs break-all text-ink">{d.url}</dd>
          <dt className="font-semibold text-muted">{t("askApp.receipt.fetched")}</dt>
          <dd className="text-ink">{format.date(d.fetchedAt, "dateTime")}</dd>
          <dt className="font-semibold text-muted">{t("askApp.receipt.pageHash")}</dt>
          <dd className="font-mono text-xs break-all text-ink">{d.domHash}</dd>
          <dt className="font-semibold text-muted">{t("askApp.receipt.textHash")}</dt>
          <dd className="font-mono text-xs break-all text-ink">{d.textHash}</dd>
          <dt className="font-semibold text-muted">{t("askApp.receipt.excerpt")}</dt>
          <dd className="text-ink">{d.excerpt}</dd>
          <dt className="font-semibold text-muted">{t("askApp.receipt.signature")}</dt>
          <dd className="text-ink">{d.verified ? t("askApp.receipt.verified") : d.signedWith === "none" ? t("askApp.receipt.unsigned") : t("askApp.receipt.broken")}</dd>
          <dt className="font-semibold text-muted">{t("askApp.receipt.via")}</dt>
          <dd className="text-ink">
            {d.via}
            {d.provider ? ` · ${d.provider}` : ""} · {t("askApp.receipt.keptUntil", { date: format.date(d.retentionUntil, "date") })}
          </dd>
        </dl>
      )}
    </section>
  );
}

function SettingsPanel({ config, providers, isAdmin }: { config: AgentwebConfig; providers: AskAppProps["providers"]; isAdmin: boolean }) {
  const { t } = useI18n();
  const known = useMemo(() => providers.map((p) => p.id), [providers]);
  const initialOrder = useMemo(() => {
    const first = config.providerOrder.filter((id) => known.includes(id as ProviderId));
    return [...first, ...known.filter((id) => !first.includes(id))] as ProviderId[];
  }, [config.providerOrder, known]);
  const [order, setOrder] = useState<ProviderId[]>(initialOrder);
  const [enabled, setEnabled] = useState<Record<string, boolean>>(() => Object.fromEntries(known.map((id) => [id, config.providerOrder.length ? config.providerOrder.includes(id) : id !== "mock"])));
  const [retention, setRetention] = useState(String(config.captureRetentionDays));
  const [cap, setCap] = useState(String(config.answerCapCredits));
  const [saving, setSaving] = useState(false);

  function move(i: number, d: -1 | 1) {
    setOrder((o) => {
      const n = [...o];
      const j = i + d;
      if (j < 0 || j >= n.length) return o;
      [n[i], n[j]] = [n[j]!, n[i]!];
      return n;
    });
  }
  async function save() {
    setSaving(true);
    const res = await api<unknown>("/api/answer/settings", { method: "PUT", body: JSON.stringify({ providerOrder: order.filter((id) => enabled[id]), captureRetentionDays: Number(retention), answerCapCredits: Number(cap) }) });
    setSaving(false);
    if (!res.ok) toastError(t("askApp.failed"), res.error);
    else toast(t("askApp.settings.saved"));
  }

  return (
    <details className="group rounded-lg bg-paper p-4 shadow-hairline">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 rounded-sm text-md font-semibold text-ink">
        <span className="flex items-center gap-2">
          <Settings2 className="size-4 text-muted" aria-hidden />
          {t("askApp.settings.title")}
        </span>
        <ChevronDown className="size-4 text-muted group-open:hidden" aria-hidden />
        <ChevronUp className="hidden size-4 text-muted group-open:block" aria-hidden />
      </summary>
      <div className="mt-3 flex flex-col gap-4">
        {!isAdmin ? <p className="text-sm text-muted">{t("askApp.settings.adminOnly")}</p> : null}
        <fieldset className="flex flex-col gap-1.5" disabled={!isAdmin}>
          <legend className="mb-1 text-sm font-semibold text-ink">{t("askApp.settings.providers")}</legend>
          {order.map((id, i) => {
            const p = providers.find((x) => x.id === id)!;
            const label = t(`askApp.sources.providers.${id}` as MessageKey);
            return (
              <div key={id} className="flex items-center gap-2">
                <Switch checked={!!enabled[id]} onChange={(v) => setEnabled((e) => ({ ...e, [id]: v }))} label={`${t("askApp.settings.use")} ${label}`} disabled={!isAdmin} />
                <span className="min-w-0 flex-1 text-md text-ink">
                  {label}
                  {!p.configured ? <span className="block text-xs text-muted">{t("askApp.settings.providerOff")}</span> : null}
                </span>
                <button type="button" onClick={() => move(i, -1)} disabled={!isAdmin || i === 0} aria-label={`${t("askApp.settings.moveUp")}: ${label}`} className="flex size-8 items-center justify-center rounded-full hover:bg-hover disabled:opacity-40">
                  <ChevronUp className="size-4" aria-hidden />
                </button>
                <button type="button" onClick={() => move(i, 1)} disabled={!isAdmin || i === order.length - 1} aria-label={`${t("askApp.settings.moveDown")}: ${label}`} className="flex size-8 items-center justify-center rounded-full hover:bg-hover disabled:opacity-40">
                  <ChevronDown className="size-4" aria-hidden />
                </button>
              </div>
            );
          })}
        </fieldset>
        <label className="flex flex-col gap-1.5 text-sm font-semibold text-ink">
          {t("askApp.settings.cap")}
          <input type="number" min={1} max={500} value={cap} onChange={(e) => setCap(e.target.value)} disabled={!isAdmin} aria-describedby="ask-cap-help" className="h-control w-full rounded-md border-[1.5px] border-control bg-paper px-3 text-md font-normal text-ink outline-none focus:border-focus focus:shadow-[0_0_0_3px_var(--aos-focus-halo)]" />
          <span id="ask-cap-help" className="text-xs font-normal text-muted">
            {t("askApp.settings.capHelp")}
          </span>
        </label>
        <label className="flex flex-col gap-1.5 text-sm font-semibold text-ink">
          {t("askApp.settings.retention")}
          <input type="number" min={1} max={365} value={retention} onChange={(e) => setRetention(e.target.value)} disabled={!isAdmin} className="h-control w-full rounded-md border-[1.5px] border-control bg-paper px-3 text-md font-normal text-ink outline-none focus:border-focus focus:shadow-[0_0_0_3px_var(--aos-focus-halo)]" />
        </label>
        {isAdmin ? (
          <button type="button" onClick={() => void save()} disabled={saving} className={aosButton({ variant: "primary", size: "sm", className: "self-start" })}>
            {saving ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
            {saving ? t("askApp.settings.saving") : t("askApp.settings.save")}
          </button>
        ) : null}
      </div>
    </details>
  );
}
