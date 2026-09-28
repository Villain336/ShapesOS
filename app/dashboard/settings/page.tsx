// Marketr — workspace settings landing (Phase 13, A1).
// This page kills the /dashboard/settings 404: the command-bar ⌥6 shortcut
// and the dashboard's new-user "Connect data" CTA both land here.
// It also unifies the two settings navs — the 16-tab SettingsNav island plus
// the sidebar's separate Settings island (alert rules, brand kits) — into one
// tab strip covering all 17 subpages, with a section index below.

import Link from "next/link";
import { redirect } from "next/navigation";
import {
  Bell,
  Bot,
  Brain,
  Cloud,
  FlaskConical,
  Gauge,
  Globe,
  Lock,
  Mail,
  Palette,
  PenLine,
  Plug,
  Scale,
  ScrollText,
  Shield,
  SlidersHorizontal,
  Terminal,
  Users,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import SettingsNav from "@/components/settings/SettingsNav";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Settings — Marketr",
  description: "Workspace settings: integrations, team, automation, and compliance.",
};

const SECTIONS: { href: string; label: string; description: string; icon: LucideIcon }[] = [
  { href: "/dashboard/settings/skills", label: "Skills", description: "Install skills that teach Marketr how your team works.", icon: Wrench },
  { href: "/dashboard/settings/connectors", label: "Connectors", description: "Connect data sources once; credentials live in the vault.", icon: Plug },
  { href: "/dashboard/settings/mail", label: "Direct Mail", description: "Senders, postage, and mail defaults.", icon: Mail },
  { href: "/dashboard/settings/media", label: "Media safety", description: "Spend guardrails, approvals, and kill switches.", icon: Shield },
  { href: "/dashboard/settings/members", label: "Members", description: "Invite teammates and control what they can do.", icon: Users },
  { href: "/dashboard/settings/providers", label: "Providers", description: "Which external providers Marketr is using.", icon: Cloud },
  { href: "/dashboard/settings/governance", label: "Governance", description: "Retention and sharing defaults, inherited by every project.", icon: Scale },
  { href: "/dashboard/settings/automation", label: "Automation", description: "What Marketr may do on its own, what asks first, and what never runs.", icon: Bot },
  // Phase 13B: agent learning + company intelligence — the "what I've learned"
  // surface, preference profile, and the five personas.
  { href: "/dashboard/settings/agents", label: "Agents", description: "What Marketr's agents have learned — lessons, preferences, personas.", icon: Brain },
  { href: "/dashboard/settings/experiments", label: "Experiments", description: "Feature flags and growth experiments.", icon: FlaskConical },
  { href: "/dashboard/settings/signing", label: "Signing", description: "Document signing requests and status.", icon: PenLine },
  { href: "/dashboard/settings/security", label: "Security", description: "Authentication, SSO, and secret-storage posture.", icon: Lock },
  { href: "/dashboard/settings/notifications", label: "Notifications", description: "Workspace-wide notification defaults.", icon: Bell },
  { href: "/dashboard/settings/defaults", label: "Defaults", description: "The baseline every project inherits: model, locale, tone.", icon: SlidersHorizontal },
  { href: "/dashboard/settings/api-mcp", label: "API / MCP", description: "Expose this workspace to MCP clients.", icon: Terminal },
  { href: "/dashboard/settings/audit", label: "Audit log", description: "Every consequential action, who did it, and when.", icon: ScrollText },
  { href: "/dashboard/settings/usage", label: "Usage", description: "Credit usage this period, by action and by project.", icon: Gauge },
  { href: "/dashboard/settings/alerts", label: "Alert rules", description: "Rules that watch for rank drops, AI Overview changes, and run completions.", icon: SlidersHorizontal },
  { href: "/dashboard/settings/brand-kits", label: "Brand kits", description: "White-label identity for client reports — logo, colors, fonts, tone.", icon: Palette },
  { href: "/dashboard/settings/white-label", label: "White-label", description: "Client-facing identity for public pages — logo, custom domain, and brand color.", icon: Globe },
];

export default async function SettingsLandingPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);

  return (
    <div className="bg-[#FAFAF7] p-4 md:p-6">
      <div className="mx-auto flex max-w-5xl flex-col gap-6">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-stone-900">Settings</h1>
          <p className="mt-0.5 text-[13px] text-stone-500">
            {workspace.name} — every workspace setting in one place. Pick a section below.
          </p>
        </div>
        <SettingsNav />
        <nav aria-label="All settings sections">
          <ul className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
            {SECTIONS.map((s) => {
              const Icon = s.icon;
              return (
                <li key={s.href}>
                  <Link
                    href={s.href}
                    className="group flex items-start gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-[var(--brand-50)]"
                  >
                    <Icon
                      size={16}
                      className="mt-0.5 shrink-0 text-stone-400 transition-colors group-hover:text-[var(--brand-700)]"
                      aria-hidden
                    />
                    <span className="min-w-0">
                      <span className="block text-[13.5px] font-medium text-stone-800 transition-colors group-hover:text-[var(--brand-700)]">
                        {s.label}
                      </span>
                      <span className="block text-[12.5px] leading-snug text-stone-500">
                        {s.description}
                      </span>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      </div>
    </div>
  );
}
