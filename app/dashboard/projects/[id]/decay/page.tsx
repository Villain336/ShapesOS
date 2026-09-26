// Marketr — content decay dashboard (milestone 14).
// Server page rendering open findings; DecayActions is the client island for
// the "create brief" / "dismiss" actions (editor+).

import { accessibleWorkspaceWhere } from "@/lib/authz";
import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { PartyPopper } from "lucide-react";
import DecayActions from "@/components/DecayActions";

export const dynamic = "force-dynamic";

const SEVERITY_STYLE: Record<string, string> = {
  critical: "bg-red-500/15 text-red-700 border-red-200/30",
  warn: "bg-amber-500/15 text-amber-700 border-amber-200/30",
  info: "bg-zinc-500/15 text-zinc-500 border-zinc-200",
};

const ACTION_LABEL: Record<string, string> = {
  refresh_content: "Refresh content",
  rebuild: "Rebuild page",
  internal_links: "Add internal links",
};

export default async function DecayPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return null;
  const { id } = await params;
  const project = await prisma.project.findFirst({
    where: { id, workspace: accessibleWorkspaceWhere(user.id) },
  });
  if (!project) notFound();

  const [open, resolved] = await Promise.all([
    prisma.contentDecayFinding.findMany({
      where: { projectId: project.id, status: "open" },
      orderBy: [{ decayScore: "desc" }, { detectedAt: "desc" }],
    }),
    prisma.contentDecayFinding.count({
      where: { projectId: project.id, status: { in: ["actioned", "dismissed"] } },
    }),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href={`/dashboard/projects/${project.id}`} className="text-sm text-zinc-500 hover:text-zinc-600">
          ← {project.domain}
        </Link>
        <h1 className="mt-1 text-xl font-bold tracking-tight text-ink">Content decay</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Pages whose rankings slipped over the last 90 days. Create a refresh brief to feed the content engine,
          or dismiss findings you&apos;ve handled. {resolved > 0 && `${resolved} resolved.`}
        </p>
      </div>

      {open.length === 0 ? (
        <div className="rounded-lg border border-zinc-300 bg-white p-8 text-center">
          <PartyPopper className="mx-auto h-6 w-6 text-stone-400" />
          <p className="mt-2 text-sm text-zinc-500">
            No decaying pages right now. Detection runs weekly — it needs at least two rank checks in the last 90 days.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {open.map((f) => (
            <div key={f.id} className="rounded-lg border border-zinc-300 bg-white p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <span className={`rounded border px-2 py-0.5 text-xs font-medium ${SEVERITY_STYLE[f.severity] ?? SEVERITY_STYLE.info}`}>
                      {f.severity} · {Math.round(f.decayScore)}/100
                    </span>
                    <span className="text-sm font-medium">{ACTION_LABEL[f.suggestedAction] ?? f.suggestedAction}</span>
                  </div>
                  <p className="mt-2 font-mono text-sm text-zinc-800">{f.url ?? "(page no longer ranking)"}</p>
                  <p className="mt-1 text-sm text-zinc-500">
                    {f.phrases.slice(0, 4).join(", ")}
                    {f.phrases.length > 4 ? ` +${f.phrases.length - 4} more` : ""}
                  </p>
                  <p className="mt-1 text-xs text-zinc-500">
                    Peak #{f.peakPosition ?? "–"} → now {f.currentPosition != null ? `#${f.currentPosition}` : "out of top 100"}
                    {" · "}detected {f.detectedAt.toISOString().slice(0, 10)}
                  </p>
                </div>
                <DecayActions projectId={project.id} findingId={f.id} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
