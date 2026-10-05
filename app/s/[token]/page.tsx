// Marketr — public design share page (Feature 6). NO auth.
// GET /s/[token] — token-guarded read-only preview.
// Unknown, expired, and revoked tokens all 404 identically (no oracle).
// Exposes only: design name, page previews (server-rendered SVG), approval
// status, and safe comment fields (author name, body, timestamps). Never:
// workspace name, owner email, commenter emails, or unrelated data.

import { notFound } from "next/navigation";
import { CheckCircle2, Clock3, FileText, MessageSquare } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { hashShareToken } from "@/lib/design/sharing";
import { exportPageToSvg } from "@/lib/design/export-svg";
// Phase 12 (embeds): optional rrweb replay + Umami cookieless analytics on
// public share pages. Both are inert unless configured / opted in.
import { RrwebRecorder } from "@/components/replay/RrwebRecorder";
import { UmamiTracker } from "@/components/analytics/UmamiTracker";
import { umamiSnippetConfig } from "@/lib/integrations/umami";
import { withWorkspaceSidecars } from "@/lib/integrations/sidecar-tenancy";
import { effectiveWhiteLabel } from "@/lib/billing/entitlements";

export const dynamic = "force-dynamic";

/** Exported page SVG → data: URL for an <img> (base64; no inline markup). */
function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}

// Review status is a human decision, not an agent state: neutral chips, told
// apart by label and weight (DESIGN.md reserves the status hues for agents).
const STATUS_LABEL: Record<string, { label: string; cls: string }> = {
  draft: { label: "Draft", cls: "bg-canvas text-muted" },
  in_review: { label: "In review", cls: "bg-paper text-ink shadow-control" },
  approved: { label: "Approved", cls: "bg-ink text-paper" },
  changes_requested: { label: "Changes requested", cls: "bg-paper text-ink shadow-outline" },
};

async function loadShare(token: string) {
  const tokenHash = hashShareToken(token);
  const share = await prisma.designShare.findUnique({
    where: { tokenHash },
    select: {
      id: true,
      expiresAt: true,
      revokedAt: true,
      replayOptIn: true,
      design: {
        select: {
          id: true,
          name: true,
          document: true,
          approvalStatus: true,
          // White-label identity (Phase 13 Wave A): the editors under
          // Settings → White-label write these fields; the share page
          // renders them below (logo, brand color, custom domain).
          workspace: {
            select: {
              id: true,
              plan: true,
              whiteLabelBrandColor: true,
              whiteLabelLogoUrl: true,
              whiteLabelCustomDomain: true,
            },
          },
        },
      },
    },
  });
  // Identical 404 for unknown / revoked / expired — no token oracle.
  if (!share) return null;
  if (share.revokedAt) return null;
  if (share.expiresAt && share.expiresAt <= new Date()) return null;
  const comments = await prisma.designComment.findMany({
    where: { designId: share.design.id },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      authorName: true,
      body: true,
      resolvedAt: true,
      createdAt: true,
    },
  });
  return { share, comments };
}

export default async function PublicSharePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const data = await loadShare(token);
  if (!data) notFound();
  const { share, comments } = data;
  const doc = share.design.document as {
    pages?: Array<{ id: string; name: string }>;
  } | null;
  const pages = Array.isArray(doc?.pages) ? doc.pages : [];
  const status = STATUS_LABEL[share.design.approvalStatus] ?? STATUS_LABEL.draft!;
  // Phase 15.1: the sharing workspace's own Umami (a shared one is refused on hosted).
  const umami = await withWorkspaceSidecars(share.design.workspace.id, () => umamiSnippetConfig());

  // White-label read path: logo + brand color + custom domain for this
  // design's workspace. Missing/empty fields fall back to the defaults.
  // Phase 4a: only on plans that include white-label (effectiveWhiteLabel).
  const wl = effectiveWhiteLabel(share.design.workspace);
  // The tenant's saved brand color is user data (white-label preview), so it
  // stays literal; with none set we fall back to the system ink.
  const brandAccent = wl.brandColor?.trim() || "var(--aos-ink)";
  const wlLogoUrl = wl.logoUrl
    ? `/api/public/workspaces/${share.design.workspace.id}/logo`
    : null;
  const wlDomain = wl.customDomain?.trim() || null;

  return (
    <div className="min-h-screen bg-canvas px-4 py-8 md:px-8">
      {umami && <UmamiTracker websiteId={umami.websiteId} scriptUrl={umami.scriptUrl} />}
      {share.replayOptIn && <RrwebRecorder token={token} />}
      <div className="mx-auto max-w-4xl">
        <header className="mb-6 flex flex-wrap items-center gap-3">
          {wlLogoUrl ? (
            // White-label logo replaces the default icon badge when set.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={wlLogoUrl}
              alt="Workspace logo"
              className="h-10 w-10 rounded-sm bg-paper object-contain shadow-hairline"
            />
          ) : (
            <div
              className="flex h-10 w-10 items-center justify-center rounded-sm text-paper"
              style={{ backgroundColor: brandAccent }}
            >
              <FileText className="h-5 w-5" />
            </div>
          )}
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-xl font-heading stretch-heading tracking-heading text-ink">
              {share.design.name}
            </h1>
            <p className="text-[13px] text-muted">
              Shared design preview — {pages.length} page{pages.length === 1 ? "" : "s"}
              {wlDomain ? ` · ${wlDomain}` : ""}
            </p>
          </div>
          <span
            className={`rounded-full px-3 py-1 text-[12px] font-semibold ${status.cls}`}
          >
            {status.label}
          </span>
        </header>

        <div className="space-y-8">
          {pages.map((p) => {
            const res = exportPageToSvg(doc, p.id);
            return (
              <section key={p.id}>
                <h2 className="mb-2 text-[13px] font-semibold text-ink">{p.name}</h2>
                <div className="overflow-hidden rounded-lg bg-paper shadow-hairline">
                  {res.ok ? (
                    // H1: rendered as an IMAGE, never inline HTML. SVG loaded
                    // through <img> can't run script or fetch subresources,
                    // so even a hostile document can't touch this origin.
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={svgDataUrl(res.svg)}
                      alt={`${share.design.name} — ${p.name}`}
                      className="block h-auto w-full"
                    />
                  ) : (
                    <p className="p-6 text-[13px] text-muted">
                      This page could not be rendered.
                    </p>
                  )}
                </div>
              </section>
            );
          })}
        </div>

        <section className="mt-10">
          <h2 className="mb-3 flex items-center gap-2 text-lg font-heading stretch-heading tracking-heading text-ink">
            <MessageSquare className="h-4 w-4" style={{ color: brandAccent }} />
            Comments ({comments.length})
          </h2>
          {comments.length === 0 ? (
            <p className="rounded-lg bg-paper p-4 text-[13px] text-muted shadow-hairline">
              No comments yet.
            </p>
          ) : (
            <ul className="space-y-3">
              {comments.map((c) => (
                <li
                  key={c.id}
                  className="rounded-lg bg-paper p-4 shadow-hairline"
                >
                  <div className="mb-1 flex items-center gap-2">
                    <span className="text-[13px] font-semibold text-ink">
                      {c.authorName}
                    </span>
                    {c.resolvedAt && (
                      <span className="flex items-center gap-1 rounded-full bg-canvas px-2 py-0.5 text-[12px] font-semibold text-ink">
                        <CheckCircle2 className="h-3 w-3" />
                        Resolved
                      </span>
                    )}
                    <span className="ml-auto flex items-center gap-1 text-[11px] text-muted">
                      <Clock3 className="h-3 w-3" />
                      {new Date(c.createdAt).toLocaleDateString()}
                    </span>
                  </div>
                  <p className="whitespace-pre-wrap text-[13px] text-ink">{c.body}</p>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-[12px] text-muted">
            Commenting is disabled on public previews — sign in to the workspace to join the
            discussion.
          </p>
        </section>
      </div>
    </div>
  );
}
