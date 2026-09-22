// Marketr — E2E: chat file attach (Phase A, fix 3).
// (e) The chat attach flow: hidden file input → multipart POST
// /api/projects/[id]/files → staged chip in the composer → file_attached
// audit row. Uses the real AttachmentMenu UI on the assistant page.

import { test, expect } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gotoClean, loadIds, expectAudit, nowIso } from "./helpers";

test.describe("chat file attach", () => {
  test("upload stages a chip and is audited", async ({ page }) => {
    const { projectId, workspaceId } = loadIds();
    const since = nowIso();

    await gotoClean(page, `/dashboard/assistant?project=${projectId}`);

    // The attach menu only renders for editors; the E2E admin is owner.
    const attachBtn = page.getByRole("button", { name: "Attach a file" });
    await expect(attachBtn).toBeVisible({ timeout: 15000 });

    const tmpFile = join(tmpdir(), "e2e-attach.txt");
    writeFileSync(tmpFile, "E2E attachment fixture: plain-text brief.\n");

    const uploadRes = page.waitForResponse(
      (r) =>
        r.url().includes(`/api/projects/${projectId}/files`) &&
        r.request().method() === "POST",
    );
    // The input is visually hidden (triggered via the dropdown); Playwright
    // can set files on it directly.
    await page.setInputFiles('input[type="file"]', tmpFile);
    const res = await uploadRes;
    expect(res.status(), "POST /api/projects/[id]/files").toBe(201);

    // Staged chip with the filename appears above the composer.
    await expect(page.getByText("e2e-attach.txt").first()).toBeVisible({
      timeout: 10000,
    });

    // The file is listed by the files API.
    const list = await page.request.get(`/api/projects/${projectId}/files`);
    expect(list.status()).toBe(200);
    const listed = (await list.json()) as { files: Array<{ filename: string }> };
    expect(listed.files.map((f) => f.filename)).toContain("e2e-attach.txt");

    await expectAudit(page, { workspaceId, action: "file_attached", since });
  });
});
