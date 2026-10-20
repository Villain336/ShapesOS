// ShapesOS CRM — lead action bar (lead slide-over): email, text, call,
// enroll in nurture, create invoice, delete. Wired to the existing APIs only
// (see lead-actions.ts for the rules and request shapes).
"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Mail, MessageSquareText, Phone, Send, Receipt, Trash2, Loader2 } from "lucide-react";
import type { CrmLead } from "./types";
import { NewInvoiceModal } from "./NewInvoiceModal";
import { btnDenySm, btnGhost, btnGhostSm, btnPrimary, inputCls, labelCls, selectCls } from "./ui";
import {
  buildSendRequest,
  enrollableSequences,
  interpretEnroll,
  interpretSend,
  leadActionAvailability,
  SMS_MAX,
  telHref,
  validateDraft,
  type LeadChannel,
} from "./lead-actions";
import { confirmAction, toast, toastError } from "@/lib/ui/feedback";

type Panel = null | "email" | "sms" | "enroll";

interface SequenceOption {
  id: string;
  name: string;
  status: string;
}

const textareaCls =
  "min-h-28 w-full rounded-md border-[1.5px] border-control bg-paper px-3 py-2 text-[0.8125rem] text-ink placeholder:text-subtle focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)]";

export function LeadActions({
  lead,
  onChanged,
  onDeleted,
  onCallStarted,
  registerEscape,
}: {
  lead: CrmLead;
  onChanged: () => void;
  onDeleted: () => void;
  /** Called after the dialer opens so the panel can prefill a "call" log. */
  onCallStarted: () => void;
  /** Lets the slide-over close an open sub-panel on Escape before itself. */
  registerEscape: (fn: (() => boolean) | null) => void;
}) {
  const router = useRouter();
  const avail = leadActionAvailability(lead);
  const [panel, setPanel] = useState<Panel>(null);
  const [invoiceOpen, setInvoiceOpen] = useState(false);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [sequences, setSequences] = useState<SequenceOption[] | null>(null);
  const [sequenceId, setSequenceId] = useState("");
  const [enrolling, setEnrolling] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const firstFieldRef = useRef<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null>(null);

  // Escape closes the open sub-panel / invoice modal first.
  useEffect(() => {
    registerEscape(() => {
      if (invoiceOpen) {
        setInvoiceOpen(false);
        return true;
      }
      if (panel) {
        setPanel(null);
        return true;
      }
      return false;
    });
    return () => registerEscape(null);
  }, [panel, invoiceOpen, registerEscape]);

  useEffect(() => {
    if (panel) requestAnimationFrame(() => firstFieldRef.current?.focus());
  }, [panel]);

  // Load sequences the first time the enroll panel opens.
  useEffect(() => {
    if (panel !== "enroll" || sequences !== null) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/nurture/sequences");
        const d = (await r.json().catch(() => ({}))) as { sequences?: SequenceOption[]; error?: string };
        if (!r.ok) throw new Error(d.error ?? "Couldn't load sequences.");
        if (cancelled) return;
        const list = enrollableSequences(d.sequences ?? []);
        setSequences(list);
        setSequenceId(list.find((s) => s.status === "active")?.id ?? list[0]?.id ?? "");
      } catch (e) {
        if (!cancelled) {
          setSequences([]);
          setFormError(e instanceof Error ? e.message : "Couldn't load sequences.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [panel, sequences]);

  function open(p: Panel) {
    setFormError(null);
    setPanel((cur) => (cur === p ? null : p));
  }

  async function send(channel: LeadChannel) {
    const draft = { channel, subject, body };
    const problem = validateDraft(draft);
    if (problem) {
      setFormError(problem);
      return;
    }
    setSending(true);
    setFormError(null);
    try {
      const r = await fetch("/api/messaging/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildSendRequest(lead.id, draft)),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "Couldn't queue the message.");
      const outcome = interpretSend(lead.name, channel, d);
      if (outcome.queued) {
        toast({
          status: "needs",
          title: outcome.title,
          description: outcome.description,
          action: { label: "Review", onClick: () => router.push("/dashboard/nurture?tab=approvals") },
        });
        setSubject("");
        setBody("");
        setPanel(null);
        onChanged();
      } else {
        toast({ status: "failed", title: outcome.title, description: outcome.description });
      }
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "Couldn't queue the message.");
    } finally {
      setSending(false);
    }
  }

  async function enroll() {
    const seq = sequences?.find((s) => s.id === sequenceId);
    if (!seq) return;
    setEnrolling(true);
    setFormError(null);
    try {
      const r = await fetch(`/api/nurture/sequences/${encodeURIComponent(seq.id)}/enroll`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leadIds: [lead.id] }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "Enrollment failed.");
      const outcome = interpretEnroll(lead.id, d);
      if (!outcome.ok) throw new Error(outcome.message);
      setPanel(null);
      toast({
        title: `${outcome.message} in ${seq.name}`,
        description: seq.status === "active" ? undefined : `The sequence is ${seq.status}; steps start when it's active.`,
        action: outcome.offerUndo
          ? {
              label: "Undo",
              doneLabel: "Undone",
              onClick: async () => {
                const u = await fetch(`/api/nurture/sequences/${encodeURIComponent(seq.id)}/unenroll`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ leadIds: [lead.id] }),
                });
                if (!u.ok) {
                  toastError("Couldn't undo the enrollment", "Unenroll from Nurture → Enrollments.");
                  throw new Error("unenroll failed");
                }
                onChanged();
              },
            }
          : undefined,
      });
      onChanged();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "Enrollment failed.");
    } finally {
      setEnrolling(false);
    }
  }

  async function remove() {
    const ok = await confirmAction({
      title: `Delete ${lead.name}?`,
      description: "The lead and its whole timeline are deleted. This can't be undone.",
      confirmLabel: "Delete lead",
      destructive: true,
    });
    if (!ok) return;
    setDeleting(true);
    try {
      const r = await fetch(`/api/crm/leads/${encodeURIComponent(lead.id)}`, { method: "DELETE" });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.error ?? "Couldn't delete the lead.");
      }
      toast({ title: `Deleted ${lead.name}` });
      onDeleted();
    } catch (e) {
      toastError("Couldn't delete the lead", e instanceof Error ? e.message : undefined);
      setDeleting(false);
    }
  }

  const tel = lead.phone ? telHref(lead.phone) : null;

  return (
    <div className="border-b border-line px-5 py-3">
      <div className="flex flex-wrap items-center gap-1.5" role="toolbar" aria-label="Lead actions">
        <button
          type="button"
          className={btnGhostSm}
          onClick={() => open("email")}
          disabled={!avail.email.enabled}
          title={avail.email.reason}
          aria-expanded={panel === "email"}
        >
          <Mail size={13} aria-hidden /> Email
        </button>
        <button
          type="button"
          className={btnGhostSm}
          onClick={() => open("sms")}
          disabled={!avail.sms.enabled}
          title={avail.sms.reason}
          aria-expanded={panel === "sms"}
        >
          <MessageSquareText size={13} aria-hidden /> Text
        </button>
        {avail.call.enabled && tel ? (
          <a href={tel} className={btnGhostSm} onClick={() => onCallStarted()}>
            <Phone size={13} aria-hidden /> Call
          </a>
        ) : (
          <button type="button" className={btnGhostSm} disabled title={avail.call.reason}>
            <Phone size={13} aria-hidden /> Call
          </button>
        )}
        <button
          type="button"
          className={btnGhostSm}
          onClick={() => open("enroll")}
          aria-expanded={panel === "enroll"}
        >
          <Send size={13} aria-hidden /> Enroll in nurture
        </button>
        <button type="button" className={btnGhostSm} onClick={() => setInvoiceOpen(true)}>
          <Receipt size={13} aria-hidden /> Create invoice
        </button>
        <button type="button" className={`${btnDenySm} ml-auto`} onClick={remove} disabled={deleting}>
          {deleting ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <Trash2 size={13} aria-hidden />}
          {deleting ? "Deleting" : "Delete"}
        </button>
      </div>

      {panel === "email" || panel === "sms" ? (
        <form
          className="mt-3 flex flex-col gap-2.5 rounded-md border border-line bg-canvas/60 p-3"
          aria-label={panel === "email" ? `Email ${lead.name}` : `Text ${lead.name}`}
          onSubmit={(e) => {
            e.preventDefault();
            void send(panel);
          }}
        >
          <p className="text-[0.75rem] text-muted">
            To {panel === "email" ? lead.email : lead.phone}. Queued for approval; nothing sends until it&apos;s approved.
          </p>
          {panel === "email" ? (
            <div>
              <label htmlFor="lead-email-subject" className={labelCls}>
                Subject
              </label>
              <input
                id="lead-email-subject"
                ref={(el) => {
                  firstFieldRef.current = el;
                }}
                className={`${inputCls} w-full`}
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                maxLength={200}
              />
            </div>
          ) : null}
          <div>
            <label htmlFor="lead-message-body" className={labelCls}>
              Message
            </label>
            <textarea
              id="lead-message-body"
              ref={(el) => {
                if (panel === "sms") firstFieldRef.current = el;
              }}
              className={textareaCls}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              aria-describedby={formError ? "lead-action-error" : undefined}
              aria-invalid={formError ? true : undefined}
            />
            {panel === "sms" ? (
              <p className="mt-1 text-right text-[0.75rem] text-muted tabular-nums">
                {body.trim().length} / {SMS_MAX}
              </p>
            ) : null}
          </div>
          {formError ? <ActionError message={formError} /> : null}
          <div className="flex justify-end gap-2">
            <button type="button" className={btnGhost} onClick={() => setPanel(null)}>
              Cancel
            </button>
            <button type="submit" className={btnPrimary} disabled={sending}>
              {sending ? <Loader2 size={13} className="animate-spin" aria-hidden /> : null}
              {sending ? "Queueing" : panel === "email" ? "Queue email" : "Queue text"}
            </button>
          </div>
        </form>
      ) : null}

      {panel === "enroll" ? (
        <form
          className="mt-3 flex flex-col gap-2.5 rounded-md border border-line bg-canvas/60 p-3"
          aria-label={`Enroll ${lead.name} in a nurture sequence`}
          onSubmit={(e) => {
            e.preventDefault();
            void enroll();
          }}
        >
          {sequences === null ? (
            <p className="flex items-center gap-2 text-[0.8125rem] text-muted">
              <Loader2 size={13} className="animate-spin" aria-hidden /> Loading sequences
            </p>
          ) : sequences.length === 0 ? (
            <p className="text-[0.8125rem] text-muted">
              No sequences yet.{" "}
              <a href="/dashboard/nurture" className="font-semibold text-ink underline underline-offset-2">
                Create one in Nurture
              </a>
              .
            </p>
          ) : (
            <div>
              <label htmlFor="lead-enroll-sequence" className={labelCls}>
                Sequence
              </label>
              <select
                id="lead-enroll-sequence"
                ref={(el) => {
                  firstFieldRef.current = el;
                }}
                className={`${selectCls} w-full`}
                value={sequenceId}
                onChange={(e) => setSequenceId(e.target.value)}
              >
                {sequences.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                    {s.status === "active" ? "" : ` (${s.status})`}
                  </option>
                ))}
              </select>
            </div>
          )}
          {formError ? <ActionError message={formError} /> : null}
          <div className="flex justify-end gap-2">
            <button type="button" className={btnGhost} onClick={() => setPanel(null)}>
              Cancel
            </button>
            <button type="submit" className={btnPrimary} disabled={enrolling || !sequenceId}>
              {enrolling ? <Loader2 size={13} className="animate-spin" aria-hidden /> : null}
              {enrolling ? "Enrolling" : "Enroll"}
            </button>
          </div>
        </form>
      ) : null}

      {invoiceOpen ? (
        <NewInvoiceModal
          initialCustomer={{ id: lead.id, name: lead.name, company: lead.company ?? null }}
          onClose={() => setInvoiceOpen(false)}
          onCreated={() => {
            toast({ title: "Invoice draft created", description: "Find it under Invoicing. Sending needs approval." });
            onChanged();
          }}
        />
      ) : null}
    </div>
  );
}

function ActionError({ message }: { message: string }) {
  return (
    <p id="lead-action-error" role="alert" className="flex items-center gap-1.5 text-[0.8125rem] text-failed-text">
      <span className="aos-shape aos-shape--failed" aria-hidden style={{ ["--aos-shape-size" as string]: "8px" }} />
      {message}
    </p>
  );
}
