// ShapesOS — Phase 18.1 (WS=find): per-user preferences against Postgres.
//   - get returns defaults until something is saved; set upserts one key
//   - ownership: one person's write never touches another's row; the route
//     reads the subject from the session only (a userId in the body is an
//     unknown key → 400)
//   - invalid values and unknown keys write nothing (all-or-nothing patch)
//   - the CHECK constraints refuse a bad value even from raw SQL
//   - PATCH /api/preferences sets the shell cookie; 401 when signed out
//   - notification channel filter (bell / push / muted kinds) + fail-open
//   - account deletion lists the table
// The session is stubbed with node:test mock.module. Listed in scripts/test/db-tests.txt.
// Run: DATABASE_URL=… npx tsx --test --experimental-test-module-mocks lib/preferences/__tests__/preferences-db.test.ts

import { describe, it, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";

const RUN = randomUUID().slice(0, 8);
const ANA = `p18pref-ana-${RUN}`;
const BEN = `p18pref-ben-${RUN}`;

let actor: { id: string; email: string; name: string } | null = { id: ANA, email: "ana@x.test", name: "Ana" };
mock.module("@/lib/session", {
  namedExports: {
    requireUser: async () => actor,
  },
});

type PrefsMod = typeof import("../index");
type Route = typeof import("@/app/api/preferences/route");
let prefs: PrefsMod;
let route: Route;

before(async () => {
  prefs = await import("../index");
  route = await import("@/app/api/preferences/route");
});

after(async () => {
  await prisma.userPreference.deleteMany({ where: { userId: { in: [ANA, BEN] } } });
  await prisma.$disconnect();
});

const patch = (body: unknown) =>
  route.PATCH(new Request("http://x/api/preferences", { method: "PATCH", body: typeof body === "string" ? body : JSON.stringify(body) }));

describe("user preferences (DB)", () => {
  it("defaults until saved, then one key at a time", async () => {
    assert.deepEqual(await prefs.getUserPreferences(ANA), prefs.DEFAULT_PREFERENCES);
    const after1 = await prefs.setUserPreference(ANA, "theme", "dark");
    assert.equal(after1.theme, "dark");
    assert.equal(after1.density, "comfortable");
    const after2 = await prefs.setUserPreference(ANA, "language", "es");
    assert.equal(after2.theme, "dark", "earlier keys kept");
    assert.equal(after2.language, "es");
    assert.equal(await prisma.userPreference.count({ where: { userId: ANA } }), 1, "one row per person");
  });

  it("the UserPrefs interface reads and writes the same store", async () => {
    await prefs.userPrefs.setUserPreference(BEN, "shortcuts", { "command_bar.open": "Mod+K" });
    assert.deepEqual((await prefs.userPrefs.getUserPreferences(BEN)).shortcuts, { "command_bar.open": "mod+k" });
  });

  it("ownership: writing Ana never changes Ben", async () => {
    const before = await prefs.getUserPreferences(BEN);
    await prefs.setUserPreferences(ANA, { density: "compact", fontScale: 125 });
    assert.deepEqual(await prefs.getUserPreferences(BEN), before);
    assert.equal((await prefs.getUserPreferences(ANA)).density, "compact");
  });

  it("invalid values and unknown keys write nothing", async () => {
    const before = await prefs.getUserPreferences(ANA);
    await assert.rejects(prefs.setUserPreferences(ANA, { theme: "light", fontScale: 999 }), prefs.PreferenceError);
    await assert.rejects(prefs.setUserPreferences(ANA, { theme: "light", userId: BEN }), /Unknown preference "userId"/);
    // @ts-expect-error runtime guard
    await assert.rejects(prefs.setUserPreference(ANA, "role", "owner"), /Unknown preference/);
    await assert.rejects(prefs.setUserPreference(ANA, "timeZone", "Nowhere/Land"), /Unknown time zone/);
    assert.deepEqual(await prefs.getUserPreferences(ANA), before, "nothing changed");
  });

  it("the CHECK constraints refuse bad values from raw SQL too", async () => {
    await assert.rejects(prisma.$executeRaw`UPDATE user_preferences SET theme = 'neon' WHERE user_id = ${ANA}`, /user_preferences_theme_check/);
    await assert.rejects(prisma.$executeRaw`UPDATE user_preferences SET font_scale = 300 WHERE user_id = ${ANA}`, /font_scale_check/);
    await assert.rejects(prisma.$executeRaw`UPDATE user_preferences SET shortcuts = '[]'::jsonb WHERE user_id = ${ANA}`, /json_check/);
  });

  it("PATCH /api/preferences acts on the session's own subject and sets the shell cookie", async () => {
    actor = { id: ANA, email: "ana@x.test", name: "Ana" };
    const res = await patch({ theme: "light", contrast: "high" });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { preferences: { theme: string; contrast: string } };
    assert.equal(body.preferences.theme, "light");
    assert.equal(body.preferences.contrast, "high");
    const cookie = res.headers.get("set-cookie") ?? "";
    assert.match(cookie, /shapes_shell=t%3Dlight%3Bc%3Dhigh|shapes_shell=t=light;c=high/);
    assert.match(cookie, /HttpOnly/i);
    assert.equal((await prefs.getUserPreferences(BEN)).contrast, "standard", "Ben untouched");

    const bad = await patch({ theme: "light", userId: BEN });
    assert.equal(bad.status, 400, "a target id in the body is refused, never honoured");
    assert.equal((await patch("{not json")).status, 400);
    assert.equal((await patch({ desktop: { x: "y".repeat(40_000) } })).status, 413);

    const get = await route.GET(new Request("http://x/api/preferences"));
    assert.equal(((await get.json()) as { preferences: { contrast: string } }).preferences.contrast, "high");

    actor = null;
    assert.equal((await patch({ theme: "dark" })).status, 401);
    assert.equal((await route.GET(new Request("http://x/api/preferences"))).status, 401);
    actor = { id: ANA, email: "ana@x.test", name: "Ana" };
  });

  it("notification channels: bell off, push off, muted kinds", async () => {
    await prefs.setUserPreference(ANA, "notifications", { inApp: true, push: false, mutedKinds: ["alert_fired"] });
    await prefs.setUserPreference(BEN, "notifications", { inApp: false, push: true, mutedKinds: [] });
    const nobody = `p18pref-nobody-${RUN}`; // never saved: defaults (everything on)
    const inputs = [ANA, BEN, nobody].flatMap((userId) => [
      { userId, kind: "approval_needed" },
      { userId, kind: "alert_fired" },
    ]);
    const bell = await prefs.filterByNotificationPrefs(inputs, "inApp");
    assert.deepEqual(
      bell.map((n) => `${n.userId === ANA ? "ana" : n.userId === BEN ? "ben" : "nobody"}:${n.kind}`).sort(),
      ["ana:approval_needed", "nobody:alert_fired", "nobody:approval_needed"],
    );
    const push = await prefs.filterByNotificationPrefs(bell, "push");
    assert.deepEqual(push.map((n) => n.userId).sort(), [nobody, nobody], "Ana switched push off");
    // A broken lookup fails open (an approval request is never swallowed).
    const broken = { userPreference: { findMany: async () => { throw new Error("db down"); } } } as never;
    assert.equal((await prefs.filterByNotificationPrefs(inputs, "inApp", broken)).length, inputs.length);
  });

  it("account deletion removes the row", async () => {
    const { PERSONAL_TABLES } = await import("@/lib/gdpr/account-delete");
    assert.ok(PERSONAL_TABLES.some((t) => t.table === "user_preferences" && t.column === "user_id"));
  });
});
