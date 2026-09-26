// Marketr — IO-brief concierge client (Phase 5 B3).
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

function money(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

interface IoBrief {
  id: string;
  name: string;
  channel: string;
  maxSpendCents: number;
  signatureStatus: string;
  repContact: { name: string; company: string; email?: string; phone?: string } | null;
  proofOfRunUrl: string | null;
  briefPdfUrl: string | null;
  ioTermsJson: { maximumSpendCents?: number; flightStart?: string; flightEnd?: string; scheduledTotalCents?: number; thirdPartyAdServer?: string };
  inventoryJson: { inventory?: { name: string; market: string; callSign?: string }[] };
  createdAt: string;
}

const CHANNELS = [
  { id: "radio", label: "Broadcast radio — rep-driven" },
  { id: "newspaper", label: "Newspaper — rep-driven" },
  { id: "magazine", label: "Magazine — planning only (v1)" },
];

const FLOW = ["draft", "sent_to_rep", "signed", "proof_received"];

export function RadioPrintApp() {
  const [briefs, setBriefs] = useState<IoBrief[]>([]);
  const [tab, setTab] = useState<"briefs" | "new">("briefs");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [proofUrl, setProofUrl] = useState("");

  const [name, setName] = useState("");
  const [channel, setChannel] = useState("radio");
  const [inventory, setInventory] = useState([{ name: "", market: "", callSign: "", daypartMix: "", placement: "" }]);
  const [deliverables, setDeliverables] = useState([{ description: "", quantity: 1, unitPriceCents: 1000, totalCents: 1000, notes: "" }]);
  const [maxSpend, setMaxSpend] = useState(5000);
  const [flightStart, setFlightStart] = useState("");
  const [flightEnd, setFlightEnd] = useState("");
  const [adServer, setAdServer] = useState("");
  const [cancelTerms, setCancelTerms] = useState("Cancellation with 14 days written notice per IAB/AAAA standard terms.");
  const [paymentTerms, setPaymentTerms] = useState("Net 30 from invoice date.");
  const [repName, setRepName] = useState("");
  const [repCompany, setRepCompany] = useState("");
  const [repEmail, setRepEmail] = useState("");
  const [repPhone, setRepPhone] = useState("");
  const [notes, setNotes] = useState("");

  const load = useCallback(async () => {
    try {
      const data = await api<{ briefs: IoBrief[] }>("/api/media/io-briefs");
      setBriefs(data.briefs);
    } catch (e) {
      if (e instanceof ApiError && e.status === 503) setError("Buying tables not migrated yet — run the Phase 5 migration first.");
      else setError(e instanceof Error ? e.message : "Failed to load briefs");
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  function deliverableSum() {
    return deliverables.reduce((s, d) => s + Number(d.totalCents || 0), 0);
  }

  async function createBrief() {
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const data = await api<{ brief: IoBrief; briefSha256: string }>("/api/media/io-briefs", {
        method: "POST",
        body: JSON.stringify({
          name,
          channel,
          inventory: inventory.filter((i) => i.name && i.market).map((i) => ({ ...i })),
          deliverables: deliverables.map((d) => ({
            description: d.description,
            quantity: Number(d.quantity),
            unitPriceCents: Math.round(Number(d.unitPriceCents)),
            totalCents: Math.round(Number(d.totalCents)),
            notes: d.notes || undefined,
          })),
          maximumSpendCents: Math.round(maxSpend * 100),
          flightStart,
          flightEnd,
          thirdPartyAdServer: adServer,
          cancelTerms,
          paymentTerms,
          notes: notes || undefined,
          repContact: repName && repCompany ? { name: repName, company: repCompany, email: repEmail || undefined, phone: repPhone || undefined } : undefined,
        }),
      });
      setNotice(`IO brief generated — maximum spend ${money(data.brief.maxSpendCents)} is the binding term (sha256 ${data.briefSha256.slice(0, 16)}…).`);
      load();
      setTab("briefs");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Brief failed");
    } finally {
      setLoading(false);
    }
  }

  async function setStatus(id: string, signatureStatus: string, extra: Record<string, unknown> = {}) {
    setLoading(true);
    setError(null);
    try {
      await api(`/api/media/io-briefs/${id}`, { method: "PATCH", body: JSON.stringify({ signatureStatus, ...extra }) });
      setNotice(`Brief ${id.slice(0, 8)}… moved to "${signatureStatus.replace(/_/g, " ")}".`);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Status update failed");
    } finally {
      setLoading(false);
    }
  }

  const inputCls = "mt-1 w-full rounded-md border border-stone-200 bg-white px-2.5 py-1.5 text-[13px] text-stone-900 placeholder:text-stone-400 focus:border-violet-400 focus:outline-none";

  return (
    <div className="flex flex-col gap-4">
      <div className="mb-4 flex gap-1 border-b border-stone-200">
        {([
          { id: "briefs" as const, label: `Briefs (${briefs.length})`, icon: FileText },
          { id: "new" as const, label: "New IO brief", icon: Plus },
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
            <h2 className="text-sm font-semibold text-stone-900">Buy & inventory</h2>
            <label className="mt-3 block text-xs font-medium text-stone-600">Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Q4 WXYZ drive-time flight" className={inputCls} />
            <label className="mt-3 block text-xs font-medium text-stone-600">Channel</label>
            <select value={channel} onChange={(e) => setChannel(e.target.value)} className={inputCls}>
              {CHANNELS.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
            {channel === "magazine" && (
              <p className="mt-1 text-xs text-amber-700">Magazines are planning-only in v1 — no signed IO, no spend.</p>
            )}
            <div className="mt-3 grid grid-cols-2 gap-2">
              <div><label className="block text-xs font-medium text-stone-600">Flight start</label><input type="date" value={flightStart} onChange={(e) => setFlightStart(e.target.value)} className={inputCls} /></div>
              <div><label className="block text-xs font-medium text-stone-600">Flight end</label><input type="date" value={flightEnd} onChange={(e) => setFlightEnd(e.target.value)} className={inputCls} /></div>
            </div>
            <h3 className="mt-4 text-xs font-semibold text-stone-700">Inventory (stations / publications)</h3>
            {inventory.map((r, i) => (
              <div key={i} className="mt-1 grid grid-cols-[1fr_1fr_auto_auto_auto] gap-1">
                <input value={r.name} onChange={(e) => setInventory((x) => x.map((o, j) => (j === i ? { ...o, name: e.target.value } : o)))} placeholder="WXYZ-FM" className={inputCls} />
                <input value={r.market} onChange={(e) => setInventory((x) => x.map((o, j) => (j === i ? { ...o, market: e.target.value } : o)))} placeholder="Market" className={inputCls} />
                <input value={r.callSign} onChange={(e) => setInventory((x) => x.map((o, j) => (j === i ? { ...o, callSign: e.target.value } : o)))} placeholder="WXYZ" className={`${inputCls} w-20`} />
                <input value={r.daypartMix} onChange={(e) => setInventory((x) => x.map((o, j) => (j === i ? { ...o, daypartMix: e.target.value } : o)))} placeholder="Dayparts" className={inputCls} />
                <button onClick={() => setInventory((x) => x.filter((_, j) => j !== i))} className="mt-1 rounded-md border border-stone-200 bg-white px-2 py-1.5 text-stone-600 hover:bg-stone-50"><Trash2 className="h-3 w-3" /></button>
              </div>
            ))}
            <button onClick={() => setInventory((x) => [...x, { name: "", market: "", callSign: "", daypartMix: "", placement: "" }])} className="mt-1 text-xs text-stone-600 underline">+ inventory</button>

            <h3 className="mt-4 text-xs font-semibold text-stone-700">Rep contact</h3>
            <div className="mt-1 grid grid-cols-2 gap-2">
              <input value={repName} onChange={(e) => setRepName(e.target.value)} placeholder="Rep name" className={inputCls} />
              <input value={repCompany} onChange={(e) => setRepCompany(e.target.value)} placeholder="Company / group" className={inputCls} />
              <input value={repEmail} onChange={(e) => setRepEmail(e.target.value)} placeholder="Email" className={inputCls} />
              <input value={repPhone} onChange={(e) => setRepPhone(e.target.value)} placeholder="Phone" className={inputCls} />
            </div>
          </div>

          <div className="rounded-lg border border-stone-200 bg-white p-4">
            <h2 className="text-sm font-semibold text-stone-900">IO terms — maximum spend binds</h2>
            <h3 className="mt-3 text-xs font-semibold text-stone-700">Deliverables</h3>
            {deliverables.map((d, i) => (
              <div key={i} className="mt-1 rounded-md border border-stone-200 p-2">
                <div className="flex gap-1">
                  <input value={d.description} onChange={(e) => setDeliverables((x) => x.map((o, j) => (j === i ? { ...o, description: e.target.value } : o)))} placeholder="30s drive-time spots (400×)" className={inputCls} />
                  <button onClick={() => setDeliverables((x) => x.filter((_, j) => j !== i))} className="mt-1 rounded-md border border-stone-200 bg-white px-2 py-1.5 text-stone-600 hover:bg-stone-50"><Trash2 className="h-3 w-3" /></button>
                </div>
                <div className="mt-1 grid grid-cols-3 gap-1">
                  <div><label className="block text-[11px] text-stone-500">Qty</label><input type="number" value={d.quantity} onChange={(e) => setDeliverables((x) => x.map((o, j) => (j === i ? { ...o, quantity: Number(e.target.value) } : o)))} className={inputCls} /></div>
                  <div><label className="block text-[11px] text-stone-500">Unit price ($)</label><input type="number" value={(d.unitPriceCents / 100).toFixed(2)} onChange={(e) => setDeliverables((x) => x.map((o, j) => (j === i ? { ...o, unitPriceCents: Math.round(Number(e.target.value) * 100) } : o)))} className={inputCls} /></div>
                  <div><label className="block text-[11px] text-stone-500">Total ($)</label><input type="number" value={(d.totalCents / 100).toFixed(2)} onChange={(e) => setDeliverables((x) => x.map((o, j) => (j === i ? { ...o, totalCents: Math.round(Number(e.target.value) * 100) } : o)))} className={inputCls} /></div>
                </div>
              </div>
            ))}
            <button onClick={() => setDeliverables((x) => [...x, { description: "", quantity: 1, unitPriceCents: 1000, totalCents: 1000, notes: "" }])} className="mt-1 text-xs text-stone-600 underline">+ deliverable</button>
            <div className="mt-3 rounded-lg border border-stone-200 bg-white p-2.5 text-xs">
              <div className="flex justify-between"><span>Scheduled total</span><span className="font-semibold">{money(deliverableSum())}</span></div>
              <div className="flex justify-between"><span>Maximum amount to be spent</span><span className="font-semibold">{money(Math.round(maxSpend * 100))}</span></div>
              {deliverableSum() > Math.round(maxSpend * 100) && (
                <p className="mt-1 font-medium text-red-700">Scheduled total exceeds the maximum spend — reduce deliverables or raise the cap.</p>
              )}
            </div>
            <label className="mt-3 block text-xs font-medium text-stone-600">Maximum amount to be spent ($)</label>
            <input type="number" value={maxSpend} onChange={(e) => setMaxSpend(Number(e.target.value))} min={1} className={inputCls} />
            <label className="mt-3 block text-xs font-medium text-stone-600">Third-party ad server</label>
            <input value={adServer} onChange={(e) => setAdServer(e.target.value)} placeholder="e.g. Dub pURL tracking / radio copy center" className={inputCls} />
            <label className="mt-3 block text-xs font-medium text-stone-600">Cancellation terms</label>
            <textarea value={cancelTerms} onChange={(e) => setCancelTerms(e.target.value)} rows={2} className={inputCls} />
            <label className="mt-3 block text-xs font-medium text-stone-600">Payment terms</label>
            <textarea value={paymentTerms} onChange={(e) => setPaymentTerms(e.target.value)} rows={2} className={inputCls} />
            <label className="mt-3 block text-xs font-medium text-stone-600">Notes</label>
            <input value={notes} onChange={(e) => setNotes(e.target.value)} className={inputCls} />
            <button onClick={createBrief} disabled={loading || !name || !flightStart || !flightEnd || !adServer || deliverableSum() > Math.round(maxSpend * 100)} className="mt-4 flex items-center gap-1.5 rounded-md bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-40">
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Generate IO brief
            </button>
          </div>
        </div>
      )}

      {tab === "briefs" && (
        briefs.length === 0 ? (
          <p className="text-sm text-stone-500">No IO briefs yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-stone-200 bg-white">
            <table className="w-full text-left text-[13px]">
              <thead>
                <tr className="border-b border-stone-100 bg-stone-50/60 text-[11px] uppercase tracking-wide text-stone-500">
                  <th className="px-3 py-2 font-medium">Brief</th>
                  <th className="px-3 py-2 font-medium">Channel</th>
                  <th className="px-3 py-2 font-medium">Max spend</th>
                  <th className="px-3 py-2 font-medium">Flight</th>
                  <th className="px-3 py-2 font-medium">Signature stage</th>
                  <th className="px-3 py-2 font-medium">PDF</th>
                  <th className="px-3 py-2 font-medium">Details</th>
                </tr>
              </thead>
              <tbody>
                {briefs.map((b) => (
                  <>
                    <tr key={b.id} className="border-b border-stone-100 last:border-0 hover:bg-violet-50/40">
                      <td className="px-3 py-2 font-medium text-stone-900">{b.name}</td>
                      <td className="px-3 py-2 text-stone-600">{b.channel}</td>
                      <td className="px-3 py-2 font-medium text-stone-900">{money(b.maxSpendCents)}</td>
                      <td className="px-3 py-2 text-[12px] text-stone-600">{b.ioTermsJson.flightStart} → {b.ioTermsJson.flightEnd}</td>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-1">
                          {FLOW.map((s, i) => {
                            const done = FLOW.indexOf(b.signatureStatus) >= i;
                            return (
                              <div key={s} className="flex items-center gap-1">
                                <span className={`rounded-full px-2 py-0.5 text-[11px] ${done ? "bg-violet-600 text-white" : "border border-stone-200 bg-white text-stone-500"}`}>{s.replace(/_/g, " ")}</span>
                                {i < FLOW.length - 1 && <span className="h-px w-4 bg-stone-300" />}
                              </div>
                            );
                          })}
                          {b.signatureStatus === "cancelled" && <span className="rounded-full border border-red-200 bg-red-50 px-2 py-0.5 text-[11px] text-red-700">cancelled</span>}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        {b.briefPdfUrl ? <a href={b.briefPdfUrl} className="flex items-center gap-1 text-xs text-stone-700 underline"><FileDown className="h-3 w-3" /> PDF</a> : <span className="text-stone-400">—</span>}
                      </td>
                      <td className="px-3 py-2">
                        <button onClick={() => setExpanded(expanded === b.id ? null : b.id)} className="rounded-md border border-stone-200 bg-white px-2 py-1 text-xs text-stone-700 hover:bg-stone-50">
                          {expanded === b.id ? "Collapse" : "Signature"}
                        </button>
                      </td>
                    </tr>
                    {expanded === b.id && (
                      <tr key={`${b.id}-detail`} className="border-b border-stone-100 bg-stone-50/40">
                        <td colSpan={7} className="px-3 py-3">
                          <h4 className="text-xs font-semibold text-stone-700">Signature flow — the rep keeps the signature</h4>
                          {b.repContact && <p className="mt-1 text-xs text-stone-500">Rep: {b.repContact.name} ({b.repContact.company})</p>}
                          <div className="mt-2 flex flex-wrap gap-2">
                            <button onClick={() => setStatus(b.id, "sent_to_rep")} disabled={loading || b.signatureStatus !== "draft"} className="rounded-md border border-stone-200 bg-white px-3 py-1.5 text-xs text-stone-700 hover:bg-stone-50 disabled:opacity-40">Mark sent to rep</button>
                            <button onClick={() => setStatus(b.id, "signed")} disabled={loading || b.signatureStatus !== "sent_to_rep" || !b.repContact} className="rounded-md border border-stone-200 bg-white px-3 py-1.5 text-xs text-stone-700 hover:bg-stone-50 disabled:opacity-40">Mark signed</button>
                            <button onClick={() => setStatus(b.id, "cancelled")} disabled={loading || ["signed", "proof_received", "cancelled"].includes(b.signatureStatus)} className="rounded-md border border-red-300 px-3 py-1.5 text-xs text-red-700 disabled:opacity-50">Cancel brief</button>
                          </div>
                          <div className="mt-3">
                            <label className="block text-xs font-medium text-stone-600">Proof-of-run URL (receipt of performance)</label>
                            <div className="mt-1 flex gap-1">
                              <input value={proofUrl} onChange={(e) => setProofUrl(e.target.value)} placeholder="https://…affidavit or file link" className="w-full rounded-md border border-stone-200 bg-white px-2.5 py-1.5 text-[13px] text-stone-900 placeholder:text-stone-400 focus:border-violet-400 focus:outline-none" />
                              <button
                                onClick={() => { if (proofUrl) { setStatus(b.id, "proof_received", { proofOfRunUrl: proofUrl }); setProofUrl(""); } }}
                                disabled={loading || !proofUrl}
                                className="rounded-md bg-violet-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-violet-700 disabled:opacity-40"
                              >
                                Attach proof
                              </button>
                            </div>
                            {b.proofOfRunUrl && <p className="mt-1 text-[11px] text-stone-500">Current: {b.proofOfRunUrl}</p>}
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
