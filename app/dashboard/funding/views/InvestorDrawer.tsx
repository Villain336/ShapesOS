// Marketr — Funding/VC slice 2: investor detail drawer (client).
// Profile + enrichment (manual entry, self-reported vs enriched provenance),
// stage transitions, interaction timeline + log form, follow-up reminders.
// Agentic OS design system: tokens only, black primary actions, Lucide
// icons only, sentence case.

"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ArrowRight,
  CalendarClock,
  Check,
  History,
  Loader2,
  Pencil,
  User,
  X,
} from "lucide-react";
import { STAGE_LABELS } from "./PipelineView";

// Legal transitions mirrored from lib/funding/types.ts (STAGE_TRANSITIONS).
// The server is the authority — these only choose which buttons to render.
const STAGE_TRANSITIONS: Record<string, string[]> = {
  target: ["contacted", "lost", "passed"],
  contacted: ["meeting", "target", "lost", "passed"],
  meeting: ["diligence", "contacted", "lost", "passed"],
  diligence: ["term_sheet", "meeting", "lost", "passed"],
  term_sheet: ["won", "diligence", "lost", "passed"],
  won: [],
  lost: ["target"],
  passed: ["target"],
};

const INTERACTION_KIND_LABELS: Record<string, string> = {
  email: "Email",
  call: "Call",
  meeting: "Meeting",
  intro: "Intro",
  deck_sent: "Deck sent",
  note: "Note",
  stage_change: "Stage change",
};

interface DetailInvestor {
  id: string;
  name: string;
  firm: string | null;
  title: string | null;
  email: string | null;
  checkSizeMin: number | null;
  checkSizeMax: number | null;
  stages: string[];
  sectors: string[];
  thesisFit: string | null;
  enrichmentSource: string;
  enrichmentFetchedAt: string | null;
  enrichmentNotes: string | null;
  stage: string;
  source: string | null;
}

interface DetailInteraction {
  id: string;
  occurredAt: string;
  kind: string;
  summary: string;
  actor: string | null;
  contactName: string | null;
}

interface DetailFollowUp {
  id: string;
  dueAt: string;
  note: string;
  done: boolean;
  doneAt: string | null;
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function inputClass() {
  return "h-11 w-full rounded-md border-[1.5px] border-control bg-white px-3 text-[0.9375rem] text-ink";
}

export function InvestorDrawer({
  investorId,
  onClose,
  onChanged,
}: {
  investorId: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [investor, setInvestor] = useState<DetailInvestor | null>(null);
  const [interactions, setInteractions] = useState<DetailInteraction[]>([]);
  const [followUps, setFollowUps] = useState<DetailFollowUp[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [editing, setEditing] = useState(false);
  const [enrich, setEnrich] = useState({
    firm: "",
    title: "",
    email: "",
    checkSizeMin: "",
    checkSizeMax: "",
    stages: "",
    sectors: "",
    thesisFit: "",
    enrichmentSource: "self_reported",
    enrichmentFetchedAt: "",
    enrichmentNotes: "",
  });

  const [logForm, setLogForm] = useState({
    kind: "call",
    summary: "",
    occurredAt: "",
  });

  const [followUpForm, setFollowUpForm] = useState({ dueAt: "", note: "" });

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/funding/investors/${investorId}`);
    if (res.ok) {
      const json = await res.json();
      setInvestor(json.investor);
      setInteractions(json.interactions ?? []);
      setFollowUps(json.followUps ?? []);
      const inv = json.investor as DetailInvestor;
      setEnrich({
        firm: inv.firm ?? "",
        title: inv.title ?? "",
        email: inv.email ?? "",
        checkSizeMin: inv.checkSizeMin != null ? String(inv.checkSizeMin) : "",
        checkSizeMax: inv.checkSizeMax != null ? String(inv.checkSizeMax) : "",
        stages: (inv.stages ?? []).join(", "),
        sectors: (inv.sectors ?? []).join(", "),
        thesisFit: inv.thesisFit ?? "",
        enrichmentSource: inv.enrichmentSource ?? "self_reported",
        enrichmentFetchedAt: inv.enrichmentFetchedAt
          ? inv.enrichmentFetchedAt.slice(0, 10)
          : "",
        enrichmentNotes: inv.enrichmentNotes ?? "",
      });
    } else {
      setError("Could not load the investor. Close and try again.");
    }
    setLoading(false);
  }, [investorId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const apiCall = async (
    url: string,
    method: string,
    body?: unknown,
  ): Promise<boolean> => {
    setBusy(true);
    setError(null);
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const json = await res.json().catch(() => null);
      setError(json?.error ?? "Something went wrong. Try again.");
      setBusy(false);
      return false;
    }
    await refresh();
    onChanged();
    setBusy(false);
    return true;
  };

  const transition = (stage: string) =>
    apiCall(`/api/funding/investors/${investorId}/stage`, "POST", { stage });

  const saveEnrichment = async () => {
    const ok = await apiCall(
      `/api/funding/investors/${investorId}`,
      "PATCH",
      {
        firm: enrich.firm || null,
        title: enrich.title || null,
        email: enrich.email || null,
        checkSizeMin: enrich.checkSizeMin ? Number(enrich.checkSizeMin) : null,
        checkSizeMax: enrich.checkSizeMax ? Number(enrich.checkSizeMax) : null,
        stages: enrich.stages.split(",").map((s) => s.trim()).filter(Boolean),
        sectors: enrich.sectors.split(",").map((s) => s.trim()).filter(Boolean),
        thesisFit: enrich.thesisFit || null,
        enrichmentSource: enrich.enrichmentSource || null,
        enrichmentFetchedAt: enrich.enrichmentFetchedAt || null,
        enrichmentNotes: enrich.enrichmentNotes || null,
      },
    );
    if (ok) setEditing(false);
  };

  const logInteraction = async () => {
    const ok = await apiCall(
      `/api/funding/investors/${investorId}/interactions`,
      "POST",
      {
        kind: logForm.kind,
        summary: logForm.summary,
        occurredAt: logForm.occurredAt || null,
      },
    );
    if (ok) setLogForm({ kind: "call", summary: "", occurredAt: "" });
  };

  const addFollowUp = async () => {
    const ok = await apiCall(
      `/api/funding/investors/${investorId}/follow-ups`,
      "POST",
      { dueAt: followUpForm.dueAt, note: followUpForm.note },
    );
    if (ok) setFollowUpForm({ dueAt: "", note: "" });
  };

  const completeFollowUp = (id: string) =>
    apiCall(`/api/funding/follow-ups/${id}/complete`, "POST");

  const provenanceBadge =
    investor?.enrichmentSource === "enriched" ? (
      <span className="rounded-full bg-canvas px-2 py-0.5 text-[0.6875rem] font-semibold text-muted">
        Enriched · fetched {formatDate(investor.enrichmentFetchedAt)}
      </span>
    ) : (
      <span className="rounded-full bg-canvas px-2 py-0.5 text-[0.6875rem] font-semibold text-muted">
        Self-reported
      </span>
    );

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end"
      role="dialog"
      aria-modal="true"
      aria-label="Investor details"
    >
      <div
        className="absolute inset-0 bg-black/40"
        onClick={onClose}
        aria-hidden
      />
      <div className="relative flex h-full w-full max-w-[520px] flex-col overflow-y-auto bg-canvas p-4 shadow-overlay md:p-6">
        <div className="mb-4 flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <User size={16} className="shrink-0 text-ink" />
              <h2
                className="truncate text-[1.5rem] font-bold text-ink"
                style={{ fontStretch: "115%", fontWeight: 750 }}
              >
                {investor?.name ?? "Investor"}
              </h2>
            </div>
            {investor && (
              <div className="mt-1 flex flex-wrap items-center gap-2 text-[0.8125rem] text-muted">
                <span>
                  {[investor.firm, investor.title].filter(Boolean).join(" · ") ||
                    "No firm on file"}
                </span>
                {provenanceBadge}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close investor details"
            className="aos-press flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-paper text-ink shadow-hairline"
          >
            <X size={16} />
          </button>
        </div>

        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted">
            <Loader2 size={16} className="animate-spin" />
            Loading
          </div>
        ) : (
          !investor
        ) ? (
          <p className="text-sm text-muted">Investor not found.</p>
        ) : (
          <div className="flex flex-col gap-4">
            {error && (
              <p
                role="alert"
                className="rounded-lg bg-paper p-3 text-[0.8125rem] font-semibold text-failed-text shadow-hairline"
              >
                {error}
              </p>
            )}

            {/* Stage */}
            <section
              aria-label="Pipeline stage"
              className="rounded-lg bg-paper p-4 shadow-hairline"
            >
              <div className="mb-2 flex items-center justify-between">
                <h3
                  className="text-[1.125rem] font-bold text-ink"
                  style={{ fontStretch: "115%" }}
                >
                  Stage
                </h3>
                <span className="rounded-full bg-black px-2.5 py-1 text-[0.75rem] font-semibold text-white">
                  {STAGE_LABELS[investor.stage] ?? investor.stage}
                </span>
              </div>
              <p className="mb-3 text-[0.8125rem] text-muted">
                Move only through legal steps — every move is recorded with
                who made it and when.
              </p>
              <div className="flex flex-wrap gap-2">
                {(STAGE_TRANSITIONS[investor.stage] ?? []).map((next) => (
                  <button
                    key={next}
                    type="button"
                    disabled={busy}
                    onClick={() => void transition(next)}
                    className="aos-press flex h-9 items-center gap-1 rounded-full bg-black px-3.5 text-[0.8125rem] font-semibold text-white disabled:opacity-50"
                  >
                    Move to {STAGE_LABELS[next] ?? next}
                    <ArrowRight size={13} />
                  </button>
                ))}
                {(STAGE_TRANSITIONS[investor.stage] ?? []).length === 0 && (
                  <p className="text-[0.8125rem] text-muted">
                    This stage is terminal — the deal is done.
                  </p>
                )}
              </div>
            </section>

            {/* Enrichment */}
            <section
              aria-label="Contact enrichment"
              className="rounded-lg bg-paper p-4 shadow-hairline"
            >
              <div className="mb-2 flex items-center justify-between">
                <h3
                  className="text-[1.125rem] font-bold text-ink"
                  style={{ fontStretch: "115%" }}
                >
                  Enrichment
                </h3>
                <button
                  type="button"
                  onClick={() => setEditing((v) => !v)}
                  className="aos-press flex h-9 items-center gap-1.5 rounded-full bg-white px-3 text-[0.8125rem] font-semibold text-ink shadow-control"
                >
                  <Pencil size={13} />
                  {editing ? "Cancel" : "Edit"}
                </button>
              </div>
              {!editing ? (
                <dl className="grid gap-2 text-[0.8125rem]">
                  <div className="flex gap-2">
                    <dt className="w-28 shrink-0 font-semibold text-ink">Email</dt>
                    <dd className="text-muted">
                      {investor.email ?? "—"}
                    </dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="w-28 shrink-0 font-semibold text-ink">Check size</dt>
                    <dd className="text-muted">
                      {investor.checkSizeMin != null || investor.checkSizeMax != null
                        ? `$${(investor.checkSizeMin ?? 0).toLocaleString()} – $${(investor.checkSizeMax ?? 0).toLocaleString()}`
                        : "—"}
                    </dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="w-28 shrink-0 font-semibold text-ink">Stages</dt>
                    <dd className="text-muted">
                      {investor.stages.length ? investor.stages.join(", ") : "—"}
                    </dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="w-28 shrink-0 font-semibold text-ink">Sectors</dt>
                    <dd className="text-muted">
                      {investor.sectors.length ? investor.sectors.join(", ") : "—"}
                    </dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="w-28 shrink-0 font-semibold text-ink">Thesis fit</dt>
                    <dd className="text-muted">{investor.thesisFit ?? "—"}</dd>
                  </div>
                  {investor.enrichmentNotes && (
                    <div className="flex gap-2">
                      <dt className="w-28 shrink-0 font-semibold text-ink">Notes</dt>
                      <dd className="text-muted">{investor.enrichmentNotes}</dd>
                    </div>
                  )}
                </dl>
              ) : (
                <div className="flex flex-col gap-3">
                  <div className="grid gap-3 md:grid-cols-2">
                    <label className="flex flex-col gap-1">
                      <span className="text-[0.8125rem] font-semibold text-ink">Firm</span>
                      <input
                        value={enrich.firm}
                        onChange={(e) => setEnrich((f) => ({ ...f, firm: e.target.value }))}
                        className={inputClass()}
                      />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="text-[0.8125rem] font-semibold text-ink">Title</span>
                      <input
                        value={enrich.title}
                        onChange={(e) => setEnrich((f) => ({ ...f, title: e.target.value }))}
                        className={inputClass()}
                      />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="text-[0.8125rem] font-semibold text-ink">Email</span>
                      <input
                        value={enrich.email}
                        onChange={(e) => setEnrich((f) => ({ ...f, email: e.target.value }))}
                        className={inputClass()}
                      />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="text-[0.8125rem] font-semibold text-ink">
                        Check size min / max (USD)
                      </span>
                      <div className="flex gap-2">
                        <input
                          value={enrich.checkSizeMin}
                          onChange={(e) => setEnrich((f) => ({ ...f, checkSizeMin: e.target.value }))}
                          placeholder="25000"
                          inputMode="numeric"
                          className={inputClass()}
                        />
                        <input
                          value={enrich.checkSizeMax}
                          onChange={(e) => setEnrich((f) => ({ ...f, checkSizeMax: e.target.value }))}
                          placeholder="250000"
                          inputMode="numeric"
                          className={inputClass()}
                        />
                      </div>
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="text-[0.8125rem] font-semibold text-ink">
                        Stages (comma separated)
                      </span>
                      <input
                        value={enrich.stages}
                        onChange={(e) => setEnrich((f) => ({ ...f, stages: e.target.value }))}
                        placeholder="pre-seed, seed"
                        className={inputClass()}
                      />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="text-[0.8125rem] font-semibold text-ink">
                        Sectors (comma separated)
                      </span>
                      <input
                        value={enrich.sectors}
                        onChange={(e) => setEnrich((f) => ({ ...f, sectors: e.target.value }))}
                        placeholder="fintech, dev-tools"
                        className={inputClass()}
                      />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="text-[0.8125rem] font-semibold text-ink">
                        Enrichment source
                      </span>
                      <select
                        value={enrich.enrichmentSource}
                        onChange={(e) => setEnrich((f) => ({ ...f, enrichmentSource: e.target.value }))}
                        className={inputClass()}
                      >
                        <option value="self_reported">Self-reported</option>
                        <option value="enriched">Enriched</option>
                      </select>
                    </label>
                    {enrich.enrichmentSource === "enriched" && (
                      <label className="flex flex-col gap-1">
                        <span className="text-[0.8125rem] font-semibold text-ink">
                          Fetched at
                        </span>
                        <input
                          type="date"
                          value={enrich.enrichmentFetchedAt}
                          onChange={(e) => setEnrich((f) => ({ ...f, enrichmentFetchedAt: e.target.value }))}
                          className={inputClass()}
                        />
                      </label>
                    )}
                  </div>
                  <label className="flex flex-col gap-1">
                    <span className="text-[0.8125rem] font-semibold text-ink">Thesis fit</span>
                    <textarea
                      value={enrich.thesisFit}
                      onChange={(e) => setEnrich((f) => ({ ...f, thesisFit: e.target.value }))}
                      rows={2}
                      className="w-full rounded-md border-[1.5px] border-control bg-white px-3 py-2 text-[0.9375rem] text-ink"
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-[0.8125rem] font-semibold text-ink">
                      Enrichment notes
                    </span>
                    <textarea
                      value={enrich.enrichmentNotes}
                      onChange={(e) => setEnrich((f) => ({ ...f, enrichmentNotes: e.target.value }))}
                      rows={2}
                      className="w-full rounded-md border-[1.5px] border-control bg-white px-3 py-2 text-[0.9375rem] text-ink"
                    />
                  </label>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void saveEnrichment()}
                    className="aos-press flex h-11 w-fit items-center rounded-full bg-black px-5 text-[0.875rem] font-semibold text-white disabled:opacity-50"
                  >
                    Save enrichment
                  </button>
                </div>
              )}
            </section>

            {/* Follow-ups */}
            <section
              aria-label="Follow-ups"
              className="rounded-lg bg-paper p-4 shadow-hairline"
            >
              <div className="mb-2 flex items-center gap-2">
                <CalendarClock size={15} className="text-ink" />
                <h3
                  className="text-[1.125rem] font-bold text-ink"
                  style={{ fontStretch: "115%" }}
                >
                  Follow-ups
                </h3>
              </div>
              {followUps.length === 0 ? (
                <p className="mb-3 text-[0.8125rem] text-muted">
                  No follow-ups yet. Due ones surface through your alert rules.
                </p>
              ) : (
                <ul className="mb-3 flex flex-col gap-2">
                  {followUps.map((f) => (
                    <li
                      key={f.id}
                      className={`flex items-start gap-2 rounded-sm p-2 ${
                        f.done ? "bg-canvas opacity-60" : "bg-canvas"
                      }`}
                    >
                      {!f.done ? (
                        <button
                          type="button"
                          onClick={() => void completeFollowUp(f.id)}
                          aria-label={`Mark follow-up done: ${f.note}`}
                          className="aos-press mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-[1.5px] border-control bg-white"
                        />
                      ) : (
                        <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-black text-white">
                          <Check size={13} />
                        </span>
                      )}
                      <div className="min-w-0">
                        <div
                          className={`text-[0.875rem] font-semibold text-ink ${
                            f.done ? "line-through" : ""
                          }`}
                        >
                          {f.note}
                        </div>
                        <div className="text-[0.75rem] text-muted">
                          Due {formatDate(f.dueAt)}
                          {f.done && f.doneAt
                            ? ` · done ${formatDate(f.doneAt)}`
                            : ""}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              <div className="grid gap-2 md:grid-cols-2">
                <label className="flex flex-col gap-1">
                  <span className="text-[0.8125rem] font-semibold text-ink">Due date</span>
                  <input
                    type="date"
                    value={followUpForm.dueAt}
                    onChange={(e) =>
                      setFollowUpForm((f) => ({ ...f, dueAt: e.target.value }))
                    }
                    className={inputClass()}
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[0.8125rem] font-semibold text-ink">Note</span>
                  <input
                    value={followUpForm.note}
                    onChange={(e) =>
                      setFollowUpForm((f) => ({ ...f, note: e.target.value }))
                    }
                    placeholder="Send the deck"
                    className={inputClass()}
                  />
                </label>
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={() => void addFollowUp()}
                className="aos-press mt-2 flex h-10 w-fit items-center rounded-full bg-black px-4 text-[0.875rem] font-semibold text-white disabled:opacity-50"
              >
                Add follow-up
              </button>
            </section>

            {/* Interaction timeline */}
            <section
              aria-label="Interaction history"
              className="rounded-lg bg-paper p-4 shadow-hairline"
            >
              <div className="mb-2 flex items-center gap-2">
                <History size={15} className="text-ink" />
                <h3
                  className="text-[1.125rem] font-bold text-ink"
                  style={{ fontStretch: "115%" }}
                >
                  History
                </h3>
              </div>
              {interactions.length === 0 ? (
                <p className="mb-3 text-[0.8125rem] text-muted">
                  Nothing recorded yet.
                </p>
              ) : (
                <ol className="mb-4 flex flex-col gap-2">
                  {interactions.map((i) => (
                    <li key={i.id} className="flex gap-3">
                      <div className="flex flex-col items-center">
                        <span
                          aria-hidden
                          className="mt-1.5 h-2 w-2 rounded-full bg-black"
                        />
                        <span aria-hidden className="w-px flex-1 bg-canvas" />
                      </div>
                      <div className="min-w-0 pb-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="rounded-full bg-canvas px-2 py-0.5 text-[0.6875rem] font-semibold text-ink">
                            {INTERACTION_KIND_LABELS[i.kind] ?? i.kind}
                          </span>
                          <span className="text-[0.75rem] text-muted">
                            {formatDate(i.occurredAt)}
                            {i.actor ? ` · ${i.actor}` : ""}
                            {i.contactName ? ` · via ${i.contactName}` : ""}
                          </span>
                        </div>
                        <p className="mt-1 text-[0.875rem] text-ink">{i.summary}</p>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
              <div className="grid gap-2">
                <div className="grid gap-2 md:grid-cols-2">
                  <label className="flex flex-col gap-1">
                    <span className="text-[0.8125rem] font-semibold text-ink">Kind</span>
                    <select
                      value={logForm.kind}
                      onChange={(e) =>
                        setLogForm((f) => ({ ...f, kind: e.target.value }))
                      }
                      className={inputClass()}
                    >
                      <option value="call">Call</option>
                      <option value="email">Email</option>
                      <option value="meeting">Meeting</option>
                      <option value="intro">Intro</option>
                      <option value="deck_sent">Deck sent</option>
                      <option value="note">Note</option>
                    </select>
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-[0.8125rem] font-semibold text-ink">
                      Date (optional)
                    </span>
                    <input
                      type="date"
                      value={logForm.occurredAt}
                      onChange={(e) =>
                        setLogForm((f) => ({ ...f, occurredAt: e.target.value }))
                      }
                      className={inputClass()}
                    />
                  </label>
                </div>
                <label className="flex flex-col gap-1">
                  <span className="text-[0.8125rem] font-semibold text-ink">Summary</span>
                  <textarea
                    value={logForm.summary}
                    onChange={(e) =>
                      setLogForm((f) => ({ ...f, summary: e.target.value }))
                    }
                    rows={2}
                    placeholder="What happened"
                    className="w-full rounded-md border-[1.5px] border-control bg-white px-3 py-2 text-[0.9375rem] text-ink"
                  />
                </label>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void logInteraction()}
                  className="aos-press flex h-10 w-fit items-center rounded-full bg-black px-4 text-[0.875rem] font-semibold text-white disabled:opacity-50"
                >
                  Log interaction
                </button>
              </div>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
