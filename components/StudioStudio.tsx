// Marketr — marketing studio: Canva Connect + Porkbun domains + asset library (milestone 22).
// Client island: Canva, Domains, Assets tabs.
// Motion language (better-ui / emil-design-eng): press scale 0.96, named
// transitions with cubic-bezier(0.2,0,0,1), 150ms tab fades, Lucide-only.

"use client";

import { useCallback, useEffect, useState } from "react";
import {
  TriangleAlert,
  Check,
  Download,
  SquareArrowOutUpRight,
  Globe,
  Image as ImageIcon,
  Layers,
  Link,
  LoaderCircle,
  Palette,
  Plug,
  RotateCw,
  Search,
  Send,
  Settings,
  Trash,
  XCircle,
} from "lucide-react";

interface Props {
  projectId: string;
  workspaceId: string;
  canEdit: boolean;
  isOwnerAdmin: boolean;
}

type Tab = "canva" | "domains" | "assets";

interface CanvaDesign {
  id: string;
  title: string;
  designType: string;
  thumbnailUrl: string | null;
  editUrl: string;
}

interface BrandTemplate {
  id: string;
  title: string;
  designType: string;
  thumbnailUrl: string | null;
  dataset: Array<{ name: string; type: string }> | null;
}

interface StudioDomain {
  id: string;
  domain: string;
  tld: string;
  status: string;
  priceUsd: number | null;
  orderId: string | null;
  whoisPrivacy: boolean;
  purchasedAt: string | null;
  nameServers: string[];
  errorDetail: string | null;
}

interface StudioAsset {
  id: string;
  name: string;
  source: string;
  url: string;
  mimeType: string | null;
  canvaDesignId: string | null;
  createdAt: string;
}

interface PurchasePreview {
  domain: string;
  priceUsd: number | null;
  renewalPriceUsd: number | null;
  confirmationToken: string;
  icannDisclosure: string;
  registrant: Record<string, string>;
}

async function api(path: string, init?: RequestInit) {
  const res = await fetch(path, init);
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(typeof body.error === "string" ? body.error : `Request failed (${res.status})`);
  return body;
}

export default function StudioStudio({ projectId, workspaceId, canEdit, isOwnerAdmin }: Props) {
  const [tab, setTab] = useState<Tab>("canva");
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  // Canva state
  const [canvaConnected, setCanvaConnected] = useState(false);
  const [designs, setDesigns] = useState<CanvaDesign[]>([]);
  const [designQuery, setDesignQuery] = useState("");
  const [folders, setFolders] = useState<Array<{ id: string; name: string }>>([]);
  const [folderId, setFolderId] = useState("");
  const [templates, setTemplates] = useState<BrandTemplate[]>([]);
  const [templatesPlanLimited, setTemplatesPlanLimited] = useState(false);
  const [exporting, setExporting] = useState<string | null>(null);
  // Brand-kit defaults (M12) for autofill prefill.
  const [brandDefaults, setBrandDefaults] = useState<{
    brandKitName: string;
    businessName: string | null;
    tagline: string | null;
    tone: string | null;
  } | null>(null);
  const [autofillTpl, setAutofillTpl] = useState<BrandTemplate | null>(null);
  const [autofillVals, setAutofillVals] = useState<Record<string, string>>({});
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [socialAsset, setSocialAsset] = useState<StudioAsset | null>(null);
  const [socialText, setSocialText] = useState("");

  // Domain state
  const [domains, setDomains] = useState<StudioDomain[]>([]);
  const [porkbunConfigured, setPorkbunConfigured] = useState(false);
  const [porkbunHint, setPorkbunHint] = useState<string | null>(null);
  const [searchDomain, setSearchDomain] = useState("");
  const [searchResult, setSearchResult] = useState<{
    domain: string;
    available: boolean;
    priceUsd: number | null;
    renewalPriceUsd: number | null;
    premium: boolean;
  } | null>(null);
  const [preview, setPreview] = useState<PurchasePreview | null>(null);
  const [registrant, setRegistrant] = useState<Record<string, string> | null>(null);
  const [agreeTerms, setAgreeTerms] = useState(false);

  // Asset state
  const [assets, setAssets] = useState<StudioAsset[]>([]);
  const [newAssetUrl, setNewAssetUrl] = useState("");
  const [newAssetName, setNewAssetName] = useState("");

  const press = "transition-transform duration-150 ease-[cubic-bezier(0.2,0,0,1)] active:scale-[0.96]";
  const fade = "transition-opacity duration-150 ease-[cubic-bezier(0.2,0,0,1)]";

  const ok = (text: string) => setNotice({ kind: "ok", text });
  const err = (e: unknown) => setNotice({ kind: "err", text: e instanceof Error ? e.message : "Something went wrong." });

  const refreshCanva = useCallback(async () => {
    const s = (await api(`/api/studio/canva/status?projectId=${projectId}`)) as {
      status: { connected: boolean };
    };
    setCanvaConnected(s.status.connected);
    if (s.status.connected) {
      const d = (await api(`/api/studio/canva/designs?projectId=${projectId}`)) as { designs: CanvaDesign[] };
      setDesigns(d.designs);
      const f = (await api(`/api/studio/canva/folders?projectId=${projectId}`)) as {
        folders: Array<{ id: string; name: string }>;
      };
      setFolders(f.folders);
      const t = (await api(`/api/studio/canva/brand-templates?projectId=${projectId}`)) as {
        templates: BrandTemplate[];
        planLimited: boolean;
      };
      setTemplates(t.templates);
      setTemplatesPlanLimited(t.planLimited);
      const bd = (await api(`/api/studio/canva/brand-defaults?projectId=${projectId}`)) as {
        defaults: {
          brandKitName: string;
          businessName: string | null;
          tagline: string | null;
          tone: string | null;
        } | null;
      };
      setBrandDefaults(bd.defaults);
    }
  }, [projectId]);

  const refreshDomains = useCallback(async () => {
    const s = (await api(`/api/studio/domains/settings?projectId=${projectId}`)) as {
      configured: boolean;
      hint: string | null;
    };
    setPorkbunConfigured(s.configured);
    setPorkbunHint(s.hint);
    const d = (await api(`/api/studio/domains?projectId=${projectId}`)) as { domains: StudioDomain[] };
    setDomains(d.domains);
    const r = (await api(`/api/studio/domains/registrant?projectId=${projectId}`)) as {
      registrant: Record<string, string> | null;
    };
    setRegistrant(r.registrant);
  }, [projectId]);

  const refreshAssets = useCallback(async () => {
    const a = (await api(`/api/studio/assets?projectId=${projectId}`)) as { assets: StudioAsset[] };
    setAssets(a.assets);
  }, [projectId]);

  useEffect(() => {
    refreshCanva().catch(err);
    refreshDomains().catch(err);
    refreshAssets().catch(err);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function run<T>(fn: () => Promise<T>, done?: (r: T) => void) {
    setBusy(true);
    setNotice(null);
    try {
      const r = await fn();
      if (done) done(r);
    } catch (e) {
      err(e);
    } finally {
      setBusy(false);
    }
  }

  // --- Canva actions ---
  async function connectCanva() {
    await run(async () => {
      const r = (await api("/api/studio/canva/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId }),
      })) as { authorizeUrl: string };
      window.location.href = r.authorizeUrl;
    });
  }

  async function disconnectCanva() {
    await run(async () => {
      await api("/api/studio/canva/disconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId }),
      });
      setCanvaConnected(false);
      setDesigns([]);
      setTemplates([]);
      ok("Canva disconnected.");
    });
  }

  async function searchDesigns() {
    await run(async () => {
      const q = new URLSearchParams({ projectId, query: designQuery });
      if (folderId) q.set("folderId", folderId);
      const d = (await api(`/api/studio/canva/designs?${q.toString()}`)) as { designs: CanvaDesign[] };
      setDesigns(d.designs);
    });
  }

  async function importDesignThumbnail(design: CanvaDesign) {
    await run(async () => {
      await api("/api/studio/assets/import-design", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, designId: design.id }),
      });
      await refreshAssets();
      ok("Design thumbnail imported to the asset library.");
    });
  }

  async function exportDesign(design: CanvaDesign, format: "png" | "jpg" | "pdf" | "mp4") {
    setExporting(design.id);
    try {
      const s = (await api("/api/studio/canva/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, designId: design.id, format }),
      })) as { exportId: string };
      // Poll the export job (bounded: ~12 polls).
      for (let i = 0; i < 12; i++) {
        await new Promise((r) => setTimeout(r, 1500));
        const j = (await api(
          `/api/studio/canva/export/${s.exportId}?projectId=${projectId}`,
        )) as { export: { status: string; downloadUrls: string[] } };
        if (j.export.status === "success" && j.export.downloadUrls.length > 0) {
          await api("/api/studio/assets/import-canva", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              projectId,
              name: design.title,
              downloadUrl: j.export.downloadUrls[0],
              designId: design.id,
              format,
            }),
          });
          await refreshAssets();
          ok(`“${design.title}” exported and added to the asset library.`);
          return;
        }
        if (j.export.status === "failed") throw new Error("Canva export failed.");
      }
      throw new Error("Export is taking too long — check the asset library later.");
    } catch (e) {
      err(e);
    } finally {
      setExporting(null);
    }
  }

  // Prefill heuristics: map template text fields to the workspace brand kit.
  function brandPrefill(fieldName: string): string {
    const n = fieldName.toLowerCase();
    if (/business|brand|company|organization/.test(n)) return brandDefaults?.businessName ?? "";
    if (/tagline|slogan|subtitle/.test(n)) return brandDefaults?.tagline ?? brandDefaults?.tone ?? "";
    return "";
  }

  function openAutofill(t: BrandTemplate) {
    const vals: Record<string, string> = {};
    for (const field of t.dataset ?? []) {
      if (field.type === "text") vals[field.name] = brandPrefill(field.name);
    }
    setAutofillVals(vals);
    setAutofillTpl(t);
  }

  async function submitAutofill() {
    if (!autofillTpl) return;
    await run(async () => {
      const data: Record<string, { type: "text"; text: string }> = {};
      for (const field of autofillTpl.dataset ?? []) {
        if (field.type !== "text") continue;
        const text = (autofillVals[field.name] ?? "").trim();
        if (!text) throw new Error(`Fill in “${field.name}” before autofill.`);
        data[field.name] = { type: "text", text };
      }
      const r = (await api("/api/studio/canva/autofill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, brandTemplateId: autofillTpl.id, data }),
      })) as { designId: string };
      setAutofillTpl(null);
      ok(`New design created from template: ${r.designId}.`);
      await refreshCanva();
    });
  }

  // --- Domain actions ---
  async function savePorkbunKeys(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    await run(async () => {
      const r = (await api("/api/studio/domains/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          apiKey: form.get("apiKey"),
          secretApiKey: form.get("secretApiKey"),
        }),
      })) as { hint: string };
      setPorkbunConfigured(true);
      setPorkbunHint(r.hint);
      ok("Porkbun keys saved.");
    });
  }

  async function searchAvailability() {
    await run(async () => {
      const r = (await api(
        `/api/studio/domains/search?projectId=${projectId}&domain=${encodeURIComponent(searchDomain)}`,
      )) as {
        availability: {
          domain: string;
          available: boolean;
          priceUsd: number | null;
          renewalPriceUsd: number | null;
          premium: boolean;
        };
      };
      setSearchResult(r.availability);
      setPreview(null);
    });
  }

  async function previewPurchase() {
    if (!searchResult) return;
    await run(async () => {
      const r = (await api("/api/studio/domains", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, domain: searchResult.domain }),
      })) as { preview: PurchasePreview };
      setPreview(r.preview);
      setAgreeTerms(false);
    });
  }

  async function confirmPurchase() {
    if (!preview) return;
    await run(async () => {
      const r = (await api("/api/studio/domains/purchase/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          confirmationToken: preview.confirmationToken,
          agreeToTerms: agreeTerms,
          whoisPrivacy: true,
        }),
      })) as { purchase: { domain: string; costUsd: number } };
      setPreview(null);
      setSearchResult(null);
      setSearchDomain("");
      await refreshDomains();
      ok(`Domain registered: ${r.purchase.domain} ($${r.purchase.costUsd.toFixed(2)}).`);
    });
  }

  async function saveRegistrant(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const fields = Object.fromEntries(
      ["firstName", "lastName", "email", "phone", "address", "city", "state", "zip", "country"].map((k) => [
        k,
        String(form.get(k) ?? ""),
      ]),
    );
    await run(async () => {
      const r = (await api("/api/studio/domains/registrant", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, ...fields }),
      })) as { registrant: Record<string, string> };
      setRegistrant(r.registrant);
      ok("Registrant contact saved.");
    });
  }

  // --- Asset actions ---
  async function addAsset(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    await run(async () => {
      await api("/api/studio/assets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, name: newAssetName || newAssetUrl, source: "upload", url: newAssetUrl }),
      });
      setNewAssetUrl("");
      setNewAssetName("");
      await refreshAssets();
      ok("Asset added to the library.");
    });
  }

  async function deleteAsset(id: string) {
    setDeleteTarget(id);
  }

  async function doDeleteAsset() {
    if (!deleteTarget) return;
    const id = deleteTarget;
    setDeleteTarget(null);
    await run(async () => {
      await api(`/api/studio/assets/${id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId }),
      });
      await refreshAssets();
      ok("Asset deleted.");
    });
  }

  function openUseInSocial(asset: StudioAsset) {
    setSocialAsset(asset);
    setSocialText("");
  }

  async function submitUseInSocial() {
    if (!socialAsset) return;
    const asset = socialAsset;
    await run(async () => {
      const r = (await api(`/api/studio/assets/${asset.id}/use-in-social`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, text: socialText, services: [] }),
      })) as { postId: string };
      void r;
      setSocialAsset(null);
      ok("Draft created in the social studio.");
    });
  }

  const tabs: Array<{ id: Tab; label: string; icon: React.ReactNode }> = [
    { id: "canva", label: "Canva", icon: <Palette className="h-4 w-4" /> },
    { id: "domains", label: "Domains", icon: <Globe className="h-4 w-4" /> },
    { id: "assets", label: "Assets", icon: <Layers className="h-4 w-4" /> },
  ];

  return (
    <div>
      {notice && (
        <div
          className={`mb-4 flex items-center gap-2 rounded-lg border px-4 py-2.5 text-sm ${fade} ${
            notice.kind === "ok"
              ? "border-emerald-200 bg-emerald-50/40 text-emerald-700"
              : "border-red-200 bg-red-50/40 text-red-700"
          }`}
        >
          {notice.kind === "ok" ? <Check className="h-4 w-4" /> : <TriangleAlert className="h-4 w-4" />}
          {notice.text}
        </div>
      )}

      <div className="mb-6 flex flex-wrap gap-1 border-b border-zinc-200">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex items-center gap-1.5 border-b-2 px-3 py-2 text-[13.5px] font-medium transition-colors ${press} ${
              tab === t.id ? "border-violet-600 text-violet-700" : "border-transparent text-stone-500 hover:text-stone-800"
            }`}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </div>

      {/* CANVA */}
      {tab === "canva" && (
        <div className={fade}>
          {!canvaConnected ? (
            <div className="rounded-xl border border-dashed border-zinc-200 p-10 text-center">
              <Palette className="mx-auto mb-3 h-8 w-8 text-zinc-500" />
              <h3 className="mb-1 font-medium text-zinc-800">Connect Canva</h3>
              <p className="mx-auto mb-5 max-w-md text-sm text-zinc-500">
                Browse your designs, export them into Marketr, and autofill brand templates — without
                leaving the studio.
              </p>
              {canEdit ? (
                <button
                  onClick={connectCanva}
                  disabled={busy}
                  className={`inline-flex items-center gap-2 rounded-lg bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 ${press}`}
                >
                  {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Plug className="h-4 w-4" />}
                  Connect Canva
                </button>
              ) : (
                <p className="text-sm text-zinc-500">An editor can connect the Canva account.</p>
              )}
            </div>
          ) : (
            <div>
              <div className="mb-6 flex items-center justify-between rounded-xl border border-zinc-200 bg-zinc-50 p-4">
                <div className="flex items-center gap-3">
                  <span className="flex h-2 w-2 rounded-full bg-emerald-400" />
                  <span className="text-sm text-zinc-500">Canva connected</span>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => run(refreshCanva)}
                    className={`rounded-md border border-zinc-200 px-3 py-1.5 text-sm text-zinc-500 ${press}`}
                  >
                    <RotateCw className="h-4 w-4" />
                  </button>
                  {canEdit && (
                    <button
                      onClick={disconnectCanva}
                      className={`inline-flex items-center gap-2 rounded-md border border-zinc-200 px-3 py-1.5 text-sm text-zinc-500 ${press}`}
                    >
                      <XCircle className="h-4 w-4" /> Disconnect
                    </button>
                  )}
                </div>
              </div>

              {/* Brand templates */}
              <h3 className="mb-3 text-sm font-semibold uppercase tracking-widest text-zinc-500">
                Brand templates
              </h3>
              {templatesPlanLimited && (
                <p className="mb-4 rounded-lg border border-amber-200 bg-amber-50/40 px-4 py-2.5 text-sm text-amber-700">
                  No brand templates are visible on this Canva plan — autofill needs a plan with brand
                  templates (typically Pro/Teams/Enterprise).
                </p>
              )}
              {templates.length > 0 && (
                <div className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {templates.map((t) => (
                    <div key={t.id} className="rounded-xl border border-zinc-200 bg-zinc-50 p-4">
                      {t.thumbnailUrl && (
                        <img
                          src={t.thumbnailUrl}
                          alt={t.title}
                          className="mb-3 aspect-video w-full rounded-lg object-cover outline outline-1 outline-[oklch(0_0_0/0.1)]"
                        />
                      )}
                      <p className="text-sm font-medium text-zinc-800">{t.title}</p>
                      <p className="mb-3 text-xs text-zinc-500">{t.designType}</p>
                      {canEdit && (
                        <button
                          onClick={() => openAutofill(t)}
                          className={`rounded-md border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-800 ${press}`}
                        >
                          Autofill template
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* Designs */}
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <h3 className="text-sm font-semibold uppercase tracking-widest text-zinc-500">
                  Your designs
                </h3>
                <div className="flex gap-2">
                  <input
                    value={designQuery}
                    onChange={(e) => setDesignQuery(e.target.value)}
                    placeholder="Search designs…"
                    className="rounded-md border border-zinc-200 bg-zinc-50 px-3 py-1.5 text-sm text-zinc-800"
                  />
                  {folders.length > 0 && (
                    <select
                      value={folderId}
                      onChange={(e) => setFolderId(e.target.value)}
                      className="rounded-md border border-zinc-200 bg-zinc-50 px-2 py-1.5 text-sm text-zinc-500"
                    >
                      <option value="">All folders</option>
                      {folders.map((f) => (
                        <option key={f.id} value={f.id}>
                          {f.name}
                        </option>
                      ))}
                    </select>
                  )}
                  <button
                    onClick={searchDesigns}
                    className={`rounded-md border border-zinc-200 px-3 py-1.5 text-sm text-zinc-500 ${press}`}
                  >
                    <Search className="h-4 w-4" />
                  </button>
                </div>
              </div>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {designs.map((d) => (
                  <div key={d.id} className="rounded-xl border border-zinc-200 bg-zinc-50 p-4">
                    {d.thumbnailUrl && (
                      <img
                        src={d.thumbnailUrl}
                        alt={d.title}
                        className="mb-3 aspect-video w-full rounded-lg object-cover outline outline-1 outline-[oklch(0_0_0/0.1)]"
                      />
                    )}
                    <p className="text-sm font-medium text-zinc-800">{d.title}</p>
                    <p className="mb-3 text-xs text-zinc-500">{d.designType}</p>
                    <div className="flex flex-wrap gap-2">
                      <a
                        href={d.editUrl}
                        target="_blank"
                        rel="noreferrer"
                        className={`inline-flex items-center gap-1 rounded-md border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-800 ${press}`}
                      >
                        <SquareArrowOutUpRight className="h-3 w-3" /> Open in Canva
                      </a>
                      {canEdit && (
                        <>
                          <button
                            onClick={() => exportDesign(d, "png")}
                            disabled={exporting === d.id}
                            className={`inline-flex items-center gap-1 rounded-md bg-zinc-100 px-3 py-1.5 text-xs font-medium text-zinc-900 ${press}`}
                          >
                            {exporting === d.id ? (
                              <LoaderCircle className="h-3 w-3 animate-spin" />
                            ) : (
                              <Download className="h-3 w-3" />
                            )}
                            Export PNG
                          </button>
                          <button
                            onClick={() => exportDesign(d, "pdf")}
                            disabled={exporting === d.id}
                            className={`inline-flex items-center gap-1 rounded-md border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-800 ${press}`}
                          >
                            PDF
                          </button>
                          {d.thumbnailUrl && (
                            <button
                              onClick={() => importDesignThumbnail(d)}
                              title="Save the design's thumbnail + metadata to the asset library"
                              className={`inline-flex items-center gap-1 rounded-md border border-zinc-200 px-3 py-1.5 text-xs text-zinc-500 ${press}`}
                            >
                              <ImageIcon className="h-3 w-3" /> Import thumbnail
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>
              {designs.length === 0 && (
                <p className="rounded-xl border border-dashed border-zinc-200 p-8 text-center text-sm text-zinc-500">
                  No designs found.
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {/* DOMAINS */}
      {tab === "domains" && (
        <div className={fade}>
          {!isOwnerAdmin && (
            <p className="mb-4 rounded-lg border border-amber-200 bg-amber-50/40 px-4 py-2.5 text-sm text-amber-700">
              Domain purchasing needs an owner or admin role. Availability search and the domain list
              are still visible.
            </p>
          )}

          {/* Porkbun keys */}
          {isOwnerAdmin && (
            <div className="mb-6 rounded-xl border border-zinc-200 bg-zinc-50 p-5">
              <h3 className="mb-1 flex items-center gap-2 text-sm font-semibold text-zinc-800">
                <Settings className="h-4 w-4" /> Porkbun API keys
              </h3>
              <p className="mb-4 text-sm text-zinc-500">
                {porkbunConfigured
                  ? `Connected (${porkbunHint ?? "key set"}). Get keys at Porkbun → Account → API Access.`
                  : "Bring your own Porkbun API keys — they are encrypted at rest and never shown again."}
              </p>
              <form onSubmit={savePorkbunKeys} className="flex flex-wrap gap-2">
                <input
                  name="apiKey"
                  type="password"
                  placeholder="API key"
                  autoComplete="off"
                  className="w-56 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-800"
                />
                <input
                  name="secretApiKey"
                  type="password"
                  placeholder="Secret API key"
                  autoComplete="off"
                  className="w-56 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-800"
                />
                <button
                  type="submit"
                  disabled={busy}
                  className={`rounded-md bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 ${press}`}
                >
                  Save keys
                </button>
              </form>
            </div>
          )}

          {/* Search */}
          {porkbunConfigured && (
            <div className="mb-6 rounded-xl border border-zinc-200 bg-zinc-50 p-5">
              <h3 className="mb-3 text-sm font-semibold text-zinc-800">Check availability</h3>
              <div className="flex gap-2">
                <input
                  value={searchDomain}
                  onChange={(e) => setSearchDomain(e.target.value)}
                  placeholder="yourdomain.com"
                  className="flex-1 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-800"
                />
                <button
                  onClick={searchAvailability}
                  disabled={busy || !searchDomain.trim()}
                  className={`rounded-md bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 ${press}`}
                >
                  Search
                </button>
              </div>
              {searchResult && (
                <div className="mt-4 rounded-lg border border-zinc-200 p-4">
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-zinc-900">{searchResult.domain}</span>
                    <span
                      className={`rounded-full px-3 py-1 text-xs font-medium ${
                        searchResult.available
                          ? "bg-emerald-50 text-emerald-700"
                          : "bg-zinc-100 text-zinc-500"
                      }`}
                    >
                      {searchResult.available ? "Available" : "Taken"}
                    </span>
                  </div>
                  {searchResult.available && searchResult.priceUsd != null && (
                    <div className="mt-2 text-sm text-zinc-500">
                      ${searchResult.priceUsd.toFixed(2)}/yr registration
                      {searchResult.renewalPriceUsd != null &&
                        searchResult.renewalPriceUsd !== searchResult.priceUsd && (
                          <span> · ${searchResult.renewalPriceUsd.toFixed(2)}/yr renewal</span>
                        )}
                      {searchResult.renewalPriceUsd != null &&
                        searchResult.renewalPriceUsd === searchResult.priceUsd && (
                          <span> · renews at ${searchResult.renewalPriceUsd.toFixed(2)}/yr</span>
                        )}
                    </div>
                  )}
                  {searchResult.available && isOwnerAdmin && !preview && (
                    <button
                      onClick={previewPurchase}
                      className={`mt-3 rounded-md bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 ${press}`}
                    >
                      Buy this domain
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Purchase preview / double confirmation */}
          {preview && (
            <div className="mb-6 rounded-xl border border-amber-200 bg-amber-50/20 p-5">
              <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-amber-800">
                <TriangleAlert className="h-4 w-4" /> Confirm purchase
              </h3>
              <p className="mb-1 text-lg font-semibold text-zinc-900">{preview.domain}</p>
              <p className="mb-3 text-sm text-zinc-500">
                ${preview.priceUsd?.toFixed(2)}/yr registration
                {preview.renewalPriceUsd != null && ` · $${preview.renewalPriceUsd.toFixed(2)}/yr renewal`}
              </p>
              <p className="mb-2 text-xs uppercase tracking-widest text-zinc-500">Registrant</p>
              <p className="mb-3 text-sm text-zinc-500">
                {preview.registrant.firstName} {preview.registrant.lastName} · {preview.registrant.email} ·{" "}
                {preview.registrant.address}, {preview.registrant.city} {preview.registrant.zip},{" "}
                {preview.registrant.country}
              </p>
              <p className="mb-4 rounded-lg border border-zinc-200 bg-zinc-50 p-3 text-xs leading-relaxed text-zinc-500">
                {preview.icannDisclosure}
              </p>
              <label className="mb-4 flex cursor-pointer items-start gap-2 text-sm text-zinc-500">
                <input
                  type="checkbox"
                  checked={agreeTerms}
                  onChange={(e) => setAgreeTerms(e.target.checked)}
                  className="mt-1"
                />
                I agree to the registration terms and confirm this purchase. This charges my Porkbun
                account.
              </label>
              <div className="flex gap-2">
                <button
                  onClick={confirmPurchase}
                  disabled={busy || !agreeTerms}
                  className={`rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-40 ${press}`}
                >
                  {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : "Confirm purchase"}
                </button>
                <button
                  onClick={() => setPreview(null)}
                  className={`rounded-md border border-zinc-200 px-4 py-2 text-sm text-zinc-500 ${press}`}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Registrant */}
          {isOwnerAdmin && (
            <div className="mb-6 rounded-xl border border-zinc-200 bg-zinc-50 p-5">
              <h3 className="mb-1 text-sm font-semibold text-zinc-800">Registrant contact</h3>
              <p className="mb-4 text-sm text-zinc-500">
                Required before any purchase. Porkbun registers with your account&apos;s default
                contact; this is your review copy and audit record.
              </p>
              <form onSubmit={saveRegistrant} className="grid gap-2 sm:grid-cols-2">
                {[
                  ["firstName", "First name"],
                  ["lastName", "Last name"],
                  ["email", "Email"],
                  ["phone", "Phone"],
                  ["address", "Address"],
                  ["city", "City"],
                  ["state", "State"],
                  ["zip", "ZIP"],
                  ["country", "Country"],
                ].map(([k, label]) => (
                  <input
                    key={k}
                    name={k}
                    defaultValue={registrant?.[k] ?? (k === "country" ? "US" : "")}
                    placeholder={label}
                    className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-800"
                  />
                ))}
                <div className="sm:col-span-2">
                  <button
                    type="submit"
                    disabled={busy}
                    className={`rounded-md border border-zinc-200 px-4 py-2 text-sm font-medium text-zinc-800 ${press}`}
                  >
                    Save registrant
                  </button>
                </div>
              </form>
            </div>
          )}

          {/* Domain list */}
          <h3 className="mb-3 text-sm font-semibold uppercase tracking-widest text-zinc-500">
            Project domains
          </h3>
          {domains.length === 0 ? (
            <p className="rounded-xl border border-dashed border-zinc-200 p-8 text-center text-sm text-zinc-500">
              No domains yet. Search above to register one through Porkbun.
            </p>
          ) : (
            <div className="grid gap-3">
              {domains.map((d) => (
                <div
                  key={d.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-zinc-200 bg-zinc-50 p-4"
                >
                  <div>
                    <p className="font-medium text-zinc-900">{d.domain}</p>
                    <p className="text-xs text-zinc-500">
                      {d.status}
                      {d.priceUsd != null && ` · $${d.priceUsd.toFixed(2)}`}
                      {d.purchasedAt && ` · bought ${new Date(d.purchasedAt).toLocaleDateString()}`}
                      {d.nameServers.length > 0 && ` · ${d.nameServers.join(", ")}`}
                    </p>
                    {d.errorDetail && <p className="text-xs text-red-600">{d.errorDetail}</p>}
                  </div>
                  <span
                    className={`rounded-full px-3 py-1 text-xs font-medium ${
                      d.status === "registered"
                        ? "bg-emerald-50 text-emerald-700"
                        : d.status === "failed"
                          ? "bg-red-50 text-red-700"
                          : "bg-zinc-100 text-zinc-500"
                    }`}
                  >
                    {d.status}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ASSETS */}
      {tab === "assets" && (
        <div className={fade}>
          {canEdit && (
            <form onSubmit={addAsset} className="mb-6 flex flex-wrap gap-2 rounded-xl border border-zinc-200 bg-zinc-50 p-4">
              <input
                value={newAssetName}
                onChange={(e) => setNewAssetName(e.target.value)}
                placeholder="Name"
                className="w-48 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-800"
              />
              <input
                value={newAssetUrl}
                onChange={(e) => setNewAssetUrl(e.target.value)}
                placeholder="https://… image or file URL"
                className="flex-1 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-800"
              />
              <button
                type="submit"
                disabled={busy || !newAssetUrl.trim()}
                className={`rounded-md bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 ${press}`}
              >
                Add asset
              </button>
            </form>
          )}
          {assets.length === 0 ? (
            <p className="rounded-xl border border-dashed border-zinc-200 p-8 text-center text-sm text-zinc-500">
              No assets yet. Export a Canva design above or add a URL.
            </p>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {assets.map((a) => (
                <div key={a.id} className="rounded-xl border border-zinc-200 bg-zinc-50 p-4">
                  <div className="mb-3 flex h-32 items-center justify-center overflow-hidden rounded-lg bg-white outline outline-1 outline-[oklch(0_0_0/0.1)]">
                    {a.mimeType?.startsWith("image/") || /\.(png|jpe?g|gif|webp|svg)$/i.test(a.url) ? (
                      <img src={a.url} alt={a.name} className="max-h-full object-contain" />
                    ) : (
                      <ImageIcon className="h-8 w-8 text-zinc-600" />
                    )}
                  </div>
                  <p className="text-sm font-medium text-zinc-800">{a.name}</p>
                  <p className="mb-3 text-xs capitalize text-zinc-500">{a.source}</p>
                  <div className="flex flex-wrap gap-2">
                    <a
                      href={a.url}
                      target="_blank"
                      rel="noreferrer"
                      className={`inline-flex items-center gap-1 rounded-md border border-zinc-200 px-3 py-1.5 text-xs text-zinc-800 ${press}`}
                    >
                      <Link className="h-3 w-3" /> Open
                    </a>
                    {canEdit && (
                      <>
                        <button
                          onClick={() => openUseInSocial(a)}
                          className={`inline-flex items-center gap-1 rounded-md bg-zinc-100 px-3 py-1.5 text-xs font-medium text-zinc-900 ${press}`}
                        >
                          <Send className="h-3 w-3" /> Use in social post
                        </button>
                        <button
                          onClick={() => deleteAsset(a.id)}
                          className={`rounded-md border border-zinc-200 px-3 py-1.5 text-xs text-zinc-500 ${press}`}
                        >
                          <Trash className="h-3 w-3" />
                        </button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {/* Autofill editor */}
      {autofillTpl && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className={`w-full max-w-lg rounded-2xl border border-zinc-200 bg-zinc-50 p-6 ${fade}`}>
            <h3 className="text-base font-semibold text-zinc-900">Autofill “{autofillTpl.title}”</h3>
            <p className="mt-1 text-xs text-zinc-500">
              Text fields are prefilled from your brand kit
              {brandDefaults ? ` “${brandDefaults.brandKitName}”` : ""} where the field name matches —
              edit anything before creating the design.
            </p>
            <div className="mt-4 space-y-3">
              {(autofillTpl.dataset ?? [])
                .filter((f) => f.type === "text")
                .map((f) => (
                  <label key={f.name} className="block">
                    <span className="mb-1 block text-xs font-medium text-zinc-500">{f.name}</span>
                    <input
                      value={autofillVals[f.name] ?? ""}
                      onChange={(e) => setAutofillVals((v) => ({ ...v, [f.name]: e.target.value }))}
                      className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900"
                    />
                  </label>
                ))}
              {(autofillTpl.dataset ?? []).some((f) => f.type !== "text") && (
                <p className="text-xs text-zinc-500">
                  Image/chart fields are autofilled in Canva — add them when editing the new design.
                </p>
              )}
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <button
                onClick={() => setAutofillTpl(null)}
                className={`rounded-md border border-zinc-200 px-4 py-2 text-sm text-zinc-500 ${press}`}
              >
                Cancel
              </button>
              <button
                onClick={submitAutofill}
                disabled={busy}
                className={`rounded-md bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 ${press}`}
              >
                Create design
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Delete confirmation */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className={`w-full max-w-sm rounded-2xl border border-zinc-200 bg-zinc-50 p-6 ${fade}`}>
            <h3 className="text-base font-semibold text-zinc-900">Delete this asset?</h3>
            <p className="mt-1 text-sm text-zinc-500">
              This removes it from the asset library. Posts already using it keep their copy.
            </p>
            <div className="mt-6 flex justify-end gap-2">
              <button
                onClick={() => setDeleteTarget(null)}
                className={`rounded-md border border-zinc-200 px-4 py-2 text-sm text-zinc-500 ${press}`}
              >
                Cancel
              </button>
              <button
                onClick={doDeleteAsset}
                disabled={busy}
                className={`rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white ${press}`}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Use in social post */}
      {socialAsset && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className={`w-full max-w-lg rounded-2xl border border-zinc-200 bg-zinc-50 p-6 ${fade}`}>
            <h3 className="text-base font-semibold text-zinc-900">Use in social post</h3>
            <p className="mt-1 text-xs text-zinc-500">
              Creates a draft in the social studio with “{socialAsset.name}” attached.
            </p>
            <label className="mt-4 block">
              <span className="mb-1 block text-xs font-medium text-zinc-500">Post text</span>
              <textarea
                value={socialText}
                onChange={(e) => setSocialText(e.target.value)}
                rows={4}
                placeholder="Write the post…"
                className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900"
              />
            </label>
            <div className="mt-6 flex justify-end gap-2">
              <button
                onClick={() => setSocialAsset(null)}
                className={`rounded-md border border-zinc-200 px-4 py-2 text-sm text-zinc-500 ${press}`}
              >
                Cancel
              </button>
              <button
                onClick={submitUseInSocial}
                disabled={busy}
                className={`rounded-md bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 ${press}`}
              >
                Create draft
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
