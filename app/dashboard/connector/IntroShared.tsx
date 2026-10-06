// Marketr — Connector Agent slice 4 UI: shared bits for the approval inbox
// and the introductions list/detail.
// Slice 5: ModePill — the LEADS/FUNDING mode an introduction was proposed
// in (data, not an agent state — monochrome, never the status colors).
// Agentic OS design system: tokens only, Lucide only, monochrome status
// pills (intro lifecycle states are data, not agent states — the
// running/needs/done/failed shapes stay reserved for agents).

import { ArrowRight } from "lucide-react";
import type {
  ConnectorIntroductionEventView,
  ConnectorIntroductionStatus,
} from "@/lib/connector/introductions";
import type { ConnectorMode } from "@/lib/connector/modes";

export interface PathSnapshot {
  hops: Array<{ kind: string; id: string | null; name: string }>;
  strength: number;
  components: { tenantWarmth: number; linkStrength: number; freshness: number };
  explanation: { text: string; facts: { lastTouchText: string } };
  mutual: { id: string; name: string };
  target: { kind: string; id: string; name: string };
}

export function asPathSnapshot(v: unknown): PathSnapshot | null {
  if (!v || typeof v !== "object") return null;
  const s = v as Record<string, unknown>;
  if (!Array.isArray(s["hops"])) return null;
  return s as unknown as PathSnapshot;
}

export const INTRO_STATUS_LABELS: Record<ConnectorIntroductionStatus, string> = {
  proposed: "Proposed",
  side_a_accepted: "Side A accepted",
  side_b_accepted: "Both accepted",
  made: "Made",
  followed_up: "Followed up",
  declined: "Declined",
  expired: "Expired",
  withdrawn: "Withdrawn",
};

export function StatusPill({ status }: { status: ConnectorIntroductionStatus }) {
  return (
    <span className="inline-flex h-7 shrink-0 items-center rounded-full border border-line bg-canvas px-3 text-[0.75rem] font-semibold text-ink">
      {INTRO_STATUS_LABELS[status]}
    </span>
  );
}

export const MODE_LABELS: Record<ConnectorMode, string> = {
  leads: "Leads",
  funding: "Funding",
};

/** Slice 5: which mode the introduction was proposed in. */
export function ModePill({ mode }: { mode: ConnectorMode }) {
  return (
    <span
      className="inline-flex h-7 shrink-0 items-center rounded-full bg-black px-3 text-[0.75rem] font-semibold text-white"
      title={`Proposed in ${MODE_LABELS[mode]} mode`}
    >
      {MODE_LABELS[mode]}
    </span>
  );
}

export function StrengthMeter({ strength }: { strength: number }) {
  const pct = Math.round(strength * 100);
  return (
    <span className="flex items-center gap-2" title={`Path strength ${pct}%`}>
      <span className="h-2 w-24 overflow-hidden rounded-full bg-canvas">
        <span className="block h-full rounded-full bg-ink" style={{ width: `${pct}%` }} />
      </span>
      <span className="text-[0.8125rem] font-semibold text-ink">{pct}%</span>
    </span>
  );
}

/** The frozen IntroPath the tenant approved, rendered from the snapshot. */
export function PathSnapshotView({ snapshot }: { snapshot: unknown }) {
  const path = asPathSnapshot(snapshot);
  if (!path) {
    return <p className="text-[0.8125rem] text-muted">Path snapshot unavailable.</p>;
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-[0.875rem] font-semibold text-ink">
          {path.hops.map((h, i) => (
            <span key={`${h.kind}-${h.id ?? "tenant"}-${i}`} className="flex items-center gap-1.5">
              {i > 0 && <ArrowRight size={14} className="text-muted" />}
              <span className={i === 0 ? "text-muted" : ""}>{h.name}</span>
            </span>
          ))}
        </div>
        <StrengthMeter strength={path.strength} />
      </div>
      <p className="text-[0.875rem] leading-relaxed text-ink">{path.explanation.text}</p>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[0.75rem] text-muted">
        <span>
          Your warmth with {path.mutual.name}:{" "}
          <span className="font-semibold text-ink">{path.components.tenantWarmth}/100</span>
        </span>
        <span>
          Their link:{" "}
          <span className="font-semibold text-ink">
            {Math.round(path.components.linkStrength * 100)}%
          </span>
        </span>
        <span>
          Freshness:{" "}
          <span className="font-semibold text-ink">
            {Math.round(path.components.freshness * 100)}%
          </span>
        </span>
        <span>
          Last touch:{" "}
          <span className="font-semibold text-ink">{path.explanation.facts.lastTouchText}</span>
        </span>
      </div>
    </div>
  );
}

const EVENT_LABELS: Record<string, string> = {
  proposed: "Proposed",
  tenant_approved: "You approved the draft",
  tenant_declined: "You declined the proposal",
  ask_sent_to_side_a: "Ask sent to side A",
  side_a_accepted: "Side A accepted the ask",
  side_a_declined: "Side A declined the ask",
  offer_sent_to_side_b: "Offer sent to side B",
  side_b_accepted: "Side B accepted the offer",
  side_b_declined: "Side B declined the offer",
  intro_sent: "Intro made",
  followup_proposed: "Followup drafted",
  followup_sent: "Followup sent",
  withdrawn: "Withdrawn",
  expired: "Expired",
};

/** The full lineage timeline: who did what, what was said, when. */
export function IntroTimeline({ events }: { events: ConnectorIntroductionEventView[] }) {
  if (events.length === 0) {
    return <p className="text-[0.8125rem] text-muted">No events yet.</p>;
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
              <span className="text-[0.875rem] font-semibold text-ink">
                {EVENT_LABELS[e.kind] ?? e.kind}
              </span>
              <span className="text-[0.75rem] text-muted">
                {e.actorIdentity} · {new Date(e.createdAt).toLocaleString()}
              </span>
            </div>
            {e.message && (
              <p className="mt-1 rounded-md border border-line bg-canvas p-2.5 text-[0.8125rem] leading-relaxed text-ink">
                {e.message}
              </p>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

export const btnApprove =
  "flex h-11 min-w-[88px] items-center justify-center gap-1.5 rounded-full bg-done px-4 text-sm font-semibold text-white aos-press disabled:opacity-40";

export const btnDeny =
  "flex h-11 min-w-[88px] items-center justify-center gap-1.5 rounded-full bg-paper px-4 text-sm font-semibold text-failed-text aos-press shadow-[inset_0_0_0_1.5px_var(--aos-failed)] disabled:opacity-40";

export const btnPrimary =
  "aos-press flex h-11 items-center gap-2 rounded-full bg-black px-5 text-[0.9375rem] font-semibold text-white disabled:opacity-50";

export const btnSecondary =
  "aos-press flex h-11 items-center gap-2 rounded-full bg-paper px-5 text-[0.9375rem] font-semibold text-ink shadow-outline disabled:opacity-50";

export const inputCls =
  "h-control rounded-md border border-control bg-paper px-3 text-[0.9375rem] text-ink";

export const textareaCls =
  "rounded-md border border-control bg-paper px-3 py-2 text-[0.875rem] leading-relaxed text-ink";

// ---------------------------------------------------------------------------
// Slice 6 — Directory + Boardy rail shared bits.
// Agentic OS design system: switches are 44×26 pills (on: ink, off:
// disabled-fg) with role=switch and a visible label to the left; Boardy
// request statuses are data (monochrome pills, like intro statuses); the
// PRIORITY reply flag is a needs-you signal — yellow fill, black text,
// triangle shape (it demands the tenant's attention).
// ---------------------------------------------------------------------------

export function Switch({
  on,
  onChange,
  label,
  disabled,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={`relative h-[26px] w-11 shrink-0 rounded-full transition-colors disabled:opacity-40 ${
        on ? "bg-ink" : "bg-disabled-fg"
      }`}
    >
      <span
        className={`absolute top-[3px] h-5 w-5 rounded-full bg-paper shadow transition-all ${
          on ? "left-[21px]" : "left-[3px]"
        }`}
        aria-hidden
      />
    </button>
  );
}

/** A labeled switch row: visible label left, switch right. */
export function SwitchRow({
  on,
  onChange,
  label,
  hint,
  disabled,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <p className="text-[0.9375rem] font-semibold text-ink">{label}</p>
        {hint && <p className="mt-0.5 text-[0.8125rem] text-muted">{hint}</p>}
      </div>
      <Switch on={on} onChange={onChange} label={label} disabled={disabled} />
    </div>
  );
}

export type BoardyRequestStatusUI =
  | "draft"
  | "approved"
  | "declined"
  | "sent"
  | "replied"
  | "cancelled";

export const BOARDY_STATUS_LABELS: Record<BoardyRequestStatusUI, string> = {
  draft: "Draft",
  approved: "Approved",
  declined: "Declined",
  sent: "Sent",
  replied: "Replied",
  cancelled: "Cancelled",
};

/** Slice 6: Boardy request status — data, not an agent state: monochrome. */
export function BoardyStatusPill({ status }: { status: BoardyRequestStatusUI }) {
  return (
    <span className="inline-flex h-7 shrink-0 items-center rounded-full border border-line bg-canvas px-3 text-[0.75rem] font-semibold text-ink">
      {BOARDY_STATUS_LABELS[status] ?? status}
    </span>
  );
}

/** The priority-reply flag: needs-you yellow + triangle + black text. */
export function PriorityReplyPill() {
  return (
    <span className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full bg-needs px-3 text-[0.75rem] font-semibold text-black">
      <span
        className="aos-shape aos-shape--needs [--aos-shape-size:12px]"
        style={{ color: "inherit" }}
        aria-hidden
      />
      Priority reply
    </span>
  );
}
