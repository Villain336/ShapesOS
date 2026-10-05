"use client";

// Marketr — CAD + Hardware slice 2: design-change proposals, draft-for-approval.
// The AI parses the request into a structured proposal; the human reviews,
// edits the parse, and approves or rejects. Approving marks the model
// "change requested" — v1 NEVER rewrites geometry (there is no code path
// that does); the edit is carried out in the tenant's CAD tool and arrives
// as a new published version.

import { useCallback, useEffect, useState } from "react";
import {
  Loader2,
  Pencil,
  Sparkles,
  Check,
  X,
  AlertTriangle,
} from "lucide-react";
import { confirmAction } from "@/lib/ui/feedback";

interface VersionLite {
  id: string;
  versionNumber: number;
  fileName: string;
}

export interface Proposal {
  id: string;
  targetVersionId: string;
  requestedText: string;
  requestedBy: string;
  requestedAt: string;
  operation: string;
  parameters: Record<string, number | string>;
  targetFeatureLabel: string | null;
  rationale: string | null;
  parseConfidence: "high" | "medium" | "low";
  status: "draft" | "approved" | "rejected";
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  createdAt: string;
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status})`);
  return body as T;
}

const OPERATIONS = [
  "thicken_wall",
  "thin_wall",
  "add_hole",
  "remove_hole",
  "resize_feature",
  "move_feature",
  "fillet_edge",
  "chamfer_edge",
  "offset_surface",
  "smooth_region",
  "unrecognized",
];

function opLabel(op: string): string {
  return op.replace(/_/g, " ");
}

export function ProposalsTab({
  modelId,
  versions,
  currentVersionId,
  onChanged,
}: {
  modelId: string;
  versions: VersionLite[];
  currentVersionId: string | null;
  onChanged: () => void;
}) {
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [targetVersionId, setTargetVersionId] = useState(
    currentVersionId ?? versions[0]?.id ?? "",
  );
  const [requestText, setRequestText] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastParse, setLastParse] = useState<Proposal | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = statusFilter ? `?status=${statusFilter}` : "";
      const res = await api<{ proposals: Proposal[] }>(
        `/api/cad/models/${modelId}/proposals${qs}`,
      );
      setProposals(res.proposals);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load proposals.");
    } finally {
      setLoading(false);
    }
  }, [modelId, statusFilter]);

  useEffect(() => {
    load();
  }, [load]);

  async function draftProposal() {
    if (!requestText.trim() || !targetVersionId) return;
    setDrafting(true);
    setError(null);
    setLastParse(null);
    try {
      const res = await api<{ proposal: Proposal }>(
        `/api/cad/models/${modelId}/proposals`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            targetVersionId,
            requestedText: requestText.trim(),
          }),
        },
      );
      setLastParse(res.proposal);
      setRequestText("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not draft the proposal.");
    } finally {
      setDrafting(false);
    }
  }

  async function decide(id: string, action: "approve" | "reject") {
    const verb = action === "approve" ? "Approve" : "Reject";
    const consequence =
      action === "approve"
        ? " This marks the model as “change requested”. The geometry is NOT rewritten — the edit happens in your CAD tool."
        : "";
    if (!await confirmAction(`${verb} this proposal?${consequence}`)) return;
    setBusyId(id);
    setError(null);
    try {
      await api(`/api/cad/proposals/${id}/${action}`, { method: "POST" });
      await load();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : `Could not ${action} the proposal.`);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      <div className="mb-4 flex items-start gap-3 rounded-lg border border-line bg-paper p-4 shadow-hairline">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-ink" aria-hidden />
        <p className="text-sm text-muted">
          The assistant <strong className="text-ink">proposes</strong>, you{" "}
          <strong className="text-ink">decide</strong>. Approving a proposal marks
          the model as “change requested” — v1 never rewrites geometry. Carry
          the edit out in your CAD tool and publish a new version; publishing
          clears the change request.
        </p>
      </div>

      <div className="mb-4 rounded-lg border border-line bg-paper p-4 shadow-hairline">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
          <Sparkles className="h-4 w-4" aria-hidden />
          Request a design change
        </h3>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <label htmlFor="proposal-version" className="text-sm font-semibold text-ink">
            Applies to
          </label>
          <select
            id="proposal-version"
            value={targetVersionId}
            onChange={(e) => setTargetVersionId(e.target.value)}
            className="h-10 rounded-full border border-line bg-paper px-3 text-sm text-ink"
          >
            {versions.map((v) => (
              <option key={v.id} value={v.id}>
                v{v.versionNumber} — {v.fileName}
              </option>
            ))}
          </select>
        </div>
        <textarea
          value={requestText}
          onChange={(e) => setRequestText(e.target.value)}
          rows={3}
          maxLength={2000}
          placeholder='e.g. Thicken this wall to 3mm — the arm cracked in the drop test.'
          className="mt-2 w-full rounded-lg border border-line bg-canvas p-3 text-sm text-ink"
        />
        {error && <p className="mt-2 text-sm text-failed-text">{error}</p>}
        <button
          type="button"
          onClick={draftProposal}
          disabled={drafting || !requestText.trim()}
          className="mt-2 flex h-10 items-center gap-2 rounded-full bg-ink px-4 text-sm font-semibold text-paper disabled:opacity-40"
        >
          {drafting && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
          Draft proposal
        </button>
        {lastParse && (
          <div className="mt-3 rounded-lg border border-dashed border-line bg-canvas p-3">
            <p className="text-sm font-semibold text-ink">
              Parsed proposal — review it in the queue below
            </p>
            <p className="mt-1 text-sm text-muted">
              Operation: <span className="font-mono text-xs">{opLabel(lastParse.operation)}</span>
              {" · "}Confidence: {lastParse.parseConfidence}
              {lastParse.targetFeatureLabel && ` · Feature: ${lastParse.targetFeatureLabel}`}
            </p>
          </div>
        )}
      </div>

      <div className="mb-2 flex items-center gap-2">
        <label htmlFor="proposal-status" className="text-sm font-semibold text-ink">
          Queue
        </label>
        <select
          id="proposal-status"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="h-10 rounded-full border border-line bg-paper px-3 text-sm text-ink"
        >
          <option value="">All</option>
          <option value="draft">Drafts</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
        </select>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          Loading…
        </div>
      ) : proposals.length === 0 ? (
        <p className="rounded-lg border border-line bg-paper p-4 text-sm text-muted shadow-hairline">
          No proposals yet. Describe a change above — the assistant drafts it,
          you approve it.
        </p>
      ) : (
        <ul className="space-y-2">
          {proposals.map((p) => (
            <ProposalCard
              key={p.id}
              proposal={p}
              busy={busyId === p.id}
              editing={editingId === p.id}
              onEdit={() => setEditingId(p.id)}
              onEditDone={() => {
                setEditingId(null);
                load();
              }}
              onApprove={() => decide(p.id, "approve")}
              onReject={() => decide(p.id, "reject")}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function ProposalCard({
  proposal: p,
  busy,
  editing,
  onEdit,
  onEditDone,
  onApprove,
  onReject,
}: {
  proposal: Proposal;
  busy: boolean;
  editing: boolean;
  onEdit: () => void;
  onEditDone: () => void;
  onApprove: () => void;
  onReject: () => void;
}) {
  return (
    <li className="rounded-lg border border-line bg-paper p-4 shadow-hairline">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full border border-line px-2.5 py-1 font-mono text-xs text-ink">
          {opLabel(p.operation)}
        </span>
        <span
          className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
            p.status === "draft"
              ? "bg-canvas text-ink shadow-[inset_0_0_0_1.5px_var(--aos-ink)]"
              : p.status === "approved"
                ? "bg-ink text-paper"
                : "bg-canvas text-muted"
          }`}
        >
          {p.status}
        </span>
        <span className="rounded-full bg-canvas px-2.5 py-1 text-xs text-muted">
          parse confidence: {p.parseConfidence}
        </span>
      </div>
      <p className="mt-2 text-sm text-ink">“{p.requestedText}”</p>
      <dl className="mt-2 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs text-muted">Parameters</dt>
          <dd className="font-mono text-xs text-ink">{JSON.stringify(p.parameters)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Feature</dt>
          <dd className="text-sm text-ink">{p.targetFeatureLabel ?? "—"}</dd>
        </div>
        {p.rationale && (
          <div className="sm:col-span-2">
            <dt className="text-xs text-muted">Rationale</dt>
            <dd className="text-sm text-ink">{p.rationale}</dd>
          </div>
        )}
      </dl>
      <p className="mt-2 text-xs text-muted">
        Requested by {p.requestedBy} · {new Date(p.requestedAt).toLocaleString()}
        {p.decidedBy &&
          ` · Decided by ${p.decidedBy} · ${p.decidedAt ? new Date(p.decidedAt).toLocaleString() : ""}`}
        {p.decisionNote && ` — ${p.decisionNote}`}
      </p>
      {p.status === "draft" &&
        (editing ? (
          <DraftEditor proposal={p} onDone={onEditDone} />
        ) : (
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={onApprove}
              disabled={busy}
              className="flex h-9 items-center gap-1.5 rounded-full bg-ink px-4 text-sm font-semibold text-paper disabled:opacity-40"
            >
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <Check className="h-4 w-4" aria-hidden />
              )}
              Approve
            </button>
            <button
              type="button"
              onClick={onReject}
              disabled={busy}
              className="flex h-9 items-center gap-1.5 rounded-full bg-paper px-4 text-sm font-semibold text-ink shadow-[inset_0_0_0_1.5px_var(--aos-ink)] disabled:opacity-40"
            >
              <X className="h-4 w-4" aria-hidden />
              Reject
            </button>
            <button
              type="button"
              onClick={onEdit}
              className="flex h-9 items-center gap-1.5 rounded-full bg-paper px-4 text-sm font-semibold text-ink shadow-[inset_0_0_0_1.5px_var(--aos-ink)]"
            >
              <Pencil className="h-4 w-4" aria-hidden />
              Fix the parse
            </button>
          </div>
        ))}
    </li>
  );
}

function DraftEditor({ proposal, onDone }: { proposal: Proposal; onDone: () => void }) {
  const [operation, setOperation] = useState(proposal.operation);
  const [parameters, setParameters] = useState(JSON.stringify(proposal.parameters, null, 2));
  const [feature, setFeature] = useState(proposal.targetFeatureLabel ?? "");
  const [rationale, setRationale] = useState(proposal.rationale ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(parameters);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("not an object");
      }
    } catch {
      setError("Parameters must be a JSON object.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api(`/api/cad/proposals/${proposal.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          operation,
          parameters: parsed,
          targetFeatureLabel: feature || null,
          rationale: rationale || null,
        }),
      });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the edits.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-3 rounded-lg border border-dashed border-line bg-canvas p-3">
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="text-xs text-muted">
          Operation
          <select
            value={operation}
            onChange={(e) => setOperation(e.target.value)}
            className="mt-1 h-10 w-full rounded-full border border-line bg-paper px-3 text-sm text-ink"
          >
            {OPERATIONS.map((o) => (
              <option key={o} value={o}>
                {opLabel(o)}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-muted">
          Feature label
          <input
            value={feature}
            onChange={(e) => setFeature(e.target.value)}
            placeholder="e.g. this wall"
            className="mt-1 h-10 w-full rounded-full border border-line bg-paper px-3 text-sm text-ink"
          />
        </label>
      </div>
      <label className="mt-2 block text-xs text-muted">
        Parameters (JSON, millimetres)
        <textarea
          value={parameters}
          onChange={(e) => setParameters(e.target.value)}
          rows={3}
          className="mt-1 w-full rounded-lg border border-line bg-paper p-2 font-mono text-xs text-ink"
        />
      </label>
      <label className="mt-2 block text-xs text-muted">
        Rationale
        <input
          value={rationale}
          onChange={(e) => setRationale(e.target.value)}
          className="mt-1 h-10 w-full rounded-full border border-line bg-paper px-3 text-sm text-ink"
        />
      </label>
      {error && <p className="mt-2 text-sm text-failed-text">{error}</p>}
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="flex h-9 items-center gap-1.5 rounded-full bg-ink px-4 text-sm font-semibold text-paper disabled:opacity-40"
        >
          {saving && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
          Save edits
        </button>
        <button
          type="button"
          onClick={onDone}
          className="flex h-9 items-center rounded-full bg-paper px-4 text-sm font-semibold text-ink shadow-[inset_0_0_0_1.5px_var(--aos-ink)]"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
