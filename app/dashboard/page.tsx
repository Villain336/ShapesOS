// Marketr — dashboard home: workspace summary + project list + create form.

import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { providerStatus } from "@/lib/providers";
import ProjectCreateForm from "@/components/ProjectCreateForm";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const user = await requireUser();
  if (!user) return null; // layout already redirects

  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const projects = await prisma.project.findMany({
    where: { workspaceId: workspace.id },
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { keywords: true } } },
  });
  const provider = providerStatus();

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{workspace.name}</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Plan: <span className="font-mono">{workspace.plan}</span> · Data
          provider:{" "}
          <span
            className={
              provider.isLive ? "text-emerald-600" : "text-amber-700"
            }
          >
            {provider.isLive
              ? "DataForSEO (live)"
              : "Mock — add DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD to .env for live data"}
          </span>
        </p>
      </div>

      <ProjectCreateForm />

      <div>
        <h2 className="mb-3 text-sm font-medium uppercase tracking-widest text-zinc-500">
          Projects
        </h2>
        {projects.length === 0 ? (
          <p className="rounded-xl border border-dashed border-zinc-200 p-8 text-center text-sm text-zinc-500">
            No projects yet. Add a domain above to start keyword research.
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {projects.map((p) => (
              <li key={p.id}>
                <Link
                  href={`/dashboard/projects/${p.id}`}
                  className="flex items-center justify-between rounded-xl border border-zinc-200 bg-white/60 px-5 py-4 hover:border-zinc-300"
                >
                  <span>
                    <span className="block font-medium">{p.domain}</span>
                    <span className="text-sm text-zinc-500">
                      {p._count.keywords} keywords saved · {p.locale}
                    </span>
                  </span>
                  <span className="text-sm text-zinc-500">Open →</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
