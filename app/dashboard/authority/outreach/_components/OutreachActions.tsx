// Marketr — O1 outreach: client-side actions (campaigns, domains, activation,
// discovery, qualification, drafting, sending, placement checks).
// Server state refreshes via router.refresh() after each mutation.

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/vault/shadcn/button";
import { Input } from "@/components/vault/shadcn/input";
import { Textarea } from "@/components/vault/shadcn/textarea";
import { Label } from "@/components/vault/shadcn/label";
import { Checkbox } from "@/components/vault/shadcn/checkbox";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/vault/shadcn/select";
import { Loader2 } from "lucide-react";

async function postJson(url: string, body: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

async function patchJson(url: string, body: unknown) {
  const res = await fetch(url, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

function ActionNote({ note }: { note: string | null }) {
  if (!note) return null;
  return <span className="text-xs text-stone-500">{note}</span>;
}

function useAction() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  async function run(label: string, fn: () => Promise<string | void>) {
    setBusy(true);
    setNote(null);
    try {
      const msg = await fn();
      setNote(msg || `${label} done`);
      router.refresh();
    } catch (e) {
      setNote(e instanceof Error ? e.message : `${label} failed`);
    } finally {
      setBusy(false);
    }
  }
  return { busy, note, run };
}

// ---------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------

export function CreateCampaignForm({ domains }: { domains: { id: string; domain: string }[] }) {
  const { busy, note, run } = useAction();
  const [name, setName] = useState("");
  const [depth, setDepth] = useState("1");
  const [sendingDomainId, setSendingDomainId] = useState("");
  const [dailyCap, setDailyCap] = useState("30");
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <Button size="sm" onClick={() => setOpen(true)}>
        New campaign
      </Button>
    );
  }
  return (
    <form
      className="space-y-3 rounded-lg border border-stone-200 bg-white p-4"
      onSubmit={(e) => {
        e.preventDefault();
        void run("Create campaign", async () => {
          const r = await postJson("/api/authority/outreach/campaigns", {
            name,
            depth: Number(depth),
            sendingDomainId: sendingDomainId || undefined,
            dailyCap: Number(dailyCap),
          });
          return `Campaign "${r.campaign.name}" created at depth ${r.campaign.depth}`;
        });
      }}
    >
      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-1.5">
          <Label>Campaign name</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Q4 guest-post push" required />
        </div>
        <div className="space-y-1.5">
          <Label>Ladder depth</Label>
          <Select value={depth} onValueChange={(v) => setDepth(v ?? "1")}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="1">1 — Prospecting only (no sending)</SelectItem>
              <SelectItem value="2">2 — Drafts for human send</SelectItem>
              <SelectItem value="3">3 — Automated pitching (gated)</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label>Sending domain</Label>
          <Select value={sendingDomainId} onValueChange={(v) => setSendingDomainId(v ?? "")}>
            <SelectTrigger><SelectValue placeholder="Choose a domain…" /></SelectTrigger>
            <SelectContent>
              {domains.map((d) => (
                <SelectItem key={d.id} value={d.id}>{d.domain}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-[11px] text-stone-500">Depth 3 requires a secondary domain. Primary domains never cold-send.</p>
        </div>
        <div className="space-y-1.5">
          <Label>Daily cap (1–50)</Label>
          <Input type="number" min={1} max={50} value={dailyCap} onChange={(e) => setDailyCap(e.target.value)} />
        </div>
      </div>
      <div className="flex items-center gap-3">
        <Button size="sm" type="submit" disabled={busy || !name.trim()}>
          {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
          Create campaign
        </Button>
        <Button size="sm" type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
        <ActionNote note={note} />
      </div>
    </form>
  );
}

export function ActivateShallowButton({ campaignId }: { campaignId: string }) {
  const { busy, note, run } = useAction();
  return (
    <div className="flex items-center gap-3">
      <Button
        size="sm"
        disabled={busy}
        onClick={() =>
          run("Activate", async () => {
            await postJson(`/api/authority/outreach/campaigns/${campaignId}/activate`, {});
            return "Campaign activated";
          })
        }
      >
        {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
        Activate
      </Button>
      <ActionNote note={note} />
    </div>
  );
}

/** Depth-3 activation flow: dry-run checklist → request (pending approval) → finalize. */
export function Depth3ActivationPanel({
  campaignId,
  sendingDomainId,
  pendingApproval,
}: {
  campaignId: string;
  sendingDomainId: string | null;
  pendingApproval: { id: string; approvers: string[] } | null;
}) {
  const { busy, note, run } = useAction();
  const [checklist, setChecklist] = useState<{ passed: boolean; failures: { code: string; message: string }[] } | null>(null);

  if (pendingApproval) {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
        <p className="text-xs font-semibold text-amber-900">
          Depth-3 activation pending — {pendingApproval.approvers.length}/2 approvers
        </p>
        <p className="mt-1 text-[11px] text-amber-700">
          Two distinct humans must approve before activation completes. Each approver signs from
          their own session.
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <ApproveApprovalButton approvalId={pendingApproval.id} />
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() =>
              run("Finalize", async () => {
                await postJson(`/api/authority/outreach/campaigns/${campaignId}/activate`, {
                  approvalId: pendingApproval.id,
                });
                return "Depth-3 activated — automated pitching is live within caps";
              })
            }
          >
            {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            Finalize activation
          </Button>
          <ActionNote note={note} />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={() =>
          run("Checklist", async () => {
            const r = await postJson(`/api/authority/outreach/campaigns/${campaignId}/activate`, {
              dryRun: true,
              ...(sendingDomainId ? { sendingDomainId } : {}),
            });
            setChecklist({ passed: r.passed, failures: r.failures });
            return r.passed ? "Checklist passed — ready to request activation" : `${r.failures.length} checklist item(s) failing`;
          })
        }
      >
        {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
        Check readiness
      </Button>
      <Button
        size="sm"
        disabled={busy || !sendingDomainId}
        onClick={() =>
          run("Request activation", async () => {
            const r = await postJson(`/api/authority/outreach/campaigns/${campaignId}/activate`, {});
            return `Approval ${r.approval.id.slice(0, 8)}… created — awaiting two approvers`;
          })
        }
      >
        Request depth-3 activation
      </Button>
      <ActionNote note={note} />
      {checklist && !checklist.passed && (
        <ul className="w-full list-disc space-y-1 pl-5 text-xs text-red-700">
          {checklist.failures.map((f) => (
            <li key={f.code}>{f.message}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ApproveApprovalButton({ approvalId }: { approvalId: string }) {
  const { busy, note, run } = useAction();
  return (
    <span className="inline-flex items-center gap-2">
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={() =>
          run("Approve", async () => {
            const r = await postJson(`/api/authority/approvals/${approvalId}/approve`, {});
            const n = r.approval.approvers.length;
            return r.approval.status === "approved"
              ? `Approved (${n}/2) — approval complete`
              : `Approved (${n}/2) — one more distinct approver needed`;
          })
        }
      >
        {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
        Approve as me
      </Button>
      <ActionNote note={note} />
    </span>
  );
}

// ---------------------------------------------------------------------------
// Sending domains
// ---------------------------------------------------------------------------

export function CreateDomainForm() {
  const { busy, note, run } = useAction();
  const [open, setOpen] = useState(false);
  const [domain, setDomain] = useState("");
  const [isPrimary, setIsPrimary] = useState(false);
  const [spfOk, setSpfOk] = useState(false);
  const [dkimOk, setDkimOk] = useState(false);
  const [dmarcPolicy, setDmarcPolicy] = useState("");
  const [trackingCnameOk, setTrackingCnameOk] = useState(false);
  const [warmupStartedAt, setWarmupStartedAt] = useState("");
  if (!open) {
    return (
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        Register sending domain
      </Button>
    );
  }
  return (
    <form
      className="space-y-3 rounded-lg border border-stone-200 bg-white p-4"
      onSubmit={(e) => {
        e.preventDefault();
        void run("Register domain", async () => {
          const r = await postJson("/api/authority/outreach/domains", {
            domain,
            isPrimary,
            spfOk,
            dkimOk,
            dmarcPolicy: dmarcPolicy || null,
            trackingCnameOk,
            warmupStartedAt: warmupStartedAt ? new Date(warmupStartedAt).toISOString() : null,
          });
          return `Domain ${r.domain.domain} registered (${r.domain.status})`;
        });
      }}
    >
      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-1.5">
          <Label>Domain</Label>
          <Input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="outreach.example.com" required />
        </div>
        <div className="space-y-1.5">
          <Label>DMARC policy</Label>
          <Select value={dmarcPolicy} onValueChange={(v) => setDmarcPolicy(v ?? "")}>
            <SelectTrigger><SelectValue placeholder="None yet" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">p=none</SelectItem>
              <SelectItem value="quarantine">p=quarantine</SelectItem>
              <SelectItem value="reject">p=reject</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label>Warmup started</Label>
          <Input type="date" value={warmupStartedAt} onChange={(e) => setWarmupStartedAt(e.target.value)} />
          <p className="text-[11px] text-stone-500">Depth 3 needs 30+ days of warmup with ramp history.</p>
        </div>
        <div className="space-y-2 pt-1">
          <label className="flex items-center gap-2 text-xs text-stone-700">
            <Checkbox checked={isPrimary} onCheckedChange={(v) => setIsPrimary(v === true)} />
            Primary domain (never cold-sends)
          </label>
          <label className="flex items-center gap-2 text-xs text-stone-700">
            <Checkbox checked={spfOk} onCheckedChange={(v) => setSpfOk(v === true)} />
            SPF verified
          </label>
          <label className="flex items-center gap-2 text-xs text-stone-700">
            <Checkbox checked={dkimOk} onCheckedChange={(v) => setDkimOk(v === true)} />
            DKIM verified
          </label>
          <label className="flex items-center gap-2 text-xs text-stone-700">
            <Checkbox checked={trackingCnameOk} onCheckedChange={(v) => setTrackingCnameOk(v === true)} />
            Custom tracking CNAME set
          </label>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <Button size="sm" type="submit" disabled={busy || !domain.trim()}>
          {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
          Register
        </Button>
        <Button size="sm" type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
        <ActionNote note={note} />
      </div>
    </form>
  );
}

export function UpdateDomainChecks({ domainId }: { domainId: string }) {
  const { busy, note, run } = useAction();
  const [spfOk, setSpfOk] = useState(false);
  const [dkimOk, setDkimOk] = useState(false);
  const [trackingCnameOk, setTrackingCnameOk] = useState(false);
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <Button size="xs" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setOpen(true)}>
        Update DNS checks
      </Button>
    );
  }
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md bg-stone-50 p-2">
      <label className="flex items-center gap-1.5 text-[11px] text-stone-700">
        <Checkbox checked={spfOk} onCheckedChange={(v) => setSpfOk(v === true)} /> SPF
      </label>
      <label className="flex items-center gap-1.5 text-[11px] text-stone-700">
        <Checkbox checked={dkimOk} onCheckedChange={(v) => setDkimOk(v === true)} /> DKIM
      </label>
      <label className="flex items-center gap-1.5 text-[11px] text-stone-700">
        <Checkbox checked={trackingCnameOk} onCheckedChange={(v) => setTrackingCnameOk(v === true)} /> CNAME
      </label>
      <Button
        size="xs"
        className="h-7 text-xs"
        disabled={busy}
        onClick={() =>
          run("Update", async () => {
            await patchJson(`/api/authority/outreach/domains/${domainId}`, { spfOk, dkimOk, trackingCnameOk });
            setOpen(false);
            return "DNS checks updated";
          })
        }
      >
        {busy && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
        Save
      </Button>
      <ActionNote note={note} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Prospects & sequences
// ---------------------------------------------------------------------------

export function DiscoverButton({ campaignId }: { campaignId: string }) {
  const { busy, note, run } = useAction();
  const [query, setQuery] = useState('"write for us" marketing');
  const [niche, setNiche] = useState("");
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input className="h-8 w-56 text-xs" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="SERP query" />
      <Input className="h-8 w-40 text-xs" value={niche} onChange={(e) => setNiche(e.target.value)} placeholder="Client niche" />
      <Button
        size="sm"
        disabled={busy || !query.trim() || !niche.trim()}
        onClick={() =>
          run("Discover", async () => {
            const r = await postJson(`/api/authority/outreach/campaigns/${campaignId}/prospects/discover`, {
              query,
              niche,
            });
            return `${r.count} prospects discovered`;
          })
        }
      >
        {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
        Discover prospects
      </Button>
      <ActionNote note={note} />
    </div>
  );
}

export function QualifyButton({ prospectId }: { prospectId: string }) {
  const { busy, note, run } = useAction();
  return (
    <span className="inline-flex items-center gap-2">
      <Button
        size="xs"
        variant="outline"
        className="h-7 text-xs"
        disabled={busy}
        onClick={() =>
          run("Qualify", async () => {
            await postJson(`/api/authority/outreach/prospects/${prospectId}/qualify`, {});
            return "Prospect qualified";
          })
        }
      >
        {busy && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
        Qualify
      </Button>
      <ActionNote note={note} />
    </span>
  );
}

export function DraftSequenceForm({ campaignId, prospectId, depth }: { campaignId: string; prospectId: string; depth: number }) {
  const { busy, note, run } = useAction();
  const [open, setOpen] = useState(false);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [unsubscribeUrl, setUnsubscribeUrl] = useState("");
  const [physicalAddress, setPhysicalAddress] = useState("");
  if (!open) {
    return (
      <Button size="xs" variant="outline" className="h-7 text-xs" onClick={() => setOpen(true)}>
        Draft pitch
      </Button>
    );
  }
  return (
    <form
      className="mt-2 space-y-2 rounded-lg border border-stone-200 bg-stone-50 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        void run("Draft", async () => {
          await postJson(`/api/authority/outreach/sequences/${prospectId}/draft`, {
            campaignId,
            subject,
            body,
            unsubscribeUrl,
            physicalAddress,
          });
          setOpen(false);
          return depth === 3
            ? "Draft created (initial + 2 follow-ups at 48h+ cadence)"
            : "Draft created — expires after 14 days if unsent";
        });
      }}
    >
      <div className="space-y-1.5">
        <Label className="text-xs">Subject</Label>
        <Input className="h-8 text-xs" value={subject} onChange={(e) => setSubject(e.target.value)} required />
      </div>
      <div className="space-y-1.5">
        <Label className="text-xs">Pitch body (first-line + angle personalization)</Label>
        <Textarea className="text-xs" rows={4} value={body} onChange={(e) => setBody(e.target.value)} required />
      </div>
      <div className="grid gap-2 md:grid-cols-2">
        <div className="space-y-1.5">
          <Label className="text-xs">One-click unsubscribe URL (CAN-SPAM)</Label>
          <Input className="h-8 text-xs" type="url" value={unsubscribeUrl} onChange={(e) => setUnsubscribeUrl(e.target.value)} required />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Physical mailing address (CAN-SPAM)</Label>
          <Input className="h-8 text-xs" value={physicalAddress} onChange={(e) => setPhysicalAddress(e.target.value)} required />
        </div>
      </div>
      <div className="flex items-center gap-3">
        <Button size="sm" type="submit" disabled={busy}>
          {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
          Create draft
        </Button>
        <Button size="sm" type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
        <ActionNote note={note} />
      </div>
    </form>
  );
}

export function SendSequenceButton({ sequenceId, depth }: { sequenceId: string; depth: number }) {
  const { busy, note, run } = useAction();
  return (
    <span className="inline-flex items-center gap-2">
      <Button
        size="xs"
        className="h-7 text-xs"
        disabled={busy}
        onClick={() =>
          run("Send", async () => {
            const r = await postJson(`/api/authority/outreach/sequences/${sequenceId}/send`, {});
            return depth === 2
              ? `Sent — human-click approval ${String(r.approvalId).slice(0, 8)}… bound to the exact payload`
              : `Sent via campaign approval (message ${r.messageId})`;
          })
        }
      >
        {busy && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
        {depth === 2 ? "Send (human click)" : "Dispatch next step"}
      </Button>
      <ActionNote note={note} />
    </span>
  );
}

export function VerifyPlacementButton({ sequenceId }: { sequenceId: string }) {
  const { busy, note, run } = useAction();
  return (
    <span className="inline-flex items-center gap-2">
      <Button
        size="xs"
        variant="outline"
        className="h-7 text-xs"
        disabled={busy}
        onClick={() =>
          run("Verify", async () => {
            const r = await postJson(`/api/authority/outreach/sequences/${sequenceId}/verify-placement`, {});
            return `Placement check: ${r.placement.outcome}${r.placement.alert ? " — ALERT" : ""}`;
          })
        }
      >
        {busy && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
        Verify placement
      </Button>
      <ActionNote note={note} />
    </span>
  );
}
