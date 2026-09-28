// Marketr — Wave B slice 1 fixture tests: single Postiz-centered social entry.
// No live DB, no network, no Postiz calls, no spend.
// Tests:
//   1. queuePostizDraft payload contract — the helper hardcodes type "draft"
//      (draft-first is load-bearing; publishing happens only via human action
//      in Postiz / the Social tab).
//   2. Payload shape — per-channel integration ids, trimmed content, guards
//      (empty content / no channels rejected).
//   3. send-to-social route input — channelIds required (1..30), text required.
// Run: npx tsx scripts/verify-waveb-social.mts

import {
  buildPostizPayload,
  schedulePostizPost,
  uploadPostizMediaFromUrl,
} from "@/lib/integrations/postiz";
import { BodySchema } from "@/app/api/ads/creatives/[id]/send-to-social/route";

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

// ── 1. Draft-first payload contract ──────────────────────────────────────
// This mirrors exactly what queuePostizDraft passes to schedulePostizPost:
// type is the literal "draft" — no parameter, no smuggling.
const draftPayload = buildPostizPayload({
  type: "draft",
  content: "  Hello social  ",
  channelIds: ["ch_1", "ch_2"],
  platformTypes: { ch_1: "x", ch_2: "linkedin" },
}) as Record<string, unknown>;
check("draft payload type is draft", draftPayload.type === "draft");
check("draft payload never now/schedule", draftPayload.type !== "now" && draftPayload.type !== "schedule");
const posts = draftPayload.posts as Array<{ integration: { id: string } }>;
check("draft payload has per-channel entries", posts.length === 2);
check(
  "draft payload carries integration ids",
  posts[0].integration.id === "ch_1" && posts[1].integration.id === "ch_2",
);
const values = (draftPayload.posts as Array<{ value: Array<{ content: string }> }>)[0].value;
check("draft payload trims content", values[0].content === "Hello social");

// ── 2. Payload guards ────────────────────────────────────────────────────
let threw = false;
try {
  buildPostizPayload({ type: "draft", content: "   ", channelIds: ["ch_1"] });
} catch {
  threw = true;
}
check("empty content rejected", threw);

threw = false;
try {
  buildPostizPayload({ type: "draft", content: "hi", channelIds: [] });
} catch {
  threw = true;
}
check("no channels rejected", threw);

// ── 3. send-to-social route input ────────────────────────────────────────
const ok = BodySchema.safeParse({
  projectId: "proj_1",
  text: "New creative is live",
  channelIds: ["ch_1"],
  platformTypes: { ch_1: "x" },
});
check("valid send-to-social body passes", ok.success);

const missingChannels = BodySchema.safeParse({ projectId: "proj_1", text: "hi", channelIds: [] });
check("empty channelIds rejected", !missingChannels.success);

const noChannels = BodySchema.safeParse({ projectId: "proj_1", text: "hi" });
check("missing channelIds rejected", !noChannels.success);

const tooMany = BodySchema.safeParse({
  projectId: "proj_1",
  text: "hi",
  channelIds: Array.from({ length: 31 }, (_, i) => `ch_${i}`),
});
check("channelIds capped at 30", !tooMany.success);

const legacyServices = BodySchema.safeParse({ projectId: "proj_1", text: "hi", services: ["twitter"] });
check("legacy services-only body rejected", !legacyServices.success);

const emptyText = BodySchema.safeParse({ projectId: "proj_1", text: "  ", channelIds: ["ch_1"] });
check("blank text rejected", !emptyText.success);

// ── 4. Media passthrough (Wave B: ad creative / studio asset attachment) ──
// Postiz requires its own hosted media URLs — upload-from-url first, then
// the returned { id, path } goes into the post payload's image array.
const mediaPayload = buildPostizPayload({
  type: "draft",
  content: "with media",
  channelIds: ["ch_1"],
  images: [
    { id: "upl_1", path: "https://uploads.postiz.com/upl_1.png" },
    { path: "https://uploads.postiz.com/upl_2.mp4" },
  ],
}) as Record<string, unknown>;
const mediaImages = (
  (mediaPayload.posts as Array<{ value: Array<{ image: unknown[] }> }>)[0].value[0].image as Array<{
    id?: string;
    path: string;
  }>
);
check("payload carries uploaded media", mediaImages.length === 2);
check(
  "media entries keep id+path",
  mediaImages[0].id === "upl_1" && mediaImages[0].path === "https://uploads.postiz.com/upl_1.png",
);
check("media entry without id still works", mediaImages[1].path === "https://uploads.postiz.com/upl_2.mp4");

// Stub the Postiz sidecar: URL-aware — uploads return { id, path }, posts return a draft id.
const calls: string[] = [];
let lastPostBody: Record<string, unknown> | null = null;
{
  const g = globalThis as unknown as { fetch: typeof fetch };
  g.fetch = (async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    calls.push(u);
    if (u.includes("/upload-from-url")) {
      const { url: mediaUrl } = JSON.parse(String(init?.body ?? "{}")) as { url: string };
      return {
        ok: true,
        json: async () => ({ id: "upl_9", path: `https://uploads.postiz.com/upl_9-${mediaUrl.endsWith(".mp4") ? "v" : "i"}` }),
      } as Response;
    }
    lastPostBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    return { ok: true, json: async () => ({ id: "draft_media" }) } as Response;
  }) as typeof fetch;
  process.env.POSTIZ_URL = "https://postiz.example.com";
  process.env.POSTIZ_API_KEY = "test-key";
}

const uploaded = await uploadPostizMediaFromUrl("https://cdn.example.com/creative.png");
check("upload-from-url returns media ref", uploaded.id === "upl_9" && uploaded.path.includes("uploads.postiz.com"));

let uploadFailed = false;
{
  const g = globalThis as unknown as { fetch: typeof fetch };
  g.fetch = (async () => ({ ok: true, json: async () => ({}) }) as Response) as typeof fetch;
  try {
    await uploadPostizMediaFromUrl("https://cdn.example.com/broken.png");
  } catch {
    uploadFailed = true;
  }
}
check("empty upload response throws (fail-closed)", uploadFailed);

// Full path: schedulePostizPost with mediaUrls uploads first, then posts with images.
{
  const g = globalThis as unknown as { fetch: typeof fetch };
  g.fetch = (async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    calls.push(u);
    if (u.includes("/upload-from-url")) {
      return { ok: true, json: async () => ({ id: "upl_9", path: "https://uploads.postiz.com/upl_9-i" }) } as Response;
    }
    lastPostBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    return { ok: true, json: async () => ({ id: "draft_media" }) } as Response;
  }) as typeof fetch;
  calls.length = 0;
  lastPostBody = null;
  await schedulePostizPost({
    type: "draft",
    content: "media draft",
    channelIds: ["ch_1"],
    mediaUrls: ["https://cdn.example.com/a.png", "https://cdn.example.com/b.png"],
  });
  check(
    "media uploaded before post",
    calls.filter((u) => u.includes("/upload-from-url")).length === 2 && calls[calls.length - 1].endsWith("/posts"),
    calls.join(","),
  );
  const postImages = (
    ((lastPostBody as Record<string, unknown> | null)?.posts as unknown as Array<{
      value: Array<{ image: Array<{ path: string }> }>;
    }>)[0].value[0].image
  );
  check("post payload attaches uploaded media", postImages.length === 2 && postImages[0].path.includes("uploads.postiz.com"));
}

console.log(`\nwaveb-social: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
