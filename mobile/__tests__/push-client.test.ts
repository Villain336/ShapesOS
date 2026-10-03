// ShapesOS mobile — push device API client + notification routing.
import { describe, expect, it } from "vitest";
import {
  PushApiError,
  listPushDevices,
  registerPushDevice,
  removePushDevice,
  tabForPushData,
  updatePushDevice,
} from "../src/push/push-client";

function recorder(status = 200, body: unknown = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (u: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(u), init: init ?? {} });
    return Response.json(body, { status });
  }) as typeof fetch;
  return { calls, opts: { baseUrl: "https://x.example.com", authHeaders: () => ({ Cookie: "authjs.session-token=t" }), fetchImpl } };
}

describe("push device client", () => {
  it("registers with the session cookie and a clipped device name", async () => {
    const r = recorder(201, { device: { id: "d1" }, pushEnabled: true });
    const res = await registerPushDevice(r.opts, { token: "ExponentPushToken[abcdefgh]", platform: "ios", deviceName: "x".repeat(200) });
    expect(res.pushEnabled).toBe(true);
    const c = r.calls[0]!;
    expect(c.url).toBe("https://x.example.com/api/mobile/push-devices");
    expect(c.init.method).toBe("POST");
    expect((c.init.headers as Record<string, string>).Cookie).toBe("authjs.session-token=t");
    const body = JSON.parse(String(c.init.body));
    expect(body).toEqual({ token: "ExponentPushToken[abcdefgh]", platform: "ios", deviceName: "x".repeat(80) });
  });

  it("lists, updates and removes with the right verbs", async () => {
    const r = recorder(200, { devices: [], pushEnabled: false, kinds: [], device: {}, removed: 1 });
    await listPushDevices(r.opts);
    await updatePushDevice(r.opts, { token: "T", enabled: false, mutedKinds: ["run_failed"] });
    await removePushDevice(r.opts, "T");
    expect(r.calls.map((c) => c.init.method)).toEqual(["GET", "PATCH", "DELETE"]);
    expect(JSON.parse(String(r.calls[1]!.init.body))).toEqual({ token: "T", enabled: false, mutedKinds: ["run_failed"] });
    expect(JSON.parse(String(r.calls[2]!.init.body))).toEqual({ token: "T" });
  });

  it("raises the server's error", async () => {
    const r = recorder(403, { error: "Forbidden" });
    await expect(listPushDevices(r.opts)).rejects.toEqual(new PushApiError(403, "Forbidden"));
  });
});

describe("tabForPushData", () => {
  it("opens the tab the notification is about", () => {
    expect(tabForPushData({ kind: "approval_needed", href: "/dashboard/approvals?source=messaging" })).toBe("approvals");
    expect(tabForPushData({ kind: "approval_decided" })).toBe("approvals");
    expect(tabForPushData({ kind: "run_failed", href: "/dashboard/runs/r1" })).toBe("missions");
    expect(tabForPushData({ href: "/dashboard/settings" })).toBeNull();
    expect(tabForPushData(undefined)).toBeNull();
  });
});
