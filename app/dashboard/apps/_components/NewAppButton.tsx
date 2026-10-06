"use client";

// ShapesOS — Phase 9 (apps): "New app" — name + description, creates a draft
// with the starter spec and opens the builder.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, X } from "lucide-react";
import { aosButton } from "@/components/aos";
import { slugify } from "@/lib/apps/spec";
import { ErrorLine, inputCls } from "./kit";

export function NewAppButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setError("Give the app a name.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/apps", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, description }),
      });
      const body = (await res.json().catch(() => ({}))) as { app?: { slug: string }; error?: string };
      if (!res.ok || !body.app) throw new Error(body.error ?? "Couldn't create the app.");
      router.push(`/dashboard/apps/${body.app.slug}/build`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't create the app.");
      setBusy(false);
    }
  }

  return (
    <>
      <button type="button" className={aosButton({ variant: "primary" })} onClick={() => setOpen(true)}>
        <Plus size={18} aria-hidden />
        New app
      </button>
      {open ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-night/30 px-4" onMouseDown={(e) => e.target === e.currentTarget && !busy && setOpen(false)}>
          <form
            role="dialog"
            aria-modal="true"
            aria-labelledby="new-app-title"
            onSubmit={create}
            onKeyDown={(e) => e.key === "Escape" && !busy && setOpen(false)}
            className="flex w-full max-w-[480px] flex-col gap-5 rounded-lg bg-paper p-6 shadow-overlay"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 id="new-app-title" className="aos-subheading">New app</h2>
                <p className="mt-1 text-md text-muted">It starts as a draft with one list you can reshape in the builder.</p>
              </div>
              <button type="button" aria-label="Close" className={aosButton({ variant: "quiet", size: "xs", className: "px-2" })} onClick={() => setOpen(false)}>
                <X size={16} aria-hidden />
              </button>
            </div>
            <label className="flex flex-col gap-2">
              <span className="text-md font-semibold text-ink">Name</span>
              <input autoFocus className={inputCls} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="Equipment check-out" />
              {name.trim() ? (
                <span className="text-sm text-muted">
                  Address: <span className="aos-mono">/dashboard/apps/{slugify(name)}</span>
                </span>
              ) : null}
            </label>
            <label className="flex flex-col gap-2">
              <span className="text-md font-semibold text-ink">Description</span>
              <input className={inputCls} value={description} maxLength={500} onChange={(e) => setDescription(e.target.value)} placeholder="What the team uses it for" />
            </label>
            {error ? <ErrorLine>{error}</ErrorLine> : null}
            <div className="flex justify-end gap-2">
              <button type="button" className={aosButton({ variant: "secondary" })} onClick={() => setOpen(false)} disabled={busy}>
                Cancel
              </button>
              <button type="submit" className={aosButton({ variant: "primary" })} disabled={busy}>
                {busy ? "Creating" : "Create draft"}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </>
  );
}
