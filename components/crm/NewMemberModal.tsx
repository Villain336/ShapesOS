// Marketr CRM — new team member modal (Phase 17 slice 5).
// Creates a free team directory entry. No gate involved.

"use client";

import { useState } from "react";
import { Loader2, X } from "lucide-react";

export function NewMemberModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [email, setEmail] = useState("");
  const [startDate, setStartDate] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!name.trim()) {
      setError("Name is required.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const r = await fetch("/api/ops/team-members", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          title: title.trim() || null,
          email: email.trim() || null,
          startDate: startDate || null,
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Failed to create member.");
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create member.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="crm-backdrop" onClick={onClose} />
      <div className="crm-modal">
        <div className="flex items-start justify-between border-b border-stone-200 px-5 py-4">
          <h3 className="text-lg font-bold tracking-tight text-stone-900">New team member</h3>
          <button onClick={onClose} className="rounded-lg p-1.5 text-stone-400 hover:bg-stone-100" aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className="flex flex-col gap-4 px-5 py-4">
          {error && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">
              {error}
            </div>
          )}
          <label className="block">
            <span className="mb-1 block text-[12px] font-semibold text-stone-700">Name *</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Ada Lovelace"
              className="w-full rounded-lg border border-stone-300 px-3 py-2 text-[13px] text-stone-900 placeholder:text-stone-400 focus:border-[var(--brand-600)] focus:outline-none"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[12px] font-semibold text-stone-700">Title</span>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Operations lead"
              className="w-full rounded-lg border border-stone-300 px-3 py-2 text-[13px] text-stone-900 placeholder:text-stone-400 focus:border-[var(--brand-600)] focus:outline-none"
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="mb-1 block text-[12px] font-semibold text-stone-700">Email</span>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@company.com"
                className="w-full rounded-lg border border-stone-300 px-3 py-2 text-[13px] text-stone-900 placeholder:text-stone-400 focus:border-[var(--brand-600)] focus:outline-none"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[12px] font-semibold text-stone-700">Start date</span>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="w-full rounded-lg border border-stone-300 px-3 py-2 text-[13px] text-stone-900 focus:border-[var(--brand-600)] focus:outline-none"
              />
            </label>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-stone-300 bg-white px-4 py-2 text-[13px] font-semibold text-stone-700 hover:bg-stone-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={saving}
              className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--brand-600)] px-4 py-2 text-[13px] font-semibold text-white hover:bg-[var(--brand-700)] disabled:opacity-50"
            >
              {saving && <Loader2 size={14} className="animate-spin" />} Add member
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
