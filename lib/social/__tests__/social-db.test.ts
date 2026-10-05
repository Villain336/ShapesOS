// ShapesOS Phase 4b — the social loop against real Postgres (FORCE RLS),
// run as the least-privilege app role:
//   media upload → draft → submit (inbox + notification) → separation of
//   duties → approve → dispatch (mock provider) → published + webhook →
//   engagement ingestion (idempotent) → aggregation → attribution join via
//   UTM-tagged touches; scheduled posts on a Postiz-like provider → status
//   refresh; deny; tenant isolation; Studio design → post draft.
// Run: DATABASE_URL=<app role> npx tsx --test lib/social/__tests__/social-db.test.ts
// Listed in scripts/test/db-tests.txt.

import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import sharp from "sharp";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope, countWithoutScope } from "@/lib/substrate/memory/rls";
import { resetStorageAdapterForTests } from "@/lib/filesystem/storage";
import { secrets } from "@/lib/secrets";
import {
  createPost,
  decidePost,
  getPost,
  listPosts,
  publishProblems,
  refreshStatuses,
  storeSocialMedia,
  submitForApproval,
  updatePost,
  type SerializedPost,
} from "../publications";
import { MockSocialProvider, type SocialProvider, type ProviderPostStatus } from "../provider";
import { getSocialEngagement, ingestEngagement } from "../engagement";
import { sendDesignToSocial } from "../studio";
import { utmTagsFor } from "../utm";
import { recordCaptureTouch } from "@/lib/attribution/touches";
import { getSocialAttribution } from "@/lib/attribution/social";
import { loadInbox } from "@/lib/approvals/inbox";

process.env.MARKETR_CREDENTIALS_KEY ||= randomBytes(32).toString("hex");

const WS = "p4b-social-ws";
const OTHER = "p4b-social-other";
const OWNER = "p4b-social-owner";
const EDITOR = "p4b-social-editor";
const VIEWER = "p4b-social-viewer";
let storageDir = "";

async function pngBytes(w = 64, h = 48): Promise<Buffer> {
  return sharp({ create: { width: w, height: h, channels: 3, background: { r: 0, g: 0, b: 0 } } }).png().toBuffer();
}
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom"), Buffer.alloc(64, 1)]);

const mock = new MockSocialProvider();
const decider = (userId: string, hasOtherApprover = true) => ({ userId, role: "editor" as const, hasOtherApprover });

async function draft(ws: string, over: Partial<Parameters<typeof createPost>[2]> = {}): Promise<SerializedPost> {
  const channels = (await mock.listChannels()).slice(0, 2);
  return createPost(ws, OWNER, {
    content: "Launch day at ShapesOS https://shapes.example/launch",
    link: "https://shapes.example/pricing",
    utmCampaign: "Fall Launch",
    channels: channels.map((c) => ({ id: c.id, identifier: c.identifier, name: c.name })),
    publishMode: "now",
    ...over,
  });
}

before(async () => {
  storageDir = mkdtempSync(join(tmpdir(), "p4b-social-"));
  process.env.MARKETR_STORAGE = "local";
  process.env.MARKETR_STORAGE_DIR = storageDir;
  resetStorageAdapterForTests();
  for (const id of [WS, OTHER]) await prisma.workspace.deleteMany({ where: { id } });
  await prisma.workspace.create({ data: { id: WS, name: WS, ownerUserId: OWNER, plan: "pro" } });
  await prisma.workspace.create({ data: { id: OTHER, name: OTHER, ownerUserId: OWNER, plan: "pro" } });
  await prisma.workspaceMember.createMany({
    data: [
      { workspaceId: WS, userId: OWNER, role: "owner" },
      { workspaceId: WS, userId: EDITOR, role: "editor" },
      { workspaceId: WS, userId: VIEWER, role: "viewer" },
      { workspaceId: OTHER, userId: OWNER, role: "owner" },
    ],
  });
  await withWorkspaceScope(WS, (tx) =>
    tx.webhookEndpoint.create({
      data: {
        workspaceId: WS,
        url: "https://hooks.example.test/shapes",
        events: ["social_post.published"],
        secretEnc: secrets().encrypt("whsec_test"),
        secretHint: "whsec_…test",
        createdBy: OWNER,
      },
    }),
  );
});

after(async () => {
  for (const id of [WS, OTHER]) await prisma.workspace.deleteMany({ where: { id } });
  await prisma.$disconnect();
  rmSync(storageDir, { recursive: true, force: true });
});

describe("social loop (DB)", () => {
  let published: SerializedPost;

  it("stores media in the workspace filesystem with sniffed type, size and dimensions", async () => {
    const image = await storeSocialMedia({ workspaceId: WS, userId: OWNER, bytes: await pngBytes(), filename: "Hero shot.png" });
    assert.equal(image.kind, "image");
    assert.equal(image.mimeType, "image/png");
    assert.equal(image.width, 64);
    assert.equal(image.height, 48);
    const file = await prisma.workspaceFile.findUnique({ where: { id: image.fileId } });
    assert.match(file!.logicalPath, /^\/files\/social\/uploads\/\d{4}-\d{2}\/Hero-shot-[0-9a-f]{8}\.png$/);
    const video = await storeSocialMedia({ workspaceId: WS, userId: OWNER, bytes: MP4, filename: "clip.mov" });
    assert.equal(video.mimeType, "video/mp4", "the bytes decide, not the name");
    assert.equal(video.kind, "video");
    await assert.rejects(
      () => storeSocialMedia({ workspaceId: WS, userId: OWNER, bytes: Buffer.from("<svg></svg>"), filename: "x.svg" }),
      /image \(JPEG, PNG, GIF, WebP\) or a video/,
    );
  });

  it("drafts validate per platform; another workspace's media can't be attached", async () => {
    const image = await storeSocialMedia({ workspaceId: WS, userId: OWNER, bytes: await pngBytes(), filename: "a.png" });
    const p = await draft(WS, { media: [{ ...image }] });
    assert.equal(p.status, "draft");
    assert.equal(p.media.length, 1);
    assert.deepEqual(publishProblems(p), []);
    const tooLong = await updatePost(WS, p.id, { content: "x".repeat(300) });
    assert.ok(publishProblems(tooLong).some((m) => m.startsWith("X: text is")));
    await assert.rejects(() => createPost(OTHER, OWNER, { content: "steal", media: [{ ...image }] }), /media file is missing/);
  });

  it("submit → inbox item + notification; requester can't self-approve while another approver exists", async () => {
    const image = await storeSocialMedia({ workspaceId: WS, userId: OWNER, bytes: await pngBytes(), filename: "b.png" });
    const p = await draft(WS, { media: [{ ...image }] });
    const pending = await submitForApproval(WS, p.id, OWNER);
    assert.equal(pending.status, "pending_approval");
    await assert.rejects(() => submitForApproval(WS, p.id, OWNER), /already submitted/);

    const note = await prisma.notification.findFirst({ where: { workspaceId: WS, userId: EDITOR, sourceType: "social", sourceId: p.id } });
    assert.ok(note, "the other editor is told");
    assert.equal(note!.href, `/dashboard/social?post=${p.id}`);

    const inbox = await loadInbox({ userId: EDITOR, workspaceId: WS, role: "editor", permissions: new Set(), hasOtherApprover: true });
    const item = inbox.items.find((i) => i.key === `social:${p.id}`);
    assert.ok(item?.canDecide, "the other editor can decide it in the unified inbox");

    await assert.rejects(() => decidePost(WS, p.id, decider(OWNER), "approve", null, mock), /Someone else approves/);
    await assert.rejects(() => decidePost(WS, p.id, { userId: VIEWER, role: "viewer", hasOtherApprover: true }, "approve", null, mock), /editor/);

    published = await decidePost(WS, p.id, decider(EDITOR), "approve", null, mock);
    assert.equal(published.status, "published");
    assert.equal(published.provider, "mock");
    assert.equal(published.providerRefs.length, 2);
    assert.equal(published.utmCampaign, "fall-launch", "the campaign the links carried is stored");
    assert.ok(published.publishedAt);
    await assert.rejects(() => decidePost(WS, p.id, decider(EDITOR), "approve", null, mock), /isn't waiting/);
  });

  it("publishing enqueues the social_post.published webhook once", async () => {
    const rows = await withWorkspaceScope(WS, (tx) => tx.webhookDelivery.findMany({ where: { workspaceId: WS, eventType: "social_post.published" } }));
    assert.equal(rows.length, 1);
    const data = (rows[0]!.payload as { data: Record<string, unknown> }).data;
    assert.equal(data.id, published.id);
    assert.deepEqual(data.platforms, published.platforms);
    assert.deepEqual([...published.platforms].sort(), ["linkedin", "x"]);
    assert.equal(data.mediaCount, 1);
    assert.equal(data.utmCampaign, "fall-launch");
  });

  it("ingests engagement per post/channel/day, idempotently, and aggregates it", async () => {
    const now = new Date(Date.now() + 2 * 86_400_000);
    const first = await ingestEngagement(WS, mock, now);
    assert.equal(first.posts, 1);
    assert.ok(first.rows >= 4, `3 days × 2 channels, got ${first.rows}`);
    const again = await ingestEngagement(WS, mock, now);
    assert.equal(again.posts, 0, "re-poll interval respected");
    const forced = await ingestEngagement(WS, mock, now, { force: true });
    assert.equal(forced.rows, first.rows);
    const count = await withWorkspaceScope(WS, (tx) => tx.socialPostMetric.count({ where: { workspaceId: WS } }));
    assert.equal(count, first.rows, "upserts, never duplicates");

    const eng = await getSocialEngagement(WS);
    assert.equal(eng.mock, true);
    assert.equal(eng.byPost.length, 1);
    assert.equal(eng.byPost[0]!.campaign, "fall-launch");
    assert.ok(eng.totals.impressions > 0);
    assert.equal(eng.totals.engagements, eng.totals.likes + eng.totals.comments + eng.totals.shares + eng.totals.clicks);
    assert.equal(eng.byPlatform.reduce((s, p) => s + p.impressions, 0), eng.totals.impressions);
    assert.equal(eng.daily.reduce((s, d) => s + d.clicks, 0), eng.totals.clicks);

    const listed = (await listPosts(WS)).find((x) => x.id === published.id)!;
    assert.equal(listed.metrics?.impressions, eng.totals.impressions);
  });

  it("leads from the post's UTM-tagged links show up in attribution with revenue", async () => {
    const pipeline = await prisma.pipeline.create({ data: { workspaceId: WS, name: "Sales", stages: [{ id: "won", label: "Won" }] } });
    const lead = await prisma.lead.create({ data: { workspaceId: WS, pipelineId: pipeline.id, name: "Ada", stage: "won", valueCents: 50_000 } });
    const other = await prisma.lead.create({ data: { workspaceId: WS, pipelineId: pipeline.id, name: "Bo", stage: "new" } });
    const tags = utmTagsFor({ platform: "linkedin-page", campaign: published.utmCampaign, postId: published.id });
    await recordCaptureTouch({ workspaceId: WS, leadId: lead.id, leadSource: "website_form", utm: tags });
    await recordCaptureTouch({ workspaceId: WS, leadId: other.id, leadSource: "website_form", utm: { ...tags, utm_content: null } });

    const attr = await getSocialAttribution(WS, {}, "linear");
    assert.equal(attr.channelLeads, 2);
    assert.equal(attr.channelRevenueCents, 50_000);
    const row = attr.posts.find((p) => p.id === published.id)!;
    assert.equal(row.leads, 2, "one via utm_content, one via the campaign");
    assert.equal(row.revenueCents, 50_000);
    assert.ok(row.clickToLead === null || row.clickToLead > 0);
    assert.equal(attr.campaigns.find((c) => c.campaign === "fall-launch")?.leads, 2);
  });

  it("scheduled posts on a Postiz-like provider wait for the provider, then publish or fail", async () => {
    const states = new Map<string, ProviderPostStatus>();
    let n = 0;
    const fake: SocialProvider = {
      name: "postiz",
      listChannels: () => mock.listChannels(),
      uploadMedia: async () => ({ id: "m", path: "https://uploads.postiz.test/m.png" }),
      createPosts: async (input) => input.posts.map((p) => ({ postId: `pz-${++n}`, integrationId: p.channel.id })),
      postStatuses: async (ids) => new Map(ids.filter((id) => states.has(id)).map((id) => [id, states.get(id)!])),
      postMetrics: async () => [],
    };
    const when = new Date(Date.now() + 3_600_000).toISOString();
    const ok = await draft(WS, { publishMode: "schedule", scheduledFor: when, utmCampaign: null });
    await submitForApproval(WS, ok.id, OWNER);
    const scheduled = await decidePost(WS, ok.id, decider(EDITOR), "approve", null, fake);
    assert.equal(scheduled.status, "scheduled");
    assert.equal(scheduled.scheduledFor, when);
    assert.match(scheduled.utmCampaign ?? "", /^social-\d{4}-\d{2}-\d{2}$/);

    const bad = await draft(WS, { publishMode: "schedule", scheduledFor: when });
    await submitForApproval(WS, bad.id, OWNER);
    const badScheduled = await decidePost(WS, bad.id, decider(EDITOR), "approve", null, fake);

    const before = await refreshStatuses(WS, fake, new Date());
    assert.equal(before.checked, 0, "not due yet");
    for (const r of scheduled.providerRefs) states.set(r.postId, { state: "published", releaseUrl: `https://x.test/${r.postId}`, publishedAt: when });
    states.set(badScheduled.providerRefs[0]!.postId, { state: "error", releaseUrl: null, publishedAt: null });
    const later = new Date(Date.now() + 2 * 3_600_000);
    const res = await refreshStatuses(WS, fake, later);
    assert.equal(res.published, 1);
    assert.equal(res.failed, 1);
    const okNow = await getPost(WS, ok.id);
    assert.equal(okNow.status, "published");
    assert.equal(okNow.publishedAt, when);
    assert.ok(okNow.providerRefs.every((r) => r.releaseUrl?.startsWith("https://x.test/")));
    const badNow = await getPost(WS, bad.id);
    assert.equal(badNow.status, "failed");
    assert.match(badNow.error ?? "", /rejected/);
    const edited = await updatePost(WS, bad.id, { content: "Fixed copy" });
    assert.equal(edited.status, "draft", "failed posts are editable and go back to draft");
  });

  it("deny sends the post back to draft with the note; no provider → failed with a clear message", async () => {
    const p = await draft(WS);
    await submitForApproval(WS, p.id, OWNER);
    const denied = await decidePost(WS, p.id, decider(EDITOR), "deny", "Tone it down", mock);
    assert.equal(denied.status, "draft");
    assert.equal(denied.decisionNote, "Tone it down");
    await submitForApproval(WS, p.id, OWNER);
    const noProvider = await decidePost(WS, p.id, decider(EDITOR), "approve", null, null);
    assert.equal(noProvider.status, "failed");
    assert.match(noProvider.error ?? "", /isn't connected/);
  });

  it("tenant isolation: FORCE RLS hides every row without the scope; other workspaces see nothing", async () => {
    assert.equal(await countWithoutScope("social_publications"), 0);
    assert.equal(await countWithoutScope("social_post_metrics"), 0);
    assert.deepEqual(await listPosts(OTHER), []);
    await assert.rejects(() => getPost(OTHER, published.id), /not found/i);
    await assert.rejects(() => submitForApproval(OTHER, published.id, OWNER), /not found/i);
    assert.equal((await getSocialEngagement(OTHER)).byPost.length, 0);
  });

  it("Studio design → rendered PNG → post draft with the image attached", async () => {
    const design = await prisma.design.create({
      data: {
        workspaceId: WS,
        name: "Spring promo",
        document: {
          schemaVersion: 1,
          pages: [
            {
              id: "page-1",
              name: "Page 1",
              width: 320,
              height: 200,
              background: "#ffffff",
              elements: [
                { id: "r1", name: "r", type: "rect", x: 10, y: 10, rotation: 0, opacity: 1, visible: true, locked: false, width: 100, height: 60, fill: "#000000", cornerRadius: 4 },
              ],
            },
          ],
        },
      },
    });
    const { post } = await sendDesignToSocial(WS, OWNER, design.id, { scale: 1 });
    assert.equal(post.status, "draft");
    assert.equal(post.source, "studio");
    assert.equal(post.sourceRef, design.id);
    assert.equal(post.utmCampaign, "Spring promo");
    assert.equal(post.media.length, 1);
    assert.equal(post.media[0]!.mimeType, "image/png");
    assert.equal(post.media[0]!.width, 320);
    const file = await prisma.workspaceFile.findUnique({ where: { id: post.media[0]!.fileId } });
    assert.match(file!.logicalPath, /^\/files\/social\/studio\//);
    await assert.rejects(() => sendDesignToSocial(OTHER, OWNER, design.id), /Design not found/);
  });
});
