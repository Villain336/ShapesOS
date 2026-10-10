"use client";

// ShapesOS — Phase 21A round 2 (WS=agentweb): one research session.
//
// Answers with claim-level citations, the pages you added, your notes, the agent's progress, the
// receipts behind every source, "Clip to…" into other apps, share and export. A claim no stored
// snippet supports stays marked unsupported. A reader who is not the owner sees the web research
// but never the owner's private workspace records (the server leaves them out; this screen says so).
// Neutral badges only: colour and shape are for agent states (DESIGN.md).

import { useCallback, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Download, FileDown, Loader2, Plus, Send, Trash2 } from "lucide-react";
import { aosButton, NeutralBadge, StatusBadge } from "@/components/aos";
import { SwitchRow } from "@/components/aos/Controls";
import { useI18n } from "@/components/i18n/I18nProvider";
import { confirmAction, toast, toastError } from "@/lib/ui/feedback";
import type { MessageKey } from "@/lib/i18n";
import type { ResearchView, ViewAnswer } from "@/lib/agentweb/research/view";
import type { SessionView } from "@/lib/agentweb/sessions/store";
import { statusLabelKey } from "@/components/sessions/SessionsPanel";

export interface ResearchDetailProps {
  initial: ResearchView;
  progress: SessionView | null;
  sessions: Array<{ runId: string; label: string }>;
  canEdit: boolean;
}

type Api<T> = { ok: true; status: number; data: T } | { ok: false; status: number; data: T & { error?: string } };

async function call<T = Record<string, unknown>>(url: string, body?: Record<string, unknown>): Promise<Api<T>> {
  try {
    const res = await fetch(url, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : { cache: "no-store" });
    const data = (await res.json().catch(() => ({}))) as T & { error?: string };
    return { ok: res.ok, status: res.status, data } as Api<T>;
  } catch {
    return { ok: false, status: 0, data: { error: "Network error" } as T & { error?: string } };
  }
}

export function ResearchDetail({ initial, progress: initialProgress, sessions, canEdit }: ResearchDetailProps) {
  const { t, format } = useI18n();
  const router = useRouter();
  const [v, setV] = useState(initial);
  const [progress, setProgress] = useState(initialProgress);
  const [busy, setBusy] = useState<string | null>(null);
  const [follow, setFollow] = useState("");
  const [address, setAddress] = useState("");
  const [pageNote, setPageNote] = useState<string | null>(null);
  const [notes, setNotes] = useState(initial.notes);
  const [title, setTitle] = useState(initial.title);
  const [pickRun, setPickRun] = useState("");
  const [withWorkspace, setWithWorkspace] = useState(false);
  const [contact, setContact] = useState({ name: "", email: "" });
  const [showContact, setShowContact] = useState(false);
  const owner = v.owner;

  const reload = useCallback(async () => {
    const r = await call<{ research: ResearchView; progress: SessionView | null }>(`/api/agentweb/research/${v.id}`);
    if (r.ok) {
      setV(r.data.research);
      setProgress(r.data.progress);
      setNotes(r.data.research.notes);
    }
  }, [v.id]);

  async function op(label: string, body: Record<string, unknown>): Promise<Api<Record<string, unknown>>> {
    setBusy(label);
    try {
      const r = await call<Record<string, unknown>>("/api/agentweb/research", { ...body, id: v.id });
      if (!r.ok) toastError(t("researchApp.detail.failed"), String((r.data as { error?: string }).error ?? ""));
      else if (r.data.research && typeof r.data.research === "object" && "answers" in r.data.research) {
        setV(r.data.research as ResearchView);
        setNotes((r.data.research as ResearchView).notes);
      }
      return r;
    } finally {
      setBusy(null);
    }
  }

  async function ask(q: string) {
    const text = q.trim();
    if (text.length < 3 || busy) return;
    setBusy("ask");
    try {
      const r = await call<{ attached?: { researchId?: string; error?: string }; error?: string }>("/api/answer", { question: text, researchId: v.id });
      if (!r.ok) return toastError(t("researchApp.detail.failed"), r.data.error);
      setFollow("");
      if (r.data.attached && "error" in r.data.attached && r.data.attached.error) toastError(t("researchApp.detail.attachFailed", { error: r.data.attached.error }));
      else toast({ title: t("researchApp.detail.attached"), status: "done" });
      await reload();
    } finally {
      setBusy(null);
    }
  }

  async function addPage() {
    if (!address.trim() || busy) return;
    setPageNote(null);
    const r = await op("page", { op: "attach_page", url: address.trim() });
    if (r.ok) {
      setAddress("");
      setPageNote(t(r.data.remembered ? "researchApp.detail.pageAddedRemembered" : "researchApp.detail.pageAdded"));
      return;
    }
    const outcome = (r.data as { outcome?: { kind?: string; reason?: string } }).outcome;
    if (outcome?.kind) setPageNote(t(`researchApp.detail.outcome.${outcome.kind in OUTCOMES ? outcome.kind : "error"}` as MessageKey, { reason: outcome.reason ?? "" }));
  }

  async function clip(target: string, extra: Record<string, unknown> = {}) {
    const r = await op(`clip:${target}:${String(extra.url ?? "")}`, { op: "clip", target, ...extra });
    if (r.ok) toast({ title: t("researchApp.detail.clipDone", { summary: String((r.data as { summary?: string }).summary ?? "") }), status: "done" });
  }

  const redactedNote = v.workspaceHidden && (!owner || !withWorkspace);

  return (
    <div className="flex flex-col gap-6">
      <div className="min-w-0">
        <Link href="/dashboard/research" className="inline-flex items-center gap-1 text-sm text-muted hover:text-ink">
          <ArrowLeft className="size-4" aria-hidden />
          {t("researchApp.detail.back")}
        </Link>
        <div className="mt-1 flex flex-wrap items-center gap-3">
          {owner ? (
            <>
              <label className="sr-only" htmlFor="rs-title">{t("researchApp.detail.rename")}</label>
              <input
                id="rs-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onBlur={() => {
                  if (title.trim() && title.trim() !== v.title) void op("title", { op: "update", patch: { title } });
                }}
                maxLength={160}
                className="aos-heading min-w-[16rem] flex-1 rounded-md border-[1.5px] border-transparent bg-transparent px-1 hover:border-control focus:border-focus focus:outline-none"
              />
            </>
          ) : (
            <h1 className="aos-heading">{v.title}</h1>
          )}
          <NeutralBadge label={t(`researchApp.list.sharing.${v.shareState === "workspace" ? "workspace" : "private"}` as MessageKey)} size="sm" />
          {v.status === "archived" ? <NeutralBadge label={t("researchApp.list.archived")} size="sm" /> : null}
        </div>
        <p className="mt-1 max-w-[72ch] text-md text-muted"><span className="font-semibold text-ink">{t("researchApp.detail.question")}:</span> {v.question}</p>
      </div>

      {!owner ? <p className="rounded-md border border-line bg-canvas px-3 py-2 text-sm text-muted" role="note">{t("researchApp.detail.readOnly")}</p> : null}
      {redactedNote ? <p className="rounded-md border border-line bg-canvas px-3 py-2 text-sm text-muted" role="note">{t("researchApp.detail.workspaceHidden")}</p> : null}

      <section aria-labelledby="rs-export" className="flex flex-col gap-2 rounded-lg bg-paper p-4 shadow-hairline sm:p-5">
        <h2 id="rs-export" className="aos-subheading">{t("researchApp.detail.exportMd")}</h2>
        <p className="max-w-[72ch] text-sm text-muted">{t("researchApp.detail.exportHelp")}</p>
        {owner ? (
          <label className="flex items-center gap-2 text-sm text-ink">
            <input type="checkbox" checked={withWorkspace} onChange={(e) => setWithWorkspace(e.target.checked)} className="size-4 accent-[var(--aos-ink)]" />
            {t("researchApp.detail.exportWorkspace")}
          </label>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <a href={`/api/agentweb/research/${v.id}/export?format=md${owner && withWorkspace ? "&workspace=1" : ""}`} download className={aosButton({ variant: "secondary", size: "sm" })}>
            <FileDown className="size-4" aria-hidden />
            {t("researchApp.detail.exportMd")}
          </a>
          <a href={`/api/agentweb/research/${v.id}/export?format=json${owner && withWorkspace ? "&workspace=1" : ""}`} download className={aosButton({ variant: "secondary", size: "sm" })}>
            <Download className="size-4" aria-hidden />
            {t("researchApp.detail.exportJson")}
          </a>
        </div>
      </section>

      {owner ? (
        <div className="flex flex-col divide-y divide-line rounded-lg bg-paper shadow-hairline">
          <SwitchRow title={t("researchApp.detail.share")} description={canEdit ? t("researchApp.detail.shareHelp") : t("researchApp.detail.shareNeedsEditor")} checked={v.shareState === "workspace"} disabled={!canEdit || busy !== null} onChange={(on) => void op("share", { op: "update", patch: { shareState: on ? "workspace" : "private" } })} />
          <div className="flex flex-wrap gap-2 px-4 py-3">
            <button type="button" disabled={busy !== null} onClick={() => void op("archive", { op: "update", patch: { status: v.status === "archived" ? "open" : "archived" } })} className={aosButton({ variant: "secondary", size: "sm" })}>
              {v.status === "archived" ? t("researchApp.detail.unarchive") : t("researchApp.detail.archive")}
            </button>
            <button
              type="button"
              disabled={busy !== null}
              onClick={async () => {
                if (!(await confirmAction({ title: t("researchApp.detail.removeConfirm"), confirmLabel: t("researchApp.detail.remove"), destructive: true }))) return;
                const r = await op("remove", { op: "remove" });
                if (r.ok) router.push("/dashboard/research");
              }}
              className={aosButton({ variant: "deny", size: "sm" })}
            >
              <Trash2 className="size-4" aria-hidden />
              {t("researchApp.detail.remove")}
            </button>
          </div>
        </div>
      ) : null}

      {owner && v.status !== "archived" ? (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void ask(follow);
          }}
        >
          <label className="block min-w-[16rem] flex-1">
            <span className="mb-1 block text-sm font-semibold text-ink">{t("researchApp.detail.followUp")}</span>
            <input value={follow} onChange={(e) => setFollow(e.target.value)} maxLength={500} placeholder={t("researchApp.detail.followUpPlaceholder")} className="h-control w-full rounded-md border-[1.5px] border-control bg-paper px-3 text-md text-ink outline-none placeholder:text-subtle focus:border-focus focus:shadow-[0_0_0_3px_var(--aos-focus-halo)]" />
          </label>
          <button type="submit" disabled={busy !== null || follow.trim().length < 3} className={aosButton({ variant: "primary", size: "md" })}>
            {busy === "ask" ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Send className="size-4" aria-hidden />}
            {busy === "ask" ? t("researchApp.detail.asking") : t("researchApp.detail.ask")}
          </button>
        </form>
      ) : null}

      <section aria-labelledby="rs-answers" className="flex flex-col gap-3">
        <h2 id="rs-answers" className="aos-subheading">{t("researchApp.detail.answers")}</h2>
        {v.answers.length === 0 ? <p className="rounded-lg bg-paper p-4 text-md text-muted shadow-hairline">{t("researchApp.detail.noAnswers")}</p> : null}
        {v.answers.map((a) => (
          <AnswerSection key={a.id} a={a} owner={owner} canClip={canEdit} busy={busy} onClip={clip} onFollowUp={(q) => void ask(q)} />
        ))}
      </section>

      <section aria-labelledby="rs-pages" className="flex flex-col gap-2 rounded-lg bg-paper p-4 shadow-hairline sm:p-5">
        <h2 id="rs-pages" className="aos-subheading">{t("researchApp.detail.pages")}</h2>
        {v.pages.length === 0 ? (
          <p className="text-sm text-muted">{t("researchApp.detail.noPages")}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line">
            {v.pages.map((p) => (
              <li key={p.captureId} className="flex flex-col gap-1 py-2">
                <a href={p.url} target="_blank" rel="noopener noreferrer" className="break-all font-mono text-xs font-semibold text-ink underline-offset-2 hover:underline">{p.url}</a>
                <span className="text-sm text-muted">{p.excerpt}</span>
                {canEdit ? (
                  <span className="flex flex-wrap gap-1" role="group" aria-label={t("researchApp.detail.clip")}>
                    <ClipButtons url={p.url} busy={busy} onClip={clip} />
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {owner && v.status !== "archived" ? (
          <form
            className="mt-2 flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void addPage();
            }}
          >
            <label className="block min-w-[16rem] flex-1">
              <span className="mb-1 block text-sm font-semibold text-ink">{t("researchApp.detail.addPage")}</span>
              <input value={address} onChange={(e) => setAddress(e.target.value)} type="url" inputMode="url" maxLength={2000} placeholder={t("researchApp.detail.addPagePlaceholder")} className="h-control w-full rounded-md border-[1.5px] border-control bg-paper px-3 font-mono text-sm text-ink outline-none placeholder:text-subtle focus:border-focus focus:shadow-[0_0_0_3px_var(--aos-focus-halo)]" />
            </label>
            <button type="submit" disabled={busy !== null || !address.trim()} className={aosButton({ variant: "secondary", size: "md" })}>
              {busy === "page" ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Plus className="size-4" aria-hidden />}
              {busy === "page" ? t("researchApp.detail.addingPage") : t("researchApp.detail.addPageButton")}
            </button>
          </form>
        ) : null}
        {pageNote ? <p role="status" className="rounded-md border border-line bg-canvas px-3 py-2 text-sm text-ink">{pageNote}</p> : null}
      </section>

      <section aria-labelledby="rs-notes" className="flex flex-col gap-2 rounded-lg bg-paper p-4 shadow-hairline sm:p-5">
        <h2 id="rs-notes" className="aos-subheading">{t("researchApp.detail.notes")}</h2>
        {owner ? (
          <>
            <label className="sr-only" htmlFor="rs-notes-text">{t("researchApp.detail.notes")}</label>
            <textarea
              id="rs-notes-text"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              onBlur={() => {
                if (notes !== v.notes) void op("notes", { op: "update", patch: { notes } }).then((r) => r.ok && toast({ title: t("researchApp.detail.notesSaved"), status: "done" }));
              }}
              rows={6}
              maxLength={20000}
              placeholder={t("researchApp.detail.notesPlaceholder")}
              className="w-full rounded-md border-[1.5px] border-control bg-paper px-3 py-2 text-md text-ink outline-none placeholder:text-subtle focus:border-focus focus:shadow-[0_0_0_3px_var(--aos-focus-halo)]"
            />
          </>
        ) : (
          <p className="whitespace-pre-wrap text-md text-ink">{v.notes || "—"}</p>
        )}
      </section>

      <section aria-labelledby="rs-progress" className="flex flex-col gap-2 rounded-lg bg-paper p-4 shadow-hairline sm:p-5">
        <h2 id="rs-progress" className="aos-subheading">{t("researchApp.detail.progress")}</h2>
        {progress ? (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              {progress.status ? <StatusBadge status={progress.status} label={t(`sessionsApp.status.${statusLabelKey(progress)}` as MessageKey)} /> : <NeutralBadge label={t(`sessionsApp.status.${statusLabelKey(progress)}` as MessageKey)} />}
              <span className="text-sm text-muted">{t("researchApp.detail.progressStats", { steps: progress.steps, sites: progress.origins.length })}</span>
              <Link href={`/dashboard/runs/sessions/${progress.runId}`} className={aosButton({ variant: "secondary", size: "xs" })}>{t("researchApp.detail.progressOpen")}</Link>
              {owner ? (
                <button type="button" disabled={busy !== null} onClick={() => void op("run", { op: "update", patch: { runId: null } }).then(() => reload())} className={aosButton({ variant: "quiet", size: "xs" })}>{t("researchApp.detail.progressUnlink")}</button>
              ) : null}
            </div>
            {progress.currentUrl ? <p className="break-all font-mono text-xs text-muted">{progress.currentUrl}</p> : null}
          </div>
        ) : (
          <p className="max-w-[72ch] text-sm text-muted">{t("researchApp.detail.progressNone")}</p>
        )}
        {owner && !progress && sessions.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2">
            <label className="sr-only" htmlFor="rs-run">{t("researchApp.detail.progressPick")}</label>
            <select id="rs-run" value={pickRun} onChange={(e) => setPickRun(e.target.value)} className="h-control max-w-[22rem] rounded-md border-[1.5px] border-control bg-paper px-3 text-md text-ink outline-none focus:border-focus focus:shadow-[0_0_0_3px_var(--aos-focus-halo)]">
              <option value="">{t("researchApp.detail.progressPick")}</option>
              {sessions.map((s) => (
                <option key={s.runId} value={s.runId}>{s.label}</option>
              ))}
            </select>
            <button type="button" disabled={busy !== null || !pickRun} onClick={() => void op("run", { op: "update", patch: { runId: pickRun } }).then(() => reload())} className={aosButton({ variant: "secondary", size: "md" })}>{t("researchApp.detail.progressLink")}</button>
          </div>
        ) : null}
      </section>

      {canEdit ? (
        <section aria-labelledby="rs-clip" className="flex flex-col gap-2 rounded-lg bg-paper p-4 shadow-hairline sm:p-5">
          <h2 id="rs-clip" className="aos-subheading">{t("researchApp.detail.clip")}</h2>
          <p className="max-w-[72ch] text-sm text-muted">{t("researchApp.detail.clipHelp")}</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={busy !== null} onClick={() => void clip("note")} className={aosButton({ variant: "secondary", size: "sm" })}>{t("researchApp.detail.clipNote")}</button>
            <button type="button" disabled={busy !== null} onClick={() => void clip("drive")} className={aosButton({ variant: "secondary", size: "sm" })}>{t("researchApp.detail.clipDrive")}</button>
            <button type="button" disabled={busy !== null} aria-expanded={showContact} onClick={() => setShowContact((s) => !s)} className={aosButton({ variant: "secondary", size: "sm" })}>{t("researchApp.detail.clipContact")}</button>
          </div>
          {showContact ? (
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (contact.name.trim()) void clip("contact", { contact }).then(() => setContact({ name: "", email: "" }));
              }}
            >
              <label className="block min-w-[10rem] flex-1">
                <span className="mb-1 block text-sm font-semibold text-ink">{t("researchApp.detail.contactName")}</span>
                <input value={contact.name} onChange={(e) => setContact({ ...contact, name: e.target.value })} maxLength={120} required className="h-control w-full rounded-md border-[1.5px] border-control bg-paper px-3 text-md text-ink outline-none focus:border-focus focus:shadow-[0_0_0_3px_var(--aos-focus-halo)]" />
              </label>
              <label className="block min-w-[10rem] flex-1">
                <span className="mb-1 block text-sm font-semibold text-ink">{t("researchApp.detail.contactEmail")}</span>
                <input value={contact.email} onChange={(e) => setContact({ ...contact, email: e.target.value })} type="email" maxLength={200} className="h-control w-full rounded-md border-[1.5px] border-control bg-paper px-3 text-md text-ink outline-none focus:border-focus focus:shadow-[0_0_0_3px_var(--aos-focus-halo)]" />
              </label>
              <button type="submit" disabled={busy !== null || !contact.name.trim()} className={aosButton({ variant: "primary", size: "md" })}>{t("researchApp.detail.contactSave")}</button>
            </form>
          ) : null}
        </section>
      ) : (
        <p className="text-sm text-muted" role="note">{t("researchApp.detail.clipNeedsEditor")}</p>
      )}

      <section aria-labelledby="rs-receipts" className="flex flex-col gap-2 rounded-lg bg-paper p-4 shadow-hairline sm:p-5">
        <h2 id="rs-receipts" className="aos-subheading">{t("researchApp.detail.receipts")}</h2>
        <p className="text-sm text-muted">{t("researchApp.detail.receiptsHelp")}</p>
        {v.receipts.length === 0 ? (
          <p className="text-sm text-muted">—</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] text-left text-sm">
              <caption className="sr-only">{t("researchApp.detail.receipts")}</caption>
              <thead>
                <tr className="text-xs text-muted">
                  <th scope="col" className="py-2 pr-3 font-semibold">{t("researchApp.detail.source")}</th>
                  <th scope="col" className="py-2 pr-3 font-semibold">{t("researchApp.detail.receipt")}</th>
                  <th scope="col" className="py-2 font-semibold">{t("researchApp.detail.signed")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {v.receipts.map((r) => (
                  <tr key={r.id} className="align-top hover:bg-hover-paper">
                    <td className="max-w-[24rem] py-2 pr-3 font-mono text-xs break-all text-ink">{r.url}<span className="block text-muted">{format.date(r.fetchedAt, "time")}</span></td>
                    <td className="py-2 pr-3 font-mono text-xs break-all text-muted">{r.id}<span className="block">{r.textHash.slice(0, 16)}</span></td>
                    <td className="py-2"><NeutralBadge label={r.alg === "hmac-sha256" && r.signature ? t("researchApp.detail.signed") : t("researchApp.detail.notSigned")} size="sm" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

const OUTCOMES: Record<string, true> = { blocked_by_site: true, payment_required: true, disallowed_by_robots: true, disallowed_by_preference: true, not_html: true, empty: true, unreachable: true };

function ClipButtons({ url, busy, onClip }: { url: string; busy: string | null; onClip: (target: string, extra?: Record<string, unknown>) => Promise<void> }) {
  const { t } = useI18n();
  return (
    <>
      <button type="button" disabled={busy !== null} onClick={() => void onClip("company", { url })} className={aosButton({ variant: "quiet", size: "xs", className: "h-7 px-2.5 text-xs" })}>{t("researchApp.detail.clipCompany")}</button>
      <button type="button" disabled={busy !== null} onClick={() => void onClip("monitor", { url })} className={aosButton({ variant: "quiet", size: "xs", className: "h-7 px-2.5 text-xs" })}>{t("researchApp.detail.clipMonitor")}</button>
      <button type="button" disabled={busy !== null} onClick={() => void onClip("graph", { url })} className={aosButton({ variant: "quiet", size: "xs", className: "h-7 px-2.5 text-xs" })}>{t("researchApp.detail.clipGraph")}</button>
    </>
  );
}

function AnswerSection({ a, owner, canClip, busy, onClip, onFollowUp }: { a: ViewAnswer; owner: boolean; canClip: boolean; busy: string | null; onClip: (target: string, extra?: Record<string, unknown>) => Promise<void>; onFollowUp: (q: string) => void }) {
  const { t } = useI18n();
  const hasWithheld = a.claims.some((c) => c.withheld);
  return (
    <article aria-labelledby={`ans-${a.id}`} className="flex flex-col gap-3 rounded-lg bg-paper p-4 shadow-hairline sm:p-5">
      <h3 id={`ans-${a.id}`} className="text-md font-semibold text-ink">{a.question}</h3>
      <ol className="flex flex-col divide-y divide-line">
        {a.claims.filter((c) => !c.withheld).map((c, i) => (
          <li key={i} className="flex flex-col gap-1 py-2">
            <p className="text-md text-ink">
              {c.text}
              {c.cites.map((id) => (
                <sup key={id} className="ml-0.5 font-semibold">[{id}]</sup>
              ))}
            </p>
            {c.status === "unsupported" ? (
              <p className="flex flex-wrap items-center gap-2 text-sm text-muted">
                <NeutralBadge label={t("researchApp.detail.unsupported")} size="sm" />
                <span>{c.reason ?? ""}</span>
              </p>
            ) : null}
          </li>
        ))}
      </ol>
      {hasWithheld ? <p className="text-xs text-muted">{t("researchApp.detail.withheld")}</p> : null}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[32rem] text-left text-sm">
          <caption className="sr-only">{t("researchApp.detail.sources")}</caption>
          <thead>
            <tr className="text-xs text-muted">
              <th scope="col" className="w-8 py-2 pr-2 font-semibold">#</th>
              <th scope="col" className="py-2 pr-3 font-semibold">{t("researchApp.detail.source")}</th>
              <th scope="col" className="py-2 font-semibold">{t("researchApp.detail.provider")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {a.sources.map((s) => (
              <tr key={s.id} className="align-top hover:bg-hover-paper">
                <td className="py-2 pr-2 font-semibold text-ink">{s.id}</td>
                <td className="py-2 pr-3">
                  {s.redacted ? (
                    <span className="text-muted">{t("researchApp.detail.redacted")}</span>
                  ) : (
                    <>
                      <a href={s.url} {...(/^https?:\/\//i.test(s.url) ? { target: "_blank", rel: "noopener noreferrer" } : {})} className="block max-w-[34ch] truncate font-semibold text-ink underline-offset-2 hover:underline">{s.title}</a>
                      <span className="block truncate font-mono text-xs text-muted">{s.url.replace(/^https?:\/\//, "")}</span>
                      {canClip && /^https?:\/\//i.test(s.url) ? (
                        <span className="mt-1 flex flex-wrap gap-1" role="group" aria-label={t("researchApp.detail.clip")}>
                          <ClipButtons url={s.url} busy={busy} onClip={onClip} />
                        </span>
                      ) : null}
                    </>
                  )}
                </td>
                <td className="py-2">
                  <span className="flex flex-wrap gap-1">
                    {s.providers.map((p) => (
                      <NeutralBadge key={p} label={t(`askApp.sources.providers.${p}` as MessageKey)} size="sm" />
                    ))}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {owner && a.followUps.length ? (
        <div role="group" aria-label={t("researchApp.detail.followUp")} className="flex flex-wrap gap-1.5">
          {a.followUps.map((f) => (
            <button key={f} type="button" disabled={busy !== null} onClick={() => onFollowUp(f)} className={aosButton({ variant: "secondary", size: "xs" })}>{f}</button>
          ))}
        </div>
      ) : null}
    </article>
  );
}
