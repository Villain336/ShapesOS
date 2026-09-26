// Marketr — Phase 10 M2: no-alert-on-docs-only regression tests.
// Run: npx tsx --test lib/intelligence/radar/__tests__/regression.test.ts
//
// The flagship invariant, end to end at the unit level:
// docs_change and volatility events can NEVER produce rollout alerts —
// only confirmed rollouts may. If this test fails, the feature is broken.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildRolloutAlert,
  isAlertableEventType,
} from "../alerts";
import { heuristicClassify } from "../classifier";
import { normalizeStatusDashboard, parseRssItems } from "../ingest";
import { parseMozCast } from "../volatility";
import {
  DOCS_EDIT_FIXTURE,
  AUG_2026_SPAM_UPDATE_FIXTURE,
} from "./fixtures";

describe("no-alert-on-docs-only", () => {
  it("only 'rollout' is alertable — docs_change and volatility are not", () => {
    assert.equal(isAlertableEventType("rollout"), true);
    assert.equal(isAlertableEventType("docs_change"), false);
    assert.equal(isAlertableEventType("volatility"), false);
    assert.equal(isAlertableEventType("anything_else"), false);
  });

  it("docs_change source items never reach the alertable branch", () => {
    const c = heuristicClassify(DOCS_EDIT_FIXTURE);
    assert.equal(c.eventType, "docs_change");
    assert.equal(isAlertableEventType(c.eventType), false);
  });

  it("a docs-only sweep produces zero alerts (simulated pipeline gate)", () => {
    const docsOnly = [DOCS_EDIT_FIXTURE];
    const alertable = docsOnly.filter((i) =>
      isAlertableEventType(heuristicClassify(i).eventType),
    );
    assert.equal(alertable.length, 0);
  });

  it("a rollout still produces an alert with the headline pattern", () => {
    const alert = buildRolloutAlert(
      {
        id: "ev_1",
        title: AUG_2026_SPAM_UPDATE_FIXTURE.title,
        startedAt: AUG_2026_SPAM_UPDATE_FIXTURE.startedAt,
        url: AUG_2026_SPAM_UPDATE_FIXTURE.url,
      },
      [
        {
          projectId: "proj_1",
          domain: "example.com",
          impacts: [
            {
              projectId: "proj_1",
              page: "https://example.com/a",
              query: "q",
              deltaClicks: -10,
              deltaImpressions: -50,
              deltaPosition: 2,
              impactScore: 0.7,
              confidenceBand: [0.5, 0.9],
              direction: "declined",
            },
          ],
        },
      ],
    );
    assert.match(alert.headline, /August 18/);
    assert.match(alert.headline, /hit 1 of your page\./);
    assert.ok(alert.checklist.length >= 4, "verification checklist present");
    assert.ok(
      alert.checklist.every((c) => !/\b(fix|implement|add|rewrite|disavow)\b/i.test(c) || /confirm|check|document|wait|rule out/i.test(c)),
      "checklist is verification, not auto-fix prescriptions",
    );
  });

  it("rollout with no pages beyond the noise band → 'no movement' headline, no false hit claim", () => {
    const alert = buildRolloutAlert(
      {
        id: "ev_2",
        title: AUG_2026_SPAM_UPDATE_FIXTURE.title,
        startedAt: AUG_2026_SPAM_UPDATE_FIXTURE.startedAt,
        url: null,
      },
      [{ projectId: "proj_1", domain: "example.com", impacts: [] }],
    );
    assert.match(alert.headline, /none of your tracked pages moved beyond the noise band yet/);
  });
});

describe("ingest parsers (no network)", () => {
  it("incidents.json normalizer extracts the Aug 2026 spam window", () => {
    const body = JSON.stringify([
      {
        id: "LEubPCm2octf2uMqCFKE",
        external_desc: "August 2026 spam update",
        begin: "2026-08-18T16:27:00+00:00",
        end: "2026-08-21T08:49:00+00:00",
        uri: "incidents/LEubPCm2octf2uMqCFKE",
        service_name: "Ranking",
      },
    ]);
    const [item] = normalizeStatusDashboard(body);
    assert.equal(item.title, "August 2026 spam update");
    assert.equal(item.startedAt?.toISOString(), "2026-08-18T16:27:00.000Z");
    assert.equal(item.endedAt?.toISOString(), "2026-08-21T08:49:00.000Z");
    assert.equal(item.url, "https://status.search.google.com/incidents/LEubPCm2octf2uMqCFKE");
    assert.equal(item.source, "status_dashboard");
  });

  it("incidents.json normalizer rejects garbage", () => {
    assert.throws(() => normalizeStatusDashboard("not json"), /not valid JSON/);
    assert.throws(() => normalizeStatusDashboard('{"a":1}'), /expected an array/);
  });

  it("RSS parser handles the Search Central docs feed shape", () => {
    const xml = `<?xml version="1.0"?><rss version="2.0"><channel>
      <item>
        <title>Added creator property and updated interactionStatistic in VideoObject structured data</title>
        <link>https://developers.google.com/search/updates#september-2026</link>
        <description>&lt;p&gt;What: docs edit&lt;/p&gt;</description>
        <pubDate>Thu, 24 Sep 2026 00:00:00 +0000</pubDate>
        <guid isPermaLink="false">2026-09-24-Added-creator-property</guid>
      </item></channel></rss>`;
    const [item] = parseRssItems(xml);
    assert.equal(item.title, "Added creator property and updated interactionStatistic in VideoObject structured data");
    assert.equal(item.description, "What: docs edit");
    assert.equal(item.guid, "2026-09-24-Added-creator-property");
  });

  it("MozCast parser extracts the latest temp from embedded Vue data", () => {
    const html = `<script>new Vue({data: {weather: [{"big10":0.22,"date":"2026-09-25T16:00:24.000Z","dateStr":"Sep 25","dayStr":"Friday","temp":138},{"dateStr":"Sep 24","dayStr":"Thursday","temp":116}]}})</script>`;
    const r = parseMozCast(html);
    assert.equal(r.available, true);
    assert.equal(r.value, 138);
    assert.match(r.valueLabel ?? "", /Sep 25/);
  });

  it("MozCast parser degrades honestly on unexpected HTML", () => {
    const r = parseMozCast("<html><body>blocked</body></html>");
    assert.equal(r.available, false);
    assert.equal(r.value, null);
  });
});
