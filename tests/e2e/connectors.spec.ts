// Marketr — E2E: connectors (Phase A, fix 3).
// (c) Connector connect flows — always against LOCAL endpoints, never a live
// service:
//   1. API-key connect (DataForSEO) via the real route: encrypted vault
//      storage + connector_connected audit row.
//   2. Full OAuth round-trip via the E2E mock provider (E2E_MOCK_OAUTH=1):
//      auth-url → mock authorize → callback → token exchange → connection row
//      + connector_connected audit row. Drives the real ConnectorsManager UI.

import { test, expect } from "@playwright/test";
import { gotoClean, loadIds, expectAudit, nowIso } from "./helpers";

test.describe("connectors", () => {
  test("API-key connect stores an encrypted credential and is audited", async ({
    page,
  }) => {
    const { workspaceId } = loadIds();
    const since = nowIso();
    await gotoClean(page, "/dashboard/settings/connectors");

    const res = await page.request.post(
      `/api/connectors/dataforseo/api-key?workspaceId=${encodeURIComponent(workspaceId)}`,
      {
        data: {
          workspaceId,
          apiKey: "e2e-fake-key",
          label: "E2E DataForSEO",
        },
      },
    );
    expect(res.status(), "POST /api/connectors/dataforseo/api-key").toBe(201);
    const body = (await res.json()) as {
      connection: { id: string; status: string };
    };
    expect(body.connection.id).toBeTruthy();
    expect(body.connection.status).toBe("active");

    // The key is never returned by the API.
    const list = await page.request.get(
      `/api/connectors?workspaceId=${encodeURIComponent(workspaceId)}`,
    );
    expect(list.status()).toBe(200);
    const listBody = (await list.json()) as { connectors: unknown[] };
    expect(JSON.stringify(listBody)).not.toContain("e2e-fake-key");

    await expectAudit(page, { workspaceId, action: "connector_connected", since });
  });

  test("mock OAuth round-trip connects and is audited", async ({ page }) => {
    const { workspaceId } = loadIds();
    const since = nowIso();
    await gotoClean(page, "/dashboard/settings/connectors");

    // The mock provider card is only registered with E2E_MOCK_OAUTH=1.
    const card = page.getByTestId("connector-card-mock-oauth");
    await expect(card).toBeVisible({ timeout: 10000 });

    // Clicking Connect navigates the whole tab through:
    // auth-url → mock authorize → callback → settings?connected=mock-oauth
    await Promise.all([
      page.waitForURL("**/dashboard/settings/connectors?connected=mock-oauth", {
        timeout: 20000,
      }),
      card.getByRole("button", { name: "Connect", exact: true }).click(),
    ]);

    await expect(
      page.getByText('Connected "mock-oauth" — the OAuth flow finished.'),
    ).toBeVisible({ timeout: 10000 });

    await expectAudit(page, { workspaceId, action: "connector_connected", since });
  });
});
