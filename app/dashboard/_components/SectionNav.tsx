// Marketr — shared dashboard section sub-nav (client).
// Agentic OS pill tabs with a Lucide icon + label; the current page is a
// solid ink pill (aria-current="page"). Icon mapping lives here so
// server layouts only pass serializable href/label/icon keys.

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Mail,
  Newspaper,
  MapPin,
  Sparkles,
  Star,
  Brain,
  ArrowLeftRight,
  Recycle,
  FlaskConical,
  Tv,
  Radio,
  Rocket,
  // Phase 10 (ops-core): /dashboard/ops section icons.
  ShoppingCart,
  CreditCard,
  TicketPercent,
  ReceiptText,
  Boxes,
  Truck,
  FolderKanban,
  LifeBuoy,
  UserRound,
  Workflow,
  Landmark,
  FileText,
  Store,
  Receipt,
  // Phase 10 (store)
  ShoppingBag,
  // Phase 12 (mfgpos)
  Factory,
  Calculator,
  // Phase 12 (people)
  Banknote,
  CalendarDays,
  // Phase 13 (twin)
  Map as MapIcon,
  type LucideIcon,
} from "lucide-react";

const ICONS: Record<string, LucideIcon> = {
  overview: LayoutDashboard,
  outreach: Mail,
  pr: Newspaper,
  listings: MapPin,
  aeo: Sparkles,
  reviews: Star,
  intelligence: Brain,
  reallocation: ArrowLeftRight,
  recycling: Recycle,
  tests: FlaskConical,
  ctv: Tv,
  dsp: Radio,
  launch: Rocket,
  // Phase 10 (ops-core)
  orders: ShoppingCart,
  payments: CreditCard,
  promotions: TicketPercent,
  invoices: ReceiptText,
  inventory: Boxes,
  purchasing: Truck,
  projects: FolderKanban,
  helpdesk: LifeBuoy,
  team: UserRound,
  workflows: Workflow,
  accounting: Landmark,
  quotes: FileText,
  vendors: Store,
  expenses: Receipt,
  // Phase 10 (store)
  store: ShoppingBag,
  // Phase 12 (mfgpos)
  manufacturing: Factory,
  pos: Calculator,
  // Phase 12 (people)
  payroll: Banknote,
  events: CalendarDays,
  // Phase 13 (twin)
  twin: MapIcon,
};

export interface SectionNavItem {
  href: string;
  label: string;
  icon: string;
}

export function SectionNav({ items, ariaLabel }: { items: SectionNavItem[]; ariaLabel: string }) {
  const pathname = usePathname();
  return (
    <nav className="mb-4 flex flex-wrap gap-1" aria-label={ariaLabel}>
      {items.map((n) => {
        const active = pathname === n.href;
        const Icon = ICONS[n.icon] ?? LayoutDashboard;
        return (
          <Link
            key={n.href}
            href={n.href}
            aria-current={active ? "page" : undefined}
            className={`flex h-8 items-center gap-1.5 whitespace-nowrap rounded-full px-3 text-[13px] font-semibold transition-colors ${
              active
                ? "bg-ink text-paper"
                : "text-muted hover:bg-hover hover:text-ink"
            }`}
          >
            <Icon size={15} />
            {n.label}
          </Link>
        );
      })}
    </nav>
  );
}
