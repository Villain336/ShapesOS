// Marketr — streaming-audio planner client (Phase 5 B2).
"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, FileDown, FileText, Loader2, Plus, ShieldCheck, Trash2 } from "lucide-react";

class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function api<T>(url: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...opts,
    headers: { "content-type": "application/json", ...(opts?.headers ?? {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? `Request failed (${res.status})`);
  return data as T;
}

function money(cents: number, currency = "USD") {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}

interface AudioBuy {
  id: string;
  name: string;
  vendor: string;
  budgetCents: number;
  currency: string;
  status: string;
  briefUrl: string | null;
  stationsJson: { stations?: { name: string; type: string; market: string }[]; spotMix?: { lengthSec: number; spotsPerDay: number; label: string }[]; flightStart?: string; flightEnd?: string };
  budgetJson: { notes?: string[]; dailyBudgetCents?: number; lifetimeMediaCents?: number; productionCents?: number };
  createdAt: string;
}

const VENDORS = [
  { id: "spotify", label: "Spotify Ads Manager — €15/day, €250 lifetime" },
  { id: "acast", label: "Acast — $250 minimum" },
  { id: "audiogo", label: "AudioGo — $250 minimum (iHeart/SiriusXM/Cumulus/Audacy streaming)" },
  { id: "fake", label: "Fake (test mode)" },
];

export function AudioApp() {
  const [buys, setBuys] = useState<AudioBuy[]>([]);
  const [tab, setTab] = useState<"briefs" | "new">("briefs");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [vendor, setVendor] = useState("spotify");
  const [stations, setStations] = useState([{ name: "", type: "streaming", market: "" }]);
  const [spotMix, setSpotMix] = useState([{ lengthSec: 30, spotsPerDay: 10, label: "30s drive" }]);
  const [flightStart, setFlightStart] = useState("");
  const [flightEnd, setFlightEnd] = useState("");
  const [dailyBudget, setDailyBudget] = useState(15);
  const [production, setProduction] = useState(0);
  const [promoCodes, setPromoCodes] = useState([{ stationRef: "", code: "", vanityUrl: "" }]);

  const load = useCallback(async () => {
    try {
      const data = await api<{ briefs: AudioBuy[] }>("/api/media/audio/briefs");
      setBuys(data.briefs);
    } catch (e) {
      if (e instanceof ApiError && e.status === 503) setError("Buying tables not migrated yet — run the Phase 5 migration first.");
      else setError(e instanceof Error ? e.message : "Failed to load briefs");
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function createBrief() {
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const body = {
        name,
        vendor,
        stations: stations.filter((s) => s.name && s.market).map((s) => ({ ...s, type: s.type as "streaming" | "podcast" })),
        spotMix: spotMix.map((s) => ({ ...s, lengthSec: s.lengthSec as 15 | 30 | 60 })),
        flightStart,
        flightEnd,
        dailyBudgetCents: Math.round(dailyBudget * 100),
        productionCents: Math.round(production * 100),
        promoCodes: promoCodes.filter((p) => p.stationRef && p.code),
      };
      const data = await api<{ buy: AudioBuy; briefSha256: string }>("/api/media/audio/briefs", {
        method: "POST",
        body: JSON.stringify(body),
      });
      setNotice(`Brief generated — envelope ${money(data.buy.budgetCents, data.buy.currency)} (sha256 ${data.briefSha256.slice(0, 16)}…).`);
      load();
      setTab("briefs");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Brief failed");
    } finally {
      setLoading(false);
    }
  }

  const inputCls = "mt-1 w-full rounded-md border border-stone-200 bg-white px-2.5 py-1.5 text-[13px] text-stone-900 placeholder:text-stone-400 focus:border-violet-400 focus:outline-none";

  return (
    <div className="flex flex-col gap-4">
      <div className="mb-4 flex gap-1 border-b border-stone-200">
        {([
          { id: "briefs" as const, label: `Briefs (${buys.length})`, icon: FileText },
          { id: "new" as const, label: "New brief", icon: Plus },
        ]).map(({ id, label, icon: Icon }) => (
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

      {error && (
        <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><span>{error}</span>
        </div>
      )}
      {notice && (
        <div className="flex items-start gap-2 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" /><span>{notice}</span>
        </div>
      )}

      {tab === "new" && (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-lg border border-stone-200 bg-white p-4">
            <h2 className="text-sm font-semibold text-stone-900">Buy setup</h2>
            <label className="mt-3 block text-xs font-medium text-stone-600">Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Q4 podcast flight" className={inputCls} />
            <label className="mt-3 block text-xs font-medium text-stone-600">Vendor</label>
            <select value={vendor} onChange={(e) => setVendor(e.target.value)} className={inputCls}>
              {VENDORS.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
            </select>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <div><label className="block text-xs font-medium text-stone-600">Flight start</label><input type="date" value={flightStart} onChange={(e) => setFlightStart(e.target.value)} className={inputCls} /></div>
              <div><label className="block text-xs font-medium text-stone-600">Flight end</label><input type="date" value={flightEnd} onChange={(e) => setFlightEnd(e.target.value)} className={inputCls} /></div>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <div><label className="block text-xs font-medium text-stone-600">Daily media budget ($/€)</label><input type="number" value={dailyBudget} onChange={(e) => setDailyBudget(Number(e.target.value))} min={1} className={inputCls} /></div>
              <div><label className="block text-xs font-medium text-stone-600">Production cost (client cost)</label><input type="number" value={production} onChange={(e) => setProduction(Number(e.target.value))} min={0} className={inputCls} /></div>
            </div>
            <h3 className="mt-4 text-xs font-semibold text-stone-700">Stations / podcasts</h3>
            {stations.map((s, i) => (
              <div key={i} className="mt-1 flex gap-1">
                <input value={s.name} onChange={(e) => setStations((x) => x.map((r, j) => (j === i ? { ...r, name: e.target.value } : r)))} placeholder="Station / show" className={inputCls} />
                <select value={s.type} onChange={(e) => setStations((x) => x.map((r, j) => (j === i ? { ...r, type: e.target.value } : r)))} className="mt-1 w-full rounded-md border border-stone-200 bg-white px-2.5 py-1.5 text-[13px] text-stone-900 placeholder:text-stone-400 focus:border-violet-400 focus:outline-none">
                  <option value="streaming">streaming</option><option value="podcast">podcast</option>
                </select>
                <input value={s.market} onChange={(e) => setStations((x) => x.map((r, j) => (j === i ? { ...r, market: e.target.value } : r)))} placeholder="Market" className={`${inputCls} w-28`} />
                <button onClick={() => setStations((x) => x.filter((_, j) => j !== i))} className="mt-1 rounded-md border border-stone-200 bg-white px-2 py-1.5 text-stone-600 hover:bg-stone-50"><Trash2 className="h-3 w-3" /></button>
              </div>
            ))}
            <button onClick={() => setStations((x) => [...x, { name: "", type: "streaming", market: "" }])} className="mt-1 text-xs text-stone-600 underline">+ station</button>
          </div>

          <div className="rounded-lg border border-stone-200 bg-white p-4">
            <h2 className="text-sm font-semibold text-stone-900">Spot mix & tracking</h2>
            {spotMix.map((s, i) => (
              <div key={i} className="mt-1 flex gap-1">
                <input value={s.label} onChange={(e) => setSpotMix((x) => x.map((r, j) => (j === i ? { ...r, label: e.target.value } : r)))} placeholder="Label" className={inputCls} />
                <select value={s.lengthSec} onChange={(e) => setSpotMix((x) => x.map((r, j) => (j === i ? { ...r, lengthSec: Number(e.target.value) } : r)))} className="mt-1 w-full rounded-md border border-stone-200 bg-white px-2.5 py-1.5 text-[13px] text-stone-900 placeholder:text-stone-400 focus:border-violet-400 focus:outline-none">
                  <option value={15}>:15</option><option value={30}>:30</option><option value={60}>:60</option>
                </select>
                <input type="number" value={s.spotsPerDay} onChange={(e) => setSpotMix((x) => x.map((r, j) => (j === i ? { ...r, spotsPerDay: Number(e.target.value) } : r)))} min={1} placeholder="/day" className={`${inputCls} w-24`} />
                <button onClick={() => setSpotMix((x) => x.filter((_, j) => j !== i))} className="mt-1 rounded-md border border-stone-200 bg-white px-2 py-1.5 text-stone-600 hover:bg-stone-50"><Trash2 className="h-3 w-3" /></button>
              </div>
            ))}
            <button onClick={() => setSpotMix((x) => [...x, { lengthSec: 30, spotsPerDay: 10, label: "30s" }])} className="mt-1 text-xs text-stone-600 underline">+ spot</button>
            <h3 className="mt-4 text-xs font-semibold text-stone-700">Per-station promo codes + vanity URLs</h3>
            {promoCodes.map((p, i) => (
              <div key={i} className="mt-1 flex gap-1">
                <input value={p.stationRef} onChange={(e) => setPromoCodes((x) => x.map((r, j) => (j === i ? { ...r, stationRef: e.target.value } : r)))} placeholder="Station" className={inputCls} />
                <input value={p.code} onChange={(e) => setPromoCodes((x) => x.map((r, j) => (j === i ? { ...r, code: e.target.value } : r)))} placeholder="CODE20" className={`${inputCls} w-28`} />
                <input value={p.vanityUrl} onChange={(e) => setPromoCodes((x) => x.map((r, j) => (j === i ? { ...r, vanityUrl: e.target.value } : r)))} placeholder="brand.link/wxyz" className={inputCls} />
                <button onClick={() => setPromoCodes((x) => x.filter((_, j) => j !== i))} className="mt-1 rounded-md border border-stone-200 bg-white px-2 py-1.5 text-stone-600 hover:bg-stone-50"><Trash2 className="h-3 w-3" /></button>
              </div>
            ))}
            <button onClick={() => setPromoCodes((x) => [...x, { stationRef: "", code: "", vanityUrl: "" }])} className="mt-1 text-xs text-stone-600 underline">+ promo code</button>
            <button onClick={createBrief} disabled={loading || !name || !flightStart || !flightEnd} className="mt-4 flex items-center gap-1.5 rounded-md bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-40">
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Generate brief
            </button>
            <p className="mt-2 text-xs text-stone-500">Vendor minimums are enforced in the plan. The brief is a self-serve handoff — the client executes in their own account.</p>
          </div>
        </div>
      )}

      {tab === "briefs" && (
        buys.length === 0 ? (
          <p className="text-sm text-stone-500">No briefs yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-stone-200 bg-white">
            <table className="w-full text-left text-[13px]">
              <thead>
                <tr className="border-b border-stone-100 bg-stone-50/60 text-[11px] uppercase tracking-wide text-stone-500">
                  <th className="px-3 py-2 font-medium">Brief</th>
                  <th className="px-3 py-2 font-medium">Vendor</th>
                  <th className="px-3 py-2 font-medium">Stations</th>
                  <th className="px-3 py-2 font-medium">Envelope</th>
                  <th className="px-3 py-2 font-medium">Flight</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Brief PDF</th>
                </tr>
              </thead>
              <tbody>
                {buys.map((b) => (
                  <tr key={b.id} className="border-b border-stone-100 last:border-0 hover:bg-violet-50/40">
                    <td className="px-3 py-2 font-medium text-stone-900">{b.name}</td>
                    <td className="px-3 py-2 text-stone-600">{b.vendor}</td>
                    <td className="px-3 py-2 text-stone-600">{(b.stationsJson.stations ?? []).length}</td>
                    <td className="px-3 py-2 font-medium text-stone-900">{money(b.budgetCents, b.currency)}</td>
                    <td className="px-3 py-2 text-[12px] text-stone-600">{b.stationsJson.flightStart} → {b.stationsJson.flightEnd}</td>
                    <td className="px-3 py-2">
                      <span className="inline-flex items-center whitespace-nowrap rounded-full border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium leading-tight text-amber-700">{b.status}</span>
                    </td>
                    <td className="px-3 py-2">
                      {b.briefUrl ? <a href={b.briefUrl} className="flex items-center gap-1 text-xs text-stone-700 underline"><FileDown className="h-3 w-3" /> PDF</a> : <span className="text-stone-400">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
    </div>
  );
}
