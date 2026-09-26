// Marketr — Media command center: seed the default v1 kill-rule pack.

"use client";

import { useState } from "react";
import { Button } from "@/components/vault/shadcn/button";

export default function SeedRulesButton({
  mediaRole,
  hasRules,
}: {
  mediaRole: string;
  hasRules: boolean;
}) {
  const [busy, setBusy] = useState(false);
  if (mediaRole !== "owner") return null;

  async function seed() {
    setBusy(true);
    try {
      const res = await fetch("/api/media/kill-rules", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error("Seed failed");
      window.location.reload();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={seed}
      disabled={busy}
      className="inline-flex items-center gap-1.5 rounded-md border border-stone-200 bg-white px-2.5 py-1.5 text-[13px] text-stone-700 hover:bg-stone-50 disabled:opacity-40"
    >
      {busy ? "Seeding…" : hasRules ? "Re-seed default pack" : "Seed default v1 pack"}
    </Button>
  );
}
