// ShapesOS — Phase 10 (finance): Accounting section navigation (pills).

import { BookOpen, ListTree, PieChart, Settings2 } from "lucide-react";
import { SectionNav } from "./kit";

export const ACCOUNTING_BASE = "/dashboard/ops/accounting";

export function AccountingNav({ current }: { current: "accounts" | "journal" | "reports" | "settings" }) {
  const items = [
    { key: "accounts", href: ACCOUNTING_BASE, label: "Accounts", icon: <ListTree size={14} aria-hidden /> },
    { key: "journal", href: `${ACCOUNTING_BASE}/journal`, label: "Journal", icon: <BookOpen size={14} aria-hidden /> },
    { key: "reports", href: `${ACCOUNTING_BASE}/reports`, label: "Reports", icon: <PieChart size={14} aria-hidden /> },
    { key: "settings", href: `${ACCOUNTING_BASE}/settings`, label: "Settings", icon: <Settings2 size={14} aria-hidden /> },
  ];
  return <SectionNav items={items} current={items.find((i) => i.key === current)!.href} />;
}
