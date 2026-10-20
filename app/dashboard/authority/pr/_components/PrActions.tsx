// Marketr — O2 digital PR: client-side actions (ingest, draft, approve,
// mark-sent, relationship events, placements). Server state refreshes via
// router.refresh() after each mutation.

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Input } from "@/components/vault/shadcn/input";
import { Textarea } from "@/components/vault/shadcn/textarea";
import { Loader2 } from "lucide-react";
import { confirmAction } from "@/lib/ui/feedback";

// Agentic OS pressables: running = agent-run verbs, done = approve.
const btnP =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-ink px-4 text-sm font-semibold text-white aos-press hover:bg-ink-hover disabled:opacity-40";
const btnS =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-paper px-4 text-sm font-semibold text-ink shadow-outline aos-press hover:bg-hover-paper disabled:opacity-40";
const btnD =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-done px-4 text-sm font-semibold text-white aos-press hover:bg-done/90 disabled:opacity-40";
const btnR =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-running px-4 text-sm font-semibold text-white aos-press hover:bg-running/90 disabled:opacity-40";

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
      <button
        className={btnR}
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
        {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        Ingest queries
      </button>
      {note && <span className="text-xs text-muted">{note}</span>}
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
      <button className={btnS} onClick={() => setOpen(true)}>
        Build draft
      </button>
    );
  }
  return (
    <form
      className="mt-3 space-y-2 rounded-lg border border-line bg-paper p-3"
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
      <p className="text-[0.6875rem] text-muted">{subject.length}/49 chars</p>
      <Textarea
        placeholder="Draft body (optional — runs the de-AI pass)"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={3}
      />
      {error && <p className="text-xs text-failed-text">{error}</p>}
      <div className="flex gap-2">
        <button className={btnP} type="submit" disabled={busy}>
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Create workspace
        </button>
        <button className={btnS} type="button" onClick={() => setOpen(false)}>
          Cancel
        </button>
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
      <button
        className={btnD}
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
        {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        Approve draft
      </button>
      {disabled && reason && <span className="text-[0.6875rem] text-ink">{reason}</span>}
      {error && <span className="text-[0.6875rem] text-failed-text">{error}</span>}
    </span>
  );
}

export function MarkSentButton({ draftId, journalist, outlet }: { draftId: string; journalist: string; outlet: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="inline-flex items-center gap-2">
      <button
        className={btnS}
        disabled={busy}
        title="Record that YOU sent this pitch from your own email client. ShapesOS never sends."
        onClick={async () => {
          if (!await confirmAction(`Record a human-sent pitch to ${journalist} (${outlet})? ShapesOS does not send — this records that YOU sent it from your own inbox, bound to a pr_send approval.`)) return;
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
        {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        Record sent
      </button>
      {error && <span className="text-[0.6875rem] text-failed-text">{error}</span>}
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
      <button className={btnS} onClick={() => setOpen(true)}>
        Log event
      </button>
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
      <label className="flex items-center gap-1.5 text-xs text-muted">
        <input type="checkbox" checked={declined} onChange={(e) => setDeclined(e.target.checked)} />
        Declined — start 90-day re-engagement window
      </label>
      {error && <p className="text-xs text-failed-text">{error}</p>}
      <div className="flex gap-2">
        <button className={btnP} type="submit" disabled={busy}>
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Save
        </button>
        <button className={btnS} type="button" onClick={() => setOpen(false)}>
          Cancel
        </button>
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
      <button className={btnP} onClick={() => setOpen(true)}>
        Record placement
      </button>
    );
  }
  return (
    <form
      className="space-y-2 rounded-lg border border-line bg-paper p-3"
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
      <label className="flex items-center gap-1.5 text-xs text-muted">
        <input type="checkbox" checked={expert} onChange={(e) => setExpert(e.target.checked)} />
        Quoted as expert (citable by LLM answers — feeds AEO)
      </label>
      {error && <p className="text-xs text-failed-text">{error}</p>}
      <div className="flex gap-2">
        <button className={btnP} type="submit" disabled={busy}>
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Record
        </button>
        <button className={btnS} type="button" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}
