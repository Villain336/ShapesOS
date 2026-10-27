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

    // The approved run executes on the deterministic (mock-mode) executors. It must reach its
    // expected terminal state: every executor step runs (the planner's follow-up scheduler step
    // included), none records an error, and it stops at the human approval step. A step error is
    // a failure here, not something to screenshot around.
    type Ev = { step: string | null; tool: string | null; observation: Record<string, unknown> };
    let events: Ev[] = [];
    await expect
      .poll(
        async () => {
          const r = await page.request.get(`/api/missions/${mission.id}`);
          events = ((await r.json()) as { events: Ev[] }).events ?? [];
          return events.some((e) => e.step === "mission.awaiting_human");
        },
        { message: "approved mission reaches its human approval step", timeout: 30000, intervals: [500, 1000] },
      )
      .toBe(true);
    const errored = events.filter((e) => /\.error$/.test(e.step ?? "")).map((e) => `${e.step}: ${JSON.stringify(e.observation)}`);
    expect(errored, "no executor step errored").toEqual([]);
    const ran = events.filter((e) => /^exec\.\d+$/.test(e.step ?? "")).map((e) => e.tool);
    for (const executor of ["researcher", "planner", "drafter", "analyst", "scheduler"]) {
      expect(ran, `the ${executor} step ran`).toContain(executor);
    }

    // The header accounts for what ran: three of the plan's eight steps are done (the rest wait behind
    // the approval step), progress is plan progress, and the no-model executors' cost estimate is not
    // shown as money spent.
    const after = (await (await page.request.get(`/api/missions/${mission.id}`)).json()) as {
      completedSteps: number;
      planStepCount: number;
      progress: number;
      totalCostCents: number;
      estimatedCostCents: number;
    };
    expect(after.completedSteps, "plan steps done").toBe(3);
    expect(after.planStepCount, "plan steps").toBe(8);
    expect(after.progress, "progress is plan progress").toBeCloseTo(3 / 8, 5);
    expect(after.estimatedCostCents, "mock-mode executor cost is flagged as an estimate").toBe(after.totalCostCents);

    // Settled viewport capture: reload so no toast is on screen, then wait for the page to idle.
    await gotoClean(page, `/dashboard/missions/${mission.id}`);
    await expect(page.getByText("Mission timeline")).toBeVisible();
    await expect(page.getByText("38% of plan · 3/8 steps")).toBeVisible();
    await expect(page.getByText("estimated, nothing billed")).toBeVisible();
    await expect(page.getByText("of goal")).toHaveCount(0);
    await expect(page.locator("p", { hasText: "of plan" })).not.toContainText("spent");
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${SHOTS}/approved-mission-settled.png` });
  });
});
