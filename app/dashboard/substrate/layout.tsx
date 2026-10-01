// Marketr — Phase 8: substrate section layout.
// Shared sub-tab nav across the three substrate tracks: Business Graph (G1),
// Campaign object (G2), Growth Memory (G3). House pattern (Creative Studio):
// bg-canvas page shell, violet icon tabs.

import { SubstrateNavTabs } from "./tabs";

export default function SubstrateLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col gap-4 bg-canvas p-4 md:p-6">
      <SubstrateNavTabs />
      {children}
    </div>
  );
}
