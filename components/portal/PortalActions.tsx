"use client";

// ShapesOS — Phase 10 (portal): the client portal's interactive bits. Every
// call is a same-origin JSON POST to /api/portal/* (the browser adds the
// Origin header the CSRF check needs; the portal cookie rides along because
// it is scoped to /api/portal). After a change the page re-renders from the
// server (router.refresh), so the server stays the source of truth.

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Check, CreditCard, Loader2, LogOut, Send, X } from "lucide-react";
import { FieldMessage } from "@/components/aos";
import { btnPrimarySm, btnQuietSm, btnSecondarySm, inputCls, textareaCls } from "./ui";

async function portalPost(path: string, body: Record<string, unknown>): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  try {
    const res = await fetch(`/api/portal/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.status === 401) {
      window.location.href = "/portal/login";
      return { ok: false, data: { error: "Your session ended. Sign in again." } };
    }
    if (res.status === 429 && !data.error) data.error = "Too many requests. Wait a minute, then try again.";
    return { ok: res.ok, data };
  } catch {
    return { ok: false, data: { error: "Couldn't reach the server. Check your connection and try again." } };
  }
}

const errText = (d: Record<string, unknown>, fallback: string) => (typeof d.error === "string" ? d.error : fallback);

export function SignOutButton() {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className={btnQuietSm}
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await portalPost("logout", {});
        window.location.href = "/portal/login";
      }}
    >
      {busy ? <Loader2 size={15} className="aos-spin" aria-hidden /> : <LogOut size={15} aria-hidden />}
      {busy ? "Signing out" : "Sign out"}
    </button>
  );
}

export function PayInvoiceButton({ invoiceId }: { invoiceId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <button
        type="button"
        className={btnPrimarySm}
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          const r = await portalPost(`invoices/${encodeURIComponent(invoiceId)}/pay`, {});
          if (r.ok && typeof r.data.url === "string") {
            window.location.href = r.data.url;
            return;
          }
          setBusy(false);
          setError(errText(r.data, "Couldn't start the payment. Try again."));
        }}
      >
        {busy ? <Loader2 size={15} className="aos-spin" aria-hidden /> : <CreditCard size={15} aria-hidden />}
        {busy ? "Opening checkout" : "Pay now"}
      </button>
      {error && <FieldMessage id={`pay-${invoiceId}`} error={error} />}
    </span>
  );
}

export function QuoteDecisionButtons({ quoteId }: { quoteId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<"accept" | "decline" | null>(null);
  const [confirmDecline, setConfirmDecline] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function decide(decision: "accept" | "decline") {
    setBusy(decision);
    setError(null);
    const r = await portalPost(`quotes/${encodeURIComponent(quoteId)}/decision`, { decision });
    setBusy(null);
    if (!r.ok) {
      setError(errText(r.data, "Couldn't record your decision. Try again."));
      return;
    }
    setConfirmDecline(false);
    router.refresh();
  }
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <span className="inline-flex gap-2">
        {confirmDecline ? (
          <>
            <button type="button" className={btnSecondarySm} disabled={busy !== null} onClick={() => decide("decline")}>
              {busy === "decline" ? <Loader2 size={15} className="aos-spin" aria-hidden /> : <X size={15} aria-hidden />}
              {busy === "decline" ? "Declining" : "Yes, decline"}
            </button>
            <button type="button" className={btnQuietSm} disabled={busy !== null} onClick={() => setConfirmDecline(false)}>
              Keep it open
            </button>
          </>
        ) : (
          <>
            <button type="button" className={btnPrimarySm} disabled={busy !== null} onClick={() => decide("accept")}>
              {busy === "accept" ? <Loader2 size={15} className="aos-spin" aria-hidden /> : <Check size={15} aria-hidden />}
              {busy === "accept" ? "Accepting" : "Accept quote"}
            </button>
            <button type="button" className={btnSecondarySm} disabled={busy !== null} onClick={() => setConfirmDecline(true)}>
              Decline
            </button>
          </>
        )}
      </span>
      {error && <FieldMessage id={`quote-${quoteId}`} error={error} />}
    </span>
  );
}

export function NewTicketForm() {
  const router = useRouter();
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await portalPost("tickets", { subject, body });
    setBusy(false);
    if (!r.ok) {
      setError(errText(r.data, "Couldn't open the ticket. Try again."));
      return;
    }
    if (typeof r.data.id === "string") {
      router.push(`/portal/tickets/${r.data.id}`);
      return;
    }
    router.refresh();
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <label className="flex flex-col gap-1">
        <span className="text-sm font-semibold text-ink">Subject</span>
        <input className={inputCls} value={subject} maxLength={300} onChange={(e) => setSubject(e.target.value)} placeholder="What do you need help with?" />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-sm font-semibold text-ink">Message</span>
        <textarea className={textareaCls} value={body} maxLength={20000} onChange={(e) => setBody(e.target.value)} />
      </label>
      <FieldMessage id="new-ticket-error" error={error} />
      <div>
        <button type="submit" className={btnPrimarySm} disabled={busy || !subject.trim() || !body.trim()}>
          {busy ? <Loader2 size={15} className="aos-spin" aria-hidden /> : <Send size={15} aria-hidden />}
          {busy ? "Opening ticket" : "Open ticket"}
        </button>
      </div>
    </form>
  );
}

export function TicketReplyForm({ ticketId }: { ticketId: string }) {
  const router = useRouter();
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await portalPost(`tickets/${encodeURIComponent(ticketId)}/replies`, { body });
    setBusy(false);
    if (!r.ok) {
      setError(errText(r.data, "Couldn't send your reply. Try again."));
      return;
    }
    setBody("");
    router.refresh();
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <label className="flex flex-col gap-1">
        <span className="text-sm font-semibold text-ink">Your reply</span>
        <textarea className={textareaCls} value={body} maxLength={20000} onChange={(e) => setBody(e.target.value)} />
      </label>
      <FieldMessage id="reply-error" error={error} />
      <div>
        <button type="submit" className={btnPrimarySm} disabled={busy || !body.trim()}>
          {busy ? <Loader2 size={15} className="aos-spin" aria-hidden /> : <Send size={15} aria-hidden />}
          {busy ? "Sending" : "Send reply"}
        </button>
      </div>
    </form>
  );
}
