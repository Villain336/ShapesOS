// ShapesOS — Phase 18.3 (WS=flow): the share sheet / Open with registry.
//   - Send-to targets come from the nav (an app not in this person's nav
//     shows no target) and the agent registry (one per sub-agent)
//   - every receiver names a real nav app and its existing route
//   - role hints, personal kinds refused by Notes, file-only share links,
//     navigator.share only where the device has it
//   - Open with: the record's own page first, then apps from the nav; every
//     OPEN_WITH href is a nav destination; kinds without entries still open

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { allNavItems } from "@/lib/nav/config";
import { RECORD_KINDS } from "@/lib/search/kinds";
import { AGENT_KEYS } from "@/lib/agents/grants";
import { absoluteLink, OPEN_WITH, openWith, recordMessage, SHARE_RECEIVERS, shareTargets } from "../registry";

const nav = allNavItems();

describe("share targets", () => {
  it("every receiver is a nav app and names the route it uses", () => {
    for (const r of SHARE_RECEIVERS) {
      assert.ok(nav.some((n) => n.href === r.app), `${r.app} is in the nav`);
      assert.ok(r.via.length > 10, `${r.id} documents its path`);
    }
    assert.deepEqual(SHARE_RECEIVERS.map((r) => r.id).sort(), ["assistant", "mail", "messages", "notes", "reminders"]);
  });

  it("apps + one target per sub-agent + links; generated, in order", () => {
    const t = shareTargets({ kind: "deal" }, { role: "editor", canNativeShare: true });
    assert.deepEqual(t.filter((x) => x.group === "apps").map((x) => x.id), ["assistant", "mail", "messages", "notes", "reminders"]);
    assert.deepEqual(t.filter((x) => x.group === "agents").map((x) => x.agentKey).sort(), AGENT_KEYS.filter((k) => k !== "lead").sort());
    assert.deepEqual(t.filter((x) => x.group === "links").map((x) => x.id), ["copy_link", "device"]);
    assert.ok(t.every((x) => x.unavailable === null));
  });

  it("a new nav app with a receiver joins; an app missing from the nav drops out", () => {
    const withoutNotes = nav.filter((n) => n.href !== "/dashboard/notes");
    assert.ok(!shareTargets({ kind: "deal" }, { role: "editor", canNativeShare: false }, withoutNotes).some((x) => x.id === "notes"));
  });

  it("role hints, personal kinds, file links, device share", () => {
    const viewer = shareTargets({ kind: "file" }, { role: "viewer", canNativeShare: false });
    assert.equal(viewer.find((x) => x.id === "mail")?.unavailable, "role");
    assert.equal(viewer.find((x) => x.id === "file_link")?.unavailable, "role");
    assert.equal(viewer.find((x) => x.id === "notes")?.unavailable, null);
    assert.ok(!viewer.some((x) => x.id === "device"), "no navigator.share → no device target");
    assert.equal(shareTargets({ kind: "mail" }, { role: "editor", canNativeShare: false }).find((x) => x.id === "notes")?.unavailable, "personal");
    assert.ok(!shareTargets({ kind: "deal" }, { role: "owner", canNativeShare: false }).some((x) => x.id === "file_link"), "share links are for files");
  });
});

describe("open with", () => {
  it("every OPEN_WITH href is a nav destination and every kind opens somewhere", () => {
    for (const [kind, hrefs] of Object.entries(OPEN_WITH)) for (const h of hrefs ?? []) assert.ok(nav.some((n) => n.href === h), `${kind} → ${h}`);
    for (const k of RECORD_KINDS) assert.ok(openWith({ kind: k, href: `/x/${k}` }, "viewer").length >= 1);
  });

  it("the record's own page first, then apps; deduped; role-gated", () => {
    const o = openWith({ kind: "file", href: "/dashboard/files?file=f1" }, "viewer");
    assert.equal(o[0]!.app, null);
    assert.deepEqual(o.slice(1).map((x) => x.href), ["/dashboard/office"], "Files is the record's own page");
  });

  it("messages and links", () => {
    const m = recordMessage("Look at this", { kind: "deal", id: "d1", title: "Acme renewal", href: "/dashboard/crm?deal=d1", snippet: "Q4" });
    assert.match(m, /Record: deal:d1 — Acme renewal/);
    assert.match(m, /search_workspace/);
    assert.equal(absoluteLink("https://app.test/", "/dashboard/x"), "https://app.test/dashboard/x");
    assert.equal(absoluteLink("https://app.test", "//evil.test"), "https://app.test");
  });
});
