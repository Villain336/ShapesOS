// Marketr — Connector Agent slice 4 UI: introductions list + detail.
// The detail renders the full lifecycle timeline (every approval event:
// who proposed, who accepted, what was said, when) and the actions legal
// from the current state: record side A/B responses, make the intro (only
// after both acceptances), propose/approve followups, withdraw.
// Agentic OS design system: tokens only, Lucide only.

"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowRight, Loader2 } from "lucide-react";
import type {
  ConnectorIntroductionDetailView,
  ConnectorIntroductionStatus,
  ConnectorIntroductionView,
} from "@/lib/connector/introductions";
import {
  btnDeny,
  btnPrimary,
  btnSecondary,
  inputCls,
  IntroTimeline,
  PathSnapshotView,
  StatusPill,
  textareaCls,
} from "./IntroShared";

const TERMINAL: ConnectorIntroductionStatus[] = ["declined", "expired", "withdrawn"];

function fmtDate(d: string | Date | null): string {
  if (!d) return "—";
  return new Date(d).toLocaleString();
}

function ActionRow({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2">{children}</div>;
}

function useIntroAction(introId: string, onDone: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(
    async (path: string, body: Record<string, unknown>) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(`/api/connector/intros/${introId}/${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? "Action failed.");
        onDone();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Action failed.");
      } finally {
        setBusy(false);
      }
    },
    [introId, onDone],
  );
  return { run, busy, error };
}

function IntroActions({
  intro,
  onDone,
}: {
  intro: ConnectorIntroductionDetailView;
  onDone: () => void;
}) {
  const { run, busy, error } = useIntroAction(intro.id, onDone);
  const [identity, setIdentity] = useState("");
  const [note, setNote] = useState("");
  const [sentVia, setSentVia] = useState("gmail");
  const [message, setMessage] = useState("");
  const [followupDraft, setFollowupDraft] = useState("");
  const [followupTo, setFollowupTo] = useState("both");

  const actorIdentity =
    identity.trim() ||
    (intro.status === "side_a_accepted" ? intro.personB.handles[0] : intro.personA.handles[0]) ||
    "";

  return (
    <div className="flex flex-col gap-3 rounded-lg bg-paper p-5 shadow-hairline">
      <p className="text-[12px] font-semibold text-muted">Next actions</p>
      {error && <p className="text-[13px] font-semibold text-failed-text">{error}</p>}

      {intro.status === "proposed" && intro.tenantApproved && (
        <div className="flex flex-col gap-2">
          <p className="text-[13px] text-muted">
            The ask is out to {intro.personA.name}. Record their human response —
            the agent can never accept on their behalf.
          </p>
          <ActionRow>
            <input
              value={identity}
              onChange={(e) => setIdentity(e.target.value)}
              placeholder={intro.personA.handles[0] ?? "Their identity (e.g. email)"}
              className={`${inputCls} w-56`}
            />
            <input
              value={sentVia}
              onChange={(e) => setSentVia(e.target.value)}
              placeholder="gmail"
              title="The offer to side B sends via your connected account"
              className={`${inputCls} w-32`}
            />
          </ActionRow>
          <ActionRow>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Note (optional)"
              className={`${inputCls} flex-1`}
            />
          </ActionRow>
          <ActionRow>
            <button
              type="button"
              disabled={busy || !actorIdentity || !sentVia.trim()}
              onClick={() =>
                run("accept-a", {
                  actor: { kind: "human", identity: actorIdentity },
                  sentVia: sentVia.trim(),
                  note: note.trim() || undefined,
                })
              }
              className={btnPrimary}
            >
              {busy && <Loader2 size={15} className="animate-spin" />}
              Record side A accepted
            </button>
            <button
              type="button"
              disabled={busy || !actorIdentity}
              onClick={() =>
                run("decline-a", {
                  actor: { kind: "human", identity: actorIdentity },
                  note: note.trim() || undefined,
                })
              }
              className={btnDeny}
            >
              Record side A declined
            </button>
          </ActionRow>
        </div>
      )}

      {intro.status === "side_a_accepted" && (
        <div className="flex flex-col gap-2">
          <p className="text-[13px] text-muted">
            The offer is out to {intro.personB.name}. Record their human response.
          </p>
          <ActionRow>
            <input
              value={identity}
              onChange={(e) => setIdentity(e.target.value)}
              placeholder={intro.personB.handles[0] ?? "Their identity (e.g. email)"}
              className={`${inputCls} w-56`}
            />
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Note (optional)"
              className={`${inputCls} flex-1`}
            />
          </ActionRow>
          <ActionRow>
            <button
              type="button"
              disabled={busy || !actorIdentity}
              onClick={() =>
                run("accept-b", {
                  actor: { kind: "human", identity: actorIdentity },
                  note: note.trim() || undefined,
                })
              }
              className={btnPrimary}
            >
              {busy && <Loader2 size={15} className="animate-spin" />}
              Record side B accepted
            </button>
            <button
              type="button"
              disabled={busy || !actorIdentity}
              onClick={() =>
                run("decline-b", {
                  actor: { kind: "human", identity: actorIdentity },
                  note: note.trim() || undefined,
                })
              }
              className={btnDeny}
            >
              Record side B declined
            </button>
          </ActionRow>
        </div>
      )}

      {intro.status === "side_b_accepted" && (
        <div className="flex flex-col gap-2">
          <p className="text-[13px] text-muted">
            Both sides accepted — the intro can go out now, and only now.
          </p>
          <label className="flex flex-col gap-1.5">
            <span className="text-[12px] font-semibold text-muted">Intro message</span>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={4}
              placeholder={`${intro.personA.name} — meet ${intro.personB.name}. …`}
              className={textareaCls}
            />
          </label>
          <ActionRow>
            <label className="flex items-center gap-2 text-[13px] text-muted">
              Send via
              <input
                value={sentVia}
                onChange={(e) => setSentVia(e.target.value)}
                className={`${inputCls} w-32`}
              />
            </label>
            <span className="flex-1" />
            <button
              type="button"
              disabled={busy || message.trim().length < 20 || !sentVia.trim()}
              onClick={() => run("make", { message: message.trim(), sentVia: sentVia.trim() })}
              className={btnPrimary}
            >
              {busy && <Loader2 size={15} className="animate-spin" />}
              Make the intro
            </button>
          </ActionRow>
        </div>
      )}

      {(intro.status === "made" || intro.status === "followed_up") &&
        !intro.pendingFollowupDraft && (
          <div className="flex flex-col gap-2">
            <p className="text-[13px] text-muted">
              Post-intro nudge — drafts land in your approval inbox logic: you
              approve every followup before it sends.
            </p>
            <label className="flex flex-col gap-1.5">
              <span className="text-[12px] font-semibold text-muted">Followup draft</span>
              <textarea
                value={followupDraft}
                onChange={(e) => setFollowupDraft(e.target.value)}
                rows={3}
                placeholder="Hi you two — did you manage to connect?"
                className={textareaCls}
              />
            </label>
            <ActionRow>
              <select
                value={followupTo}
                onChange={(e) => setFollowupTo(e.target.value)}
                className={inputCls}
              >
                <option value="both">Both</option>
                <option value="side_a">{intro.personA.name} (side A)</option>
                <option value="side_b">{intro.personB.name} (side B)</option>
              </select>
              <button
                type="button"
                disabled={busy || followupDraft.trim().length < 20}
                onClick={() =>
                  run("followup", { draft: followupDraft.trim(), to: followupTo })
                }
                className={btnSecondary}
              >
                {busy && <Loader2 size={15} className="animate-spin" />}
                Draft followup
              </button>
            </ActionRow>
          </div>
        )}

      {intro.pendingFollowupDraft && (
        <div className="flex flex-col gap-2 rounded-md border border-line bg-canvas p-3">
          <p className="text-[12px] font-semibold text-muted">
            Pending followup draft — to{" "}
            {intro.pendingFollowupTo === "side_a"
              ? intro.personA.name
              : intro.pendingFollowupTo === "side_b"
                ? intro.personB.name
                : "both"}
          </p>
          <p className="text-[14px] leading-relaxed text-ink">{intro.pendingFollowupDraft}</p>
          <ActionRow>
            <label className="flex items-center gap-2 text-[13px] text-muted">
              Send via
              <input
                value={sentVia}
                onChange={(e) => setSentVia(e.target.value)}
                className={`${inputCls} w-32`}
              />
            </label>
            <button
              type="button"
              disabled={busy || !sentVia.trim()}
              onClick={() => run("followup/approve", { sentVia: sentVia.trim() })}
              className={btnPrimary}
            >
              {busy && <Loader2 size={15} className="animate-spin" />}
              Approve and send followup
            </button>
          </ActionRow>
        </div>
      )}

      {!TERMINAL.includes(intro.status) && (
        <ActionRow>
          <button
            type="button"
            disabled={busy}
            onClick={() => run("withdraw", {})}
            className={btnDeny}
          >
            Withdraw intro
          </button>
        </ActionRow>
      )}
    </div>
  );
}

function IntroDetail({
  intro,
  onDone,
  onBack,
}: {
  intro: ConnectorIntroductionDetailView;
  onDone: () => void;
  onBack: () => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <button type="button" onClick={onBack} className={btnSecondary}>
        <ArrowRight size={15} className="rotate-180" /> All introductions
      </button>

      <div className="flex flex-col gap-4 rounded-lg bg-paper p-5 shadow-hairline">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-[18px] font-semibold text-ink">
            {intro.personA.name} <span className="font-normal text-muted">→</span>{" "}
            {intro.personB.name}
          </div>
          <StatusPill status={intro.status} />
        </div>
        <PathSnapshotView snapshot={intro.introPathSnapshot} />
        <div className="grid gap-x-6 gap-y-1 text-[13px] text-muted md:grid-cols-2">
          <span>
            Tenant approval:{" "}
            <span className="font-semibold text-ink">
              {intro.tenantApproved
                ? `${intro.tenantApprovedBy} · ${fmtDate(intro.tenantApprovedAt)}`
                : "pending"}
            </span>
          </span>
          <span>
            Side A acceptance:{" "}
            <span className="font-semibold text-ink">
              {intro.sideAAcceptedBy
                ? `${intro.sideAAcceptedBy} · ${fmtDate(intro.sideAAcceptedAt)}`
                : "—"}
            </span>
          </span>
          <span>
            Side B acceptance:{" "}
            <span className="font-semibold text-ink">
              {intro.sideBAcceptedBy
                ? `${intro.sideBAcceptedBy} · ${fmtDate(intro.sideBAcceptedAt)}`
                : "—"}
            </span>
          </span>
          <span>
            Made:{" "}
            <span className="font-semibold text-ink">
              {intro.madeSentAt
                ? `${intro.madeSentBy} via ${intro.madeSentVia} · ${fmtDate(intro.madeSentAt)}`
                : "—"}
            </span>
          </span>
          {intro.declinedAt && (
            <span>
              Declined:{" "}
              <span className="font-semibold text-ink">
                {intro.declinedBy} · {fmtDate(intro.declinedAt)}
                {intro.declineReason ? ` — ${intro.declineReason}` : ""}
              </span>
            </span>
          )}
          {intro.followupCount > 0 && (
            <span>
              Followups sent:{" "}
              <span className="font-semibold text-ink">{intro.followupCount}</span>
            </span>
          )}
        </div>
      </div>

      <IntroActions intro={intro} onDone={onDone} />

      <div className="flex flex-col gap-3 rounded-lg bg-paper p-5 shadow-hairline">
        <p className="aos-subheading">Lifecycle timeline</p>
        <IntroTimeline events={intro.events} />
      </div>
    </div>
  );
}

export function IntroductionsTab() {
  const [intros, setIntros] = useState<ConnectorIntroductionView[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ConnectorIntroductionDetailView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/connector/intros");
      if (!res.ok) throw new Error("Could not load introductions.");
      const json = await res.json();
      setIntros(json.introductions);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load introductions.");
    }
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    setDetail(null);
    try {
      const res = await fetch(`/api/connector/intros/${id}`);
      if (!res.ok) throw new Error("Could not load the introduction.");
      setDetail(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the introduction.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const select = useCallback(
    (id: string | null) => {
      setSelectedId(id);
      if (id) void loadDetail(id);
      else setDetail(null);
    },
    [loadDetail],
  );

  const refreshAll = useCallback(() => {
    void load();
    if (selectedId) void loadDetail(selectedId);
  }, [load, loadDetail, selectedId]);

  if (intros === null) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted">
        <Loader2 size={16} className="animate-spin" /> Loading introductions
      </div>
    );
  }

  if (selectedId && detail) {
    return <IntroDetail intro={detail} onDone={refreshAll} onBack={() => select(null)} />;
  }

  return (
    <div className="flex flex-col gap-3">
      {error && <p className="text-[13px] font-semibold text-failed-text">{error}</p>}
      {intros.length === 0 ? (
        <div className="rounded-lg bg-paper p-6 text-[14px] text-muted shadow-hairline">
          No introductions yet. The connector agent proposes intros from the paths
          it finds — each one lands in your approval inbox first.
        </div>
      ) : (
        intros.map((i) => (
          <button
            key={i.id}
            type="button"
            onClick={() => select(i.id)}
            className="aos-press flex items-center justify-between gap-3 rounded-sm bg-paper px-4 py-3 text-left shadow-hairline"
          >
            <span className="min-w-0">
              <span className="block truncate text-[15px] font-semibold text-ink">
                {i.personA.name} <span className="font-normal text-muted">→</span> {i.personB.name}
              </span>
              <span className="block truncate text-[13px] text-muted">
                Proposed {new Date(i.createdAt).toLocaleDateString()}
                {i.followupCount > 0 &&
                  ` · ${i.followupCount} followup${i.followupCount === 1 ? "" : "s"}`}
              </span>
            </span>
            <StatusPill status={i.status} />
          </button>
        ))
      )}
    </div>
  );
}
