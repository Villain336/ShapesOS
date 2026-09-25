// Marketr — CTV buying path UI (Phase 7 F4).
// Client island: campaign list (API vs concierge labeled), creative
// validator, per-spot QR/pURL kit, concierge IO workflow states (alert-only
// copy enforced), probabilistic attribution views.
//
// Tailwind + lucide-react only (repo dashboard conventions). Concierge
// paths are labeled alert-only everywhere; no deterministic ROAS is
// rendered anywhere.

"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Tv, QrCode, FileText, BarChart3, PauseCircle,
  AlertTriangle, CheckCircle2, XCircle, Loader2, Zap, ShieldAlert,
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

const inputCls =
  "w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder-zinc-400 focus:border-zinc-500 focus:outline-none";
const btnPrimary =
  "inline-flex items-center gap-2 rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50";
const btnGhost =
  "inline-flex items-center gap-2 rounded-md border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 hover:border-zinc-500 disabled:opacity-50";
const card = "rounded-lg border border-zinc-200 bg-white p-4 shadow-sm";
const labelCls = "mb-1 block text-xs font-medium uppercase tracking-wide text-zinc-500";

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

export function CtvApp() {
  const [tab, setTab] = useState<Tab>("campaigns");
  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <header className="mb-6 flex items-center gap-3">
        <Tv className="h-6 w-6 text-zinc-900" />
        <div>
          <h1 className="text-2xl font-semibold text-zinc-900">CTV / Commercials Buying Path</h1>
          <p className="text-sm text-zinc-500">
            Validator → per-spot QR/pURL kit → concierge IO → Vibe API → probabilistic attribution.
            Every spend action sits behind a Phase 5 per-buy approval object.
          </p>
        </div>
      </header>
      <nav className="mb-6 flex flex-wrap gap-2">
        {([
          ["campaigns", "Campaigns"],
          ["validator", "Creative Validator"],
          ["spots", "Spot QR/pURL Kit"],
          ["io", "Concierge IO"],
          ["attribution", "Attribution"],
        ] as [Tab, string][]).map(([t, label]) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`rounded-md px-3 py-1.5 text-sm font-medium ${tab === t ? "bg-zinc-900 text-white" : "border border-zinc-300 text-zinc-600 hover:border-zinc-500"}`}
          >
            {label}
          </button>
        ))}
      </nav>
      {tab === "campaigns" && <CampaignsTab />}
      {tab === "validator" && <ValidatorTab />}
      {tab === "spots" && <SpotsTab />}
      {tab === "io" && <IoTab />}
      {tab === "attribution" && <AttributionTab />}
    </div>
  );
}

// ---------------------------------------------------------------- campaigns

function CampaignsTab() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [form, setForm] = useState({ name: "", platform: "vibe", mode: "api", approvalObjectId: "", vibeAdvertiserId: "" });
  const [pausing, setPausing] = useState<string | null>(null);
  const [pauseNote, setPauseNote] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      // list via the store-backed detail route is per-id; the dashboard keeps
      // a local registry of campaigns it created this session plus fresh reads.
      setCampaigns((c) => c);
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
    <div className="space-y-4">
      <div className={card}>
        <h2 className="mb-3 text-sm font-semibold text-zinc-900">New CTV campaign</h2>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <div><span className={labelCls}>Name</span><input className={inputCls} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Spring :30 flight" /></div>
          <div><span className={labelCls}>Platform</span>
            <select className={inputCls} value={form.platform} onChange={(e) => setForm({ ...form, platform: e.target.value })}>
              {Object.entries(PLATFORM_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
          <div><span className={labelCls}>Mode</span>
            <select className={inputCls} value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value })}>
              <option value="api">API (Vibe / seat)</option>
              <option value="concierge">Concierge IO</option>
            </select>
          </div>
          <div><span className={labelCls}>Approval object id (required for API buys)</span><input className={inputCls} value={form.approvalObjectId} onChange={(e) => setForm({ ...form, approvalObjectId: e.target.value })} placeholder="appr_…" /></div>
          <div><span className={labelCls}>Vibe advertiser id (API mode)</span><input className={inputCls} value={form.vibeAdvertiserId} onChange={(e) => setForm({ ...form, vibeAdvertiserId: e.target.value })} placeholder="adv_…" /></div>
        </div>
        <div className="mt-3 flex items-center gap-3">
          <button className={btnPrimary} onClick={create} disabled={!form.name}><Zap className="h-4 w-4" /> Create (draft)</button>
          <span className="text-xs text-zinc-500">Vibe adapter runs in test mode by default — never touches real spend.</span>
        </div>
        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      </div>

      <div className={card}>
        <h2 className="mb-3 text-sm font-semibold text-zinc-900">Campaigns {loading && <Loader2 className="inline h-4 w-4 animate-spin" />}</h2>
        {pauseNote && (
          <div className="mb-3 flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><span>{pauseNote}</span>
          </div>
        )}
        {campaigns.length === 0 && <p className="text-sm text-zinc-500">No campaigns yet this session.</p>}
        <div className="space-y-2">
          {campaigns.map((c) => (
            <div key={c.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-zinc-200 p-3">
              <div>
                <p className="text-sm font-medium text-zinc-900">{c.name}</p>
                <p className="text-xs text-zinc-500">
                  {PLATFORM_LABELS[c.platform] ?? c.platform} · {c.mode} · status <b>{c.status}</b>
                  {c.vibeTestMode && c.mode === "api" ? " · test mode" : ""}
                </p>
              </div>
              <button className={btnGhost} onClick={() => pause(c.id)} disabled={pausing === c.id || c.status === "paused"}>
                {pausing === c.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <PauseCircle className="h-4 w-4" />}
                Pause
              </button>
            </div>
          ))}
        </div>
      </div>
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
    <div className={card}>
      <h2 className="mb-1 text-sm font-semibold text-zinc-900">Creative validator</h2>
      <p className="mb-4 text-sm text-zinc-500">
        ffprobe checks against the IAB Tech Lab Dec 2025 draft: 1920×1080, :15/:30 (6/15/30/45/60 accepted),
        MP4 H.264, ready-to-serve bitrate, stereo −23 LUFS / 48 kHz, no slates/countdowns, no black bars.
        Non-compliant creative <b>blocks</b> submission.
      </p>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div>
          <span className={labelCls}>Workspace file id</span>
          <input className={inputCls} id="ctv-file-id" placeholder="file_… — upload the MP4 via Dashboard → Files first" />
        </div>
        <div>
          <span className={labelCls}>Publisher (optional)</span>
          <select className={inputCls} value={publisher} onChange={(e) => setPublisher(e.target.value)}>
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
      <div className="mt-3 flex gap-2">
        <button className={btnPrimary} disabled={busy} onClick={async () => {
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
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldAlert className="h-4 w-4" />} Validate
        </button>
      </div>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      {result && (
        <div className="mt-4">
          <div className={`mb-2 flex items-center gap-2 text-sm font-semibold ${result.pass ? "text-emerald-700" : "text-red-700"}`}>
            {result.pass ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
            {result.pass ? "COMPLIANT — may be attached to a buy" : "BLOCKED — fix the failing checks before submission"}
          </div>
          <ul className="space-y-1">
            {result.checks.map((c) => (
              <li key={c.name} className="flex items-start gap-2 text-sm">
                {c.passed ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />}
                <span><b className="font-mono text-xs">{c.name}</b>{c.heuristic && <span className="ml-1 rounded bg-zinc-100 px-1 text-[10px] text-zinc-500">heuristic</span>} <span className="text-zinc-600">— {c.detail}</span></span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
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
    <div className="space-y-4">
      <div className={card}>
        <h2 className="mb-1 text-sm font-semibold text-zinc-900">Per-spot QR/pURL kit</h2>
        <p className="mb-4 text-sm text-zinc-500">
          One unique dynamic QR + pURL per placement (show genre, daypart, demo). Codes are sized for couch-distance
          scanning (~3 m); landings must complete in ≤3 taps. Minting requires a passing creative validation.
        </p>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <div><span className={labelCls}>Campaign id</span><input className={inputCls} value={campaignId} onChange={(e) => setCampaignId(e.target.value)} placeholder="ctv_…" /></div>
          <div><span className={labelCls}>Destination URL</span><input className={inputCls} value={destinationUrl} onChange={(e) => setDestinationUrl(e.target.value)} placeholder="https://shop.example.com/tv" /></div>
        </div>
        <div className="mt-3 space-y-2">
          {rows.map((r, i) => (
            <div key={i} className="grid grid-cols-2 gap-2 md:grid-cols-4">
              <input className={inputCls} placeholder="Placement label" value={r.placementLabel} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, placementLabel: e.target.value } : x)))} />
              <input className={inputCls} placeholder="Show genre" value={r.showGenre} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, showGenre: e.target.value } : x)))} />
              <input className={inputCls} placeholder="Daypart" value={r.daypart} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, daypart: e.target.value } : x)))} />
              <input className={inputCls} placeholder="Demo" value={r.demo} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, demo: e.target.value } : x)))} />
            </div>
          ))}
        </div>
        <div className="mt-3 flex gap-2">
          <button className={btnGhost} onClick={() => setRows([...rows, { placementLabel: "", showGenre: "", daypart: "", demo: "" }])}>+ placement</button>
          <button className={btnPrimary} onClick={mint} disabled={busy || !campaignId || !destinationUrl}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <QrCode className="h-4 w-4" />} Mint kit
          </button>
        </div>
        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
        {landing && <p className="mt-2 text-sm text-zinc-600">{landing}</p>}
      </div>
      {result && (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {result.map((s) => (
            <div key={s.publicUrl} className={card}>
              <p className="text-sm font-medium text-zinc-900">{s.placementLabel}</p>
              <p className="mb-2 font-mono text-xs text-zinc-500">{s.publicUrl}</p>
              <div className="max-w-[180px]" dangerouslySetInnerHTML={{ __html: s.qrSvg }} />
              <p className="mt-1 text-xs text-zinc-500">Print ≥ {s.qrWidthCm} cm wide (couch distance ~3 m)</p>
            </div>
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
  }

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm({ ...form, [k]: e.target.value });

  return (
    <div className="space-y-4">
      <div className={card}>
        <h2 className="mb-1 text-sm font-semibold text-zinc-900">Concierge IO generator</h2>
        <div className="mb-4 flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{ALERT_ONLY_COPY} Marketr generates the IO + creative brief; you place the buy in the vendor UI.</span>
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <div><span className={labelCls}>Campaign id</span><input className={inputCls} value={form.campaignId} onChange={set("campaignId")} /></div>
          <div><span className={labelCls}>Vendor</span>
            <select className={inputCls} value={form.vendor} onChange={set("vendor")}>
              <option value="mntn">MNTN</option><option value="roku">Roku Ads Manager</option>
              <option value="tatari">Tatari</option><option value="tvscientific">tvScientific</option>
            </select>
          </div>
          <div><span className={labelCls}>Advertiser name</span><input className={inputCls} value={form.advertiserName} onChange={set("advertiserName")} /></div>
          <div><span className={labelCls}>Audience</span><input className={inputCls} value={form.audience} onChange={set("audience")} placeholder="In-market auto intenders, 25–54" /></div>
          <div><span className={labelCls}>Geo (comma-separated)</span><input className={inputCls} value={form.geo} onChange={set("geo")} placeholder="US-NC, US-SC" /></div>
          <div><span className={labelCls}>Budget (cents)</span><input className={inputCls} value={form.budgetCents} onChange={set("budgetCents")} /></div>
          <div><span className={labelCls}>Flight start</span><input type="date" className={inputCls} value={form.flightStart} onChange={set("flightStart")} /></div>
          <div><span className={labelCls}>Flight end</span><input type="date" className={inputCls} value={form.flightEnd} onChange={set("flightEnd")} /></div>
          <div><span className={labelCls}>Approval object id</span><input className={inputCls} value={form.approvalObjectId} onChange={set("approvalObjectId")} /></div>
        </div>
        <button className={`${btnPrimary} mt-3`} onClick={createIo} disabled={busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />} Generate IO + brief
        </button>
        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      </div>

      {honesty.length > 0 && (
        <div className={`${card} border-amber-300`}>
          <h3 className="mb-2 text-sm font-semibold text-amber-900">Vendor honesty notes (surfaced in-product)</h3>
          <ul className="list-disc space-y-1 pl-5 text-sm text-amber-900">
            {honesty.map((h, i) => <li key={i}>{h}</li>)}
          </ul>
        </div>
      )}

      {io && (
        <div className={card}>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-zinc-900">IO {io.id}</h3>
            <span className="rounded bg-zinc-100 px-2 py-0.5 font-mono text-xs text-zinc-700">{io.state}</span>
          </div>
          <div className="mb-3 flex flex-wrap gap-2">
            {(["pending_vendor_approval", "human_placed", "live", "reconciling", "cancelled"] as const).map((s) => (
              <button key={s} className={btnGhost} onClick={() => transition(s)}>{s.replace(/_/g, " ")}</button>
            ))}
          </div>
          <pre className="max-h-96 overflow-auto rounded-md bg-zinc-50 p-3 font-mono text-xs text-zinc-700">
            {JSON.stringify(io.ioPayload.ioDocument, null, 2)}
          </pre>
          <p className="mt-2 text-xs text-amber-800">{ALERT_ONLY_COPY}</p>
        </div>
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
    <div className={card}>
      <h2 className="mb-1 text-sm font-semibold text-zinc-900">Attribution — layered & probabilistic</h2>
      <p className="mb-4 text-sm text-zinc-500">
        Impression-to-conversion on CTV is device-graph inference or geo-holdout experiment — never ledger-grade.
        QR/pURL scans are the deterministic slice. Deterministic CTV ROAS is never presented.
      </p>
      <div className="mb-4 flex gap-2">
        <input className={inputCls} value={campaignId} onChange={(e) => setCampaignId(e.target.value)} placeholder="Campaign id" />
        <button className={btnPrimary} onClick={load} disabled={busy || !campaignId}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <BarChart3 className="h-4 w-4" />} Load
        </button>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      {view && layers && (
        <div className="space-y-3">
          <LayerCard title="Impression pixel" value={`${layers.impressionPixel.impressions} impressions`} note={`View-through window: ${layers.impressionPixel.viewThroughWindowDays} days`} />
          <LayerCard title="View-through (modeled)" value={`${layers.viewThrough.attributedConversions} attributed conversions`} note={layers.viewThrough.disclaimer} />
          <LayerCard title="QR/pURL scans — deterministic slice" value={`${layers.qrScans.scans} scans`} note={layers.qrScans.deterministicSliceNote} highlight />
          <div className="rounded-md border border-zinc-200 bg-zinc-50 p-3 text-xs text-zinc-600">
            {(view.probabilisticDisclaimer as string) ?? ""}
          </div>
        </div>
      )}
    </div>
  );
}

function LayerCard({ title, value, note, highlight }: { title: string; value: string; note: string; highlight?: boolean }) {
  return (
    <div className={`rounded-md border p-3 ${highlight ? "border-emerald-300 bg-emerald-50/50" : "border-zinc-200"}`}>
      <p className="text-sm font-medium text-zinc-900">{title}</p>
      <p className="text-lg font-semibold text-zinc-900">{value}</p>
      <p className="text-xs text-zinc-500">{note}</p>
    </div>
  );
}
