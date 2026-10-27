// ShapesOS - mission plan alternatives (pixel + behaviour evidence).
// Choosing an alternative rewrites the drafted plan only: the mission stays
// planned, the old revision can't be approved, and approval is still a
// separate click. Signed-out control: 401. PNGs: test-results/mission-plan-alternatives/.

import { expect, test } from "@playwright/test";
import { gotoClean } from "./helpers";

const SHOTS = "test-results/mission-plan-alternatives";

test("choosing a plan alternative changes the draft but never starts the mission", async ({ page, browser, baseURL }) => {
  const create = await page.request.post("/api/missions", {
    data: { templateId: "home-services.booked-job-growth", goal: { metric: "booked_jobs", targetValue: 40, unit: "jobs", timeframeDays: 90, baseline: 22 } },
  });
  expect(create.status()).toBe(201);
  const { mission } = (await create.json()) as { mission: { id: string } };
  const id = mission.id;

  const before = (await (await page.request.get(`/api/missions/${id}/plan-alternatives`)).json()) as {
    currentRevision: string; costEstimate: unknown; alternatives: { id: string; revision: string; stepCount: number }[];
  };
  expect(before.costEstimate, "no cost forecast is claimed").toBeNull();
  const full = before.alternatives.find((a) => a.id === "as-templated")!;
  const drafts = before.alternatives.find((a) => a.id === "drafts-only")!;
  expect(full.revision, "a fresh draft is the full plan").toBe(before.currentRevision);
  expect(drafts.stepCount).toBeLessThan(full.stepCount);

  // Signed-out control: the route is not public (explicit empty storage state).
  const anon = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
  expect((await anon.request.get(`/api/missions/${id}/plan-alternatives`)).status()).toBe(401);
  expect((await anon.request.post(`/api/missions/${id}/plan-alternatives`, { data: { alternativeId: "drafts-only", planRevision: before.currentRevision } })).status()).toBe(401);
  await anon.close();

  await gotoClean(page, `/dashboard/missions/${id}`);
  await page.getByRole("tab", { name: "Plan" }).click();
  const card = page.getByTestId("alt-drafts-only");
  await expect(card).toBeVisible();
  await expect(page.getByTestId("alt-as-templated")).toContainText("Current plan");
  await page.screenshot({ path: `${SHOTS}/alternatives-before.png`, fullPage: true });

  await card.getByRole("button", { name: "Use this plan" }).click();
  await expect(card).toContainText("Current plan");
  await expect(page.locator("table tbody tr")).toHaveCount(drafts.stepCount);
  await expect(page.getByText("Review the plan before anything runs")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/alternatives-after.png`, fullPage: true });

  const detail = (await (await page.request.get(`/api/missions/${id}`)).json()) as { mission: { status: string } };
  expect(detail.mission.status, "choosing does not start the mission").toBe("planned");

  // The revision reviewed before the switch can no longer be approved.
  const stale = await page.request.post(`/api/missions/${id}/approve-plan`, { data: { planRevision: before.currentRevision } });
  expect(stale.status()).toBe(409);
  // A second choice from the stale revision is refused too.
  const staleChoice = await page.request.post(`/api/missions/${id}/plan-alternatives`, { data: { alternativeId: "review-first", planRevision: before.currentRevision } });
  expect(staleChoice.status()).toBe(409);
});
