// ShapesOS — Phase 18.1 (WS=find): the nav in the person's language.
//
// lib/nav/config.ts stays the single source of destinations (English labels
// are the source text); this overlays the active catalogue's labels,
// descriptions and group titles. The English words are kept in `keywords`,
// so ⌘K still finds "Files" while the menu says "Archivos". Pure.

import type { Catalogue } from "@/lib/i18n";
import { navText } from "@/lib/i18n";
import type { NavGroup } from "./config";

export function localizeNavGroups(groups: NavGroup[], messages: Catalogue): NavGroup[] {
  const titles = messages.nav.groups as Record<string, string | undefined>;
  return groups.map((g) => ({
    ...g,
    title: g.title ? (titles[g.id] ?? g.title) : g.title,
    items: g.items.map((item) => {
      const m = navText(messages, item.href);
      const label = m.label ?? item.label;
      const description = m.description ?? item.description;
      const english = label === item.label ? "" : `${item.label} ${item.description}`;
      return {
        ...item,
        label,
        description,
        keywords: [item.keywords ?? "", english].filter(Boolean).join(" ") || undefined,
      };
    }),
  }));
}
