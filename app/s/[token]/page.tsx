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

export const dynamic = "force-dynamic";

const STATUS_LABEL: Record<string, { label: string; cls: string }> = {
  draft: { label: "Draft", cls: "bg-stone-100 text-stone-600" },
  in_review: { label: "In review", cls: "bg-amber-100 text-amber-800" },
  approved: { label: "Approved", cls: "bg-emerald-100 text-emerald-800" },
  changes_requested: { label: "Changes requested", cls: "bg-red-100 text-red-800" },
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
  const umami = umamiSnippetConfig();

  // White-label read path: logo + brand color + custom domain for this
  // design's workspace. Missing/empty fields fall back to the defaults.
  const wl = share.design.workspace;
  const brandAccent = wl.whiteLabelBrandColor?.trim() || "#7c3aed";
  const wlLogoUrl = wl.whiteLabelLogoUrl
    ? `/api/public/workspaces/${wl.id}/logo`
    : null;
  const wlDomain = wl.whiteLabelCustomDomain?.trim() || null;

  return (
    <div className="min-h-screen bg-[#FAFAF7] px-4 py-8 md:px-8">
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
              className="h-10 w-10 rounded-lg border border-stone-200 bg-white object-contain"
            />
          ) : (
            <div
              className="flex h-10 w-10 items-center justify-center rounded-lg text-white"
              style={{ backgroundColor: brandAccent }}
            >
              <FileText className="h-5 w-5" />
            </div>
          )}
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-xl font-bold tracking-tight text-stone-900">
              {share.design.name}
            </h1>
            <p className="text-[13px] text-stone-500">
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
                <h2 className="mb-2 text-[13px] font-semibold text-stone-700">{p.name}</h2>
                <div className="overflow-hidden rounded-lg border border-stone-200 bg-white shadow-sm">
                  {res.ok ? (
                    <div
                      className="[&_svg]:block [&_svg]:h-auto [&_svg]:w-full"
                      // Server-rendered from the validated design document.
                      dangerouslySetInnerHTML={{ __html: res.svg }}
                    />
                  ) : (
                    <p className="p-6 text-[13px] text-stone-500">
                      This page could not be rendered.
                    </p>
                  )}
                </div>
              </section>
            );
          })}
        </div>

        <section className="mt-10">
          <h2 className="mb-3 flex items-center gap-2 text-[15px] font-semibold text-stone-900">
            <MessageSquare className="h-4 w-4" style={{ color: brandAccent }} />
            Comments ({comments.length})
          </h2>
          {comments.length === 0 ? (
            <p className="rounded-lg border border-stone-200 bg-white p-4 text-[13px] text-stone-500">
              No comments yet.
            </p>
          ) : (
            <ul className="space-y-3">
              {comments.map((c) => (
                <li
                  key={c.id}
                  className="rounded-lg border border-stone-200 bg-white p-4"
                >
                  <div className="mb-1 flex items-center gap-2">
                    <span className="text-[13px] font-semibold text-stone-900">
                      {c.authorName}
                    </span>
                    {c.resolvedAt && (
                      <span className="flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-800">
                        <CheckCircle2 className="h-3 w-3" />
                        Resolved
                      </span>
                    )}
                    <span className="ml-auto flex items-center gap-1 text-[11px] text-stone-400">
                      <Clock3 className="h-3 w-3" />
                      {new Date(c.createdAt).toLocaleDateString()}
                    </span>
                  </div>
                  <p className="whitespace-pre-wrap text-[13px] text-stone-700">{c.body}</p>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-[12px] text-stone-400">
            Commenting is disabled on public previews — sign in to the workspace to join the
            discussion.
          </p>
        </section>
      </div>
    </div>
  );
}
