// Marketr — Listings: connect-channel button (client).
// The tier is authoritative server-side; this only triggers the connect call.

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/vault/shadcn/button";
import { Plug } from "lucide-react";

export default function ConnectChannelButton({ channel }: { channel: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function connect() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/authority/listings/channels/${channel}/connect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: {} }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Connect failed");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <Button size="sm" variant="outline" onClick={connect} disabled={busy}>
        <Plug className="mr-1.5 h-3.5 w-3.5" />
        {busy ? "Connecting…" : "Connect"}
      </Button>
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}
