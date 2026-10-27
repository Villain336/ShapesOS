"use client";

// ShapesOS — read-only Univer mount for a publicly shared doc (Phase 23).
// Reuses the Office embed with no onSave: no save affordance renders and no
// edit can persist (there is no write route behind the public page).

import dynamic from "next/dynamic";

const UniverEmbed = dynamic(() => import("./UniverEmbed"), { ssr: false });

export default function SharedDocEmbed({ kind, snapshot }: { kind: string; snapshot: unknown }) {
  return <UniverEmbed kind={kind as "sheet" | "doc" | "slide"} snapshot={snapshot} onSave={undefined} />;
}
