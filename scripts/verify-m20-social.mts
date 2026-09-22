// Marketr milestone 20 — fixture tests for social scheduling.
// Pure channel logic + mock Buffer port + mock-db dispatch paths: no live DB,
// no network, no Buffer calls, no spend.
// Tests: per-channel limits, media requirements, override resolution, UTM
// builder, idempotent dispatch, validation-before-dispatch, missing-channel
// guard, bounded retry semantics, cancel, analytics sync, calendar bucketing.
// Run: npx tsx scripts/verify-m20-social.mts

import {
  ALL_SERVICES,
  CHANNEL_DEFS,
  MAX_DISPATCH_ATTEMPTS,
  bucketPostsByDay,
  buildUtmUrl,
  nextRetryAt,
  resolveChannelContent,
  validatePostForChannels,
  type SocialContent,
} from "@/lib/social/channels";
import { MockBufferPort, isTransientBufferError } from "@/lib/social/buffer";
import {
  attemptDispatch,
  cancelPost,
  dispatchPost,
  refreshPostStatus,
  sanitizeContent as sanitize2,
  syncAnalytics,
} from "@/lib/social/service";
import type { PrismaClient } from "@prisma/client";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function text(n: number): string {
  return "x".repeat(n);
}

function baseContent(over: Partial<SocialContent> = {}): SocialContent {
  return {
    text: "Hello world",
    perChannel: {},
    media: [{ type: "image", url: "https://example.com/pic.jpg" }],
    ...over,
  };
}

// --- channel defs ----------------------------------------------------------------
check("nine channels defined", ALL_SERVICES.length === 9, String(ALL_SERVICES.length));
check("twitter limit 280", CHANNEL_DEFS.twitter.maxLength === 280);
check("threads limit 500", CHANNEL_DEFS.threads.maxLength === 500);
check("bluesky limit 300", CHANNEL_DEFS.bluesky.maxLength === 300);
check("instagram limit 2200", CHANNEL_DEFS.instagram.maxLength === 2200);
check("instagram media required", CHANNEL_DEFS.instagram.mediaRequirement === "photo_or_video");
check("tiktok video only", CHANNEL_DEFS.tiktok.mediaRequirement === "video_only");
check("youtube video only", CHANNEL_DEFS.youtube.mediaRequirement === "video_only");
check("pinterest photo only", CHANNEL_DEFS.pinterest.mediaRequirement === "photo_only");
check("linkedin media optional", CHANNEL_DEFS.linkedin.mediaRequirement === "optional");

// --- per-channel validation --------------------------------------------------------
let issues = validatePostForChannels(["twitter"], baseContent({ text: text(281) }));
check("twitter over-limit flagged", issues.length === 1 && /280/.test(issues[0].message), JSON.stringify(issues));
issues = validatePostForChannels(["twitter"], baseContent({ text: text(280) }));
check("twitter at-limit ok", issues.length === 0, JSON.stringify(issues));
issues = validatePostForChannels(["bluesky"], baseContent({ text: text(301) }));
check("bluesky over-limit flagged", issues.length === 1, JSON.stringify(issues));
issues = validatePostForChannels(["twitter"], baseContent({ text: "   " }));
check("empty text flagged", issues.length === 1 && issues[0].field === "text", JSON.stringify(issues));

issues = validatePostForChannels(["instagram"], baseContent({ text: "hi", media: [] }));
check("instagram text-only flagged", issues.length === 1 && issues[0].field === "media", JSON.stringify(issues));
issues = validatePostForChannels(["instagram"], baseContent({ text: "hi" }));
check("instagram with image ok", issues.length === 0, JSON.stringify(issues));
issues = validatePostForChannels(["tiktok"], baseContent({ text: "hi", media: [{ type: "image", url: "https://e.com/p.jpg" }] }));
check("tiktok image-only flagged", issues.length === 1, JSON.stringify(issues));
issues = validatePostForChannels(["tiktok"], baseContent({ text: "hi", media: [{ type: "video", url: "https://e.com/v.mp4" }] }));
check("tiktok with video ok", issues.length === 0, JSON.stringify(issues));
issues = validatePostForChannels(["youtube"], baseContent({ text: "hi", media: [{ type: "image", url: "https://e.com/p.jpg" }] }));
check("youtube image-only flagged", issues.length === 1, JSON.stringify(issues));
issues = validatePostForChannels(["pinterest"], baseContent({ text: "hi", media: [{ type: "video", url: "https://e.com/v.mp4" }] }));
check("pinterest video-only flagged", issues.length === 1, JSON.stringify(issues));

// --- override resolution -------------------------------------------------------------
const withOverride = baseContent({
  text: "shared",
  perChannel: { twitter: { text: "custom tweet" } },
});
check("override wins", resolveChannelContent(withOverride, "twitter").text === "custom tweet");
check("fallback to shared", resolveChannelContent(withOverride, "linkedin").text === "shared");
check("override media falls back", resolveChannelContent(withOverride, "twitter").media.length === 1);

// --- UTM builder ----------------------------------------------------------------------
check("utm appended", buildUtmUrl("https://e.com/a", { source: "buffer", medium: "social", campaign: "launch" }) === "https://e.com/a?utm_source=buffer&utm_medium=social&utm_campaign=launch");
check("utm merges with existing", (buildUtmUrl("https://e.com/a?x=1", { source: "buffer" }) ?? "").includes("x=1") && (buildUtmUrl("https://e.com/a?x=1", { source: "buffer" }) ?? "").includes("utm_source=buffer"));
check("no utm returns link", buildUtmUrl("https://e.com/a", {}) === "https://e.com/a");
check("no link returns undefined", buildUtmUrl(undefined, { source: "s" }) === undefined);
check("bad url passthrough", buildUtmUrl("not a url", { source: "s" }) === "not a url");

// --- transient classification ------------------------------------------------------------
const transient = Object.assign(new Error("x"), { status: 503 });
const rateLimited = Object.assign(new Error("x"), { status: 429 });
const badRequest = Object.assign(new Error("x"), { status: 400 });
check("503 transient", isTransientBufferError(transient));
check("429 transient", isTransientBufferError(rateLimited));
check("400 permanent", !isTransientBufferError(badRequest));
check("network error transient", isTransientBufferError(new Error("fetch failed")));
check("retry backoff increasing", nextRetryAt(2).getTime() > nextRetryAt(1).getTime());
check("max attempts 3", MAX_DISPATCH_ATTEMPTS === 3);

// --- sanitize -------------------------------------------------------------------------------
const dirty = sanitize2({ text: 42, media: [{ type: "video", url: "https://e.com/v.mp4" }, { nope: 1 }], perChannel: { twitter: { text: "t" }, bogus: { text: "x" } }, utm: { source: "s", empty: "" } });
check("sanitize coerces text", dirty.text === "");
check("sanitize drops bad media", dirty.media.length === 1 && dirty.media[0].type === "video");
check("sanitize keeps valid override", dirty.perChannel.twitter?.text === "t");
check("sanitize drops unknown service", !("bogus" in dirty.perChannel));
check("sanitize drops empty utm", !!dirty.utm && !("empty" in dirty.utm));
check("sanitizeContent alias", sanitize2({ text: "hi" }).text === "hi");

// --- mock Buffer port -----------------------------------------------------------------------
const mock = new MockBufferPort();
mock.addProfile({ id: "prof-tw", service: "twitter", formattedUsername: "@acme" });
mock.addProfile({ id: "prof-ig", service: "instagram", formattedUsername: "@acme" });
const profiles = await mock.listProfiles();
check("mock lists profiles", profiles.length === 2);
const created = await mock.createUpdate("prof-tw", { text: "hello", scheduledAt: new Date().toISOString() });
check("mock create pending", created.status === "pending" && created.id.startsWith("mock-update-"));
const nowU = await mock.createUpdate("prof-tw", { text: "now", now: true });
check("mock now sent", nowU.status === "sent");
mock.advance();
check("mock advance flips to sent", (await mock.getUpdate(created.id)).status === "sent");
mock.interactions[created.id] = { likes: 10, shares: 2, comments: 1, clicks: 5 };
const inter = await mock.getInteractions(created.id);
check("mock interactions", inter.likes === 10 && inter.clicks === 5);
await mock.deleteUpdate(created.id);
check("mock delete recorded", mock.deleted.includes(created.id));

// --- fake db for dispatch paths ---------------------------------------------------------------
interface Row { [k: string]: unknown }
function fakeDb(post: Row, channels: Row[]) {
  return {
    socialPost: {
      findUniqueOrThrow: async () => post,
      update: async ({ data }: { data: Row }) => { Object.assign(post, data); return post; },
    },
    socialChannel: {
      findMany: async () => channels,
    },
    fileChangeLog: { create: async () => {} },
  } as unknown as PrismaClient;
}

function draftRow(services: string[], content: SocialContent): Row {
  return {
    id: "post-1", projectId: "proj-1", status: "draft",
    services, content, scheduledFor: new Date(Date.now() + 3600_000),
    bufferUpdateIds: [], attempts: 0, nextAttemptAt: null, error: null,
  };
}
const chanRows = (svcs: string[]): Row[] =>
  svcs.map((s, i) => ({ id: `ch-${i}`, bufferProfileId: `prof-${s}`, service: s, enabled: true }));

// --- idempotent dispatch --------------------------------------------------------------------------
{
  const port = new MockBufferPort();
  port.addProfile({ id: "prof-twitter", service: "twitter" });
  port.addProfile({ id: "prof-linkedin", service: "linkedin" });
  const row = draftRow(["twitter", "linkedin"], baseContent());
  const db = fakeDb(row, chanRows(["twitter", "linkedin"]));
  const r1 = await dispatchPost(db, "ws-1", "proj-1", "post-1", port);
  check("dispatch creates per channel", r1.dispatched.length === 2 && !r1.alreadyDispatched, JSON.stringify(r1));
  check("status scheduled", row.status === "scheduled");
  check("attempts reset", row.attempts === 0);
  const createsAfterFirst = port.created.length;
  const r2 = await dispatchPost(db, "ws-1", "proj-1", "post-1", port);
  check("second dispatch idempotent", r2.alreadyDispatched && port.created.length === createsAfterFirst, `created=${port.created.length}`);
  check("update ids stable", JSON.stringify(r1.dispatched) === JSON.stringify(r2.dispatched));
  const r3 = await dispatchPost(db, "ws-1", "proj-1", "post-1", port);
  check("third dispatch still no-op", r3.alreadyDispatched && port.created.length === createsAfterFirst);
}

// --- validation blocks dispatch (no Buffer calls) ---------------------------------------------------
{
  const port = new MockBufferPort();
  port.addProfile({ id: "prof-twitter", service: "twitter" });
  const row = draftRow(["twitter"], baseContent({ text: text(300) }));
  const db = fakeDb(row, chanRows(["twitter"]));
  let threw = "";
  try {
    await dispatchPost(db, "ws-1", "proj-1", "post-1", port);
  } catch (e) { threw = e instanceof Error ? e.message : ""; }
  check("over-limit blocked", /280/.test(threw), threw);
  check("no buffer calls on validation failure", port.created.length === 0);
  check("status untouched on validation failure", row.status === "draft");
}

// --- missing channel guard ----------------------------------------------------------------------------
{
  const port = new MockBufferPort();
  const row = draftRow(["instagram"], baseContent());
  const db = fakeDb(row, chanRows(["twitter"]));
  let threw = "";
  try {
    await dispatchPost(db, "ws-1", "proj-1", "post-1", port);
  } catch (e) { threw = e instanceof Error ? e.message : ""; }
  check("disconnected channel blocked", /not connected or disabled/i.test(threw), threw);
  check("no buffer calls on missing channel", port.created.length === 0);
}

// --- media requirement enforced at dispatch ---------------------------------------------------------------
{
  const port = new MockBufferPort();
  const row = draftRow(["instagram"], baseContent({ text: "hi", media: [] }));
  const db = fakeDb(row, chanRows(["instagram"]));
  let threw = "";
  try {
    await dispatchPost(db, "ws-1", "proj-1", "post-1", port);
  } catch (e) { threw = e instanceof Error ? e.message : ""; }
  check("instagram media gate at dispatch", /photo or video/i.test(threw), threw);
}

// --- bounded retry semantics -------------------------------------------------------------------------------
{
  const port = new MockBufferPort();
  port.addProfile({ id: "prof-twitter", service: "twitter" });
  const row = draftRow(["twitter"], baseContent());
  const db = fakeDb(row, chanRows(["twitter"]));
  const transientErr = () => Object.assign(new Error("boom"), { status: 503 });

  port.failNext(1, transientErr);
  const a1 = await attemptDispatch(db, "ws-1", row as never, port, "system");
  check("transient 1 → retrying", a1.outcome === "retrying", a1.outcome);
  check("attempts=1", row.attempts === 1);
  check("backoff scheduled", row.nextAttemptAt instanceof Date);
  check("not failed yet", row.status === "draft");

  port.failNext(1, transientErr);
  const a2 = await attemptDispatch(db, "ws-1", row as never, port, "system");
  check("transient 2 → retrying", a2.outcome === "retrying");
  check("attempts=2", row.attempts === 2);

  port.failNext(1, transientErr);
  const a3 = await attemptDispatch(db, "ws-1", row as never, port, "system");
  check("transient 3 → failed (cap)", a3.outcome === "failed", a3.outcome);
  check("status failed", row.status === "failed");
  check("no more retries scheduled", row.nextAttemptAt === null);
  check("error recorded", typeof row.error === "string" && row.error.length > 0);
}

{
  // Permanent error fails immediately without consuming retries.
  const port = new MockBufferPort();
  port.addProfile({ id: "prof-twitter", service: "twitter" });
  const row = draftRow(["twitter"], baseContent());
  const db = fakeDb(row, chanRows(["twitter"]));
  port.failNext(1, () => Object.assign(new Error("bad profile"), { status: 400 }));
  const a = await attemptDispatch(db, "ws-1", row as never, port, "system");
  check("permanent → failed immediately", a.outcome === "failed" && row.attempts === 1, a.outcome);
  check("permanent sets failed status", row.status === "failed");
}

// --- cancel removes pending updates ---------------------------------------------------------------------------
{
  const port = new MockBufferPort();
  port.addProfile({ id: "prof-twitter", service: "twitter" });
  const row = draftRow(["twitter"], baseContent());
  const db = fakeDb(row, chanRows(["twitter"]));
  await dispatchPost(db, "ws-1", "proj-1", "post-1", port);
  const updateId = (row.bufferUpdateIds as Array<{ updateId: string }>)[0].updateId;
  await cancelPost(db, "ws-1", "post-1", port, "system");
  check("cancel deletes buffer update", port.deleted.includes(updateId));
  check("cancel sets status", row.status === "cancelled");
}

// --- refresh + analytics ----------------------------------------------------------------------------------------------
{
  const port = new MockBufferPort();
  port.addProfile({ id: "prof-twitter", service: "twitter" });
  const row = draftRow(["twitter"], baseContent());
  const db = fakeDb(row, chanRows(["twitter"]));
  await dispatchPost(db, "ws-1", "proj-1", "post-1", port);
  const before = await refreshPostStatus(db, "ws-1", "post-1", port, "system");
  check("pending stays scheduled", before.status === "scheduled" && before.sentCount === 0);
  port.advance();
  const after = await refreshPostStatus(db, "ws-1", "post-1", port, "system");
  check("sent updates mark post sent", after.status === "sent" && after.sentCount === 1, JSON.stringify(after));
  const updateId = (row.bufferUpdateIds as Array<{ updateId: string }>)[0].updateId;
  port.interactions[updateId] = { likes: 7, shares: 1, comments: 0, clicks: 3 };
  const stats = await syncAnalytics(db, "ws-1", "post-1", port, "system") as { totals: Record<string, number> };
  check("analytics totals", stats.totals.likes === 7 && stats.totals.clicks === 3, JSON.stringify(stats.totals));
  check("analytics persisted", (row.stats as typeof stats).totals.shares === 1);
}

// --- calendar bucketing ----------------------------------------------------------------------------------------------------
{
  const posts = [
    { id: "a", scheduledFor: "2026-10-05T12:00:00Z", services: ["twitter"] as never[], status: "scheduled" },
    { id: "b", scheduledFor: "2026-10-05T18:00:00Z", services: ["instagram"] as never[], status: "sent" },
    { id: "c", scheduledFor: "2026-10-20T09:00:00Z", services: ["tiktok"] as never[], status: "draft" },
    { id: "d", scheduledFor: "2026-11-01T09:00:00Z", services: ["twitter"] as never[], status: "scheduled" },
    { id: "e", scheduledFor: null, services: ["twitter"] as never[], status: "draft" },
  ];
  const b = bucketPostsByDay(posts, 2026, 10);
  check("two posts on oct 5", (b.days.get(5) ?? []).length === 2);
  check("one post on oct 20", (b.days.get(20) ?? []).length === 1);
  check("out-of-month + unscheduled counted", b.outOfMonth === 2, String(b.outOfMonth));
  check("no phantom days", b.days.size === 2);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
