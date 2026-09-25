// Marketr — CTV buying path UI (Phase 7 F4).
// Client island: campaign list (API vs concierge labeled), creative
// validator, per-spot QR/pURL kit, concierge IO workflow states (alert-only
// copy enforced), probabilistic attribution views.
//
// House primitives only (shadcn Button/Input/Label/Tabs, vault Card,
// ValuePill) — no hand-rolled button/card language. Concierge paths are
// labeled alert-only everywhere; no deterministic ROAS is rendered anywhere.

"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, CardHeader } from "@/components/vault/Card";
import { ValuePill } from "@/components/vault/atoms/ValuePill";
import { Badge } from "@/components/vault/shadcn/badge";
import { Button } from "@/components/vault/shadcn/button";
import { Input } from "@/components/vault/shadcn/input";
import { Label } from "@/components/vault/shadcn/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/vault/shadcn/tabs";
import {
  QrCode, FileText, BarChart3, PauseCircle,
  AlertTriangle, CheckCircle2, XCircle, Loader2, ShieldAlert,
} from "lucide-react";

type Tab = "campaigns" | "validator" | "spots" | "io" | "attribution";

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

function statusTone(s: string): "neutral" | "green" | "orange" | "red" | "accent" {
  if (s === "live" || s === "human_placed") return "green";
  if (s === "pending_vendor_approval" || s === "reconciling") return "orange";
  if (s === "cancelled") return "red";
  return "neutral";
}

export function CtvApp() {
  const [tab, setTab] = useState<Tab>("campaigns");

  return (
    <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
      <TabsList className="max-w-full justify-start overflow-x-auto">
        <TabsTrigger value="campaigns">Campaigns</TabsTrigger>
        <TabsTrigger value="validator">Creative validator</TabsTrigger>
        <TabsTrigger value="spots">Spot QR/pURL kit</TabsTrigger>
        <TabsTrigger value="io">Concierge IO</TabsTrigger>
        <TabsTrigger value="attribution">Attribution</TabsTrigger>
      </TabsList>
      <TabsContent value="campaigns" className="mt-4"><CampaignsTab /></TabsContent>
      <TabsContent value="validator" className="mt-4"><ValidatorTab /></TabsContent>
      <TabsContent value="spots" className="mt-4"><SpotsTab /></TabsContent>
      <TabsContent value="io" className="mt-4"><IoTab /></TabsContent>
      <TabsContent value="attribution" className="mt-4"><AttributionTab /></TabsContent>
    </Tabs>
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
      <Card>
        <CardHeader
          title="New CTV campaign"
          description="Vibe adapter runs in test mode by default — never touches real spend."
        />
        <div className="grid gap-3 p-4 md:grid-cols-3">
          <div className="grid gap-1.5"><Label htmlFor="ctv-name">Name</Label><Input id="ctv-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Spring :30 flight" /></div>
          <div className="grid gap-1.5"><Label htmlFor="ctv-platform">Platform</Label>
            <select id="ctv-platform" className="rounded-md border bg-background px-3 py-2 text-sm" value={form.platform} onChange={(e) => setForm({ ...form, platform: e.target.value })}>
              {Object.entries(PLATFORM_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
          <div className="grid gap-1.5"><Label htmlFor="ctv-mode">Mode</Label>
            <select id="ctv-mode" className="rounded-md border bg-background px-3 py-2 text-sm" value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value })}>
              <option value="api">API (Vibe / seat)</option>
              <option value="concierge">Concierge IO</option>
            </select>
          </div>
          <div className="grid gap-1.5"><Label htmlFor="ctv-approval">Approval object id (required for API buys)</Label><Input id="ctv-approval" value={form.approvalObjectId} onChange={(e) => setForm({ ...form, approvalObjectId: e.target.value })} placeholder="appr_…" /></div>
          <div className="grid gap-1.5"><Label htmlFor="ctv-advertiser">Vibe advertiser id (API mode)</Label><Input id="ctv-advertiser" value={form.vibeAdvertiserId} onChange={(e) => setForm({ ...form, vibeAdvertiserId: e.target.value })} placeholder="adv_…" /></div>
          <div className="flex items-end">
            <Button onClick={create} disabled={!form.name}>Create (draft)</Button>
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Campaigns"
          actions={<Button size="sm" variant="outline" onClick={refresh} disabled={loading}>Refresh</Button>}
        />
        <div className="divide-y divide-stone-100">
          {pauseNote && (
            <div className="flex items-start gap-2 p-4 text-[13px] text-amber-900">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{pauseNote}</span>
            </div>
          )}
          {!loading && campaigns.length === 0 && (
            <p className="p-4 text-[13px] text-stone-500">No campaigns yet — create one above.</p>
          )}
          {campaigns.map((c) => (
            <div key={c.id} className="flex flex-wrap items-center gap-3 p-4">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2 text-[13px] font-medium text-stone-900">
                  <span>{c.name}</span>
                  <ValuePill tone={statusTone(c.status)}>{c.status}</ValuePill>
                  <Badge variant="outline">{PLATFORM_LABELS[c.platform] ?? c.platform}</Badge>
                  {c.vibeTestMode && c.mode === "api" && <Badge variant="outline">test mode</Badge>}
                </div>
                <p className="mt-1 text-[12px] text-stone-500">{c.mode} mode</p>
              </div>
              <Button size="sm" variant="outline" onClick={() => pause(c.id)} disabled={pausing === c.id || c.status === "paused"}>
                {pausing === c.id ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <PauseCircle className="mr-1 h-3.5 w-3.5" />}
                Pause
              </Button>
            </div>
          ))}
        </div>
      </Card>
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
    <Card>
      <CardHeader
        title="Creative validator"
        description="ffprobe checks against the IAB Tech Lab Dec 2025 draft: 1920×1080, :15/:30 (6/15/30/45/60 accepted), MP4 H.264, ready-to-serve bitrate, stereo −23 LUFS / 48 kHz, no slates/countdowns, no black bars. Non-compliant creative blocks submission."
      />
      <div className="flex flex-col gap-3 p-4">
        <div className="grid gap-3 md:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="ctv-file-id">Workspace file id</Label>
            <Input id="ctv-file-id" placeholder="file_… — upload the MP4 via Dashboard → Files first" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="ctv-publisher">Publisher (optional)</Label>
            <select id="ctv-publisher" className="rounded-md border bg-background px-3 py-2 text-sm" value={publisher} onChange={(e) => setPublisher(e.target.value)}>
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
          <Button disabled={busy} onClick={async () => {
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
            {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <ShieldAlert className="mr-1 h-4 w-4" />} Validate
          </Button>
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
        {result && (
          <div>
            <div className={`mb-2 flex items-center gap-2 text-sm font-semibold ${result.pass ? "text-emerald-700" : "text-red-700"}`}>
              {result.pass ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
              {result.pass ? "COMPLIANT — may be attached to a buy" : "BLOCKED — fix the failing checks before submission"}
            </div>
            <ul className="space-y-1">
              {result.checks.map((c) => (
                <li key={c.name} className="flex items-start gap-2 text-sm">
                  {c.passed ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />}
                  <span><b className="font-mono text-xs">{c.name}</b>{c.heuristic && <Badge variant="outline" className="ml-1">heuristic</Badge>} <span className="text-stone-600">— {c.detail}</span></span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Card>
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
      <Card>
        <CardHeader
          title="Per-spot QR/pURL kit"
          description="One unique dynamic QR + pURL per placement (show genre, daypart, demo). Codes are sized for couch-distance scanning (~3 m); landings must complete in ≤3 taps. Minting requires a passing creative validation."
        />
        <div className="flex flex-col gap-3 p-4">
          <div className="grid gap-3 md:grid-cols-2">
            <div className="grid gap-1.5"><Label htmlFor="spot-campaign">Campaign id</Label><Input id="spot-campaign" value={campaignId} onChange={(e) => setCampaignId(e.target.value)} placeholder="ctv_…" /></div>
            <div className="grid gap-1.5"><Label htmlFor="spot-dest">Destination URL</Label><Input id="spot-dest" value={destinationUrl} onChange={(e) => setDestinationUrl(e.target.value)} placeholder="https://shop.example.com/tv" /></div>
          </div>
          <div className="space-y-2">
            {rows.map((r, i) => (
              <div key={i} className="grid grid-cols-2 gap-2 md:grid-cols-4">
                <Input placeholder="Placement label" value={r.placementLabel} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, placementLabel: e.target.value } : x)))} />
                <Input placeholder="Show genre" value={r.showGenre} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, showGenre: e.target.value } : x)))} />
                <Input placeholder="Daypart" value={r.daypart} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, daypart: e.target.value } : x)))} />
                <Input placeholder="Demo" value={r.demo} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, demo: e.target.value } : x)))} />
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setRows([...rows, { placementLabel: "", showGenre: "", daypart: "", demo: "" }])}>+ placement</Button>
            <Button onClick={mint} disabled={busy || !campaignId || !destinationUrl}>
              {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <QrCode className="mr-1 h-4 w-4" />} Mint kit
            </Button>
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
          {landing && <p className="text-sm text-stone-600">{landing}</p>}
        </div>
      </Card>
      {result && (
        <div className="grid gap-3 md:grid-cols-2">
          {result.map((s) => (
            <Card key={s.publicUrl}>
              <div className="p-4">
                <p className="text-sm font-medium text-stone-900">{s.placementLabel}</p>
                <p className="mb-2 font-mono text-xs text-stone-500">{s.publicUrl}</p>
                <div className="max-w-[180px]" dangerouslySetInnerHTML={{ __html: s.qrSvg }} />
                <p className="mt-1 text-xs text-stone-500">Print ≥ {s.qrWidthCm} cm wide (couch distance ~3 m)</p>
              </div>
            </Card>
          ))}
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
    finally { }
  }

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm({ ...form, [k]: e.target.value });

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader title="Concierge IO generator" />
        <div className="flex flex-col gap-3 p-4">
          <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-[13px] text-amber-900">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{ALERT_ONLY_COPY} Marketr generates the IO + creative brief; you place the buy in the vendor UI.</span>
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            <div className="grid gap-1.5"><Label>Campaign id</Label><Input value={form.campaignId} onChange={set("campaignId")} /></div>
            <div className="grid gap-1.5"><Label>Vendor</Label>
              <select className="rounded-md border bg-background px-3 py-2 text-sm" value={form.vendor} onChange={set("vendor")}>
                <option value="mntn">MNTN</option><option value="roku">Roku Ads Manager</option>
                <option value="tatari">Tatari</option><option value="tvscientific">tvScientific</option>
              </select>
            </div>
            <div className="grid gap-1.5"><Label>Advertiser name</Label><Input value={form.advertiserName} onChange={set("advertiserName")} /></div>
            <div className="grid gap-1.5"><Label>Audience</Label><Input value={form.audience} onChange={set("audience")} placeholder="In-market auto intenders, 25–54" /></div>
            <div className="grid gap-1.5"><Label>Geo (comma-separated)</Label><Input value={form.geo} onChange={set("geo")} placeholder="US-NC, US-SC" /></div>
            <div className="grid gap-1.5"><Label>Budget (cents)</Label><Input value={form.budgetCents} onChange={set("budgetCents")} /></div>
            <div className="grid gap-1.5"><Label>Flight start</Label><Input type="date" value={form.flightStart} onChange={set("flightStart")} /></div>
            <div className="grid gap-1.5"><Label>Flight end</Label><Input type="date" value={form.flightEnd} onChange={set("flightEnd")} /></div>
            <div className="grid gap-1.5"><Label>Approval object id</Label><Input value={form.approvalObjectId} onChange={set("approvalObjectId")} /></div>
          </div>
          <div>
            <Button onClick={createIo} disabled={busy}>
              {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <FileText className="mr-1 h-4 w-4" />} Generate IO + brief
            </Button>
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>
      </Card>

      {honesty.length > 0 && (
        <Card>
          <div className="p-4">
            <h3 className="mb-2 text-sm font-semibold text-amber-900">Vendor honesty notes (surfaced in-product)</h3>
            <ul className="list-disc space-y-1 pl-5 text-sm text-amber-900">
              {honesty.map((h, i) => <li key={i}>{h}</li>)}
            </ul>
          </div>
        </Card>
      )}

      {io && (
        <Card>
          <CardHeader
            title={`IO ${io.id}`}
            actions={<Badge variant="outline">{io.state}</Badge>}
          />
          <div className="flex flex-col gap-3 p-4">
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
        </Card>
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

  return (
    <Card>
      <CardHeader
        title="Attribution — layered & probabilistic"
        description="Impression-to-conversion on CTV is device-graph inference or geo-holdout experiment — never ledger-grade. QR/pURL scans are the deterministic slice. Deterministic CTV ROAS is never presented."
      />
      <div className="flex flex-col gap-3 p-4">
        <div className="flex gap-2">
          <Input value={campaignId} onChange={(e) => setCampaignId(e.target.value)} placeholder="Campaign id" />
          <Button onClick={load} disabled={busy || !campaignId}>
            {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <BarChart3 className="mr-1 h-4 w-4" />} Load
          </Button>
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
        {view && layers && (
          <div className="space-y-3">
            <LayerCard title="Impression pixel" value={`${layers.impressionPixel.impressions} impressions`} note={`View-through window: ${layers.impressionPixel.viewThroughWindowDays} days`} />
            <LayerCard title="View-through (modeled)" value={`${layers.viewThrough.attributedConversions} attributed conversions`} note={layers.viewThrough.disclaimer} />
            <LayerCard title="QR/pURL scans — deterministic slice" value={`${layers.qrScans.scans} scans`} note={layers.qrScans.deterministicSliceNote} highlight />
            <div className="rounded-md border border-stone-200 bg-stone-50 p-3 text-xs text-stone-600">
              {(view.probabilisticDisclaimer as string) ?? ""}
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}

function LayerCard({ title, value, note, highlight }: { title: string; value: string; note: string; highlight?: boolean }) {
  return (
    <div className={`rounded-lg border p-3 ${highlight ? "border-emerald-200 bg-emerald-50/60" : "border-stone-200"}`}>
      <p className="text-sm font-medium text-stone-900">{title}</p>
      <p className="text-lg font-semibold text-stone-900">{value}</p>
      <p className="text-xs text-stone-500">{note}</p>
    </div>
  );
}
