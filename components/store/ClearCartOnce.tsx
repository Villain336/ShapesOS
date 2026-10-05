"use client";

// ShapesOS — Phase 10 (store): after a paid checkout, empty the buyer's
// cart once (the cookie is HttpOnly, so the cart API clears it).

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

export function ClearCartOnce({ storeSlug }: { storeSlug: string }) {
  const router = useRouter();
  const done = useRef(false);
  useEffect(() => {
    if (done.current) return;
    done.current = true;
    void fetch(`/api/shop/${encodeURIComponent(storeSlug)}/cart`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "clear" }),
    })
      .then(() => router.refresh())
      .catch(() => undefined);
  }, [storeSlug, router]);
  return null;
}
