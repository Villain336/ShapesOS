// ShapesOS — mission whole-plan approval gate (pixel evidence).
//
// A mission drafted via POST /api/missions must hold at "planned" with the
// review banner + approve action rendered, and nothing queued. Approving the
// whole plan from the banner is what starts the mission. The PNGs land in
// test-results/mission-plan-gate/ and upload with the playwright-report
// artifact, like tests/e2e/visual-gate.spec.ts.

import { expect, test } from "@playwright/test";
import { gotoClean, loadIds } from "./helpers";

const SHOTS = "test-results/mission-plan-gate";

test.describe("mission plan gate", () => {
  test("a drafted mission holds at planned until a person approves the whole plan", async ({ page }) => {
    loadIds(); // validates the seed ids file exists (workspace comes from the session)
    const create = await page.request.post("/api/missions", {
      data: {
        templateId: "home-services.booked-job-growth",
        goal: { metric: "booked_jobs", targetValue: 40, unit: "jobs", timeframeDays: 90, baseline: 22 },
      },
    });
    expect(create.status(), "mission draft created").toBe(201);
    const { mission, awaitingPlanApproval } = (await create.json()) as {
      mission: { id: string; status: string };
      awaitingPlanApproval: boolean;
    };
    expect(awaitingPlanApproval, "draft flags that it awaits plan approval").toBe(true);
    expect(mission.status, "draft holds at planned").toBe("planned");

    await gotoClean(page, `/dashboard/missions/${mission.id}`);
    const bannerTitle = page.getByText("Review the plan before anything runs");
    await expect(bannerTitle).toBeVisible();
    const approve = page.getByRole("button", { name: "Approve plan and start" });
    await expect(approve).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/planned-mission-banner.png`, fullPage: true });

    // The plan under review: the Plan tab renders the complete drafted
    // snapshot - the same planSnapshot the approve call fingerprints via
    // planRevision, so what is shown here is exactly what approval binds to.
    const detail = await page.request.get(`/api/missions/${mission.id}`);
    expect(detail.status(), "mission detail readable").toBe(200);
    const detailJson = (await detail.json()) as { mission: { planSnapshot: { steps?: unknown[] } } };
    const plannedSteps = detailJson.mission.planSnapshot.steps?.length ?? 0;
    expect(plannedSteps, "drafted plan has steps").toBeGreaterThan(0);
    await page.getByRole("tab", { name: "Plan" }).click();
    await expect(page.locator("table tbody tr")).toHaveCount(plannedSteps);
    await page.screenshot({ path: `${SHOTS}/planned-mission-plan-tab.png`, fullPage: true });

    await approve.click();
    await expect(bannerTitle).toBeHidden({ timeout: 15000 });
    await page.screenshot({ path: `${SHOTS}/approved-mission.png`, fullPage: true });
  });
});
