"use client";

// Marketr — new-project form (dashboard).

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

export default function ProjectCreateForm() {
  const router = useRouter();
  const [domain, setDomain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? "Could not create project.");
        return;
      }
      setDomain("");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      className="flex flex-col gap-3 rounded-xl border border-zinc-200 bg-white/60 p-5 sm:flex-row sm:items-end"
    >
      <div className="flex-1">
        <label
          htmlFor="domain"
          className="mb-1 block text-xs font-medium uppercase tracking-widest text-zinc-500"
        >
          New project
        </label>
        <input
          id="domain"
          required
          placeholder="example.com"
          value={domain}
          onChange={(e) => setDomain(e.target.value)}
          className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-orange-500 focus:outline-none"
        />
      </div>
      <button
        type="submit"
        disabled={busy}
        className="rounded-md bg-orange-600 px-4 py-2 text-sm font-medium text-white hover:bg-orange-700 disabled:opacity-50 active:scale-[0.96] transition-[background-color,transform] duration-150 ease-[cubic-bezier(0.2,0,0,1)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 focus-visible:ring-offset-2"
      >
        {busy ? "Creating…" : "Add domain"}
      </button>
      {error && <p className="text-sm text-red-600 sm:basis-full">{error}</p>}
    </form>
  );
}
