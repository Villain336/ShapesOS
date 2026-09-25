// Marketr — Phase 8 G3: playbook — published patterns + review queue.
// Published patterns are APPROVED, human-reviewed, anonymized cross-client
// patterns. The queue is editor-only. House pattern: plain cards, badges
// top-right, light mode.

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { Badge } from "@/components/vault/shadcn/badge";
import { BookOpenCheck, Inbox } from "lucide-react";
import { listReviewedPatterns, listReviewQueue } from "@/lib/substrate/memory/playbook";
import PlaybookReviewButtons from "./playbook-review-buttons";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Playbook — Growth Memory — Marketr",
  description: "Anonymized, human-reviewed cross-client patterns. Nothing publishes without review.",
};

export default async function PlaybookPage() {
  const user = await requireUser();
  if (!user?.id) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const isEditor = await requireWorkspaceRole(user.id, workspace.id, "editor");
  const [patterns, queue] = await Promise.all([
    listReviewedPatterns({ limit: 50 }),
    isEditor ? listReviewQueue(workspace.id).catch(() => []) : Promise.resolve([]),
  ]);

  return (
    <div className="space-y-6">
      {isEditor && queue.length > 0 && (
        <section className="space-y-3">
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <Inbox className="h-5 w-5" aria-hidden /> Review queue
            <Badge variant="outline">{queue.length} pending</Badge>
          </h2>
          <p className="text-sm text-muted-foreground">
            Unreviewed patterns are invisible everywhere else. Approve only what contains no
            client-identifying detail.
          </p>
          <div className="grid gap-3">
            {queue.map((p) => (
              <article key={p.id} className="relative rounded-lg border bg-card p-4">
                <div className="absolute right-3 top-3">
                  <Badge variant="outline">pending_review</Badge>
                </div>
                <h3 className="pr-28 font-medium leading-snug">{p.patternTitle}</h3>
                <p className="mt-1 text-sm text-muted-foreground">{p.patternBody}</p>
                <p className="mt-2 text-xs text-muted-foreground">
                  {p.supportingClientCount} supporting client{p.supportingClientCount === 1 ? "" : "s"}
                </p>
                <div className="mt-3">
                  <PlaybookReviewButtons workspaceId={workspace.id} playbookId={p.id} />
                </div>
              </article>
            ))}
          </div>
        </section>
      )}

      <section className="space-y-3">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <BookOpenCheck className="h-5 w-5" aria-hidden /> Published patterns
          <Badge variant="secondary">{patterns.length}</Badge>
        </h2>
        {patterns.length === 0 && (
          <div className="rounded-lg border bg-card p-8 text-center text-sm text-muted-foreground">
            No published patterns yet. Propose one from a learning — it publishes only after human review.
          </div>
        )}
        <div className="grid gap-3">
          {patterns.map((p) => (
            <article key={p.id} className="relative rounded-lg border bg-card p-4">
              <div className="absolute right-3 top-3 flex gap-1.5">
                <Badge variant="secondary">approved</Badge>
              </div>
              <h3 className="pr-36 font-medium leading-snug">{p.patternTitle}</h3>
              <p className="mt-1 text-sm text-muted-foreground">{p.patternBody}</p>
              <p className="mt-2 text-xs text-muted-foreground">
                reviewed {p.reviewedAt ? new Date(p.reviewedAt).toLocaleDateString() : "—"}
                {p.anonymizationReviewedBy ? ` · by ${p.anonymizationReviewedBy.slice(0, 8)}…` : ""}
                {` · ${p.supportingClientCount} client${p.supportingClientCount === 1 ? "" : "s"}`}
              </p>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
