// Marketr — brand kit CRUD UI (milestone 12, white-label reporting).
// Client component: list, create/edit form, logo upload, set-default, delete.

"use client";

import { useState } from "react";

interface BrandKit {
  id: string;
  name: string;
  logoPath: string | null;
  colors: Record<string, string>;
  fonts: Record<string, string>;
  tone: string | null;
  clientId: string | null;
  isDefault: boolean;
  _count?: { templates: number; reports: number };
}

const COLOR_FIELDS = [
  { key: "primary", label: "Primary" },
  { key: "accent", label: "Accent" },
  { key: "text", label: "Text" },
  { key: "muted", label: "Muted" },
];

const FONT_FIELDS = [
  { key: "heading", label: "Heading font" },
  { key: "body", label: "Body font" },
];

const emptyForm = {
  name: "",
  colors: { primary: "#18181b", accent: "#f97316", text: "#18181b", muted: "#71717a" },
  fonts: { heading: "Helvetica-Bold", body: "Helvetica" },
  tone: "",
  isDefault: false,
};

export default function BrandKitManager({ initial }: { initial: BrandKit[] }) {
  const [kits, setKits] = useState<BrandKit[]>(initial);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploadingId, setUploadingId] = useState<string | null>(null);

  function startCreate() {
    setEditingId("new");
    setForm(emptyForm);
    setError(null);
  }

  function startEdit(kit: BrandKit) {
    setEditingId(kit.id);
    setForm({
      name: kit.name,
      colors: { ...emptyForm.colors, ...kit.colors },
      fonts: { ...emptyForm.fonts, ...kit.fonts },
      tone: kit.tone ?? "",
      isDefault: kit.isDefault,
    });
    setError(null);
  }

  async function save() {
    if (!form.name.trim()) {
      setError("Name is required");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const url = editingId === "new" ? "/api/brand-kits" : `/api/brand-kits/${editingId}`;
      const res = await fetch(url, {
        method: editingId === "new" ? "POST" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name,
          colors: form.colors,
          fonts: form.fonts,
          tone: form.tone || null,
          isDefault: form.isDefault,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Save failed");
      const saved: BrandKit = data.brandKit;
      setKits((prev) => {
        // Replace edited kit (or append new), keep default first.
        const merged = prev.some((k) => k.id === saved.id)
          ? prev.map((k) => (k.id === saved.id ? { ...k, ...saved } : k))
          : [...prev, { ...saved, _count: { templates: 0, reports: 0 } }];
        const fixed = saved.isDefault ? merged.map((k) => ({ ...k, isDefault: k.id === saved.id })) : merged;
        return fixed.sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
      });
      setEditingId(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string) {
    if (!confirm("Delete this brand kit? Templates using it will fall back to the default kit.")) return;
    const res = await fetch(`/api/brand-kits/${id}`, { method: "DELETE" });
    if (res.ok) setKits((prev) => prev.filter((k) => k.id !== id));
  }

  async function uploadLogo(id: string, file: File) {
    setUploadingId(id);
    setError(null);
    try {
      const formData = new FormData();
      formData.append("logo", file);
      const res = await fetch(`/api/brand-kits/${id}/logo`, { method: "POST", body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Upload failed");
      setKits((prev) => prev.map((k) => (k.id === id ? { ...k, ...data.brandKit } : k)));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploadingId(null);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <p className="text-sm text-zinc-500">
          Brand kits power white-label PDF reports. The default kit is used when a template has none.
        </p>
        <button
          onClick={startCreate}
          className="rounded-md bg-violet-600 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-violet-700"
        >
          New brand kit
        </button>
      </div>

      {error && <p className="rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{error}</p>}

      {editingId && (
        <div className="rounded-lg border border-zinc-300 bg-white p-6">
          <h2 className="mb-4 text-lg font-semibold">{editingId === "new" ? "New brand kit" : "Edit brand kit"}</h2>
          <div className="grid gap-4 md:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-zinc-500">Name</span>
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="e.g. Launchabl"
                className="rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-zinc-900"
              />
            </label>
            {FONT_FIELDS.map((f) => (
              <label key={f.key} className="flex flex-col gap-1 text-sm">
                <span className="text-zinc-500">{f.label}</span>
                <input
                  value={(form.fonts as Record<string, string>)[f.key] ?? ""}
                  onChange={(e) => setForm({ ...form, fonts: { ...form.fonts, [f.key]: e.target.value } })}
                  placeholder="Helvetica"
                  className="rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-zinc-900"
                />
              </label>
            ))}
          </div>
          <div className="mt-4 grid grid-cols-2 gap-4 md:grid-cols-4">
            {COLOR_FIELDS.map((c) => (
              <label key={c.key} className="flex items-center gap-2 text-sm">
                <input
                  type="color"
                  value={(form.colors as Record<string, string>)[c.key] ?? "#000000"}
                  onChange={(e) => setForm({ ...form, colors: { ...form.colors, [c.key]: e.target.value } })}
                  className="h-8 w-10 cursor-pointer rounded border border-zinc-200 bg-zinc-50"
                />
                <span className="text-zinc-500">{c.label}</span>
              </label>
            ))}
          </div>
          <label className="mt-4 flex flex-col gap-1 text-sm">
            <span className="text-zinc-500">Tone / voice notes (guides AI copy in reports)</span>
            <textarea
              value={form.tone}
              onChange={(e) => setForm({ ...form, tone: e.target.value })}
              rows={2}
              placeholder="Confident, plain-spoken, no jargon…"
              className="rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-zinc-900"
            />
          </label>
          <label className="mt-3 flex items-center gap-2 text-sm text-zinc-500">
            <input
              type="checkbox"
              checked={form.isDefault}
              onChange={(e) => setForm({ ...form, isDefault: e.target.checked })}
            />
            Default kit for this workspace
          </label>
          <div className="mt-4 flex gap-2">
            <button
              onClick={save}
              disabled={saving}
              className="rounded-md bg-violet-600 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-violet-700 disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save"}
            </button>
            <button
              onClick={() => setEditingId(null)}
              className="rounded-md border border-zinc-200 px-4 py-2 text-sm text-zinc-500 hover:bg-zinc-100"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        {kits.map((kit) => (
          <div key={kit.id} className="rounded-lg border border-zinc-300 bg-white p-5">
            <div className="flex items-start justify-between">
              <div>
                <h3 className="font-semibold text-zinc-900">
                  {kit.name}
                  {kit.isDefault && (
                    <span className="ml-2 rounded bg-accent-tint px-2 py-0.5 text-xs text-accent-ink">default</span>
                  )}
                </h3>
                <p className="mt-1 text-xs text-zinc-500">
                  {kit._count?.templates ?? 0} templates · {kit._count?.reports ?? 0} reports
                </p>
              </div>
              <div
                className="h-10 w-10 rounded border border-zinc-200"
                style={{ backgroundColor: kit.colors?.primary ?? "#18181b" }}
                title="Primary color"
              />
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {COLOR_FIELDS.map((c) => (
                <span key={c.key} className="flex items-center gap-1 text-xs text-zinc-500">
                  <span
                    className="inline-block h-3 w-3 rounded-full border border-zinc-200"
                    style={{ backgroundColor: (kit.colors as Record<string, string>)?.[c.key] ?? "transparent" }}
                  />
                  {c.label}
                </span>
              ))}
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <label className="cursor-pointer rounded-md border border-zinc-200 px-3 py-1.5 text-xs text-zinc-500 hover:bg-zinc-100">
                {uploadingId === kit.id ? "Uploading…" : kit.logoPath ? "Replace logo" : "Upload logo"}
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/svg+xml"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) uploadLogo(kit.id, f);
                    e.target.value = "";
                  }}
                />
              </label>
              <button
                onClick={() => startEdit(kit)}
                className="rounded-md border border-zinc-200 px-3 py-1.5 text-xs text-zinc-500 hover:bg-zinc-100"
              >
                Edit
              </button>
              <button
                onClick={() => remove(kit.id)}
                className="rounded-md border border-red-200 px-3 py-1.5 text-xs text-red-600 hover:bg-red-100"
              >
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>
      {kits.length === 0 && !editingId && (
        <p className="text-sm text-zinc-500">No brand kits yet. Create one to start white-labeling reports.</p>
      )}
    </div>
  );
}
