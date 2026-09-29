// Marketr mobile — gate route contract tests.
//
// These pin the client to the REAL route shapes:
//   GET  /api/autopilot/queue?projectId=&status=          (milestone 18)
//   GET  /api/autopilot/items/[id]?projectId=             (Phase 16 slice 3)
//   POST /api/autopilot/items/[id]/approve { projectId }  (milestone 18)
//   POST /api/autopilot/items/[id]/reject  { projectId }
//   POST /api/autopilot/items/[id]/edit { projectId, title?, draftMarkdown? }
//                                                        (Phase 16 slice 3)
//   GET  /api/missions
// If a route changes, these fail first — before a phone ever hits it.
import { describe, expect, it } from "vitest";
import { GateApiError, gateUrls } from "../src/api/gate";

const BASE = "https://marketr.example";

describe("gateUrls", () => {
  it("queue: projectId + status as query params", () => {
    expect(gateUrls.queue(BASE, "p1", "pending")).toBe(
      "https://marketr.example/api/autopilot/queue?projectId=p1&status=pending",
    );
  });
  it("queue: status is optional", () => {
    expect(gateUrls.queue(BASE, "p1")).toBe("https://marketr.example/api/autopilot/queue?projectId=p1");
  });
  it("item: id in path, projectId as query param (viewer+)", () => {
    expect(gateUrls.item(BASE, "item-9", "p1")).toBe(
      "https://marketr.example/api/autopilot/items/item-9?projectId=p1",
    );
  });
  it("approve/reject/edit: POST to the item sub-routes", () => {
    expect(gateUrls.approve(BASE, "item-9")).toBe("https://marketr.example/api/autopilot/items/item-9/approve");
    expect(gateUrls.reject(BASE, "item-9")).toBe("https://marketr.example/api/autopilot/items/item-9/reject");
    expect(gateUrls.edit(BASE, "item-9")).toBe("https://marketr.example/api/autopilot/items/item-9/edit");
  });
  it("item ids are path-encoded", () => {
    expect(gateUrls.approve(BASE, "a/b")).toContain("a%2Fb");
  });
  it("missions list route", () => {
    expect(gateUrls.missions(BASE)).toBe("https://marketr.example/api/missions");
  });
});

describe("GateApiError", () => {
  it("carries the HTTP status", () => {
    const err = new GateApiError(403, "Forbidden");
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(403);
    expect(err.message).toBe("Forbidden");
  });
});
