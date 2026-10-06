// Marketr CRM — capture forms tab: embeddable lead-capture forms.
"use client";

import { useEffect, useState } from "react";
import { Plus, Trash, Copy, Check, Earth } from "lucide-react";
import { EmptyState, btnGhostSm, btnPrimary, chipCls, inputCls } from "./ui";
import { confirmAction, toastError } from "@/lib/ui/feedback";

interface CrmForm {
  id: string;
  name: string;
  pipelineId: string;
  enabled: boolean;
  redirectUrl?: string | null;
  submitCount: number;
  createdAt: string;
}

export function FormsTab({ pipelineId }: { pipelineId: string }) {
  const [forms, setForms] = useState<CrmForm[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/crm/forms?pipelineId=${pipelineId}`);
      if (r.ok) setForms((await r.json()).forms ?? []);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, [pipelineId]);

  const create = async () => {
    if (!name.trim()) return;
    setCreating(true);
    setNewToken(null);
    try {
      const r = await fetch("/api/crm/forms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), pipelineId }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Create failed");
      setNewToken(d.token);
      setName("");
      await load();
    } catch (e) {
      toastError(e instanceof Error ? e.message : "Create failed");
    } finally {
      setCreating(false);
    }
  };

  const toggle = async (f: CrmForm) => {
    const r = await fetch(`/api/crm/forms/${f.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !f.enabled }),
    });
    if (r.ok) load();
  };

  const remove = async (f: CrmForm) => {
    if (!await confirmAction(`Delete form "${f.name}"? The embed URL stops working.`)) return;
    const r = await fetch(`/api/crm/forms/${f.id}`, { method: "DELETE" });
    if (r.ok) load();
  };

  const copy = (text: string) => {
    navigator.clipboard.writeText(text).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  if (loading) return <p className="py-12 text-center text-sm text-muted">Loading forms…</p>;

  return (
    <div className="space-y-4">
      {newToken && (
        <div className="rounded-md border border-line bg-canvas p-4">
          <p className="text-[0.8125rem] font-semibold text-ink">
            Form created. Save this token now — it is never shown again:
          </p>
          <div className="mt-2 flex items-center gap-2">
            <code className="flex-1 break-all rounded-md bg-paper px-3 py-2 font-mono text-[0.78125rem] text-ink">
              {newToken}
            </code>
            <button className={btnGhostSm} onClick={() => copy(newToken)}>
              {copied ? <Check size={15} className="text-ink" /> : <Copy size={15} />}
            </button>
          </div>
          <p className="mt-2 text-[0.75rem] text-ink">
            Submit endpoint: <code className="font-mono">POST /api/crm/public/forms/{newToken}</code> with{" "}
            <code className="font-mono">{"{ name, email, phone, company, message }"}</code>. Include a honeypot field named{" "}
            <code className="font-mono">website</code> (leave blank).
          </p>
        </div>
      )}

      <div className="flex gap-2">
        <input
          className={`${inputCls} max-w-sm flex-1`}
          placeholder="New form name (e.g. Homepage contact form)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") create(); }}
        />
        <button className={btnPrimary} onClick={create} disabled={creating || !name.trim()}>
          <Plus size={15} strokeWidth={2.5} /> {creating ? "Creating…" : "Create form"}
        </button>
      </div>

      {forms.length === 0 ? (
        <EmptyState
          icon={Earth}
          title="No capture forms"
          hint="Create an embeddable form to turn website visitors into pipeline leads automatically."
        />
      ) : (
        <div className="overflow-hidden rounded-md border border-line bg-paper">
          {forms.map((f) => (
            <div key={f.id} className="flex items-center gap-3 border-b border-line px-4 py-3 last:border-0">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[0.84375rem] font-semibold text-ink">{f.name}</div>
                <div className="text-[0.75rem] text-muted">
                  {f.submitCount} submission{f.submitCount === 1 ? "" : "s"} · created{" "}
                  {new Date(f.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                </div>
              </div>
              <span className={chipCls}>
                {f.enabled ? "Live" : "Disabled"}
              </span>
              <button className={btnGhostSm} onClick={() => toggle(f)}>
                {f.enabled ? "Disable" : "Enable"}
              </button>
              <button
                className="rounded-md p-1.5 text-subtle hover:bg-failed-tint hover:text-failed-text"
                onClick={() => remove(f)}
                title="Delete form"
              >
                <Trash size={15} />
              </button>
            </div>
          ))}
        </div>
      )}
      <p className="text-[0.75rem] text-subtle">
        Tokens are stored as SHA-256 hashes and can be revoked by deleting or disabling the form.
      </p>
    </div>
  );
}
