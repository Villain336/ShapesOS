"use client";

// ShapesOS — Phase 10 (finance): the propose → approve → execute flow for
// gated finance writes, client side. The first request answers 202 with a
// pending Phase 14 approval; the person approves inline (or in the Actions
// queue) and then executes with the approvalId. Reuses the existing
// OpsApprovalCard (components/crm/OpsApprovalCard.tsx).

import { useState } from "react";
import { OpsApprovalCard, type OpsPendingGate } from "@/components/crm/OpsApprovalCard";

export interface GatedAction {
  label: string;
  summary: string;
  /** First call (no approvalId) and the execute call (with it). */
  send: (approvalId?: string) => Promise<Response>;
  executeLabel: string;
  onDone?: (body: Record<string, unknown>) => void;
}

export function useGated() {
  const [pending, setPending] = useState<(OpsPendingGate & { action: GatedAction }) | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function readBody(r: Response): Promise<Record<string, unknown>> {
    return (await r.json().catch(() => ({}))) as Record<string, unknown>;
  }

  async function start(action: GatedAction) {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const r = await action.send();
      const d = await readBody(r);
      if (r.status === 202 && d.approval_required) {
        const a = d.approval as { id: string; riskTier?: string };
        setPending({ approvalId: a.id, tier: a.riskTier ?? "medium", actionLabel: action.label, summary: action.summary, approved: false, action });
      } else if (!r.ok) {
        throw new Error(String(d.error ?? "That didn't work."));
      } else {
        action.onDone?.(d);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't work.");
    } finally {
      setBusy(false);
    }
  }

  async function decide(decision: "approved" | "denied") {
    if (!pending) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/integrations/actions/approvals/${pending.approvalId}/decide`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      const d = await readBody(r);
      if (!r.ok) throw new Error(String(d.error ?? "Decision failed."));
      if (decision === "denied") {
        setPending(null);
        setNote("Denied. Nothing was executed.");
      } else setPending({ ...pending, approved: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Decision failed.");
    } finally {
      setBusy(false);
    }
  }

  async function execute() {
    if (!pending?.approved) return;
    setBusy(true);
    setError(null);
    try {
      const r = await pending.action.send(pending.approvalId);
      const d = await readBody(r);
      if (!r.ok) throw new Error(String(d.error ?? "Execution failed."));
      const done = pending.action;
      setPending(null);
      done.onDone?.(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Execution failed.");
    } finally {
      setBusy(false);
    }
  }

  const card = pending ? (
    <OpsApprovalCard pending={pending} busy={busy} executeLabel={pending.action.executeLabel} onApprove={() => decide("approved")} onDeny={() => decide("denied")} onExecute={execute} />
  ) : null;

  return { start, card, busy, error, setError, note, setNote, pending };
}

export function jsonPost(url: string, body: unknown, method = "POST"): Promise<Response> {
  return fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}
