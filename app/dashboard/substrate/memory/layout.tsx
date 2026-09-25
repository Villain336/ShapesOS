// Marketr — Phase 8 G3: Growth Memory section layout.
// House pattern (Creative Studio): violet icon sub-tabs, light mode.

import { MemoryTabs } from "../tabs";

export default function MemoryLayout({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <MemoryTabs />
      {children}
    </div>
  );
}
