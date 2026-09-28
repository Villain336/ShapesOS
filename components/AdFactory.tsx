// Marketr — ad factory studio (milestone 21).
// Client island: Campaigns, Generate (brief → variants), Gallery (review),
// Settings (BYO Higgsfield key + spend cap) tabs.
// Motion language (better-ui / emil-design-eng): press scale 0.96, named
// transitions with cubic-bezier(0.2, 0, 0, 1), 150ms tab fades, Lucide-only,
// image outlines for depth, transform+opacity only.

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  TriangleAlert,
  Check,
  Download,
  Clapperboard,
  Image as ImageIcon,
  Key,
  LoaderCircle,
  Megaphone,
  Pencil,
  Plug,
  Plus,
  RotateCw,
  Send,
  Settings,
  Zap,
  Trash,
  Wallet,
  X,
  XCircle,
} from "lucide-react";
import {
  ASPECT_RATIOS,
  CHANNEL_FORMATS,
  ESTIMATED_COST_CENTS,
  MAX_VARIANTS,
  type AspectRatio,
} from "@/lib/ads/brief";

export interface StudioBrandKit {
  id: string;
  name: string;
}

export interface StudioCreative {
  id: string;
  campaignId: string;
  name: string;
  type: "image" | "video";
  brief: Record<string, string>;
  prompt: string;
  promptHistory: { prompt: string; at: string }[];
  status: "queued" | "generating" | "ready" | "failed" | "cancelled";
  aspectRatio: string;
  channels: string[];
  costEstimateCents: number;
  costActualCents: number;
  assets: { url: string; variantIndex: number }[];
  error: string | null;
  approved: boolean;
  rejected: boolean;
  createdAt: string;
}

export interface StudioCampaign {
  id: string;
  name: string;
  objective: string | null;
  brandKitId: string | null;
  channels: string[];
  creatives: StudioCreative[];
  spend: { estimated: number; actual: number; count: number };
  _count: { creatives: number };
}

interface Settings {
  connected: boolean;
  hint: string | null;
  capCents: number;
  spend: { period: string; spendCents: number; capCents: number; remainingCents: number; atCap: boolean };
}

interface Props {
  projectId: string;
  campaigns: StudioCampaign[];
  brandKits: StudioBrandKit[];
  settings: Settings;
  canEdit: boolean;
}

type Tab = "campaigns" | "generate" | "gallery" | "settings";

const STATUS_STYLE: Record<string, string> = {
  queued: "bg-zinc-100 text-zinc-500",
  generating: "bg-blue-50 text-blue-700",
  ready: "bg-emerald-50 text-emerald-700",
  failed: "bg-red-50 text-red-700",
  cancelled: "bg-white text-zinc-500",
};

const CHANNELS = Object.keys(CHANNEL_FORMATS);
const EASE = "cubic-bezier(0.2, 0, 0, 1)";

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function StatusBadge({ status }: { status: string }) {
  const generating = status === "generating" || status === "queued";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium transition-colors duration-150 ${STATUS_STYLE[status] ?? "bg-zinc-100 text-zinc-500"}`}
      style={{ transitionTimingFunction: EASE }}
    >
      {generating && <LoaderCircle className="h-3 w-3 animate-spin" />}
      {status}
    </span>
  );
}

export default function AdFactory({ projectId, campaigns: initial, brandKits, settings: initialSettings, canEdit }: Props) {
  const [tab, setTab] = useState<Tab>("campaigns");
  const [campaigns, setCampaigns] = useState<StudioCampaign[]>(initial);
  const [settings, setSettings] = useState<Settings>(initialSettings);
  const [activeCampaignId, setActiveCampaignId] = useState<string | null>(initial[0]?.id ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const activeCampaign = useMemo(
    () => campaigns.find((c) => c.id === activeCampaignId) ?? null,
    [campaigns, activeCampaignId],
  );

  const inFlight = useMemo(
    () => campaigns.some((c) => c.creatives.some((cr) => cr.status === "queued" || cr.status === "generating")),
    [campaigns],
  );

  const refreshCampaigns = useCallback(async () => {
    try {
      const res = await fetch(`/api/ads/campaigns?projectId=${projectId}`);
      const data = await res.json();
      if (res.ok) setCampaigns(data.campaigns ?? []);
    } catch {
      // refresh is best-effort
    }
  }, [projectId]);

  const refreshSettings = useCallback(async () => {
    try {
      const res = await fetch(`/api/ads/settings?projectId=${projectId}`);
      const data = await res.json();
      if (res.ok) setSettings(data);
    } catch {
      // best-effort
    }
  }, [projectId]);

  // Auto-refresh while jobs are in flight (15s cadence, stops when done).
  useEffect(() => {
    if (!inFlight) return;
    const t = setInterval(() => {
      void refreshCampaigns();
    }, 15000);
    return () => clearInterval(t);
  }, [inFlight, refreshCampaigns]);

  useEffect(() => {
    setError(null);
    setNotice(null);
  }, [tab]);

  async function mutate(path: string, method: string, body?: unknown) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(path, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
      return data;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed.");
      return null;
    } finally {
      setBusy(false);
    }
  }

  // ---- campaigns -----------------------------------------------------------
  const [newName, setNewName] = useState("");
  const [editing, setEditing] = useState<StudioCampaign | null>(null);

  async function createCampaign() {
    if (!newName.trim()) return;
    const data = await mutate("/api/ads/campaigns", "POST", { projectId, name: newName.trim() });
    if (data?.campaign) {
      setNewName("");
      setNotice("Campaign created.");
      await refreshCampaigns();
      setActiveCampaignId(data.campaign.id);
    }
  }

  async function saveCampaignEdit() {
    if (!editing) return;
    const data = await mutate(`/api/ads/campaigns/${editing.id}`, "PATCH", {
      projectId,
      name: editing.name,
      objective: editing.objective,
      brandKitId: editing.brandKitId,
      channels: editing.channels,
    });
    if (data?.campaign) {
      setEditing(null);
      setNotice("Campaign updated.");
      await refreshCampaigns();
    }
  }

  async function deleteCampaign(id: string) {
    if (!window.confirm("Delete this campaign and all its creatives? This cannot be undone.")) return;
    const data = await mutate(`/api/ads/campaigns/${id}?projectId=${projectId}`, "DELETE");
    if (data?.ok) {
      setNotice("Campaign deleted.");
      if (activeCampaignId === id) setActiveCampaignId(null);
      await refreshCampaigns();
    }
  }

  // ---- brief / generate ----------------------------------------------------
  const [brief, setBrief] = useState({ product: "", audience: "", hook: "", offer: "", cta: "", tone: "", negativePrompt: "" });
  const [genType, setGenType] = useState<"image" | "video">("image");
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>("1:1");
  const [genChannels, setGenChannels] = useState<string[]>(["instagram"]);
  const [variants, setVariants] = useState(4);
  const [referenceImageUrl, setReferenceImageUrl] = useState("");

  const liveEstimate = ESTIMATED_COST_CENTS[genType] * variants;

  async function generate() {
    if (!activeCampaignId) {
      setError("Create and select a campaign first.");
      return;
    }
    const data = await mutate("/api/ads/creatives", "POST", {
      projectId,
      campaignId: activeCampaignId,
      brief: {
        product: brief.product.trim(),
        audience: brief.audience.trim(),
        hook: brief.hook.trim(),
        offer: brief.offer.trim() || undefined,
        cta: brief.cta.trim(),
        tone: brief.tone.trim() || undefined,
        negativePrompt: brief.negativePrompt.trim() || undefined,
      },
      type: genType,
      aspectRatio,
      channels: genChannels,
      variants,
      referenceImageUrl: referenceImageUrl.trim() || undefined,
    });
    if (data) {
      setNotice(`Generating ${data.created} variant(s) — ~${dollars(data.costEstimateCents)} estimated.`);
      setTab("gallery");
      await refreshCampaigns();
    }
  }

  // ---- gallery actions -----------------------------------------------------
  const [regenPrompt, setRegenPrompt] = useState<string | null>(null);
  const [regenId, setRegenId] = useState<string | null>(null);
  const [sendTarget, setSendTarget] = useState<StudioCreative | null>(null);
  const [sendText, setSendText] = useState("");
  // Wave B: Postiz channels for the send-to-social draft (replaces the old
  // Buffer service keys). Loaded when the modal opens.
  const [sendChannelIds, setSendChannelIds] = useState<string[]>([]);
  const [postizChannels, setPostizChannels] = useState<Array<{ id: string; name: string | null; identifier: string }>>([]);
  const [postizChannelsLoading, setPostizChannelsLoading] = useState(false);

  async function openSendModal(creative: StudioCreative) {
    setSendTarget(creative);
    setSendText("");
    setSendChannelIds([]);
    setPostizChannelsLoading(true);
    try {
      const res = await fetch("/api/integrations/postiz/channels");
      const data = await res.json().catch(() => ({}));
      if (res.ok && Array.isArray(data.channels)) setPostizChannels(data.channels);
    } catch {
      setPostizChannels([]);
    } finally {
      setPostizChannelsLoading(false);
    }
  }

  async function creativeAction(id: string, action: "approve" | "reject" | "cancel") {
    const data = await mutate(`/api/ads/creatives/${id}`, "PATCH", { projectId, action });
    if (data?.creative) {
      setNotice(action === "approve" ? "Creative approved." : action === "reject" ? "Creative rejected." : "Generation cancelled.");
      await refreshCampaigns();
    }
  }

  async function regenerate(id: string) {
    const data = await mutate(`/api/ads/creatives/${id}/regenerate`, "POST", {
      projectId,
      prompt: regenPrompt?.trim() || undefined,
    });
    if (data?.creative) {
      setRegenId(null);
      setRegenPrompt(null);
      setNotice("Regeneration started — the previous prompt is preserved in history.");
      await refreshCampaigns();
    }
  }

  async function sendToSocial() {
    if (!sendTarget || sendChannelIds.length === 0) return;
    const platformTypes: Record<string, string> = {};
    for (const c of postizChannels) if (sendChannelIds.includes(c.id) && c.identifier) platformTypes[c.id] = c.identifier;
    const data = await mutate(`/api/ads/creatives/${sendTarget.id}/send-to-social`, "POST", {
      projectId,
      text: sendText,
      channelIds: sendChannelIds,
      platformTypes,
    });
    if (data?.postizRef) {
      setSendTarget(null);
      setSendText("");
      setSendChannelIds([]);
      setNotice("Draft created in Postiz — find it under Social.");
    }
  }

  // ---- settings ------------------------------------------------------------
  const [keyInput, setKeyInput] = useState("");
  const [capInput, setCapInput] = useState(String(initialSettings.capCents / 100));

  async function saveKey() {
    const data = await mutate("/api/ads/settings", "POST", { projectId, key: keyInput });
    if (data?.connected) {
      setKeyInput("");
      setNotice("Higgsfield API key saved (encrypted).");
      await refreshSettings();
    }
  }

  async function revokeKey() {
    if (!window.confirm("Revoke the Higgsfield API key? In-flight jobs will stop being polled.")) return;
    const data = await mutate(`/api/ads/settings?projectId=${projectId}`, "DELETE");
    if (data) {
      setNotice("API key revoked.");
      await refreshSettings();
    }
  }

  async function saveCap() {
    const cents = Math.round(Number(capInput) * 100);
    if (!Number.isFinite(cents) || cents < 0) {
      setError("Cap must be a non-negative dollar amount.");
      return;
    }
    const data = await mutate("/api/ads/settings", "PATCH", { projectId, monthlyCapCents: cents });
    if (data?.ok) {
      setNotice("Monthly spend cap updated.");
      await refreshSettings();
    }
  }

  const tabs: { key: Tab; label: string; icon: React.ReactNode }[] = [
    { key: "campaigns", label: "Campaigns", icon: <Megaphone className="h-4 w-4" /> },
    { key: "generate", label: "Generate", icon: <Zap className="h-4 w-4" /> },
    { key: "gallery", label: "Gallery", icon: <ImageIcon className="h-4 w-4" /> },
    { key: "settings", label: "Settings", icon: <Settings className="h-4 w-4" /> },
  ];

  const btnPrimary =
    "inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-[background-color,transform] duration-150 ease-[cubic-bezier(0.2,0,0,1)] hover:bg-accent-hover active:scale-[0.96] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2";
  const btnGhost =
    "inline-flex items-center gap-2 rounded-lg border border-zinc-200 px-3 py-1.5 text-sm text-zinc-800 transition-[background-color,border-color,color,transform] duration-150 hover:border-zinc-400 active:scale-[0.96] disabled:opacity-50";
  const field =
    "w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 transition-colors duration-150 focus:border-accent focus:outline-none";
  const label = "mb-1 block text-xs font-medium uppercase tracking-wide text-zinc-500";

  return (
    <div>
      {/* Tabs */}
      <div className="mb-6 flex gap-1 border-b border-zinc-200">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-medium transition-[background-color,border-color,color,transform] duration-150 active:scale-[0.96] ${
              tab === t.key
                ? "border-accent text-accent-ink"
                : "border-transparent text-zinc-500 hover:text-zinc-800"
            }`}
            style={{ transitionTimingFunction: EASE }}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </div>

      {/* Flash messages */}
      <div key={tab} className="transition-opacity duration-150" style={{ transitionTimingFunction: EASE }}>
        {error && (
          <div className="mb-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50/50 px-4 py-3 text-sm text-red-700">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            {error}
          </div>
        )}
        {notice && (
          <div className="mb-4 flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50/50 px-4 py-3 text-sm text-emerald-800">
            <Check className="mt-0.5 h-4 w-4 shrink-0" />
            {notice}
          </div>
        )}

        {tab === "campaigns" && (
          <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
            <div className="space-y-3">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">Campaigns</h2>
              {campaigns.map((c) => (
                <button
                  key={c.id}
                  onClick={() => setActiveCampaignId(c.id)}
                  className={`w-full rounded-xl border p-4 text-left transition-[background-color,border-color,color,transform] duration-150 active:scale-[0.98] ${
                    activeCampaignId === c.id ? "border-accent bg-accent-tint" : "border-zinc-200 bg-zinc-50 hover:border-zinc-300"
                  }`}
                  style={{ transitionTimingFunction: EASE }}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium text-zinc-900">{c.name}</span>
                    <span className="shrink-0 text-xs text-zinc-500">{c._count.creatives} creatives</span>
                  </div>
                  <div className="mt-1 text-xs text-zinc-500">
                    Est {dollars(c.spend.estimated)} · Actual {dollars(c.spend.actual)}
                  </div>
                </button>
              ))}
              {canEdit && (
                <div className="flex gap-2">
                  <input
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="New campaign name"
                    className={field}
                    onKeyDown={(e) => e.key === "Enter" && void createCampaign()}
                  />
                  <button onClick={() => void createCampaign()} disabled={busy || !newName.trim()} className={btnPrimary} aria-label="Create campaign">
                    <Plus className="h-4 w-4" />
                  </button>
                </div>
              )}
              {campaigns.length === 0 && (
                <p className="text-sm text-zinc-500">No campaigns yet — create one to start generating ads.</p>
              )}
            </div>

            <div>
              {activeCampaign ? (
                <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-5">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h3 className="text-lg font-semibold text-zinc-900">{activeCampaign.name}</h3>
                      {activeCampaign.objective && <p className="mt-1 text-sm text-zinc-500">{activeCampaign.objective}</p>}
                      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                        <span>
                          Brand kit:{" "}
                          <span className={activeCampaign.brandKitId ? "text-emerald-700" : "text-amber-700"}>
                            {brandKits.find((k) => k.id === activeCampaign.brandKitId)?.name ?? "none — required for generation"}
                          </span>
                        </span>
                        {activeCampaign.channels.length > 0 && <span>· {activeCampaign.channels.join(", ")}</span>}
                      </div>
                    </div>
                    {canEdit && (
                      <div className="flex gap-2">
                        <button onClick={() => setEditing(activeCampaign)} className={btnGhost} aria-label="Edit campaign">
                          <Pencil className="h-4 w-4" />
                        </button>
                        <button onClick={() => void deleteCampaign(activeCampaign.id)} className={btnGhost} aria-label="Delete campaign">
                          <Trash className="h-4 w-4" />
                        </button>
                      </div>
                    )}
                  </div>
                  <div className="mt-4 grid grid-cols-3 gap-3">
                    {[
                      { label: "Creatives", value: String(activeCampaign.spend.count) },
                      { label: "Est. spend", value: dollars(activeCampaign.spend.estimated) },
                      { label: "Actual spend", value: dollars(activeCampaign.spend.actual) },
                    ].map((s) => (
                      <div key={s.label} className="rounded-lg border border-zinc-300 bg-white p-3">
                        <div className="text-xs text-zinc-500">{s.label}</div>
                        <div className="mt-0.5 text-lg font-semibold text-zinc-900 tabular-nums">{s.value}</div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <p className="text-sm text-zinc-500">Select a campaign to see details.</p>
              )}
            </div>
          </div>
        )}

        {tab === "generate" && (
          <div className="max-w-2xl">
            {!activeCampaign && (
              <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50/40 px-4 py-3 text-sm text-amber-800">
                Select a campaign first (Campaigns tab).
              </div>
            )}
            {activeCampaign && !activeCampaign.brandKitId && (
              <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50/40 px-4 py-3 text-sm text-amber-800">
                <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                This campaign has no brand kit — generation is blocked until you assign one (edit the campaign).
              </div>
            )}
            {!settings.connected && (
              <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50/40 px-4 py-3 text-sm text-amber-800">
                <Key className="mt-0.5 h-4 w-4 shrink-0" />
                No Higgsfield API key configured — add one in Settings before generating.
              </div>
            )}
            {settings.spend.atCap && (
              <div className="mb-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50/50 px-4 py-3 text-sm text-red-700">
                <Wallet className="mt-0.5 h-4 w-4 shrink-0" />
                Monthly spend cap reached ({dollars(settings.spend.capCents)}). Raise it in Settings to generate more.
              </div>
            )}

            <div className="space-y-4 rounded-xl border border-zinc-200 bg-zinc-50 p-5">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">Ad brief</h3>
              {[
                { key: "product", label: "Product", placeholder: "What are you advertising?" },
                { key: "audience", label: "Audience", placeholder: "Who is this for?" },
                { key: "hook", label: "Hook", placeholder: "The opening line or angle" },
                { key: "offer", label: "Offer (optional)", placeholder: "20% off, free trial, …" },
                { key: "cta", label: "Call to action", placeholder: "Shop now, Book a call, …" },
                { key: "tone", label: "Tone (optional)", placeholder: "Defaults to the brand kit's tone" },
              ].map((f) => (
                <div key={f.key}>
                  <label className={label}>{f.label}</label>
                  <input
                    value={(brief as Record<string, string>)[f.key]}
                    onChange={(e) => setBrief({ ...brief, [f.key]: e.target.value })}
                    placeholder={f.placeholder}
                    className={field}
                    disabled={!canEdit}
                  />
                </div>
              ))}
              <div>
                <label className={label}>Negative prompt (optional)</label>
                <input
                  value={brief.negativePrompt}
                  onChange={(e) => setBrief({ ...brief, negativePrompt: e.target.value })}
                  placeholder="Things to avoid in the creative"
                  className={field}
                  disabled={!canEdit}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className={label}>Type</label>
                  <div className="flex gap-2">
                    {(["image", "video"] as const).map((t) => (
                      <button
                        key={t}
                        onClick={() => setGenType(t)}
                        disabled={!canEdit}
                        className={`flex flex-1 items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm transition-[background-color,border-color,color,transform] duration-150 active:scale-[0.96] ${
                          genType === t ? "border-violet-600 bg-violet-600 text-white" : "border-zinc-200 text-zinc-500 hover:border-zinc-400"
                        }`}
                        style={{ transitionTimingFunction: EASE }}
                      >
                        {t === "image" ? <ImageIcon className="h-4 w-4" /> : <Clapperboard className="h-4 w-4" />}
                        {t}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className={label}>Aspect ratio</label>
                  <div className="flex flex-wrap gap-2">
                    {(Object.keys(ASPECT_RATIOS) as AspectRatio[]).map((r) => (
                      <button
                        key={r}
                        onClick={() => setAspectRatio(r)}
                        disabled={!canEdit}
                        title={ASPECT_RATIOS[r].label}
                        className={`rounded-lg border px-3 py-2 text-sm transition-[background-color,border-color,color,transform] duration-150 active:scale-[0.96] ${
                          aspectRatio === r ? "border-violet-600 bg-violet-600 text-white" : "border-zinc-200 text-zinc-500 hover:border-zinc-400"
                        }`}
                        style={{ transitionTimingFunction: EASE }}
                      >
                        {r}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div>
                <label className={label}>Target channels</label>
                <div className="flex flex-wrap gap-2">
                  {CHANNELS.map((ch) => (
                    <button
                      key={ch}
                      onClick={() =>
                        setGenChannels(genChannels.includes(ch) ? genChannels.filter((c) => c !== ch) : [...genChannels, ch])
                      }
                      disabled={!canEdit}
                      className={`rounded-full border px-3 py-1 text-xs transition-[background-color,border-color,color,transform] duration-150 active:scale-[0.96] ${
                        genChannels.includes(ch) ? "border-violet-600 bg-violet-600 text-white" : "border-zinc-200 text-zinc-500 hover:border-zinc-400"
                      }`}
                      style={{ transitionTimingFunction: EASE }}
                    >
                      {ch}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className={label}>
                  Variants: {variants} · estimated {dollars(liveEstimate)}
                </label>
                <input
                  type="range"
                  min={1}
                  max={MAX_VARIANTS}
                  value={variants}
                  onChange={(e) => setVariants(Number(e.target.value))}
                  disabled={!canEdit}
                  className="w-full accent-white"
                />
              </div>

              {genType === "video" && (
                <div>
                  <label className={label}>Reference image URL (optional — enables the verified image-to-video route)</label>
                  <input
                    value={referenceImageUrl}
                    onChange={(e) => setReferenceImageUrl(e.target.value)}
                    placeholder="https://…"
                    className={field}
                    disabled={!canEdit}
                  />
                </div>
              )}

              <button
                onClick={() => void generate()}
                disabled={busy || !canEdit || !activeCampaign || !activeCampaign.brandKitId || !settings.connected || settings.spend.atCap}
                className={btnPrimary}
              >
                {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />}
                Generate {variants} variant{variants === 1 ? "" : "s"} (~{dollars(liveEstimate)})
              </button>
              <p className="text-xs text-zinc-500">
                Estimates are illustrative — actual spend is recorded from provider responses. Every generation is an
                explicit action; nothing regenerates on its own.
              </p>
            </div>
          </div>
        )}

        {tab === "gallery" && (
          <div>
            {!activeCampaign && <p className="text-sm text-zinc-500">Select a campaign to review its creatives.</p>}
            {activeCampaign && activeCampaign.creatives.length === 0 && (
              <p className="text-sm text-zinc-500">No creatives yet — generate some from the Generate tab.</p>
            )}
            {activeCampaign && (
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {activeCampaign.creatives.map((cr, i) => (
                  <div
                    key={cr.id}
                    className="overflow-hidden rounded-xl border border-zinc-200 bg-zinc-50"
                    style={{ animation: `adfade 200ms ${EASE} ${Math.min(i, 6) * 50}ms both` }}
                  >
                    <div className="relative aspect-square bg-white">
                      {cr.assets.length > 0 ? (
                        cr.type === "video" ? (
                          <video src={cr.assets[0].url} controls className="h-full w-full object-cover outline outline-1 outline-white/10" />
                        ) : (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={cr.assets[0].url} alt={cr.name} className="h-full w-full object-cover outline outline-1 outline-black/10" />
                        )
                      ) : (
                        <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-zinc-500">
                          {cr.status === "failed" ? <XCircle className="h-8 w-8" /> : <LoaderCircle className="h-8 w-8 animate-spin" />}
                          <span className="px-4 text-center text-xs">{cr.error ?? "Generating…"}</span>
                        </div>
                      )}
                      <div className="absolute left-2 top-2 flex gap-1">
                        <StatusBadge status={cr.status} />
                        {cr.approved && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
                            <Check className="h-3 w-3" /> approved
                          </span>
                        )}
                        {cr.rejected && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700">
                            rejected
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="p-4">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-sm font-medium text-zinc-900">{cr.name}</span>
                        <span className="shrink-0 text-xs text-zinc-500 tabular-nums">
                          {cr.type} · {cr.aspectRatio} · {dollars(cr.costActualCents || cr.costEstimateCents)}
                        </span>
                      </div>
                      <p className="mt-1 line-clamp-2 text-xs text-zinc-500" title={cr.prompt}>
                        {cr.prompt}
                      </p>
                      {canEdit && (
                        <div className="mt-3 flex flex-wrap gap-1.5">
                          {cr.status === "ready" && !cr.approved && (
                            <button onClick={() => void creativeAction(cr.id, "approve")} disabled={busy} className={btnGhost}>
                              <Check className="h-3.5 w-3.5" /> Approve
                            </button>
                          )}
                          {cr.status === "ready" && !cr.rejected && (
                            <button onClick={() => void creativeAction(cr.id, "reject")} disabled={busy} className={btnGhost}>
                              <X className="h-3.5 w-3.5" /> Reject
                            </button>
                          )}
                          {(cr.status === "ready" || cr.status === "failed") && (
                            <button
                              onClick={() => {
                                setRegenId(cr.id);
                                setRegenPrompt(cr.prompt);
                              }}
                              disabled={busy}
                              className={btnGhost}
                            >
                              <RotateCw className="h-3.5 w-3.5" /> Regenerate
                            </button>
                          )}
                          {(cr.status === "queued" || cr.status === "generating") && (
                            <button onClick={() => void creativeAction(cr.id, "cancel")} disabled={busy} className={btnGhost}>
                              <X className="h-3.5 w-3.5" /> Cancel
                            </button>
                          )}
                          {cr.status === "ready" && cr.approved && cr.assets.length > 0 && (
                            <>
                              <a
                                href={cr.assets[0].url}
                                target="_blank"
                                rel="noreferrer"
                                download
                                className={btnGhost}
                              >
                                <Download className="h-3.5 w-3.5" /> Download
                              </a>
                              <button
                                onClick={() => {
                                  setSendText(`${cr.brief.hook ?? ""} ${cr.brief.cta ?? ""}`.trim());
                                  void openSendModal(cr);
                                }}
                                className={btnGhost}
                              >
                                <Send className="h-3.5 w-3.5" /> To social
                              </button>
                            </>
                          )}
                        </div>
                      )}
                      {cr.promptHistory.length > 0 && (
                        <details className="mt-2 text-xs text-zinc-500">
                          <summary className="cursor-pointer hover:text-zinc-600">
                            Prompt history ({cr.promptHistory.length})
                          </summary>
                          <ul className="mt-1 space-y-1">
                            {cr.promptHistory.map((h, j) => (
                              <li key={j} className="rounded bg-white p-2">
                                <span className="text-zinc-500">{h.at}</span>
                                <p className="mt-0.5">{h.prompt}</p>
                              </li>
                            ))}
                          </ul>
                        </details>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {tab === "settings" && (
          <div className="max-w-xl space-y-6">
            <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-5">
              <h3 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-zinc-500">
                <Plug className="h-4 w-4" /> Higgsfield API key
              </h3>
              {settings.connected ? (
                <div className="mt-3 flex items-center justify-between gap-3">
                  <span className="text-sm text-emerald-700">Connected · {settings.hint}</span>
                  {canEdit && (
                    <button onClick={() => void revokeKey()} disabled={busy} className={btnGhost}>
                      Revoke
                    </button>
                  )}
                </div>
              ) : (
                <div className="mt-3">
                  <label className={label}>API key (KEY_ID:KEY_SECRET) — stored encrypted, never shown again</label>
                  <div className="flex gap-2">
                    <input
                      type="password"
                      value={keyInput}
                      onChange={(e) => setKeyInput(e.target.value)}
                      placeholder="Paste key"
                      className={field}
                      disabled={!canEdit}
                    />
                    <button onClick={() => void saveKey()} disabled={busy || !keyInput.trim() || !canEdit} className={btnPrimary}>
                      Save
                    </button>
                  </div>
                </div>
              )}
              <p className="mt-2 text-xs text-zinc-500">
                Auth header format: <code className="text-zinc-500">Authorization: Key KEY_ID:KEY_SECRET</code>. The
                provider&apos;s image-generation model catalog should be confirmed via{" "}
                <code className="text-zinc-500">GET /models</code> before production image jobs.
              </p>
            </div>

            <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-5">
              <h3 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-zinc-500">
                <Wallet className="h-4 w-4" /> Spend & cap
              </h3>
              <div className="mt-3">
                <div className="flex justify-between text-sm">
                  <span className="text-zinc-500">
                    {settings.spend.period} · spent {dollars(settings.spend.spendCents)} of {dollars(settings.spend.capCents)}
                  </span>
                  <span className="text-zinc-500 tabular-nums">{dollars(settings.spend.remainingCents)} left</span>
                </div>
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-zinc-100">
                  <div
                    className={`h-full rounded-full transition-[width,background-color] duration-300 ${settings.spend.atCap ? "bg-red-500" : "bg-emerald-500"}`}
                    style={{
                      width: `${Math.min(100, (settings.spend.spendCents / Math.max(1, settings.spend.capCents)) * 100)}%`,
                      transitionTimingFunction: EASE,
                    }}
                  />
                </div>
              </div>
              {canEdit && (
                <div className="mt-4 flex gap-2">
                  <input
                    value={capInput}
                    onChange={(e) => setCapInput(e.target.value)}
                    placeholder="Monthly cap (USD)"
                    inputMode="decimal"
                    className={field}
                  />
                  <button onClick={() => void saveCap()} disabled={busy} className={btnPrimary}>
                    Set cap
                  </button>
                </div>
              )}
              <p className="mt-2 text-xs text-zinc-500">
                The cap is enforced server-side: new generations are blocked once it&apos;s reached. Default $50/month.
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Regenerate modal */}
      {regenId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="w-full max-w-lg rounded-xl border border-zinc-200 bg-zinc-50 p-5">
            <h3 className="text-sm font-semibold text-zinc-900">Regenerate with edited prompt</h3>
            <p className="mt-1 text-xs text-zinc-500">The current prompt is preserved in history.</p>
            <textarea
              value={regenPrompt ?? ""}
              onChange={(e) => setRegenPrompt(e.target.value)}
              rows={6}
              className={`${field} mt-3 font-mono text-xs`}
            />
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => setRegenId(null)} className={btnGhost}>
                Cancel
              </button>
              <button onClick={() => void regenerate(regenId)} disabled={busy} className={btnPrimary}>
                Regenerate
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Send-to-social modal */}
      {sendTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="w-full max-w-lg rounded-xl border border-zinc-200 bg-zinc-50 p-5">
            <h3 className="text-sm font-semibold text-zinc-900">Send to social</h3>
            <p className="mt-1 text-xs text-zinc-500">Creates a Postiz draft with this creative — publish it from the Social tab.</p>
            <label className={`${label} mt-4`}>Post text</label>
            <textarea value={sendText} onChange={(e) => setSendText(e.target.value)} rows={3} className={field} />
            <label className={`${label} mt-4`}>Postiz channels</label>
            {postizChannelsLoading ? (
              <p className="text-xs text-zinc-500">Loading channels…</p>
            ) : postizChannels.length === 0 ? (
              <p className="text-xs text-zinc-500">No Postiz channels connected — connect one under Social first.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {postizChannels.map((ch) => (
                  <button
                    key={ch.id}
                    onClick={() => setSendChannelIds(sendChannelIds.includes(ch.id) ? sendChannelIds.filter((c) => c !== ch.id) : [...sendChannelIds, ch.id])}
                    className={`rounded-full border px-3 py-1 text-xs transition-[background-color,border-color,color,transform] duration-150 active:scale-[0.96] ${
                      sendChannelIds.includes(ch.id) ? "border-violet-600 bg-violet-600 text-white" : "border-zinc-200 text-zinc-500"
                    }`}
                    style={{ transitionTimingFunction: EASE }}
                  >
                    {ch.name ?? ch.identifier}
                  </button>
                ))}
              </div>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => setSendTarget(null)} className={btnGhost}>
                Cancel
              </button>
              <button onClick={() => void sendToSocial()} disabled={busy || !sendText.trim() || sendChannelIds.length === 0} className={btnPrimary}>
                <Send className="h-4 w-4" /> Create draft
              </button>
            </div>
          </div>
        </div>
      )}

      <style>{`@keyframes adfade { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }`}</style>
    </div>
  );
}
