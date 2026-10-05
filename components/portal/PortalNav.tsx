"use client";

// ShapesOS — Phase 10 (portal): section navigation. Pills: the current page
// is solid black with white text (DESIGN.md "pressed" chip), the rest quiet.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { FileText, Files, FolderKanban, LayoutGrid, LifeBuoy, ReceiptText, type LucideIcon } from "lucide-react";

const ITEMS: Record<string, { label: string; icon: LucideIcon }> = {
  projects: { label: "Projects", icon: FolderKanban },
  invoices: { label: "Invoices", icon: ReceiptText },
  quotes: { label: "Quotes", icon: FileText },
  tickets: { label: "Tickets", icon: LifeBuoy },
  documents: { label: "Documents", icon: Files },
};

export function PortalNav({ sections }: { sections: string[] }) {
  const pathname = usePathname() ?? "/portal";
  const items = [{ href: "/portal", label: "Overview", icon: LayoutGrid }, ...sections.filter((s) => ITEMS[s]).map((s) => ({ href: `/portal/${s}`, ...ITEMS[s]! }))];
  return (
    <nav aria-label="Client portal" className="flex flex-wrap gap-1.5">
      {items.map(({ href, label, icon: Icon }) => {
        const current = href === "/portal" ? pathname === "/portal" : pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link
            key={href}
            href={href}
            aria-current={current ? "page" : undefined}
            className={`inline-flex h-chip items-center gap-1.5 rounded-full px-3.5 text-sm font-semibold ${
              current ? "bg-ink text-white" : "bg-paper text-ink shadow-control hover:bg-hover-paper"
            }`}
          >
            <Icon size={15} aria-hidden />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
