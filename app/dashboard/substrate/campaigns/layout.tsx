// Marketr — Phase 8 G2 campaign object section layout.
// House pattern (Creative Studio): violet icon sub-tabs, light mode.

import { CampaignTabs } from "../tabs";

export default function CampaignsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <CampaignTabs />
      {children}
    </div>
  );
}
