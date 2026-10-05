// ShapesOS Phase 10 (ops-core) — shared atoms for the /dashboard/ops views.
// Built ON the CRM visual atoms (components/crm/ui.tsx) — no second kit.
// Workflow states (order/ticket/task statuses) are NEUTRAL chips; the four
// status colours stay reserved for agent states (docs/design/DESIGN.md).

"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, X, type LucideIcon } from "lucide-react";
import { decideOpsApproval, type OpsPendingGate } from "@/components/crm/OpsApprovalCard";
import { backdropCls, modalCardCls, modalWrapCls, slideoverCls } from "@/components/crm/ui";
import { closeOnEscape } from "@/lib/ui/keyboard";

export function fmtDate(v: string | Date | null | undefined): string {
  if (!v) return "—";
  const d = new Date(v);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function fmtDateTime(v: string | Date | null | undefined): string {
  if (!v) return "—";
  const d = new Date(v);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** Exact cents → "$1,234.56" (the CRM formatter rounds to whole dollars). */
export function fmtCents(cents: number | null | undefined): string {
  if (cents == null) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

export function shortId(id: string): string {
  return id.length > 12 ? id.slice(-8).toUpperCase() : id.toUpperCase();
}

/** Dollars text → integer cents (null when invalid). */
export function toCents(dollars: string): number | null {
  const t = dollars.trim().replace(/[$,]/g, "");
  if (t === "") return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

export function sentence(s: string): string {
  const t = s.replace(/_/g, " ");
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** View header: title + one-line explanation + right-aligned slot. */
export function ViewHeader({
  title,
  hint,
  children,
}: {
  title: string;
  hint: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 className="text-xl font-bold tracking-tight text-ink">{title}</h2>
        <p className="mt-0.5 text-[13px] text-muted">{hint}</p>
      </div>
      {children && <div className="flex flex-wrap items-center gap-4 text-[13px] text-muted">{children}</div>}
    </div>
  );
}

export function LoadingLine({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 text-[13px] text-muted">
      <Loader2 size={16} className="animate-spin" /> {label}
    </div>
  );
}

export function EmptyBlock({ icon: Icon, title, hint }: { icon: LucideIcon; title: string; hint: string }) {
  return (
    <div className="rounded-md border border-line bg-canvas px-4 py-10 text-center">
      <Icon size={28} className="mx-auto text-subtle" />
      <p className="mt-2 text-[13px] font-semibold text-ink">{title}</p>
      <p className="mt-0.5 text-[13px] text-muted">{hint}</p>
    </div>
  );
}

/** GET /api/ops/{entity} list loader. */
export function useOpsList<T>(entity: string, params: Record<string, string | undefined> = {}) {
  const [rows, setRows] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const key = JSON.stringify(params);
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const p = new URLSearchParams({ limit: "200" });
      for (const [k, v] of Object.entries(JSON.parse(key) as Record<string, string | undefined>)) {
        if (v) p.set(k, v);
      }
      const r = await fetch(`/api/ops/${entity}?${p.toString()}`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? `Failed to load ${entity}.`);
      setRows((d.rows ?? []) as T[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : `Failed to load ${entity}.`);
    } finally {
      setLoading(false);
    }
  }, [entity, key]);
  useEffect(() => {
    load();
  }, [load]);
  return { rows, loading, error, reload: load };
}

export async function opsJson(
  url: string,
  method: "POST" | "PATCH" | "GET",
  body?: unknown,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const r = await fetch(url, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (!r.ok && r.status !== 202) throw new Error((data.error as string) ?? "Request failed.");
  return { status: r.status, data };
}

export interface GatedPending extends OpsPendingGate {
  body: Record<string, unknown>;
}

/**
 * Propose → approve/deny inline → execute for a gated ops PATCH (the same
 * flow PODetail/InvoiceDetail implement, factored for the new views).
 */
export function useGatedPatch(entity: string, onDone: (row: Record<string, unknown>) => void) {
  return useGatedWrite(entity, "PATCH", onDone);
}

/** Same flow for gated creates (payments are money records: every POST is gated). */
export function useGatedWrite(
  entity: string,
  method: "POST" | "PATCH",
  onDone: (row: Record<string, unknown>) => void,
) {
  const [pending, setPending] = useState<GatedPending | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const request = useCallback(
    async (body: Record<string, unknown>, summary: string) => {
      setBusy(true);
      setError(null);
      setNote(null);
      try {
        const { status, data } = await opsJson(`/api/ops/${entity}`, method, body);
        if (status === 202 && data.approval_required) {
          const approval = data.approval as { id: string; riskTier?: string };
          const label = ((data.classification as { label?: string } | undefined)?.label) ?? "Gated write";
          setPending({
            approvalId: approval.id,
            tier: approval.riskTier ?? "medium",
            actionLabel: label,
            summary: `${label} — ${summary}`,
            approved: false,
            body,
          });
        } else {
          // Phase 14: a rule approved an automatable gate — say which.
          setNote(typeof data.autoApproved === "string" ? `Done — ${data.autoApproved}.` : "Done.");
          onDone(data.row as Record<string, unknown>);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Request failed.");
      } finally {
        setBusy(false);
      }
    },
    [entity, method, onDone],
  );

  const decide = useCallback(
    async (decision: "approved" | "denied") => {
      if (!pending) return;
      setBusy(true);
      setError(null);
      try {
        await decideOpsApproval(pending.approvalId, decision);
        if (decision === "denied") {
          setPending(null);
          setNote("Denied — nothing was executed.");
        } else {
          setPending({ ...pending, approved: true });
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Decision failed.");
      } finally {
        setBusy(false);
      }
    },
    [pending],
  );

  const execute = useCallback(async () => {
    if (!pending?.approved) return;
    setBusy(true);
    setError(null);
    try {
      const { data } = await opsJson(`/api/ops/${entity}`, method, { ...pending.body, approvalId: pending.approvalId });
      setPending(null);
      setNote("Done.");
      onDone(data.row as Record<string, unknown>);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Execution failed.");
    } finally {
      setBusy(false);
    }
  }, [entity, method, pending, onDone]);

  return { pending, busy, error, note, request, decide, execute, setError, setNote };
}

/** Centered dialog shell (same atoms as the CRM modals). */
export function OpsModal({
  title,
  onClose,
  children,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <>
      <div className={backdropCls} aria-hidden onClick={onClose} />
      <div
        className={modalWrapCls}
        role="presentation"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
        onKeyDown={closeOnEscape(onClose)}
      >
        <div className={modalCardCls} style={wide ? { width: 640 } : undefined} role="dialog" aria-modal="true" aria-label={title}>
          <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
            <h3 className="text-[15px] font-bold text-ink">{title}</h3>
            <button type="button" onClick={onClose} aria-label="Close" className="rounded-full p-1.5 text-subtle hover:bg-hover-paper hover:text-ink">
              <X size={16} />
            </button>
          </div>
          <div className="overflow-y-auto px-5 py-4">{children}</div>
        </div>
      </div>
    </>
  );
}

/** Right slide-over shell (same atoms as the CRM detail panels). */
export function OpsSlideOver({
  title,
  meta,
  onClose,
  children,
}: {
  title: React.ReactNode;
  meta?: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <>
      <div className={backdropCls} onClick={onClose} aria-hidden />
      <div className={slideoverCls} role="dialog" aria-modal="true" onKeyDown={closeOnEscape(onClose)}>
        <div className="flex h-full flex-col">
          <div className="flex items-start justify-between border-b border-line px-5 py-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-lg font-bold tracking-tight text-ink">{title}</div>
              {meta && <p className="mt-0.5 text-[13px] text-muted">{meta}</p>}
            </div>
            <button type="button" onClick={onClose} className="rounded-md p-1.5 text-subtle hover:bg-hover-paper hover:text-ink" aria-label="Close">
              <X size={18} />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
        </div>
      </div>
    </>
  );
}
