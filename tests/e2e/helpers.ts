// Marketr — shared Playwright E2E helpers (Phase A, fix 3).
//
// Every spec asserts the same three things:
//   1. HTTP 200s on the pages/APIs it touches,
//   2. no page console errors / failed requests,
//   3. audit rows were written where the app writes them (via the app's own
//      /api/settings/audit endpoint — no DB access from the specs).

import { expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface E2EIds {
  workspaceId: string;
  projectId: string;
}

export function loadIds(): E2EIds {
  // Playwright runs from the repo root (see scripts/e2e/run.sh); the seed
  // writes scripts/e2e/.e2e-ids.json. No import.meta — the package is CJS.
  const p = join(process.cwd(), "scripts", "e2e", ".e2e-ids.json");
  return JSON.parse(readFileSync(p, "utf-8")) as E2EIds;
}

/** Navigate and assert: HTTP 200 + no console errors + no failed requests. */
export async function gotoClean(page: Page, path: string) {
  const errors: string[] = [];
  const failed: string[] = [];
  // Drop listeners from previous navigations: a new page.goto() aborts the
  // old page's in-flight RSC prefetches, and those aborts must not be
  // attributed to the new page.
  page.removeAllListeners("pageerror");
  page.removeAllListeners("console");
  page.removeAllListeners("requestfailed");
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console.error: ${m.text()}`);
  });
  page.on("requestfailed", (r) =>
    failed.push(`${r.method()} ${r.url()} :: ${r.failure()?.errorText}`),
  );

  const res = await page.goto(path, { waitUntil: "networkidle" });
  expect(res, `GET ${path} returned a response`).not.toBeNull();
  expect(res!.status(), `GET ${path} status`).toBe(200);
  expect(errors, `page/console errors on ${path}`).toEqual([]);
  // Failed-request check. Two benign signatures are ignored:
  // - favicon.ico 404s (no favicon shipped in this build), and
  // - Next.js `?_rsc=` prefetch requests aborted with net::ERR_ABORTED.
  //   The App Router prefetches <Link> targets best-effort and cancels those
  //   fetches whenever router state changes; the cancellations are invisible
  //   to users and say nothing about the page under test. Anything else that
  //   fails to load still fails the test.
  const realFailed = failed.filter(
    (f) => !f.includes("favicon.ico") && !(f.includes("?_rsc=") && f.includes("ERR_ABORTED")),
  );
  expect(realFailed, `failed requests on ${path}`).toEqual([]);
}

/**
 * Assert that an audit row for `action` was written in this workspace at or
 * after `since` (ISO string). Uses the app's own audit API (admin+).
 */
export async function expectAudit(
  page: Page,
  opts: { workspaceId: string; action: string; since: string },
) {
  const { workspaceId, action, since } = opts;
  const res = await page.request.get(
    `/api/settings/audit?workspaceId=${encodeURIComponent(workspaceId)}&action=${encodeURIComponent(action)}`,
  );
  expect(res.status(), `GET /api/settings/audit?action=${action}`).toBe(200);
  const body = (await res.json()) as {
    events: Array<{ action: string; createdAt: string; summary: string }>;
  };
  const fresh = body.events.filter((e) => e.createdAt >= since);
  expect(
    fresh.length,
    `expected a fresh "${action}" audit row since ${since} (got ${body.events.length} total)`,
  ).toBeGreaterThan(0);
  return fresh[0];
}

export function nowIso(): string {
  return new Date().toISOString();
}
