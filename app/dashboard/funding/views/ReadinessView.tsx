// Marketr — Funding/VC slice 4: round readiness view (client).
// Sections: readiness checklist (with read-only Legal vault cross-links),
// cap table (manual entry + fully-diluted rollups), SAFE template picker
// (information, not advice — the Legal guardrail label ships), and the
// deterministic pitch-deck review. Agentic OS design system: tokens only,
// black primary pills, Lucide icons only, sentence case.

"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  Check,
  ClipboardCheck,
  FileText,
  Loader2,
  Pencil,
  Plus,
  Scale,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { confirmAction } from "@/lib/ui/feedback";

export interface ReadinessItem {
  id: string;
  roundId: string;
  key: string;
  label: string;
  description: string;
  status: "todo" | "doing" | "done" | "waived";
  evidence: {
    links: { label: string; url?: string; legalDocumentId?: string; dataRoomDocId?: string; shareLinkId?: string }[];
    safeTemplateKey?: string;
    safeTemplateParams?: Record<string, string | number | null>;
    testedAt?: string;
    note?: string;
  };
  notes: string | null;
  completedAt: string | null;
  completedBy: string | null;
  legalDocTypes: ("formation" | "ein_letter")[] | null;
  dataRoomKind: "pitch_deck" | "financials" | null;
}

export interface ReadinessSignals {
  legalVault: {
    formationDocs: { id: string; title: string }[];
    einDocs: { id: string; title: string }[];
  };
  dataRoom: {
    pitchDeck: { docId: string; title: string; version: number } | null;
    financials: { docId: string; title: string; version: number } | null;
    shareLinks: { total: number; tested: number };
  };
  capTable: { rowCount: number; totalShares: string; founderPctBp: number; investorPctBp: number };
  deckReview: { id: string; overallScore: number; createdAt: string } | null;
}

interface SafeTemplate {
  key: string;
  name: string;
  roundFit: string;
  description: string;
  keyTerms: { term: string; explanation: string }[];
  whenToUse: string;
  watchOuts: string[];
}

interface StakeholderRow {
  id: string;
  name: string;
  type: "founder" | "investor" | "employee" | "advisor";
  shares: string;
  shareClass: string | null;
  vestingSummary: string | null;
  fullyDilutedPctBp: number;
}

interface CapRollup {
  totalShares: string;
  byType: Record<string, string>;
  pctByTypeBp: Record<string, number>;
  topHolder: { name: string; shares: string; pctBp: number } | null;
  rowCount: number;
}

interface DeckReview {
  id: string;
  overallScore: number;
  narrative: string;
  deckTextProvided: boolean;
  results: {
    criterion: string;
    label: string;
    expectation: string;
    score: number;
    verdict: "pass" | "partial" | "not_detected";
    signals: { source: string; excerpt?: string; field?: string; value?: string }[];
    note: string;
  }[];
}

const inputCls =
  "h-10 rounded-md border-[1.5px] border-control bg-paper px-3 text-[0.875rem] text-ink placeholder:text-subtle focus:border-focus focus:outline-none";
const labelCls = "text-[0.8125rem] font-semibold text-ink";
const primaryPill =
  "aos-press flex h-9 items-center gap-2 rounded-full bg-black px-4 text-[0.8125rem] font-semibold text-white disabled:opacity-50";
const ghostPill =
  "aos-press flex h-9 items-center gap-2 rounded-full bg-paper px-4 text-[0.8125rem] font-semibold text-ink shadow-hairline disabled:opacity-50";

const STATUS_META: Record<ReadinessItem["status"], { label: string; cls: string }> = {
  todo: { label: "To do", cls: "bg-canvas text-muted" },
  doing: { label: "In progress", cls: "bg-canvas text-ink" },
  done: { label: "Done", cls: "bg-black text-white" },
  waived: { label: "Waived", cls: "bg-canvas text-muted line-through" },
};

function pct(bp: number): string {
  return `${(bp / 100).toFixed(2)}%`;
}

function fmtShares(s: string): string {
  const n = BigInt(s);
  return n.toLocaleString("en-US");
}

export function ReadinessView({ roundId }: { roundId: string }) {
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<ReadinessItem[]>([]);
  const [signals, setSignals] = useState<ReadinessSignals | null>(null);
  const [safeTemplates, setSafeTemplates] = useState<SafeTemplate[]>([]);
  const [notAdviceLabel, setNotAdviceLabel] = useState("");
  const [error, setError] = useState("");
  const [rows, setRows] = useState<StakeholderRow[]>([]);
  const [rollup, setRollup] = useState<CapRollup | null>(null);
  const [review, setReview] = useState<DeckReview | null>(null);
  const [deckText, setDeckText] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  // Checklist edit state
  const [editing, setEditing] = useState<string | null>(null);
  const [editStatus, setEditStatus] = useState<ReadinessItem["status"]>("todo");
  const [editNotes, setEditNotes] = useState("");

  // Cap table form state
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: "", type: "founder", shares: "", shareClass: "", vestingSummary: "" });

  // SAFE picker state
  const [safeKey, setSafeKey] = useState("");
  const [safeCap, setSafeCap] = useState("");
  const [safeDiscount, setSafeDiscount] = useState("");

  const refresh = useCallback(async () => {
    setError("");
    try {
      const [r, c] = await Promise.all([
        fetch(`/api/funding/rounds/${roundId}/readiness`),
        fetch(`/api/funding/rounds/${roundId}/cap-table`),
      ]);
      const rj = await r.json();
      if (!r.ok) throw new Error(rj.error ?? "Could not load readiness.");
      setItems(rj.items ?? []);
      setSignals(rj.signals ?? null);
      setSafeTemplates(rj.safeTemplates ?? []);
      setNotAdviceLabel(rj.notAdviceLabel ?? "");
      const cj = await c.json();
      if (c.ok) {
        setRows(cj.rows ?? []);
        setRollup(cj.rollup ?? null);
      }
      const dr = await fetch(`/api/funding/rounds/${roundId}/deck-review`);
      const drj = await dr.json();
      if (dr.ok) setReview(drj.review ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load readiness.");
    } finally {
      setLoading(false);
    }
  }, [roundId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function patchItem(item: ReadinessItem, status: ReadinessItem["status"], notes?: string) {
    setBusy(item.id);
    try {
      const res = await fetch(`/api/funding/rounds/${roundId}/readiness/items/${item.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status, ...(notes !== undefined ? { notes } : {}) }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not update the item.");
      setItems((xs) => xs.map((x) => (x.id === item.id ? json.item : x)));
      setEditing(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update the item.");
    } finally {
      setBusy(null);
    }
  }

  async function testLinks() {
    setBusy("test-links");
    try {
      const res = await fetch(`/api/funding/rounds/${roundId}/readiness/test-links`, { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not test links.");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not test links.");
    } finally {
      setBusy(null);
    }
  }

  async function addStakeholder() {
    setBusy("add-stakeholder");
    try {
      const res = await fetch(`/api/funding/rounds/${roundId}/cap-table`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: form.name,
          type: form.type,
          shares: form.shares,
          shareClass: form.shareClass || undefined,
          vestingSummary: form.vestingSummary || undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not add the stakeholder.");
      setAdding(false);
      setForm({ name: "", type: "founder", shares: "", shareClass: "", vestingSummary: "" });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add the stakeholder.");
    } finally {
      setBusy(null);
    }
  }

  async function deleteStakeholder(id: string) {
    const ok = await confirmAction({
      title: "Remove this stakeholder from the cap table?",
      description: "Their holdings are removed from this round's cap table.",
      confirmLabel: "Remove",
      destructive: true,
    });
    if (!ok) return;
    setBusy(`del-${id}`);
    try {
      const res = await fetch(`/api/funding/rounds/${roundId}/cap-table/${id}`, { method: "DELETE" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not remove the stakeholder.");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not remove the stakeholder.");
    } finally {
      setBusy(null);
    }
  }

  async function selectSafe() {
    if (!safeKey) return;
    setBusy("safe-select");
    try {
      const res = await fetch(`/api/funding/rounds/${roundId}/safe-templates/select`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          templateKey: safeKey,
          valuationCapUsd: safeCap ? Number(safeCap) : null,
          discountPct: safeDiscount ? Number(safeDiscount) : null,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not record the selection.");
      setItems((xs) => xs.map((x) => (x.id === json.item.id ? json.item : x)));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not record the selection.");
    } finally {
      setBusy(null);
    }
  }

  async function runReview() {
    setBusy("deck-review");
    try {
      const res = await fetch(`/api/funding/rounds/${roundId}/deck-review`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deckText: deckText.trim() || null }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not run the review.");
      setReview(json.review);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not run the review.");
    } finally {
      setBusy(null);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted">
        <Loader2 size={16} className="animate-spin" /> Loading round readiness
      </div>
    );
  }

  const doneCount = items.filter((i) => i.status === "done").length;

  return (
    <div className="flex flex-col gap-5">
      {error ? (
        <div className="flex items-center gap-2 rounded-lg bg-paper p-3 text-[0.8125rem] text-ink shadow-hairline">
          <AlertTriangle size={15} className="shrink-0" /> {error}
          <button type="button" onClick={() => setError("")} className="ml-auto" aria-label="Dismiss">
            <X size={14} />
          </button>
        </div>
      ) : null}

      {/* Readiness summary */}
      <div className="flex items-center gap-3 rounded-lg bg-paper p-4 shadow-hairline">
        <ClipboardCheck size={18} />
        <div>
          <div className="text-[0.9375rem] font-bold text-ink">
            {doneCount} of {items.length} ready
          </div>
          <div className="text-[0.8125rem] text-muted">
            Incorporation, cap table, SAFE, deck, and links — everything an investor expects before the first meeting.
          </div>
        </div>
      </div>

      {/* Checklist */}
      <section className="rounded-lg bg-paper p-4 shadow-hairline md:p-5">
        <h2 className="text-[1rem] font-bold text-ink">Checklist</h2>
        <div className="mt-3 flex flex-col gap-2">
          {items.map((item) => {
            const meta = STATUS_META[item.status];
            const isEditing = editing === item.id;
            return (
              <div key={item.id} className="rounded-md border-[1.5px] border-control p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`rounded-full px-2.5 py-1 text-[0.6875rem] font-semibold ${meta.cls}`}>
                    {meta.label}
                  </span>
                  <span className="text-[0.875rem] font-semibold text-ink">{item.label}</span>
                  <div className="ml-auto flex items-center gap-1.5">
                    {(["todo", "doing", "done"] as const).map((s) =>
                      s === item.status ? null : (
                        <button
                          key={s}
                          type="button"
                          disabled={busy === item.id}
                          onClick={() => void patchItem(item, s)}
                          className="rounded-full bg-canvas px-2.5 py-1 text-[0.6875rem] font-semibold text-muted hover:text-ink"
                        >
                          Mark {STATUS_META[s].label.toLowerCase()}
                        </button>
                      ),
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        setEditing(isEditing ? null : item.id);
                        setEditStatus(item.status);
                        setEditNotes(item.notes ?? "");
                      }}
                      className="rounded-full bg-canvas p-1.5 text-muted hover:text-ink"
                      aria-label={isEditing ? "Close editor" : "Edit item"}
                    >
                      {isEditing ? <X size={13} /> : <Pencil size={13} />}
                    </button>
                  </div>
                </div>
                <p className="mt-1 text-[0.8125rem] text-muted">{item.description}</p>

                {/* Read-only Legal vault cross-link signals */}
                {item.legalDocTypes && signals ? (
                  <div className="mt-2 flex flex-wrap gap-2 text-[0.75rem]">
                    {item.legalDocTypes.includes("formation") ? (
                      signals.legalVault.formationDocs.length ? (
                        <span className="rounded-full bg-canvas px-2.5 py-1 text-muted">
                          Legal vault: {signals.legalVault.formationDocs.map((d) => d.title).join(", ")}
                        </span>
                      ) : (
                        <span className="rounded-full bg-canvas px-2.5 py-1 text-muted">
                          No formation doc in the legal vault yet
                        </span>
                      )
                    ) : null}
                    {item.legalDocTypes.includes("ein_letter") ? (
                      signals.legalVault.einDocs.length ? (
                        <span className="rounded-full bg-canvas px-2.5 py-1 text-muted">
                          Legal vault: {signals.legalVault.einDocs.map((d) => d.title).join(", ")}
                        </span>
                      ) : (
                        <span className="rounded-full bg-canvas px-2.5 py-1 text-muted">
                          No EIN letter in the legal vault yet
                        </span>
                      )
                    ) : null}
                  </div>
                ) : null}

                {/* Data-room signals */}
                {item.key === "pitch_deck" && signals ? (
                  <div className="mt-2 text-[0.75rem] text-muted">
                    {signals.dataRoom.pitchDeck
                      ? `In the data room: ${signals.dataRoom.pitchDeck.title} (v${signals.dataRoom.pitchDeck.version})`
                      : "Not in the data room yet"}
                  </div>
                ) : null}
                {item.key === "financials" && signals ? (
                  <div className="mt-2 text-[0.75rem] text-muted">
                    {signals.dataRoom.financials
                      ? `In the data room: ${signals.dataRoom.financials.title} (v${signals.dataRoom.financials.version})`
                      : "Not in the data room yet"}
                  </div>
                ) : null}
                {item.key === "data_room_links" ? (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <span className="text-[0.75rem] text-muted">
                      {signals
                        ? `${signals.dataRoom.shareLinks.total} link(s), ${signals.dataRoom.shareLinks.tested} opened at least once`
                        : ""}
                    </span>
                    <button type="button" onClick={() => void testLinks()} disabled={busy === "test-links"} className={ghostPill}>
                      {busy === "test-links" ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                      Test links now
                    </button>
                    {item.evidence.testedAt ? (
                      <span className="text-[0.75rem] text-muted">Last tested {new Date(item.evidence.testedAt).toLocaleString()}</span>
                    ) : null}
                  </div>
                ) : null}
                {item.key === "cap_table" && signals ? (
                  <div className="mt-2 text-[0.75rem] text-muted">
                    {signals.capTable.rowCount
                      ? `${signals.capTable.rowCount} stakeholder(s), ${fmtShares(signals.capTable.totalShares)} fully-diluted shares, founders ${pct(signals.capTable.founderPctBp)}`
                      : "No stakeholders entered yet"}
                  </div>
                ) : null}

                {/* SAFE evidence */}
                {item.key === "safe_template" && item.evidence.safeTemplateKey ? (
                  <div className="mt-2 text-[0.75rem] text-muted">
                    Selected: {safeTemplates.find((t) => t.key === item.evidence.safeTemplateKey)?.name ?? item.evidence.safeTemplateKey}
                    {item.evidence.note ? ` — ${item.evidence.note}` : ""}
                  </div>
                ) : null}

                {item.evidence.links.length ? (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {item.evidence.links.map((l, i) => (
                      <span key={i} className="rounded-full bg-canvas px-2.5 py-1 text-[0.75rem] font-medium text-ink">
                        {l.label}
                      </span>
                    ))}
                  </div>
                ) : null}
                {item.notes ? <p className="mt-2 text-[0.8125rem] text-ink">{item.notes}</p> : null}
                {item.completedAt ? (
                  <p className="mt-1 text-[0.75rem] text-muted">
                    Done {new Date(item.completedAt).toLocaleDateString()} by {item.completedBy ?? "you"}
                  </p>
                ) : null}

                {isEditing ? (
                  <div className="mt-3 flex flex-col gap-2 border-t border-control pt-3">
                    <label className={labelCls} htmlFor={`notes-${item.id}`}>
                      Notes {editStatus === "waived" ? "(required to waive)" : ""}
                    </label>
                    <textarea
                      id={`notes-${item.id}`}
                      className={`${inputCls} h-auto min-h-20 py-2`}
                      value={editNotes}
                      onChange={(e) => setEditNotes(e.target.value)}
                      placeholder="Why is this waived, or any context for the record…"
                    />
                    <div className="flex gap-2">
                      <button
                        type="button"
                        disabled={busy === item.id}
                        onClick={() => void patchItem(item, editStatus, editNotes)}
                        className={primaryPill}
                      >
                        {busy === item.id ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                        Save
                      </button>
                      {item.status !== "waived" ? (
                        <button
                          type="button"
                          disabled={busy === item.id}
                          onClick={() => {
                            setEditStatus("waived");
                            void patchItem(item, "waived", editNotes);
                          }}
                          className={ghostPill}
                        >
                          Waive this item
                        </button>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </section>

      {/* Cap table */}
      <section className="rounded-lg bg-paper p-4 shadow-hairline md:p-5">
        <div className="flex items-center gap-2">
          <h2 className="text-[1rem] font-bold text-ink">Cap table</h2>
          <span className="rounded-full bg-canvas px-2.5 py-1 text-[0.6875rem] font-semibold text-muted">Manual entry — no live Carta sync</span>
          <button type="button" onClick={() => setAdding((a) => !a)} className={`${ghostPill} ml-auto`}>
            {adding ? <X size={13} /> : <Plus size={13} />} {adding ? "Cancel" : "Add stakeholder"}
          </button>
        </div>

        {rollup ? (
          <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-4">
            <div className="rounded-md bg-canvas p-3">
              <div className="text-[0.6875rem] font-semibold uppercase tracking-wide text-muted">Fully-diluted shares</div>
              <div className="text-[1rem] font-bold text-ink">{fmtShares(rollup.totalShares)}</div>
            </div>
            <div className="rounded-md bg-canvas p-3">
              <div className="text-[0.6875rem] font-semibold uppercase tracking-wide text-muted">Founders</div>
              <div className="text-[1rem] font-bold text-ink">{pct(rollup.pctByTypeBp.founder ?? 0)}</div>
            </div>
            <div className="rounded-md bg-canvas p-3">
              <div className="text-[0.6875rem] font-semibold uppercase tracking-wide text-muted">Investors</div>
              <div className="text-[1rem] font-bold text-ink">{pct(rollup.pctByTypeBp.investor ?? 0)}</div>
            </div>
            <div className="rounded-md bg-canvas p-3">
              <div className="text-[0.6875rem] font-semibold uppercase tracking-wide text-muted">Top holder</div>
              <div className="text-[1rem] font-bold text-ink">
                {rollup.topHolder ? `${rollup.topHolder.name} · ${pct(rollup.topHolder.pctBp)}` : "—"}
              </div>
            </div>
          </div>
        ) : null}

        {adding ? (
          <div className="mt-3 grid grid-cols-1 gap-2 rounded-md border-[1.5px] border-control p-3 md:grid-cols-2">
            <div className="flex flex-col gap-1">
              <label className={labelCls} htmlFor="ct-name">Name</label>
              <input id="ct-name" className={inputCls} value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="Jane Founder" />
            </div>
            <div className="flex flex-col gap-1">
              <label className={labelCls} htmlFor="ct-type">Type</label>
              <select id="ct-type" className={inputCls} value={form.type} onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))}>
                <option value="founder">Founder</option>
                <option value="investor">Investor</option>
                <option value="employee">Employee</option>
                <option value="advisor">Advisor</option>
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label className={labelCls} htmlFor="ct-shares">Shares</label>
              <input id="ct-shares" className={inputCls} value={form.shares} onChange={(e) => setForm((f) => ({ ...f, shares: e.target.value }))} placeholder="8000000" inputMode="numeric" />
            </div>
            <div className="flex flex-col gap-1">
              <label className={labelCls} htmlFor="ct-class">Share class</label>
              <input id="ct-class" className={inputCls} value={form.shareClass} onChange={(e) => setForm((f) => ({ ...f, shareClass: e.target.value }))} placeholder="Common" />
            </div>
            <div className="flex flex-col gap-1 md:col-span-2">
              <label className={labelCls} htmlFor="ct-vesting">Vesting summary</label>
              <input id="ct-vesting" className={inputCls} value={form.vestingSummary} onChange={(e) => setForm((f) => ({ ...f, vestingSummary: e.target.value }))} placeholder="4yr / 1yr cliff" />
            </div>
            <div className="md:col-span-2">
              <button type="button" onClick={() => void addStakeholder()} disabled={busy === "add-stakeholder"} className={primaryPill}>
                {busy === "add-stakeholder" ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
                Add stakeholder
              </button>
            </div>
          </div>
        ) : null}

        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-[0.8125rem]">
            <thead>
              <tr className="text-muted">
                <th className="py-2 pr-3 font-semibold">Name</th>
                <th className="py-2 pr-3 font-semibold">Type</th>
                <th className="py-2 pr-3 font-semibold">Shares</th>
                <th className="py-2 pr-3 font-semibold">Class</th>
                <th className="py-2 pr-3 font-semibold">Vesting</th>
                <th className="py-2 pr-3 font-semibold">FD %</th>
                <th className="py-2 font-semibold" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-control">
                  <td className="py-2 pr-3 font-semibold text-ink">{r.name}</td>
                  <td className="py-2 pr-3 text-muted capitalize">{r.type}</td>
                  <td className="py-2 pr-3 text-ink">{fmtShares(r.shares)}</td>
                  <td className="py-2 pr-3 text-muted">{r.shareClass ?? "—"}</td>
                  <td className="py-2 pr-3 text-muted">{r.vestingSummary ?? "—"}</td>
                  <td className="py-2 pr-3 font-semibold text-ink">{pct(r.fullyDilutedPctBp)}</td>
                  <td className="py-2">
                    <button
                      type="button"
                      onClick={() => void deleteStakeholder(r.id)}
                      disabled={busy === `del-${r.id}`}
                      className="rounded-full bg-canvas p-1.5 text-muted hover:text-ink"
                      aria-label={`Remove ${r.name}`}
                    >
                      {busy === `del-${r.id}` ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                    </button>
                  </td>
                </tr>
              ))}
              {!rows.length ? (
                <tr>
                  <td colSpan={7} className="py-4 text-center text-muted">
                    No stakeholders yet — add your founders first.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      {/* SAFE templates */}
      <section className="rounded-lg bg-paper p-4 shadow-hairline md:p-5">
        <div className="flex items-center gap-2">
          <Scale size={16} />
          <h2 className="text-[1rem] font-bold text-ink">SAFE templates</h2>
        </div>
        <p className="mt-1 text-[0.8125rem] text-muted">{notAdviceLabel}</p>
        <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-2">
          {safeTemplates.map((t) => {
            const selected = safeKey === t.key;
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => setSafeKey(selected ? "" : t.key)}
                className={`rounded-md border-[1.5px] p-3 text-left ${selected ? "border-black" : "border-control"}`}
              >
                <div className="flex items-center gap-2">
                  <span className="text-[0.875rem] font-bold text-ink">{t.name}</span>
                  {selected ? <Check size={15} className="ml-auto shrink-0" /> : null}
                </div>
                <p className="mt-1 text-[0.8125rem] text-muted">{t.description}</p>
                <p className="mt-2 text-[0.75rem] text-muted">
                  <span className="font-semibold text-ink">When to use: </span>
                  {t.whenToUse}
                </p>
                <div className="mt-2 flex flex-col gap-1">
                  {t.keyTerms.map((kt) => (
                    <div key={kt.term} className="text-[0.75rem] text-muted">
                      <span className="font-semibold text-ink">{kt.term}: </span>
                      {kt.explanation}
                    </div>
                  ))}
                </div>
              </button>
            );
          })}
        </div>
        {safeKey ? (
          <div className="mt-3 flex flex-wrap items-end gap-2 rounded-md border-[1.5px] border-control p-3">
            <div className="flex flex-col gap-1">
              <label className={labelCls} htmlFor="safe-cap">Valuation cap (USD, optional)</label>
              <input id="safe-cap" className={inputCls} value={safeCap} onChange={(e) => setSafeCap(e.target.value)} placeholder="8000000" inputMode="numeric" />
            </div>
            <div className="flex flex-col gap-1">
              <label className={labelCls} htmlFor="safe-discount">Discount % (optional)</label>
              <input id="safe-discount" className={inputCls} value={safeDiscount} onChange={(e) => setSafeDiscount(e.target.value)} placeholder="20" inputMode="numeric" />
            </div>
            <button type="button" onClick={() => void selectSafe()} disabled={busy === "safe-select"} className={primaryPill}>
              {busy === "safe-select" ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
              Record this selection
            </button>
          </div>
        ) : null}
      </section>

      {/* Deck review */}
      <section className="rounded-lg bg-paper p-4 shadow-hairline md:p-5">
        <div className="flex items-center gap-2">
          <Sparkles size={16} />
          <h2 className="text-[1rem] font-bold text-ink">Pitch-deck review</h2>
          <span className="rounded-full bg-canvas px-2.5 py-1 text-[0.6875rem] font-semibold text-muted">
            Deterministic rubric — every finding cites its signal
          </span>
        </div>
        <p className="mt-1 text-[0.8125rem] text-muted">
          {signals?.dataRoom.pitchDeck
            ? `Reviews "${signals.dataRoom.pitchDeck.title}" (v${signals.dataRoom.pitchDeck.version}) from your data room.`
            : "Upload a pitch deck to the data room first."}
          {" "}Paste the deck copy below to enable the text-driven checks — without it, those criteria are reported as not detected, never guessed.
        </p>
        <div className="mt-3 flex flex-col gap-2">
          <label className={labelCls} htmlFor="deck-text">Deck text (optional)</label>
          <textarea
            id="deck-text"
            className={`${inputCls} h-auto min-h-28 py-2`}
            value={deckText}
            onChange={(e) => setDeckText(e.target.value)}
            placeholder="Paste the deck's slide copy here…"
          />
          <div>
            <button
              type="button"
              onClick={() => void runReview()}
              disabled={busy === "deck-review" || !signals?.dataRoom.pitchDeck}
              className={primaryPill}
            >
              {busy === "deck-review" ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
              Run the review
            </button>
          </div>
        </div>

        {review ? (
          <div className="mt-4 flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <span className="text-[0.9375rem] font-bold text-ink">Score: {review.overallScore}/100</span>
              {!review.deckTextProvided ? (
                <span className="rounded-full bg-canvas px-2.5 py-1 text-[0.6875rem] font-semibold text-muted">
                  Text checks skipped — no deck text supplied
                </span>
              ) : null}
            </div>
            <p className="text-[0.8125rem] text-muted">{review.narrative}</p>
            {review.results.map((r) => (
              <div key={r.criterion} className="rounded-md border-[1.5px] border-control p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`rounded-full px-2.5 py-1 text-[0.6875rem] font-semibold ${
                      r.verdict === "pass" ? "bg-black text-white" : r.verdict === "partial" ? "bg-canvas text-ink" : "bg-canvas text-muted"
                    }`}
                  >
                    {r.verdict === "pass" ? "Strong" : r.verdict === "partial" ? "Partial" : "Not detected"}
                  </span>
                  <span className="text-[0.875rem] font-semibold text-ink">{r.label}</span>
                  <span className="text-[0.75rem] text-muted">{r.score}/2</span>
                </div>
                <p className="mt-1 text-[0.75rem] text-muted">Investors look for: {r.expectation}</p>
                <p className="mt-1 text-[0.8125rem] text-ink">{r.note}</p>
                {r.signals.filter((s) => s.source === "deck_text").map((s, i) => (
                  <p key={i} className="mt-1 flex gap-1.5 text-[0.75rem] text-muted">
                    <FileText size={12} className="mt-0.5 shrink-0" />
                    <span className="italic">{s.excerpt}</span>
                  </p>
                ))}
              </div>
            ))}
          </div>
        ) : null}
      </section>
    </div>
  );
}
