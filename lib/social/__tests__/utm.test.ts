// ShapesOS Phase 4b — automatic UTM tagging of outbound social links.
// Run: npx tsx --test lib/social/__tests__/utm.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildChannelBody, defaultCampaign, slugCampaign, tagUrl, tagUrlsInText, utmTagsFor } from "../utm";
import { channelFor } from "@/lib/attribution/touches";

const AT = new Date("2026-10-05T12:00:00Z");

describe("UTM tagging", () => {
  it("builds tags from platform, campaign and post id", () => {
    assert.deepEqual(utmTagsFor({ platform: "linkedin-page", campaign: "Spring Launch!", postId: "p1", at: AT }), {
      utm_source: "linkedin",
      utm_medium: "social",
      utm_campaign: "spring-launch",
      utm_content: "p1",
    });
    assert.equal(utmTagsFor({ platform: "x", campaign: null, postId: "p1", at: AT }).utm_campaign, "social-2026-10-05");
    assert.equal(defaultCampaign(AT), "social-2026-10-05");
    assert.equal(slugCampaign("  Ünïcode — Sale  "), "unicode-sale");
    assert.equal(slugCampaign("!!!"), null);
  });

  it("adds tags to a URL without overwriting the author's own utm values", () => {
    const tags = utmTagsFor({ platform: "x", campaign: "fall", postId: "p9", at: AT });
    const out = new URL(tagUrl("https://shop.example/a?utm_source=newsletter&ref=1#top", tags));
    assert.equal(out.searchParams.get("utm_source"), "newsletter", "existing value kept");
    assert.equal(out.searchParams.get("utm_medium"), "social");
    assert.equal(out.searchParams.get("utm_campaign"), "fall");
    assert.equal(out.searchParams.get("utm_content"), "p9");
    assert.equal(out.searchParams.get("ref"), "1");
    assert.equal(out.hash, "#top");
    assert.equal(tagUrl("mailto:hi@example.com", tags), "mailto:hi@example.com");
    assert.equal(tagUrl("not a url", tags), "not a url");
  });

  it("tags every URL in text and keeps trailing punctuation outside the link", () => {
    const tags = utmTagsFor({ platform: "x", campaign: "c", postId: "p", at: AT });
    const out = tagUrlsInText("See https://a.example/x. Also (https://b.example)!", tags);
    assert.match(out, /^See https:\/\/a\.example\/x\?utm_source=x&utm_medium=social&utm_campaign=c&utm_content=p\. Also \(https:\/\/b\.example\/\?utm_source=x/);
    assert.ok(out.endsWith(")!"));
  });

  it("appends the post link once, tagged per channel", () => {
    const li = buildChannelBody({ content: "New post", link: "https://shapes.example/blog", platform: "linkedin", campaign: "launch", postId: "p1", at: AT });
    assert.equal(li, "New post\n\nhttps://shapes.example/blog?utm_source=linkedin&utm_medium=social&utm_campaign=launch&utm_content=p1");
    const x = buildChannelBody({ content: "Read https://shapes.example/blog", link: "https://shapes.example/blog", platform: "x", campaign: "launch", postId: "p1", at: AT });
    assert.equal(x.match(/https:/g)?.length, 1, "link already in the text is not appended again");
    assert.match(x, /utm_source=x/);
    assert.equal(buildChannelBody({ content: "Hi", link: "javascript:alert(1)", platform: "x", campaign: null, postId: "p", at: AT }), "Hi");
  });

  it("the tagged links land in the social_organic attribution channel", () => {
    for (const platform of ["x", "linkedin", "instagram", "threads", "bluesky", "pinterest"]) {
      const t = utmTagsFor({ platform, campaign: "c", postId: "p", at: AT });
      assert.equal(channelFor("website_form", t), "social_organic", platform);
    }
    // Paid mediums still win over the social rule.
    assert.equal(channelFor("website_form", { utm_source: "facebook", utm_medium: "cpc" }), "paid_ads");
  });
});
