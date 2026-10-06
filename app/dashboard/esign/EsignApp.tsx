// Marketr — Wave 2 E-sign module: envelope list, composer, detail, send gate.
// Agentic OS design system (docs/design/DESIGN.md): canvas app bg, white
// paper cards, black pill primary actions, Lucide icons, aos tokens only.
// E-sign invariant: the agent prepares, NEVER sends — the send path stays
// gated on explicit human review.

"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Archive,
  ArrowLeft,
  BarChart3,
  BellRing,
  Bot,
  CheckCircle2,
  Clock3,
  Copy,
  FileDown,
  FileText,
  FileUp,
  Info,
  LayoutTemplate,
  Link2,
  Loader2,
  Lock,
  Pencil,
  PencilLine,
  Plus,
  RefreshCw,
  Scale,
  Send,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import { confirmAction, toastError } from "@/lib/ui/feedback";
import { activateOnKey } from "@/lib/ui/keyboard";

// ── Agentic OS atoms ─────────────────────────────────────────────────────────

const inputCls =
  "h-control-sm rounded-md border-[1.5px] border-control bg-paper px-3 text-sm text-ink placeholder:text-subtle focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)] focus-visible:outline-none";

const btnPrimary =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-ink px-4 text-sm font-semibold text-white aos-press hover:bg-ink-hover disabled:opacity-40";

const btnGhost =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-paper px-4 text-sm font-semibold text-ink shadow-outline aos-press hover:bg-hover-paper disabled:opacity-40";

const btnDeny =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-paper px-4 text-sm font-semibold text-failed-text aos-press shadow-[inset_0_0_0_1.5px_var(--aos-failed)] disabled:opacity-40";

const btnApprove =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-done px-4 text-sm font-semibold text-white aos-press disabled:opacity-40";

const btnReview =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-needs px-4 text-sm font-semibold text-ink aos-press disabled:opacity-40";

// All workflow states render neutral: envelope, signer, field and role
// states are document/workflow states, not agent states, so they never take
// a status color. The tone prop stays for call-site compatibility.
function Chip({ children, tone = "slate" }: { children: React.ReactNode; tone?: "slate" | "violet" | "green" | "amber" | "red" | "blue" }) {
  void tone;
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-paper px-2 py-0.5 text-xs font-semibold text-muted shadow-control">
      {children}
    </span>
  );
}

function statusLabel(status: string): string {
  return status === "partially-signed" ? "Partially signed" : status[0]!.toUpperCase() + status.slice(1);
}

function hashShort(hash: string | null | undefined): string {
  return hash ? `${hash.slice(0, 12)}…` : "—";
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

// ── Types ────────────────────────────────────────────────────────────────────

interface ApiSigner {
  id: string;
  name: string;
  email: string;
  role: string;
  orderIndex: number;
  status: string;
  signedAt: string | null;
}

interface ApiEnvelope {
  id: string;
  title: string;
  status: string;
  signingOrder: string;
  vendorRef: string | null;
  documentName: string | null;
  expiresAt: string | null;
  sealedPdfHash: string | null;
  sealedPdfFetchedAt: string | null;
  voidReason: string | null;
  createdAt: string;
  updatedAt: string;
  signers: ApiSigner[];
}

interface ApiEnvelopeDetail extends ApiEnvelope {
  vendor: string;
  vendorStatus: string | null;
  sourcePdfHash: string | null;
  fields: Array<{
    id: string;
    signerId: string | null;
    fieldType: string;
    page: number | null;
    x: number | null;
    y: number | null;
    width: number | null;
    height: number | null;
    required: boolean;
  }>;
  events: Array<{
    id: string;
    event: string;
    actor: string | null;
    hash: string;
    previousHash: string | null;
    createdAt: string;
  }>;
  contractType: string | null;
  contractRef: string | null;
  vaultEntry: {
    id: string;
    storedAt: string;
    retentionUntil: string | null;
    legalHold: boolean;
    legalHoldReason: string | null;
    purgedAt: string | null;
  } | null;
}

interface SendPreview {
  title: string;
  documentName: string | null;
  documentSize: number | null;
  sourcePdfHash: string | null;
  signingOrder: string;
  expiresAt: string | null;
  signers: Array<{ name: string; email: string; role: string; orderIndex: number }>;
  fieldCount: number;
  vendorConfigured: boolean;
}

function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-night/30 p-4">
      <div className={`flex max-h-[90vh] w-full ${wide ? "max-w-3xl" : "max-w-2xl"} flex-col overflow-hidden rounded-lg bg-paper shadow-overlay`}>
        <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <h2 className="aos-subheading">{title}</h2>
          <button onClick={onClose} className="rounded-full p-1.5 text-muted hover:bg-hover-paper hover:text-ink" aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
      </div>
    </div>
  );
}

function ErrorNote({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <div className="mb-4 flex items-start gap-2 rounded-md border border-failed bg-failed-tint px-3 py-2 text-sm text-failed-text">
      <span className="mt-1 h-3 w-3 shrink-0 bg-failed" aria-hidden="true" />
      <span>{error}</span>
    </div>
  );
}

// ── Envelope composer ────────────────────────────────────────────────────────

interface ComposerSigner {
  name: string;
  email: string;
  role: "signer" | "approver" | "cc";
}

interface ComposerField {
  signerEmail: string;
  fieldType: "signature" | "initials" | "date" | "text" | "checkbox";
  page: string;
  x: string;
  y: string;
}

function ComposerModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [title, setTitle] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [signers, setSigners] = useState<ComposerSigner[]>([{ name: "", email: "", role: "signer" }]);
  const [signingOrder, setSigningOrder] = useState<"sequential" | "parallel">("sequential");
  const [expiresAt, setExpiresAt] = useState("");
  const [fields, setFields] = useState<ComposerField[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const updateSigner = (i: number, patch: Partial<ComposerSigner>) =>
    setSigners((ss) => ss.map((s, j) => (j === i ? { ...s, ...patch } : s)));

  const updateField = (i: number, patch: Partial<ComposerField>) =>
    setFields((fs) => fs.map((f, j) => (j === i ? { ...f, ...patch } : f)));

  async function submit() {
    setError(null);
    if (!title.trim()) return setError("Give the envelope a title.");
    if (!file) return setError("Attach the PDF to be signed.");
    if (signers.some((s) => !s.name.trim() || !s.email.trim())) {
      return setError("Every signer needs a name and an email.");
    }
    setSaving(true);
    try {
      const form = new FormData();
      form.set("title", title.trim());
      form.set("file", file);
      form.set("signingOrder", signingOrder);
      if (expiresAt) form.set("expiresAt", new Date(expiresAt).toISOString());
      form.set(
        "signers",
        JSON.stringify(
          signers.map((s, i) => ({ name: s.name.trim(), email: s.email.trim(), role: s.role, orderIndex: i })),
        ),
      );
      form.set(
        "fields",
        JSON.stringify(
          fields.map((f) => ({
            signerEmail: f.signerEmail,
            fieldType: f.fieldType,
            page: f.page ? Number(f.page) : undefined,
            x: f.x ? Number(f.x) : undefined,
            y: f.y ? Number(f.y) : undefined,
          })),
        ),
      );
      const res = await fetch("/api/esign/envelopes", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not create the envelope draft.");
      onCreated(data.envelope.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create the envelope draft.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title="New envelope" onClose={onClose} wide>
      <ErrorNote error={error} />

      <label className="mb-1 block text-xs font-semibold text-muted">Title</label>
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. MSA — Acme Corp" className={`${inputCls} mb-4 w-full`} maxLength={200} />

      <label className="mb-1 block text-xs font-semibold text-muted">Document (PDF)</label>
      <label className="mb-4 flex cursor-pointer items-center gap-2 rounded-md border border-dashed border-control bg-canvas px-3 py-3 text-sm text-muted hover:border-ink">
        <FileUp size={16} className="shrink-0 text-subtle" />
        <span className="truncate">{file ? file.name : "Choose a PDF — this is the exact file reviewers approve"}</span>
        <input
          type="file"
          accept="application/pdf"
          className="hidden"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
      </label>

      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs font-semibold text-muted">Signers</span>
        <button
          type="button"
          onClick={() => setSigners((ss) => [...ss, { name: "", email: "", role: "signer" }])}
          className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold text-ink hover:bg-hover-paper aos-press"
        >
          <Plus size={13} /> Add signer
        </button>
      </div>
      <div className="mb-4 space-y-2">
        {signers.map((s, i) => (
          <div key={i} className="grid grid-cols-[1fr_1fr_110px_28px] items-center gap-2">
            <input value={s.name} onChange={(e) => updateSigner(i, { name: e.target.value })} placeholder="Full name" className={inputCls} />
            <input value={s.email} onChange={(e) => updateSigner(i, { email: e.target.value })} placeholder="email@company.com" className={inputCls} />
            <select value={s.role} onChange={(e) => updateSigner(i, { role: e.target.value as ComposerSigner["role"] })} className={inputCls}>
              <option value="signer">Signer</option>
              <option value="approver">Approver</option>
              <option value="cc">CC</option>
            </select>
            <button
              type="button"
              disabled={signers.length <= 1}
              onClick={() => setSigners((ss) => ss.filter((_, j) => j !== i))}
              className="rounded-full p-1.5 text-subtle hover:bg-failed-tint hover:text-failed-text disabled:opacity-30"
              aria-label="Remove signer"
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </div>

      <div className="mb-4 grid grid-cols-2 gap-3">
        <div>
          <label className="mb-1 block text-xs font-semibold text-muted">Signing order</label>
          <select value={signingOrder} onChange={(e) => setSigningOrder(e.target.value as "sequential" | "parallel")} className={`${inputCls} w-full`}>
            <option value="sequential">Sequential — in listed order</option>
            <option value="parallel">Parallel — all at once</option>
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-semibold text-muted">Expires (optional)</label>
          <input type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} className={`${inputCls} w-full`} />
        </div>
      </div>

      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs font-semibold text-muted">Signature fields (optional)</span>
        <button
          type="button"
          disabled={signers.every((s) => !s.email.trim())}
          onClick={() =>
            setFields((fs) => [
              ...fs,
              { signerEmail: signers.find((s) => s.email.trim())?.email.trim() ?? "", fieldType: "signature", page: "1", x: "", y: "" },
            ])
          }
          className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold text-ink hover:bg-hover-paper aos-press disabled:opacity-40"
        >
          <Plus size={13} /> Add field
        </button>
      </div>
      {fields.length > 0 && (
        <div className="mb-4 space-y-2">
          {fields.map((f, i) => (
            <div key={i} className="grid grid-cols-[1fr_110px_56px_64px_64px_28px] items-center gap-2">
              <select value={f.signerEmail} onChange={(e) => updateField(i, { signerEmail: e.target.value })} className={inputCls}>
                {signers.filter((s) => s.email.trim()).map((s) => (
                  <option key={s.email} value={s.email.trim()}>{s.name.trim() || s.email.trim()}</option>
                ))}
              </select>
              <select value={f.fieldType} onChange={(e) => updateField(i, { fieldType: e.target.value as ComposerField["fieldType"] })} className={inputCls}>
                <option value="signature">Signature</option>
                <option value="initials">Initials</option>
                <option value="date">Date</option>
                <option value="text">Text</option>
                <option value="checkbox">Checkbox</option>
              </select>
              <input value={f.page} onChange={(e) => updateField(i, { page: e.target.value })} placeholder="Pg" className={inputCls} inputMode="numeric" />
              <input value={f.x} onChange={(e) => updateField(i, { x: e.target.value })} placeholder="x" className={inputCls} inputMode="decimal" />
              <input value={f.y} onChange={(e) => updateField(i, { y: e.target.value })} placeholder="y" className={inputCls} inputMode="decimal" />
              <button
                type="button"
                onClick={() => setFields((fs) => fs.filter((_, j) => j !== i))}
                className="rounded-full p-1.5 text-subtle hover:bg-failed-tint hover:text-failed-text"
                aria-label="Remove field"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="rounded-md border border-line bg-canvas px-3 py-2.5 text-xs text-muted">
        The draft is created locally and never sent automatically. Sending requires a
        separate review step where you confirm the exact document and signer list.
      </div>

      <div className="mt-4 flex justify-end gap-2">
        <button type="button" onClick={onClose} className={btnGhost}>Cancel</button>
        <button type="button" onClick={submit} disabled={saving} className={btnPrimary}>
          {saving ? <Loader2 size={14} className="animate-spin" /> : <PencilLine size={14} />}
          Create draft
        </button>
      </div>
    </Modal>
  );
}

// ── Send gate: the heavy approval dialog ─────────────────────────────────────

function SendGateDialog({ envelopeId, onClose, onSent }: { envelopeId: string; onClose: () => void; onSent: () => void }) {
  const [preview, setPreview] = useState<SendPreview | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/esign/envelopes/${envelopeId}/send-preview`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Could not load the send preview.");
        setPreview(data.preview);
        setToken(data.token);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not load the send preview.");
      }
    })();
  }, [envelopeId]);

  async function send() {
    if (!token || !reviewed) return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch(`/api/esign/envelopes/${envelopeId}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Send failed.");
      onSent();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Send failed.");
    } finally {
      setSending(false);
    }
  }

  return (
    <Modal title="Review before sending" onClose={onClose} wide>
      <ErrorNote error={error} />
      {!preview ? (
        <div className="flex items-center justify-center py-10 text-sm text-muted">
          <Loader2 size={16} className="mr-2 animate-spin" /> Loading the exact send summary…
        </div>
      ) : (
        <>
          {!preview.vendorConfigured && (
            <div className="mb-4 flex items-start gap-2 rounded-md border border-line bg-canvas px-3 py-2 text-sm text-muted">
              <Info size={14} className="mt-0.5 shrink-0" />
              <span>
                The signing vendor is not connected (missing DOCUMENSO credentials). Sending will
                fail until it is configured — the draft stays safe either way.
              </span>
            </div>
          )}
          <div className="mb-4 rounded-md border border-line">
            <div className="border-b border-line px-3 py-2 text-xs font-semibold text-muted">
              What will be sent
            </div>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-2 px-3 py-3 text-sm">
              <div><dt className="text-xs text-muted">Title</dt><dd className="font-medium text-ink">{preview.title}</dd></div>
              <div><dt className="text-xs text-muted">Document</dt><dd className="text-ink">{preview.documentName ?? "—"}</dd></div>
              <div><dt className="text-xs text-muted">Document hash</dt><dd className="font-mono text-xs text-ink">{hashShort(preview.sourcePdfHash)}</dd></div>
              <div><dt className="text-xs text-muted">Signing order</dt><dd className="text-ink">{preview.signingOrder}</dd></div>
              <div><dt className="text-xs text-muted">Expires</dt><dd className="text-ink">{fmtDate(preview.expiresAt)}</dd></div>
              <div><dt className="text-xs text-muted">Fields</dt><dd className="text-ink">{preview.fieldCount}</dd></div>
            </dl>
            <div className="border-t border-line px-3 py-2">
              <div className="mb-1 text-xs font-semibold text-muted">Signers</div>
              <ul className="space-y-1 text-sm">
                {preview.signers.map((s) => (
                  <li key={s.email} className="flex items-center justify-between gap-2">
                    <span className="text-ink">{s.name} <span className="text-muted">· {s.email}</span></span>
                    <Chip>{s.role}</Chip>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <label className="flex cursor-pointer items-start gap-2.5 rounded-md border border-line bg-canvas px-3 py-2.5">
            <input
              type="checkbox"
              checked={reviewed}
              onChange={(e) => setReviewed(e.target.checked)}
              className="mt-0.5 h-4 w-4 accent-ink"
            />
            <span className="text-sm text-ink">
              I have reviewed the document, the signer list, and the signing order above. This
              confirmation is bound to this exact version — if anything changes, I review again.
            </span>
          </label>

          <div className="mt-3 flex items-center gap-2 text-xs text-muted">
            <ShieldCheck size={14} className="shrink-0 text-subtle" />
            <span>Approval token (echoed to the server with your send):</span>
            <code className="truncate rounded bg-canvas px-1.5 py-0.5 font-mono text-xs text-muted">{token ? `${token.slice(0, 24)}…` : "—"}</code>
          </div>

          <div className="mt-4 flex justify-end gap-2">
            <button type="button" onClick={onClose} className={btnGhost}>Cancel</button>
            <button type="button" onClick={send} disabled={!reviewed || sending} className={btnApprove}>
              {sending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
              Send envelope
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

function VoidDialog({ envelopeId, onClose, onVoided }: { envelopeId: string; onClose: () => void; onVoided: () => void }) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (!reason.trim()) return setError("A reason is required — it becomes part of the audit trail.");
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/esign/envelopes/${envelopeId}/void`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: reason.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Void failed.");
      onVoided();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Void failed.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title="Void envelope" onClose={onClose}>
      <ErrorNote error={error} />
      <p className="mb-3 text-sm text-muted">
        The envelope is cancelled and signers can no longer sign. The sealed document,
        if any, is kept as evidence — voiding never deletes it.
      </p>
      <label className="mb-1 block text-xs font-semibold text-muted">Reason</label>
      <textarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Why is this envelope being voided?"
        rows={3}
        className={`${inputCls} mb-4 w-full`}
        maxLength={500}
      />
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} className={btnGhost}>Cancel</button>
        <button type="button" onClick={submit} disabled={saving} className={btnDeny}>
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
          Void envelope
        </button>
      </div>
    </Modal>
  );
}

// ── Envelope detail ──────────────────────────────────────────────────────────

function DetailView({ id, onBack, onChanged }: { id: string; onBack: () => void; onChanged: () => void }) {
  const [detail, setDetail] = useState<ApiEnvelopeDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSend, setShowSend] = useState(false);
  const [showVoid, setShowVoid] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/esign/envelopes/${id}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not load the envelope.");
      setDetail(data.envelope);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the envelope.");
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function refresh() {
    setRefreshing(true);
    try {
      await fetch(`/api/esign/envelopes/${id}/refresh`, { method: "POST" });
      await load();
      onChanged();
    } finally {
      setRefreshing(false);
    }
  }

  if (error) {
    return (
      <div className="rounded-lg bg-paper p-6 shadow-hairline">
        <ErrorNote error={error} />
        <button onClick={onBack} className={btnGhost}><ArrowLeft size={14} /> Back</button>
      </div>
    );
  }
  if (!detail) {
    return (
      <div className="flex items-center justify-center rounded-lg bg-paper py-16 text-sm text-muted shadow-hairline">
        <Loader2 size={16} className="mr-2 animate-spin" /> Loading envelope…
      </div>
    );
  }

  const canSend = detail.status === "draft" || detail.status === "error";
  const canVoid = ["draft", "error", "sent", "partially-signed", "expired"].includes(detail.status);
  const canRefresh = ["sent", "partially-signed", "completed"].includes(detail.status);
  const canClone = ["expired", "declined"].includes(detail.status);
  const [cloning, setCloning] = useState(false);
  const [cloneError, setCloneError] = useState<string | null>(null);

  const clone = async () => {
    setCloning(true);
    setCloneError(null);
    try {
      const res = await fetch(`/api/esign/envelopes/${id}/clone`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Clone failed.");
      onChanged();
      onBack();
    } catch (e) {
      setCloneError(e instanceof Error ? e.message : "Clone failed.");
    } finally {
      setCloning(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <button onClick={onBack} className={btnGhost}><ArrowLeft size={14} /> Back</button>
          <h2 className="aos-subheading">{detail.title}</h2>
          <Chip>{statusLabel(detail.status)}</Chip>
        </div>
        <div className="flex items-center gap-2">
          {canRefresh && (
            <button onClick={refresh} disabled={refreshing} className={btnGhost}>
              <RefreshCw size={14} className={refreshing ? "animate-spin" : ""} /> Refresh status
            </button>
          )}
          {canVoid && (
            <button onClick={() => setShowVoid(true)} className={btnGhost}>
              <Trash2 size={14} /> Void
            </button>
          )}
          {canClone && (
            <button onClick={clone} disabled={cloning} className={btnGhost} title="Re-send as a fresh draft — same document, signers and fields.">
              <Copy size={14} className={cloning ? "animate-spin" : ""} /> Clone as draft
            </button>
          )}
          {canSend && (
            <button onClick={() => setShowSend(true)} className={btnReview}>
              <span className="aos-shape aos-shape--needs" style={{ color: "var(--aos-ink)" }} role="img" aria-label="Needs review" />
              Review & send
            </button>
          )}
        </div>
      </div>
      {cloneError && <ErrorNote error={cloneError} />}

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-lg bg-paper shadow-hairline">
          <div className="border-b border-line px-4 py-2.5 text-xs font-semibold text-ink">Document</div>
          <dl className="space-y-2 px-4 py-3 text-sm">
            <div className="flex justify-between gap-4"><dt className="text-muted">File</dt><dd className="text-right text-ink">{detail.documentName ?? "—"}</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-muted">Source hash</dt><dd className="font-mono text-xs text-ink">{hashShort(detail.sourcePdfHash)}</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-muted">Sealed PDF hash</dt><dd className="font-mono text-xs text-ink">{hashShort(detail.sealedPdfHash)}</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-muted">Sealed fetched</dt><dd className="text-ink">{fmtDate(detail.sealedPdfFetchedAt)}</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-muted">Signing order</dt><dd className="text-ink">{detail.signingOrder}</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-muted">Expires</dt><dd className="text-ink">{fmtDate(detail.expiresAt)}</dd></div>
            {detail.vendorRef && (
              <div className="flex justify-between gap-4"><dt className="text-muted">Vendor ref</dt><dd className="font-mono text-xs text-ink">{detail.vendorRef}</dd></div>
            )}
            {detail.voidReason && (
              <div className="flex justify-between gap-4"><dt className="text-muted">Void reason</dt><dd className="text-right text-ink">{detail.voidReason}</dd></div>
            )}
          </dl>
        </div>

        <div className="rounded-lg bg-paper shadow-hairline">
          <div className="border-b border-line px-4 py-2.5 text-xs font-semibold text-ink">Signers</div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-line text-xs font-semibold text-muted">
                  <th className="px-4 py-2 font-medium">Name</th>
                  <th className="px-4 py-2 font-medium">Email</th>
                  <th className="px-4 py-2 font-medium">Role</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium">Signed</th>
                </tr>
              </thead>
              <tbody>
                {detail.signers.map((s) => (
                  <tr key={s.id} className="border-b border-line last:border-0 hover:bg-hover-paper">
                    <td className="px-4 py-2 font-medium text-ink">{s.name}</td>
                    <td className="px-4 py-2 text-muted">{s.email}</td>
                    <td className="px-4 py-2"><Chip>{s.role}</Chip></td>
                    <td className="px-4 py-2"><Chip>{s.status}</Chip></td>
                    <td className="px-4 py-2 text-muted">{fmtDate(s.signedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <EvidenceCard detail={detail} onChanged={() => { void load(); onChanged(); }} />

      {detail.fields.length > 0 && (
        <div className="rounded-lg bg-paper shadow-hairline">
          <div className="border-b border-line px-4 py-2.5 text-xs font-semibold text-ink">Fields</div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-line text-xs font-semibold text-muted">
                  <th className="px-4 py-2 font-medium">Signer</th>
                  <th className="px-4 py-2 font-medium">Type</th>
                  <th className="px-4 py-2 font-medium">Page</th>
                  <th className="px-4 py-2 font-medium">Position</th>
                  <th className="px-4 py-2 font-medium">Required</th>
                </tr>
              </thead>
              <tbody>
                {detail.fields.map((f) => {
                  const signer = detail.signers.find((s) => s.id === f.signerId);
                  return (
                    <tr key={f.id} className="border-b border-line last:border-0 hover:bg-hover-paper">
                      <td className="px-4 py-2 text-ink">{signer?.name ?? "—"}</td>
                      <td className="px-4 py-2"><Chip>{f.fieldType}</Chip></td>
                      <td className="px-4 py-2 text-muted">{f.page ?? "—"}</td>
                      <td className="px-4 py-2 text-muted">{f.x != null && f.y != null ? `(${f.x}, ${f.y})` : "—"}</td>
                      <td className="px-4 py-2 text-muted">{f.required ? "Yes" : "No"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="rounded-lg bg-paper shadow-hairline">
        <div className="border-b border-line px-4 py-2.5 text-xs font-semibold text-ink">
          Audit trail <span className="ml-1 font-normal text-muted">— hash-chained, tamper-evident</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-line text-xs font-semibold text-muted">
                <th className="px-4 py-2 font-medium">Event</th>
                <th className="px-4 py-2 font-medium">Actor</th>
                <th className="px-4 py-2 font-medium">Hash</th>
                <th className="px-4 py-2 font-medium">Time</th>
              </tr>
            </thead>
            <tbody>
              {detail.events.map((e) => (
                <tr key={e.id} className="border-b border-line last:border-0 hover:bg-hover-paper">
                  <td className="px-4 py-2 font-medium text-ink">{e.event.replace(/_/g, " ")}</td>
                  <td className="px-4 py-2 text-muted">{e.actor ?? "vendor"}</td>
                  <td className="px-4 py-2 font-mono text-xs text-muted" title={e.previousHash ? `prev: ${e.previousHash}` : ""}>
                    {hashShort(e.hash)}
                  </td>
                  <td className="px-4 py-2 text-muted">{fmtDate(e.createdAt)}</td>
                </tr>
              ))}
              {detail.events.length === 0 && (
                <tr><td colSpan={4} className="px-4 py-6 text-center text-muted">No events yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {detail.status === "completed" && (
        <div className="flex items-start gap-2 rounded-md border border-line bg-canvas px-3 py-2.5 text-sm text-muted">
          <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-ink" />
          <span>
            Completed and sealed by the vendor. The sealed PDF and this audit trail are the
            evidence pack — use Refresh status to re-fetch the sealed document if needed.
          </span>
        </div>
      )}

      {showSend && (
        <SendGateDialog
          envelopeId={id}
          onClose={() => setShowSend(false)}
          onSent={() => { setShowSend(false); void load(); onChanged(); }}
        />
      )}
      {showVoid && (
        <VoidDialog
          envelopeId={id}
          onClose={() => setShowVoid(false)}
          onVoided={() => { setShowVoid(false); void load(); onChanged(); }}
        />
      )}
    </div>
  );
}

// ── Evidence & legal vault card ────────────────────────────────────────────

function EvidenceCard({ detail, onChanged }: { detail: ApiEnvelopeDetail; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [linkType, setLinkType] = useState("");
  const [linkRef, setLinkRef] = useState("");
  const [retentionDays, setRetentionDays] = useState("2555");
  const [holdReason, setHoldReason] = useState("");
  const [showHold, setShowHold] = useState(false);

  async function post(url: string, body?: unknown, method = "POST") {
    setBusy(true);
    try {
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Action failed.");
      onChanged();
    } catch (e) {
      toastError(e instanceof Error ? e.message : "Action failed.");
    } finally {
      setBusy(false);
    }
  }

  async function downloadPack() {
    setBusy(true);
    try {
      const res = await fetch(`/api/esign/envelopes/${detail.id}/evidence`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not build the evidence pack.");
      const blob = new Blob([JSON.stringify(data.evidence, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${detail.title.replace(/[^a-z0-9-_]+/gi, "-").slice(0, 60)}-evidence-pack.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      toastError(e instanceof Error ? e.message : "Could not build the evidence pack.");
    } finally {
      setBusy(false);
    }
  }

  const canVault = detail.status === "completed" && detail.sealedPdfHash && !detail.vaultEntry;
  const canFlip = detail.status === "completed" && detail.sealedPdfHash && detail.contractRef;

  return (
    <div className="rounded-lg bg-paper shadow-hairline">
      <div className="border-b border-line px-4 py-2.5 text-xs font-semibold text-ink">
        Evidence & legal vault <span className="ml-1 font-normal text-muted">— one package for counsel</span>
      </div>
      <div className="grid gap-4 px-4 py-3 md:grid-cols-3">
        {/* Contract binding */}
        <div>
          <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-ink">
            <Scale size={13} /> Contract
          </div>
          {detail.contractRef ? (
            <div className="space-y-1 text-sm">
              <div className="flex justify-between gap-4"><span className="text-muted">Type</span><span className="text-ink">{detail.contractType ?? "—"}</span></div>
              <div className="flex justify-between gap-4"><span className="text-muted">Ref</span><span className="font-mono text-xs text-ink">{detail.contractRef}</span></div>
              {canFlip && (
                <button disabled={busy} onClick={() => post(`/api/esign/envelopes/${detail.id}/flip-executed`)} className={btnGhost}>
                  <CheckCircle2 size={14} /> Mark contract executed
                </button>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              <input value={linkType} onChange={(e) => setLinkType(e.target.value)} placeholder="Contract type (e.g. msa)" className={inputCls} />
              <input value={linkRef} onChange={(e) => setLinkRef(e.target.value)} placeholder="Contract reference" className={inputCls} />
              <button
                disabled={busy || !linkType.trim() || !linkRef.trim()}
                onClick={() => post(`/api/esign/envelopes/${detail.id}/link-contract`, { contractType: linkType, contractRef: linkRef })}
                className={btnGhost}
              >
                <Link2 size={14} /> Link contract
              </button>
            </div>
          )}
        </div>

        {/* Vault */}
        <div>
          <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-ink">
            <Archive size={13} /> Legal vault
          </div>
          {detail.vaultEntry ? (
            <div className="space-y-1 text-sm">
              <div className="flex justify-between gap-4"><span className="text-muted">Stored</span><span className="text-ink">{fmtDate(detail.vaultEntry.storedAt)}</span></div>
              <div className="flex justify-between gap-4"><span className="text-muted">Retention until</span><span className="text-ink">{fmtDate(detail.vaultEntry.retentionUntil) ?? "indefinite"}</span></div>
              {detail.vaultEntry.legalHold ? (
                <div className="space-y-1">
                  <div><Chip><Lock size={11} className="mr-1" />Legal hold</Chip></div>
                  {detail.vaultEntry.legalHoldReason && <div className="text-muted">{detail.vaultEntry.legalHoldReason}</div>}
                  <button disabled={busy} onClick={() => post(`/api/esign/vault/${detail.vaultEntry!.id}/legal-hold`, undefined, "DELETE")} className={btnGhost}>
                    Release hold
                  </button>
                </div>
              ) : showHold ? (
                <div className="space-y-2">
                  <input value={holdReason} onChange={(e) => setHoldReason(e.target.value)} placeholder="Hold reason (required)" className={inputCls} />
                  <div className="flex gap-2">
                    <button disabled={busy || !holdReason.trim()} onClick={() => { void post(`/api/esign/vault/${detail.vaultEntry!.id}/legal-hold`, { reason: holdReason }).then(() => setShowHold(false)); }} className={btnPrimary}>
                      Set hold
                    </button>
                    <button onClick={() => setShowHold(false)} className={btnGhost}>Cancel</button>
                  </div>
                </div>
              ) : (
                <button disabled={busy} onClick={() => setShowHold(true)} className={btnGhost}>
                  <Lock size={14} /> Set legal hold
                </button>
              )}
            </div>
          ) : canVault ? (
            <div className="space-y-2">
              <p className="text-sm text-muted">Anchors the sealed PDF hash + audit chain head.</p>
              <input value={retentionDays} onChange={(e) => setRetentionDays(e.target.value)} inputMode="numeric" placeholder="Retention days (default 2555)" className={inputCls} />
              <button
                disabled={busy}
                onClick={() => post(`/api/esign/envelopes/${detail.id}/vault`, retentionDays.trim() ? { retentionDays: Number(retentionDays) } : {})}
                className={btnGhost}
              >
                <Archive size={14} /> Store in vault
              </button>
            </div>
          ) : (
            <p className="text-sm text-muted">Available once the envelope is completed and sealed.</p>
          )}
        </div>

        {/* Evidence pack */}
        <div>
          <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-ink">
            <ShieldCheck size={13} /> Evidence pack
          </div>
          <p className="mb-2 text-sm text-muted">Sealed PDF hash + hash-chained audit log + signer identity evidence.</p>
          <div className="flex flex-wrap gap-2">
            <button disabled={busy} onClick={downloadPack} className={btnGhost}>
              <FileDown size={14} /> Download pack
            </button>
            {detail.sealedPdfHash && (
              <a href={`/api/esign/envelopes/${detail.id}/evidence/pdf`} className={btnGhost}>
                <FileText size={14} /> Sealed PDF
              </a>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Signing automation (agent workflows) ─────────────────────────────────────

type PendingNudgeRow = {
  signerId: string;
  name: string;
  email: string;
  role: string;
  envelopeId: string;
  envelopeTitle: string;
  daysWaiting: number;
  lastNudgeAt: string | null;
};

type SigningAnalytics = {
  sent: number;
  completed: number;
  declined: number;
  completionRate: number | null;
  avgHoursToSign: number | null;
  medianHoursToSign: number | null;
  perTemplate: Array<{
    templateId: string;
    templateName: string;
    sent: number;
    completed: number;
    completionRate: number | null;
    avgHoursToSign: number | null;
  }>;
};

function fmtHours(h: number | null): string {
  if (h === null) return "—";
  return h < 1 ? `${Math.round(h * 60)}m` : `${h.toFixed(1)}h`;
}

function AutomationCard() {
  const [analytics, setAnalytics] = useState<SigningAnalytics | null>(null);
  const [pending, setPending] = useState<PendingNudgeRow[]>([]);
  const [drafted, setDrafted] = useState<Record<string, { nudgeEventId: string; message: string }>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [a, p] = await Promise.all([
        fetch("/api/esign/agent/analytics").then((r) => r.json()),
        fetch("/api/esign/agent/pending-nudges").then((r) => r.json()),
      ]);
      if (a.analytics) setAnalytics(a.analytics);
      setPending(p.pending ?? []);
    } catch {
      /* non-blocking */
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const draft = async (n: PendingNudgeRow) => {
    setBusy(n.signerId);
    setErr(null);
    try {
      const res = await fetch("/api/esign/agent/nudges?action=draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ envelopeId: n.envelopeId, signerId: n.signerId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Draft failed.");
      setDrafted((d) => ({ ...d, [n.signerId]: { nudgeEventId: data.nudgeEventId, message: data.message } }));
      setNote(`Nudge drafted for ${n.name} — approve to release. Nothing has been sent.`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Draft failed.");
    } finally {
      setBusy(null);
    }
  };

  const approve = async (n: PendingNudgeRow) => {
    const d = drafted[n.signerId];
    if (!d) return;
    setBusy(n.signerId);
    setErr(null);
    try {
      const res = await fetch("/api/esign/agent/nudges?action=approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nudgeEventId: d.nudgeEventId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Approval failed.");
      setDrafted((dd) => {
        const c = { ...dd };
        delete c[n.signerId];
        return c;
      });
      setNote(`Nudge released for ${n.name}. Deliver it through your signing provider, then record the delivery.`);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Approval failed.");
    } finally {
      setBusy(null);
    }
  };

  const sweep = async () => {
    setBusy("sweep");
    setErr(null);
    try {
      const res = await fetch("/api/esign/agent/sweep-expirations", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Sweep failed.");
      setNote(`Sweep complete — expired ${data.expired} stale envelope${data.expired === 1 ? "" : "s"}.`);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Sweep failed.");
    } finally {
      setBusy(null);
    }
  };

  const stats = analytics
    ? [
        { label: "Completion rate", value: analytics.completionRate === null ? "—" : `${Math.round(analytics.completionRate * 100)}%` },
        { label: "Avg time to sign", value: fmtHours(analytics.avgHoursToSign) },
        { label: "Median time to sign", value: fmtHours(analytics.medianHoursToSign) },
        { label: "Sent / completed", value: `${analytics.sent} / ${analytics.completed}` },
      ]
    : [];

  return (
    <div className="rounded-lg bg-paper shadow-hairline">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2.5">
        <div className="flex items-center gap-2 text-xs font-semibold text-ink">
          <Bot size={14} className="text-ink" />
          Signing automation
          <span className="font-normal text-muted">— agent prepares, a human releases</span>
        </div>
        <button onClick={sweep} disabled={busy === "sweep"} className={btnGhost}>
          <Clock3 size={14} className={busy === "sweep" ? "animate-spin" : ""} /> Run expiry sweep
        </button>
      </div>
      {note && <div className="border-b border-line px-4 py-2 text-xs text-muted">{note}</div>}
      {err && <div className="border-b border-failed bg-failed-tint px-4 py-2 text-xs text-failed-text">{err}</div>}
      <div className="grid gap-px bg-line sm:grid-cols-4">
        {stats.map((s) => (
          <div key={s.label} className="bg-paper px-4 py-3">
            <div className="text-xs font-semibold text-muted">{s.label}</div>
            <div className="text-lg font-bold text-ink">{s.value}</div>
          </div>
        ))}
      </div>
      {analytics && analytics.perTemplate.length > 0 && (
        <div className="border-t border-line px-4 py-2.5">
          <div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-muted">
            <BarChart3 size={12} /> By template
          </div>
          <table className="w-full text-left text-xs">
            <tbody>
              {analytics.perTemplate.slice(0, 5).map((t) => (
                <tr key={t.templateId} className="border-t border-line first:border-0">
                  <td className="py-1 pr-2 text-ink">{t.templateName}</td>
                  <td className="py-1 text-right text-muted">{t.completed}/{t.sent} signed</td>
                  <td className="py-1 text-right text-muted">{t.completionRate === null ? "—" : `${Math.round(t.completionRate * 100)}%`}</td>
                  <td className="py-1 text-right text-muted">{fmtHours(t.avgHoursToSign)} avg</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="border-t border-line px-4 py-2.5">
        <div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-muted">
          <BellRing size={12} /> Pending nudges {pending.length > 0 && <span className="text-subtle">({pending.length})</span>}
        </div>
        {pending.length === 0 ? (
          <p className="py-1 text-xs text-muted">No idle signers waiting on live envelopes.</p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="text-xs font-semibold text-muted">
                <th className="py-1 font-medium">Signer</th>
                <th className="py-1 font-medium">Envelope</th>
                <th className="py-1 font-medium">Waiting</th>
                <th className="py-1 font-medium">Last nudge</th>
                <th className="py-1 text-right font-medium">Action</th>
              </tr>
            </thead>
            <tbody>
              {pending.map((n) => {
                const d = drafted[n.signerId];
                return (
                  <tr key={n.signerId} className="border-t border-line hover:bg-hover-paper">
                    <td className="py-1.5 pr-2">
                      <div className="text-ink">{n.name}</div>
                      <div className="text-xs text-muted">{n.email}</div>
                    </td>
                    <td className="py-1.5 pr-2 text-ink">{n.envelopeTitle}</td>
                    <td className="py-1.5 pr-2 text-ink">{n.daysWaiting}d</td>
                    <td className="py-1.5 pr-2 text-xs text-muted">
                      {n.lastNudgeAt ? new Date(n.lastNudgeAt).toLocaleDateString() : "—"}
                    </td>
                    <td className="py-1.5 text-right">
                      {d ? (
                        <div className="flex items-center justify-end gap-2">
                          <span className="max-w-56 truncate text-xs italic text-muted" title={d.message}>“{d.message}”</span>
                          <button onClick={() => approve(n)} disabled={busy === n.signerId} className={btnApprove}>
                            <CheckCircle2 size={13} /> Approve & release
                          </button>
                        </div>
                      ) : (
                        <button onClick={() => draft(n)} disabled={busy === n.signerId} className={btnGhost}>
                          <BellRing size={13} /> Draft nudge
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <p className="mt-2 text-xs text-subtle">
          Nudges are drafted for your approval — the OS never sends them on its own. Record the delivery after your provider sends it.
        </p>
      </div>
    </div>
  );
}

// ── Envelope list tab ────────────────────────────────────────────────────────

function EnvelopesTab() {
  const [envelopes, setEnvelopes] = useState<ApiEnvelope[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [composerOpen, setComposerOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/esign/envelopes");
      const data = await res.json();
      if (res.ok) setEnvelopes(data.envelopes ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = envelopes.filter((e) =>
    !search.trim() ||
    e.title.toLowerCase().includes(search.toLowerCase()) ||
    e.signers.some((s) => s.email.toLowerCase().includes(search.toLowerCase()) || s.name.toLowerCase().includes(search.toLowerCase())),
  );

  if (selectedId) {
    return <DetailView id={selectedId} onBack={() => setSelectedId(null)} onChanged={load} />;
  }

  return (
    <div className="space-y-4">
      <AutomationCard />
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search envelopes or signers…"
          className={`${inputCls} w-64`}
        />
        <div className="flex-1" />
        <button onClick={() => setComposerOpen(true)} className={btnPrimary}>
          <Plus size={14} /> New envelope
        </button>
      </div>

      <div className="overflow-hidden rounded-lg bg-paper shadow-hairline">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-line text-xs font-semibold text-muted">
                <th className="px-3 py-2 font-medium">Title</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Signers</th>
                <th className="px-3 py-2 font-medium">Document</th>
                <th className="px-3 py-2 font-medium">Updated</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={5} className="px-3 py-10 text-center text-muted"><Loader2 size={16} className="mr-2 inline animate-spin" />Loading…</td></tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-3 py-10 text-center text-muted">
                    <FileText size={20} className="mx-auto mb-2 text-subtle" />
                    No envelopes yet. Create a draft to get started.
                  </td>
                </tr>
              ) : (
                filtered.map((e) => {
                  const signed = e.signers.filter((s) => s.status === "signed").length;
                  return (
                    <tr
                      key={e.id}
                      onClick={() => setSelectedId(e.id)}
                      tabIndex={0}
                      onKeyDown={activateOnKey(() => setSelectedId(e.id))}
                      className="cursor-pointer border-b border-line last:border-0 hover:bg-hover-paper"
                    >
                      <td className="px-3 py-2.5 font-medium text-ink">{e.title}</td>
                      <td className="px-3 py-2.5"><Chip>{statusLabel(e.status)}</Chip></td>
                      <td className="px-3 py-2.5 text-muted">
                        {e.signers.length === 0 ? "—" : `${signed}/${e.signers.length} signed`}
                      </td>
                      <td className="px-3 py-2.5 text-muted">{e.documentName ?? "—"}</td>
                      <td className="px-3 py-2.5 text-muted">{fmtDate(e.updatedAt)}</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="rounded-md border border-line bg-canvas px-3 py-2.5 text-xs text-muted">
        Signing itself happens with the connected vendor (Documenso). ShapesOS prepares the
        envelope, gates the send on your explicit review, and mirrors the sealed document
        plus a tamper-evident audit trail — it never invents a signature.
      </div>

      {composerOpen && (
        <ComposerModal
          onClose={() => setComposerOpen(false)}
          onCreated={(id) => { setComposerOpen(false); void load(); setSelectedId(id); }}
        />
      )}
    </div>
  );
}

// ── Template library ─────────────────────────────────────────────────────────

interface ApiTemplate {
  id: string;
  name: string;
  sourceDocumentName: string | null;
  sourceDocumentHash: string | null;
  signerRoles: Array<{ role: string; orderIndex: number; required: boolean }>;
  fieldLayout: Array<{ signerRole: string; fieldType: string; page?: number; x?: number; y?: number; required?: boolean }>;
  mergeFieldMapping: Record<string, { source: string; path: string; required: boolean }>;
  contractType: string | null;
  updatedAt: string;
}

interface RoleRow { role: string; required: boolean }
interface FieldRow { signerRole: string; fieldType: string; page: string; x: string; y: string }
interface MergeRow { name: string; source: string; path: string; required: boolean }

function TemplateModal({
  template,
  onClose,
  onSaved,
}: {
  template: ApiTemplate | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(template?.name ?? "");
  const [contractType, setContractType] = useState(template?.contractType ?? "");
  const [file, setFile] = useState<File | null>(null);
  const [roles, setRoles] = useState<RoleRow[]>(
    template?.signerRoles.map((r) => ({ role: r.role, required: r.required })) ?? [{ role: "signer", required: true }],
  );
  const [fields, setFields] = useState<FieldRow[]>(
    template?.fieldLayout.map((f) => ({
      signerRole: f.signerRole,
      fieldType: f.fieldType,
      page: f.page != null ? String(f.page) : "1",
      x: f.x != null ? String(f.x) : "",
      y: f.y != null ? String(f.y) : "",
    })) ?? [],
  );
  const [merges, setMerges] = useState<MergeRow[]>(
    template ? Object.entries(template.mergeFieldMapping).map(([n, d]) => ({ name: n, source: d.source, path: d.path, required: d.required })) : [],
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const roleNames = roles.map((r) => r.role.trim()).filter(Boolean);

  async function submit() {
    setError(null);
    if (!name.trim()) return setError("Give the template a name.");
    if (!template && !file) return setError("Attach the blueprint PDF.");
    setSaving(true);
    try {
      if (template) {
        const res = await fetch(`/api/esign/templates/${template.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: name.trim(),
            contractType: contractType.trim() || null,
            signerRoles: roles.map((r, i) => ({ role: r.role.trim(), orderIndex: i, required: r.required })),
            fieldLayout: fields.map((f) => ({
              signerRole: f.signerRole,
              fieldType: f.fieldType,
              page: f.page ? Number(f.page) : undefined,
              x: f.x ? Number(f.x) : undefined,
              y: f.y ? Number(f.y) : undefined,
            })),
            mergeFieldMapping: Object.fromEntries(
              merges.filter((m) => m.name.trim()).map((m) => [m.name.trim(), { source: m.source.trim() || "manual", path: m.path.trim() || m.name.trim(), required: m.required }]),
            ),
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Could not save the template.");
      } else {
        const form = new FormData();
        form.set("name", name.trim());
        form.set("file", file!);
        form.set("signerRoles", JSON.stringify(roles.map((r, i) => ({ role: r.role.trim(), orderIndex: i, required: r.required }))));
        form.set("fieldLayout", JSON.stringify(fields.map((f) => ({
          signerRole: f.signerRole,
          fieldType: f.fieldType,
          page: f.page ? Number(f.page) : undefined,
          x: f.x ? Number(f.x) : undefined,
          y: f.y ? Number(f.y) : undefined,
        }))));
        form.set("mergeFieldMapping", JSON.stringify(Object.fromEntries(
          merges.filter((m) => m.name.trim()).map((m) => [m.name.trim(), { source: m.source.trim() || "manual", path: m.path.trim() || m.name.trim(), required: m.required }]),
        )));
        const res = await fetch("/api/esign/templates", { method: "POST", body: form });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Could not create the template.");
      }
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the template.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title={template ? "Edit template" : "New template"} onClose={onClose} wide>
      <ErrorNote error={error} />

      <label className="mb-1 block text-xs font-semibold text-muted">Name</label>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. MSA template" className={`${inputCls} mb-4 w-full`} maxLength={200} />

      {template && (
        <>
          <label className="mb-1 block text-xs font-semibold text-muted">
            Contract type <span className="font-normal text-subtle">(binds the template to a legal contract object, e.g. msa)</span>
          </label>
          <input value={contractType} onChange={(e) => setContractType(e.target.value)} placeholder="e.g. msa" className={`${inputCls} mb-4 w-full`} maxLength={80} />
        </>
      )}

      {!template && (
        <>
          <label className="mb-1 block text-xs font-semibold text-muted">Blueprint PDF</label>
          <label className="mb-4 flex cursor-pointer items-center gap-2 rounded-md border border-dashed border-control bg-canvas px-3 py-3 text-sm text-muted hover:border-ink">
            <FileUp size={16} className="shrink-0 text-subtle" />
            <span className="truncate">{file ? file.name : "Choose the blueprint PDF — drafts mint from these exact bytes"}</span>
            <input type="file" accept="application/pdf" className="hidden" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </label>
        </>
      )}

      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs font-semibold text-muted">Signer roles <span className="font-normal text-subtle">(in signing order)</span></span>
        <button type="button" onClick={() => setRoles((rs) => [...rs, { role: "", required: true }])} className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold text-ink hover:bg-hover-paper aos-press">
          <Plus size={13} /> Add role
        </button>
      </div>
      <div className="mb-4 space-y-2">
        {roles.map((r, i) => (
          <div key={i} className="grid grid-cols-[1fr_120px_28px] items-center gap-2">
            <input value={r.role} onChange={(e) => setRoles((rs) => rs.map((x, j) => (j === i ? { ...x, role: e.target.value } : x)))} placeholder="e.g. client" className={inputCls} />
            <label className="flex items-center gap-1.5 text-xs text-muted">
              <input type="checkbox" checked={r.required} onChange={(e) => setRoles((rs) => rs.map((x, j) => (j === i ? { ...x, required: e.target.checked } : x)))} className="h-3.5 w-3.5 accent-ink" />
              Required
            </label>
            <button type="button" disabled={roles.length <= 1} onClick={() => setRoles((rs) => rs.filter((_, j) => j !== i))} className="rounded-full p-1.5 text-subtle hover:bg-failed-tint hover:text-failed-text disabled:opacity-30" aria-label="Remove role">
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </div>

      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs font-semibold text-muted">Field layout</span>
        <button
          type="button"
          disabled={roleNames.length === 0}
          onClick={() => setFields((fs) => [...fs, { signerRole: roleNames[0]!, fieldType: "signature", page: "1", x: "", y: "" }])}
          className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold text-ink hover:bg-hover-paper aos-press disabled:opacity-40"
        >
          <Plus size={13} /> Add field
        </button>
      </div>
      {fields.length > 0 && (
        <div className="mb-4 space-y-2">
          {fields.map((f, i) => (
            <div key={i} className="grid grid-cols-[1fr_110px_56px_64px_64px_28px] items-center gap-2">
              <select value={f.signerRole} onChange={(e) => setFields((fs) => fs.map((x, j) => (j === i ? { ...x, signerRole: e.target.value } : x)))} className={inputCls}>
                {roleNames.map((r) => (<option key={r} value={r}>{r}</option>))}
              </select>
              <select value={f.fieldType} onChange={(e) => setFields((fs) => fs.map((x, j) => (j === i ? { ...x, fieldType: e.target.value } : x)))} className={inputCls}>
                <option value="signature">Signature</option>
                <option value="initials">Initials</option>
                <option value="date">Date</option>
                <option value="text">Text</option>
                <option value="checkbox">Checkbox</option>
              </select>
              <input value={f.page} onChange={(e) => setFields((fs) => fs.map((x, j) => (j === i ? { ...x, page: e.target.value } : x)))} placeholder="Pg" className={inputCls} inputMode="numeric" />
              <input value={f.x} onChange={(e) => setFields((fs) => fs.map((x, j) => (j === i ? { ...x, x: e.target.value } : x)))} placeholder="x" className={inputCls} inputMode="decimal" />
              <input value={f.y} onChange={(e) => setFields((fs) => fs.map((x, j) => (j === i ? { ...x, y: e.target.value } : x)))} placeholder="y" className={inputCls} inputMode="decimal" />
              <button type="button" onClick={() => setFields((fs) => fs.filter((_, j) => j !== i))} className="rounded-full p-1.5 text-subtle hover:bg-failed-tint hover:text-failed-text" aria-label="Remove field">
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs font-semibold text-muted">Merge fields <span className="font-normal text-subtle">(declared values the caller must supply)</span></span>
        <button type="button" onClick={() => setMerges((ms) => [...ms, { name: "", source: "manual", path: "", required: false }])} className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold text-ink hover:bg-hover-paper aos-press">
          <Plus size={13} /> Add merge field
        </button>
      </div>
      {merges.length > 0 && (
        <div className="mb-4 space-y-2">
          {merges.map((m, i) => (
            <div key={i} className="grid grid-cols-[1fr_110px_1fr_90px_28px] items-center gap-2">
              <input value={m.name} onChange={(e) => setMerges((ms) => ms.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} placeholder="placeholder" className={inputCls} />
              <input value={m.source} onChange={(e) => setMerges((ms) => ms.map((x, j) => (j === i ? { ...x, source: e.target.value } : x)))} placeholder="source" className={inputCls} />
              <input value={m.path} onChange={(e) => setMerges((ms) => ms.map((x, j) => (j === i ? { ...x, path: e.target.value } : x)))} placeholder="dotted.path" className={inputCls} />
              <label className="flex items-center gap-1 text-xs text-muted">
                <input type="checkbox" checked={m.required} onChange={(e) => setMerges((ms) => ms.map((x, j) => (j === i ? { ...x, required: e.target.checked } : x)))} className="h-3.5 w-3.5 accent-ink" />
                Req.
              </label>
              <button type="button" onClick={() => setMerges((ms) => ms.filter((_, j) => j !== i))} className="rounded-full p-1.5 text-subtle hover:bg-failed-tint hover:text-failed-text" aria-label="Remove merge field">
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="mt-4 flex justify-end gap-2">
        <button type="button" onClick={onClose} className={btnGhost}>Cancel</button>
        <button type="button" onClick={submit} disabled={saving} className={btnPrimary}>
          {saving ? <Loader2 size={14} className="animate-spin" /> : <LayoutTemplate size={14} />}
          {template ? "Save template" : "Create template"}
        </button>
      </div>
    </Modal>
  );
}

function InstantiateModal({
  template,
  onClose,
  onCreated,
}: {
  template: ApiTemplate;
  onClose: () => void;
  onCreated: (envelopeId: string) => void;
}) {
  const mergeNames = Object.keys(template.mergeFieldMapping);
  const [mergeValues, setMergeValues] = useState<Record<string, string>>({});
  const [bindings, setBindings] = useState<Array<{ role: string; name: string; email: string }>>(
    template.signerRoles.map((r) => ({ role: r.role, name: "", email: "" })),
  );
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit() {
    setError(null);
    setSaving(true);
    try {
      const res = await fetch(`/api/esign/templates/${template.id}/instantiate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim() || undefined,
          mergeValues,
          signerBindings: bindings.map((b) => ({ role: b.role, name: b.name.trim(), email: b.email.trim() })),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not instantiate the template.");
      onCreated(data.envelope.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not instantiate the template.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title={`Use template — ${template.name}`} onClose={onClose}>
      <ErrorNote error={error} />
      <p className="mb-4 text-sm text-muted">
        This mints a <span className="font-medium text-ink">draft</span> from the template's
        blueprint. Missing required values block — nothing is silently left blank.
      </p>

      <label className="mb-1 block text-xs font-semibold text-muted">Envelope title (optional)</label>
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={`${template.name} — …`} className={`${inputCls} mb-4 w-full`} maxLength={200} />

      {mergeNames.length > 0 && (
        <>
          <div className="mb-1 text-xs font-semibold text-muted">Merge values</div>
          <div className="mb-4 space-y-2">
            {mergeNames.map((n) => {
              const def = template.mergeFieldMapping[n]!;
              return (
                <div key={n} className="grid grid-cols-[160px_1fr] items-center gap-2">
                  <span className="truncate text-sm text-ink" title={`${def.source} · ${def.path}`}>
                    <code className="rounded bg-canvas px-1 py-0.5 font-mono text-xs">{n}</code>
                    {def.required && <span className="ml-1 text-failed-text">*</span>}
                  </span>
                  <input
                    value={mergeValues[n] ?? ""}
                    onChange={(e) => setMergeValues((m) => ({ ...m, [n]: e.target.value }))}
                    placeholder={`${def.source} · ${def.path}`}
                    className={inputCls}
                  />
                </div>
              );
            })}
          </div>
        </>
      )}

      <div className="mb-1 text-xs font-semibold text-muted">Bind signer roles</div>
      <div className="mb-4 space-y-2">
        {bindings.map((b, i) => (
          <div key={b.role} className="grid grid-cols-[120px_1fr_1fr] items-center gap-2">
            <span className="truncate text-sm font-medium text-ink">{b.role}</span>
            <input value={b.name} onChange={(e) => setBindings((bs) => bs.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} placeholder="Full name" className={inputCls} />
            <input value={b.email} onChange={(e) => setBindings((bs) => bs.map((x, j) => (j === i ? { ...x, email: e.target.value } : x)))} placeholder="email@company.com" className={inputCls} />
          </div>
        ))}
      </div>

      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} className={btnGhost}>Cancel</button>
        <button type="button" onClick={submit} disabled={saving} className={btnPrimary}>
          {saving ? <Loader2 size={14} className="animate-spin" /> : <PencilLine size={14} />}
          Create draft
        </button>
      </div>
    </Modal>
  );
}

function TemplatesTab({ onOpenEnvelope }: { onOpenEnvelope: (id: string) => void }) {
  const [templates, setTemplates] = useState<ApiTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<"create" | ApiTemplate | null>(null);
  const [instantiate, setInstantiate] = useState<ApiTemplate | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/esign/templates");
      const data = await res.json();
      if (res.ok) setTemplates(data.templates ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function remove(id: string) {
    if (!await confirmAction("Delete this template? Existing envelopes keep their copy.")) return;
    setDeleting(id);
    try {
      await fetch(`/api/esign/templates/${id}`, { method: "DELETE" });
      await load();
    } finally {
      setDeleting(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <div className="flex-1" />
        <button onClick={() => setModal("create")} className={btnPrimary}>
          <Plus size={14} /> New template
        </button>
      </div>

      <div className="overflow-hidden rounded-lg bg-paper shadow-hairline">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-line text-xs font-semibold text-muted">
                <th className="px-3 py-2 font-medium">Name</th>
                <th className="px-3 py-2 font-medium">Contract</th>
                <th className="px-3 py-2 font-medium">Roles</th>
                <th className="px-3 py-2 font-medium">Fields</th>
                <th className="px-3 py-2 font-medium">Merge fields</th>
                <th className="px-3 py-2 font-medium">Blueprint</th>
                <th className="px-3 py-2 font-medium">Updated</th>
                <th className="px-3 py-2 font-medium"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={8} className="px-3 py-10 text-center text-muted"><Loader2 size={16} className="mr-2 inline animate-spin" />Loading…</td></tr>
              ) : templates.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-3 py-10 text-center text-muted">
                    <LayoutTemplate size={20} className="mx-auto mb-2 text-subtle" />
                    No templates yet. Save a reusable blueprint to stop rebuilding envelopes by hand.
                  </td>
                </tr>
              ) : (
                templates.map((t) => (
                  <tr key={t.id} className="border-b border-line last:border-0 hover:bg-hover-paper">
                    <td className="px-3 py-2.5 font-medium text-ink">{t.name}</td>
                    <td className="px-3 py-2.5">{t.contractType ? <Chip>{t.contractType}</Chip> : <span className="text-subtle">—</span>}</td>
                    <td className="px-3 py-2.5">
                      <span className="flex flex-wrap gap-1">
                        {t.signerRoles.map((r) => (<Chip key={r.role}>{r.role}</Chip>))}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-muted">{t.fieldLayout.length}</td>
                    <td className="px-3 py-2.5 text-muted">{Object.keys(t.mergeFieldMapping).length}</td>
                    <td className="px-3 py-2.5 font-mono text-xs text-muted" title={t.sourceDocumentHash ?? ""}>
                      {t.sourceDocumentHash ? `${t.sourceDocumentHash.slice(0, 12)}…` : "—"}
                    </td>
                    <td className="px-3 py-2.5 text-muted">{fmtDate(t.updatedAt)}</td>
                    <td className="px-3 py-2.5">
                      <span className="flex items-center justify-end gap-1">
                        <button onClick={() => setInstantiate(t)} className="rounded-full px-2.5 py-1 text-xs font-semibold text-ink hover:bg-hover-paper">Use</button>
                        <button onClick={() => setModal(t)} className="rounded-full p-1.5 text-subtle hover:bg-hover-paper hover:text-ink" aria-label="Edit template">
                          <Pencil size={14} />
                        </button>
                        <button onClick={() => remove(t.id)} disabled={deleting === t.id} className="rounded-full p-1.5 text-subtle hover:bg-failed-tint hover:text-failed-text disabled:opacity-40" aria-label="Delete template">
                          {deleting === t.id ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                        </button>
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {modal && (
        <TemplateModal
          template={modal === "create" ? null : modal}
          onClose={() => setModal(null)}
          onSaved={() => { setModal(null); void load(); }}
        />
      )}
      {instantiate && (
        <InstantiateModal
          template={instantiate}
          onClose={() => setInstantiate(null)}
          onCreated={(id) => { setInstantiate(null); onOpenEnvelope(id); }}
        />
      )}
    </div>
  );
}

// ── App shell with sub-tabs ──────────────────────────────────────────────────

const ESIGN_TABS = [
  { id: "envelopes", label: "Envelopes", icon: FileText },
  { id: "templates", label: "Templates", icon: LayoutTemplate },
] as const;

export function EsignApp() {
  const [tab, setTab] = useState<(typeof ESIGN_TABS)[number]["id"]>("envelopes");
  const [openEnvelopeId, setOpenEnvelopeId] = useState<string | null>(null);

  if (openEnvelopeId) {
    return <DetailView id={openEnvelopeId} onBack={() => setOpenEnvelopeId(null)} onChanged={() => {}} />;
  }

  return (
    <div>
      <div className="mb-4 flex gap-1 border-b border-line">
        {ESIGN_TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-semibold ${
              tab === id
                ? "border-ink text-ink"
                : "border-transparent text-muted hover:text-ink"
            }`}
          >
            <Icon size={15} />
            {label}
          </button>
        ))}
      </div>
      {tab === "envelopes" ? <EnvelopesTab /> : <TemplatesTab onOpenEnvelope={setOpenEnvelopeId} />}
    </div>
  );
}
