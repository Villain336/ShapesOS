// Marketr — Creative Studio home (Phase 4, T2).
// The central home for all creative and design work across Marketr.
// Tabs: [Creatives] [Designs] [Pages] [Assets] [QR codes].
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
  FileText,
  FileUp,
  FolderOpen,
  Loader2,
  Mail,
  Monitor,
  Palette,
  PenTool,
  Plus,
  QrCode,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import { GRAPES_TEMPLATES, type GrapesTemplateKind } from "@/lib/grapes/templates";
import {
  api,
  hashShort,
  type ChannelTemplate,
  type Creative,
  type ValidationReport,
} from "./api";
import { CreativeWizard, ValidationView } from "./CreativeWizard";
import { QrDesignerTab } from "./QrDesigner";
import { TEMPLATES } from "@/lib/design/templates";
import { confirmAction, toastError } from "@/lib/ui/feedback";
import { activateOnKey } from "@/lib/ui/keyboard";

// ── Small atoms ──────────────────────────────────────────────────────────────

function Chip({ children, tone = "slate" }: { children: React.ReactNode; tone?: "slate" | "violet" | "green" | "amber" | "red" | "blue" }) {
  const tones: Record<string, string> = {
    slate: "bg-canvas text-muted border-line",
    violet: "bg-canvas text-muted border-line",
    green: "bg-canvas text-muted border-line",
    amber: "bg-canvas text-muted border-line",
    red: "bg-failed-tint text-failed-text border-failed",
    blue: "bg-canvas text-muted border-line",
  };
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-1.5 py-0.5 text-[0.625rem] font-medium leading-tight ${tones[tone]}`}>
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
  "rounded-md border-[1.5px] border-control bg-paper px-2.5 py-1.5 text-[0.8125rem] text-ink placeholder:text-subtle focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)] focus-visible:outline-none";

const btnPrimary =
  "flex items-center gap-1.5 rounded-full bg-ink px-4 py-1.5 text-[0.8125rem] font-semibold text-white aos-press disabled:opacity-40";
const btnGhost =
  "flex items-center gap-1.5 rounded-full border border-line bg-paper px-3 py-1.5 text-[0.8125rem] font-medium text-ink shadow-outline hover:bg-hover-paper disabled:opacity-40";

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

      <div className="overflow-hidden rounded-lg border border-line bg-paper">
        <table className="w-full text-left text-[0.8125rem]">
          <thead>
            <tr className="border-b border-line bg-canvas text-[0.6875rem] font-semibold text-subtle">
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
                tabIndex={0}
                onKeyDown={activateOnKey(() => setSelectedId(c.id))}
                className={`cursor-pointer border-b border-line last:border-0 hover:bg-hover-paper ${selectedId === c.id ? "bg-hover-paper" : ""}`}
              >
                <td className="px-3 py-2 font-medium text-ink">{c.name}</td>
                <td className="px-3 py-2"><Chip tone="blue">{c.channelTemplate}</Chip></td>
                <td className="px-3 py-2 text-muted">
                  <Chip>{trackLabel(c.formatTrack)}</Chip> <span className="text-muted">{c.size}</span>
                </td>
                <td className="px-3 py-2 text-muted">{c.source}</td>
                <td className="px-3 py-2"><Chip tone="violet">v{c.version}</Chip></td>
                <td className="px-3 py-2 font-mono text-[0.6875rem] text-subtle">{hashShort(c.creativeHash)}</td>
                <td className="px-3 py-2"><Chip tone={statusTone(c.status)}>{c.status}</Chip></td>
              </tr>
            ))}
            {creatives.length === 0 && !loading && (
              <tr>
                <td colSpan={7} className="px-3 py-8 text-center text-[0.8125rem] text-subtle">
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
  const [attested, setAttested] = useState(false);

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

  const report: ValidationReport | null = c.validation;

  return (
    <div className="fixed inset-0 z-40">
      <div className="absolute inset-0 bg-night/30" onClick={onClose} aria-hidden />
      <div className="absolute right-0 top-0 flex h-full w-full max-w-md flex-col bg-white shadow-xl">
        <div className="flex items-start justify-between border-b border-line px-4 py-3.5">
          <div>
            <h3 className="text-[0.9375rem] font-semibold text-ink">{c.name}</h3>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <Chip tone={statusTone(c.status)}>{c.status}</Chip>
              <Chip tone="violet">v{c.version}</Chip>
              <Chip tone="blue">{c.channelTemplate}</Chip>
              <Chip>{trackLabel(c.formatTrack)} · {c.size}</Chip>
            </div>
            <div className="mt-1.5 font-mono text-[0.6875rem] text-subtle">
              hash {c.creativeHash ?? "—"}
            </div>
          </div>
          <button onClick={onClose} className="rounded-full p-1.5 text-subtle hover:bg-hover-paper hover:text-ink" aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
          {error && (
            <div className="flex items-start gap-2 rounded-md border border-failed bg-failed-tint px-3 py-2 text-[0.8125rem] text-failed-text">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {report ? <ValidationView report={report} /> : <p className="text-[0.8125rem] text-muted">No PDF attached yet.</p>}

          {c.pdfUrl && (
            <a href={c.pdfUrl} className={btnGhost} download>
              <Download size={14} /> Download PDF
            </a>
          )}

          {c.status === "draft" && (
            <div className="space-y-2 border-t border-line pt-3">
              <div className="text-[0.75rem] font-semibold text-subtle">Actions</div>
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
              </div>

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

              <label className="flex cursor-pointer items-start gap-2.5 rounded-md border border-line bg-canvas px-3 py-2.5">
                <input type="checkbox" checked={attested} onChange={(e) => setAttested(e.target.checked)} className="mt-0.5 accent-ink" />
                <span className="text-[0.78125rem] leading-snug text-ink">
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
                className="flex items-center gap-1.5 rounded-full bg-done px-4 py-1.5 text-[0.8125rem] font-semibold text-white aos-press disabled:opacity-40"
              >
                {busy === "ready" && <Loader2 size={14} className="animate-spin" />}
                <CheckCircle2 size={14} /> Mark ready
              </button>
            </div>
          )}

          {c.status === "ready" && (
            <div className="flex items-start gap-1.5 rounded-md border border-line bg-paper px-3 py-2 text-[0.78125rem] text-ink">
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
        <span className="text-[0.75rem] text-subtle">The asset library is per-project; creatives are workspace-wide.</span>
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {assets.map((a) => (
          <div key={a.id} className="overflow-hidden rounded-lg border border-line bg-paper">
            <div className="flex h-28 items-center justify-center bg-canvas">
              {a.mimeType?.startsWith("image/") ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={a.url} alt={a.name} className="max-h-full max-w-full object-contain" />
              ) : (
                <FolderOpen size={24} className="text-subtle" />
              )}
            </div>
            <div className="px-2.5 py-2">
              <div className="truncate text-[0.78125rem] font-medium text-ink">{a.name}</div>
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
                  className="rounded-full p-1 text-subtle hover:bg-failed-tint hover:text-failed-text"
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
        <p className="py-8 text-center text-[0.8125rem] text-subtle">No assets in this project yet.</p>
      )}
    </div>
  );
}

// ── Designs tab (Phase 11 "Canvas") ─────────────────────────────────────────

interface DesignSummary {
  id: string;
  name: string;
  thumbnail: string | null;
  templateKey: string | null;
  pageCount: number;
  elementCount: number;
  updatedAt: string;
}

function templateLabel(key: string | null): string {
  if (!key) return "Blank";
  return TEMPLATES.find((t) => t.key === key)?.name ?? key;
}

function NewDesignModal({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("");
  const [templateKey, setTemplateKey] = useState<string | null>("instagram-post");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ design: { id: string } }>("/api/studio/designs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: name.trim() || "Untitled design",
          ...(templateKey ? { templateKey } : {}),
        }),
      });
      window.location.href = `/dashboard/studio/designs/${r.design.id}`;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Create failed.");
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-night/40 p-4">
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <h2 className="text-[0.9375rem] font-semibold text-ink">New design</h2>
          <button onClick={onClose} className="rounded-full p-1.5 text-subtle hover:bg-hover-paper hover:text-ink" aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {error && (
            <div className="mb-4 flex items-start gap-2 rounded-md border border-failed bg-failed-tint px-3 py-2 text-[0.8125rem] text-failed-text">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <label className="mb-1 block text-[0.75rem] font-medium text-muted">Name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Untitled design"
            className={`${inputCls} mb-4 w-full`}
            maxLength={120}
          />

          <div className="mb-2 text-[0.75rem] font-medium text-muted">Start from</div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <button
              type="button"
              onClick={() => setTemplateKey(null)}
              className={`rounded-lg border p-3 text-left transition ${
                templateKey === null
                  ? "border-ink bg-hover-paper"
                  : "border-line hover:border-line-strong"
              }`}
            >
              <div className="text-[0.8125rem] font-medium text-ink">Blank canvas</div>
              <div className="mt-0.5 text-[0.6875rem] text-subtle">1080 × 1080</div>
            </button>
            {TEMPLATES.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setTemplateKey(t.key)}
                className={`rounded-lg border p-3 text-left transition ${
                  templateKey === t.key
                    ? "border-ink bg-hover-paper"
                    : "border-line hover:border-line-strong"
                }`}
              >
                <div className="flex items-center justify-between gap-1">
                  <div className="truncate text-[0.8125rem] font-medium text-ink">{t.name}</div>
                </div>
                <div className="mt-0.5 text-[0.6875rem] text-subtle">{t.width} × {t.height}</div>
                <div className="mt-1"><Chip tone="violet">{t.category}</Chip></div>
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3.5">
          <button onClick={onClose} className={btnGhost} disabled={busy}>Cancel</button>
          <button onClick={create} className={btnPrimary} disabled={busy}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
            Create design
          </button>
        </div>
      </div>
    </div>
  );
}

function DesignsTab() {
  const [designs, setDesigns] = useState<DesignSummary[]>([]);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api<{ designs: DesignSummary[] }>("/api/studio/designs");
      setDesigns(r.designs);
    } catch {
      // keep previous list on transient failure
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return designs;
    return designs.filter(
      (d) =>
        d.name.toLowerCase().includes(needle) ||
        templateLabel(d.templateKey).toLowerCase().includes(needle),
    );
  }, [designs, q]);

  const remove = async (d: DesignSummary, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!await confirmAction(`Delete “${d.name}”? This cannot be undone.`)) return;
    try {
      await api(`/api/studio/designs/${d.id}`, { method: "DELETE" });
      load();
    } catch (err) {
      toastError(err instanceof Error ? err.message : "Delete failed.");
    }
  };

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search designs…" className={`${inputCls} w-44`} />
        <div className="ml-auto">
          <button onClick={() => setModalOpen(true)} className={btnPrimary}>
            <Plus size={14} /> New design
          </button>
        </div>
      </div>

      <div className="overflow-hidden rounded-lg border border-line bg-paper">
        <table className="w-full text-left text-[0.8125rem]">
          <thead>
            <tr className="border-b border-line bg-canvas text-[0.6875rem] font-semibold text-subtle">
              <th className="px-3 py-2 font-medium">Name</th>
              <th className="px-3 py-2 font-medium">Template</th>
              <th className="px-3 py-2 font-medium">Pages</th>
              <th className="px-3 py-2 font-medium">Elements</th>
              <th className="px-3 py-2 font-medium">Updated</th>
              <th className="px-3 py-2 font-medium"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((d) => (
              <tr
                key={d.id}
                onClick={() => {
                  window.location.href = `/dashboard/studio/designs/${d.id}`;
                }}
                tabIndex={0}
                onKeyDown={activateOnKey(() => {
                  window.location.href = `/dashboard/studio/designs/${d.id}`;
                })}
                className="cursor-pointer border-b border-line last:border-0 hover:bg-hover-paper"
              >
                <td className="px-3 py-2 font-medium text-ink">{d.name}</td>
                <td className="px-3 py-2">
                  <Chip tone={d.templateKey ? "blue" : "slate"}>{templateLabel(d.templateKey)}</Chip>
                </td>
                <td className="px-3 py-2 text-muted">{d.pageCount}</td>
                <td className="px-3 py-2 text-muted">{d.elementCount}</td>
                <td className="px-3 py-2 text-muted">
                  {new Date(d.updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
                </td>
                <td className="px-3 py-2 text-right">
                  <button
                    onClick={(e) => remove(d, e)}
                    className="rounded-full p-1.5 text-subtle hover:bg-failed-tint hover:text-failed-text"
                    aria-label={`Delete ${d.name}`}
                  >
                    <Trash2 size={14} />
                  </button>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && !loading && (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-[0.8125rem] text-subtle">
                  {q ? "No designs match your search." : "No designs yet — create the first one with “New design”."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {modalOpen && <NewDesignModal onClose={() => setModalOpen(false)} />}
    </div>
  );
}

// ── Pages tab (Phase 12 "Pages" — GrapesJS) ──────────────────────────────────
// Responsive landing pages and email templates. Complementary to the Canvas
// (Designs) tab: Canvas makes PNG/SVG assets; Pages make HTML documents.

interface PageSummary {
  id: string;
  name: string;
  kind: string;
  templateKey: string | null;
  templateName: string | null;
  updatedAt: string;
}

function NewPageModal({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<GrapesTemplateKind>("landing");
  const [templateKey, setTemplateKey] = useState<string | null>("hero-saas");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const templates = useMemo(
    () => GRAPES_TEMPLATES.filter((t) => t.kind === kind),
    [kind],
  );

  useEffect(() => {
    setTemplateKey(templates[0]?.key ?? null);
  }, [templates]);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ page: { id: string } }>("/api/studio/pages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: name.trim() || "Untitled page",
          kind,
          ...(templateKey ? { templateKey } : {}),
        }),
      });
      window.location.href = `/dashboard/studio/pages/${r.page.id}`;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Create failed.");
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-night/40 p-4">
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <h2 className="text-[0.9375rem] font-semibold text-ink">New page</h2>
          <button onClick={onClose} className="rounded-full p-1.5 text-subtle hover:bg-hover-paper hover:text-ink" aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {error && (
            <div className="mb-4 flex items-start gap-2 rounded-md border border-failed bg-failed-tint px-3 py-2 text-[0.8125rem] text-failed-text">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <label className="mb-1 block text-[0.75rem] font-medium text-muted">Name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Untitled page"
            className={`${inputCls} mb-4 w-full`}
            maxLength={120}
          />

          <div className="mb-2 text-[0.75rem] font-medium text-muted">Page type</div>
          <div className="mb-4 flex gap-1 border-b border-line">
            {(
              [
                { id: "landing", label: "Landing page", icon: Monitor },
                { id: "email", label: "Email template", icon: Mail },
              ] as const
            ).map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                onClick={() => setKind(id)}
                className={`flex items-center gap-1.5 border-b-2 px-3 py-2 text-[0.84375rem] font-medium transition ${
                  kind === id
                    ? "border-ink text-ink"
                    : "border-transparent text-muted hover:text-ink"
                }`}
              >
                <Icon size={15} />
                {label}
              </button>
            ))}
          </div>

          <div className="mb-2 text-[0.75rem] font-medium text-muted">Start from</div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <button
              type="button"
              onClick={() => setTemplateKey(null)}
              className={`rounded-lg border p-3 text-left transition ${
                templateKey === null
                  ? "border-ink bg-hover-paper"
                  : "border-line hover:border-line-strong"
              }`}
            >
              <div className="text-[0.8125rem] font-medium text-ink">Blank page</div>
              <div className="mt-0.5 text-[0.6875rem] text-subtle">Empty canvas</div>
            </button>
            {templates.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setTemplateKey(t.key)}
                className={`rounded-lg border p-3 text-left transition ${
                  templateKey === t.key
                    ? "border-ink bg-hover-paper"
                    : "border-line hover:border-line-strong"
                }`}
              >
                <div className="truncate text-[0.8125rem] font-medium text-ink">{t.name}</div>
                <div className="mt-0.5 line-clamp-2 text-[0.6875rem] text-subtle">{t.description}</div>
                <div className="mt-1"><Chip tone="violet">{t.category}</Chip></div>
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3.5">
          <button onClick={onClose} className={btnGhost} disabled={busy}>Cancel</button>
          <button onClick={create} className={btnPrimary} disabled={busy}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
            Create page
          </button>
        </div>
      </div>
    </div>
  );
}

function PagesTab() {
  const [pages, setPages] = useState<PageSummary[]>([]);
  const [fKind, setFKind] = useState("");
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api<{ pages: PageSummary[] }>("/api/studio/pages");
      setPages(r.pages);
    } catch {
      // keep previous list on transient failure
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return pages.filter(
      (p) =>
        (!fKind || p.kind === fKind) &&
        (!needle ||
          p.name.toLowerCase().includes(needle) ||
          (p.templateName ?? "").toLowerCase().includes(needle)),
    );
  }, [pages, fKind, q]);

  const remove = async (p: PageSummary, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!await confirmAction(`Delete “${p.name}”? This cannot be undone.`)) return;
    try {
      await api(`/api/studio/pages/${p.id}`, { method: "DELETE" });
      load();
    } catch (err) {
      toastError(err instanceof Error ? err.message : "Delete failed.");
    }
  };

  return (
    <div>
      <div className="mb-3 rounded-lg border border-line bg-canvas px-3 py-2.5 text-[0.78125rem] text-muted">
        <span className="font-medium text-ink">Canvas vs Pages. </span>
        Designs (Canvas) produce PNG/SVG assets; Pages produce responsive HTML —
        landing pages and email templates. Build the hero in Canvas, drop the asset into a Page.
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <select value={fKind} onChange={(e) => setFKind(e.target.value)} className={inputCls}>
          <option value="">All types</option>
          <option value="landing">Landing pages</option>
          <option value="email">Email templates</option>
        </select>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search pages…" className={`${inputCls} w-44`} />
        <div className="ml-auto">
          <button onClick={() => setModalOpen(true)} className={btnPrimary}>
            <Plus size={14} /> New page
          </button>
        </div>
      </div>

      <div className="overflow-hidden rounded-lg border border-line bg-paper">
        <table className="w-full text-left text-[0.8125rem]">
          <thead>
            <tr className="border-b border-line bg-canvas text-[0.6875rem] font-semibold text-subtle">
              <th className="px-3 py-2 font-medium">Name</th>
              <th className="px-3 py-2 font-medium">Type</th>
              <th className="px-3 py-2 font-medium">Template</th>
              <th className="px-3 py-2 font-medium">Updated</th>
              <th className="px-3 py-2 font-medium"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((p) => (
              <tr
                key={p.id}
                onClick={() => {
                  window.location.href = `/dashboard/studio/pages/${p.id}`;
                }}
                tabIndex={0}
                onKeyDown={activateOnKey(() => {
                  window.location.href = `/dashboard/studio/pages/${p.id}`;
                })}
                className="cursor-pointer border-b border-line last:border-0 hover:bg-hover-paper"
              >
                <td className="px-3 py-2 font-medium text-ink">{p.name}</td>
                <td className="px-3 py-2">
                  <Chip tone={p.kind === "email" ? "amber" : "blue"}>
                    {p.kind === "email" ? "Email" : "Landing page"}
                  </Chip>
                </td>
                <td className="px-3 py-2">
                  <Chip tone={p.templateName ? "violet" : "slate"}>{p.templateName ?? "Blank"}</Chip>
                </td>
                <td className="px-3 py-2 text-muted">
                  {new Date(p.updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
                </td>
                <td className="px-3 py-2 text-right">
                  <button
                    onClick={(e) => remove(p, e)}
                    className="rounded-full p-1.5 text-subtle hover:bg-failed-tint hover:text-failed-text"
                    aria-label={`Delete ${p.name}`}
                  >
                    <Trash2 size={14} />
                  </button>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && !loading && (
              <tr>
                <td colSpan={5} className="px-3 py-8 text-center text-[0.8125rem] text-subtle">
                  {q || fKind ? "No pages match your filters." : "No pages yet — create the first one with “New page”."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {modalOpen && <NewPageModal onClose={() => setModalOpen(false)} />}
    </div>
  );
}

// ── Studio app shell ─────────────────────────────────────────────────────────

const TABS = [
  { id: "creatives", label: "Creatives", icon: Palette },
  { id: "designs", label: "Designs", icon: PenTool },
  { id: "pages", label: "Pages", icon: FileText },
  { id: "assets", label: "Assets", icon: FolderOpen },
  { id: "qr", label: "QR codes", icon: QrCode },
] as const;

export function StudioApp() {
  const [tab, setTab] = useState<(typeof TABS)[number]["id"]>("creatives");
  return (
    <div>
      <div className="mb-4 flex gap-1 border-b border-line">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`flex items-center gap-1.5 border-b-2 px-3 py-2 text-[0.84375rem] font-medium transition ${
              tab === id
                ? "border-ink text-ink"
                : "border-transparent text-muted hover:text-ink"
            }`}
          >
            <Icon size={15} />
            {label}
          </button>
        ))}
      </div>
      {tab === "creatives" && <CreativesTab />}
      {tab === "designs" && <DesignsTab />}
      {tab === "pages" && <PagesTab />}
      {tab === "assets" && <AssetsTab />}
      {tab === "qr" && <QrDesignerTab />}
    </div>
  );
}
