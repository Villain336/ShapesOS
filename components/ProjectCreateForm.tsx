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
      className="flex flex-col gap-3 rounded-xl border border-zinc-800 bg-zinc-900/60 p-5 sm:flex-row sm:items-end"
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
          className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none"
        />
      </div>
      <button
        type="submit"
        disabled={busy}
        className="rounded-md bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-950 hover:bg-white disabled:opacity-50"
      >
        {busy ? "Creating…" : "Add domain"}
      </button>
      {error && <p className="text-sm text-red-400 sm:basis-full">{error}</p>}
    </form>
  );
}
