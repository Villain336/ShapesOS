// ShapesOS — Phase 18.2 (WS=content): a shared file, for anyone with the link.
// NO session. /r/file/<token> — the public viewer page of the file share-link
// family (lib/files/shares.ts; the bytes and the password unlock are
// /r/file/<token>/raw). Unknown, revoked, expired and trashed all 404 the
// same (no oracle). Shows only: the file's name, size and type, the preview,
// and a download button when the link allows it — never the workspace, the
// path, or who made it. A password link asks for its password first (the
// form posts to …/raw; the password never travels in a URL).

import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { Download, Lock } from "lucide-react";
import { getI18n } from "@/lib/i18n/server";
import { recordShareOpen, resolveShareToken, shareSecret, unlockCookieName, verifyUnlock } from "@/lib/files/shares";
import { isPreviewableMime } from "@/lib/files/preview";
import { aosButton, Wordmark } from "@/components/aos";
import { SharedFilePreview } from "@/components/files/SharedFilePreview";
import { fmtBytes } from "@/components/files/format";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const { t } = await getI18n();
  return { title: `${t("filesApp.share.pageTitle")} — ShapesOS`, robots: { index: false, follow: false } };
}

export default async function SharedFilePage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { token } = await params;
  const share = await resolveShareToken(token);
  if (!share) notFound();
  const { t } = await getI18n();
  const sp = await searchParams;
  const secret = shareSecret();
  const jar = await cookies();
  const locked = !!share.link.passwordHash && !(secret && verifyUnlock(share.link.id, jar.get(unlockCookieName(share.link.id))?.value, secret));
  const raw = `/r/file/${encodeURIComponent(token)}/raw`;
  if (!locked) await recordShareOpen(share);
  const previewable = isPreviewableMime(share.file.mimeType, share.file.filename);

  return (
    <main id="main-content" className="min-h-dvh bg-canvas px-4 py-8 sm:py-12">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-5">
        <Wordmark size={24} />
        {locked ? (
          <section className="mx-auto flex w-full max-w-md flex-col gap-3 rounded-lg bg-paper p-6 shadow-hairline" aria-labelledby="share-lock-title">
            <h1 id="share-lock-title" className="flex items-center gap-2 aos-subheading">
              <Lock className="size-5" aria-hidden />
              {t("filesApp.share.passwordTitle")}
            </h1>
            <p className="text-md text-muted">{t("filesApp.share.passwordBody")}</p>
            <form method="post" action={raw} className="flex flex-col gap-3">
              <label className="flex flex-col gap-2">
                <span className="text-md font-semibold text-ink">{t("filesApp.share.passwordLabel")}</span>
                <input
                  type="password"
                  name="password"
                  required
                  autoFocus
                  autoComplete="current-password"
                  aria-invalid={sp.e === "1" || undefined}
                  aria-describedby={sp.e === "1" ? "share-pw-error" : undefined}
                  className="h-control rounded-md border-[1.5px] border-control bg-paper px-3.5 text-base text-ink outline-none focus:border-focus"
                />
              </label>
              {sp.e === "1" ? (
                <p id="share-pw-error" role="alert" className="flex items-center gap-2 text-sm font-semibold text-failed-text">
                  <span aria-hidden className="size-2 shrink-0 bg-failed" />
                  {t("filesApp.share.passwordWrong")}
                </p>
              ) : null}
              <button type="submit" className={aosButton({ size: "md", className: "self-start" })}>
                {t("filesApp.share.unlock")}
              </button>
            </form>
          </section>
        ) : (
          <section className="flex flex-col gap-4 rounded-lg bg-paper p-5 shadow-hairline sm:p-6" aria-labelledby="share-file-title">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h1 id="share-file-title" className="truncate aos-subheading">{share.file.filename}</h1>
                <p className="text-sm text-muted">
                  {fmtBytes(share.file.sizeBytes)} · {share.file.mimeType} · {share.link.access === "download" ? t("filesApp.sharing.viewAndDownload") : t("filesApp.sharing.viewOnly")}
                </p>
              </div>
              {share.link.access === "download" ? (
                <a href={`${raw}?save=1`} className={aosButton({ size: "sm" })}>
                  <Download className="size-4" aria-hidden />
                  {t("filesApp.download")}
                </a>
              ) : null}
            </div>
            {previewable ? (
              <SharedFilePreview src={raw} mimeType={share.file.mimeType} filename={share.file.filename} />
            ) : (
              <p className="rounded-md bg-canvas px-4 py-10 text-center text-md text-muted">
                {share.link.access === "download" ? t("filesApp.share.noPreviewDownload") : t("filesApp.share.noPreviewViewOnly")}
              </p>
            )}
          </section>
        )}
        <p className="text-center text-xs text-muted">{t("filesApp.share.footer")}</p>
      </div>
    </main>
  );
}
