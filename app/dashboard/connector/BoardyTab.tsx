// Marketr — Connector Agent slice 6 UI: the Boardy escalation rail tab.
// The composer drafts the request email (context-rich: who the target is,
// why, what the tenant offers) — NOTHING sends until the tenant approves
// per instance. Approved requests send from the tenant's own address to
// boardy@boardy.ai; Boardy's reply is triaged as a priority thread.
// Boardy is free to use. The native loop never blocks on this rail.
// Agentic OS design system: canvas page, white surfaces, black primary
// pills, needs-yellow for the priority flag only, Lucide only, tokens only.

"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, MailPlus, X } from "lucide-react";
import type { BoardyRequestView } from "@/lib/connector/boardy-rail";
import type { ConnectorMode } from "@/lib/connector/modes";
import {
  BoardyStatusPill,
  PriorityReplyPill,
  btnApprove,
  btnDeny,
  btnPrimary,
  btnSecondary,
  inputCls,
  textareaCls,
} from "./IntroShared";

const BOARDY_EVENT_LABELS: Record<string, string> = {
  boardy_request_drafted: "Draft created",
  boardy_request_approved: "You approved the draft",
  boardy_request_declined: "You declined the draft",
  boardy_request_sent: "Sent to boardy@boardy.ai",
  boardy_request_cancelled: "Cancelled",
  boardy_reply_triaged: "Boardy replied — priority",
};

function BoardyTimeline({ events }: { events: BoardyRequestView["events"] }) {
  if (events.length === 0) {
    return <p className="text-[13px] text-muted">No events yet.</p>;
  }
  return (
    <ol className="flex flex-col">
      {events.map((e, i) => (
        <li key={e.id} className="relative flex gap-3 pb-4 last:pb-0">
          {i < events.length - 1 && (
            <span className="absolute left-[5px] top-4 h-full w-px bg-line" aria-hidden />
          )}
          <span className="mt-1.5 h-[11px] w-[11px] shrink-0 rounded-full border-2 border-ink bg-paper" aria-hidden />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-[14px] font-semibold text-ink">
                {BOARDY_EVENT_LABELS[e.kind] ?? e.kind}
              </span>
              <span className="text-[12px] text-muted">
                {e.actorIdentity} · {new Date(e.createdAt).toLocaleString()}
              </span>
            </div>
            {e.message && (
              <p className="mt-1 rounded-md border border-line bg-canvas p-2.5 text-[13px] leading-relaxed text-ink">
                {e.message}
              </p>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

function RequestCard({
  request,
  onChanged,
}: {
  request: BoardyRequestView;
  onChanged: () => void;
}) {
  const [sentVia, setSentVia] = useState("gmail");
  const [reason, setReason] = useState("");
  const [declining, setDeclining] = useState(false);
  const [summary, setSummary] = useState("");
  const [triaging, setTriaging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const act = useCallback(
    async (path: string, body: Record<string, unknown>) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(`/api/connector/boardy/${request.id}/${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? "Action failed.");
        onChanged();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Action failed.");
      } finally {
        setBusy(false);
      }
    },
    [request.id, onChanged],
  );

  return (
    <div className="flex flex-col gap-4 rounded-lg bg-paper p-5 shadow-hairline">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-[16px] font-semibold text-ink">
          {request.targetName}
          {request.targetRole && (
            <span className="font-normal text-muted"> · {request.targetRole}</span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <BoardyStatusPill status={request.status} />
          {request.priorityThread && <PriorityReplyPill />}
        </div>
      </div>

      <div className="rounded-md border border-line bg-canvas p-3">
        <p className="mb-1 text-[12px] font-semibold text-muted">
          Draft request email — to boardy@boardy.ai (sends only after you approve)
        </p>
        <p className="text-[14px] font-semibold text-ink">{request.draftedSubject}</p>
        <p className="mt-1 whitespace-pre-line text-[14px] leading-relaxed text-ink">
          {request.draftedBody}
        </p>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <p className="mb-1 text-[12px] font-semibold text-muted">Why now</p>
          <p className="text-[14px] text-ink">{request.targetContext}</p>
        </div>
        <div>
          <p className="mb-1 text-[12px] font-semibold text-muted">What you bring them</p>
          <p className="text-[14px] text-ink">{request.offerSummary}</p>
        </div>
      </div>

      {request.replySummary && (
        <div className="rounded-md border border-line bg-needs-tint p-3">
          <p className="mb-1 text-[12px] font-semibold text-muted">Boardy&apos;s reply</p>
          <p className="text-[14px] text-ink">{request.replySummary}</p>
        </div>
      )}

      {error && <p className="text-[13px] font-semibold text-failed-text">{error}</p>}

      {request.status === "draft" && !declining && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex-1" />
          <button type="button" disabled={busy} onClick={() => act("approve", {})} className={btnApprove}>
            {busy ? <Loader2 size={15} className="animate-spin" /> : null}
            Approve
          </button>
          <button type="button" disabled={busy} onClick={() => setDeclining(true)} className={btnDeny}>
            <X size={15} /> Decline
          </button>
          <button type="button" disabled={busy} onClick={() => act("cancel", {})} className={btnSecondary}>
            Cancel
          </button>
        </div>
      )}

      {request.status === "draft" && declining && (
        <div className="flex flex-col gap-2">
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason (optional)"
            className={inputCls}
          />
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={busy} onClick={() => act("decline", { reason })} className={btnDeny}>
              {busy ? <Loader2 size={15} className="animate-spin" /> : <X size={15} />}
              Confirm decline
            </button>
            <button type="button" onClick={() => setDeclining(false)} className={btnSecondary}>
              Back
            </button>
          </div>
        </div>
      )}

      {request.status === "approved" && (
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-[13px] text-muted">
            Send from your address via
            <input
              value={sentVia}
              onChange={(e) => setSentVia(e.target.value)}
              placeholder="gmail"
              className={`${inputCls} w-36`}
            />
          </label>
          <span className="flex-1" />
          <button
            type="button"
            disabled={busy || !sentVia.trim()}
            onClick={() => act("send", { sentVia: sentVia.trim() })}
            className={btnApprove}
          >
            {busy ? <Loader2 size={15} className="animate-spin" /> : null}
            Send to Boardy
          </button>
          <button type="button" disabled={busy} onClick={() => act("cancel", {})} className={btnSecondary}>
            Cancel
          </button>
        </div>
      )}

      {request.status === "sent" && !triaging && (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-[13px] text-muted">
            Sent — when Boardy replies, triage it here as a priority thread.
          </p>
          <span className="flex-1" />
          <button type="button" disabled={busy} onClick={() => setTriaging(true)} className={btnPrimary}>
            Boardy replied
          </button>
        </div>
      )}

      {request.status === "sent" && triaging && (
        <div className="flex flex-col gap-2">
          <label className="flex flex-col gap-1.5">
            <span className="text-[12px] font-semibold text-muted">
              Reply summary (what Boardy said)
            </span>
            <textarea
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              rows={3}
              placeholder="e.g. Boardy knows Alex — double-opt-in ask going out Thursday."
              className={textareaCls}
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => act("reply", { summary })}
              className={btnPrimary}
            >
              {busy && <Loader2 size={15} className="animate-spin" />}
              {busy ? "Triaging" : "Triage as priority"}
            </button>
            <button type="button" onClick={() => setTriaging(false)} className={btnSecondary}>
              Back
            </button>
          </div>
        </div>
      )}

      <details className="text-[13px]">
        <summary className="cursor-pointer font-semibold text-muted">Lineage</summary>
        <div className="mt-2">
          <BoardyTimeline events={request.events} />
        </div>
      </details>
    </div>
  );
}

export function BoardyTab({
  seed,
  onSeedConsumed,
}: {
  seed: { targetName: string; targetRole?: string } | null;
  onSeedConsumed: () => void;
}) {
  const [requests, setRequests] = useState<BoardyRequestView[] | null>(null);
  const [composing, setComposing] = useState(false);
  // Composer fields.
  const [targetName, setTargetName] = useState("");
  const [targetRole, setTargetRole] = useState("");
  const [targetContext, setTargetContext] = useState("");
  const [offerSummary, setOfferSummary] = useState("");
  const [mode, setMode] = useState<ConnectorMode>("leads");
  const [tenantName, setTenantName] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const res = await fetch("/api/connector/boardy");
    if (res.ok) {
      const json = await res.json();
      setRequests(json.requests as BoardyRequestView[]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // A directory match seeds the composer ("Ask Boardy for an intro").
  useEffect(() => {
    if (seed) {
      setTargetName(seed.targetName);
      setTargetRole(seed.targetRole ?? "");
      setComposing(true);
      onSeedConsumed();
    }
  }, [seed, onSeedConsumed]);

  const draft = useCallback(async () => {
    setDrafting(true);
    setError(null);
    try {
      const res = await fetch("/api/connector/boardy", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          targetName,
          targetRole: targetRole.trim() || null,
          targetContext,
          offerSummary,
          mode,
          tenantName,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not draft the request.");
      setTargetName("");
      setTargetRole("");
      setTargetContext("");
      setOfferSummary("");
      setTenantName("");
      setComposing(false);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not draft the request.");
    } finally {
      setDrafting(false);
    }
  }, [targetName, targetRole, targetContext, offerSummary, mode, tenantName, refresh]);

  if (requests === null) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted">
        <Loader2 size={16} className="animate-spin" /> Loading Boardy requests
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-lg bg-paper p-5 shadow-hairline">
        <h2 className="aos-subheading">Boardy escalation rail</h2>
        <p className="mt-1 max-w-3xl text-[13px] leading-relaxed text-muted">
          When your own network has no warm path to a target, escalate to Boardy —
          the AI superconnector. The connector drafts a context-rich request email;
          you approve it per instance; it sends from your own address to
          boardy@boardy.ai. Boardy is free to use, and his double-opt-in norms
          apply on his side. Escalation is optional — the native loop never waits
          on it.
        </p>
        {!composing && (
          <div className="mt-3">
            <button type="button" onClick={() => setComposing(true)} className={btnPrimary}>
              <MailPlus size={15} /> New Boardy request
            </button>
          </div>
        )}
      </div>

      {composing && (
        <div className="flex flex-col gap-3 rounded-lg bg-paper p-5 shadow-hairline">
          <h3 className="aos-subheading">Draft a Boardy request</h3>
          <p className="text-[13px] text-muted">
            Auto-draft only — nothing sends until you approve it.
          </p>
          <div className="grid gap-3 md:grid-cols-3">
            <label className="flex flex-col gap-1.5">
              <span className="text-[12px] font-semibold text-muted">Your name</span>
              <input value={tenantName} onChange={(e) => setTenantName(e.target.value)} placeholder="Tico Hamphill" className={inputCls} />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-[12px] font-semibold text-muted">Target name</span>
              <input value={targetName} onChange={(e) => setTargetName(e.target.value)} placeholder="Alex Rivera" className={inputCls} />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-[12px] font-semibold text-muted">Target role (optional)</span>
              <input value={targetRole} onChange={(e) => setTargetRole(e.target.value)} placeholder="Partner, Sequoia" className={inputCls} />
            </label>
          </div>
          <label className="flex flex-col gap-1.5">
            <span className="text-[12px] font-semibold text-muted">
              Why now — who they are, why this intro (min 20 chars)
            </span>
            <textarea value={targetContext} onChange={(e) => setTargetContext(e.target.value)} rows={3} className={textareaCls} />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[12px] font-semibold text-muted">
              What you bring them — your offer (min 20 chars)
            </span>
            <textarea value={offerSummary} onChange={(e) => setOfferSummary(e.target.value)} rows={3} className={textareaCls} />
          </label>
          <label className="flex max-w-xs flex-col gap-1.5">
            <span className="text-[12px] font-semibold text-muted">Mode</span>
            <select value={mode} onChange={(e) => setMode(e.target.value as ConnectorMode)} className={inputCls}>
              <option value="leads">Leads</option>
              <option value="funding">Funding</option>
            </select>
          </label>
          {error && <p className="text-[13px] font-semibold text-failed-text">{error}</p>}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={drafting || !targetName.trim() || !tenantName.trim()}
              onClick={draft}
              className={btnPrimary}
            >
              {drafting && <Loader2 size={15} className="animate-spin" />}
              {drafting ? "Drafting" : "Draft request"}
            </button>
            <button type="button" onClick={() => setComposing(false)} className={btnSecondary}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {requests.length === 0 ? (
        <div className="rounded-lg bg-paper p-6 text-[14px] text-muted shadow-hairline">
          No Boardy requests yet. Draft one when your network has no warm path —
          Boardy is free, and every request needs your per-instance approval
          before anything sends.
        </div>
      ) : (
        requests.map((r) => <RequestCard key={r.id} request={r} onChanged={refresh} />)
      )}
    </div>
  );
}
