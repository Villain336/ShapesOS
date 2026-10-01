// Marketr — Settings → Brand → Intelligence (Phase 13B, worker 5).
// The company intelligence layer: Brand Voice profile (with "review pending
// updates" diffs from the learner), knowledge graph editor, style rules
// manager, content history. Pin/lock controls per element. Sub-tabs
// [Brand Voice | Knowledge | Style Rules | Content] in the house pattern.

import Link from "next/link";
import { redirect } from "next/navigation";
import { BookOpen, FileText, Megaphone, SlidersHorizontal } from "lucide-react";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import SettingsNav from "@/components/settings/SettingsNav";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import VoiceTab from "./voice-tab";
import KnowledgeTab from "./knowledge-tab";
import StyleRulesTab from "./style-rules-tab";
import ContentTab from "./content-tab";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Brand Intelligence — Settings — Marketr",
  description: "The living company intelligence layer: brand voice, knowledge, style rules, content memory.",
};

const TABS = [
  { id: "voice", label: "Brand Voice", icon: Megaphone },
  { id: "knowledge", label: "Knowledge", icon: BookOpen },
  { id: "rules", label: "Style Rules", icon: SlidersHorizontal },
  { id: "content", label: "Content", icon: FileText },
] as const;

type TabId = (typeof TABS)[number]["id"];

export default async function BrandIntelligencePage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const canEdit = (await requireWorkspaceRole(user.id, workspace.id, "editor")) !== null;

  const sp = await searchParams;
  const tab: TabId = (["voice", "knowledge", "rules", "content"] as const).includes(
    sp.tab as TabId,
  )
    ? (sp.tab as TabId)
    : "voice";

  const [voice, knowledge, rules, content] = await Promise.all([
    withWorkspaceScope(workspace.id, (tx) =>
      tx.brandVoiceProfile.findUnique({ where: { workspaceId: workspace.id } }),
    ),
    withWorkspaceScope(workspace.id, (tx) =>
      tx.companyKnowledge.findMany({
        where: { workspaceId: workspace.id },
        orderBy: [{ kind: "asc" }, { updatedAt: "desc" }],
      }),
    ),
    withWorkspaceScope(workspace.id, (tx) =>
      tx.styleRule.findMany({
        where: { workspaceId: workspace.id },
        orderBy: [{ severity: "asc" }, { updatedAt: "desc" }],
      }),
    ),
    withWorkspaceScope(workspace.id, (tx) =>
      tx.contentRecord.findMany({
        where: { workspaceId: workspace.id },
        orderBy: { createdAt: "desc" },
        take: 200,
      }),
    ),
  ]);

  return (
    <div className="bg-canvas p-4 md:p-6">
      <div className="mx-auto flex max-w-5xl flex-col gap-6">
        <div>
          <h1 className="aos-heading">Brand Intelligence</h1>
          <p className="mt-0.5 text-sm text-muted">
            {workspace.name} — the living model of your business. The learning loop refines it from every
            interaction; pin anything the learner must not touch.
          </p>
        </div>
        <SettingsNav />
        <nav aria-label="Intelligence sections" className="flex flex-wrap gap-1 border-b border-line">
          {TABS.map((t) => {
            const active = tab === t.id;
            const Icon = t.icon;
            return (
              <Link
                key={t.id}
                href={`/dashboard/settings/brand/intelligence?tab=${t.id}`}
                aria-current={active ? "page" : undefined}
                className={`flex items-center gap-1.5 border-b-2 px-3 py-2 text-[13.5px] font-medium transition ${
                  active
                    ? "border-ink text-ink"
                    : "border-transparent text-muted hover:text-ink"
                }`}
              >
                <Icon size={15} />
                {t.label}
              </Link>
            );
          })}
        </nav>

        {tab === "voice" && (
          <VoiceTab
            workspaceId={workspace.id}
            profile={
              voice
                ? {
                    dimensions: (voice.dimensions ?? {}) as Record<string, unknown>,
                    derivedFrom: (voice.derivedFrom ?? {}) as Record<string, unknown>,
                    confidence: voice.confidence,
                    pinnedByUser: voice.pinnedByUser,
                    pendingUpdates: (voice.pendingUpdates ?? null) as Record<string, unknown> | null,
                    updatedAt: voice.updatedAt.toISOString(),
                  }
                : null
            }
            canEdit={canEdit}
          />
        )}
        {tab === "knowledge" && (
          <KnowledgeTab
            workspaceId={workspace.id}
            entries={knowledge.map((k) => ({
              id: k.id,
              kind: k.kind,
              title: k.title,
              body: (k.body ?? {}) as Record<string, unknown>,
              confidence: k.confidence,
              pinned: k.pinned,
              updatedAt: k.updatedAt.toISOString(),
            }))}
            canEdit={canEdit}
          />
        )}
        {tab === "rules" && (
          <StyleRulesTab
            workspaceId={workspace.id}
            rules={rules.map((r) => ({
              id: r.id,
              kind: r.kind,
              pattern: r.pattern,
              replacement: r.replacement,
              severity: r.severity,
              pinned: r.pinned,
              active: r.active,
              source: r.source,
              updatedAt: r.updatedAt.toISOString(),
            }))}
            canEdit={canEdit}
          />
        )}
        {tab === "content" && (
          <ContentTab
            workspaceId={workspace.id}
            records={content.map((c) => ({
              id: c.id,
              kind: c.kind,
              title: c.title,
              angle: c.angle,
              channel: c.channel,
              performance: (c.performance ?? null) as Record<string, unknown> | null,
              createdAt: c.createdAt.toISOString(),
            }))}
          />
        )}
      </div>
    </div>
  );
}
