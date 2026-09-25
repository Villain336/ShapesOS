// Marketr — Creative Studio home (Phase 4, T2).
// The central home for all creative and design work across Marketr, powered by
// Canva. Tabs: [Creatives] [Assets] [Canva connection].
// v1 ships print/mail creative + the asset library; email/social channel
// templates are registered as coming_soon and plug in without rework.
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Archive,
  CheckCircle2,
  Copy,
  Download,
  FileUp,
  FolderOpen,
  Link2,
  Loader2,
  Palette,
  Plug,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import {
  api,
  hashShort,
  pollPdfExport,
  type ChannelTemplate,
  type Creative,
  type ValidationReport,
} from "./api";
import { CreativeWizard, ValidationView } from "./CreativeWizard";

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
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-tight ${tones[tone]}`}>
      {children}
    </span>
  );
}

function statusTone(status: string): "slate" | "violet" | "green" | "amber" | "red" | "blue" {
  switch (status) {
    case "ready": return "green";
    case "draft": return "violet";
    case "archived": return "slate";
    default: return "slate";
  }
}

const inputCls =
  "rounded-md border border-stone-200 bg-white px-2.5 py-1.5 text-[13px] text-stone-900 placeholder:text-stone-400 focus:border-violet-400 focus:outline-none";

const btnPrimary =
  "flex items-center gap-1.5 rounded-md bg-violet-600 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-violet-700 disabled:opacity-40";
const btnGhost =
  "flex items-center gap-1.5 rounded-md border border-stone-200 bg-white px-2.5 py-1.5 text-[13px] text-stone-700 hover:bg-stone-50 disabled:opacity-40";

// ── Creatives tab ────────────────────────────────────────────────────────────

function trackLabel(track: string) {
  return track === "addressed" ? "Addressed" : track === "eddm" ? "EDDM flat" : track;
}

function CreativesTab() {
  const [creatives, setCreatives] = useState<Creative[]>([]);
  const [channels, setChannels] = useState<ChannelTemplate[]>([]);
  const [fChannel, setFChannel] = useState("");
  const [fTrack, setFTrack] = useState("");
  const [fStatus, setFStatus] = useState("");
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (fChannel) qs.set("channelTemplate", fChannel);
      if (fTrack) qs.set("formatTrack", fTrack);
      if (fStatus) qs.set("status", fStatus);
      if (q.trim()) qs.set("q", q.trim());
      const r = await api<{ creatives: Creative[] }>(`/api/studio/creatives?${qs.toString()}`);
      setCreatives(r.creatives);
    } catch {
      // keep previous list on transient failure
    } finally {
      setLoading(false);
    }
  }, [fChannel, fTrack, fStatus, q]);

  useEffect(() => {
    api<{ channelTemplates: Record<string, ChannelTemplate> }>("/api/studio/creatives/formats")
      .then((r) => setChannels(Object.values(r.channelTemplates)))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const t = setTimeout(load, q ? 300 : 0);
    return () => clearTimeout(t);
  }, [load, q]);

  const selected = useMemo(() => creatives.find((c) => c.id === selectedId) ?? null, [creatives, selectedId]);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <select value={fChannel} onChange={(e) => setFChannel(e.target.value)} className={inputCls}>
          <option value="">All channels</option>
          {channels.map((c) => (
            <option key={c.id} value={c.id}>{c.label}{c.status === "coming_soon" ? " (soon)" : ""}</option>
          ))}
        </select>
        <select value={fTrack} onChange={(e) => setFTrack(e.target.value)} className={inputCls}>
          <option value="">All format tracks</option>
          <option value="addressed">Addressed</option>
          <option value="eddm">EDDM flat</option>
        </select>
        <select value={fStatus} onChange={(e) => setFStatus(e.target.value)} className={inputCls}>
          <option value="">All statuses</option>
          <option value="draft">Draft</option>
          <option value="ready">Ready</option>
          <option value="archived">Archived</option>
        </select>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search creatives…" className={`${inputCls} w-44`} />
        <div className="ml-auto">
          <button onClick={() => setWizardOpen(true)} className={btnPrimary}>
            <Plus size={14} /> New creative
          </button>
        </div>
      </div>

      <div className="overflow-hidden rounded-lg border border-stone-200 bg-white">
        <table className="w-full text-left text-[13px]">
          <thead>
            <tr className="border-b border-stone-100 bg-stone-50/60 text-[11px] uppercase tracking-wide text-stone-500">
              <th className="px-3 py-2 font-medium">Name</th>
              <th className="px-3 py-2 font-medium">Channel</th>
              <th className="px-3 py-2 font-medium">Track / size</th>
              <th className="px-3 py-2 font-medium">Source</th>
              <th className="px-3 py-2 font-medium">Ver</th>
              <th className="px-3 py-2 font-medium">Hash</th>
              <th className="px-3 py-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {creatives.map((c) => (
              <tr
                key={c.id}
                onClick={() => setSelectedId(c.id)}
                className={`cursor-pointer border-b border-stone-100 last:border-0 hover:bg-violet-50/40 ${selectedId === c.id ? "bg-violet-50/60" : ""}`}
              >
                <td className="px-3 py-2 font-medium text-stone-900">{c.name}</td>
                <td className="px-3 py-2"><Chip tone="blue">{c.channelTemplate}</Chip></td>
                <td className="px-3 py-2 text-stone-600">
                  <Chip>{trackLabel(c.formatTrack)}</Chip> <span className="text-stone-500">{c.size}</span>
                </td>
                <td className="px-3 py-2 text-stone-500">{c.source === "canva_link" ? "canva link" : c.source}</td>
                <td className="px-3 py-2"><Chip tone="violet">v{c.version}</Chip></td>
                <td className="px-3 py-2 font-mono text-[11px] text-stone-500">{hashShort(c.creativeHash)}</td>
                <td className="px-3 py-2"><Chip tone={statusTone(c.status)}>{c.status}</Chip></td>
              </tr>
            ))}
            {creatives.length === 0 && !loading && (
              <tr>
                <td colSpan={7} className="px-3 py-8 text-center text-[13px] text-stone-400">
                  No creatives yet — create the first one with “New creative”.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {wizardOpen && (
        <CreativeWizard
          onClose={() => setWizardOpen(false)}
          onDone={(c) => {
            setWizardOpen(false);
            setSelectedId(c.id);
            load();
          }}
        />
      )}
      {selected && (
        <CreativeDrawer creative={selected} onClose={() => setSelectedId(null)} onChange={load} />
      )}
    </div>
  );
}

// ── Creative detail drawer ───────────────────────────────────────────────────

function CreativeDrawer({ creative, onClose, onChange }: { creative: Creative; onClose: () => void; onChange: () => void }) {
  const [c, setC] = useState(creative);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [designId, setDesignId] = useState(c.canvaDesignId ?? "");
  const [shareUrl, setShareUrl] = useState("");
  const [attested, setAttested] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [showLink, setShowLink] = useState(false);

  useEffect(() => setC(creative), [creative]);

  async function run(label: string, fn: () => Promise<Creative>) {
    setBusy(label);
    setError(null);
    try {
      const next = await fn();
      setC(next);
      onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed.");
    } finally {
      setBusy(null);
    }
  }

  const upload = async (f: File) => {
    const form = new FormData();
    form.append("file", f);
    return run("upload", () =>
      api<{ creative: Creative }>(`/api/studio/creatives/${c.id}/upload`, { method: "POST", body: form }).then((r) => r.creative),
    );
  };

  const exportPdf = () =>
    run("export", async () => {
      await api("/api/studio/creatives/canva/export-pdf", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ creativeId: c.id, designId: designId.trim() }),
      });
      return pollPdfExport(c.id);
    });

  const designLink = () =>
    run("export", async () => {
      await api("/api/studio/creatives/canva/design-link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ creativeId: c.id, shareUrl: shareUrl.trim() }),
      });
      return pollPdfExport(c.id);
    });

  const report: ValidationReport | null = c.validation;

  return (
    <div className="fixed inset-0 z-40">
      <div className="absolute inset-0 bg-stone-900/30" onClick={onClose} />
      <div className="absolute right-0 top-0 flex h-full w-full max-w-md flex-col bg-white shadow-xl">
        <div className="flex items-start justify-between border-b border-stone-100 px-4 py-3.5">
          <div>
            <h3 className="text-[15px] font-semibold text-stone-900">{c.name}</h3>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <Chip tone={statusTone(c.status)}>{c.status}</Chip>
              <Chip tone="violet">v{c.version}</Chip>
              <Chip tone="blue">{c.channelTemplate}</Chip>
              <Chip>{trackLabel(c.formatTrack)} · {c.size}</Chip>
            </div>
            <div className="mt-1.5 font-mono text-[11px] text-stone-500">
              hash {c.creativeHash ?? "—"}
            </div>
          </div>
          <button onClick={onClose} className="rounded-md p-1.5 text-stone-400 hover:bg-stone-100" aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
          {error && (
            <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {report ? <ValidationView report={report} /> : <p className="text-[13px] text-stone-500">No PDF attached yet.</p>}

          {c.pdfUrl && (
            <a href={c.pdfUrl} className={btnGhost} download>
              <Download size={14} /> Download PDF
            </a>
          )}

          {c.status === "draft" && (
            <div className="space-y-2 border-t border-stone-100 pt-3">
              <div className="text-[12px] font-medium uppercase tracking-wide text-stone-500">Actions</div>
              <div className="flex flex-wrap gap-2">
                <label className={`${btnGhost} cursor-pointer`}>
                  <FileUp size={14} /> Upload PDF
                  <input
                    type="file"
                    accept="application/pdf,.pdf"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void upload(f);
                      e.target.value = "";
                    }}
                  />
                </label>
                <button onClick={() => api<{ creative: Creative }>(`/api/studio/creatives/${c.id}/validate`, { method: "POST" }).then((r) => { setC(r.creative); onChange(); }).catch((e) => setError(e.message))} className={btnGhost} disabled={!!busy}>
                  <RefreshCw size={14} /> Re-validate
                </button>
                <button onClick={() => setShowExport((s) => !s)} className={btnGhost}>
                  <Copy size={14} /> Export from Canva
                </button>
                <button onClick={() => setShowLink((s) => !s)} className={btnGhost}>
                  <Link2 size={14} /> Canva link
                </button>
              </div>

              {showExport && (
                <div className="flex gap-2">
                  <input
                    value={designId}
                    onChange={(e) => setDesignId(e.target.value)}
                    placeholder="Canva design id (DAG…)"
                    className={`${inputCls} flex-1`}
                  />
                  <button onClick={exportPdf} disabled={busy === "export" || !designId.trim()} className={btnPrimary}>
                    {busy === "export" && <Loader2 size={14} className="animate-spin" />} Export PDF
                  </button>
                </div>
              )}
              {showLink && (
                <div className="flex gap-2">
                  <input
                    value={shareUrl}
                    onChange={(e) => setShareUrl(e.target.value)}
                    placeholder="https://www.canva.com/design/…"
                    className={`${inputCls} flex-1`}
                  />
                  <button onClick={designLink} disabled={busy === "export" || !shareUrl.trim()} className={btnPrimary}>
                    {busy === "export" && <Loader2 size={14} className="animate-spin" />} Pull PDF
                  </button>
                </div>
              )}

              <div className="flex flex-wrap gap-2 pt-1">
                <button
                  onClick={() => run("version", () => api<{ next: Creative }>(`/api/studio/creatives/${c.id}/version`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).then((r) => r.next))}
                  className={btnGhost}
                  disabled={!!busy}
                >
                  <Copy size={14} /> New version
                </button>
                <button
                  onClick={() => run("archive", () => api<{ creative: Creative }>(`/api/studio/creatives/${c.id}`, { method: "DELETE" }).then((r) => r.creative))}
                  className={btnGhost}
                  disabled={!!busy}
                >
                  <Archive size={14} /> Archive
                </button>
              </div>

              <label className="flex cursor-pointer items-start gap-2.5 rounded-md border border-stone-200 bg-stone-50 px-3 py-2.5">
                <input type="checkbox" checked={attested} onChange={(e) => setAttested(e.target.checked)} className="mt-0.5 accent-violet-600" />
                <span className="text-[12.5px] leading-snug text-stone-700">
                  I confirm this creative contains <strong>no USPS/government impersonation markings</strong> (spec §7).
                </span>
              </label>
              <button
                onClick={() => run("ready", () => api<{ creative: Creative }>(`/api/studio/creatives/${c.id}/mark-ready`, {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ attested }),
                }).then((r) => r.creative))}
                disabled={!!busy || !attested || !report?.ok}
                title={!report?.ok ? "Validation must pass before marking ready" : undefined}
                className="flex items-center gap-1.5 rounded-md bg-emerald-600 px-3.5 py-1.5 text-[13px] font-medium text-white hover:bg-emerald-700 disabled:opacity-40"
              >
                {busy === "ready" && <Loader2 size={14} className="animate-spin" />}
                <CheckCircle2 size={14} /> Mark ready
              </button>
            </div>
          )}

          {c.status === "ready" && (
            <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-[12.5px] text-emerald-800">
              Ready for campaigns. The approval gate binds hash <span className="font-mono">{hashShort(c.creativeHash)}</span>.
              To change the PDF, create a new version.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Assets tab ───────────────────────────────────────────────────────────────

interface Asset {
  id: string;
  name: string;
  source: string;
  url: string;
  mimeType: string | null;
  createdAt: string;
}

function AssetsTab() {
  const [projects, setProjects] = useState<Array<{ id: string; domain: string }>>([]);
  const [projectId, setProjectId] = useState("");
  const [assets, setAssets] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    api<{ projects: Array<{ id: string; domain: string }> }>("/api/projects")
      .then((r) => {
        setProjects(r.projects);
        if (r.projects.length > 0) setProjectId(r.projects[0].id);
      })
      .catch(() => {});
  }, []);

  const load = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const r = await api<{ assets: Asset[] }>(`/api/studio/assets?projectId=${encodeURIComponent(projectId)}`);
      setAssets(r.assets);
    } catch {
      setAssets([]);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <select value={projectId} onChange={(e) => setProjectId(e.target.value)} className={inputCls}>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>{p.domain}</option>
          ))}
        </select>
        <button onClick={() => void load()} className={btnGhost}>
          <RefreshCw size={14} /> Refresh
        </button>
        <span className="text-[12px] text-stone-400">The asset library is per-project; creatives are workspace-wide.</span>
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {assets.map((a) => (
          <div key={a.id} className="overflow-hidden rounded-lg border border-stone-200 bg-white">
            <div className="flex h-28 items-center justify-center bg-stone-50">
              {a.mimeType?.startsWith("image/") ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={a.url} alt={a.name} className="max-h-full max-w-full object-contain" />
              ) : (
                <FolderOpen size={24} className="text-stone-300" />
              )}
            </div>
            <div className="px-2.5 py-2">
              <div className="truncate text-[12.5px] font-medium text-stone-900">{a.name}</div>
              <div className="mt-1 flex items-center justify-between">
                <Chip>{a.source}</Chip>
                <button
                  onClick={() =>
                    api(`/api/studio/assets/${a.id}`, {
                      method: "DELETE",
                      headers: { "content-type": "application/json" },
                      body: JSON.stringify({ projectId }),
                    }).then(() => void load()).catch(() => {})
                  }
                  className="rounded p-1 text-stone-400 hover:bg-red-50 hover:text-red-600"
                  aria-label={`Delete ${a.name}`}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
      {assets.length === 0 && !loading && (
        <p className="py-8 text-center text-[13px] text-stone-400">No assets in this project yet.</p>
      )}
    </div>
  );
}

// ── Canva tab ────────────────────────────────────────────────────────────────

interface CanvaStatus {
  connected: boolean;
  canvaUserId?: string | null;
  scopes?: string[];
  connectedAt?: string;
}

function CanvaTab() {
  const [status, setStatus] = useState<CanvaStatus | null>(null);
  const [workspaceId, setWorkspaceId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [templates, setTemplates] = useState<Array<{ id: string; title: string }> | null>(null);
  const [enterpriseError, setEnterpriseError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api<{ status: CanvaStatus; workspaceId: string }>("/api/studio/creatives/canva/status");
      setStatus(r.status);
      setWorkspaceId(r.workspaceId);
    } catch {
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ authorizeUrl: string }>("/api/studio/canva/connect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId }),
      });
      window.location.href = r.authorizeUrl;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Connect failed.");
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    setError(null);
    try {
      await api("/api/studio/canva/disconnect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId }),
      });
      setStatus({ connected: false });
      setTemplates(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Disconnect failed.");
    } finally {
      setBusy(false);
    }
  };

  const loadTemplates = async () => {
    setEnterpriseError(null);
    setTemplates(null);
    try {
      const r = await api<{ templates: Array<{ id: string; title: string }> }>("/api/studio/creatives/canva/templates");
      setTemplates(r.templates);
    } catch (e) {
      setEnterpriseError(e instanceof Error ? e.message : "Failed to load templates.");
    }
  };

  return (
    <div className="max-w-2xl space-y-4">
      {error && (
        <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      <div className="rounded-lg border border-stone-200 bg-white p-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-[14px] font-semibold text-stone-900">Canva connection</div>
            <div className="mt-0.5 text-[12.5px] text-stone-500">
              {status?.connected
                ? `Connected${status.canvaUserId ? ` · ${status.canvaUserId}` : ""}`
                : "Not connected — connect Canva to export PDF files into creatives."}
            </div>
          </div>
          {status?.connected ? (
            <button onClick={disconnect} disabled={busy} className={btnGhost}>
              {busy && <Loader2 size={14} className="animate-spin" />} Disconnect
            </button>
          ) : (
            <button onClick={connect} disabled={busy || !workspaceId} className={btnPrimary}>
              {busy && <Loader2 size={14} className="animate-spin" />} Connect Canva
            </button>
          )}
        </div>
        {status?.connected && status.scopes && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {status.scopes.map((s) => (
              <Chip key={s} tone="blue">{s}</Chip>
            ))}
          </div>
        )}
      </div>

      <div className="rounded-lg border border-stone-200 bg-white p-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-[14px] font-semibold text-stone-900">Brand templates</div>
            <div className="mt-0.5 text-[12.5px] text-stone-500">
              Autofill requires Canva Enterprise — otherwise you get a clean 409, never a fake success.
            </div>
          </div>
          <button onClick={loadTemplates} disabled={!status?.connected} className={btnGhost}>
            Load templates
          </button>
        </div>
        {enterpriseError && (
          <div className="mt-3 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] text-amber-800">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span>{enterpriseError}</span>
          </div>
        )}
        {templates && (
          <ul className="mt-3 space-y-1.5">
            {templates.map((t) => (
              <li key={t.id} className="rounded-md border border-stone-100 px-3 py-2 text-[13px] text-stone-700">
                {t.title}
              </li>
            ))}
            {templates.length === 0 && <li className="text-[13px] text-stone-400">No brand templates on this account.</li>}
          </ul>
        )}
      </div>

      <div className="rounded-lg border border-stone-200 bg-stone-50 p-4 text-[12.5px] text-stone-600">
        <span className="font-medium text-stone-800">Print-quality note. </span>
        The Canva Connect API exports a standard PDF (RGB) — it cannot add bleed/crop marks or convert to CMYK.
        For press-ready files with bleed and crop marks, download PDF Print manually in the Canva editor, then upload the PDF here (Upload PDF).
      </div>
    </div>
  );
}

// ── Studio app shell ─────────────────────────────────────────────────────────

const TABS = [
  { id: "creatives", label: "Creatives", icon: Palette },
  { id: "assets", label: "Assets", icon: FolderOpen },
  { id: "canva", label: "Canva connection", icon: Plug },
] as const;

export function StudioApp() {
  const [tab, setTab] = useState<(typeof TABS)[number]["id"]>("creatives");
  return (
    <div>
      <div className="mb-4 flex gap-1 border-b border-stone-200">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`flex items-center gap-1.5 border-b-2 px-3 py-2 text-[13.5px] font-medium transition ${
              tab === id
                ? "border-violet-600 text-violet-700"
                : "border-transparent text-stone-500 hover:text-stone-800"
            }`}
          >
            <Icon size={15} />
            {label}
          </button>
        ))}
      </div>
      {tab === "creatives" && <CreativesTab />}
      {tab === "assets" && <AssetsTab />}
      {tab === "canva" && <CanvaTab />}
    </div>
  );
}
