// ShapesOS Phase 10 (ops-core) — Promotions view (/dashboard/ops/promotions).
// The existing OpsPromotion entity (generic /api/ops/promotions route):
// create codes, pause/resume them (free, logged), and preview what a code
// takes off a sample order with the shared evaluator (lib/ops/promotions).

"use client";

import { useState } from "react";
import { Loader2, Pause, Play, Plus, TicketPercent } from "lucide-react";
import {
  btnGhost,
  btnGhostSm,
  btnPrimary,
  chipCls,
  errorBoxCls,
  inputCls,
  labelCls,
  tableCls,
  tableWrapCls,
  tdCls,
  thCls,
} from "@/components/crm/ui";
import { evaluatePromotion, parsePromotionRules } from "@/lib/ops/promotions";
import { EmptyBlock, LoadingLine, OpsModal, ViewHeader, fmtCents, fmtDate, opsJson, toCents, useOpsList } from "./shared";

interface PromotionRow {
  id: string;
  code: string;
  rules: unknown;
  usageLimit: number | null;
  usedCount: number;
  active: boolean;
  // Phase 10 (store): validity window.
  startsAt?: string | null;
  endsAt?: string | null;
  createdAt: string;
}

/** Phase 10 (store): "Oct 1 – Oct 31", "from Oct 1", "until Oct 31", or "". */
function describeWindow(p: { startsAt?: string | null; endsAt?: string | null }): string {
  if (p.startsAt && p.endsAt) return `${fmtDate(p.startsAt)} – ${fmtDate(p.endsAt)}`;
  if (p.startsAt) return `from ${fmtDate(p.startsAt)}`;
  if (p.endsAt) return `until ${fmtDate(p.endsAt)}`;
  return "";
}

function describeRules(raw: unknown): string {
  const r = parsePromotionRules(raw);
  const parts: string[] = [];
  if (r.percentOff) parts.push(`${r.percentOff}% off`);
  if (r.amountOffCents) parts.push(`${fmtCents(r.amountOffCents)} off`);
  if (r.minSubtotalCents) parts.push(`min ${fmtCents(r.minSubtotalCents)}`);
  if (r.productSkus) parts.push(`SKUs ${r.productSkus.join(", ")}`);
  return parts.join(" · ") || "No discount configured";
}

export function PromotionsView() {
  const { rows, loading, error, reload } = useOpsList<PromotionRow>("promotions");
  const [showNew, setShowNew] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [preview, setPreview] = useState("100");

  async function toggle(p: PromotionRow) {
    setBusyId(p.id);
    setActionError(null);
    try {
      await opsJson("/api/ops/promotions", "PATCH", { id: p.id, active: !p.active });
      reload();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Update failed.");
    } finally {
      setBusyId(null);
    }
  }

  const previewCents = toCents(preview) ?? 0;

  return (
    <div className="flex flex-col gap-4">
      <ViewHeader title="Promotions" hint="Discount codes. Rules are evaluated on the order subtotal; the preview shows what each code takes off.">
        <label className="flex items-center gap-2">
          Preview on a
          <input className={`${inputCls} w-24`} value={preview} onChange={(e) => setPreview(e.target.value)} inputMode="decimal" aria-label="Preview subtotal in dollars" />
          order
        </label>
      </ViewHeader>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={btnPrimary} onClick={() => setShowNew(true)}>
          <Plus size={15} /> New promotion
        </button>
      </div>
      {(error || actionError) && <div className={errorBoxCls}>{error ?? actionError}</div>}
      {loading ? (
        <LoadingLine label="Loading promotions…" />
      ) : rows.length === 0 ? (
        <EmptyBlock icon={TicketPercent} title="No promotions yet" hint="Create a code like SPRING20 for 20% off." />
      ) : (
        <div className={tableWrapCls}>
          <table className={`${tableCls} min-w-[760px]`}>
            <thead>
              <tr>
                <th className={thCls}>Code</th>
                <th className={thCls}>Rules</th>
                <th className={thCls}>Status</th>
                <th className={`${thCls} text-right`}>Used</th>
                <th className={`${thCls} text-right`}>Preview discount</th>
                <th className={thCls}>Created</th>
                <th className={thCls} />
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => {
                const v = evaluatePromotion(p, [{ qty: 1, priceCents: previewCents }]);
                return (
                  <tr key={p.id}>
                    <td className={`${tdCls} font-mono font-semibold`}>{p.code}</td>
                    <td className={`${tdCls} text-muted`}>
                      {describeRules(p.rules)}
                      {describeWindow(p) && <span className="block text-[0.75rem]">{describeWindow(p)}</span>}
                    </td>
                    <td className={tdCls}>
                      <span className={chipCls}>{p.active ? "Active" : "Paused"}</span>
                    </td>
                    <td className={`${tdCls} text-right tabular-nums`}>
                      {p.usedCount}
                      {p.usageLimit != null ? ` / ${p.usageLimit}` : ""}
                    </td>
                    <td className={`${tdCls} text-right tabular-nums`} title={v.ok ? undefined : v.reason}>
                      {v.ok ? `−${fmtCents(v.discountCents)}` : "—"}
                    </td>
                    <td className={`${tdCls} text-muted`}>{fmtDate(p.createdAt)}</td>
                    <td className={`${tdCls} text-right`}>
                      <button type="button" className={btnGhostSm} disabled={busyId === p.id} onClick={() => toggle(p)}>
                        {p.active ? <Pause size={13} /> : <Play size={13} />} {p.active ? "Pause" : "Resume"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {showNew && <NewPromotionModal onClose={() => setShowNew(false)} onCreated={reload} />}
    </div>
  );
}

function NewPromotionModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [code, setCode] = useState("");
  const [percent, setPercent] = useState("");
  const [amount, setAmount] = useState("");
  const [min, setMin] = useState("");
  const [skus, setSkus] = useState("");
  const [limit, setLimit] = useState("");
  // Phase 10 (store): optional validity window (local dates).
  const [startsOn, setStartsOn] = useState("");
  const [endsOn, setEndsOn] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const rules: Record<string, unknown> = {};
    const pct = Number(percent);
    if (percent.trim()) {
      if (!Number.isFinite(pct) || pct <= 0 || pct > 100) return setError("Percent off must be between 0 and 100.");
      rules.percentOff = pct;
    }
    if (amount.trim()) {
      const c = toCents(amount);
      if (c === null || c <= 0) return setError("Amount off must be a positive dollar amount.");
      rules.amountOffCents = c;
    }
    if (!rules.percentOff && !rules.amountOffCents) return setError("Set a percent off or an amount off.");
    if (min.trim()) {
      const c = toCents(min);
      if (c === null) return setError("Minimum subtotal must be a dollar amount.");
      rules.minSubtotalCents = c;
    }
    const skuList = skus.split(",").map((s) => s.trim()).filter(Boolean);
    if (skuList.length) rules.productSkus = skuList;
    const usageLimit = limit.trim() ? Number(limit) : undefined;
    if (usageLimit !== undefined && (!Number.isInteger(usageLimit) || usageLimit < 1)) return setError("Usage limit must be a whole number.");
    const startsAt = startsOn ? new Date(`${startsOn}T00:00:00`).toISOString() : undefined;
    const endsAt = endsOn ? new Date(`${endsOn}T23:59:59`).toISOString() : undefined;
    if (startsAt && endsAt && endsAt <= startsAt) return setError("The end date must be after the start date.");
    setSaving(true);
    setError(null);
    try {
      await opsJson("/api/ops/promotions", "POST", { code: code.trim().toUpperCase(), rules, ...(usageLimit ? { usageLimit } : {}), ...(startsAt ? { startsAt } : {}), ...(endsAt ? { endsAt } : {}) });
      onCreated();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create the promotion.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <OpsModal title="New promotion" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <label className="block">
          <span className={labelCls}>Code</span>
          <input className={`${inputCls} w-full font-mono uppercase`} value={code} onChange={(e) => setCode(e.target.value)} placeholder="SPRING20" />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className={labelCls}>Percent off</span>
            <input className={`${inputCls} w-full`} value={percent} onChange={(e) => setPercent(e.target.value)} inputMode="decimal" />
          </label>
          <label className="block">
            <span className={labelCls}>Amount off ($)</span>
            <input className={`${inputCls} w-full`} value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
          </label>
          <label className="block">
            <span className={labelCls}>Minimum subtotal ($)</span>
            <input className={`${inputCls} w-full`} value={min} onChange={(e) => setMin(e.target.value)} inputMode="decimal" />
          </label>
          <label className="block">
            <span className={labelCls}>Usage limit</span>
            <input className={`${inputCls} w-full`} value={limit} onChange={(e) => setLimit(e.target.value)} inputMode="numeric" />
          </label>
          <label className="block">
            <span className={labelCls}>Starts (optional)</span>
            <input type="date" className={`${inputCls} w-full`} value={startsOn} onChange={(e) => setStartsOn(e.target.value)} />
          </label>
          <label className="block">
            <span className={labelCls}>Ends (optional)</span>
            <input type="date" className={`${inputCls} w-full`} value={endsOn} onChange={(e) => setEndsOn(e.target.value)} />
          </label>
        </div>
        <label className="block">
          <span className={labelCls}>Only these SKUs (comma-separated, optional)</span>
          <input className={`${inputCls} w-full font-mono`} value={skus} onChange={(e) => setSkus(e.target.value)} />
        </label>
        {error && <div className={errorBoxCls}>{error}</div>}
        <div className="flex justify-end gap-2">
          <button type="button" className={btnGhost} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={btnPrimary} disabled={saving || !code.trim()} onClick={submit}>
            {saving && <Loader2 size={14} className="animate-spin" />} Create promotion
          </button>
        </div>
      </div>
    </OpsModal>
  );
}
