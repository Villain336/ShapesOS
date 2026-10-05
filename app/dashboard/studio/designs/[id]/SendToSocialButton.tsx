// ShapesOS — Studio → social (Phase 4b). Renders the saved design to PNG,
// creates a social post draft with it attached and opens it in Social.
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Share2 } from "lucide-react";
import { confirmAction, toastError } from "@/lib/ui/feedback";

export function SendToSocialButton({ designId }: { designId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const send = async () => {
    const ok = await confirmAction({
      title: "Send this design to social?",
      description: "The last saved version is exported as an image and opens as a post draft. Nothing is published until the post is approved.",
      confirmLabel: "Create post draft",
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/studio/designs/${encodeURIComponent(designId)}/send-to-social`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const data = (await res.json().catch(() => ({}))) as { href?: string; error?: string };
      if (!res.ok || !data.href) throw new Error(data.error ?? "Export failed.");
      router.push(data.href);
    } catch (e) {
      toastError("Couldn't send the design to social.", e instanceof Error ? e.message : undefined);
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      onClick={() => void send()}
      disabled={busy}
      className="inline-flex h-control-sm cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-full bg-paper px-3 text-sm font-semibold text-ink shadow-outline aos-press hover:bg-hover-paper focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--aos-focus-halo)] disabled:opacity-40"
    >
      {busy ? <Loader2 className="h-4 w-4 aos-spin" /> : <Share2 className="h-4 w-4" />}
      {busy ? "Exporting" : "Send to social"}
    </button>
  );
}
