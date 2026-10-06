// ShapesOS — Phase 18.3 (WS=trust): notifications from operations writes —
// invoice paid and ticket assigned — at the ONE seam every ops write already
// passes for its outbound webhooks (lib/webhooks/ops-events.ts
// emitOpsWriteEvents / emitOpsEvent): the generic entity routes, the agent
// tools, payments and the gate's approved executions alike.
//
// Those run inside the write's transaction, so the notifications are
// produced right AFTER it (setImmediate, on the shared client): a producer
// can never poison the write's transaction, and the write never waits on a
// notification. Best-effort like every producer (dedup keys make a retried
// write notify once).

export type OpsNotice =
  | { kind: "invoice_paid"; invoiceId: string; number: string | null; totalCents: number | null; currency: string | null }
  | { kind: "ticket_assigned"; ticketId: string; number: number; subject: string; assigneeId: string; at: Date };

type Row = Record<string, unknown>;

const str = (v: unknown) => (typeof v === "string" && v ? v : null);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** What notifications one ops write produces. PURE. */
export function opsNotices(slug: string, before: Row | null, after: Row | null, now: Date = new Date()): OpsNotice[] {
  if (!after || typeof after.id !== "string") return [];
  const out: OpsNotice[] = [];
  if (slug === "invoices" && after.kind !== "credit_note" && after.status === "paid" && before?.status !== "paid") {
    out.push({ kind: "invoice_paid", invoiceId: after.id, number: str(after.number), totalCents: num(after.totalCents), currency: str(after.currency) });
  }
  if (slug === "tickets") {
    const assignee = str(after.assigneeId);
    if (assignee && assignee !== str(before?.assigneeId)) {
      const at = after.updatedAt instanceof Date ? after.updatedAt : typeof after.updatedAt === "string" ? new Date(after.updatedAt) : now;
      out.push({ kind: "ticket_assigned", ticketId: after.id, number: num(after.number) ?? 0, subject: String(after.subject ?? ""), assigneeId: assignee, at });
    }
  }
  return out;
}

/** Produce the notices after the current transaction (never throws, never blocks). */
export function queueOpsNotices(workspaceId: string, notices: readonly OpsNotice[], actorUserId: string | null = null): void {
  if (!notices.length) return;
  setImmediate(() => {
    void (async () => {
      const producers = await import("./producers");
      for (const n of notices) {
        if (n.kind === "invoice_paid") {
          await producers.notifyInvoicePaid({ workspaceId, invoiceId: n.invoiceId, number: n.number, totalCents: n.totalCents, currency: n.currency });
        } else {
          await producers.notifyTicketAssigned({ workspaceId, ticketId: n.ticketId, number: n.number, subject: n.subject, assigneeId: n.assigneeId, assignedBy: actorUserId, at: n.at });
        }
      }
    })().catch((e: unknown) => console.warn("[notifications] ops notices skipped:", e instanceof Error ? e.message : e));
  });
}
