"use client";

// ShapesOS — Phase 21A (WS=agentweb): Agent readiness (a project tab in the SEO app).
//
// A score for "can an AI agent find and use this site", the fixes ordered by points,
// and the question that matters: could an agent complete the site's top tasks, and
// through which channel (declared tools, documented API, structured data, driving the
// page). Everything is computed from the site's own files; saving writes a DRAFT
// revision, never the live site. The AI-usage policy is the tenant's choice.
// Check details come from the engine in English; labels, fixes and task names are
// translated. The pass/partial/missing badges are neutral: colour and shape are for
// agent states only (DESIGN.md).

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Info, Loader2 } from "lucide-react";
import { aosButton, NeutralBadge } from "@/components/aos";
import { SwitchRow } from "@/components/aos/Controls";
import { useI18n } from "@/components/i18n/I18nProvider";
import type { MessageKey } from "@/lib/i18n";

interface Check {
  id: string;
  weight: number;
  earned: number | null;
  status: "pass" | "partial" | "fail" | "na";
  detail: string;
}
interface Report {
  score: number;
  checks: Check[];
  fixes: { id: string; points: number }[];
  tasks: { kind: string; can: boolean; channel: string; via: string }[];
}
interface Policy {
  search: boolean;
  input: boolean;
  train: boolean;
}
interface Data {
  origin: string;
  policy: Policy;
  currentPolicy: Policy | null;
  before: Report;
  after: Report;
  changes: { path: string; what: string }[];
  kept: { path: string; reason: string }[];
}

export function AgentReadyApp({ projectId, domain, sites, canDraft }: { projectId: string; domain: string; sites: { id: string; name: string }[]; canDraft: boolean }) {
  const { t } = useI18n();
  const k = (key: string) => key as MessageKey;
  const [siteId, setSiteId] = useState(sites[0]?.id ?? "");
  // The person's own AI-usage choice; null = whatever the site states now (or our default).
  const [choice, setChoice] = useState<Policy | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [result, setResult] = useState<{ key: string; data: Data | null; error: string | null } | null>(null);

  // One preview per (site, choice). State is only set after the fetch resolves, and
  // `busy` is derived: the result on screen is for another key than the one asked for.
  const key = `${siteId}|${choice ? `${+choice.search}${+choice.input}${+choice.train}` : "default"}`;
  useEffect(() => {
    if (!siteId) return;
    let live = true;
    const q = new URLSearchParams({ projectId });
    if (choice) for (const k2 of ["search", "input", "train"] as const) q.set(k2, choice[k2] ? "yes" : "no");
    (async () => {
      try {
        const res = await fetch(`/api/websites/${siteId}/agent-ready?${q}`);
        const json = (await res.json()) as Data & { error?: string };
        if (!live) return;
        setResult(res.ok ? { key, data: json, error: null } : { key, data: null, error: json.error ?? t("agentReady.failed") });
      } catch (err) {
        if (live) setResult({ key, data: null, error: err instanceof Error ? err.message : t("agentReady.failed") });
      }
    })();
    return () => {
      live = false;
    };
  }, [siteId, choice, key, projectId, t]);

  const busy = !result || result.key !== key;
  const data = result && result.key.split("|")[0] === siteId ? result.data : null;
  const policy = choice ?? data?.policy ?? null;
  const error = saveError ?? (busy ? null : (result?.error ?? null));

  function pickSite(id: string) {
    setChoice(null);
    setNotice(null);
    setSaveError(null);
    setSiteId(id);
  }

  function change(next: Policy) {
    setChoice(next);
    setNotice(null);
  }

  async function save() {
    if (!policy) return;
    setSaving(true);
    setSaveError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/websites/${siteId}/agent-ready`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId, policy }) });
      const json = (await res.json()) as { error?: string; saved?: boolean; revision?: { number: number } | null };
      if (!res.ok) throw new Error(json.error ?? t("agentReady.failed"));
      setNotice(json.saved && json.revision ? t("agentReady.draft.saved", { n: json.revision.number }) : t("agentReady.draft.nothing"));
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : t("agentReady.failed"));
    } finally {
      setSaving(false);
    }
  }

  const channelName = (c: string) => t(k(`agentReady.tasks.channels.${c}`));

  return (
    <div className="flex flex-col gap-6">
      <div className="min-w-0">
        <Link href={`/dashboard/projects/${projectId}`} className="inline-flex items-center gap-1 text-sm text-muted hover:text-ink">
          <ArrowLeft className="size-4" aria-hidden />
          {t("agentReady.back")} ({domain})
        </Link>
        <h1 className="aos-heading mt-1">{t("agentReady.title")}</h1>
        <p className="mt-1 max-w-[72ch] text-md text-muted">{t("agentReady.subtitle")}</p>
      </div>

      {sites.length === 0 ? (
        <p className="rounded-md border border-line bg-canvas px-3 py-2 text-sm text-muted" role="note">
          {t("agentReady.noSites")}
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-3">
            {sites.length > 1 ? (
              <label className="flex flex-col gap-1 text-sm font-semibold text-ink">
                {t("agentReady.site")}
                <select value={siteId} onChange={(e) => pickSite(e.target.value)} className="h-control rounded-md border-[1.5px] border-control bg-paper px-3 text-md font-normal text-ink outline-none focus:border-focus focus:shadow-[0_0_0_3px_var(--aos-focus-halo)]">
                  {sites.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {busy ? (
              <p className="flex items-center gap-2 text-sm text-muted" role="status">
                <Loader2 className="size-4 animate-spin" aria-hidden />
                {t("agentReady.loading")}
              </p>
            ) : null}
          </div>

          <p className="flex items-start gap-2 rounded-md border border-line bg-canvas px-3 py-2 text-sm text-muted" role="note">
            <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>{t("agentReady.notRanking")}</span>
          </p>

          {error ? (
            <p role="alert" className="text-sm font-semibold text-failed-text">
              {error}
            </p>
          ) : null}
          {notice ? (
            <p role="status" className="rounded-md border border-line bg-canvas px-3 py-2 text-sm text-ink">
              {notice}
            </p>
          ) : null}

          {data && policy ? (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,20rem)]">
              <div className="flex min-w-0 flex-col gap-4">
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <Score label={t("agentReady.scoreNow")} value={data.before.score} outOf={t("agentReady.outOf")} />
                  <Score label={t("agentReady.scoreAfter")} value={data.after.score} outOf={t("agentReady.outOf")} />
                </div>

                <section aria-labelledby="ar-tasks" className="flex flex-col gap-2 rounded-lg bg-paper p-4 shadow-hairline sm:p-5">
                  <h2 id="ar-tasks" className="aos-subheading">
                    {t("agentReady.tasks.title")}
                  </h2>
                  <p className="text-sm text-muted">{t("agentReady.tasks.subtitle")}</p>
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[30rem] text-left text-sm">
                      <caption className="sr-only">{t("agentReady.tasks.title")}</caption>
                      <thead>
                        <tr className="text-xs text-muted">
                          <th scope="col" className="py-2 pr-3 font-semibold">{t("agentReady.tasks.task")}</th>
                          <th scope="col" className="py-2 pr-3 font-semibold">{t("agentReady.tasks.now")}</th>
                          <th scope="col" className="py-2 font-semibold">{t("agentReady.tasks.after")}</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-line">
                        {data.after.tasks.map((a) => {
                          const b = data.before.tasks.find((x) => x.kind === a.kind);
                          return (
                            <tr key={a.kind} className="align-top hover:bg-hover-paper">
                              <th scope="row" className="py-2.5 pr-3 font-semibold text-ink">{t(k(`agentReady.tasks.${a.kind}`))}</th>
                              <td className="py-2.5 pr-3 text-muted">{b ? (b.can ? channelName(b.channel) : t("agentReady.tasks.cannot")) : t("agentReady.tasks.cannot")}</td>
                              <td className="py-2.5">
                                <span className="text-ink">{a.can ? channelName(a.channel) : t("agentReady.tasks.cannot")}</span>
                                {a.can && a.via !== a.channel ? <span className="block font-mono text-xs break-all text-muted">{a.via}</span> : null}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </section>

                <section aria-labelledby="ar-fixes" className="flex flex-col gap-2 rounded-lg bg-paper p-4 shadow-hairline sm:p-5">
                  <h2 id="ar-fixes" className="aos-subheading">
                    {t("agentReady.fixes.title")}
                  </h2>
                  {data.before.fixes.length === 0 ? (
                    <p className="text-md text-muted">{t("agentReady.fixes.empty")}</p>
                  ) : (
                    <ol className="flex flex-col divide-y divide-line">
                      {data.before.fixes.map((f) => (
                        <li key={f.id} className="flex flex-col gap-1 py-2.5 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                          <div className="min-w-0">
                            <p className="text-md font-semibold text-ink">{t(k(`agentReady.check.${f.id}`))}</p>
                            <p className="text-sm text-muted">{t(k(`agentReady.fixes.${f.id}`))}</p>
                          </div>
                          <NeutralBadge label={t("agentReady.fixes.points", { n: f.points })} size="sm" />
                        </li>
                      ))}
                    </ol>
                  )}
                </section>

                <section aria-labelledby="ar-checks" className="flex flex-col gap-2 rounded-lg bg-paper p-4 shadow-hairline sm:p-5">
                  <h2 id="ar-checks" className="aos-subheading">
                    {t("agentReady.checks.title")}
                  </h2>
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[34rem] text-left text-sm">
                      <caption className="sr-only">{t("agentReady.checks.title")}</caption>
                      <thead>
                        <tr className="text-xs text-muted">
                          <th scope="col" className="py-2 pr-3 font-semibold">{t("agentReady.checks.check")}</th>
                          <th scope="col" className="py-2 pr-3 font-semibold">{t("agentReady.checks.status")}</th>
                          <th scope="col" className="py-2 pr-3 font-semibold">{t("agentReady.checks.points")}</th>
                          <th scope="col" className="py-2 font-semibold">{t("agentReady.checks.detail")}</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-line">
                        {data.before.checks.map((c) => (
                          <tr key={c.id} className="align-top hover:bg-hover-paper">
                            <th scope="row" className="py-2.5 pr-3 font-semibold text-ink">{t(k(`agentReady.check.${c.id}`))}</th>
                            <td className="py-2.5 pr-3"><NeutralBadge label={t(k(`agentReady.status.${c.status}`))} size="sm" /></td>
                            <td className="py-2.5 pr-3 whitespace-nowrap text-muted tabular-nums">{c.earned === null ? "–" : `${c.earned} / ${c.weight}`}</td>
                            <td className="py-2.5 text-muted">{c.detail}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              </div>

              <aside className="flex min-w-0 flex-col gap-4 self-start">
                <section aria-labelledby="ar-policy" className="flex flex-col gap-2 rounded-lg bg-paper p-4 shadow-hairline">
                  <h2 id="ar-policy" className="aos-subheading">
                    {t("agentReady.policy.title")}
                  </h2>
                  <p className="text-sm text-muted">{t("agentReady.policy.help")}</p>
                  <div className="-mx-4 divide-y divide-line border-y border-line">
                    {(["search", "input", "train"] as const).map((key) => (
                      <SwitchRow key={key} title={t(k(`agentReady.policy.${key}`))} checked={policy[key]} disabled={!canDraft || busy} onChange={(v) => change({ ...policy, [key]: v })} />
                    ))}
                  </div>
                  <p className="text-xs text-muted">{data.currentPolicy ? t("agentReady.policy.current") : t("agentReady.policy.notSet")}</p>
                </section>

                <section aria-labelledby="ar-draft" className="flex flex-col gap-2 rounded-lg bg-paper p-4 shadow-hairline">
                  <h2 id="ar-draft" className="aos-subheading">
                    {t("agentReady.draft.title")}
                  </h2>
                  <p className="text-sm text-muted">{t("agentReady.draft.body")}</p>
                  <h3 className="text-sm font-semibold text-ink">{t("agentReady.draft.changes")}</h3>
                  {data.changes.length === 0 ? (
                    <p className="text-sm text-muted">{t("agentReady.draft.noChanges")}</p>
                  ) : (
                    <ul className="flex flex-col gap-1 text-sm">
                      {data.changes.map((c) => (
                        <li key={c.path} className="flex flex-col">
                          <span className="font-mono text-xs break-all text-ink">{c.path}</span>
                          <span className="text-muted">{c.what}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {data.kept.length ? (
                    <>
                      <h3 className="text-sm font-semibold text-ink">{t("agentReady.draft.kept")}</h3>
                      <ul className="flex flex-col gap-1 text-sm">
                        {data.kept.map((c) => (
                          <li key={c.path} className="flex flex-col">
                            <span className="font-mono text-xs break-all text-ink">{c.path}</span>
                            <span className="text-muted">{c.reason}</span>
                          </li>
                        ))}
                      </ul>
                    </>
                  ) : null}
                  <button type="button" onClick={() => void save()} disabled={!canDraft || saving || busy || data.changes.length === 0} className={aosButton({ variant: "primary", size: "md" })}>
                    {saving ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
                    {saving ? t("agentReady.draft.saving") : t("agentReady.draft.button")}
                  </button>
                  {!canDraft ? <p className="text-xs text-muted">{t("agentReady.draft.viewerOnly")}</p> : null}
                </section>
              </aside>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

function Score({ label, value, outOf }: { label: string; value: number; outOf: string }) {
  return (
    <div className="rounded-lg bg-paper p-4 shadow-hairline">
      <div className="text-xs font-semibold text-muted">{label}</div>
      <div className="mt-1 text-2xl font-extrabold stretch-heading tracking-heading text-ink tabular-nums">{value}</div>
      <div className="mt-1 text-xs text-muted">{outOf}</div>
    </div>
  );
}
