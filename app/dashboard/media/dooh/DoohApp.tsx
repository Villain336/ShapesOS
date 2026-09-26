// Marketr — DOOH planner client (Phase 5 B1).
"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  ClipboardList,
  FileDown,
  Loader2,
  Map,
  Plus,
  Search,
  ShieldCheck,
  ExternalLink,
} from "lucide-react";

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

function money(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

interface InventoryItem {
  boardId: string;
  name: string;
  city: string;
  state: string;
  formats: string[];
}

interface Plan {
  id: string;
  name: string;
  vendor: string;
  estimateCents: number;
  status: string;
  launchPacketUrl: string | null;
  creativeIds: string[];
  creativeHashes: string[];
  placementsJson: { placements?: { boardId: string; name: string; city: string; state: string }[]; dayparts?: string[]; flightStart?: string; flightEnd?: string };
  estimateJson: { lines?: { label: string; totalCents: number; note?: string }[]; minCents?: number; maxCents?: number; notes?: string[] };
  createdAt: string;
}

interface Packet {
  id: string;
  approvalId: string;
  bindingHash: string;
  packetSha256: string;
  pdfUrl: string;
  version: number;
  generatedAt: string;
}

interface Creative {
  id: string;
  name: string;
  size: string;
  creativeHash: string | null;
  status: string;
}

const VENDORS = [
  { id: "blip", label: "Blip — per-blip, from $0.01", hint: "Self-serve, no minimums, daily budgets from ~$20" },
  { id: "blindspot", label: "Blindspot — per-play, ~$0.23", hint: "3M+ screens, bookable by the hour" },
  { id: "adomni", label: "Adomni — programmatic CPM $2–$15", hint: "No minimums, credit-card signup (denominators differ — compare with caution)" },
  { id: "fake", label: "Fake (test mode)", hint: "Deterministic fixture — no spend possible" },
];

const DAYPARTS = ["Overnight", "Morning drive", "Midday", "Evening drive", "Evening", "Late night"];

export function DoohApp() {
  const [tab, setTab] = useState<"planner" | "plans">("planner");
  const [plans, setPlans] = useState<Plan[]>([]);
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [creatives, setCreatives] = useState<Creative[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Planner form
  const [name, setName] = useState("");
  const [vendor, setVendor] = useState("blip");
  const [city, setCity] = useState("");
  const [state, setState] = useState("");
  const [selected, setSelected] = useState<InventoryItem[]>([]);
  const [dayparts, setDayparts] = useState<string[]>(["Morning drive", "Evening drive"]);
  const [flightStart, setFlightStart] = useState("");
  const [flightEnd, setFlightEnd] = useState("");
  const [plays, setPlays] = useState(100);
  const [creativeIds, setCreativeIds] = useState<string[]>([]);

  // Packet compile
  const [expandedPlan, setExpandedPlan] = useState<string | null>(null);
  const [packets, setPackets] = useState<Record<string, Packet[]>>({});
  const [approvalId, setApprovalId] = useState("");
  const [trackingJson, setTrackingJson] = useState("[]");

  const loadPlans = useCallback(async () => {
    try {
      const data = await api<{ plans: Plan[] }>("/api/media/dooh/plans");
      setPlans(data.plans);
    } catch (e) {
      if (e instanceof ApiError && e.status === 503) setError("Buying tables not migrated yet — run the Phase 5 migration first.");
      else setError(e instanceof Error ? e.message : "Failed to load plans");
    }
  }, []);

  useEffect(() => {
    loadPlans();
    api<{ creatives: Creative[] }>("/api/studio/creatives")
      .then((d) => setCreatives((d.creatives ?? []).filter((c) => c.creativeHash)))
      .catch(() => {});
  }, [loadPlans]);

  async function lookupInventory() {
    setLoading(true);
    setError(null);
    try {
      const q = new URLSearchParams({ inventory: "1", vendor, limit: "25" });
      if (city) q.set("city", city);
      if (state) q.set("state", state);
      const data = await api<{ items: InventoryItem[] }>(`/api/media/dooh/plans?${q}`);
      setInventory(data.items);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Lookup failed");
    } finally {
      setLoading(false);
    }
  }

  function toggleBoard(item: InventoryItem) {
    setSelected((s) => (s.some((b) => b.boardId === item.boardId) ? s.filter((b) => b.boardId !== item.boardId) : [...s, item]));
  }

  function toggleDaypart(d: string) {
    setDayparts((s) => (s.includes(d) ? s.filter((x) => x !== d) : [...s, d]));
  }

  async function createPlan() {
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const data = await api<{ plan: Plan }>(`/api/media/dooh/plans`, {
        method: "POST",
        body: JSON.stringify({
          name,
          vendor,
          placements: selected.map((b) => ({ boardId: b.boardId, name: b.name, city: b.city, state: b.state })),
          dayparts,
          flightStart,
          flightEnd,
          playsPerBoardPerDay: plays,
          creativeIds,
        }),
      });
      setNotice(`Plan "${data.plan.name}" created — estimate ceiling ${money(data.plan.estimateCents)}.`);
      setName("");
      setSelected([]);
      loadPlans();
      setTab("plans");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Create failed");
    } finally {
      setLoading(false);
    }
  }

  async function loadPackets(planId: string) {
    const data = await api<{ packets: Packet[] }>(`/api/media/dooh/plans/${planId}/launch-packet`);
    setPackets((p) => ({ ...p, [planId]: data.packets }));
  }

  async function compilePacket(planId: string) {
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      let tracking: { placementRef: string; boardName: string; slug: string; destinationUrl: string }[] = [];
      try {
        tracking = JSON.parse(trackingJson || "[]");
      } catch {
        throw new Error("Tracking JSON is not valid JSON.");
      }
      const data = await api<{ packet: Packet; packetSha256: string }>(
        `/api/media/dooh/plans/${planId}/launch-packet`,
        { method: "POST", body: JSON.stringify({ approvalId, tracking }) },
      );
      setNotice(`Launch packet v${data.packet.version} compiled — sha256 ${data.packetSha256.slice(0, 16)}…`);
      loadPackets(planId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Packet compile failed");
    } finally {
      setLoading(false);
    }
  }

  const selectedPlan = plans.find((p) => p.id === expandedPlan);

  return (
    <div className="flex flex-col gap-4">
      <div className="mb-4 flex gap-1 border-b border-stone-200">
        {([
          { id: "planner" as const, label: "Planner", icon: Map },
          { id: "plans" as const, label: `Plans (${plans.length})`, icon: ClipboardList },
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
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {notice && (
        <div className="flex items-start gap-2 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{notice}</span>
        </div>
      )}

      {tab === "planner" && (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-lg border border-stone-200 bg-white p-4">
            <h2 className="text-sm font-semibold text-stone-900">1 · Vendor & inventory</h2>
            <label className="mt-3 block text-xs font-medium text-stone-600">Vendor (locked order)</label>
            <select value={vendor} onChange={(e) => setVendor(e.target.value)} className="mt-1 w-full rounded-md border border-stone-200 bg-white px-2.5 py-1.5 text-[13px] text-stone-900 placeholder:text-stone-400 focus:border-violet-400 focus:outline-none">
              {VENDORS.map((v) => (
                <option key={v.id} value={v.id}>{v.label}</option>
              ))}
            </select>
            <p className="mt-1 text-xs text-stone-500">{VENDORS.find((v) => v.id === vendor)?.hint}</p>
            <div className="mt-3 flex gap-2">
              <input value={city} onChange={(e) => setCity(e.target.value)} placeholder="City" className="w-full rounded-md border border-stone-200 bg-white px-2.5 py-1.5 text-[13px] text-stone-900 placeholder:text-stone-400 focus:border-violet-400 focus:outline-none" />
              <input value={state} onChange={(e) => setState(e.target.value)} placeholder="ST" className="w-20 rounded-md border border-stone-200 bg-white px-2.5 py-1.5 text-[13px] text-stone-900 focus:border-violet-400 focus:outline-none" />
              <button onClick={lookupInventory} disabled={loading} className="flex items-center gap-1.5 rounded-md bg-violet-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-40">
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />} Lookup
              </button>
            </div>
            <div className="mt-3 max-h-64 space-y-1 overflow-y-auto">
              {inventory.map((item) => (
                <label key={item.boardId} className="flex items-start gap-2 rounded-md border border-stone-200 p-2 text-sm hover:border-violet-200 hover:bg-violet-50/40">
                  <input type="checkbox" checked={selected.some((b) => b.boardId === item.boardId)} onChange={() => toggleBoard(item)} className="mt-1" />
                  <span>
                    <span className="font-medium text-stone-900">{item.name}</span>
                    <span className="block text-xs text-stone-500">{item.city}, {item.state} · {item.boardId}</span>
                  </span>
                </label>
              ))}
              {inventory.length === 0 && <p className="text-xs text-stone-500">Look up inventory to pick boards. Planning data only — availability is confirmed in the client&apos;s account.</p>}
            </div>
          </div>

          <div className="rounded-lg border border-stone-200 bg-white p-4">
            <h2 className="text-sm font-semibold text-stone-900">2 · Flight, dayparts & budget</h2>
            <label className="mt-3 block text-xs font-medium text-stone-600">Plan name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Q4 Greensboro flight" className="mt-1 w-full rounded-md border border-stone-200 bg-white px-2.5 py-1.5 text-[13px] text-stone-900 placeholder:text-stone-400 focus:border-violet-400 focus:outline-none" />
            <div className="mt-3 grid grid-cols-2 gap-2">
              <div>
                <label className="block text-xs font-medium text-stone-600">Flight start</label>
                <input type="date" value={flightStart} onChange={(e) => setFlightStart(e.target.value)} className="mt-1 w-full rounded-md border border-stone-200 bg-white px-2.5 py-1.5 text-[13px] text-stone-900 placeholder:text-stone-400 focus:border-violet-400 focus:outline-none" />
              </div>
              <div>
                <label className="block text-xs font-medium text-stone-600">Flight end</label>
                <input type="date" value={flightEnd} onChange={(e) => setFlightEnd(e.target.value)} className="mt-1 w-full rounded-md border border-stone-200 bg-white px-2.5 py-1.5 text-[13px] text-stone-900 placeholder:text-stone-400 focus:border-violet-400 focus:outline-none" />
              </div>
            </div>
            <label className="mt-3 block text-xs font-medium text-stone-600">Daypart mix</label>
            <div className="mt-1 flex flex-wrap gap-1">
              {DAYPARTS.map((d) => (
                <button key={d} onClick={() => toggleDaypart(d)} className={`rounded-full border px-2.5 py-1 text-xs ${dayparts.includes(d) ? "border-violet-600 bg-violet-600 text-white" : "border-stone-200 text-stone-600 hover:border-stone-300"}`}>
                  {d}
                </button>
              ))}
            </div>
            <label className="mt-3 block text-xs font-medium text-stone-600">Plays per board per day</label>
            <input type="number" value={plays} onChange={(e) => setPlays(Number(e.target.value))} min={1} className="mt-1 w-32 rounded-md border border-stone-200 bg-white px-2.5 py-1.5 text-[13px] text-stone-900 focus:border-violet-400 focus:outline-none" />
            <label className="mt-3 block text-xs font-medium text-stone-600">Creatives (Creative Studio — hash-bound)</label>
            <div className="mt-1 max-h-32 space-y-1 overflow-y-auto">
              {creatives.map((c) => (
                <label key={c.id} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={creativeIds.includes(c.id)} onChange={() => setCreativeIds((s) => (s.includes(c.id) ? s.filter((x) => x !== c.id) : [...s, c.id]))} />
                  <span className="text-stone-800">{c.name} <span className="text-xs text-stone-500">({c.size})</span></span>
                </label>
              ))}
              {creatives.length === 0 && <p className="text-xs text-stone-500">No hashed creatives found — finalize one in Creative Studio first.</p>}
            </div>
            <button onClick={createPlan} disabled={loading || !name || selected.length === 0 || !flightStart || !flightEnd} className="mt-4 flex items-center gap-1.5 rounded-md bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-40">
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Create plan & estimate
            </button>
            <p className="mt-2 text-xs text-stone-500">
              Estimate only — the approved binding&apos;s max_total_spend is the controlling cap.
              Traditional OOH alongside this plan:{" "}
              <a href="https://www.adquick.com" target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-stone-700 underline">
                adquick.com self-serve <ExternalLink className="h-3 w-3" />
              </a>{" "}
              (referral only — API parked).
            </p>
          </div>
        </div>
      )}

      {tab === "plans" && (
        plans.length === 0 ? (
          <p className="text-sm text-stone-500">No plans yet — build one in the Planner tab.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-stone-200 bg-white">
            <table className="w-full text-left text-[13px]">
              <thead>
                <tr className="border-b border-stone-100 bg-stone-50/60 text-[11px] uppercase tracking-wide text-stone-500">
                  <th className="px-3 py-2 font-medium">Plan</th>
                  <th className="px-3 py-2 font-medium">Vendor</th>
                  <th className="px-3 py-2 font-medium">Boards</th>
                  <th className="px-3 py-2 font-medium">Flight</th>
                  <th className="px-3 py-2 font-medium">Ceiling</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Packets</th>
                </tr>
              </thead>
              <tbody>
                {plans.map((plan) => (
                  <>
                    <tr key={plan.id} className="border-b border-stone-100 last:border-0 hover:bg-violet-50/40">
                      <td className="px-3 py-2 font-medium text-stone-900">{plan.name}</td>
                      <td className="px-3 py-2 text-stone-600">{plan.vendor}</td>
                      <td className="px-3 py-2 text-stone-600">{(plan.placementsJson.placements ?? []).length}</td>
                      <td className="px-3 py-2 text-[12px] text-stone-600">{plan.placementsJson.flightStart} → {plan.placementsJson.flightEnd}</td>
                      <td className="px-3 py-2 font-medium text-stone-900">{money(plan.estimateCents)}</td>
                      <td className="px-3 py-2">
                        <span className="inline-flex items-center whitespace-nowrap rounded-full border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium leading-tight text-amber-700">{plan.status}</span>
                      </td>
                      <td className="px-3 py-2">
                        <button onClick={() => { const next = expandedPlan === plan.id ? null : plan.id; setExpandedPlan(next); if (next) loadPackets(plan.id); }} className="rounded-md border border-stone-200 bg-white px-2 py-1 text-xs text-stone-700 hover:bg-stone-50">
                          {expandedPlan === plan.id ? "Collapse" : "Packets"}
                        </button>
                      </td>
                    </tr>
                    {expandedPlan === plan.id && (
                      <tr key={`${plan.id}-detail`} className="border-b border-stone-100 bg-stone-50/40">
                        <td colSpan={7} className="px-3 py-3">
                          <h4 className="text-xs font-semibold text-stone-700">Estimate lines</h4>
                          <ul className="mt-1 text-xs text-stone-600">
                            {(plan.estimateJson.lines ?? []).map((l, i) => (
                              <li key={i} className="flex justify-between gap-2 py-0.5">
                                <span>{l.label}{l.note ? ` — ${l.note}` : ""}</span>
                                <span className="font-medium">{money(l.totalCents)}</span>
                              </li>
                            ))}
                          </ul>
                          <h4 className="mt-3 text-xs font-semibold text-stone-700">Launch packets</h4>
                          {(packets[plan.id] ?? []).map((pkt) => (
                            <div key={pkt.id} className="mt-1 flex items-center justify-between rounded-md border border-stone-200 bg-white p-2 text-xs">
                              <span>v{pkt.version} · approval {pkt.approvalId.slice(0, 8)}… · sha256 {pkt.packetSha256.slice(0, 16)}…</span>
                              <a href={pkt.pdfUrl} className="flex items-center gap-1 text-stone-700 underline"><FileDown className="h-3 w-3" /> PDF</a>
                            </div>
                          ))}
                          <div className="mt-3 rounded-lg border border-stone-200 bg-white p-3">
                            <h4 className="text-xs font-semibold text-stone-700">Compile launch packet (approved buy only)</h4>
                            <input value={approvalId} onChange={(e) => setApprovalId(e.target.value)} placeholder="Approval ID (status: approved)" className="mt-2 w-full rounded-md border border-stone-200 bg-white px-2.5 py-1.5 text-[13px] text-stone-900 placeholder:text-stone-400 focus:border-violet-400 focus:outline-none" />
                            <label className="mt-2 block text-xs text-stone-500">Per-placement tracking (JSON — from the attribution track)</label>
                            <textarea value={trackingJson} onChange={(e) => setTrackingJson(e.target.value)} rows={2} placeholder='[{"placementRef":"board-47","boardName":"I-40 W","slug":"brand-board-47","destinationUrl":"https://brand.link/board-47"}]' className="mt-1 w-full rounded-md border border-stone-200 bg-white px-2.5 py-1.5 font-mono text-[12px] text-stone-900 placeholder:text-stone-400 focus:border-violet-400 focus:outline-none" />
                            <button onClick={() => compilePacket(plan.id)} disabled={loading || !approvalId} className="mt-2 flex items-center gap-1.5 rounded-md bg-violet-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-violet-700 disabled:opacity-40">
                              {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <ShieldCheck className="h-3 w-3" />} Compile packet
                            </button>
                            <p className="mt-1 text-[11px] text-stone-500">Fail-closed: any drift between the plan and the approved binding blocks compilation.</p>
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
    </div>
  );
}
