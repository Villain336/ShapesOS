// Marketr — Connector Agent slice 4 UI: the tenant's approval inbox.
// Every proposal lands here with the full IntroPath + draft copy. The
// tenant approves every draft in v1 (reputation is the product). Approval
// sends the ask to side A via the tenant's connected messaging account.
// Agentic OS design system: needs banner, done approve, failed-ring deny.

"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Inbox, Loader2, X } from "lucide-react";
import type { ConnectorIntroductionView } from "@/lib/connector/introductions";
import {
  btnApprove,
  btnDeny,
  inputCls,
  PathSnapshotView,
  StatusPill,
} from "./IntroShared";

function ApprovalCard({
  intro,
  onChanged,
}: {
  intro: ConnectorIntroductionView;
  onChanged: () => void;
}) {
  const [sentVia, setSentVia] = useState("gmail");
  const [reason, setReason] = useState("");
  const [declining, setDeclining] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const act = useCallback(
    async (path: string, body: Record<string, unknown>) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(`/api/connector/intros/${intro.id}/${path}`, {
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
    [intro.id, onChanged],
  );

  return (
    <div className="flex flex-col gap-4 rounded-lg bg-paper p-5 shadow-hairline">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-[16px] font-semibold text-ink">
          {intro.personA.name} <span className="font-normal text-muted">→</span>{" "}
          {intro.personB.name}
        </div>
        <StatusPill status={intro.status} />
      </div>

      <PathSnapshotView snapshot={intro.introPathSnapshot} />

      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-md border border-line bg-canvas p-3">
          <p className="mb-1 text-[12px] font-semibold text-muted">
            Draft ask — to {intro.personA.name} (side A)
          </p>
          <p className="text-[14px] leading-relaxed text-ink">{intro.draftAskMessage}</p>
        </div>
        <div className="rounded-md border border-line bg-canvas p-3">
          <p className="mb-1 text-[12px] font-semibold text-muted">
            Draft offer — to {intro.personB.name} (side B, after side A accepts)
          </p>
          <p className="text-[14px] leading-relaxed text-ink">{intro.draftOfferMessage}</p>
        </div>
      </div>

      {intro.rateLimitOverrideMaxAsks != null && (
        <p className="text-[12px] text-muted">
          Rate-limit override on this proposal: {intro.rateLimitOverrideMaxAsks} ask
          {intro.rateLimitOverrideMaxAsks === 1 ? "" : "s"} per{" "}
          {intro.rateLimitOverrideWindowDays} days.
        </p>
      )}

      {error && <p className="text-[13px] font-semibold text-failed-text">{error}</p>}

      {!declining ? (
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-[13px] text-muted">
            Send the ask via
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
            onClick={() => act("approve", { sentVia: sentVia.trim() })}
            className={btnApprove}
          >
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />}
            Approve
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => setDeclining(true)}
            className={btnDeny}
          >
            <X size={15} />
            Decline
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <label className="flex flex-col gap-1.5">
            <span className="text-[12px] font-semibold text-muted">
              Reason (optional — recorded on the intro)
            </span>
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Wrong timing"
              className={inputCls}
            />
          </label>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => act("decline", { reason: reason.trim() || undefined })}
              className={btnDeny}
            >
              {busy ? <Loader2 size={15} className="animate-spin" /> : <X size={15} />}
              Confirm decline
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setDeclining(false)}
              className="aos-press flex h-11 items-center rounded-full bg-paper px-5 text-sm font-semibold text-ink shadow-outline"
            >
              Back
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function ApprovalsTab({ onChanged }: { onChanged: () => void }) {
  const [inbox, setInbox] = useState<ConnectorIntroductionView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/connector/intros?inbox=1");
      if (!res.ok) throw new Error("Could not load the approval inbox.");
      const json = await res.json();
      setInbox(json.introductions);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the approval inbox.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const changed = useCallback(() => {
    void load();
    onChanged();
  }, [load, onChanged]);

  if (inbox === null) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted">
        <Loader2 size={16} className="animate-spin" /> Loading approvals
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {error && <p className="text-[13px] font-semibold text-failed-text">{error}</p>}
      {inbox.length > 0 && (
        <div role="status" className="flex items-center gap-2.5 rounded-lg bg-needs px-4 py-3 text-ink">
          <span
            className="aos-shape aos-shape--needs [--aos-shape-size:14px]"
            style={{ color: "inherit" }}
            aria-hidden
          />
          <p className="text-sm font-semibold">
            {inbox.length} intro{inbox.length === 1 ? "" : "s"} waiting on your sign-off —
            nothing sends until you approve.
          </p>
        </div>
      )}
      {inbox.length === 0 ? (
        <div className="flex items-center gap-2 rounded-lg bg-paper p-6 text-[14px] text-muted shadow-hairline">
          <Inbox size={16} />
          Nothing awaiting approval. Proposed intros land here with the full path and draft copy.
        </div>
      ) : (
        inbox.map((i) => <ApprovalCard key={i.id} intro={i} onChanged={changed} />)
      )}
    </div>
  );
}
