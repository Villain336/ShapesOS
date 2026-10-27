// ShapesOS — Phase 23: Univer styles for the public shared-doc page.
// The dashboard Office layout ships this CSS only under /dashboard/office,
// so the public /o/<token> route needs its own copy (screenshot showed the
// embed rendering unstyled without it).

import "@univerjs/preset-sheets-core/lib/index.css";

export default function SharedDocLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
