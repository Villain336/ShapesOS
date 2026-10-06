"use client";

// ShapesOS — Phase 18.1 (WS=find): save this device's time zone once.
//
// A person who never chose a time zone (UserPreference.timeZone is NULL) gets
// the zone their browser reports, saved the first time they open the
// dashboard, then the page re-renders server-side in that zone. They can
// change it any time in Settings → You → Language and region; once set,
// this does nothing.

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export function TimeZoneSync({ needed }: { needed: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!needed) return;
    let zone: string | undefined;
    try {
      zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      return;
    }
    if (!zone) return;
    void fetch("/api/preferences", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ timeZone: zone }),
    })
      .then((res) => {
        if (res.ok) router.refresh();
      })
      .catch(() => {
        // best effort: dates stay in UTC until the next visit
      });
  }, [needed, router]);
  return null;
}
