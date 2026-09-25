// Marketr — O2 digital PR: client-side actions (ingest, draft, approve,
// mark-sent, relationship events, placements). Server state refreshes via
// router.refresh() after each mutation.

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/vault/shadcn/button";
import { Input } from "@/components/vault/shadcn/input";
import { Textarea } from "@/components/vault/shadcn/textarea";
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

export function IngestButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  return (
    <div className="flex items-center gap-3">
      <Button
        size="sm"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setNote(null);
          try {
            const r = await postJson("/api/authority/pr/opportunities/ingest", {});
            setNote(`${r.created?.length ?? 0} new · ${r.deduped ?? 0} deduped · ${r.rejected?.length ?? 0} rejected`);
            router.refresh();
          } catch (e) {
            setNote(e instanceof Error ? e.message : "Ingest failed");
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
        Ingest queries
      </Button>
      {note && <span className="text-xs text-stone-500">{note}</span>}
    </div>
  );
}

export function CreateDraftForm({ opportunityId }: { opportunityId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [expertise, setExpertise] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        Build draft
      </Button>
    );
  }
  return (
    <form
      className="mt-3 space-y-2 rounded-lg border border-stone-200 bg-stone-50 p-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await postJson(`/api/authority/pr/opportunities/${opportunityId}/draft`, {
            expertiseSummary: expertise,
            subject,
            bodyText: body || undefined,
          });
          router.refresh();
        } catch (err) {
          setError(err instanceof Error ? err.message : "Draft failed");
        } finally {
          setBusy(false);
        }
      }}
    >
      <Input
        placeholder="Your expertise summary (what makes you credible on this query)"
        value={expertise}
        onChange={(e) => setExpertise(e.target.value)}
        required
      />
      <Input
        placeholder="Email subject (≤49 chars — enforced)"
        value={subject}
        maxLength={49}
        onChange={(e) => setSubject(e.target.value)}
        required
      />
      <p className="text-[11px] text-stone-500">{subject.length}/49 chars</p>
      <Textarea
        placeholder="Draft body (optional — runs the de-AI pass)"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={3}
      />
      {error && <p className="text-xs text-red-600">{error}</p>}
      <div className="flex gap-2">
        <Button size="sm" type="submit" disabled={busy}>
          {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
          Create workspace
        </Button>
        <Button size="sm" variant="ghost" type="button" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

export function ApproveButton({ draftId, disabled, reason }: { draftId: string; disabled?: boolean; reason?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="inline-flex items-center gap-2">
      <Button
        size="sm"
        disabled={busy || disabled}
        title={reason}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await postJson(`/api/authority/pr/drafts/${draftId}/approve`, {});
            router.refresh();
          } catch (e) {
            setError(e instanceof Error ? e.message : "Approval failed");
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
        Approve draft
      </Button>
      {disabled && reason && <span className="text-[11px] text-amber-700">{reason}</span>}
      {error && <span className="text-[11px] text-red-600">{error}</span>}
    </span>
  );
}

export function MarkSentButton({ draftId, journalist, outlet }: { draftId: string; journalist: string; outlet: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="inline-flex items-center gap-2">
      <Button
        size="sm"
        variant="secondary"
        disabled={busy}
        title="Record that YOU sent this pitch from your own email client. Marketr never sends."
        onClick={async () => {
          if (!window.confirm(`Record a human-sent pitch to ${journalist} (${outlet})? Marketr does not send — this records that YOU sent it from your own inbox, bound to a pr_send approval.`)) return;
          setBusy(true);
          setError(null);
          try {
            await postJson(`/api/authority/pr/drafts/${draftId}/mark-sent`, {});
            router.refresh();
          } catch (e) {
            setError(e instanceof Error ? e.message : "Mark-sent failed");
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
        Record sent
      </Button>
      {error && <span className="text-[11px] text-red-600">{error}</span>}
    </span>
  );
}

export function RelationshipNoteForm({ journalist, outlet }: { journalist: string; outlet: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState("");
  const [declined, setDeclined] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        Log event
      </Button>
    );
  }
  return (
    <form
      className="mt-2 space-y-2"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await postJson("/api/authority/pr/relationships", {
            journalist,
            outlet,
            kind: declined ? "declined" : "note",
            detail,
            ...(declined ? { declinationReason: detail } : {}),
          });
          setOpen(false);
          setDetail("");
          setDeclined(false);
          router.refresh();
        } catch (err) {
          setError(err instanceof Error ? err.message : "Log failed");
        } finally {
          setBusy(false);
        }
      }}
    >
      <Textarea value={detail} onChange={(e) => setDetail(e.target.value)} placeholder={declined ? "Declination reason (starts 90-day re-engagement window)" : "Note"} rows={2} required />
      <label className="flex items-center gap-1.5 text-xs text-stone-600">
        <input type="checkbox" checked={declined} onChange={(e) => setDeclined(e.target.checked)} />
        Declined — start 90-day re-engagement window
      </label>
      {error && <p className="text-xs text-red-600">{error}</p>}
      <div className="flex gap-2">
        <Button size="sm" type="submit" disabled={busy}>
          {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
          Save
        </Button>
        <Button size="sm" variant="ghost" type="button" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

export function PlacementForm() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [outlet, setOutlet] = useState("");
  const [expert, setExpert] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <Button size="sm" onClick={() => setOpen(true)}>
        Record placement
      </Button>
    );
  }
  return (
    <form
      className="space-y-2 rounded-lg border border-stone-200 bg-stone-50 p-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await postJson("/api/authority/pr/placements", {
            url,
            outlet,
            signals: { quotedAsExpert: expert },
          });
          setOpen(false);
          setUrl("");
          setOutlet("");
          router.refresh();
        } catch (err) {
          setError(err instanceof Error ? err.message : "Placement failed");
        } finally {
          setBusy(false);
        }
      }}
    >
      <Input placeholder="Coverage URL" value={url} onChange={(e) => setUrl(e.target.value)} required />
      <Input placeholder="Outlet" value={outlet} onChange={(e) => setOutlet(e.target.value)} required />
      <label className="flex items-center gap-1.5 text-xs text-stone-600">
        <input type="checkbox" checked={expert} onChange={(e) => setExpert(e.target.checked)} />
        Quoted as expert (citable by LLM answers — feeds AEO)
      </label>
      {error && <p className="text-xs text-red-600">{error}</p>}
      <div className="flex gap-2">
        <Button size="sm" type="submit" disabled={busy}>
          {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
          Record
        </Button>
        <Button size="sm" variant="ghost" type="button" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
