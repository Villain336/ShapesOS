// ShapesOS — Phase 9 (sites): a person applies (or discards) a site revision.
//
// Applying is the human step after an agent's site_publish_draft: the
// working copy becomes exactly the draft's files. Before anything is
// written, the current working copy is saved as a "backup" revision —
// applying that backup later is the revert. A draft whose site moved on
// since the agent checked it out (fingerprint mismatch) is refused unless
// the person confirms (force). Applying never deploys or publishes: those
// stay their own actions behind their own gates.

import { logSiteChange } from "@/lib/connectors/source";
import type { WorkingCopyProvider } from "@/lib/connectors/local";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import type { Prisma } from "@prisma/client";
import { readSiteWorkingCopy, siteFingerprint, workingCopy, writeSiteWorkingCopy } from "./files";
import { createSiteRevisionTx, getSiteRevision, setSiteRevisionStatusTx } from "./revisions";

type Tx = Prisma.TransactionClient;

export class SiteRevisionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "SiteRevisionError";
  }
}

export interface ApplyInput {
  workspaceId: string;
  projectId: string;
  siteId: string;
  revisionId: string;
  userId: string;
  /** Apply even though the site changed after the agent checked it out. */
  force?: boolean;
  /** Test seam: the working copy (default: the site's own). */
  provider?: WorkingCopyProvider;
  /** Test seam: audit log writer. */
  log?: typeof logSiteChange;
  /** Phase 11 (seotools): rebuild the sitemap after applying a draft (default true). */
  refreshSitemap?: boolean;
}

export interface ApplyOutcome {
  number: number;
  backupId: string;
  backupNumber: number;
  written: number;
  removed: string[];
}

export async function applySiteRevision(input: ApplyInput): Promise<ApplyOutcome> {
  const provider = input.provider ?? workingCopy(input.siteId);
  const log = input.log ?? logSiteChange;
  const rev = await getSiteRevision(input.workspaceId, input.siteId, input.revisionId);
  if (!rev) throw new SiteRevisionError("not_found", "Revision not found.", 404);
  if (rev.status !== "draft" && rev.status !== "backup") {
    throw new SiteRevisionError("not_applicable", `This revision was already ${rev.status}.`, 409);
  }
  const current = await readSiteWorkingCopy(input.siteId, provider);
  if (rev.status === "draft" && rev.baseFingerprint && !input.force) {
    if (siteFingerprint(current.files) !== rev.baseFingerprint) {
      throw new SiteRevisionError(
        "site_changed",
        "The site changed after the agent checked it out. Applying replaces those changes too (they are kept in a backup).",
        409,
      );
    }
  }

  // Backup + claim in one transaction; files are written after it commits.
  const { backup } = await withWorkspaceScope(input.workspaceId, async (raw) => {
    const tx = raw as Tx;
    const backup = await createSiteRevisionTx(tx, {
      workspaceId: input.workspaceId,
      siteId: input.siteId,
      status: "backup",
      source: "backup",
      files: current.files,
      summary: `Before applying #${rev.number}`,
      createdBy: input.userId,
    });
    const now = new Date();
    const claimed =
      rev.status === "draft"
        ? await setSiteRevisionStatusTx(tx, input.workspaceId, rev.id, ["draft"], {
            status: "applied",
            appliedAt: now,
            appliedBy: input.userId,
            backupId: backup.id,
          })
        : await setSiteRevisionStatusTx(tx, input.workspaceId, rev.id, ["backup"], {
            status: "backup",
            appliedAt: now,
            appliedBy: input.userId,
            backupId: backup.id,
          });
    if (!claimed) throw new SiteRevisionError("not_applicable", "This revision was just applied or discarded.", 409);
    return { backup };
  });

  let result: { written: number; removed: string[] };
  try {
    result = await writeSiteWorkingCopy(input.siteId, rev.files, provider);
  } catch (err) {
    // Put the draft back so it can be applied again; the backup stays.
    if (rev.status === "draft") {
      await withWorkspaceScope(input.workspaceId, (tx) =>
        setSiteRevisionStatusTx(tx as Tx, input.workspaceId, rev.id, ["applied"], { status: "draft", backupId: null }),
      ).catch(() => undefined);
    }
    throw err;
  }

  // Phase 11 (seotools): rebuild sitemap.xml / robots.txt / IndexNow key for
  // the applied draft's pages (best effort — never fails the apply).
  // Restoring a backup stays an exact revert: no rebuild.
  if (rev.status === "draft" && input.refreshSitemap !== false) {
    const { refreshSiteSitemap } = await import("@/lib/seo/sitemap");
    await refreshSiteSitemap({ siteId: input.siteId, projectId: input.projectId, provider }).catch(() => undefined);
  }

  await log({
    projectId: input.projectId,
    siteId: input.siteId,
    filePath: "/",
    actor: rev.status === "draft" ? "ai" : "user",
    action: rev.status === "draft" ? "ai_applied" : "save",
    summary:
      rev.status === "draft"
        ? `Applied agent draft #${rev.number}: ${result.written} files written, ${result.removed.length} removed (backup #${backup.number})`
        : `Restored backup #${rev.number}: ${result.written} files written, ${result.removed.length} removed (backup #${backup.number})`,
    approvedBy: input.userId,
  }).catch(() => undefined);

  return { number: rev.number, backupId: backup.id, backupNumber: backup.number, ...result };
}

export async function discardSiteRevision(input: { workspaceId: string; siteId: string; revisionId: string }): Promise<void> {
  const ok = await withWorkspaceScope(input.workspaceId, async (raw) => {
    const tx = raw as Tx;
    const found = await tx.siteRevision.findFirst({
      where: { id: input.revisionId, workspaceId: input.workspaceId, siteId: input.siteId },
      select: { id: true },
    });
    if (!found) throw new SiteRevisionError("not_found", "Revision not found.", 404);
    return setSiteRevisionStatusTx(tx, input.workspaceId, input.revisionId, ["draft"], { status: "discarded" });
  });
  if (!ok) throw new SiteRevisionError("not_applicable", "Only a draft can be discarded.", 409);
}
