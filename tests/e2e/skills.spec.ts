// Marketr — E2E: skill installation (Phase A, fix 3).
// (d) Install a skill from a URL with commit-SHA pinning (against the local
// E2E skill fixture — never the network), and install via SKILL.md upload.
// Both write skill_installed audit rows.

import { test, expect } from "@playwright/test";
import { gotoClean, loadIds, expectAudit, nowIso } from "./helpers";

const SKILL_MD = `---
name: e2e-upload-skill
description: Fixture skill installed via SKILL.md upload in the E2E suite.
version: 1.0.0
---

# E2E Upload Skill

Uploaded, not fetched.
`;

test.describe("skill installation", () => {
  test("URL install with SHA pinning", async ({ page }) => {
    const { workspaceId } = loadIds();
    const since = nowIso();
    await gotoClean(page, "/dashboard/settings/skills");

    const fixtureUrl = `${process.env.E2E_BASE_URL ?? "http://localhost:3000"}/api/e2e/skill-fixture/SKILL.md`;

    // 1. Preview the URL → server fetches + hashes the SKILL.md.
    const preview = await page.request.post("/api/skills/preview-url", {
      data: { workspaceId, url: fixtureUrl },
    });
    expect(preview.status(), "POST /api/skills/preview-url").toBe(200);
    const pv = (await preview.json()) as { name: string; sha: string };
    expect(pv.name).toBe("e2e-test-skill");
    expect(pv.sha, "preview returns a SHA").toBeTruthy();

    // 2. Install with the SHA → pin verified server-side.
    const install = await page.request.post("/api/skills", {
      data: { workspaceId, source: "url", url: fixtureUrl, sha: pv.sha },
    });
    expect(install.status(), "POST /api/skills (url)").toBe(201);

    // 3. A mismatched SHA is rejected with 409 — the pinning actually pins.
    const stale = await page.request.post("/api/skills", {
      data: {
        workspaceId,
        source: "url",
        url: fixtureUrl,
        sha: "deadbeef".repeat(8),
      },
    });
    expect(stale.status(), "POST /api/skills with stale SHA").toBe(409);

    // 4. The installed skill is listed.
    const list = await page.request.get(
      `/api/skills?workspaceId=${encodeURIComponent(workspaceId)}`,
    );
    expect(list.status()).toBe(200);
    const listed = (await list.json()) as { skills: Array<{ name: string }> };
    expect(listed.skills.map((s) => s.name)).toContain("e2e-test-skill");

    await expectAudit(page, { workspaceId, action: "skill_installed", since });
  });

  test("SKILL.md upload install", async ({ page }) => {
    const { workspaceId } = loadIds();
    const since = nowIso();
    await gotoClean(page, "/dashboard/settings/skills");

    const res = await page.request.post("/api/skills", {
      data: { workspaceId, source: "upload", skillMd: SKILL_MD, filename: "SKILL.md" },
    });
    expect(res.status(), "POST /api/skills (upload)").toBe(201);
    const body = (await res.json()) as { skill: { name: string } };
    expect(body.skill.name).toBe("e2e-upload-skill");

    await expectAudit(page, { workspaceId, action: "skill_installed", since });
  });
});
