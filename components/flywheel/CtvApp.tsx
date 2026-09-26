// Marketr — CTV buying path UI (Phase 7 F4).
// Client island: campaign list (API vs concierge labeled), creative
// validator, per-spot QR/pURL kit, concierge IO workflow states (alert-only
// copy enforced), probabilistic attribution views.
//
// Concierge paths are labeled alert-only everywhere; no deterministic ROAS
// is rendered anywhere.

"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/vault/shadcn/button";
import { Input } from "@/components/vault/shadcn/input";
import { Label } from "@/components/vault/shadcn/label";
import {
  Megaphone, ShieldCheck, QrCode, FileText, BarChart3,
  PauseCircle, AlertTriangle, CheckCircle2, XCircle, Loader2,
} from "lucide-react";

type Tab = "campaigns" | "validator" | "spots" | "io" | "attribution";

const TABS: { id: Tab; label: string; icon: typeof Megaphone }[] = [
  { id: "campaigns", label: "Campaigns", icon: Megaphone },
  { id: "validator", label: "Creative validator", icon: ShieldCheck },
  { id: "spots", label: "Spot QR/pURL kit", icon: QrCode },
  { id: "io", label: "Concierge IO", icon: FileText },
  { id: "attribution", label: "Attribution", icon: BarChart3 },
];

interface Campaign {
  id: string;
  name: string;
  platform: string;
  mode: string;
  status: string;
  approvalObjectId: string | null;
  vibeTestMode: boolean;
  vibeCampaignId: string | null;
}

const PLATFORM_LABELS: Record<string, string> = {
  vibe: "Vibe.co (API)",
  mntn: "MNTN (concierge)",
  roku: "Roku Ads Manager (concierge)",
  tatari: "Tatari (concierge)",
  tvscientific: "tvScientific (concierge)",
  "seat:ttd": "The Trade Desk (BYO seat)",
  "seat:dv360": "DV360 (BYO seat)",
  "seat:amazon": "Amazon DSP (BYO seat)",
  "seat:basis": "Basis (BYO seat)",
};

const ALERT_ONLY_COPY = "Marketr cannot pause this buy — alerts only.";

async function api(path: string, init?: RequestInit) {
  const res = await fetch(path, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error((data.error as string) ?? `Request failed (${res.status})`);
  return data;
}

function chip(text: React.ReactNode, cls: string) {
  return (
    <span className={`inline-flex items-center gap-0.5 whitespace-nowrap rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-tight ${cls}`}>
      {text}
    </span>
  );
}

function statusChip(s: string) {
  if (s === "live" || s === "human_placed") return chip(s, "border-emerald-200 bg-emerald-50 text-emerald-700");
  if (s === "pending_vendor_approval" || s === "reconciling") return chip(s, "border-amber-200 bg-amber-50 text-amber-700");
  if (s === "cancelled") return chip(s, "border-red-200 bg-red-50 text-red-700");
  return chip(s, "border-stone-200 bg-stone-100 text-stone-600");
}

const HI = "border-stone-200 bg-white text-[13px] placeholder:text-stone-400 focus-visible:border-violet-400 focus-visible:ring-violet-200/60";
const HSELECT = "rounded-md border border-stone-200 bg-white px-3 py-2 text-[13px] text-stone-800 focus-visible:border-violet-400 focus-visible:outline-none";
const HLABEL = "text-[13px] font-medium text-stone-700";

function Panel({ title, description, action, children }: {
  title: string; description?: string; action?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-stone-200 bg-white p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold tracking-tight text-stone-900">{title}</h2>
          {description && <p className="mt-0.5 text-xs text-stone-500">{description}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

export function CtvApp() {
  const [tab, setTab] = useState<Tab>("campaigns");

  return (
    <div className="flex h-full flex-col gap-4">
      <div className="flex gap-1 overflow-x-auto border-b border-stone-200">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`-mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-[13px] font-medium transition ${
              tab === id
                ? "border-violet-600 text-violet-700"
                : "border-transparent text-stone-500 hover:border-stone-300 hover:text-stone-800"
            }`}
          >
            <Icon className="h-4 w-4" />
            {label}
          </button>
        ))}
      </div>
      <div className="mt-1">
        {tab === "campaigns" && <CampaignsTab />}
        {tab === "validator" && <ValidatorTab />}
        {tab === "spots" && <SpotsTab />}
        {tab === "io" && <IoTab />}
        {tab === "attribution" && <AttributionTab />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- campaigns

function CampaignsTab() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [form, setForm] = useState({ name: "", platform: "vibe", mode: "api", approvalObjectId: "", vibeAdvertiserId: "" });
  const [pausing, setPausing] = useState<string | null>(null);
  const [pauseNote, setPauseNote] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await api("/api/flywheel/ctv/campaigns");
      setCampaigns((data.campaigns as Campaign[]) ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  async function create() {
    setError("");
    try {
      const data = await api("/api/flywheel/ctv/campaigns", {
        method: "POST",
        body: JSON.stringify({
          name: form.name,
          platform: form.platform,
          mode: form.mode,
          approvalObjectId: form.approvalObjectId || undefined,
          vibeAdvertiserId: form.vibeAdvertiserId || undefined,
        }),
      });
      const c = data.campaign as Campaign;
      const detail = await api(`/api/flywheel/ctv/campaigns/${c.id}`);
      setCampaigns((prev) => [detail.campaign as Campaign, ...prev]);
      setForm({ name: "", platform: "vibe", mode: "api", approvalObjectId: "", vibeAdvertiserId: "" });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function pause(id: string) {
    setPausing(id);
    setPauseNote("");
    try {
      const data = await api(`/api/flywheel/ctv/campaigns/${id}/pause`, {
        method: "POST",
        body: JSON.stringify({ reason: "Manual pause from CTV dashboard" }),
      });
      if (data.alertOnly) {
        setPauseNote(`${ALERT_ONLY_COPY} ${(data.alert as { humanAction?: string })?.humanAction ?? ""}`);
      } else {
        setPauseNote(`Paused via ${(data.via as string) ?? "adapter"}${(data.testMode as boolean) ? " (test mode — no real spend touched)" : ""}.`);
        setCampaigns((prev) => prev.map((c) => (c.id === id ? { ...c, status: "paused" } : c)));
      }
    } catch (e) {
      setPauseNote(e instanceof Error ? e.message : String(e));
    } finally {
      setPausing(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-[13px] text-red-900">
          <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      <Panel
        title="New CTV campaign"
        description="Vibe adapter runs in test mode by default — never touches real spend."
      >
        <div className="grid gap-3 md:grid-cols-3">
          <div className="grid gap-1.5"><Label htmlFor="ctv-name" className={HLABEL}>Name</Label><Input id="ctv-name" className={HI} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Spring :30 flight" /></div>
          <div className="grid gap-1.5"><Label htmlFor="ctv-platform" className={HLABEL}>Platform</Label>
            <select id="ctv-platform" className={HSELECT} value={form.platform} onChange={(e) => setForm({ ...form, platform: e.target.value })}>
              {Object.entries(PLATFORM_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
          <div className="grid gap-1.5"><Label htmlFor="ctv-mode" className={HLABEL}>Mode</Label>
            <select id="ctv-mode" className={HSELECT} value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value })}>
              <option value="api">API (Vibe / seat)</option>
              <option value="concierge">Concierge IO</option>
            </select>
          </div>
          <div className="grid gap-1.5"><Label htmlFor="ctv-approval" className={HLABEL}>Approval object id (required for API buys)</Label><Input id="ctv-approval" className={HI} value={form.approvalObjectId} onChange={(e) => setForm({ ...form, approvalObjectId: e.target.value })} placeholder="appr_…" /></div>
          <div className="grid gap-1.5"><Label htmlFor="ctv-advertiser" className={HLABEL}>Vibe advertiser id (API mode)</Label><Input id="ctv-advertiser" className={HI} value={form.vibeAdvertiserId} onChange={(e) => setForm({ ...form, vibeAdvertiserId: e.target.value })} placeholder="adv_…" /></div>
          <div className="flex items-end">
            <Button className="bg-violet-600 text-white hover:bg-violet-700" onClick={create} disabled={!form.name}>Create (draft)</Button>
          </div>
        </div>
      </Panel>

      <Panel
        title="Campaigns"
        action={<Button size="sm" variant="outline" onClick={refresh} disabled={loading}>Refresh</Button>}
      >
        {pauseNote && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-[13px] text-amber-900">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{pauseNote}</span>
          </div>
        )}
        {!loading && campaigns.length === 0 && (
          <p className="py-2 text-[13px] text-stone-500">No campaigns yet — create one above.</p>
        )}
        {campaigns.length > 0 && (
          <div className="overflow-x-auto rounded-xl border border-stone-200">
            <table className="w-full text-left text-[13px]">
              <thead>
                <tr className="border-b border-stone-100 bg-stone-50/60 text-[11px] uppercase tracking-wide text-stone-500">
                  <th className="px-3 py-2 font-medium">Campaign</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Platform</th>
                  <th className="px-3 py-2 font-medium">Mode</th>
                  <th className="px-3 py-2 font-medium">Action</th>
                </tr>
              </thead>
              <tbody>
                {campaigns.map((c) => (
                  <tr key={c.id} className="border-b border-stone-100 last:border-0 hover:bg-violet-50/40">
                    <td className="px-3 py-2 font-medium text-stone-900">{c.name}</td>
                    <td className="px-3 py-2">{statusChip(c.status)}</td>
                    <td className="px-3 py-2 text-[12px] text-stone-600">{PLATFORM_LABELS[c.platform] ?? c.platform}</td>
                    <td className="px-3 py-2 text-[12px] text-stone-600">
                      {c.mode}
                      {c.vibeTestMode && c.mode === "api" && (
                        <> {chip("test mode", "border-stone-200 bg-stone-100 text-stone-500")}</>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <Button size="sm" variant="outline" onClick={() => pause(c.id)} disabled={pausing === c.id || c.status === "paused"}>
                        {pausing === c.id ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <PauseCircle className="mr-1 h-3.5 w-3.5" />}
                        Pause
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}

// ---------------------------------------------------------------- validator

function ValidatorTab() {
  const [publisher, setPublisher] = useState("");
  const [result, setResult] = useState<{ pass: boolean; checks: { name: string; passed: boolean; detail: string; heuristic?: boolean }[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  return (
    <Panel
      title="Creative validator"
      description="ffprobe checks against the IAB Tech Lab Dec 2025 draft: 1920×1080, :15/:30 (6/15/30/45/60 accepted), MP4 H.264, ready-to-serve bitrate, stereo −23 LUFS / 48 kHz, no slates/countdowns, no black bars. Non-compliant creative blocks submission."
    >
      <div className="flex flex-col gap-3">
        <div className="grid gap-3 md:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="ctv-file-id" className={HLABEL}>Workspace file id</Label>
            <Input id="ctv-file-id" className={HI} placeholder="file_… — upload the MP4 via Dashboard → Files first" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="ctv-publisher" className={HLABEL}>Publisher (optional)</Label>
            <select id="ctv-publisher" className={HSELECT} value={publisher} onChange={(e) => setPublisher(e.target.value)}>
              <option value="">IAB base only</option>
              <option value="tubi">Tubi</option>
              <option value="roku">Roku</option>
              <option value="pluto">Pluto TV</option>
              <option value="freevee">Amazon Freevee</option>
              <option value="hulu">Hulu</option>
              <option value="peacock">Peacock</option>
              <option value="vibe-network">Vibe.co network</option>
            </select>
          </div>
        </div>
        <div>
          <Button className="bg-violet-600 text-white hover:bg-violet-700" disabled={busy} onClick={async () => {
            setBusy(true); setError(""); setResult(null);
            try {
              const fileId = (document.getElementById("ctv-file-id") as HTMLInputElement | null)?.value?.trim();
              if (!fileId) throw new Error("Paste the workspace file id first (upload via Dashboard → Files).");
              const data = await api("/api/flywheel/ctv/creative/validate", {
                method: "POST",
                body: JSON.stringify({ fileId, publisher: publisher || undefined }),
              });
              setResult({ pass: data.pass as boolean, checks: data.checks as { name: string; passed: boolean; detail: string; heuristic?: boolean }[] });
            } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
            finally { setBusy(false); }
          }}>
            {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <ShieldCheck className="mr-1 h-4 w-4" />} Validate
          </Button>
        </div>
        {error && <p className="text-[13px] text-red-600">{error}</p>}
        {result && (
          <div>
            <div className={`mb-2 flex items-center gap-2 text-[13px] font-semibold ${result.pass ? "text-emerald-700" : "text-red-700"}`}>
              {result.pass ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
              {result.pass ? "COMPLIANT — may be attached to a buy" : "BLOCKED — fix the failing checks before submission"}
            </div>
            <div className="overflow-x-auto rounded-xl border border-stone-200">
              <table className="w-full text-left text-[13px]">
                <thead>
                  <tr className="border-b border-stone-100 bg-stone-50/60 text-[11px] uppercase tracking-wide text-stone-500">
                    <th className="px-3 py-2 font-medium">Check</th>
                    <th className="px-3 py-2 font-medium">Result</th>
                    <th className="px-3 py-2 font-medium">Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {result.checks.map((c) => (
                    <tr key={c.name} className="border-b border-stone-100 last:border-0 hover:bg-violet-50/40">
                      <td className="px-3 py-2 font-mono text-[12px] text-stone-800">{c.name}</td>
                      <td className="px-3 py-2">
                        <span className="flex items-center gap-1.5 text-[12px]">
                          {c.passed ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-600" /> : <XCircle className="h-3.5 w-3.5 shrink-0 text-red-600" />}
                          {c.passed ? "Pass" : "Fail"}
                          {c.heuristic && chip("heuristic", "border-stone-200 bg-stone-100 text-stone-500")}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-[12px] text-stone-600">{c.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------- spots

function SpotsTab() {
  const [campaignId, setCampaignId] = useState("");
  const [destinationUrl, setDestinationUrl] = useState("");
  const [rows, setRows] = useState([{ placementLabel: "", showGenre: "", daypart: "", demo: "" }]);
  const [result, setResult] = useState<{ publicUrl: string; placementLabel: string; qrSvg: string; qrWidthCm: number }[] | null>(null);
  const [landing, setLanding] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function mint() {
    setBusy(true); setError(""); setResult(null); setLanding("");
    try {
      const data = await api("/api/flywheel/ctv/spots", {
        method: "POST",
        body: JSON.stringify({
          campaignId,
          destinationUrl,
          spots: rows.filter((r) => r.placementLabel.trim()).map((r) => ({
            placementLabel: r.placementLabel.trim(),
            showGenre: r.showGenre || undefined,
            daypart: r.daypart || undefined,
            demo: r.demo || undefined,
          })),
        }),
      });
      setResult(data.spots as { publicUrl: string; placementLabel: string; qrSvg: string; qrWidthCm: number }[]);
      const l = data.landing as { taps: number; ok: boolean; detail: string };
      setLanding(l.detail);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  return (
    <div className="flex flex-col gap-4">
      <Panel
        title="Per-spot QR/pURL kit"
        description="One unique dynamic QR + pURL per placement (show genre, daypart, demo). Codes are sized for couch-distance scanning (~3 m); landings must complete in ≤3 taps. Minting requires a passing creative validation."
      >
        <div className="flex flex-col gap-3">
          <div className="grid gap-3 md:grid-cols-2">
            <div className="grid gap-1.5"><Label htmlFor="spot-campaign" className={HLABEL}>Campaign id</Label><Input id="spot-campaign" className={HI} value={campaignId} onChange={(e) => setCampaignId(e.target.value)} placeholder="ctv_…" /></div>
            <div className="grid gap-1.5"><Label htmlFor="spot-dest" className={HLABEL}>Destination URL</Label><Input id="spot-dest" className={HI} value={destinationUrl} onChange={(e) => setDestinationUrl(e.target.value)} placeholder="https://shop.example.com/tv" /></div>
          </div>
          <div className="overflow-x-auto rounded-xl border border-stone-200">
            <table className="w-full text-left text-[13px]">
              <thead>
                <tr className="border-b border-stone-100 bg-stone-50/60 text-[11px] uppercase tracking-wide text-stone-500">
                  <th className="px-3 py-2 font-medium">Placement label</th>
                  <th className="px-3 py-2 font-medium">Show genre</th>
                  <th className="px-3 py-2 font-medium">Daypart</th>
                  <th className="px-3 py-2 font-medium">Demo</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} className="border-b border-stone-100 last:border-0">
                    <td className="px-3 py-2"><Input placeholder="Placement label" className={HI} value={r.placementLabel} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, placementLabel: e.target.value } : x)))} /></td>
                    <td className="px-3 py-2"><Input placeholder="Show genre" className={HI} value={r.showGenre} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, showGenre: e.target.value } : x)))} /></td>
                    <td className="px-3 py-2"><Input placeholder="Daypart" className={HI} value={r.daypart} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, daypart: e.target.value } : x)))} /></td>
                    <td className="px-3 py-2"><Input placeholder="Demo" className={HI} value={r.demo} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, demo: e.target.value } : x)))} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setRows([...rows, { placementLabel: "", showGenre: "", daypart: "", demo: "" }])}>+ placement</Button>
            <Button className="bg-violet-600 text-white hover:bg-violet-700" onClick={mint} disabled={busy || !campaignId || !destinationUrl}>
              {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <QrCode className="mr-1 h-4 w-4" />} Mint kit
            </Button>
          </div>
          {error && <p className="text-[13px] text-red-600">{error}</p>}
          {landing && <p className="text-[13px] text-stone-600">{landing}</p>}
        </div>
      </Panel>
      {result && (
        <div className="overflow-x-auto rounded-xl border border-stone-200 bg-white">
          <table className="w-full text-left text-[13px]">
            <thead>
              <tr className="border-b border-stone-100 bg-stone-50/60 text-[11px] uppercase tracking-wide text-stone-500">
                <th className="px-3 py-2 font-medium">QR code</th>
                <th className="px-3 py-2 font-medium">Placement</th>
                <th className="px-3 py-2 font-medium">Public URL</th>
                <th className="px-3 py-2 font-medium">Print size</th>
              </tr>
            </thead>
            <tbody>
              {result.map((s) => (
                <tr key={s.publicUrl} className="border-b border-stone-100 last:border-0 hover:bg-violet-50/40">
                  <td className="px-3 py-2"><div className="max-w-[120px]" dangerouslySetInnerHTML={{ __html: s.qrSvg }} /></td>
                  <td className="px-3 py-2 font-medium text-stone-900">{s.placementLabel}</td>
                  <td className="px-3 py-2 font-mono text-[11px] text-stone-500">{s.publicUrl}</td>
                  <td className="px-3 py-2 text-[12px] text-stone-600">Print ≥ {s.qrWidthCm} cm wide (couch distance ~3 m)</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- IO

function IoTab() {
  const [form, setForm] = useState({
    campaignId: "", vendor: "mntn", advertiserName: "", audience: "",
    geo: "", budgetCents: "500000", flightStart: "", flightEnd: "",
    approvalObjectId: "", spotCount: "12",
  });
  const [io, setIo] = useState<{ id: string; state: string; ioPayload: { ioDocument: Record<string, unknown> } } | null>(null);
  const [honesty, setHonesty] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function createIo() {
    setBusy(true); setError(""); setIo(null); setHonesty([]);
    try {
      const data = await api("/api/flywheel/ctv/ios", {
        method: "POST",
        body: JSON.stringify({
          action: "create",
          campaignId: form.campaignId,
          vendor: form.vendor,
          advertiserName: form.advertiserName,
          audience: form.audience,
          geo: form.geo.split(",").map((g) => g.trim()).filter(Boolean),
          budgetCents: Number(form.budgetCents),
          flightStart: form.flightStart,
          flightEnd: form.flightEnd,
          approvalObjectId: form.approvalObjectId,
          spotCount: Number(form.spotCount),
        }),
      });
      setIo(data.io as { id: string; state: string; ioPayload: { ioDocument: Record<string, unknown> } });
      setHonesty(((data.vendorNote as { honestyNotes?: string[] } | undefined)?.honestyNotes) ?? []);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  async function transition(to: string) {
    if (!io) return;
    setError("");
    try {
      const confirmation = to === "human_placed" ? window.prompt("Vendor confirmation reference (from the vendor UI):") ?? "" : "";
      const data = await api("/api/flywheel/ctv/ios", {
        method: "POST",
        body: JSON.stringify({ action: "transition", ioId: io.id, to, vendorConfirmation: confirmation || undefined }),
      });
      setIo(data.io as { id: string; state: string; ioPayload: { ioDocument: Record<string, unknown> } });
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm({ ...form, [k]: e.target.value });

  return (
    <div className="flex flex-col gap-4">
      <Panel title="Concierge IO generator">
        <div className="flex flex-col gap-3">
          <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-[13px] text-amber-900">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{ALERT_ONLY_COPY} Marketr generates the IO + creative brief; you place the buy in the vendor UI.</span>
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            <div className="grid gap-1.5"><Label className={HLABEL}>Campaign id</Label><Input className={HI} value={form.campaignId} onChange={set("campaignId")} /></div>
            <div className="grid gap-1.5"><Label className={HLABEL}>Vendor</Label>
              <select className={HSELECT} value={form.vendor} onChange={set("vendor")}>
                <option value="mntn">MNTN</option><option value="roku">Roku Ads Manager</option>
                <option value="tatari">Tatari</option><option value="tvscientific">tvScientific</option>
              </select>
            </div>
            <div className="grid gap-1.5"><Label className={HLABEL}>Advertiser name</Label><Input className={HI} value={form.advertiserName} onChange={set("advertiserName")} /></div>
            <div className="grid gap-1.5"><Label className={HLABEL}>Audience</Label><Input className={HI} value={form.audience} onChange={set("audience")} placeholder="In-market auto intenders, 25–54" /></div>
            <div className="grid gap-1.5"><Label className={HLABEL}>Geo (comma-separated)</Label><Input className={HI} value={form.geo} onChange={set("geo")} placeholder="US-NC, US-SC" /></div>
            <div className="grid gap-1.5"><Label className={HLABEL}>Budget (cents)</Label><Input className={HI} value={form.budgetCents} onChange={set("budgetCents")} /></div>
            <div className="grid gap-1.5"><Label className={HLABEL}>Flight start</Label><Input className={HI} type="date" value={form.flightStart} onChange={set("flightStart")} /></div>
            <div className="grid gap-1.5"><Label className={HLABEL}>Flight end</Label><Input className={HI} type="date" value={form.flightEnd} onChange={set("flightEnd")} /></div>
            <div className="grid gap-1.5"><Label className={HLABEL}>Approval object id</Label><Input className={HI} value={form.approvalObjectId} onChange={set("approvalObjectId")} /></div>
          </div>
          <div>
            <Button className="bg-violet-600 text-white hover:bg-violet-700" onClick={createIo} disabled={busy}>
              {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <FileText className="mr-1 h-4 w-4" />} Generate IO + brief
            </Button>
          </div>
          {error && <p className="text-[13px] text-red-600">{error}</p>}
        </div>
      </Panel>

      {honesty.length > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50/50 p-4">
          <h3 className="mb-2 text-[13px] font-semibold text-amber-900">Vendor honesty notes (surfaced in-product)</h3>
          <ul className="list-disc space-y-1 pl-5 text-[13px] text-amber-900">
            {honesty.map((h, i) => <li key={i}>{h}</li>)}
          </ul>
        </div>
      )}

      {io && (
        <Panel
          title={`IO ${io.id}`}
          action={chip(io.state, "border-stone-200 bg-stone-100 text-stone-600")}
        >
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap gap-2">
              {(["pending_vendor_approval", "human_placed", "live", "reconciling", "cancelled"] as const).map((s) => (
                <Button key={s} variant="outline" size="sm" onClick={() => transition(s)}>{s.replace(/_/g, " ")}</Button>
              ))}
            </div>
            <pre className="max-h-96 overflow-auto rounded-md bg-stone-50 p-3 font-mono text-xs text-stone-700">
              {JSON.stringify(io.ioPayload.ioDocument, null, 2)}
            </pre>
            <p className="text-xs text-amber-800">{ALERT_ONLY_COPY}</p>
          </div>
        </Panel>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- attribution

function AttributionTab() {
  const [campaignId, setCampaignId] = useState("");
  const [view, setView] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    setBusy(true); setError(""); setView(null);
    try {
      const data = await api(`/api/flywheel/ctv/attribution/${campaignId}`);
      setView(data.attribution as Record<string, unknown>);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  const layers = view?.layers as {
    impressionPixel: { impressions: number; viewThroughWindowDays: number };
    viewThrough: { attributedConversions: number; windowDays: number; disclaimer: string };
    qrScans: { scans: number; deterministicSliceNote: string };
  } | undefined;

  const layerRows = layers ? [
    { title: "Impression pixel", value: `${layers.impressionPixel.impressions} impressions`, note: `View-through window: ${layers.impressionPixel.viewThroughWindowDays} days`, deterministic: false },
    { title: "View-through (modeled)", value: `${layers.viewThrough.attributedConversions} attributed conversions`, note: layers.viewThrough.disclaimer, deterministic: false },
    { title: "QR/pURL scans — deterministic slice", value: `${layers.qrScans.scans} scans`, note: layers.qrScans.deterministicSliceNote, deterministic: true },
  ] : [];

  return (
    <Panel
      title="Attribution — layered & probabilistic"
      description="Impression-to-conversion on CTV is device-graph inference or geo-holdout experiment — never ledger-grade. QR/pURL scans are the deterministic slice. Deterministic CTV ROAS is never presented."
    >
      <div className="flex flex-col gap-3">
        <div className="flex gap-2">
          <Input className={HI} value={campaignId} onChange={(e) => setCampaignId(e.target.value)} placeholder="Campaign id" />
          <Button className="bg-violet-600 text-white hover:bg-violet-700" onClick={load} disabled={busy || !campaignId}>
            {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <BarChart3 className="mr-1 h-4 w-4" />} Load
          </Button>
        </div>
        {error && <p className="text-[13px] text-red-600">{error}</p>}
        {view && layers && (
          <div className="flex flex-col gap-3">
            <div className="overflow-x-auto rounded-xl border border-stone-200">
              <table className="w-full text-left text-[13px]">
                <thead>
                  <tr className="border-b border-stone-100 bg-stone-50/60 text-[11px] uppercase tracking-wide text-stone-500">
                    <th className="px-3 py-2 font-medium">Layer</th>
                    <th className="px-3 py-2 font-medium">Value</th>
                    <th className="px-3 py-2 font-medium">Note</th>
                  </tr>
                </thead>
                <tbody>
                  {layerRows.map((l) => (
                    <tr key={l.title} className={`border-b border-stone-100 last:border-0 ${l.deterministic ? "bg-emerald-50/40 hover:bg-emerald-50/60" : "hover:bg-violet-50/40"}`}>
                      <td className="px-3 py-2 font-medium text-stone-900">{l.title}</td>
                      <td className="px-3 py-2 font-semibold text-stone-900">{l.value}</td>
                      <td className="px-3 py-2 text-[12px] text-stone-500">{l.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="rounded-lg border border-stone-200 bg-stone-50 p-3 text-xs text-stone-600">
              {(view.probabilisticDisclaimer as string) ?? ""}
            </div>
          </div>
        )}
      </div>
    </Panel>
  );
}
