// Marketr CRM — capture forms tab: embeddable lead-capture forms.
"use client";

import { useEffect, useState } from "react";
import { Plus, Trash, Copy, Check, Earth } from "lucide-react";
import { EmptyState } from "./ui";

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
      alert(e instanceof Error ? e.message : "Create failed");
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
    if (!confirm(`Delete form "${f.name}"? The embed URL stops working.`)) return;
    const r = await fetch(`/api/crm/forms/${f.id}`, { method: "DELETE" });
    if (r.ok) load();
  };

  const copy = (text: string) => {
    navigator.clipboard.writeText(text).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  if (loading) return <p className="py-12 text-center text-sm text-stone-500">Loading forms…</p>;

  return (
    <div className="space-y-4">
      {newToken && (
        <div className="rounded-[10px] border border-violet-300 bg-violet-50 p-4">
          <p className="text-[13px] font-semibold text-violet-900">
            Form created. Save this token now — it is never shown again:
          </p>
          <div className="mt-2 flex items-center gap-2">
            <code className="flex-1 break-all rounded-lg bg-white px-3 py-2 font-mono text-[12.5px] text-stone-800">
              {newToken}
            </code>
            <button className="crm-btn-ghost !py-1.5" onClick={() => copy(newToken)}>
              {copied ? <Check size={15} className="text-green-600" /> : <Copy size={15} />}
            </button>
          </div>
          <p className="mt-2 text-[12px] text-violet-800">
            Submit endpoint: <code className="font-mono">POST /api/crm/public/forms/{newToken}</code> with{" "}
            <code className="font-mono">{"{ name, email, phone, company, message }"}</code>. Include a honeypot field named{" "}
            <code className="font-mono">website</code> (leave blank).
          </p>
        </div>
      )}

      <div className="flex gap-2">
        <input
          className="crm-input max-w-sm flex-1 !text-[13px]"
          placeholder="New form name (e.g. Homepage contact form)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") create(); }}
        />
        <button className="crm-btn-primary" onClick={create} disabled={creating || !name.trim()}>
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
        <div className="overflow-hidden rounded-[10px] border border-stone-200 bg-white">
          {forms.map((f) => (
            <div key={f.id} className="flex items-center gap-3 border-b border-stone-100 px-4 py-3 last:border-0">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13.5px] font-semibold text-stone-900">{f.name}</div>
                <div className="text-[12px] text-stone-500">
                  {f.submitCount} submission{f.submitCount === 1 ? "" : "s"} · created{" "}
                  {new Date(f.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                </div>
              </div>
              <span className={`crm-chip ${f.enabled ? "crm-chip-green" : "crm-chip-gray"}`}>
                {f.enabled ? "Live" : "Disabled"}
              </span>
              <button className="crm-btn-ghost !py-1 !px-2.5 !text-[12px]" onClick={() => toggle(f)}>
                {f.enabled ? "Disable" : "Enable"}
              </button>
              <button
                className="rounded-lg p-1.5 text-stone-400 hover:bg-red-50 hover:text-red-600"
                onClick={() => remove(f)}
                title="Delete form"
              >
                <Trash size={15} />
              </button>
            </div>
          ))}
        </div>
      )}
      <p className="text-[12px] text-stone-400">
        Tokens are stored as SHA-256 hashes and can be revoked by deleting or disabling the form.
      </p>
    </div>
  );
}
