// ShapesOS - side-by-side comparison of the declared plan variants (pixel + behaviour evidence).
// Template variants, not independent runs: the panel says so and makes no cost claim.
// PNGs: test-results/mission-plan-compare/.

import { expect, test } from "@playwright/test";
import { gotoClean } from "./helpers";

const SHOTS = "test-results/mission-plan-compare";

test("the plan variants can be compared step by step, labelled as variants", async ({ page }) => {
  const create = await page.request.post("/api/missions", {
    data: { templateId: "home-services.booked-job-growth", goal: { metric: "booked_jobs", targetValue: 40, unit: "jobs", timeframeDays: 90, baseline: 22 } },
  });
  expect(create.status()).toBe(201);
  const id = ((await create.json()) as { mission: { id: string } }).mission.id;

  const data = (await (await page.request.get(`/api/missions/${id}/plan-alternatives`)).json()) as {
    alternatives: { id: string; stepCount: number; steps: { key: string; tier: number }[] }[];
  };
  const full = data.alternatives.find((a) => a.id === "as-templated")!;
  const drafts = data.alternatives.find((a) => a.id === "drafts-only")!;
  expect(full.steps).toHaveLength(full.stepCount);
  const leftOut = full.steps.filter((s) => !drafts.steps.some((d) => d.key === s.key));
  expect(leftOut.length).toBeGreaterThan(0);

  await gotoClean(page, `/dashboard/missions/${id}`);
  await page.getByRole("tab", { name: "Plan" }).click();
  const panel = page.getByTestId("plan-compare");
  await expect(panel).toBeVisible();
  await panel.getByText("Compare steps side by side").click();
  const table = panel.getByRole("table", { name: "Plan variants compared" });
  await expect(table).toBeVisible();
  await expect(panel).toContainText("not independent");
  await expect(table.getByRole("row")).toHaveCount(full.steps.length + 1);
  for (const s of leftOut) {
    await expect(panel.getByTestId(`compare-row-${s.key}`)).toContainText("Not in this variant");
  }
  await expect(panel).toContainText("no time or cost estimate");
  await panel.scrollIntoViewIfNeeded();
  await panel.screenshot({ path: `${SHOTS}/compare-open.png` });

  // Comparing changes nothing: the mission is still the unstarted draft.
  const detail = (await (await page.request.get(`/api/missions/${id}`)).json()) as { mission: { status: string } };
  expect(detail.mission.status).toBe("planned");

  // Narrow viewport: the controls stay reachable and nothing in the table is clipped off-screen.
  await page.setViewportSize({ width: 390, height: 844 });
  await panel.scrollIntoViewIfNeeded();
  await expect(table).toBeVisible();
  const box = await table.boundingBox();
  expect(box, "table has a box").not.toBeNull();
  expect(box!.x + box!.width, "table fits the viewport width").toBeLessThanOrEqual(390 + 1);
  await panel.getByText("Compare steps side by side").click();
  await expect(table).toBeHidden();
  await panel.getByText("Compare steps side by side").click();
  await expect(table).toBeVisible();
  await panel.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/compare-narrow-viewport.png` });
});
