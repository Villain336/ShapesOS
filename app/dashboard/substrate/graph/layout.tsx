// Marketr — Phase 8 G1: Business Graph section layout.
// House pattern (Creative Studio): violet icon sub-tabs, light mode.

import { GraphTabs } from "../tabs";

export default function GraphLayout({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <GraphTabs />
      {children}
    </div>
  );
}
