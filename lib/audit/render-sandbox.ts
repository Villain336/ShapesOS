// ShapesOS Phase 11 (seotools): JavaScript rendering for the live audit,
// through headless Chromium inside the Phase 8 sandbox — never on the host.
//
// The renderer looks for a Chromium binary in the sandbox image once; when
// there is none (the default node:bookworm image ships without one) or the
// sandbox's egress policy can't reach the site, render() returns null and
// the crawl falls back to static HTML, saying so in its summary. Nothing is
// ever reported as JS-rendered unless Chromium actually produced the DOM.

import type { Sandbox } from "@/lib/sandbox/types";
import type { PageRenderer } from "./live";

const CHROMIUM_CANDIDATES = ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable", "headless_shell"];
const RENDER_TIMEOUT_MS = 45_000;

export function sandboxChromiumRenderer(sandbox: Sandbox): PageRenderer & { reason(): string | null } {
  let binary: string | null | undefined;
  let reason: string | null = null;

  async function findBinary(): Promise<string | null> {
    if (binary !== undefined) return binary;
    const probe = await sandbox.exec(
      `for b in ${CHROMIUM_CANDIDATES.join(" ")}; do command -v "$b" && exit 0; done; exit 1`,
      { timeoutMs: 10_000 },
    );
    binary = probe.exitCode === 0 ? probe.stdout.trim().split("\n")[0] || null : null;
    if (!binary) reason = "no headless Chromium in the sandbox image";
    return binary;
  }

  return {
    label: "Headless Chromium in the code sandbox",
    reason: () => reason,
    async render(url: string) {
      const bin = await findBinary();
      if (!bin) return null;
      const r = await sandbox.exec(
        [bin, "--headless=new", "--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--virtual-time-budget=8000", "--dump-dom", url],
        { timeoutMs: RENDER_TIMEOUT_MS, maxOutputBytes: 2 * 1024 * 1024 },
      );
      if (r.timedOut || r.exitCode !== 0 || !/<html|<body|<head/i.test(r.stdout)) {
        reason = r.timedOut ? "Chromium timed out" : `Chromium exited ${r.exitCode}${r.stderr ? `: ${r.stderr.trim().slice(0, 160)}` : ""}`;
        return null;
      }
      return { html: r.stdout };
    },
  };
}
