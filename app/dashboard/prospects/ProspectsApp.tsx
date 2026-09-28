"use client";

// Marketr — R6 prospecting & enrichment UI.
// Light mode, dense data-first: white/paper surfaces, violet accents,
// compact type, chips, Lucide icons. Research only — nothing here sends
// anything; "Send to sequence" queues an ApprovalItem for human review
// (CAN-SPAM warning shown before export).

import { useCallback, useEffect, useMemo, useState } from "react";
import { OpenInSheetsButton } from "@/components/office/OpenInSheetsButton";
import {
  Users,
  Plus,
  Upload,
  Sparkles,
  FlaskConical,
  ArrowRightLeft,
  Send,
  X,
  ChevronRight,
  BadgeCheck,
  CircleDashed,
  AlertTriangle,
  Loader2,
  ListPlus,
  FileText,
  Zap,
  CheckCircle2,
} from "lucide-react";

// ── Types ────────────────────────────────────────────────────────────────────

interface Icp {
  industries: string[];
  employeeRange?: string | null;
  geo?: string | null;
  techSignals: string[];
  titles: string[];
}

interface ProspectList {
  id: string;
  name: string;
  icp: Icp;
  status: string;
  prospectCount: number;
  enrichedCount: number;
}

interface Lookup {
  id: string;
  provider: string;
  status: "hit" | "miss" | "error" | "skipped";
  costCents: number;
}

interface Research {
  summary: string;
  icebreakers: string[];
  firstLines: string[];
  talkingPoints: string[];
  generatedAt: string;
  mock: boolean;
  wordCount: number;
}

interface Prospect {
  id: string;
  company: string | null;
  name: string | null;
  email: string | null;
  phone: string | null;
  title: string | null;
  website: string | null;
  status: string;
  score: number;
  leadId: string | null;
  research: Research | null;
  lookups: Lookup[];
}

interface Estimate {
  prospectCount: number;
  providerChain: string[];
  perProspectUsd: number;
  estimatedTotalUsd: number;
  requiresAck: boolean;
}

// ── Small atoms ──────────────────────────────────────────────────────────────

function Chip({ children, tone = "slate" }: { children: React.ReactNode; tone?: "slate" | "violet" | "green" | "amber" | "red" | "blue" }) {
  const tones: Record<string, string> = {
    slate: "bg-slate-100 text-slate-600 border-slate-200",
    violet: "bg-violet-50 text-violet-700 border-violet-200",
    green: "bg-emerald-50 text-emerald-700 border-emerald-200",
    amber: "bg-amber-50 text-amber-700 border-amber-200",
    red: "bg-red-50 text-red-700 border-red-200",
    blue: "bg-blue-50 text-blue-700 border-blue-200",
  };
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-tight ${tones[tone]}`}>
      {children}
    </span>
  );
}

function statusTone(status: string): "slate" | "violet" | "green" | "amber" | "red" | "blue" {
  switch (status) {
    case "enriched": return "green";
    case "enriching": return "blue";
    case "converted": return "violet";
    case "in_sequence": return "violet";
    case "failed": return "red";
    default: return "slate";
  }
}

async function api(path: string, init?: RequestInit) {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body;
}

// ── App ──────────────────────────────────────────────────────────────────────

export function ProspectsApp() {
  const [lists, setLists] = useState<ProspectList[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [prospects, setProspects] = useState<Prospect[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showNewList, setShowNewList] = useState(false);
  const [newListName, setNewListName] = useState("");
  const [newListIcp, setNewListIcp] = useState("");

  const [showAdd, setShowAdd] = useState(false);
  const [addForm, setAddForm] = useState({ company: "", name: "", email: "", phone: "", title: "", website: "" });
  const [showCsv, setShowCsv] = useState(false);
  const [csvText, setCsvText] = useState("");

  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [estimateAck, setEstimateAck] = useState(false);
  const [running, setRunning] = useState(false);
  const [runSummary, setRunSummary] = useState<string | null>(null);

  const [researchTarget, setResearchTarget] = useState<Prospect | null>(null);
  const [researching, setResearching] = useState<string | null>(null);
  const [converting, setConverting] = useState<string | null>(null);

  const [showExport, setShowExport] = useState(false);
  const [sequences, setSequences] = useState<Array<{ id: string; name: string; status: string }>>([]);
  const [exportSeq, setExportSeq] = useState("");
  const [exportIds, setExportIds] = useState<string[]>([]);
  const [exportDone, setExportDone] = useState<string | null>(null);

  const selected = useMemo(() => lists.find((l) => l.id === selectedId) ?? null, [lists, selectedId]);

  const refreshLists = useCallback(async () => {
    const body = await api("/api/prospects/lists");
    setLists(body.lists);
    return body.lists as ProspectList[];
  }, []);

  const refreshProspects = useCallback(async (listId: string) => {
    const body = await api(`/api/prospects/lists/${listId}/prospects?limit=500`);
    setProspects(body.prospects);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const ls = await refreshLists();
        if (ls.length > 0) {
          setSelectedId(ls[0].id);
          await refreshProspects(ls[0].id);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load");
      } finally {
        setLoading(false);
      }
    })();
  }, [refreshLists, refreshProspects]);

  const selectList = async (id: string) => {
    setSelectedId(id);
    setEstimate(null);
    setEstimateAck(false);
    setRunSummary(null);
    try {
      await refreshProspects(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load prospects");
    }
  };

  const createList = async () => {
    if (!newListName.trim()) return;
    let icp: Partial<Icp> = {};
    if (newListIcp.trim()) {
      try {
        icp = JSON.parse(newListIcp);
      } catch {
        setError("ICP must be valid JSON, e.g. {\"industries\":[\"SaaS\"],\"geo\":\"NC\"}");
        return;
      }
    }
    const body = await api("/api/prospects/lists", { method: "POST", body: JSON.stringify({ name: newListName.trim(), icp }) });
    const ls = await refreshLists();
    setSelectedId(body.list.id);
    await refreshProspects(body.list.id);
    setShowNewList(false);
    setNewListName("");
    setNewListIcp("");
    void ls;
  };

  const addProspect = async () => {
    if (!selectedId) return;
    await api(`/api/prospects/lists/${selectedId}/prospects`, {
      method: "POST",
      body: JSON.stringify({ prospects: [addForm] }),
    });
    setShowAdd(false);
    setAddForm({ company: "", name: "", email: "", phone: "", title: "", website: "" });
    await refreshProspects(selectedId);
    await refreshLists();
  };

  const importCsv = async () => {
    if (!selectedId || !csvText.trim()) return;
    const body = await api(`/api/prospects/lists/${selectedId}/prospects`, {
      method: "POST",
      body: JSON.stringify({ csv: csvText }),
    });
    setShowCsv(false);
    setCsvText("");
    setRunSummary(`Imported ${body.created} prospect(s)${body.skipped ? `, skipped ${body.skipped}` : ""}.`);
    await refreshProspects(selectedId);
    await refreshLists();
  };

  const fetchEstimate = async () => {
    if (!selectedId) return;
    const body = await api("/api/enrichment/estimate", {
      method: "POST",
      body: JSON.stringify({ listId: selectedId }),
    });
    setEstimate(body.estimate);
    setEstimateAck(false);
  };

  const runEnrichment = async () => {
    if (!selectedId) return;
    setRunning(true);
    setRunSummary(null);
    try {
      const body = await api("/api/enrichment/run", {
        method: "POST",
        body: JSON.stringify({ listId: selectedId, estimateAck }),
      });
      setRunSummary(`Ran ${body.ran} prospect(s): ${body.enriched} enriched, ${body.failed} failed.`);
      await refreshProspects(selectedId);
      await refreshLists();
      setEstimate(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Enrichment run failed");
    } finally {
      setRunning(false);
    }
  };

  const runResearch = async (p: Prospect) => {
    setResearching(p.id);
    try {
      const body = await api(`/api/prospects/${p.id}/research`, { method: "POST" });
      const updated = { ...p, research: body.research };
      setProspects((ps) => ps.map((x) => (x.id === p.id ? updated : x)));
      setResearchTarget(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Research failed");
    } finally {
      setResearching(null);
    }
  };

  const convertProspect = async (p: Prospect) => {
    setConverting(p.id);
    try {
      const body = await api(`/api/prospects/${p.id}/convert`, { method: "POST", body: JSON.stringify({}) });
      setRunSummary(
        body.linkedExisting
          ? `Linked to existing lead "${body.lead.name}" (dedup match — no duplicate created).`
          : `Converted to lead "${body.lead.name}" (source: ${body.lead.sourceDetail ?? body.lead.source}).`,
      );
      await refreshProspects(selectedId!);
      await refreshLists();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Convert failed");
    } finally {
      setConverting(null);
    }
  };

  const openExport = async () => {
    const targets = prospects.filter((p) => p.status === "enriched" && !p.leadId);
    if (targets.length === 0) {
      setError("No enriched, unconverted prospects to export.");
      return;
    }
    setExportIds(targets.map((p) => p.id));
    try {
      const body = await api("/api/nurture/sequences");
      setSequences(body.sequences ?? []);
      if ((body.sequences ?? []).length > 0) setExportSeq(body.sequences[0].id);
    } catch {
      setSequences([]);
    }
    setExportDone(null);
    setShowExport(true);
  };

  const submitExport = async () => {
    if (!exportSeq) {
      setError("Pick a sequence first.");
      return;
    }
    const body = await api("/api/prospects/export-approval", {
      method: "POST",
      body: JSON.stringify({ prospectIds: exportIds, sequenceId: exportSeq }),
    });
    setExportDone(`Queued ${body.queued} prospect(s) for approval. Nothing will be sent until a human approves it.`);
  };

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-slate-500">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading prospecting workspace…
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-[600px] text-slate-900">
      {/* ── List sidebar ── */}
      <aside className="w-72 shrink-0 border-r border-slate-200 bg-white p-3">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Lists</h2>
          <button
            onClick={() => setShowNewList(true)}
            className="inline-flex items-center gap-1 rounded-md bg-violet-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-violet-700"
          >
            <Plus className="h-3 w-3" /> New
          </button>
        </div>
        <div className="space-y-1.5 overflow-y-auto">
          {lists.map((l) => (
            <button
              key={l.id}
              onClick={() => selectList(l.id)}
              className={`w-full rounded-lg border p-2.5 text-left transition ${
                l.id === selectedId ? "border-violet-300 bg-violet-50" : "border-slate-200 bg-white hover:border-slate-300"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-[13px] font-semibold">{l.name}</span>
                <Chip tone={l.status === "ready" ? "green" : "slate"}>{l.status}</Chip>
              </div>
              <div className="mt-1 flex flex-wrap gap-1">
                {(l.icp.industries ?? []).slice(0, 2).map((i) => (
                  <Chip key={i} tone="violet">{i}</Chip>
                ))}
                {l.icp.geo && <Chip>{l.icp.geo}</Chip>}
                {l.icp.titles?.slice(0, 1).map((t) => (
                  <Chip key={t}>{t}</Chip>
                ))}
              </div>
              <div className="mt-1.5 flex items-center gap-2 text-[11px] text-slate-500">
                <span className="inline-flex items-center gap-1"><Users className="h-3 w-3" />{l.prospectCount}</span>
                <span className="inline-flex items-center gap-1 text-emerald-600"><BadgeCheck className="h-3 w-3" />{l.enrichedCount} enriched</span>
              </div>
            </button>
          ))}
          {lists.length === 0 && (
            <p className="rounded-lg border border-dashed border-slate-300 p-4 text-center text-xs text-slate-500">
              No lists yet. Create one to start building a prospect pipeline.
            </p>
          )}
        </div>
      </aside>

      {/* ── Main ── */}
      <main className="min-w-0 flex-1 overflow-y-auto p-4">
        {error && (
          <div className="mb-3 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-2.5 text-xs text-red-700">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span className="flex-1">{error}</span>
            <button onClick={() => setError(null)}><X className="h-3.5 w-3.5" /></button>
          </div>
        )}

        {!selected ? (
          <div className="flex h-64 flex-col items-center justify-center gap-2 text-sm text-slate-500">
            <ListPlus className="h-8 w-8 text-slate-300" />
            Select or create a prospect list to begin.
          </div>
        ) : (
          <>
            {/* List header + actions */}
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div>
                <h1 className="text-lg font-bold tracking-tight">{selected.name}</h1>
                <p className="text-xs text-slate-500">
                  ICP: {(selected.icp.industries ?? []).join(", ") || "—"}
                  {selected.icp.geo ? ` · ${selected.icp.geo}` : ""}
                  {selected.icp.titles?.length ? ` · ${selected.icp.titles.join(", ")}` : ""}
                </p>
              </div>
              <div className="flex flex-wrap gap-1.5">
                <button onClick={() => setShowAdd(true)} className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium hover:bg-slate-50">
                  <Plus className="h-3.5 w-3.5" /> Add prospect
                </button>
                <button onClick={() => setShowCsv(true)} className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium hover:bg-slate-50">
                  <Upload className="h-3.5 w-3.5" /> CSV import
                </button>
                <button onClick={fetchEstimate} className="inline-flex items-center gap-1 rounded-md border border-violet-300 bg-violet-50 px-2.5 py-1.5 text-xs font-medium text-violet-700 hover:bg-violet-100">
                  <Zap className="h-3.5 w-3.5" /> Estimate & enrich
                </button>
                <button onClick={openExport} className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium hover:bg-slate-50">
                  <Send className="h-3.5 w-3.5" /> Send to sequence
                </button>
              </div>
            </div>

            {/* Cost-estimate banner */}
            {estimate && (
              <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 p-3">
                <div className="flex items-start gap-2">
                  <FlaskConical className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                  <div className="flex-1 text-xs text-amber-900">
                    <p className="font-semibold">Cost estimate — review before running</p>
                    <p className="mt-1">
                      {estimate.prospectCount} unenriched prospect(s) · chain: {estimate.providerChain.join(" → ")} ·
                      worst case <strong>${estimate.estimatedTotalUsd.toFixed(2)}</strong> (${estimate.perProspectUsd.toFixed(4)}/prospect).
                      Every lookup is metered and audit-logged.
                    </p>
                    {estimate.requiresAck && (
                      <label className="mt-2 flex cursor-pointer items-center gap-2 font-medium">
                        <input type="checkbox" checked={estimateAck} onChange={(e) => setEstimateAck(e.target.checked)} className="h-3.5 w-3.5 accent-violet-600" />
                        I acknowledge this run covers {estimate.prospectCount} prospects (est. ${estimate.estimatedTotalUsd.toFixed(2)} worst case).
                      </label>
                    )}
                  </div>
                  <div className="flex gap-1.5">
                    <button onClick={() => setEstimate(null)} className="rounded-md border border-amber-300 bg-white px-2 py-1 text-xs font-medium text-amber-800">Cancel</button>
                    <button
                      onClick={runEnrichment}
                      disabled={running || (estimate.requiresAck && !estimateAck)}
                      className="inline-flex items-center gap-1 rounded-md bg-violet-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-violet-700 disabled:opacity-50"
                    >
                      {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                      Run waterfall
                    </button>
                  </div>
                </div>
              </div>
            )}

            {runSummary && (
              <div className="mb-3 flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-2.5 text-xs text-emerald-800">
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0" /> {runSummary}
              </div>
            )}

            {/* Prospect table */}
            <div className="mb-2 flex items-center justify-between">
              <p className="text-[12px] text-slate-500">{prospects.length} prospects</p>
              {prospects.length > 0 && (
                <OpenInSheetsButton
                  title={`Prospect list — ${selected?.name ?? "all"}`}
                  headers={["Company", "Contact", "Title", "Email", "Phone", "Website", "Score", "Status"]}
                  rows={prospects.map((p) => [
                    p.company ?? "—",
                    p.name ?? "—",
                    p.title ?? "—",
                    p.email ?? "—",
                    p.phone ?? "—",
                    p.website ?? "—",
                    p.score,
                    p.status,
                  ])}
                  sourceRef="prospects:list"
                  sheetName="Prospects"
                  className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-[12px] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                />
              )}
            </div>
            <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
                    <th className="px-3 py-2 font-medium">Company / Contact</th>
                    <th className="px-3 py-2 font-medium">Title</th>
                    <th className="px-3 py-2 font-medium">Email / Phone</th>
                    <th className="px-3 py-2 font-medium">Enrichment</th>
                    <th className="px-3 py-2 font-medium">Score</th>
                    <th className="px-3 py-2 font-medium">Status</th>
                    <th className="px-3 py-2 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {prospects.map((p) => (
                    <tr key={p.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50/60">
                      <td className="px-3 py-2">
                        <div className="font-semibold text-slate-900">{p.company ?? "—"}</div>
                        <div className="text-slate-500">{p.name ?? ""}{p.website ? ` · ${p.website.replace(/^https?:\/\//, "").split("/")[0]}` : ""}</div>
                      </td>
                      <td className="px-3 py-2 text-slate-600">{p.title ?? "—"}</td>
                      <td className="px-3 py-2 text-slate-600">
                        <div className="truncate">{p.email ?? "—"}</div>
                        <div className="text-slate-400">{p.phone ?? ""}</div>
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap gap-1">
                          {p.lookups.length === 0 && <span className="inline-flex items-center gap-1 text-slate-400"><CircleDashed className="h-3 w-3" /> none</span>}
                          {p.lookups.map((l) => (
                            <Chip key={l.id} tone={l.status === "hit" ? "green" : l.status === "error" ? "red" : "slate"}>
                              {l.provider}:{l.status}
                            </Chip>
                          ))}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <span className={`font-semibold ${p.score >= 60 ? "text-emerald-600" : p.score >= 30 ? "text-amber-600" : "text-slate-500"}`}>{p.score}</span>
                      </td>
                      <td className="px-3 py-2"><Chip tone={statusTone(p.status)}>{p.status.replace("_", " ")}</Chip></td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap gap-1">
                          <button
                            onClick={() => (p.research ? setResearchTarget(p) : runResearch(p))}
                            disabled={researching === p.id}
                            title="AI research (icebreakers, first lines)"
                            className="inline-flex items-center gap-1 rounded border border-slate-200 px-1.5 py-1 text-[11px] font-medium text-slate-600 hover:bg-slate-100 disabled:opacity-50"
                          >
                            {researching === p.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <FlaskConical className="h-3 w-3" />}
                            {p.research ? "Research" : "Research"}
                          </button>
                          {p.status !== "converted" && (
                            <button
                              onClick={() => convertProspect(p)}
                              disabled={converting === p.id}
                              title="Convert to CRM lead"
                              className="inline-flex items-center gap-1 rounded border border-violet-200 bg-violet-50 px-1.5 py-1 text-[11px] font-medium text-violet-700 hover:bg-violet-100 disabled:opacity-50"
                            >
                              {converting === p.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <ArrowRightLeft className="h-3 w-3" />}
                              Convert
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                  {prospects.length === 0 && (
                    <tr><td colSpan={7} className="px-3 py-8 text-center text-slate-400">No prospects in this list yet — add one or import a CSV.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </main>

      {/* ── Modals & drawer ── */}
      {showNewList && (
        <Modal title="New prospect list" onClose={() => setShowNewList(false)}>
          <label className="mb-2 block text-xs font-medium text-slate-600">Name</label>
          <input value={newListName} onChange={(e) => setNewListName(e.target.value)} placeholder="Q4 SaaS outreach" className="mb-3 w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-sm" />
          <label className="mb-2 block text-xs font-medium text-slate-600">ICP (JSON)</label>
          <textarea value={newListIcp} onChange={(e) => setNewListIcp(e.target.value)} rows={5} placeholder='{"industries":["SaaS"],"geo":"North Carolina","titles":["VP Marketing"]}' className="mb-3 w-full rounded-md border border-slate-300 px-2.5 py-1.5 font-mono text-xs" />
          <div className="flex justify-end gap-2">
            <button onClick={() => setShowNewList(false)} className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium">Cancel</button>
            <button onClick={createList} className="rounded-md bg-violet-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-violet-700">Create list</button>
          </div>
        </Modal>
      )}

      {showAdd && (
        <Modal title="Add prospect" onClose={() => setShowAdd(false)}>
          <div className="grid grid-cols-2 gap-2">
            {(["company", "name", "email", "phone", "title", "website"] as const).map((f) => (
              <div key={f}>
                <label className="mb-1 block text-xs font-medium capitalize text-slate-600">{f}</label>
                <input value={addForm[f]} onChange={(e) => setAddForm({ ...addForm, [f]: e.target.value })} className="w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-sm" />
              </div>
            ))}
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <button onClick={() => setShowAdd(false)} className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium">Cancel</button>
            <button onClick={addProspect} className="rounded-md bg-violet-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-violet-700">Add</button>
          </div>
        </Modal>
      )}

      {showCsv && (
        <Modal title="CSV import" onClose={() => setShowCsv(false)}>
          <p className="mb-2 text-xs text-slate-500">Headers: company, name, email, phone, title, website. Duplicates (by email/phone) are skipped.</p>
          <textarea value={csvText} onChange={(e) => setCsvText(e.target.value)} rows={8} placeholder="company,name,email,phone,title,website&#10;Acme Inc,Jane Doe,jane@acme.com,,VP Marketing,acme.com" className="mb-3 w-full rounded-md border border-slate-300 px-2.5 py-1.5 font-mono text-xs" />
          <div className="flex justify-end gap-2">
            <button onClick={() => setShowCsv(false)} className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium">Cancel</button>
            <button onClick={importCsv} className="inline-flex items-center gap-1 rounded-md bg-violet-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-violet-700"><FileText className="h-3.5 w-3.5" /> Import</button>
          </div>
        </Modal>
      )}

      {showExport && (
        <Modal title="Send to sequence — approval required" onClose={() => setShowExport(false)}>
          {!exportDone ? (
            <>
              <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 p-2.5 text-xs text-amber-900">
                <p className="flex items-start gap-1.5 font-semibold"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> Cold-email compliance (CAN-SPAM)</p>
                <p className="mt-1">Outreach requires opt-in or legitimate-interest review for every recipient. Every message must include a working unsubscribe mechanism and the sender's physical postal address. This only queues an approval — nothing is sent until a human approves it, and R3's consent layer enforces compliance before any send.</p>
              </div>
              <label className="mb-1 block text-xs font-medium text-slate-600">Sequence ({exportIds.length} enriched prospect(s))</label>
              <select value={exportSeq} onChange={(e) => setExportSeq(e.target.value)} className="mb-3 w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-sm">
                {sequences.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.status})</option>)}
                {sequences.length === 0 && <option value="">No sequences found</option>}
              </select>
              <div className="flex justify-end gap-2">
                <button onClick={() => setShowExport(false)} className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium">Cancel</button>
                <button onClick={submitExport} className="inline-flex items-center gap-1 rounded-md bg-violet-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-violet-700"><Send className="h-3.5 w-3.5" /> Queue approval</button>
              </div>
            </>
          ) : (
            <>
              <p className="flex items-start gap-2 text-sm text-emerald-700"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />{exportDone}</p>
              <div className="mt-3 flex justify-end">
                <button onClick={() => setShowExport(false)} className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium">Close</button>
              </div>
            </>
          )}
        </Modal>
      )}

      {researchTarget && (
        <div className="fixed inset-0 z-40 flex justify-end bg-black/20" onClick={() => setResearchTarget(null)}>
          <div className="h-full w-full max-w-md overflow-y-auto border-l border-slate-200 bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-start justify-between">
              <div>
                <h3 className="text-sm font-bold">AI research</h3>
                <p className="text-xs text-slate-500">{researchTarget.company ?? researchTarget.name}</p>
              </div>
              <button onClick={() => setResearchTarget(null)}><X className="h-4 w-4 text-slate-400" /></button>
            </div>
            {researchTarget.research?.mock && (
              <div className="mb-3"><Chip tone="amber">Mock research — connect an LLM for real output</Chip></div>
            )}
            <section className="mb-4">
              <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Summary</h4>
              <p className="text-[13px] leading-relaxed text-slate-700">{researchTarget.research?.summary}</p>
            </section>
            <section className="mb-4">
              <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Icebreakers</h4>
              <ul className="space-y-1.5">
                {(researchTarget.research?.icebreakers ?? []).map((s, i) => (
                  <li key={i} className="flex gap-1.5 rounded-md bg-violet-50 p-2 text-[13px] text-slate-700"><ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-violet-500" />{s}</li>
                ))}
              </ul>
            </section>
            <section className="mb-4">
              <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">First lines</h4>
              <ul className="space-y-1.5">
                {(researchTarget.research?.firstLines ?? []).map((s, i) => (
                  <li key={i} className="flex gap-1.5 rounded-md bg-slate-50 p-2 text-[13px] text-slate-700"><ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" />{s}</li>
                ))}
              </ul>
            </section>
            <section>
              <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Talking points</h4>
              <ul className="list-disc space-y-1 pl-5 text-[13px] text-slate-700">
                {(researchTarget.research?.talkingPoints ?? []).map((s, i) => <li key={i}>{s}</li>)}
              </ul>
            </section>
          </div>
        </div>
      )}
    </div>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/20 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-xl border border-slate-200 bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-bold">{title}</h3>
          <button onClick={onClose}><X className="h-4 w-4 text-slate-400" /></button>
        </div>
        {children}
      </div>
    </div>
  );
}
