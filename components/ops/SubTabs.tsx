// ShapesOS Phase 10 (ops-core) — in-page sub-tabs (Lucide icon + label,
// ink underline: the same tabCls atom the CRM header uses). The active tab
// is mirrored to ?view= so links and reloads land on the same view.

"use client";

import { useEffect, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { tabCls } from "@/components/crm/ui";

export interface SubTab {
  id: string;
  label: string;
  icon: LucideIcon;
  render: () => React.ReactNode;
}

export function SubTabs({ tabs, ariaLabel }: { tabs: SubTab[]; ariaLabel: string }) {
  const [active, setActive] = useState(tabs[0]!.id);
  useEffect(() => {
    const v = new URLSearchParams(window.location.search).get("view");
    if (v && tabs.some((t) => t.id === v)) setActive(v);
  }, [tabs]);
  const pick = (id: string) => {
    setActive(id);
    const url = new URL(window.location.href);
    url.searchParams.set("view", id);
    window.history.replaceState(null, "", url.toString());
  };
  const current = tabs.find((t) => t.id === active) ?? tabs[0]!;
  return (
    <div className="flex flex-col gap-4">
      <nav className="flex flex-wrap gap-4 border-b border-line" aria-label={ariaLabel} role="tablist">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={t.id === current.id}
            className={tabCls(t.id === current.id)}
            onClick={() => pick(t.id)}
          >
            <t.icon size={15} />
            {t.label}
          </button>
        ))}
      </nav>
      <div role="tabpanel">{current.render()}</div>
    </div>
  );
}
