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

// Decay severities are scan results, not agent states — neutral chips.
const SEVERITY_STYLE: Record<string, string> = {
  critical: "bg-paper text-muted shadow-control",
  warn: "bg-paper text-muted shadow-control",
  info: "bg-paper text-muted shadow-control",
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
        <Link href={`/dashboard/projects/${project.id}`} className="text-sm text-muted hover:text-ink">
          ← {project.domain}
        </Link>
        <h1 className="mt-1 text-xl font-bold tracking-tight text-ink">Content decay</h1>
        <p className="mt-1 text-sm text-muted">
          Pages whose rankings slipped over the last 90 days. Create a refresh brief to feed the content engine,
          or dismiss findings you&apos;ve handled. {resolved > 0 && `${resolved} resolved.`}
        </p>
      </div>

      {open.length === 0 ? (
        <div className="rounded-lg border border-line bg-paper p-8 text-center">
          <PartyPopper className="mx-auto h-6 w-6 text-subtle" />
          <p className="mt-2 text-sm text-muted">
            No decaying pages right now. Detection runs weekly — it needs at least two rank checks in the last 90 days.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {open.map((f) => (
            <div key={f.id} className="rounded-lg border border-line bg-paper p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <span className={`rounded border px-2 py-0.5 text-xs font-medium ${SEVERITY_STYLE[f.severity] ?? SEVERITY_STYLE.info}`}>
                      {f.severity} · {Math.round(f.decayScore)}/100
                    </span>
                    <span className="text-sm font-medium">{ACTION_LABEL[f.suggestedAction] ?? f.suggestedAction}</span>
                  </div>
                  <p className="mt-2 font-mono text-sm text-ink">{f.url ?? "(page no longer ranking)"}</p>
                  <p className="mt-1 text-sm text-muted">
                    {f.phrases.slice(0, 4).join(", ")}
                    {f.phrases.length > 4 ? ` +${f.phrases.length - 4} more` : ""}
                  </p>
                  <p className="mt-1 text-xs text-muted">
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
