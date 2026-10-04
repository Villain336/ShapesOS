// ShapesOS Phase 12 (mfgpos) — point of sale: /dashboard/ops/pos (registers
// and till sessions) and /dashboard/ops/pos/till/[sessionId] (the touch
// till). Sales go to POST /api/ops/pos/sessions/{id}/sales, priced by the
// server (/quote shows the same numbers first); when the server can't be
// reached, cash sales wait in the browser's offline queue and replay by their
// client order id (lib/ops/pos/offline-queue.ts) — a replay never sells
// twice. Card payments use the register's Stripe Terminal reader (or the
// labelled mock). Counting the cash is free; closing the session posts the
// takings and asks for approval (OpsApprovalCard).

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Banknote,
  Calculator,
  CheckCircle2,
  CreditCard,
  FileText,
  Loader2,
  Minus,
  Plus,
  RefreshCw,
  Search,
  Store,
  WifiOff,
  X,
} from "lucide-react";
import {
  btnGhost,
  btnGhostSm,
  btnPrimary,
  chipCls,
  errorBoxCls,
  inputCls,
  labelCls,
  needsBoxCls,
  noteBoxCls,
  selectCls,
  tableCls,
  tableWrapCls,
  tdCls,
  thCls,
} from "@/components/crm/ui";
import { OpsApprovalCard } from "@/components/crm/OpsApprovalCard";
import { EmptyBlock, LoadingLine, OpsModal, ViewHeader, fmtCents, fmtDateTime, opsJson, sentence, toCents, useGatedPatch, useOpsList } from "./shared";
import { classifySend, enqueue, readQueue, replayQueue, type KeyValueStore } from "@/lib/ops/pos/offline-queue";
import { describeDifference, estimateOffline, newClientOrderId } from "@/lib/ops/pos/rules";

// ---------------------------------------------------------------------------
// Admin: registers + sessions
// ---------------------------------------------------------------------------

interface RegisterRow {
  id: string;
  name: string;
  locationId: string | null;
  taxRateId: string | null;
  terminalReaderId: string | null;
  active: boolean;
}
interface SessionRow {
  id: string;
  registerId: string;
  number: string | null;
  status: string;
  openedAt: string;
  openingCashCents: number;
  countedCashCents: number | null;
  expectedCashCents: number | null;
  cashDifferenceCents: number | null;
  netSalesCents: number;
  taxCents: number;
  orderCount: number;
  journalEntryId: string | null;
  closedAt: string | null;
}

export function PosWorkspace() {
  const router = useRouter();
  const regs = useOpsList<RegisterRow>("pos-registers");
  const sessions = useOpsList<SessionRow>("pos-sessions");
  const { rows: locations } = useOpsList<{ id: string; path: string; active: boolean }>("locations");
  const { rows: taxRates } = useOpsList<{ id: string; name: string; rateBps: number; active: boolean }>("tax-rates");
  const [showNew, setShowNew] = useState(false);
  const [openFor, setOpenFor] = useState<RegisterRow | null>(null);
  const R = useMemo(() => new Map(regs.rows.map((r) => [r.id, r])), [regs.rows]);
  const openByRegister = useMemo(() => new Map(sessions.rows.filter((s) => s.status !== "closed").map((s) => [s.registerId, s])), [sessions.rows]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4">
        <ViewHeader title="Registers" hint="A till: where its stock comes from, the sales tax it charges and its card reader. Open a session with the cash float to start selling.">
          <button type="button" className={btnPrimary} onClick={() => setShowNew(true)}>
            <Plus size={14} /> New register
          </button>
        </ViewHeader>
        {regs.error && <div className={errorBoxCls}>{regs.error}</div>}
        {regs.loading ? (
          <LoadingLine label="Loading registers" />
        ) : regs.rows.length === 0 ? (
          <EmptyBlock icon={Store} title="No registers yet" hint="Add a register to sell at the counter." />
        ) : (
          <div className={tableWrapCls}>
            <table className={tableCls}>
              <thead>
                <tr>
                  <th className={thCls}>Register</th>
                  <th className={thCls}>Stock from</th>
                  <th className={thCls}>Tax</th>
                  <th className={thCls}>Card reader</th>
                  <th className={thCls}>Session</th>
                  <th className={thCls} />
                </tr>
              </thead>
              <tbody>
                {regs.rows.map((r) => {
                  const open = openByRegister.get(r.id);
                  const rate = taxRates.find((t) => t.id === r.taxRateId);
                  return (
                    <tr key={r.id}>
                      <td className={tdCls}>{r.name}</td>
                      <td className={`${tdCls} text-muted`}>{locations.find((l) => l.id === r.locationId)?.path ?? "Any location"}</td>
                      <td className={`${tdCls} text-muted`}>{rate ? `${rate.name} (${(rate.rateBps / 100).toFixed(2)}%)` : "None"}</td>
                      <td className={`${tdCls} font-mono text-[12px] text-muted`}>{r.terminalReaderId ?? "—"}</td>
                      <td className={tdCls}>{open ? <span className={chipCls}>{`${open.number} · ${sentence(open.status)}`}</span> : <span className="text-muted">Closed</span>}</td>
                      <td className={`${tdCls} text-right`}>
                        {open ? (
                          <Link className={btnPrimary} href={`/dashboard/ops/pos/till/${open.id}`}>
                            <Calculator size={14} /> Open till
                          </Link>
                        ) : (
                          <button type="button" className={btnGhost} disabled={!r.active} onClick={() => setOpenFor(r)}>
                            <Plus size={14} /> Open session
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="flex flex-col gap-4">
        <ViewHeader title="Till sessions" hint="Each session runs from the opening float to the cash count; closing it posts the takings to the books." />
        {sessions.error && <div className={errorBoxCls}>{sessions.error}</div>}
        {sessions.loading ? (
          <LoadingLine label="Loading sessions" />
        ) : sessions.rows.length === 0 ? (
          <EmptyBlock icon={Calculator} title="No sessions yet" hint="Open a session on a register to start selling." />
        ) : (
          <div className={tableWrapCls}>
            <table className={tableCls}>
              <thead>
                <tr>
                  <th className={thCls}>Session</th>
                  <th className={thCls}>Register</th>
                  <th className={thCls}>Status</th>
                  <th className={thCls}>Opened</th>
                  <th className={`${thCls} text-right`}>Float</th>
                  <th className={`${thCls} text-right`}>Sales</th>
                  <th className={thCls}>Cash count</th>
                  <th className={thCls}>Books</th>
                </tr>
              </thead>
              <tbody>
                {sessions.rows.map((s) => (
                  <tr key={s.id}>
                    <td className={`${tdCls} font-mono text-[12px]`}>
                      {s.status === "closed" ? s.number : <Link className="underline" href={`/dashboard/ops/pos/till/${s.id}`}>{s.number}</Link>}
                    </td>
                    <td className={tdCls}>{R.get(s.registerId)?.name ?? s.registerId}</td>
                    <td className={tdCls}>
                      <span className={chipCls}>{sentence(s.status)}</span>
                    </td>
                    <td className={`${tdCls} text-muted`}>{fmtDateTime(s.openedAt)}</td>
                    <td className={`${tdCls} text-right tabular-nums`}>{fmtCents(s.openingCashCents)}</td>
                    <td className={`${tdCls} text-right tabular-nums`}>{s.status === "open" ? "—" : `${fmtCents(s.netSalesCents + s.taxCents)} · ${s.orderCount}`}</td>
                    <td className={`${tdCls} text-muted`}>{s.cashDifferenceCents == null ? "—" : describeDifference(s.cashDifferenceCents)}</td>
                    <td className={`${tdCls} text-muted`}>{s.journalEntryId ? "Posted" : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {showNew && <NewRegisterModal locations={locations} taxRates={taxRates} onClose={() => setShowNew(false)} onCreated={regs.reload} />}
      {openFor && (
        <OpenSessionModal
          register={openFor}
          onClose={() => setOpenFor(null)}
          onOpened={(id) => {
            sessions.reload();
            router.push(`/dashboard/ops/pos/till/${id}`);
          }}
        />
      )}
    </div>
  );
}

function NewRegisterModal({
  locations,
  taxRates,
  onClose,
  onCreated,
}: {
  locations: Array<{ id: string; path: string; active: boolean }>;
  taxRates: Array<{ id: string; name: string; rateBps: number; active: boolean }>;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [loc, setLoc] = useState("");
  const [tax, setTax] = useState("");
  const [reader, setReader] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const readerOk = !reader.trim() || /^tmr_[A-Za-z0-9]+$/.test(reader.trim());
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await opsJson("/api/ops/pos-registers", "POST", { name: name.trim(), ...(loc ? { locationId: loc } : {}), ...(tax ? { taxRateId: tax } : {}), ...(reader.trim() ? { terminalReaderId: reader.trim() } : {}) });
      onCreated();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't create the register.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <OpsModal title="New register" onClose={onClose}>
      <div className="flex flex-col gap-3">
        {error && <div className={errorBoxCls}>{error}</div>}
        <label>
          <span className={labelCls}>Name</span>
          <input className={`${inputCls} w-full`} value={name} onChange={(e) => setName(e.target.value)} placeholder="Front counter" />
        </label>
        <label>
          <span className={labelCls}>Sell stock from</span>
          <select className={`${selectCls} w-full`} value={loc} onChange={(e) => setLoc(e.target.value)}>
            <option value="">Any location</option>
            {locations.filter((l) => l.active).map((l) => (
              <option key={l.id} value={l.id}>
                {l.path}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className={labelCls}>Sales tax</span>
          <select className={`${selectCls} w-full`} value={tax} onChange={(e) => setTax(e.target.value)}>
            <option value="">No tax</option>
            {taxRates.filter((t) => t.active).map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({(t.rateBps / 100).toFixed(2)}%)
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className={labelCls}>Stripe Terminal reader id (optional)</span>
          <input className={`${inputCls} w-full font-mono`} value={reader} onChange={(e) => setReader(e.target.value)} placeholder="tmr_…" aria-invalid={!readerOk} />
        </label>
        <div className="flex justify-end gap-2">
          <button type="button" className={btnGhost} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={btnPrimary} disabled={!name.trim() || !readerOk || busy} onClick={submit}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} {busy ? "Creating" : "Create register"}
          </button>
        </div>
      </div>
    </OpsModal>
  );
}

function OpenSessionModal({ register, onClose, onOpened }: { register: RegisterRow; onClose: () => void; onOpened: (id: string) => void }) {
  const [float, setFloat] = useState("100.00");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cents = toCents(float);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const { data } = await opsJson("/api/ops/pos-sessions", "POST", { registerId: register.id, openingCashCents: cents });
      onOpened(String((data.row as { id: string }).id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't open the session.");
      setBusy(false);
    }
  };
  return (
    <OpsModal title={`Open ${register.name}`} onClose={onClose}>
      <div className="flex flex-col gap-3">
        {error && <div className={errorBoxCls}>{error}</div>}
        <label>
          <span className={labelCls}>Cash in the drawer to start ($)</span>
          <input className={`${inputCls} w-full`} inputMode="decimal" value={float} onChange={(e) => setFloat(e.target.value)} />
        </label>
        <div className="flex justify-end gap-2">
          <button type="button" className={btnGhost} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={btnPrimary} disabled={cents === null || busy} onClick={submit}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Calculator size={14} />} {busy ? "Opening" : "Open session"}
          </button>
        </div>
      </div>
    </OpsModal>
  );
}

// ---------------------------------------------------------------------------
// The till
// ---------------------------------------------------------------------------

export interface TillItem {
  key: string;
  productId: string;
  variantId: string | null;
  name: string;
  sku: string;
  priceCents: number;
}

export interface TillSession {
  id: string;
  number: string | null;
  status: string;
  registerName: string;
  openingCashCents: number;
  countedCashCents: number | null;
  expectedCashCents: number;
  cashDifferenceCents: number | null;
  totals: { orderCount: number; netSalesCents: number; taxCents: number; cashSalesCents: number; cardSalesCents: number };
}

interface CartLine {
  item: TillItem;
  qty: number;
}

interface Quote {
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
  promo: { code: string; ok: boolean; reason?: string } | null;
  blocker: string | null;
}

function browserStore(): KeyValueStore {
  try {
    return window.localStorage;
  } catch {
    const m = new Map<string, string>();
    return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
  }
}

async function postSale(sessionId: string, body: Record<string, unknown>) {
  try {
    const r = await fetch(`/api/ops/pos/sessions/${sessionId}/sales`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = (await r.json().catch(() => null)) as Record<string, unknown> | null;
    return classifySend(r.status, data);
  } catch {
    return classifySend(null, null);
  }
}

export function PosTill({ session: initial, items, taxRateBps, cardMode }: { session: TillSession; items: TillItem[]; taxRateBps: number; cardMode: "live" | "mock" | null }) {
  const router = useRouter();
  const [session, setSession] = useState(initial);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [query, setQuery] = useState("");
  const [promo, setPromo] = useState("");
  const [appliedPromo, setAppliedPromo] = useState<string | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  // True when the last quote request couldn't reach the server (offline pricing).
  const [quoteUnreachable, setQuoteUnreachable] = useState(false);
  const [online, setOnline] = useState(true);
  const [queued, setQueued] = useState(0);
  const [syncNote, setSyncNote] = useState<string | null>(null);
  const [pay, setPay] = useState<"cash" | "card" | null>(null);
  const [result, setResult] = useState<{ label: string; orderId: string | null; changeCents: number; offline: boolean } | null>(null);
  const [counting, setCounting] = useState(false);
  // One client order id per sale being rung up: every retry of THIS sale
  // (lost response, card recorded again, offline replay) carries the same id.
  const [saleId, setSaleId] = useState(() => newClientOrderId());
  // Card tries for this sale (each try is its own reader payment).
  const cardTries = useRef(0);
  const store = useMemo(() => (typeof window === "undefined" ? null : browserStore()), []);
  const sellable = session.status === "open";

  const refreshSession = useCallback(async () => {
    try {
      const { data } = await opsJson(`/api/ops/pos/sessions/${initial.id}`, "GET");
      setSession(data.session as unknown as TillSession);
    } catch {
      /* offline: keep the last view */
    }
  }, [initial.id]);

  const sync = useCallback(async () => {
    if (!store) return;
    if (readQueue(store, initial.id).length === 0) {
      setQueued(0);
      return;
    }
    const report = await replayQueue(store, initial.id, (s) => postSale(s.sessionId, s.body));
    setQueued(report.remaining);
    if (report.sent.length || report.failed.length) {
      setSyncNote(
        `${report.sent.length} offline sale(s) synced${report.failed.length ? `; ${report.failed.length} refused — ${report.failed.map((f) => f.error).join("; ")}` : ""}.`,
      );
      refreshSession();
    }
  }, [store, initial.id, refreshSession]);

  useEffect(() => {
    const on = () => {
      setOnline(true);
      sync();
    };
    const off = () => setOnline(false);
    setOnline(navigator.onLine);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    sync();
    const t = setInterval(sync, 30_000);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
      clearInterval(t);
    };
  }, [sync]);

  // Server quote (prices, promotion, tax) whenever the cart changes; offline,
  // the same arithmetic without a code.
  const offlineEstimate = useMemo(() => estimateOffline(cart.map((l) => ({ qty: l.qty, unitPriceCents: l.item.priceCents })), taxRateBps), [cart, taxRateBps]);
  useEffect(() => {
    if (cart.length === 0) {
      setQuote(null);
      return;
    }
    let live = true;
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/api/ops/pos/sessions/${initial.id}/quote`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ lines: cart.map((l) => ({ productId: l.item.productId, variantId: l.item.variantId, qty: l.qty })), promoCode: appliedPromo }),
        });
        const d = (await r.json()) as { quote?: Quote; error?: string };
        if (live) {
          setQuote(r.ok && d.quote ? d.quote : null);
          setQuoteUnreachable(false);
        }
      } catch {
        if (live) {
          setQuote(null);
          setQuoteUnreachable(true);
        }
      }
    }, 150);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [cart, appliedPromo, initial.id]);

  const totals = quote ?? { ...offlineEstimate, discountCents: 0, promo: null, blocker: null };
  const offlinePricing = !quote && cart.length > 0 && (quoteUnreachable || !online);
  // Online and the server's price isn't back yet: wait before taking money.
  const pricing = cart.length > 0 && !quote && !offlinePricing;
  const shown = items.filter((i) => !query.trim() || `${i.name} ${i.sku}`.toLowerCase().includes(query.trim().toLowerCase()));

  const add = (item: TillItem) => setCart((c) => (c.some((l) => l.item.key === item.key) ? c.map((l) => (l.item.key === item.key ? { ...l, qty: l.qty + 1 } : l)) : [...c, { item, qty: 1 }]));
  const bump = (key: string, d: number) => setCart((c) => c.map((l) => (l.item.key === key ? { ...l, qty: l.qty + d } : l)).filter((l) => l.qty > 0));

  const finish = useCallback(
    async (payments: Array<Record<string, unknown>>, changeCents: number) => {
      const clientOrderId = saleId;
      const body = {
        clientOrderId,
        lines: cart.map((l) => ({ productId: l.item.productId, variantId: l.item.variantId, qty: l.qty })),
        promoCode: appliedPromo,
        payments,
      };
      const r = await postSale(initial.id, body);
      if (r.ok) {
        setResult({ label: r.orderId, orderId: r.orderId, changeCents, offline: false });
        refreshSession();
      } else if (!r.permanent && payments.every((p) => p.method === "cash") && store) {
        enqueue(store, { clientOrderId, sessionId: initial.id, body });
        setQueued(readQueue(store, initial.id).length);
        setResult({ label: clientOrderId, orderId: null, changeCents, offline: true });
      } else {
        throw new Error(r.ok ? "" : r.error);
      }
      setCart([]);
      setPromo("");
      setAppliedPromo(null);
      setPay(null);
      setSaleId(newClientOrderId());
      cardTries.current = 0;
    },
    [cart, appliedPromo, initial.id, refreshSession, store, saleId],
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-ink">
            {session.registerName} · <span className="font-mono text-[15px]">{session.number}</span>
          </h2>
          <p className="mt-0.5 text-[13px] text-muted">
            {session.totals.orderCount} sale(s) · {fmtCents(session.totals.netSalesCents + session.totals.taxCents)} taken · cash expected {fmtCents(session.expectedCashCents)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {!online && (
            <span className={chipCls}>
              <WifiOff size={12} /> Offline
            </span>
          )}
          {queued > 0 && (
            <button type="button" className={btnGhostSm} onClick={sync}>
              <RefreshCw size={12} /> {queued} waiting to sync
            </button>
          )}
          <span className={chipCls}>{sentence(session.status)}</span>
          <button type="button" className={btnGhost} onClick={() => setCounting(true)}>
            <Banknote size={14} /> {session.status === "open" ? "Count cash and close" : "Close session"}
          </button>
          <Link href="/dashboard/ops/pos" className={btnGhost}>
            Registers
          </Link>
        </div>
      </div>
      {syncNote && (
        <div className={noteBoxCls}>
          {syncNote}{" "}
          <button type="button" className="ml-2 underline" onClick={() => setSyncNote(null)}>
            Dismiss
          </button>
        </div>
      )}
      {!sellable && <div className={needsBoxCls}>This session is being closed — sales are paused. Re-open it to sell again.</div>}

      <div className="grid gap-4 lg:grid-cols-[1fr_380px]">
        <section className="flex min-w-0 flex-col gap-3" aria-label="Products">
          <div className="relative">
            <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-subtle" />
            <input className={`${inputCls} h-control w-full pl-9 text-[15px]`} placeholder="Search products" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search products" />
          </div>
          {shown.length === 0 ? (
            <EmptyBlock icon={Search} title="No products match" hint="Active products appear here." />
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
              {shown.map((i) => (
                <button
                  key={i.key}
                  type="button"
                  disabled={!sellable}
                  onClick={() => add(i)}
                  className="aos-press flex min-h-[96px] flex-col justify-between rounded-lg bg-paper p-3 text-left shadow-hairline hover:shadow-outline focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--aos-focus-halo)] disabled:opacity-40"
                >
                  <span className="line-clamp-2 text-[15px] font-semibold text-ink">{i.name}</span>
                  <span className="mt-2 flex flex-col gap-0.5">
                    <span className="truncate font-mono text-[12px] text-muted">{i.sku}</span>
                    <span className="text-[15px] font-semibold tabular-nums text-ink">{fmtCents(i.priceCents)}</span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>

        <aside className="flex flex-col gap-3 rounded-lg bg-paper p-4 shadow-hairline" aria-label="Current sale">
          <h3 className="text-[15px] font-bold text-ink">Current sale</h3>
          {cart.length === 0 ? (
            <p className="text-[13px] text-muted">Tap a product to add it.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-line">
              {cart.map((l) => (
                <li key={l.item.key} className="flex items-center gap-2 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[15px] font-medium text-ink">{l.item.name}</p>
                    <p className="text-[13px] tabular-nums text-muted">
                      {l.qty} × {fmtCents(l.item.priceCents)}
                    </p>
                  </div>
                  <button type="button" className="flex h-11 w-11 items-center justify-center rounded-full bg-paper shadow-outline aos-press" onClick={() => bump(l.item.key, -1)} aria-label={`One less ${l.item.name}`}>
                    <Minus size={16} />
                  </button>
                  <span className="w-6 text-center text-[15px] font-semibold tabular-nums">{l.qty}</span>
                  <button type="button" className="flex h-11 w-11 items-center justify-center rounded-full bg-paper shadow-outline aos-press" onClick={() => bump(l.item.key, 1)} aria-label={`One more ${l.item.name}`}>
                    <Plus size={16} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex gap-2">
            <input className={`${inputCls} flex-1`} placeholder="Promotion code" value={promo} onChange={(e) => setPromo(e.target.value)} disabled={!online || !sellable} aria-label="Promotion code" />
            {appliedPromo ? (
              <button type="button" className={btnGhostSm} onClick={() => { setAppliedPromo(null); setPromo(""); }}>
                <X size={12} /> Remove
              </button>
            ) : (
              <button type="button" className={btnGhostSm} disabled={!promo.trim() || !online} onClick={() => setAppliedPromo(promo.trim())}>
                Apply
              </button>
            )}
          </div>
          {totals.promo && !totals.promo.ok && <p className="text-[13px] text-failed-text">{totals.promo.reason ?? "That code can't be used."}</p>}
          <dl className="flex flex-col gap-1 text-[14px]">
            <div className="flex justify-between">
              <dt className="text-muted">Subtotal</dt>
              <dd className="tabular-nums">{fmtCents(totals.subtotalCents)}</dd>
            </div>
            {totals.discountCents > 0 && (
              <div className="flex justify-between">
                <dt className="text-muted">Discount{appliedPromo ? ` (${appliedPromo})` : ""}</dt>
                <dd className="tabular-nums">−{fmtCents(totals.discountCents)}</dd>
              </div>
            )}
            <div className="flex justify-between">
              <dt className="text-muted">Tax</dt>
              <dd className="tabular-nums">{fmtCents(totals.taxCents)}</dd>
            </div>
            <div className="flex justify-between border-t border-line pt-2 text-[18px] font-bold">
              <dt>Total</dt>
              <dd className="tabular-nums">{fmtCents(totals.totalCents)}</dd>
            </div>
          </dl>
          {offlinePricing && <p className="text-[13px] text-muted">Offline price: the server re-checks it when the sale syncs.</p>}
          {totals.blocker && <p className="text-[13px] text-failed-text">{totals.blocker}</p>}
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              className={`${btnPrimary} h-control-lg text-[15px]`}
              disabled={!sellable || cart.length === 0 || pricing || Boolean(totals.blocker) || totals.totalCents <= 0 || (offlinePricing && Boolean(appliedPromo))}
              onClick={() => setPay("cash")}
            >
              <Banknote size={16} /> Cash
            </button>
            <button
              type="button"
              className={`${btnGhost} h-control-lg text-[15px]`}
              disabled={!sellable || cart.length === 0 || pricing || offlinePricing || Boolean(totals.blocker) || !online || !cardMode || totals.totalCents <= 0}
              onClick={() => setPay("card")}
              title={!cardMode ? "Connect Stripe in Finance settings to take cards" : undefined}
            >
              <CreditCard size={16} /> Card
            </button>
          </div>
          {cart.length > 0 && (
            <button type="button" className={btnGhostSm} onClick={() => { setCart([]); setAppliedPromo(null); setPromo(""); }}>
              <X size={12} /> Clear sale
            </button>
          )}
        </aside>
      </div>

      {pay === "cash" && <CashModal totalCents={totals.totalCents} onClose={() => setPay(null)} onPay={(tendered) => finish([{ method: "cash", amountCents: totals.totalCents, tenderedCents: tendered }], tendered - totals.totalCents)} />}
      {pay === "card" && (
        <CardModal
          sessionId={initial.id}
          saleId={saleId}
          nextTry={() => Math.min(100, (cardTries.current += 1))}
          totalCents={totals.totalCents}
          mode={cardMode}
          onClose={() => setPay(null)}
          onPaid={(ref) => finish([{ method: "card", amountCents: totals.totalCents, providerRef: ref }], 0)}
        />
      )}
      {result && <SaleDoneModal result={result} onClose={() => setResult(null)} />}
      {counting && (
        <CloseSessionModal
          session={session}
          onClose={() => setCounting(false)}
          onChanged={(s) => setSession((prev) => ({ ...prev, ...s }))}
          onClosed={() => router.push("/dashboard/ops/pos")}
          refresh={refreshSession}
        />
      )}
    </div>
  );
}

function CashModal({ totalCents, onClose, onPay }: { totalCents: number; onClose: () => void; onPay: (tenderedCents: number) => Promise<void> }) {
  const [given, setGiven] = useState((totalCents / 100).toFixed(2));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cents = toCents(given);
  const ok = cents !== null && cents >= totalCents;
  const quick = [...new Set([totalCents, ...[500, 1000, 2000, 5000, 10000].map((n) => Math.ceil(totalCents / n) * n)])].filter((n) => n >= totalCents).slice(0, 5);
  const submit = async () => {
    if (cents === null) return;
    setBusy(true);
    setError(null);
    try {
      await onPay(cents);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The sale didn't go through.");
      setBusy(false);
    }
  };
  return (
    <OpsModal title={`Cash — ${fmtCents(totalCents)} due`} onClose={onClose}>
      <div className="flex flex-col gap-3">
        {error && <div className={errorBoxCls}>{error}</div>}
        <label>
          <span className={labelCls}>Cash handed over ($)</span>
          <input className={`${inputCls} h-control w-full text-[18px]`} inputMode="decimal" value={given} onChange={(e) => setGiven(e.target.value)} autoFocus />
        </label>
        <div className="flex flex-wrap gap-2">
          {quick.map((n) => (
            <button key={n} type="button" className={btnGhost} onClick={() => setGiven((n / 100).toFixed(2))}>
              {n === totalCents ? "Exact" : fmtCents(n)}
            </button>
          ))}
        </div>
        <p className="text-[18px] font-bold tabular-nums text-ink">Change: {ok ? fmtCents(cents! - totalCents) : "—"}</p>
        <div className="flex justify-end gap-2">
          <button type="button" className={btnGhost} onClick={onClose}>
            Back
          </button>
          <button type="button" className={`${btnPrimary} h-control-lg`} disabled={!ok || busy} onClick={submit}>
            {busy ? <Loader2 size={16} className="animate-spin" /> : <CheckCircle2 size={16} />} {busy ? "Completing" : "Complete sale"}
          </button>
        </div>
      </div>
    </OpsModal>
  );
}

function CardModal({ sessionId, saleId, nextTry, totalCents, mode, onClose, onPaid }: { sessionId: string; saleId: string; nextTry: () => number; totalCents: number; mode: "live" | "mock" | null; onClose: () => void; onPaid: (ref: string) => Promise<void> }) {
  const [state, setState] = useState<"idle" | "waiting" | "recording" | "failed">("idle");
  const [error, setError] = useState<string | null>(null);
  // Set once the reader approved: a failed recording retries with the SAME
  // payment (never a second charge).
  const [approvedRef, setApprovedRef] = useState<string | null>(null);
  const cancelled = useRef(false);
  const record = async (ref: string) => {
    setState("recording");
    setError(null);
    try {
      await onPaid(ref);
    } catch (e) {
      setState("failed");
      setError(`The card was approved (${ref}) but the sale wasn't recorded: ${e instanceof Error ? e.message : "error"}. Record it again — the customer won't be charged twice.`);
    }
  };
  useEffect(() => () => void (cancelled.current = true), []);
  const start = async () => {
    setState("waiting");
    setError(null);
    try {
      const { data } = await opsJson("/api/ops/pos/terminal", "POST", { sessionId, amountCents: totalCents, clientOrderId: saleId, attempt: nextTry() });
      const ref = String(data.paymentIntentId);
      let status = String(data.status);
      const deadline = Date.now() + 120_000;
      while (status !== "succeeded" && !cancelled.current) {
        if (status === "canceled" || Date.now() > deadline) throw new Error(status === "canceled" ? "The card payment was cancelled." : "The reader didn't finish in time. Try again.");
        await new Promise((r) => setTimeout(r, 2000));
        const { data: d } = await opsJson(`/api/ops/pos/terminal?paymentIntentId=${encodeURIComponent(ref)}`, "GET");
        status = String(d.status);
      }
      if (cancelled.current) return;
      setApprovedRef(ref);
      await record(ref);
    } catch (e) {
      setState("failed");
      setError(e instanceof Error ? e.message : "The card payment didn't go through.");
    }
  };
  return (
    <OpsModal title={`Card — ${fmtCents(totalCents)}`} onClose={onClose}>
      <div className="flex flex-col gap-3">
        {mode === "mock" && <div className={needsBoxCls}>Mock card terminal (POS_TERMINAL_MOCK): every payment is approved and recorded as a mock — no real money moves.</div>}
        {error && <div className={errorBoxCls}>{error}</div>}
        <p className="text-[14px] text-ink">
          {state === "waiting" ? "Waiting for the customer to tap or insert their card on the reader…" : state === "recording" ? "Card approved — recording the sale…" : "Send the amount to the card reader."}
        </p>
        <div className="flex justify-end gap-2">
          <button type="button" className={btnGhost} onClick={onClose} disabled={state === "recording"}>
            Back
          </button>
          {approvedRef && state === "failed" ? (
            <button type="button" className={`${btnPrimary} h-control-lg`} onClick={() => record(approvedRef)}>
              <RefreshCw size={16} /> Record sale again
            </button>
          ) : (
            <button type="button" className={`${btnPrimary} h-control-lg`} disabled={state === "waiting" || state === "recording"} onClick={start}>
              {state === "waiting" || state === "recording" ? <Loader2 size={16} className="animate-spin" /> : <CreditCard size={16} />}{" "}
              {state === "waiting" ? "Waiting for card" : state === "recording" ? "Recording" : "Charge card"}
            </button>
          )}
        </div>
      </div>
    </OpsModal>
  );
}

function SaleDoneModal({ result, onClose }: { result: { label: string; orderId: string | null; changeCents: number; offline: boolean }; onClose: () => void }) {
  return (
    <OpsModal title={result.offline ? "Sale saved offline" : "Sale complete"} onClose={onClose}>
      <div className="flex flex-col gap-3">
        {result.offline ? (
          <div className={needsBoxCls}>No connection — the sale is saved on this device and will sync automatically. Its receipt is available once it syncs.</div>
        ) : null}
        {result.changeCents > 0 && <p className="text-[24px] font-bold tabular-nums text-ink">Change: {fmtCents(result.changeCents)}</p>}
        <div className="flex justify-end gap-2">
          {result.orderId && (
            <a className={btnGhost} href={`/api/ops/pos/orders/${result.orderId}/receipt`} target="_blank" rel="noreferrer">
              <FileText size={14} /> Receipt (PDF)
            </a>
          )}
          <button type="button" className={`${btnPrimary} h-control-lg`} onClick={onClose} autoFocus>
            <Plus size={16} /> New sale
          </button>
        </div>
      </div>
    </OpsModal>
  );
}

function CloseSessionModal({
  session,
  onClose,
  onChanged,
  onClosed,
  refresh,
}: {
  session: TillSession;
  onClose: () => void;
  onChanged: (s: Partial<TillSession>) => void;
  onClosed: () => void;
  refresh: () => Promise<void>;
}) {
  const [counted, setCounted] = useState(session.countedCashCents != null ? (session.countedCashCents / 100).toFixed(2) : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const done = useCallback(
    (row: Record<string, unknown>) => {
      if (row?.status === "closed") onClosed();
    },
    [onClosed],
  );
  const gate = useGatedPatch("pos-sessions", done);
  const cents = toCents(counted);
  const count = async () => {
    if (cents === null) return;
    setBusy(true);
    setError(null);
    try {
      const { data } = await opsJson("/api/ops/pos-sessions", "PATCH", { id: session.id, status: "closing", countedCashCents: cents });
      const row = data.row as { status: string; countedCashCents: number; expectedCashCents: number; cashDifferenceCents: number };
      onChanged({ status: row.status, countedCashCents: row.countedCashCents, expectedCashCents: row.expectedCashCents, cashDifferenceCents: row.cashDifferenceCents });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't record the count.");
    } finally {
      setBusy(false);
    }
  };
  const reopen = async () => {
    setBusy(true);
    setError(null);
    try {
      await opsJson("/api/ops/pos-sessions", "PATCH", { id: session.id, status: "open" });
      onChanged({ status: "open", countedCashCents: null, cashDifferenceCents: null });
      await refresh();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't re-open the session.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <OpsModal title={`Close ${session.number ?? "session"}`} onClose={onClose}>
      <div className="flex flex-col gap-3">
        {(error || gate.error) && <div className={errorBoxCls}>{error ?? gate.error}</div>}
        {gate.pending && (
          <OpsApprovalCard
            pending={gate.pending}
            busy={gate.busy}
            executeLabel="Close session and post"
            onApprove={() => gate.decide("approved")}
            onDeny={() => gate.decide("denied")}
            onExecute={gate.execute}
          />
        )}
        <dl className="grid grid-cols-2 gap-2 text-[14px]">
          <dt className="text-muted">Opening float</dt>
          <dd className="text-right tabular-nums">{fmtCents(session.openingCashCents)}</dd>
          <dt className="text-muted">Cash sales</dt>
          <dd className="text-right tabular-nums">{fmtCents(session.totals.cashSalesCents)}</dd>
          <dt className="text-muted">Card sales</dt>
          <dd className="text-right tabular-nums">{fmtCents(session.totals.cardSalesCents)}</dd>
          <dt className="font-semibold text-ink">Cash expected in the drawer</dt>
          <dd className="text-right font-semibold tabular-nums">{fmtCents(session.expectedCashCents)}</dd>
        </dl>
        {session.status === "open" ? (
          <>
            <label>
              <span className={labelCls}>Cash counted ($)</span>
              <input className={`${inputCls} h-control w-full text-[18px]`} inputMode="decimal" value={counted} onChange={(e) => setCounted(e.target.value)} autoFocus />
            </label>
            <p className="text-[13px] text-muted">Counting stops sales on this session until you close it or re-open it.</p>
            <div className="flex justify-end gap-2">
              <button type="button" className={btnGhost} onClick={onClose}>
                Back
              </button>
              <button type="button" className={btnPrimary} disabled={cents === null || busy} onClick={count}>
                {busy ? <Loader2 size={14} className="animate-spin" /> : <Banknote size={14} />} {busy ? "Saving" : "Save count"}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className={noteBoxCls}>
              Counted {fmtCents(session.countedCashCents)} — {session.cashDifferenceCents == null ? "" : describeDifference(session.cashDifferenceCents)}.
            </div>
            <p className="text-[13px] text-muted">Closing posts the session's sales, tax, cash, card takings and any cash difference to the books as one entry. It asks for approval.</p>
            <div className="flex justify-end gap-2">
              <button type="button" className={btnGhost} disabled={busy || gate.busy} onClick={reopen}>
                Re-open for sales
              </button>
              <button
                type="button"
                className={btnPrimary}
                disabled={busy || gate.busy || Boolean(gate.pending)}
                onClick={() => gate.request({ id: session.id, status: "closed" }, `close ${session.number}: ${fmtCents(session.totals.netSalesCents + session.totals.taxCents)} taken, cash ${session.cashDifferenceCents == null ? "" : describeDifference(session.cashDifferenceCents)}.`)}
              >
                <CheckCircle2 size={14} /> Close session
              </button>
            </div>
          </>
        )}
      </div>
    </OpsModal>
  );
}
