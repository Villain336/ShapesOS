// Marketr — Phase 8 G2: client-side campaign actions.
// Plain fetch calls against /api/substrate/campaigns/*, then router.refresh().

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/vault/shadcn/button";
import { Input } from "@/components/vault/shadcn/input";
import { Label } from "@/components/vault/shadcn/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/vault/shadcn/select";
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
    <form onSubmit={submit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="g2-name">Name</Label>
        <Input id="g2-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="2026 Q4 Holiday Launch" />
      </div>
      <div className="space-y-2">
        <Label>Objective</Label>
        <Select value={objective} onValueChange={(v) => setObjective(v ?? "lead_gen")}>
          <SelectTrigger>
            <SelectValue placeholder="Objective" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="lead_gen">Lead generation</SelectItem>
            <SelectItem value="sale">Sale</SelectItem>
            <SelectItem value="awareness">Awareness</SelectItem>
            <SelectItem value="retention">Retention</SelectItem>
            <SelectItem value="launch">Launch</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <Button type="submit" disabled={busy || !name.trim()}>
        {busy ? "Creating…" : parentId ? "Create sub-campaign" : "Create campaign"}
      </Button>
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
      <div className="space-y-2">
        <Label>Fragment</Label>
        <Select value={value} onValueChange={(v) => setValue(v ?? "")}>
          <SelectTrigger>
            <SelectValue placeholder="Choose a fragment…" />
          </SelectTrigger>
          <SelectContent>
            {fragments.map((f) => (
              <SelectItem key={`${f.linkedType}::${f.linkedId}`} value={`${f.linkedType}::${f.linkedId}`}>
                [{LINKED_TYPE_LABELS[f.linkedType]}] {f.displayName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-2">
          <Label>Role</Label>
          <Select value={role} onValueChange={(v) => setRole((v as "primary" | "supporting") ?? "primary")}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="primary">Primary</SelectItem>
              <SelectItem value="supporting">Supporting</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label>Stage (optional)</Label>
          <Select value={stageKey} onValueChange={(v) => setStageKey(v ?? "")}>
            <SelectTrigger>
              <SelectValue placeholder="Auto (by fragment type)" />
            </SelectTrigger>
            <SelectContent>
              {CAMPAIGN_STAGES.map((k) => (
                <SelectItem key={k} value={k as string}>
                  {CAMPAIGN_STAGE_LABELS[k as CampaignStageKey]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <Button type="submit" disabled={busy || !value}>
        {busy ? "Attaching…" : "Attach to campaign"}
      </Button>
    </form>
  );
}

export function UnlinkButton({ campaignId, linkId, label }: { campaignId: string; linkId: string; label: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function unlink() {
    if (!window.confirm(`Unlink "${label}"? The fragment itself is untouched — only the link row is removed.`)) return;
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
    <span className="inline-flex items-center gap-2">
      <Button variant="outline" size="sm" onClick={unlink} disabled={busy}>
        {busy ? "Unlinking…" : "Unlink"}
      </Button>
      {error ? <span className="text-xs text-destructive">{error}</span> : null}
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
      <Button size="sm" onClick={() => resolve("approved")} disabled={busy !== null}>
        {busy === "approved" ? "Approving…" : "Approve"}
      </Button>
      <Button variant="outline" size="sm" onClick={() => resolve("rejected")} disabled={busy !== null}>
        {busy === "rejected" ? "Rejecting…" : "Reject"}
      </Button>
      {error ? <span className="text-xs text-destructive">{error}</span> : null}
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
      <Button onClick={scan} disabled={busy}>
        {busy ? "Scanning fragments…" : "Run backfill scan"}
      </Button>
      {result ? <span className="text-sm text-muted-foreground">{result}</span> : null}
      {error ? <span className="text-sm text-destructive">{error}</span> : null}
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

  async function change(next: string | null) {
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
      <Select value={value} onValueChange={change} disabled={busy}>
        <SelectTrigger className="w-32" aria-label="Campaign status">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="draft">Draft</SelectItem>
          <SelectItem value="active">Active</SelectItem>
          <SelectItem value="paused">Paused</SelectItem>
          <SelectItem value="complete">Complete</SelectItem>
          <SelectItem value="archived">Archived</SelectItem>
        </SelectContent>
      </Select>
      {error ? <span className="text-xs text-destructive">{error}</span> : null}
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

  async function change(next: string | null) {
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
      <Select value={value} onValueChange={change} disabled={busy}>
        <SelectTrigger className="w-36" aria-label={`${stageKey} status`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="not_started">Not started</SelectItem>
          <SelectItem value="in_progress">In progress</SelectItem>
          <SelectItem value="complete">Complete</SelectItem>
          <SelectItem value="blocked">Blocked</SelectItem>
          <SelectItem value="skipped">Skipped</SelectItem>
        </SelectContent>
      </Select>
      {error ? <span className="text-xs text-destructive">{error}</span> : null}
    </span>
  );
}
