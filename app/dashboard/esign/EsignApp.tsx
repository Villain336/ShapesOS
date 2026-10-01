// Marketr — Wave 2 E-sign module: envelope list, composer, detail, send gate.
// House pattern: StudioApp.tsx (AGENTS.md) — dense tables, brand buttons,
// Lucide icons, --brand-* vars (never hardcoded primary colors).

"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  FileText,
  FileUp,
  LayoutTemplate,
  Loader2,
  Pencil,
  PencilLine,
  Plus,
  RefreshCw,
  Send,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";

// ── House atoms ──────────────────────────────────────────────────────────────

const inputCls =
  "rounded-md border border-stone-200 bg-white px-2.5 py-1.5 text-[13px] text-stone-900 placeholder:text-stone-400 focus:border-[var(--brand-600)] focus:outline-none";

const btnPrimary =
  "flex items-center gap-1.5 rounded-md bg-[var(--brand-600)] px-3 py-1.5 text-[13px] font-medium text-white hover:bg-[var(--brand-700)] disabled:opacity-40";

const btnGhost =
  "flex items-center gap-1.5 rounded-md border border-stone-200 bg-white px-2.5 py-1.5 text-[13px] text-stone-700 hover:bg-stone-50 disabled:opacity-40";

const btnDanger =
  "flex items-center gap-1.5 rounded-md bg-red-600 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-red-700 disabled:opacity-40";

function Chip({ children, tone = "slate" }: { children: React.ReactNode; tone?: "slate" | "violet" | "green" | "amber" | "red" | "blue" }) {
  const tones: Record<string, string> = {
    slate: "bg-slate-100 text-slate-600 border-slate-200",
    violet: "bg-violet-50 text-violet-700 border-violet-200",
    green: "bg-emerald-50 text-emerald-700 border-emerald-200",
    amber: "bg-amber-50 text-amber-700 border-amber-200",
    red: "bg-red-50 text-red-700 border-red-200",
    blue: "bg-blue-50 text-blue-700 border-blue-200",
  };
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-tight ${tones[tone]}`}>
      {children}
    </span>
  );
}

function statusTone(status: string): "slate" | "violet" | "green" | "amber" | "red" | "blue" {
  switch (status) {
    case "draft": return "violet";
    case "sent": return "blue";
    case "partially-signed": return "amber";
    case "completed": return "green";
    case "declined":
    case "error": return "red";
    case "expired": return "amber";
    case "voided": return "slate";
    default: return "slate";
  }
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/40 p-4">
      <div className={`flex max-h-[90vh] w-full ${wide ? "max-w-3xl" : "max-w-2xl"} flex-col overflow-hidden rounded-xl bg-white shadow-xl`}>
        <div className="flex items-center justify-between border-b border-stone-100 px-5 py-3.5">
          <h2 className="text-[15px] font-semibold text-stone-900">{title}</h2>
          <button onClick={onClose} className="rounded-md p-1.5 text-stone-400 hover:bg-stone-100 hover:text-stone-600" aria-label="Close">
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
    <div className="mb-4 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">
      <AlertTriangle size={14} className="mt-0.5 shrink-0" />
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

      <label className="mb-1 block text-[12px] font-medium text-stone-600">Title</label>
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. MSA — Acme Corp" className={`${inputCls} mb-4 w-full`} maxLength={200} />

      <label className="mb-1 block text-[12px] font-medium text-stone-600">Document (PDF)</label>
      <label className="mb-4 flex cursor-pointer items-center gap-2 rounded-md border border-dashed border-stone-300 bg-stone-50 px-3 py-3 text-[13px] text-stone-600 hover:border-[var(--brand-600)]">
        <FileUp size={16} className="shrink-0 text-stone-400" />
        <span className="truncate">{file ? file.name : "Choose a PDF — this is the exact file reviewers approve"}</span>
        <input
          type="file"
          accept="application/pdf"
          className="hidden"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
      </label>

      <div className="mb-1 flex items-center justify-between">
        <span className="text-[12px] font-medium text-stone-600">Signers</span>
        <button
          type="button"
          onClick={() => setSigners((ss) => [...ss, { name: "", email: "", role: "signer" }])}
          className="flex items-center gap-1 text-[12px] font-medium text-[var(--brand-700)] hover:underline"
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
              className="rounded-md p-1.5 text-stone-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-30"
              aria-label="Remove signer"
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </div>

      <div className="mb-4 grid grid-cols-2 gap-3">
        <div>
          <label className="mb-1 block text-[12px] font-medium text-stone-600">Signing order</label>
          <select value={signingOrder} onChange={(e) => setSigningOrder(e.target.value as "sequential" | "parallel")} className={`${inputCls} w-full`}>
            <option value="sequential">Sequential — in listed order</option>
            <option value="parallel">Parallel — all at once</option>
          </select>
        </div>
        <div>
          <label className="mb-1 block text-[12px] font-medium text-stone-600">Expires (optional)</label>
          <input type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} className={`${inputCls} w-full`} />
        </div>
      </div>

      <div className="mb-1 flex items-center justify-between">
        <span className="text-[12px] font-medium text-stone-600">Signature fields (optional)</span>
        <button
          type="button"
          disabled={signers.every((s) => !s.email.trim())}
          onClick={() =>
            setFields((fs) => [
              ...fs,
              { signerEmail: signers.find((s) => s.email.trim())?.email.trim() ?? "", fieldType: "signature", page: "1", x: "", y: "" },
            ])
          }
          className="flex items-center gap-1 text-[12px] font-medium text-[var(--brand-700)] hover:underline disabled:opacity-40"
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
                className="rounded-md p-1.5 text-stone-400 hover:bg-red-50 hover:text-red-600"
                aria-label="Remove field"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="rounded-md border border-stone-200 bg-stone-50 px-3 py-2.5 text-[12px] text-stone-500">
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
        <div className="flex items-center justify-center py-10 text-[13px] text-stone-500">
          <Loader2 size={16} className="mr-2 animate-spin" /> Loading the exact send summary…
        </div>
      ) : (
        <>
          {!preview.vendorConfigured && (
            <div className="mb-4 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] text-amber-800">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span>
                The signing vendor is not connected (missing DOCUMENSO credentials). Sending will
                fail until it is configured — the draft stays safe either way.
              </span>
            </div>
          )}
          <div className="mb-4 rounded-md border border-stone-200">
            <div className="border-b border-stone-100 bg-stone-50/60 px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-stone-500">
              What will be sent
            </div>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-2 px-3 py-3 text-[13px]">
              <div><dt className="text-[11px] text-stone-500">Title</dt><dd className="font-medium text-stone-900">{preview.title}</dd></div>
              <div><dt className="text-[11px] text-stone-500">Document</dt><dd className="text-stone-900">{preview.documentName ?? "—"}</dd></div>
              <div><dt className="text-[11px] text-stone-500">Document hash</dt><dd className="font-mono text-[12px] text-stone-900">{hashShort(preview.sourcePdfHash)}</dd></div>
              <div><dt className="text-[11px] text-stone-500">Signing order</dt><dd className="text-stone-900">{preview.signingOrder}</dd></div>
              <div><dt className="text-[11px] text-stone-500">Expires</dt><dd className="text-stone-900">{fmtDate(preview.expiresAt)}</dd></div>
              <div><dt className="text-[11px] text-stone-500">Fields</dt><dd className="text-stone-900">{preview.fieldCount}</dd></div>
            </dl>
            <div className="border-t border-stone-100 px-3 py-2">
              <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-stone-500">Signers</div>
              <ul className="space-y-1 text-[13px]">
                {preview.signers.map((s) => (
                  <li key={s.email} className="flex items-center justify-between gap-2">
                    <span className="text-stone-900">{s.name} <span className="text-stone-500">· {s.email}</span></span>
                    <Chip tone={s.role === "signer" ? "blue" : "slate"}>{s.role}</Chip>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <label className="flex cursor-pointer items-start gap-2.5 rounded-md border border-stone-200 bg-stone-50 px-3 py-2.5">
            <input
              type="checkbox"
              checked={reviewed}
              onChange={(e) => setReviewed(e.target.checked)}
              className="mt-0.5 h-4 w-4 accent-[var(--brand-600)]"
            />
            <span className="text-[13px] text-stone-700">
              I have reviewed the document, the signer list, and the signing order above. This
              confirmation is bound to this exact version — if anything changes, I review again.
            </span>
          </label>

          <div className="mt-3 flex items-center gap-2 text-[12px] text-stone-500">
            <ShieldCheck size={14} className="shrink-0 text-stone-400" />
            <span>Approval token (echoed to the server with your send):</span>
            <code className="truncate rounded bg-stone-100 px-1.5 py-0.5 font-mono text-[11px] text-stone-700">{token ? `${token.slice(0, 24)}…` : "—"}</code>
          </div>

          <div className="mt-4 flex justify-end gap-2">
            <button type="button" onClick={onClose} className={btnGhost}>Cancel</button>
            <button type="button" onClick={send} disabled={!reviewed || sending} className={btnPrimary}>
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
      <p className="mb-3 text-[13px] text-stone-600">
        The envelope is cancelled and signers can no longer sign. The sealed document,
        if any, is kept as evidence — voiding never deletes it.
      </p>
      <label className="mb-1 block text-[12px] font-medium text-stone-600">Reason</label>
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
        <button type="button" onClick={submit} disabled={saving} className={btnDanger}>
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
          Void envelope
        </button>
      </div>
    </Modal>
  );
}

// ── Envelope detail ──────────────────────────────────────────────────────────

function signerTone(status: string): "slate" | "violet" | "green" | "amber" | "red" | "blue" {
  switch (status) {
    case "signed": return "green";
    case "sent":
    case "viewed": return "blue";
    case "declined": return "red";
    default: return "slate";
  }
}

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
      <div className="rounded-lg border border-stone-200 bg-white p-6">
        <ErrorNote error={error} />
        <button onClick={onBack} className={btnGhost}><ArrowLeft size={14} /> Back</button>
      </div>
    );
  }
  if (!detail) {
    return (
      <div className="flex items-center justify-center rounded-lg border border-stone-200 bg-white py-16 text-[13px] text-stone-500">
        <Loader2 size={16} className="mr-2 animate-spin" /> Loading envelope…
      </div>
    );
  }

  const canSend = detail.status === "draft";
  const canVoid = ["draft", "sent", "partially-signed"].includes(detail.status);
  const canRefresh = ["sent", "partially-signed", "completed"].includes(detail.status);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <button onClick={onBack} className={btnGhost}><ArrowLeft size={14} /> Back</button>
          <h2 className="text-lg font-bold tracking-tight text-stone-900">{detail.title}</h2>
          <Chip tone={statusTone(detail.status)}>{statusLabel(detail.status)}</Chip>
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
          {canSend && (
            <button onClick={() => setShowSend(true)} className={btnPrimary}>
              <Send size={14} /> Review & send
            </button>
          )}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-lg border border-stone-200 bg-white">
          <div className="border-b border-stone-100 px-4 py-2.5 text-[12px] font-semibold text-stone-900">Document</div>
          <dl className="space-y-2 px-4 py-3 text-[13px]">
            <div className="flex justify-between gap-4"><dt className="text-stone-500">File</dt><dd className="text-right text-stone-900">{detail.documentName ?? "—"}</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-stone-500">Source hash</dt><dd className="font-mono text-[12px] text-stone-900">{hashShort(detail.sourcePdfHash)}</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-stone-500">Sealed PDF hash</dt><dd className="font-mono text-[12px] text-stone-900">{hashShort(detail.sealedPdfHash)}</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-stone-500">Sealed fetched</dt><dd className="text-stone-900">{fmtDate(detail.sealedPdfFetchedAt)}</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-stone-500">Signing order</dt><dd className="text-stone-900">{detail.signingOrder}</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-stone-500">Expires</dt><dd className="text-stone-900">{fmtDate(detail.expiresAt)}</dd></div>
            {detail.vendorRef && (
              <div className="flex justify-between gap-4"><dt className="text-stone-500">Vendor ref</dt><dd className="font-mono text-[12px] text-stone-900">{detail.vendorRef}</dd></div>
            )}
            {detail.voidReason && (
              <div className="flex justify-between gap-4"><dt className="text-stone-500">Void reason</dt><dd className="text-right text-stone-900">{detail.voidReason}</dd></div>
            )}
          </dl>
        </div>

        <div className="rounded-lg border border-stone-200 bg-white">
          <div className="border-b border-stone-100 px-4 py-2.5 text-[12px] font-semibold text-stone-900">Signers</div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[13px]">
              <thead>
                <tr className="border-b border-stone-100 bg-stone-50/60 text-[11px] uppercase tracking-wide text-stone-500">
                  <th className="px-4 py-2 font-medium">Name</th>
                  <th className="px-4 py-2 font-medium">Email</th>
                  <th className="px-4 py-2 font-medium">Role</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium">Signed</th>
                </tr>
              </thead>
              <tbody>
                {detail.signers.map((s) => (
                  <tr key={s.id} className="border-b border-stone-100 last:border-0 hover:bg-[var(--brand-50)]/40">
                    <td className="px-4 py-2 font-medium text-stone-900">{s.name}</td>
                    <td className="px-4 py-2 text-stone-600">{s.email}</td>
                    <td className="px-4 py-2"><Chip>{s.role}</Chip></td>
                    <td className="px-4 py-2"><Chip tone={signerTone(s.status)}>{s.status}</Chip></td>
                    <td className="px-4 py-2 text-stone-600">{fmtDate(s.signedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {detail.fields.length > 0 && (
        <div className="rounded-lg border border-stone-200 bg-white">
          <div className="border-b border-stone-100 px-4 py-2.5 text-[12px] font-semibold text-stone-900">Fields</div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[13px]">
              <thead>
                <tr className="border-b border-stone-100 bg-stone-50/60 text-[11px] uppercase tracking-wide text-stone-500">
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
                    <tr key={f.id} className="border-b border-stone-100 last:border-0 hover:bg-[var(--brand-50)]/40">
                      <td className="px-4 py-2 text-stone-900">{signer?.name ?? "—"}</td>
                      <td className="px-4 py-2"><Chip tone="blue">{f.fieldType}</Chip></td>
                      <td className="px-4 py-2 text-stone-600">{f.page ?? "—"}</td>
                      <td className="px-4 py-2 text-stone-600">{f.x != null && f.y != null ? `(${f.x}, ${f.y})` : "—"}</td>
                      <td className="px-4 py-2 text-stone-600">{f.required ? "Yes" : "No"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="rounded-lg border border-stone-200 bg-white">
        <div className="border-b border-stone-100 px-4 py-2.5 text-[12px] font-semibold text-stone-900">
          Audit trail <span className="ml-1 font-normal text-stone-500">— hash-chained, tamper-evident</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[13px]">
            <thead>
              <tr className="border-b border-stone-100 bg-stone-50/60 text-[11px] uppercase tracking-wide text-stone-500">
                <th className="px-4 py-2 font-medium">Event</th>
                <th className="px-4 py-2 font-medium">Actor</th>
                <th className="px-4 py-2 font-medium">Hash</th>
                <th className="px-4 py-2 font-medium">Time</th>
              </tr>
            </thead>
            <tbody>
              {detail.events.map((e) => (
                <tr key={e.id} className="border-b border-stone-100 last:border-0 hover:bg-[var(--brand-50)]/40">
                  <td className="px-4 py-2 font-medium text-stone-900">{e.event.replace(/_/g, " ")}</td>
                  <td className="px-4 py-2 text-stone-600">{e.actor ?? "vendor"}</td>
                  <td className="px-4 py-2 font-mono text-[12px] text-stone-600" title={e.previousHash ? `prev: ${e.previousHash}` : ""}>
                    {hashShort(e.hash)}
                  </td>
                  <td className="px-4 py-2 text-stone-600">{fmtDate(e.createdAt)}</td>
                </tr>
              ))}
              {detail.events.length === 0 && (
                <tr><td colSpan={4} className="px-4 py-6 text-center text-stone-500">No events yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {detail.status === "completed" && (
        <div className="flex items-start gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-[13px] text-emerald-800">
          <CheckCircle2 size={15} className="mt-0.5 shrink-0" />
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

      <div className="overflow-hidden rounded-lg border border-stone-200 bg-white">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[13px]">
            <thead>
              <tr className="border-b border-stone-100 bg-stone-50/60 text-[11px] uppercase tracking-wide text-stone-500">
                <th className="px-3 py-2 font-medium">Title</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Signers</th>
                <th className="px-3 py-2 font-medium">Document</th>
                <th className="px-3 py-2 font-medium">Updated</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={5} className="px-3 py-10 text-center text-stone-500"><Loader2 size={16} className="mr-2 inline animate-spin" />Loading…</td></tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-3 py-10 text-center text-stone-500">
                    <FileText size={20} className="mx-auto mb-2 text-stone-300" />
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
                      className="cursor-pointer border-b border-stone-100 last:border-0 hover:bg-[var(--brand-50)]/40"
                    >
                      <td className="px-3 py-2.5 font-medium text-stone-900">{e.title}</td>
                      <td className="px-3 py-2.5"><Chip tone={statusTone(e.status)}>{statusLabel(e.status)}</Chip></td>
                      <td className="px-3 py-2.5 text-stone-600">
                        {e.signers.length === 0 ? "—" : `${signed}/${e.signers.length} signed`}
                      </td>
                      <td className="px-3 py-2.5 text-stone-600">{e.documentName ?? "—"}</td>
                      <td className="px-3 py-2.5 text-stone-600">{fmtDate(e.updatedAt)}</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="rounded-md border border-stone-200 bg-stone-50 px-3 py-2.5 text-[12px] text-stone-500">
        Signing itself happens with the connected vendor (Documenso). Marketr prepares the
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

      <label className="mb-1 block text-[12px] font-medium text-stone-600">Name</label>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. MSA template" className={`${inputCls} mb-4 w-full`} maxLength={200} />

      {!template && (
        <>
          <label className="mb-1 block text-[12px] font-medium text-stone-600">Blueprint PDF</label>
          <label className="mb-4 flex cursor-pointer items-center gap-2 rounded-md border border-dashed border-stone-300 bg-stone-50 px-3 py-3 text-[13px] text-stone-600 hover:border-[var(--brand-600)]">
            <FileUp size={16} className="shrink-0 text-stone-400" />
            <span className="truncate">{file ? file.name : "Choose the blueprint PDF — drafts mint from these exact bytes"}</span>
            <input type="file" accept="application/pdf" className="hidden" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </label>
        </>
      )}

      <div className="mb-1 flex items-center justify-between">
        <span className="text-[12px] font-medium text-stone-600">Signer roles <span className="font-normal text-stone-400">(in signing order)</span></span>
        <button type="button" onClick={() => setRoles((rs) => [...rs, { role: "", required: true }])} className="flex items-center gap-1 text-[12px] font-medium text-[var(--brand-700)] hover:underline">
          <Plus size={13} /> Add role
        </button>
      </div>
      <div className="mb-4 space-y-2">
        {roles.map((r, i) => (
          <div key={i} className="grid grid-cols-[1fr_120px_28px] items-center gap-2">
            <input value={r.role} onChange={(e) => setRoles((rs) => rs.map((x, j) => (j === i ? { ...x, role: e.target.value } : x)))} placeholder="e.g. client" className={inputCls} />
            <label className="flex items-center gap-1.5 text-[12px] text-stone-600">
              <input type="checkbox" checked={r.required} onChange={(e) => setRoles((rs) => rs.map((x, j) => (j === i ? { ...x, required: e.target.checked } : x)))} className="h-3.5 w-3.5 accent-[var(--brand-600)]" />
              Required
            </label>
            <button type="button" disabled={roles.length <= 1} onClick={() => setRoles((rs) => rs.filter((_, j) => j !== i))} className="rounded-md p-1.5 text-stone-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-30" aria-label="Remove role">
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </div>

      <div className="mb-1 flex items-center justify-between">
        <span className="text-[12px] font-medium text-stone-600">Field layout</span>
        <button
          type="button"
          disabled={roleNames.length === 0}
          onClick={() => setFields((fs) => [...fs, { signerRole: roleNames[0]!, fieldType: "signature", page: "1", x: "", y: "" }])}
          className="flex items-center gap-1 text-[12px] font-medium text-[var(--brand-700)] hover:underline disabled:opacity-40"
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
              <button type="button" onClick={() => setFields((fs) => fs.filter((_, j) => j !== i))} className="rounded-md p-1.5 text-stone-400 hover:bg-red-50 hover:text-red-600" aria-label="Remove field">
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="mb-1 flex items-center justify-between">
        <span className="text-[12px] font-medium text-stone-600">Merge fields <span className="font-normal text-stone-400">(declared values the caller must supply)</span></span>
        <button type="button" onClick={() => setMerges((ms) => [...ms, { name: "", source: "manual", path: "", required: false }])} className="flex items-center gap-1 text-[12px] font-medium text-[var(--brand-700)] hover:underline">
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
              <label className="flex items-center gap-1 text-[12px] text-stone-600">
                <input type="checkbox" checked={m.required} onChange={(e) => setMerges((ms) => ms.map((x, j) => (j === i ? { ...x, required: e.target.checked } : x)))} className="h-3.5 w-3.5 accent-[var(--brand-600)]" />
                Req.
              </label>
              <button type="button" onClick={() => setMerges((ms) => ms.filter((_, j) => j !== i))} className="rounded-md p-1.5 text-stone-400 hover:bg-red-50 hover:text-red-600" aria-label="Remove merge field">
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
      <p className="mb-4 text-[13px] text-stone-600">
        This mints a <span className="font-medium text-stone-900">draft</span> from the template's
        blueprint. Missing required values block — nothing is silently left blank.
      </p>

      <label className="mb-1 block text-[12px] font-medium text-stone-600">Envelope title (optional)</label>
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={`${template.name} — …`} className={`${inputCls} mb-4 w-full`} maxLength={200} />

      {mergeNames.length > 0 && (
        <>
          <div className="mb-1 text-[12px] font-medium text-stone-600">Merge values</div>
          <div className="mb-4 space-y-2">
            {mergeNames.map((n) => {
              const def = template.mergeFieldMapping[n]!;
              return (
                <div key={n} className="grid grid-cols-[160px_1fr] items-center gap-2">
                  <span className="truncate text-[13px] text-stone-700" title={`${def.source} · ${def.path}`}>
                    <code className="rounded bg-stone-100 px-1 py-0.5 font-mono text-[12px]">{n}</code>
                    {def.required && <span className="ml-1 text-red-500">*</span>}
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

      <div className="mb-1 text-[12px] font-medium text-stone-600">Bind signer roles</div>
      <div className="mb-4 space-y-2">
        {bindings.map((b, i) => (
          <div key={b.role} className="grid grid-cols-[120px_1fr_1fr] items-center gap-2">
            <span className="truncate text-[13px] font-medium text-stone-700">{b.role}</span>
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
    if (!window.confirm("Delete this template? Existing envelopes keep their copy.")) return;
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

      <div className="overflow-hidden rounded-lg border border-stone-200 bg-white">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[13px]">
            <thead>
              <tr className="border-b border-stone-100 bg-stone-50/60 text-[11px] uppercase tracking-wide text-stone-500">
                <th className="px-3 py-2 font-medium">Name</th>
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
                <tr><td colSpan={7} className="px-3 py-10 text-center text-stone-500"><Loader2 size={16} className="mr-2 inline animate-spin" />Loading…</td></tr>
              ) : templates.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-3 py-10 text-center text-stone-500">
                    <LayoutTemplate size={20} className="mx-auto mb-2 text-stone-300" />
                    No templates yet. Save a reusable blueprint to stop rebuilding envelopes by hand.
                  </td>
                </tr>
              ) : (
                templates.map((t) => (
                  <tr key={t.id} className="border-b border-stone-100 last:border-0 hover:bg-[var(--brand-50)]/40">
                    <td className="px-3 py-2.5 font-medium text-stone-900">{t.name}</td>
                    <td className="px-3 py-2.5">
                      <span className="flex flex-wrap gap-1">
                        {t.signerRoles.map((r) => (<Chip key={r.role}>{r.role}</Chip>))}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-stone-600">{t.fieldLayout.length}</td>
                    <td className="px-3 py-2.5 text-stone-600">{Object.keys(t.mergeFieldMapping).length}</td>
                    <td className="px-3 py-2.5 font-mono text-[12px] text-stone-600" title={t.sourceDocumentHash ?? ""}>
                      {t.sourceDocumentHash ? `${t.sourceDocumentHash.slice(0, 12)}…` : "—"}
                    </td>
                    <td className="px-3 py-2.5 text-stone-600">{fmtDate(t.updatedAt)}</td>
                    <td className="px-3 py-2.5">
                      <span className="flex items-center justify-end gap-1">
                        <button onClick={() => setInstantiate(t)} className="rounded-md px-2 py-1 text-[12px] font-medium text-[var(--brand-700)] hover:bg-[var(--brand-50)]">Use</button>
                        <button onClick={() => setModal(t)} className="rounded-md p-1.5 text-stone-400 hover:bg-stone-100 hover:text-stone-600" aria-label="Edit template">
                          <Pencil size={14} />
                        </button>
                        <button onClick={() => remove(t.id)} disabled={deleting === t.id} className="rounded-md p-1.5 text-stone-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-40" aria-label="Delete template">
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
      <div className="mb-4 flex gap-1 border-b border-stone-200">
        {ESIGN_TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`flex items-center gap-1.5 border-b-2 px-3 py-2 text-[13.5px] font-medium transition ${
              tab === id
                ? "border-[var(--brand-600)] text-[var(--brand-700)]"
                : "border-transparent text-stone-500 hover:text-stone-800"
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
