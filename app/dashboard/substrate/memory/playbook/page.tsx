// Marketr — Phase 8 G3: playbook — published patterns + review queue.
// Published patterns are APPROVED, human-reviewed, anonymized cross-client
// patterns. The queue is editor-only. House pattern: plain cards, badges
// top-right, light mode.

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { BookOpenCheck, Inbox } from "lucide-react";
import { listReviewedPatterns, listReviewQueue } from "@/lib/substrate/memory/playbook";
import PlaybookReviewButtons from "./playbook-review-buttons";

// Review states: pending_review is a workflow state awaiting human decision ->
// needs fill; approved -> done. (Approval workflow => status colors.)
const chipNeeds =
  "inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-needs px-1.5 py-0.5 text-[10px] font-medium leading-tight text-ink";
const chipDone =
  "inline-flex items-center whitespace-nowrap rounded-full bg-done px-1.5 py-0.5 text-[10px] font-medium leading-tight text-white";

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
          <h2 className="aos-subheading flex items-center gap-2">
            <Inbox className="h-5 w-5" aria-hidden /> Review queue
            <span className={chipNeeds}>{queue.length} pending</span>
          </h2>
          <p className="text-sm text-muted">
            Unreviewed patterns are invisible everywhere else. Approve only what contains no
            client-identifying detail.
          </p>
          <div className="grid gap-3">
            {queue.map((p) => (
              <article key={p.id} className="relative rounded-lg border border-line bg-paper p-4">
                <div className="absolute right-3 top-3">
                  <span className={chipNeeds}>pending review</span>
                </div>
                <h3 className="pr-28 font-medium leading-snug">{p.patternTitle}</h3>
                <p className="mt-1 text-sm text-muted">{p.patternBody}</p>
                <p className="mt-2 text-xs text-muted">
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
        <h2 className="aos-subheading flex items-center gap-2">
          <BookOpenCheck className="h-5 w-5" aria-hidden /> Published patterns
          <span className="inline-flex items-center rounded-full bg-paper px-2 py-0.5 text-xs font-medium text-muted shadow-control">
                {patterns.length}
              </span>
        </h2>
        {patterns.length === 0 && (
          <div className="rounded-lg border border-line bg-paper p-8 text-center text-sm text-muted">
            No published patterns yet. Propose one from a learning — it publishes only after human review.
          </div>
        )}
        <div className="grid gap-3">
          {patterns.map((p) => (
            <article key={p.id} className="relative rounded-lg border border-line bg-paper p-4">
              <div className="absolute right-3 top-3 flex gap-1.5">
                <span className={chipDone}>approved</span>
              </div>
              <h3 className="pr-36 font-medium leading-snug">{p.patternTitle}</h3>
              <p className="mt-1 text-sm text-muted">{p.patternBody}</p>
              <p className="mt-2 text-xs text-muted">
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
