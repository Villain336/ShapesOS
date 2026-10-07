"use client";

// ShapesOS — Phase 19B (WS=panel): Dress Rehearsal (/dashboard/rehearsal).
//   Page walk: interviews in (upload / paste / reuse Meet or a note) →
//   personas (derive under a confirmed cap, edit, veto) → a page walk run
//   (estimate first, then a confirmed hard cap) → runs → the report.
//   Town: the next milestone.
// Run states are neutral pills: a run is a background job, not an agent
// (DESIGN.md: status colour + shape only for agent states). Personas are
// people. Every screen carries the "synthetic; directional" note.

import { useCallback, useState } from "react";
import { Building2, Drama, FileText, Footprints, Plus, RotateCcw, Upload, UserRound, UsersRound } from "lucide-react";
import { aosButton, NeutralBadge } from "@/components/aos";
import { useI18n } from "@/components/i18n/I18nProvider";
import { toast, toastError } from "@/lib/ui/feedback";
import type { MessageKey } from "@/lib/i18n";
import type { CalibrationSummary, InterviewView, PersonaView, RunView } from "@/lib/panel/service.server";
import type { DeriveEstimate, RunEstimate } from "@/lib/panel/estimate";
import { RunReportView } from "./RunReport";
import { cardClass, inputClass, SyntheticNote } from "./ui";

export interface RehearsalSources {
  meetings: Array<{ id: string; label: string }>;
  notes: Array<{ id: string; label: string }>;
  landingPages: Array<{ id: string; label: string }>;
  sites: Array<{ id: string; label: string }>;
}

export interface RehearsalAppProps {
  canEdit: boolean;
  initial: { interviews: InterviewView[]; personas: PersonaView[]; runs: RunView[]; calibration: CalibrationSummary };
  sources: RehearsalSources;
}

const labelClass = "flex flex-col gap-1.5 text-sm font-semibold text-ink";

async function api<T>(url: string, init?: RequestInit): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  const res = await fetch(url, { cache: "no-store", ...init }).catch(() => null);
  const body = (await res?.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res || !res.ok) return { ok: false, error: body?.error ?? "Could not reach the server." };
  return { ok: true, data: body as T };
}

const post = (body: unknown, method = "POST"): RequestInit => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export function RehearsalApp({ canEdit, initial, sources }: RehearsalAppProps) {
  const { t } = useI18n();
  const [tab, setTab] = useState<"walk" | "town">("walk");
  const [interviews, setInterviews] = useState(initial.interviews);
  const [personas, setPersonas] = useState(initial.personas);
  const [runs, setRuns] = useState(initial.runs);
  const [calibration, setCalibration] = useState(initial.calibration);
  const [openRun, setOpenRun] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [i, p, r, c] = await Promise.all([
      api<{ interviews: InterviewView[] }>("/api/rehearsal/interviews"),
      api<{ personas: PersonaView[] }>("/api/rehearsal/personas"),
      api<{ runs: RunView[] }>("/api/rehearsal/runs"),
      api<{ summary: CalibrationSummary }>("/api/rehearsal/calibration"),
    ]);
    if (i.ok) setInterviews(i.data.interviews);
    if (p.ok) setPersonas(p.data.personas);
    if (r.ok) setRuns(r.data.runs);
    if (c.ok) setCalibration(c.data.summary);
  }, []);

  const tabs = [
    { id: "walk" as const, label: t("rehearsal.tabs.pageWalk"), icon: Footprints },
    { id: "town" as const, label: t("rehearsal.tabs.town"), icon: Building2 },
  ];

  return (
    <div className="flex flex-col gap-6">
      <div className="min-w-0">
        <h1 className="aos-heading">{t("rehearsal.title")}</h1>
        <p className="mt-1 max-w-[72ch] text-md text-muted">{t("rehearsal.subtitle")}</p>
      </div>
      <SyntheticNote />
      <div className="flex gap-1 border-b border-line" role="tablist" aria-label={t("rehearsal.title")}>
        {tabs.map((x) => {
          const Icon = x.icon;
          return (
            <button
              key={x.id}
              type="button"
              role="tab"
              id={`rehearsal-tab-${x.id}`}
              aria-selected={tab === x.id}
              aria-controls={`rehearsal-panel-${x.id}`}
              onClick={() => setTab(x.id)}
              className={`flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition ${tab === x.id ? "border-ink text-ink" : "border-transparent text-muted hover:text-ink"}`}
            >
              <Icon className="size-4" aria-hidden />
              {x.label}
            </button>
          );
        })}
      </div>
      {tab === "town" ? (
        <section id="rehearsal-panel-town" role="tabpanel" aria-labelledby="rehearsal-tab-town" className={cardClass}>
          <div className="flex items-center gap-2">
            <Building2 className="size-4 text-muted" aria-hidden />
            <h2 className="aos-subheading">{t("rehearsal.town.title")}</h2>
          </div>
          <p className="text-sm text-muted">{t("rehearsal.town.soon")}</p>
        </section>
      ) : (
        <div id="rehearsal-panel-walk" role="tabpanel" aria-labelledby="rehearsal-tab-walk" className="flex flex-col gap-6">
          <Interviews canEdit={canEdit} interviews={interviews} sources={sources} onChange={refresh} />
          <Personas canEdit={canEdit} interviews={interviews} personas={personas} onChange={refresh} />
          {canEdit ? <NewRun personas={personas} sources={sources} onStarted={async (id) => (await refresh(), setOpenRun(id))} /> : null}
          <Runs runs={runs} calibration={calibration} onOpen={setOpenRun} openRun={openRun} />
          {openRun ? <RunReportView key={openRun} runId={openRun} runs={runs} canEdit={canEdit} onClose={() => setOpenRun(null)} onChange={refresh} /> : null}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Interviews
// ---------------------------------------------------------------------------

function Interviews({ canEdit, interviews, sources, onChange }: { canEdit: boolean; interviews: InterviewView[]; sources: RehearsalSources; onChange: () => Promise<void> }) {
  const { t, format } = useI18n();
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [interviewee, setInterviewee] = useState("");
  const [reuse, setReuse] = useState("");

  async function done(res: { ok: boolean; error?: string }) {
    setBusy(false);
    if (!res.ok) return toastError(t("rehearsal.interviews.failed"), res.error);
    toast({ title: t("rehearsal.interviews.added"), status: "done" });
    await onChange();
  }

  async function upload(file: File | null) {
    if (!file) return;
    setBusy(true);
    const form = new FormData();
    form.set("file", file);
    if (interviewee.trim()) form.set("interviewee", interviewee.trim());
    await done(await api("/api/rehearsal/interviews", { method: "POST", body: form }));
  }

  async function paste() {
    setBusy(true);
    await done(await api("/api/rehearsal/interviews", post({ title: title || "Interview", text, interviewee: interviewee || null })));
    setText("");
    setTitle("");
  }

  async function reuseSource() {
    const [kind, id] = reuse.split(":");
    if (!id) return;
    setBusy(true);
    await done(await api("/api/rehearsal/interviews", post(kind === "meet" ? { meetingId: id } : { noteId: id })));
    setReuse("");
  }

  return (
    <section aria-labelledby="rh-interviews" className={cardClass}>
      <div className="flex items-center gap-2">
        <FileText className="size-4 text-muted" aria-hidden />
        <h2 id="rh-interviews" className="aos-subheading">
          {t("rehearsal.interviews.title")}
        </h2>
      </div>
      {interviews.length === 0 ? (
        <p className="text-sm text-muted">{t("rehearsal.interviews.empty")}</p>
      ) : (
        <div className="-mx-1 overflow-x-auto">
          <table className="w-full min-w-[36rem] border-collapse text-left text-sm">
            <caption className="sr-only">{t("rehearsal.interviews.title")}</caption>
            <thead>
              <tr className="border-b border-line text-xs text-muted">
                <th scope="col" className="px-2 py-2 font-semibold">{t("rehearsal.interviews.cols.title")}</th>
                <th scope="col" className="px-2 py-2 font-semibold">{t("rehearsal.interviews.cols.source")}</th>
                <th scope="col" className="px-2 py-2 font-semibold">{t("rehearsal.interviews.cols.size")}</th>
                <th scope="col" className="px-2 py-2 font-semibold">{t("rehearsal.interviews.cols.added")}</th>
              </tr>
            </thead>
            <tbody>
              {interviews.map((i) => (
                <tr key={i.id} className="border-b border-line last:border-b-0 hover:bg-hover-paper">
                  <td className="px-2 py-2.5">
                    <span className="block font-semibold text-ink">{i.title}</span>
                    {i.interviewee ? <span className="block text-xs text-muted">{i.interviewee}</span> : null}
                  </td>
                  <td className="px-2 py-2.5">
                    <NeutralBadge size="sm" label={t(`rehearsal.interviews.sources.${i.source}` as MessageKey)} />
                  </td>
                  <td className="px-2 py-2.5 text-muted">{t("rehearsal.interviews.chars", { count: format.number(i.charCount) })}</td>
                  <td className="px-2 py-2.5 text-muted" suppressHydrationWarning>
                    {format.date(i.createdAt, "dateTime")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {canEdit ? (
        <div className="grid gap-4 md:grid-cols-3">
          <div className="flex flex-col gap-2">
            <label className={labelClass}>
              {t("rehearsal.interviews.interviewee")}
              <input value={interviewee} onChange={(e) => setInterviewee(e.target.value)} className={inputClass} />
            </label>
            <label className={labelClass}>
              <span className="flex items-center gap-1.5">
                <Upload className="size-4" aria-hidden />
                {t("rehearsal.interviews.upload")}
              </span>
              <input
                type="file"
                accept=".txt,.md,.vtt,.srt,.docx,text/plain,text/vtt"
                disabled={busy}
                onChange={(e) => void upload(e.target.files?.[0] ?? null).then(() => (e.target.value = ""))}
                className="text-sm text-ink file:mr-3 file:h-control-sm file:rounded-full file:border-0 file:bg-ink file:px-4 file:font-semibold file:text-paper"
              />
              <span className="text-xs font-normal text-muted">{t("rehearsal.interviews.uploadHint")}</span>
            </label>
          </div>
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void paste();
            }}
          >
            <label className={labelClass}>
              {t("rehearsal.interviews.pasteTitle")}
              <input value={title} onChange={(e) => setTitle(e.target.value)} className={inputClass} />
            </label>
            <label className={labelClass}>
              {t("rehearsal.interviews.pasteText")}
              <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} className="w-full rounded-md border-[1.5px] border-control bg-paper px-3 py-2 text-md text-ink outline-none focus:border-focus focus:shadow-[0_0_0_3px_var(--aos-focus-halo)]" />
            </label>
            <button type="submit" disabled={busy || !text.trim()} className={aosButton({ variant: "secondary", size: "sm", className: "self-start" })}>
              <Plus className="size-4" aria-hidden />
              {busy ? t("rehearsal.interviews.adding") : t("rehearsal.interviews.add")}
            </button>
          </form>
          <div className="flex flex-col gap-2">
            <label className={labelClass}>
              {t("rehearsal.interviews.reuse")}
              <select value={reuse} onChange={(e) => setReuse(e.target.value)} className={inputClass}>
                <option value="">{sources.meetings.length + sources.notes.length ? t("rehearsal.interviews.pick") : t("rehearsal.interviews.none")}</option>
                {sources.meetings.length ? (
                  <optgroup label={t("rehearsal.interviews.fromMeet")}>
                    {sources.meetings.map((m) => (
                      <option key={m.id} value={`meet:${m.id}`}>
                        {m.label}
                      </option>
                    ))}
                  </optgroup>
                ) : null}
                {sources.notes.length ? (
                  <optgroup label={t("rehearsal.interviews.fromNote")}>
                    {sources.notes.map((n) => (
                      <option key={n.id} value={`note:${n.id}`}>
                        {n.label}
                      </option>
                    ))}
                  </optgroup>
                ) : null}
              </select>
            </label>
            <button type="button" disabled={busy || !reuse} onClick={() => void reuseSource()} className={aosButton({ variant: "secondary", size: "sm", className: "self-start" })}>
              <Plus className="size-4" aria-hidden />
              {t("rehearsal.interviews.add")}
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Personas
// ---------------------------------------------------------------------------

function CapConfirm({ estimate, cap, setCap, confirmed, setConfirmed, idPrefix }: { estimate: number; cap: string; setCap: (v: string) => void; confirmed: boolean; setConfirmed: (v: boolean) => void; idPrefix: string }) {
  const { t } = useI18n();
  const capN = Math.max(0, Math.floor(Number(cap) || 0));
  return (
    <div className="flex flex-wrap items-end gap-4">
      <label className={labelClass}>
        {t("rehearsal.run.cap")}
        <input id={`${idPrefix}-cap`} type="number" min={1} value={cap} onChange={(e) => (setCap(e.target.value), setConfirmed(false))} className={`${inputClass} w-32`} aria-describedby={`${idPrefix}-cap-help`} />
      </label>
      <label className="flex min-h-control items-center gap-2 text-sm text-ink">
        <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className="size-4" />
        {t("rehearsal.run.confirm", { credits: capN })}
      </label>
      <span id={`${idPrefix}-cap-help`} className="basis-full text-xs text-muted">
        {t("rehearsal.run.capHelp")} {estimate > 0 ? t("rehearsal.run.estimateLine", { credits: estimate }) : null}
      </span>
    </div>
  );
}

function Personas({ canEdit, interviews, personas, onChange }: { canEdit: boolean; interviews: InterviewView[]; personas: PersonaView[]; onChange: () => Promise<void> }) {
  const { t, format } = useI18n();
  const [picked, setPicked] = useState<string[]>([]);
  const [estimate, setEstimate] = useState<DeriveEstimate | null>(null);
  const [cap, setCap] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<PersonaView | null>(null);

  async function estimateDerive() {
    setBusy("estimate");
    const res = await api<{ estimate: DeriveEstimate }>("/api/rehearsal/personas/estimate", post({ transcriptIds: picked }));
    setBusy(null);
    if (!res.ok) return toastError(t("rehearsal.personas.failed"), res.error);
    setEstimate(res.data.estimate);
    setCap(String(res.data.estimate.total));
    setConfirmed(false);
  }

  async function derive() {
    setBusy("derive");
    const res = await api<{ result: { personas: PersonaView[]; stoppedAtCap: boolean; droppedObjections: string[] } }>("/api/rehearsal/personas/derive", post({ transcriptIds: picked, capCredits: Number(cap), confirmed }));
    setBusy(null);
    if (!res.ok) return toastError(t("rehearsal.personas.failed"), res.error);
    const r = res.data.result;
    toast({ title: t("rehearsal.personas.derived", { count: r.personas.length }), description: [r.stoppedAtCap ? t("rehearsal.personas.stoppedAtCap") : "", r.droppedObjections.length ? t("rehearsal.personas.dropped", { count: r.droppedObjections.length }) : ""].filter(Boolean).join(" ") || undefined, status: "done" });
    setPicked([]);
    setEstimate(null);
    setConfirmed(false);
    await onChange();
  }

  async function setStatus(p: PersonaView, status: "active" | "vetoed") {
    setBusy(p.id);
    const res = await api(`/api/rehearsal/personas/${encodeURIComponent(p.id)}`, post({ status }, "PATCH"));
    setBusy(null);
    if (!res.ok) return toastError(t("rehearsal.personas.saveFailed"), res.error);
    await onChange();
  }

  return (
    <section aria-labelledby="rh-personas" className={cardClass}>
      <div className="flex items-center gap-2">
        <UsersRound className="size-4 text-muted" aria-hidden />
        <h2 id="rh-personas" className="aos-subheading">
          {t("rehearsal.personas.title")}
        </h2>
      </div>
      {personas.length === 0 ? (
        <p className="text-sm text-muted">{t("rehearsal.personas.empty")}</p>
      ) : (
        <div className="-mx-1 overflow-x-auto">
          <table className="w-full min-w-[40rem] border-collapse text-left text-sm">
            <caption className="sr-only">{t("rehearsal.personas.title")}</caption>
            <thead>
              <tr className="border-b border-line text-xs text-muted">
                <th scope="col" className="px-2 py-2 font-semibold">{t("rehearsal.personas.cols.name")}</th>
                <th scope="col" className="px-2 py-2 font-semibold">{t("rehearsal.personas.cols.budget")}</th>
                <th scope="col" className="px-2 py-2 font-semibold">{t("rehearsal.personas.cols.interviews")}</th>
                <th scope="col" className="px-2 py-2 font-semibold">{t("rehearsal.personas.cols.status")}</th>
                {canEdit ? <th scope="col" className="px-2 py-2 text-right font-semibold">{t("rehearsal.personas.cols.actions")}</th> : null}
              </tr>
            </thead>
            <tbody>
              {personas.map((p) => (
                <tr key={p.id} className="border-b border-line align-top last:border-b-0 hover:bg-hover-paper">
                  <td className="px-2 py-2.5">
                    <span className="flex items-center gap-1.5 font-semibold text-ink">
                      <UserRound className="size-4 text-muted" aria-hidden />
                      {p.name}
                    </span>
                    <span className="block text-xs text-muted">{p.spec.identity.role}</span>
                  </td>
                  <td className="px-2 py-2.5 text-muted">
                    {t("rehearsal.personas.budgetValue", { amount: format.money(Math.round(p.spec.budget.monthlyMax * 100), p.spec.budget.currency) })}
                    {p.spec.budget.hardCap ? <span className="block text-xs">{t("rehearsal.personas.hardCap")}</span> : null}
                  </td>
                  <td className="px-2 py-2.5">
                    <NeutralBadge size="sm" label={p.calibrated ? t("rehearsal.personas.calibrated") : t("rehearsal.personas.uncalibrated")} />
                  </td>
                  <td className="px-2 py-2.5">
                    <NeutralBadge size="sm" label={p.status === "vetoed" ? t("rehearsal.personas.vetoed") : t("rehearsal.personas.active")} />
                  </td>
                  {canEdit ? (
                    <td className="px-2 py-2.5">
                      <div className="flex flex-wrap justify-end gap-1.5">
                        <button type="button" onClick={() => setEditing(p)} className={aosButton({ variant: "quiet", size: "xs" })}>
                          {t("rehearsal.personas.edit")}
                        </button>
                        {p.status === "vetoed" ? (
                          <button type="button" disabled={busy !== null} onClick={() => void setStatus(p, "active")} className={aosButton({ variant: "secondary", size: "xs" })}>
                            <RotateCcw className="size-3.5" aria-hidden />
                            {t("rehearsal.personas.restore")}
                          </button>
                        ) : (
                          <button type="button" disabled={busy !== null} onClick={() => void setStatus(p, "vetoed")} className={aosButton({ variant: "secondary", size: "xs" })}>
                            {t("rehearsal.personas.veto")}
                          </button>
                        )}
                      </div>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing ? <PersonaEditor persona={editing} onClose={() => setEditing(null)} onSaved={onChange} /> : null}
      {canEdit && interviews.length > 0 ? (
        <fieldset className="flex flex-col gap-3 rounded-md border border-line p-3">
          <legend className="px-1 text-sm font-semibold text-ink">{t("rehearsal.personas.pickInterviews")}</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {interviews.map((i) => (
              <label key={i.id} className="flex items-center gap-2 text-sm text-ink">
                <input type="checkbox" className="size-4" checked={picked.includes(i.id)} onChange={(e) => (setPicked((xs) => (e.target.checked ? [...xs, i.id] : xs.filter((x) => x !== i.id))), setEstimate(null))} />
                {i.title}
              </label>
            ))}
          </div>
          <button type="button" disabled={busy !== null || picked.length === 0} onClick={() => void estimateDerive()} className={aosButton({ variant: "secondary", size: "sm", className: "self-start" })}>
            {busy === "estimate" ? t("rehearsal.personas.estimating") : t("rehearsal.personas.estimate")}
          </button>
          {estimate ? (
            <>
              <p className="text-sm text-muted">{t("rehearsal.personas.estimateLine", { credits: estimate.total, formula: estimate.formula })}</p>
              <CapConfirm idPrefix="derive" estimate={estimate.total} cap={cap} setCap={setCap} confirmed={confirmed} setConfirmed={setConfirmed} />
              <button type="button" disabled={busy !== null || !confirmed || Number(cap) < 0} onClick={() => void derive()} className={aosButton({ size: "md", className: "self-start" })}>
                <Drama className="size-4" aria-hidden />
                {busy === "derive" ? t("rehearsal.personas.deriving") : t("rehearsal.personas.derive")}
              </button>
            </>
          ) : null}
        </fieldset>
      ) : null}
    </section>
  );
}

function PersonaEditor({ persona, onClose, onSaved }: { persona: PersonaView; onClose: () => void; onSaved: () => Promise<void> }) {
  const { t } = useI18n();
  const [monthly, setMonthly] = useState(String(persona.spec.budget.monthlyMax));
  const [skepticism, setSkepticism] = useState(String(persona.spec.skepticism));
  const [goals, setGoals] = useState(persona.spec.goals.join("\n"));
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    const edits = { budget: { monthlyMax: Number(monthly) }, skepticism: Number(skepticism), goals: goals.split("\n").map((g) => g.trim()).filter(Boolean) };
    const res = await api(`/api/rehearsal/personas/${encodeURIComponent(persona.id)}`, post({ edits }, "PATCH"));
    setBusy(false);
    if (!res.ok) return toastError(t("rehearsal.personas.saveFailed"), res.error);
    toast({ title: t("rehearsal.personas.saved"), status: "done" });
    onClose();
    await onSaved();
  }
  return (
    <form
      aria-label={t("rehearsal.personas.editTitle", { name: persona.name })}
      className="flex flex-col gap-3 rounded-md border border-line p-3"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <p className="text-sm font-semibold text-ink">{t("rehearsal.personas.editTitle", { name: persona.name })}</p>
      <div className="grid gap-3 md:grid-cols-2">
        <label className={labelClass}>
          {t("rehearsal.personas.monthly")} ({persona.spec.budget.currency})
          <input type="number" min={0} value={monthly} onChange={(e) => setMonthly(e.target.value)} className={inputClass} />
        </label>
        <label className={labelClass}>
          {t("rehearsal.personas.skepticism")}
          <input type="number" min={0} max={1} step={0.05} value={skepticism} onChange={(e) => setSkepticism(e.target.value)} className={inputClass} />
        </label>
      </div>
      <label className={labelClass}>
        {t("rehearsal.personas.goals")}
        <textarea rows={3} value={goals} onChange={(e) => setGoals(e.target.value)} className="w-full rounded-md border-[1.5px] border-control bg-paper px-3 py-2 text-md text-ink outline-none focus:border-focus focus:shadow-[0_0_0_3px_var(--aos-focus-halo)]" />
      </label>
      {persona.spec.knownObjections.length ? (
        <div className="text-sm">
          <p className="font-semibold text-ink">{t("rehearsal.personas.objections")}</p>
          <ul className="list-disc pl-5 text-muted">
            {persona.spec.knownObjections.map((o) => (
              <li key={o.text}>{o.text}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="flex gap-2">
        <button type="submit" disabled={busy} className={aosButton({ size: "sm" })}>
          {t("rehearsal.personas.save")}
        </button>
        <button type="button" onClick={onClose} className={aosButton({ variant: "quiet", size: "sm" })}>
          {t("common.cancel")}
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// New run
// ---------------------------------------------------------------------------

function NewRun({ personas, sources, onStarted }: { personas: PersonaView[]; sources: RehearsalSources; onStarted: (runId: string) => Promise<void> }) {
  const { t } = useI18n();
  const active = personas.filter((p) => p.status === "active");
  const [kind, setKind] = useState<"url" | "landing_page" | "site">(sources.landingPages.length ? "landing_page" : "url");
  const [url, setUrl] = useState("");
  const [pageDraftId, setPageDraftId] = useState(sources.landingPages[0]?.id ?? "");
  const [siteId, setSiteId] = useState(sources.sites[0]?.id ?? "");
  const [sitePath, setSitePath] = useState("");
  const [chosen, setChosen] = useState<string[] | null>(null);
  // Until the person changes the selection, every active persona walks —
  // including personas derived after the page loaded.
  const picked = chosen ?? active.map((p) => p.id);
  const setPicked = (fn: (xs: string[]) => string[]) => setChosen(fn(picked));
  const [stepCap, setStepCap] = useState("8");
  const [estimate, setEstimate] = useState<RunEstimate | null>(null);
  const [cap, setCap] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const target = kind === "url" ? { kind, url } : kind === "landing_page" ? { kind, pageDraftId } : { kind, siteId, ...(sitePath.trim() ? { path: sitePath.trim() } : {}) };

  async function estimateRun() {
    setBusy("estimate");
    const res = await api<{ estimate: RunEstimate }>("/api/rehearsal/runs/estimate", post({ personaIds: picked, stepCap: Number(stepCap) }));
    setBusy(null);
    if (!res.ok) return toastError(t("rehearsal.run.failed"), res.error);
    setEstimate(res.data.estimate);
    setCap(String(res.data.estimate.total));
    setConfirmed(false);
  }

  async function start() {
    setBusy("start");
    const res = await api<{ run: RunView }>("/api/rehearsal/runs", post({ target, personaIds: picked, stepCap: Number(stepCap), capCredits: Number(cap), confirmed }));
    setBusy(null);
    if (!res.ok) return toastError(t("rehearsal.run.failed"), res.error);
    toast({ title: t("rehearsal.run.started"), status: "done" });
    setEstimate(null);
    setConfirmed(false);
    await onStarted(res.data.run.id);
  }

  return (
    <section aria-labelledby="rh-new-run" className={cardClass}>
      <div className="flex items-center gap-2">
        <Footprints className="size-4 text-muted" aria-hidden />
        <h2 id="rh-new-run" className="aos-subheading">
          {t("rehearsal.run.title")}
        </h2>
      </div>
      {active.length === 0 ? (
        <p className="text-sm text-muted">{t("rehearsal.run.noPersonas")}</p>
      ) : (
        <>
          <div className="grid gap-3 md:grid-cols-3">
            <label className={labelClass}>
              {t("rehearsal.run.targetKind")}
              <select value={kind} onChange={(e) => (setKind(e.target.value as typeof kind), setEstimate(null))} className={inputClass}>
                <option value="url">{t("rehearsal.run.kinds.url")}</option>
                <option value="landing_page">{t("rehearsal.run.kinds.landing_page")}</option>
                <option value="site">{t("rehearsal.run.kinds.site")}</option>
              </select>
            </label>
            {kind === "url" ? (
              <label className={`${labelClass} md:col-span-2`}>
                {t("rehearsal.run.url")}
                <input type="url" inputMode="url" placeholder="https://" value={url} onChange={(e) => setUrl(e.target.value)} className={inputClass} />
              </label>
            ) : kind === "landing_page" ? (
              <label className={`${labelClass} md:col-span-2`}>
                {t("rehearsal.run.landingPage")}
                <select value={pageDraftId} onChange={(e) => setPageDraftId(e.target.value)} className={inputClass}>
                  {sources.landingPages.length ? sources.landingPages.map((d) => <option key={d.id} value={d.id}>{d.label}</option>) : <option value="">{t("rehearsal.run.noLandingPages")}</option>}
                </select>
              </label>
            ) : (
              <>
                <label className={labelClass}>
                  {t("rehearsal.run.site")}
                  <select value={siteId} onChange={(e) => setSiteId(e.target.value)} className={inputClass}>
                    {sources.sites.length ? sources.sites.map((s) => <option key={s.id} value={s.id}>{s.label}</option>) : <option value="">{t("rehearsal.run.noSites")}</option>}
                  </select>
                </label>
                <label className={labelClass}>
                  {t("rehearsal.run.sitePath")}
                  <input value={sitePath} placeholder="/index.html" onChange={(e) => setSitePath(e.target.value)} className={inputClass} />
                </label>
              </>
            )}
          </div>
          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-semibold text-ink">{t("rehearsal.run.personas")}</legend>
            <div className="flex flex-wrap gap-x-4 gap-y-2">
              {active.map((p) => (
                <label key={p.id} className="flex items-center gap-2 text-sm text-ink">
                  <input type="checkbox" className="size-4" checked={picked.includes(p.id)} onChange={(e) => (setPicked((xs) => (e.target.checked ? [...xs, p.id] : xs.filter((x) => x !== p.id))), setEstimate(null))} />
                  {p.name}
                  {!p.calibrated ? <span className="text-xs text-muted">({t("rehearsal.personas.uncalibrated")})</span> : null}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="flex flex-wrap items-end gap-4">
            <label className={labelClass}>
              {t("rehearsal.run.stepCap")}
              <input type="number" min={2} max={15} value={stepCap} onChange={(e) => (setStepCap(e.target.value), setEstimate(null))} className={`${inputClass} w-24`} />
            </label>
            <button type="button" disabled={busy !== null || picked.length === 0} onClick={() => void estimateRun()} className={aosButton({ variant: "secondary", size: "md" })}>
              {busy === "estimate" ? t("rehearsal.run.estimating") : t("rehearsal.run.estimate")}
            </button>
          </div>
          {estimate ? (
            <>
              <p className="font-mono text-sm text-muted">{estimate.formula}</p>
              <CapConfirm idPrefix="run" estimate={estimate.total} cap={cap} setCap={setCap} confirmed={confirmed} setConfirmed={setConfirmed} />
              <button type="button" disabled={busy !== null || !confirmed || Number(cap) < 1} onClick={() => void start()} className={aosButton({ size: "md", className: "self-start" })}>
                <Footprints className="size-4" aria-hidden />
                {busy === "start" ? t("rehearsal.run.starting") : t("rehearsal.run.start")}
              </button>
            </>
          ) : null}
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

function Runs({ runs, calibration, onOpen, openRun }: { runs: RunView[]; calibration: CalibrationSummary; onOpen: (id: string) => void; openRun: string | null }) {
  const { t, format } = useI18n();
  return (
    <section aria-labelledby="rh-runs" className={cardClass}>
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="rh-runs" className="aos-subheading min-w-0 flex-1">
          {t("rehearsal.runs.title")}
        </h2>
        <span className="text-sm text-muted">
          {calibration.score === null ? t("rehearsal.track.noScore") : t("rehearsal.track.score", { score: (calibration.score * 100).toFixed(1), count: calibration.launches })}
        </span>
      </div>
      {runs.length === 0 ? (
        <p className="text-sm text-muted">{t("rehearsal.runs.empty")}</p>
      ) : (
        <div className="-mx-1 overflow-x-auto">
          <table className="w-full min-w-[40rem] border-collapse text-left text-sm">
            <caption className="sr-only">{t("rehearsal.runs.title")}</caption>
            <thead>
              <tr className="border-b border-line text-xs text-muted">
                <th scope="col" className="px-2 py-2 font-semibold">{t("rehearsal.runs.cols.page")}</th>
                <th scope="col" className="px-2 py-2 font-semibold">{t("rehearsal.runs.cols.status")}</th>
                <th scope="col" className="px-2 py-2 font-semibold">{t("rehearsal.runs.cols.credits")}</th>
                <th scope="col" className="px-2 py-2 font-semibold">{t("rehearsal.runs.cols.started")}</th>
                <th scope="col" className="px-2 py-2">
                  <span className="sr-only">{t("rehearsal.runs.open")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} className={`border-b border-line last:border-b-0 hover:bg-hover-paper ${openRun === r.id ? "bg-hover-paper" : ""}`}>
                  <td className="px-2 py-2.5 font-semibold text-ink">{r.targetLabel}</td>
                  <td className="px-2 py-2.5">
                    <NeutralBadge size="sm" label={t(`rehearsal.runs.statuses.${r.status}` as MessageKey)} />
                  </td>
                  <td className="px-2 py-2.5 text-muted">{t("rehearsal.runs.credits", { spent: r.spentCredits, cap: r.capCredits })}</td>
                  <td className="px-2 py-2.5 text-muted" suppressHydrationWarning>
                    {format.date(r.createdAt, "dateTime")}
                  </td>
                  <td className="px-2 py-2.5 text-right">
                    <button type="button" onClick={() => onOpen(r.id)} className={aosButton({ variant: "secondary", size: "xs" })}>
                      {t("rehearsal.runs.open")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
