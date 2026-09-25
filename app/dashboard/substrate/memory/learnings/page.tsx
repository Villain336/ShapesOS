// Marketr — Phase 8 G3: learnings list (SPEC-PHASE8.md §6).
// Filters (result, source, q), badges top-right, provenance + freshness on
// every card. House pattern: plain cards, light mode, Lucide icons.

import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { Badge } from "@/components/vault/shadcn/badge";
import { Input } from "@/components/vault/shadcn/input";
import { Button } from "@/components/vault/shadcn/button";
import { CheckCircle2, XCircle, HelpCircle, FlaskConical } from "lucide-react";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { freshnessLabel } from "@/lib/substrate/graph/freshness";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Learnings — Growth Memory — Marketr",
  description: "What worked, what failed, what was inconclusive — with provenance.",
};

const RESULT_ICON = {
  worked: CheckCircle2,
  failed: XCircle,
  inconclusive: HelpCircle,
} as const;

function bucketVariant(bucket: string): "secondary" | "outline" | "destructive" {
  if (bucket === "fresh") return "secondary";
  if (bucket === "aging") return "outline";
  return "destructive";
}

async function listLearnings(
  workspaceId: string,
  opts: { result?: string; source?: string; q?: string },
) {
  return withWorkspaceScope(workspaceId, (tx) =>
    tx.memoryLearning.findMany({
      where: {
        workspaceId,
        invalidatedAt: null,
        ...(opts.result ? { result: opts.result as never } : {}),
        ...(opts.source ? { source: opts.source as never } : {}),
        ...(opts.q
          ? {
              OR: [
                { hypothesis: { contains: opts.q, mode: "insensitive" } },
                { action: { contains: opts.q, mode: "insensitive" } },
              ],
            }
          : {}),
      },
      orderBy: { observedAt: "desc" },
      take: 60,
    }),
  );
}

export default async function LearningsPage({
  searchParams,
}: {
  searchParams: Promise<{ result?: string; source?: string; q?: string }>;
}) {
  const user = await requireUser();
  if (!user?.id) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const sp = await searchParams;
  const learnings = await listLearnings(workspace.id, {
    result: sp.result || undefined,
    source: sp.source || undefined,
    q: sp.q?.trim() || undefined,
  });
  const now = new Date();

  return (
    <div className="space-y-4">
      <form method="get" className="flex flex-wrap items-center gap-2">
        <Input name="q" placeholder="Search hypothesis or action…" defaultValue={sp.q ?? ""} className="w-64" />
        <select
          name="result"
          defaultValue={sp.result ?? ""}
          className="rounded-md border border-input bg-background px-3 py-2 text-sm"
          aria-label="Filter by result"
        >
          <option value="">All results</option>
          <option value="worked">Worked</option>
          <option value="failed">Failed</option>
          <option value="inconclusive">Inconclusive</option>
        </select>
        <Button type="submit" variant="secondary">
          Filter
        </Button>
        <span className="ml-auto text-sm text-muted-foreground">{learnings.length} learnings</span>
      </form>

      {learnings.length === 0 && (
        <div className="rounded-lg border bg-card p-8 text-center text-sm text-muted-foreground">
          No learnings yet. Close a Test Lab experiment and archive it — the learning lands here.
        </div>
      )}

      <div className="grid gap-3">
        {learnings.map((l) => {
          const Icon = RESULT_ICON[l.result as keyof typeof RESULT_ICON] ?? HelpCircle;
          const fresh = freshnessLabel(l.observedAt, `memory:learning · ${l.source}`, now);
          return (
            <article key={l.id} className="relative rounded-lg border bg-card p-4">
              <div className="absolute right-3 top-3 flex gap-1.5">
                <Badge variant={l.result === "worked" ? "secondary" : l.result === "failed" ? "destructive" : "outline"}>
                  {l.result}
                </Badge>
                <Badge variant={bucketVariant(fresh.bucket)} title={fresh.label}>
                  {fresh.bucket}
                </Badge>
              </div>
              <div className="flex items-start gap-3 pr-40">
                <Icon className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
                <div className="min-w-0">
                  <h3 className="font-medium leading-snug">{l.hypothesis}</h3>
                  <p className="mt-1 text-sm text-muted-foreground">{l.action}</p>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {fresh.label}
                    {l.sourceEpisodeId ? (
                      <>
                        {" · "}
                        <Link
                          className="underline"
                          href={`/dashboard/substrate/memory/episodes#${l.sourceEpisodeId}`}
                        >
                          source episode
                        </Link>
                      </>
                    ) : null}
                  </p>
                </div>
              </div>
            </article>
          );
        })}
      </div>

      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <FlaskConical className="h-3.5 w-3.5" aria-hidden />
        Human-asserted learnings carry confidence 1.0 and origin user_told — they never decay.
      </p>
    </div>
  );
}
