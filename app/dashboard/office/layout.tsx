// Marketr — Phase 14: Office docs surface CSS (Univer editor styles).
// Imported here (route layout) so the editor CSS only ships on /dashboard/office
// and its children — not on every dashboard page.

import "@univerjs/preset-sheets-core/lib/index.css";

export default function OfficeLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
