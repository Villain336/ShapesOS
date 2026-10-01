// Marketr — Wave 2 context.dev slice 2: knowledge page (server).
// House style per StudioApp.tsx / corpus page (diffed class-by-class).

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { listSources } from "@/lib/knowledge/contextdev/sources";
import { listCrawlJobs } from "@/lib/knowledge/contextdev/crawl";
import { KnowledgeClient } from "./KnowledgeClient";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Knowledge sources — Marketr",
  description:
    "Context.dev web sources: register pages, sitemaps, and brand profiles; crawl them into a provenance-ledgered knowledge base for RAG.",
};

export default async function KnowledgePage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "viewer");
  if (!membership) redirect("/dashboard");
  const canEdit = membership.role !== "viewer";

  const [sources, jobs] = await Promise.all([
    listSources(workspace.id),
    listCrawlJobs(workspace.id),
  ]);

  return (
    <div className="flex h-full flex-col gap-4 bg-[#FAFAF7] p-4 md:p-6">
      <div>
        <h1 className="text-xl font-bold tracking-tight text-stone-900">Knowledge sources</h1>
        <p className="mt-0.5 max-w-2xl text-[13px] text-stone-500">
          Crawl the web into Marketr&apos;s knowledge base with Context.dev. Your
          own domains activate instantly; third-party domains need one approval,
          then crawl freely. Every chunk keeps its source URL and fetch time.
        </p>
      </div>
      <KnowledgeClient
        initialSources={JSON.parse(JSON.stringify(sources))}
        initialJobs={JSON.parse(JSON.stringify(jobs))}
        canEdit={canEdit}
      />
    </div>
  );
}
