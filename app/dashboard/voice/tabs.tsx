// Marketr — Phase 13D: voice section sub-tab nav.
// Exact pattern from Creative Studio (StudioApp.tsx) + substrate tabs:
// icon + label, ACTIVE = border-ink text-ink.
// Never hardcode primary colors — brand vars only (docs/audit/THEMING.md).
//
// Nav configs MUST live in this client module (server components cannot
// pass icon component references across the client boundary).

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { LucideIcon } from "lucide-react";
import {
  Bot,
  PhoneCall,
  ScrollText,
  ShieldCheck,
  Mic,
  BookOpenText,
} from "lucide-react";

interface VoiceTab {
  href: string;
  label: string;
  icon: LucideIcon;
}

const defaultActive = (href: string) => (p: string) =>
  p === href || p.startsWith(href + "/");

export function VoiceNavTabs() {
  const pathname = usePathname();
  // Worker B (voiceovers) owns "Voiceover Studio" + "Pronunciation".
  // Worker A (lead follow-up) owns Agents / Sessions / Scripts / Consent.
  const items: VoiceTab[] = [
    { href: "/dashboard/voice", label: "Agents", icon: Bot },
    { href: "/dashboard/voice/sessions", label: "Sessions", icon: PhoneCall },
    { href: "/dashboard/voice/scripts", label: "Scripts", icon: ScrollText },
    { href: "/dashboard/voice/consent", label: "Consent", icon: ShieldCheck },
    { href: "/dashboard/voice/studio", label: "Voiceover Studio", icon: Mic },
    {
      href: "/dashboard/voice/pronunciation",
      label: "Pronunciation",
      icon: BookOpenText,
    },
  ];
  return (
    <div
      className="flex flex-wrap gap-1 border-b border-line"
      role="navigation"
      aria-label="Voice sections"
    >
      {items.map(({ href, label, icon: Icon }) => {
        const active = defaultActive(href)(pathname);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={`flex items-center gap-1.5 border-b-2 px-3 py-2 text-[0.84375rem] font-medium transition ${
              active
                ? "border-ink text-ink"
                : "border-transparent text-muted hover:text-ink"
            }`}
          >
            <Icon size={15} />
            {label}
          </Link>
        );
      })}
    </div>
  );
}
