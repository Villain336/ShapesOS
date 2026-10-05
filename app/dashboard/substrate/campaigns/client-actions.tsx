// Marketr — Campaign client-side actions.
// Plain fetch calls against /api/substrate/campaigns/*, then router.refresh().
// Agentic OS pressables: approve = done fill, reject = deny idiom, run = running fill.
// Styling only — no behavior changes.

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { btnGhost, btnPrimary, inputCls, labelCls } from "../ui";
import { confirmAction } from "@/lib/ui/feedback";

// Local decision idioms (not in ../ui): approve → done, reject → deny,
// backfill scan → running.
const btnApprove =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-done px-4 text-sm font-semibold text-white aos-press hover:bg-done/90 disabled:opacity-40";
const btnDeny =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-paper px-4 text-sm font-semibold text-failed-text shadow-[inset_0_0_0_1.5px_var(--aos-failed)] aos-press hover:bg-failed-tint disabled:opacity-40";
const btnRun =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-running px-4 text-sm font-semibold text-white aos-press hover:bg-running/90 disabled:opacity-40";
import {
  CAMPAIGN_STAGES,
  CAMPAIGN_STAGE_LABELS,
  LINKED_TYPES,
  LINKED_TYPE_LABELS,
  type CampaignStageKey,
} from "@/lib/substrate/campaigns/types";

async function api(path: string, method: string, body?: unknown) {
  const res = await fetch(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(json.error ?? `Request failed (${res.status})`);
  return json;
}

export function NewCampaignForm({ parentId }: { parentId?: string }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [objective, setObjective] = useState("lead_gen");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const path = parentId
        ? `/api/substrate/campaigns/${parentId}/children`
        : "/api/substrate/campaigns";
      const json = (await api(path, "POST", { name, objective })) as { campaign?: { id: string }; child?: { id: string } };
      const id = json.campaign?.id ?? json.child?.id;
      router.push(id ? `/dashboard/substrate/campaigns/${id}` : "/dashboard/substrate/campaigns");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="space-y-1.5">
        <label htmlFor="g2-name" className={labelCls}>Name</label>
        <input
          id="g2-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="2026 Q4 Holiday Launch"
          className={`${inputCls} w-full`}
        />
      </div>
      <div className="space-y-1.5">
        <label className={labelCls}>Objective</label>
        <select value={objective} onChange={(e) => setObjective(e.target.value || "lead_gen")} className={inputCls}>
          <option value="lead_gen">Lead generation</option>
          <option value="sale">Sale</option>
          <option value="awareness">Awareness</option>
          <option value="retention">Retention</option>
          <option value="launch">Launch</option>
        </select>
      </div>
      {error ? <p className="text-[13px] text-failed-text">{error}</p> : null}
      <button type="submit" className={btnPrimary} disabled={busy || !name.trim()}>
        {busy ? "Creating…" : parentId ? "Create sub-campaign" : "Create campaign"}
      </button>
    </form>
  );
}

export interface FragmentOption {
  linkedType: (typeof LINKED_TYPES)[number];
  linkedId: string;
  displayName: string;
}

export function AttachLinkForm({ campaignId, fragments }: { campaignId: string; fragments: FragmentOption[] }) {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [role, setRole] = useState<"primary" | "supporting">("primary");
  const [stageKey, setStageKey] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const [linkedType, linkedId] = value.split("::");
    if (!linkedType || !linkedId) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/substrate/campaigns/${campaignId}/links`, "POST", {
        linkedType,
        linkedId,
        role,
        linkSource: "human",
        ...(stageKey ? { stageKey } : {}),
      });
      router.refresh();
      setValue("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="space-y-1.5">
        <label className={labelCls}>Fragment</label>
        <select value={value} onChange={(e) => setValue(e.target.value || "")} className={`${inputCls} w-full`}>
          <option value="">Choose a fragment…</option>
          {fragments.map((f) => (
            <option key={`${f.linkedType}::${f.linkedId}`} value={`${f.linkedType}::${f.linkedId}`}>
              [{LINKED_TYPE_LABELS[f.linkedType]}] {f.displayName}
            </option>
          ))}
        </select>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <label className={labelCls}>Role</label>
          <select
            value={role}
            onChange={(e) => setRole((e.target.value as "primary" | "supporting") || "primary")}
            className={`${inputCls} w-full`}
          >
            <option value="primary">Primary</option>
            <option value="supporting">Supporting</option>
          </select>
        </div>
        <div className="space-y-1.5">
          <label className={labelCls}>Stage (optional)</label>
          <select value={stageKey} onChange={(e) => setStageKey(e.target.value || "")} className={`${inputCls} w-full`}>
            <option value="">Auto (by fragment type)</option>
            {CAMPAIGN_STAGES.map((k) => (
              <option key={k} value={k as string}>
                {CAMPAIGN_STAGE_LABELS[k as CampaignStageKey]}
              </option>
            ))}
          </select>
        </div>
      </div>
      {error ? <p className="text-[13px] text-failed-text">{error}</p> : null}
      <button type="submit" className={btnPrimary} disabled={busy || !value}>
        {busy ? "Attaching…" : "Attach to campaign"}
      </button>
    </form>
  );
}

export function UnlinkButton({ campaignId, linkId, label }: { campaignId: string; linkId: string; label: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function unlink() {
    if (!await confirmAction(`Unlink "${label}"? The fragment itself is untouched — only the link row is removed.`)) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/substrate/campaigns/${campaignId}/links/${linkId}`, "DELETE");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex shrink-0 items-center gap-2">
      <button onClick={unlink} disabled={busy} className={btnGhost}>
        {busy ? "Unlinking…" : "Unlink"}
      </button>
      {error ? <span className="text-xs text-failed-text">{error}</span> : null}
    </span>
  );
}

export function ProposalActions({ proposalId }: { proposalId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<"approved" | "rejected" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function resolve(decision: "approved" | "rejected") {
    setBusy(decision);
    setError(null);
    try {
      await api(`/api/substrate/campaigns/link-proposals/${proposalId}/resolve`, "POST", { decision });
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(null);
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button onClick={() => resolve("approved")} disabled={busy !== null} className={btnApprove}>
        {busy === "approved" ? "Approving…" : "Approve"}
      </button>
      <button onClick={() => resolve("rejected")} disabled={busy !== null} className={btnDeny}>
        {busy === "rejected" ? "Rejecting…" : "Reject"}
      </button>
      {error ? <span className="text-xs text-failed-text">{error}</span> : null}
    </span>
  );
}

export function RunScanButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function scan() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const json = (await api("/api/substrate/campaigns/link-proposals", "POST", {})) as {
        scannedFragments?: number;
        proposalsCreated?: number;
      };
      setResult(`Scanned ${json.scannedFragments ?? 0} fragments → ${json.proposalsCreated ?? 0} new proposals (pending review, zero auto-links).`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-3">
      <button onClick={scan} disabled={busy} className={btnRun}>
        {busy ? "Scanning fragments…" : "Run backfill scan"}
      </button>
      {result ? <span className="text-[13px] text-muted">{result}</span> : null}
      {error ? <span className="text-[13px] text-failed-text">{error}</span> : null}
    </span>
  );
}

export function CampaignStatusSelect({
  campaignId,
  value,
}: {
  campaignId: string;
  value: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function change(next: string) {
    if (!next) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/substrate/campaigns/${campaignId}`, "PATCH", { status: next });
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      <select
        value={value}
        onChange={(e) => change(e.target.value)}
        disabled={busy}
        className={`${inputCls} w-32`}
        aria-label="Campaign status"
      >
        <option value="draft">Draft</option>
        <option value="active">Active</option>
        <option value="paused">Paused</option>
        <option value="complete">Complete</option>
        <option value="archived">Archived</option>
      </select>
      {error ? <span className="text-xs text-failed-text">{error}</span> : null}
    </span>
  );
}

export function StageStatusSelect({
  campaignId,
  stageKey,
  value,
}: {
  campaignId: string;
  stageKey: string;
  value: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function change(next: string) {
    if (!next) return;
    setBusy(true);
    setError(null);
    try {
      // Fetch current stages, patch this one, save. Stages are the campaign's
      // own JSONB — the fragment links that populate them are untouched.
      const detail = (await api(`/api/substrate/campaigns/${campaignId}`, "GET")) as {
        campaign?: { stages?: Array<{ key: string; status: string; note: string | null; linkedRefs: unknown[] }> };
      };
      const stages = (detail.campaign?.stages ?? []).map((s) =>
        s.key === stageKey ? { ...s, status: next } : s,
      );
      await api(`/api/substrate/campaigns/${campaignId}`, "PATCH", { stages });
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      <select
        value={value}
        onChange={(e) => change(e.target.value)}
        disabled={busy}
        className={`${inputCls} w-36`}
        aria-label={`${stageKey} status`}
      >
        <option value="not_started">Not started</option>
        <option value="in_progress">In progress</option>
        <option value="complete">Complete</option>
        <option value="blocked">Blocked</option>
        <option value="skipped">Skipped</option>
      </select>
      {error ? <span className="text-xs text-failed-text">{error}</span> : null}
    </span>
  );
}
