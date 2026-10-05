// ShapesOS — Expo push client (Phase 4b). Pure; fetch is mocked.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  EXPO_MAX_PER_REQUEST,
  EXPO_PUSH_SEND_URL,
  ExpoPushRequestError,
  isExpoPushToken,
  pushProvider,
  sendExpoPush,
  type ExpoPushMessage,
} from "../expo";
import { pushMessageFor, pushNotifications, queuePushForNotifications } from "../notify";

const msg = (i: number): ExpoPushMessage => ({ to: `ExponentPushToken[tok${String(i).padStart(6, "0")}]`, title: `t${i}` });

describe("isExpoPushToken", () => {
  it("accepts both documented prefixes and rejects everything else", () => {
    assert.ok(isExpoPushToken("ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]"));
    assert.ok(isExpoPushToken("ExpoPushToken[abcdefgh_-12]"));
    assert.ok(!isExpoPushToken("ExponentPushToken[]"));
    assert.ok(!isExpoPushToken("ExponentPushToken[short]"));
    assert.ok(!isExpoPushToken("fcm:abcdefghijklmnop"));
    assert.ok(!isExpoPushToken("ExponentPushToken[abc def ghi]"));
    assert.ok(!isExpoPushToken(42));
  });
});

describe("pushProvider", () => {
  it("is off unless PUSH_PROVIDER=expo", () => {
    assert.equal(pushProvider({} as NodeJS.ProcessEnv), "off");
    assert.equal(pushProvider({ PUSH_PROVIDER: "fcm" } as unknown as NodeJS.ProcessEnv), "off");
    assert.equal(pushProvider({ PUSH_PROVIDER: " Expo " } as unknown as NodeJS.ProcessEnv), "expo");
  });
});

describe("sendExpoPush", () => {
  it("POSTs JSON arrays of at most 100 to the documented endpoint and keeps ticket order", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      const body = JSON.parse(String(init.body)) as ExpoPushMessage[];
      return Response.json({
        data: body.map((m) =>
          m.title === "t3"
            ? { status: "error", message: "gone", details: { error: "DeviceNotRegistered" } }
            : { status: "ok", id: `id-${m.title}` },
        ),
      });
    };
    const messages = Array.from({ length: EXPO_MAX_PER_REQUEST + 5 }, (_, i) => msg(i));
    const tickets = await sendExpoPush(messages, { fetchImpl, accessToken: "secret-token" });
    assert.equal(seen.length, 2);
    assert.equal(seen[0]!.url, EXPO_PUSH_SEND_URL);
    assert.equal(seen[0]!.init.method, "POST");
    const headers = seen[0]!.init.headers as Record<string, string>;
    assert.equal(headers["content-type"], "application/json");
    assert.equal(headers.authorization, "Bearer secret-token");
    assert.equal((JSON.parse(String(seen[0]!.init.body)) as unknown[]).length, 100);
    assert.equal((JSON.parse(String(seen[1]!.init.body)) as unknown[]).length, 5);
    assert.equal(tickets.length, 105);
    assert.deepEqual(tickets[0], { status: "ok", id: "id-t0" });
    assert.equal(tickets[3]!.status, "error");
    assert.equal(tickets[3]!.status === "error" && tickets[3]!.details?.error, "DeviceNotRegistered");
  });

  it("omits the Authorization header without an access token", async () => {
    let headers: Record<string, string> = {};
    await sendExpoPush([msg(1)], {
      fetchImpl: async (_u, init) => {
        headers = init.headers as Record<string, string>;
        return Response.json({ data: [{ status: "ok", id: "x" }] });
      },
    });
    assert.equal(headers.authorization, undefined);
  });

  it("throws ExpoPushRequestError on request-level failures", async () => {
    await assert.rejects(
      sendExpoPush([msg(1)], {
        fetchImpl: async () => Response.json({ errors: [{ code: "PUSH_TOO_MANY_NOTIFICATIONS" }] }, { status: 400 }),
      }),
      (e: unknown) => e instanceof ExpoPushRequestError && /PUSH_TOO_MANY_NOTIFICATIONS/.test(e.message),
    );
    await assert.rejects(
      sendExpoPush([msg(1)], { fetchImpl: async () => new Response("<html>", { status: 502 }) }),
      ExpoPushRequestError,
    );
    await assert.rejects(
      sendExpoPush([msg(1)], {
        fetchImpl: async () => {
          throw new Error("ECONNRESET");
        },
      }),
      ExpoPushRequestError,
    );
  });

  it("treats a malformed ticket as an error ticket", async () => {
    const [t] = await sendExpoPush([msg(1)], { fetchImpl: async () => Response.json({ data: [{ nonsense: true }] }) });
    assert.equal(t!.status, "error");
  });
});

describe("push messages", () => {
  it("carry the in-app link and clip long text", () => {
    const m = pushMessageFor(
      {
        workspaceId: "ws",
        userId: "u",
        kind: "run_failed",
        title: "x".repeat(300),
        body: "y".repeat(500),
        href: "/dashboard/runs/r1",
        sourceType: "agent_run",
        sourceId: "r1",
      },
      "ExponentPushToken[abcdefgh]",
    );
    assert.equal(m.title.length, 120);
    assert.equal(m.body!.length, 180);
    assert.equal(m.priority, "high");
    assert.deepEqual(m.data, { kind: "run_failed", workspaceId: "ws", href: "/dashboard/runs/r1", sourceType: "agent_run", sourceId: "r1" });
  });

  it("delivery is a no-op without PUSH_PROVIDER (no DB, no network)", async () => {
    let touched = false;
    const res = await pushNotifications(
      [{ workspaceId: "ws", userId: "u", kind: "approval_needed", title: "t" }],
      {
        env: {} as NodeJS.ProcessEnv,
        fetchImpl: async () => {
          touched = true;
          return Response.json({});
        },
        scope: async () => {
          touched = true;
          throw new Error("no db");
        },
      },
    );
    assert.equal(res.skipped, "disabled");
    queuePushForNotifications([{ workspaceId: "ws", userId: "u", kind: "approval_needed", title: "t" }], {
      env: {} as NodeJS.ProcessEnv,
    });
    assert.equal(touched, false);
  });

  it("only the push kinds are sent", async () => {
    const res = await pushNotifications(
      [{ workspaceId: "ws", userId: "u", kind: "invite_accepted", title: "t" }],
      { env: { PUSH_PROVIDER: "expo" } as unknown as NodeJS.ProcessEnv },
    );
    assert.equal(res.skipped, "no_kinds");
  });

  it("never throws when the device lookup fails", async () => {
    const res = await pushNotifications(
      [{ workspaceId: "ws", userId: "u", kind: "approval_needed", title: "t" }],
      {
        env: { PUSH_PROVIDER: "expo" } as unknown as NodeJS.ProcessEnv,
        scope: async () => {
          throw new Error("db down");
        },
      },
    );
    assert.equal(res.sent, 0);
  });
});
