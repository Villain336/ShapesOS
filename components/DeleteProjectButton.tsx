"use client";

// Marketr — delete-project button with a confirm step.

import { useRouter } from "next/navigation";
import { useState } from "react";

export default function DeleteProjectButton({
  projectId,
}: {
  projectId: string;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  async function onDelete() {
    setBusy(true);
    try {
      const res = await fetch(`/api/projects/${projectId}`, {
        method: "DELETE",
      });
      if (res.ok) router.push("/dashboard");
    } finally {
      setBusy(false);
    }
  }

  if (!confirming) {
    return (
      <button
        onClick={() => setConfirming(true)}
        className="rounded-md border border-red-900 px-3 py-1.5 text-sm text-red-400 hover:bg-red-950"
      >
        Delete project
      </button>
    );
  }

  return (
    <span className="flex items-center gap-2 text-sm">
      <span className="text-zinc-400">Are you sure?</span>
      <button
        onClick={onDelete}
        disabled={busy}
        className="rounded-md bg-red-600 px-3 py-1.5 text-white hover:bg-red-500 disabled:opacity-50"
      >
        {busy ? "Deleting…" : "Yes, delete"}
      </button>
      <button
        onClick={() => setConfirming(false)}
        className="rounded-md border border-zinc-700 px-3 py-1.5 text-zinc-300 hover:bg-zinc-800"
      >
        Cancel
      </button>
    </span>
  );
}
