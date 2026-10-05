"use client";

// ShapesOS — Phase 8 (ship): the run's Changes section. The diff is the
// server's record (the newest patch a git tool stored on a run event; see
// lib/ship/review.ts) — this component only renders it and sends the three
// decisions to POST /api/agent-runs/:id/review:
//   Approve          — the pending push / PR proposal runs (chat confirmation path)
//   Reject and stop  — Stop; the proposal is dropped
//   Ask for changes  — the note goes into the run's thread; the agent continues
// Design: tokens only. Adds and removes are told apart by the +/− marker,
// weight and surface (paper vs hover), never by a status colour; code is
// JetBrains Mono (DESIGN.md: mono for code and paths).

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { ExternalLink, FileCode, GitBranch, GitPullRequest, MessageSquare } from "lucide-react";
import { aosButton, AsksFirstChip, FieldMessage } from "@/components/aos";
import { toast, toastError } from "@/lib/ui/feedback";
import { cn } from "@/lib/utils";
import type { DiffFile } from "@/lib/ship/diff";

export interface ChangesReviewProps {
  runId: string;
  files: DiffFile[];
  truncated: boolean;
  additions: number;
  deletions: number;
  sourceLabel: string;
  ship: { repo: string; branch: string; branchUrl?: string; prUrl?: string; prNumber?: number } | null;
  /** The push / PR proposal waiting on a person, if any. */
  pendingTool: string | null;
  canApprove: boolean;
  canAsk: boolean;
  canReject: boolean;
}

const STATUS_LABEL: Record<DiffFile["status"], string> = {
  added: "Added",
  deleted: "Deleted",
  modified: "Modified",
  renamed: "Renamed",
  binary: "Binary",
};

/** Lines rendered before the rest of a file folds away (keeps the page light). */
const LINE_BUDGET = 4000;

function pendingLabel(tool: string | null): string {
  if (tool === "git_push_branch") return "Push this branch to GitHub";
  if (tool === "open_pull_request") return "Open the pull request";
  return "Approve";
}

export function ChangesReview(props: ChangesReviewProps) {
  const router = useRouter();
  const [busy, setBusy] = useState<null | "approve" | "reject" | "changes">(null);
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState("");
  const [noteError, setNoteError] = useState<string | null>(null);
  const noteId = useId();
  const msgId = useId();

  async function send(action: "approve" | "reject" | "changes") {
    if (action === "changes" && !note.trim()) {
      setNoteError("Say what should change.");
      return;
    }
    setBusy(action);
    try {
      const res = await fetch(`/api/agent-runs/${encodeURIComponent(props.runId)}/review`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(action === "changes" ? { action, message: note.trim() } : { action }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; followUpRunId?: string };
      if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status}).`);
      if (action === "approve") toast({ title: "Approved", description: "The agent carried on with it.", status: "done" });
      else if (action === "reject") toast({ title: "Rejected", description: "The run was stopped and nothing was pushed.", status: "done" });
      else toast({ title: "Sent", description: "The agent is working on your changes.", status: "running" });
      setAsking(false);
      setNote("");
      if (body.followUpRunId) router.push(`/dashboard/runs/${body.followUpRunId}`);
      else router.refresh();
    } catch (e) {
      const verb = action === "approve" ? "approve" : action === "reject" ? "reject" : "send your changes";
      toastError(`Couldn't ${verb}`, e instanceof Error ? e.message : undefined);
    } finally {
      setBusy(null);
    }
  }

  let budget = LINE_BUDGET;

  return (
    <section className="overflow-hidden rounded-lg bg-paper shadow-hairline" aria-labelledby={`${noteId}-h`}>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-4">
        <div className="min-w-0">
          <h2 id={`${noteId}-h`} className="aos-subheading">
            Changes
          </h2>
          <p className="mt-0.5 text-sm text-muted">
            {props.files.length} {props.files.length === 1 ? "file" : "files"} · +{props.additions} −{props.deletions} · {props.sourceLabel}
          </p>
        </div>
        {props.ship ? (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            {props.ship.branchUrl ? (
              <a href={props.ship.branchUrl} target="_blank" rel="noreferrer" className={aosButton({ variant: "secondary", size: "xs" })}>
                <GitBranch className="size-4" aria-hidden />
                <span className="aos-mono">{props.ship.branch}</span>
                <ExternalLink className="size-3.5" aria-hidden />
              </a>
            ) : (
              <span className="inline-flex h-8 items-center gap-1.5 rounded-full bg-canvas px-3.5 text-sm text-ink">
                <GitBranch className="size-4" aria-hidden />
                <span className="aos-mono">{props.ship.branch}</span>
              </span>
            )}
            {props.ship.prUrl ? (
              <a href={props.ship.prUrl} target="_blank" rel="noreferrer" className={aosButton({ variant: "secondary", size: "xs" })}>
                <GitPullRequest className="size-4" aria-hidden />
                Pull request{props.ship.prNumber ? ` #${props.ship.prNumber}` : ""}
                <ExternalLink className="size-3.5" aria-hidden />
              </a>
            ) : null}
          </div>
        ) : null}
      </div>

      {props.pendingTool || props.canAsk || props.canReject ? (
        <div className="flex flex-col gap-3 border-b border-line px-5 py-4">
          {props.pendingTool ? <AsksFirstChip label={`${pendingLabel(props.pendingTool)} — waiting for your OK`} /> : null}
          <div className="flex flex-wrap items-center gap-2">
            {props.pendingTool && props.canApprove ? (
              <button type="button" className={aosButton({ variant: "approve", size: "sm" })} disabled={busy !== null} onClick={() => send("approve")}>
                {busy === "approve" ? "Approving" : pendingLabel(props.pendingTool)}
              </button>
            ) : null}
            {props.canAsk ? (
              <button
                type="button"
                className={aosButton({ variant: "secondary", size: "sm" })}
                aria-expanded={asking}
                aria-controls={`${noteId}-form`}
                disabled={busy !== null}
                onClick={() => setAsking((v) => !v)}
              >
                <MessageSquare className="size-4" aria-hidden />
                Ask for changes
              </button>
            ) : null}
            {props.canReject ? (
              <button type="button" className={aosButton({ variant: "deny", size: "sm" })} disabled={busy !== null} onClick={() => send("reject")}>
                {busy === "reject" ? "Rejecting" : "Reject and stop"}
              </button>
            ) : null}
          </div>
          {asking ? (
            <form
              id={`${noteId}-form`}
              className="flex flex-col gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void send("changes");
              }}
            >
              <label htmlFor={noteId} className="text-sm font-semibold text-ink">
                What should change?
              </label>
              <textarea
                id={noteId}
                value={note}
                onChange={(e) => {
                  setNote(e.target.value);
                  if (noteError) setNoteError(null);
                }}
                rows={4}
                maxLength={3800}
                aria-invalid={noteError ? true : undefined}
                aria-describedby={msgId}
                placeholder="Keep the old heading; add a test for the empty cart."
                className={cn(
                  "w-full rounded-md border-[1.5px] bg-paper px-3.5 py-2.5 text-base text-ink placeholder:text-subtle focus:outline-none",
                  noteError ? "border-failed" : "border-control focus:border-focus focus:shadow-[0_0_0_3px_var(--aos-focus-halo)]",
                )}
              />
              <FieldMessage id={msgId} helper="Sent to the agent in this run's chat; it carries on from your note." error={noteError} />
              <div>
                <button type="submit" className={aosButton({ variant: "primary", size: "sm" })} disabled={busy !== null}>
                  {busy === "changes" ? "Sending" : "Send to the agent"}
                </button>
              </div>
            </form>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-col gap-3 p-4">
        {props.files.length === 0 ? (
          <p className="text-md text-muted">No changes since the task started.</p>
        ) : (
          props.files.map((f, i) => {
            const lines = f.hunks.reduce((n, h) => n + h.lines.length + 1, 0);
            const show = budget > 0;
            budget -= lines;
            return (
              <details key={`${f.path}-${i}`} open={show && i < 12} className="overflow-hidden rounded-md bg-canvas">
                <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-3.5 py-2 hover:bg-hover">
                  <span className="flex min-w-0 items-center gap-2">
                    <FileCode className="size-4 shrink-0 text-muted" aria-hidden />
                    <span className="aos-mono truncate text-sm text-ink">
                      {f.oldPath ? `${f.oldPath} → ` : ""}
                      {f.path}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <span className="inline-flex h-6 items-center rounded-full bg-paper px-2.5 text-xs font-semibold text-ink shadow-hairline">
                      {STATUS_LABEL[f.status]}
                    </span>
                    <span className="aos-mono text-xs text-ink tabular-nums">+{f.additions}</span>
                    <span className="aos-mono text-xs text-muted tabular-nums">−{f.deletions}</span>
                  </span>
                </summary>
                {f.status === "binary" ? (
                  <p className="border-t border-line px-3.5 py-2.5 text-sm text-muted">Binary file — not shown.</p>
                ) : (
                  <div className="overflow-x-auto border-t border-line">
                    <table className="aos-mono w-full border-collapse text-xs leading-5">
                      <tbody>
                        {f.hunks.map((h, hi) => (
                          <HunkRows key={hi} header={h.header} lines={h.lines} />
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </details>
            );
          })
        )}
        {props.truncated ? (
          <p className="text-sm text-muted">This diff was cut at 200 KB when it was stored; ask the agent for git_diff on specific paths to see the rest.</p>
        ) : null}
      </div>
    </section>
  );
}

function HunkRows({ header, lines }: { header: string; lines: DiffFile["hunks"][number]["lines"] }) {
  return (
    <>
      <tr>
        <td colSpan={3} className="bg-hover px-3.5 py-1 text-muted">
          {header}
        </td>
      </tr>
      {lines.map((l, i) => (
        <tr
          key={i}
          className={cn(
            l.kind === "add" && "bg-paper font-medium text-ink shadow-[inset_2px_0_0_var(--aos-ink)]",
            l.kind === "del" && "bg-hover text-muted",
            (l.kind === "ctx" || l.kind === "note") && "text-muted",
          )}
        >
          <td className="w-10 select-none px-2 text-right text-subtle tabular-nums">{l.oldNo ?? ""}</td>
          <td className="w-10 select-none px-2 text-right text-subtle tabular-nums">{l.newNo ?? ""}</td>
          <td className="whitespace-pre pr-4">
            <span className="inline-block w-4 select-none font-semibold" aria-label={l.kind === "add" ? "added" : l.kind === "del" ? "removed" : undefined}>
              {l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}
            </span>
            <span className={cn(l.kind === "del" && "line-through decoration-subtle", l.kind === "note" && "italic")}>{l.text}</span>
          </td>
        </tr>
      ))}
    </>
  );
}
