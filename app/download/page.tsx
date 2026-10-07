// ShapesOS — Phase 19A (WS=server): the public /download page (website, like
// /pricing). Lists the ShapesOS Desktop builds for Mac and Windows from the
// same feed the app auto-updates from (DESKTOP_UPDATE_URL → lib/desktop-app/
// releases.ts, also served as GET /api/desktop/releases). No feed configured
// or nothing published → "Desktop builds are not published yet": never a
// made-up link. Reads no database and no session.

import Link from "next/link";
import { ArrowRight, Download, Laptop, Monitor } from "lucide-react";
import { desktopReleases, type DesktopReleaseFile } from "@/lib/desktop-app/releases";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Download ShapesOS Desktop",
  description: "ShapesOS Desktop for Mac and Windows: the full ShapesOS in a native window, plus a voice cursor that sees your screen while you hold a key and points at what to click.",
};

const quietNav =
  "inline-flex h-control-sm items-center rounded-full px-4 text-base font-semibold text-muted transition-colors hover:bg-hover hover:text-ink";
const primaryCta =
  "aos-press inline-flex h-control items-center gap-2 rounded-full bg-ink px-5.5 text-base font-semibold text-paper hover:bg-ink-hover";

function sizeLabel(bytes: number | null): string | null {
  if (!bytes || bytes <= 0) return null;
  return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
}

const ARCH_LABEL: Record<DesktopReleaseFile["arch"], string> = {
  universal: "Apple silicon and Intel",
  arm64: "ARM (Apple silicon / Windows on ARM)",
  x64: "Intel / AMD 64-bit",
};

function OsCard({ os, files }: { os: "mac" | "windows"; files: DesktopReleaseFile[] }) {
  const Icon = os === "mac" ? Laptop : Monitor;
  const title = os === "mac" ? "macOS" : "Windows";
  return (
    <section aria-labelledby={`dl-${os}`} className="flex flex-col rounded-lg bg-paper p-6 shadow-hairline">
      <div className="flex items-center gap-3">
        <Icon className="size-6 text-ink" aria-hidden />
        <h2 id={`dl-${os}`} className="aos-heading text-ink">
          {title}
        </h2>
      </div>
      {files.length === 0 ? (
        <p className="mt-3 text-sm text-muted">No {title} build is published yet.</p>
      ) : (
        <ul className="mt-4 flex flex-col gap-3">
          {files.map((f) => (
            <li key={f.url} className="flex flex-col gap-2 rounded-md border border-line p-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="text-base font-semibold text-ink">{ARCH_LABEL[f.arch]}</p>
                <p className="text-sm text-muted">
                  {[sizeLabel(f.size), f.url.split("/").pop()].filter(Boolean).join(" · ")}
                </p>
                {f.sha512 ? (
                  <p className="mt-1 truncate font-mono text-xs text-subtle" title={f.sha512}>
                    sha512 {f.sha512}
                  </p>
                ) : null}
              </div>
              <a href={f.url} className={primaryCta} rel="noopener">
                <Download className="size-4" aria-hidden />
                Download
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default async function DownloadPage() {
  const data = await desktopReleases("stable");
  const mac = data.files.filter((f) => f.os === "mac");
  const win = data.files.filter((f) => f.os === "windows");
  const published = data.configured && data.files.length > 0;
  return (
    <div className="min-h-screen bg-canvas">
      <header className="border-b border-line">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <Link href="/" className="text-xl font-heading stretch-heading text-ink">
            ShapesOS
          </Link>
          <nav aria-label="Site" className="flex items-center gap-2">
            <Link href="/pricing" className={quietNav}>
              Pricing
            </Link>
            <Link href="/download" aria-current="page" className={quietNav}>
              Download
            </Link>
            <Link href="/login" className={quietNav}>
              Sign in
            </Link>
            <Link href="/signup" className={primaryCta}>
              Start free trial
              <ArrowRight className="size-4" aria-hidden />
            </Link>
          </nav>
        </div>
      </header>

      <main id="main-content">
        <section className="mx-auto max-w-6xl px-6 pb-10 pt-16 text-center">
          <h1 className="aos-display mx-auto max-w-3xl text-ink">ShapesOS Desktop</h1>
          <p className="mx-auto mt-4 max-w-2xl text-lg text-muted">
            The full ShapesOS in a native window, plus a voice cursor: hold a key, ask, and it answers out loud and points at
            exactly what to click — in any app. It sees your screen only while you hold the key and never stores screenshots.
          </p>
          {data.version ? <p className="mt-3 text-sm text-muted">Version {data.version}</p> : null}
        </section>

        <section aria-label="Downloads" className="mx-auto max-w-6xl px-6 pb-16">
          {published ? (
            <div className="grid gap-6 md:grid-cols-2">
              <OsCard os="mac" files={mac} />
              <OsCard os="windows" files={win} />
            </div>
          ) : (
            <div role="status" className="mx-auto max-w-xl rounded-lg bg-paper p-6 text-center shadow-hairline">
              <p className="text-base font-semibold text-ink">Desktop builds are not published yet</p>
              <p className="mt-1 text-sm text-muted">
                {data.error ?? "Use ShapesOS in your browser in the meantime. This page lists the Mac and Windows builds as soon as they are released."}
              </p>
              <Link href="/login" className={`${primaryCta} mt-4`}>
                Open ShapesOS in the browser
                <ArrowRight className="size-4" aria-hidden />
              </Link>
            </div>
          )}
        </section>
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5 text-xs text-muted">
          <span>ShapesOS Desktop — macOS and Windows</span>
          <Link href="/pricing" className="hover:text-ink">
            Pricing
          </Link>
        </div>
      </footer>
    </div>
  );
}
