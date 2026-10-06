// ShapesOS Phase 10 (ops-core) — Operations home layout: header + section
// sub-nav. The ops apps used to be tabs inside the CRM page; they live here
// now (the CRM keeps leads, contacts, deals, pipeline, forecast and forms).

import { SectionNav } from "../_components/SectionNav";
import { OPS_SECTIONS } from "@/lib/ops/sections";

const NAV = OPS_SECTIONS.map(({ href, label, icon }) => ({ href, label, icon }));

export default function OpsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col bg-canvas">
      <div className="border-b border-line bg-paper px-5 pt-4">
        <p className="text-[0.75rem] font-medium text-subtle">ShapesOS · Operations</p>
        <h1 className="aos-heading mt-0.5">Operations</h1>
        <div className="mt-3">
          <SectionNav items={NAV} ariaLabel="Operations sections" />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
    </div>
  );
}
