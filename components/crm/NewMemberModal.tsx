// Marketr CRM — new team member modal (Phase 17 slice 5).
// Creates a free team directory entry. No gate involved.

"use client";

import { useState } from "react";
import { Loader2, X } from "lucide-react";
import { backdropCls, btnGhost, btnPrimary, errorBoxCls, inputCls, modalWrapCls } from "./ui";

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
      <div className={backdropCls} onClick={onClose} aria-hidden />
      <div className={modalWrapCls}>
        <div className="flex items-start justify-between border-b border-line px-5 py-4">
          <h3 className="text-lg font-bold tracking-tight text-ink">New team member</h3>
          <button onClick={onClose} className="rounded-md p-1.5 text-subtle hover:bg-hover-paper hover:text-ink" aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className="flex flex-col gap-4 px-5 py-4">
          {error && (
            <div className={errorBoxCls}>
              {error}
            </div>
          )}
          <label className="block">
            <span className="mb-1 block text-[12px] font-semibold text-ink">Name *</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Ada Lovelace"
              className={`${inputCls} w-full`}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[12px] font-semibold text-ink">Title</span>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Operations lead"
              className={`${inputCls} w-full`}
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="mb-1 block text-[12px] font-semibold text-ink">Email</span>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@company.com"
                className={`${inputCls} w-full`}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[12px] font-semibold text-ink">Start date</span>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className={`${inputCls} w-full`}
              />
            </label>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className={btnGhost}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={saving}
              className={btnPrimary}
            >
              {saving && <Loader2 size={14} className="animate-spin" />} Add member
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
