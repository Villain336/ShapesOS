// ShapesOS — Phase 1 tests: Composio draft-creators are an EXACT allow-list,
// and the requester identity helpers used for separation of duties.
// Run: npx tsx --test lib/integrations/actions/__tests__/draft-allowlist.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyAction, isDraftCreator } from "../risk";
import { isRequester, requesterOf } from "../gate";

describe("draft-creator allow-list is exact", () => {
  it("tools that merely mention DRAFT/PROPOSAL are not draft-creators", () => {
    for (const slug of ["GMAIL_SEND_DRAFT", "OUTLOOK_SEND_DRAFT", "GMAIL_DELETE_DRAFT", "HUBSPOT_SEND_PROPOSAL", "X_PROPOSE_AND_SEND"]) {
      assert.equal(isDraftCreator(slug), false, slug);
    }
  });

  it("GMAIL_SEND_DRAFT is never auto-executable", () => {
    const c = classifyAction("GMAIL_SEND_DRAFT");
    assert.equal(c.draftCreator, false);
    assert.equal(c.autoExecutable, false);
  });

  it("the listed draft-creators keep their auto-executable privilege", () => {
    for (const slug of ["GMAIL_CREATE_DRAFT", "gmail_create_email_draft", "NOTION_CREATE_PAGE"]) {
      assert.equal(isDraftCreator(slug), true, slug);
    }
    const c = classifyAction("GMAIL_CREATE_DRAFT");
    assert.equal(c.autoExecutable, true);
    assert.equal(c.draftCreator, true);
  });
});

describe("requester identity (separation of duties)", () => {
  const trail = [
    { at: "t0", actor: "user_1 (playbook:pb_1@v2)", event: "proposed" },
    { at: "t1", actor: "user_2", event: "approved" },
  ];
  it("reads the requester from the server-written proposed event", () => {
    assert.equal(requesterOf(trail), "user_1 (playbook:pb_1@v2)");
    assert.equal(requesterOf([]), null);
    assert.equal(requesterOf(null), null);
  });
  it("matches the bare user id and the playbook form, nothing else", () => {
    assert.equal(isRequester("user_1", "user_1"), true);
    assert.equal(isRequester("user_1 (playbook:pb_1@v2)", "user_1"), true);
    assert.equal(isRequester("user_10", "user_1"), false);
    assert.equal(isRequester("chief-strategy-agent:m1", "user_1"), false);
    assert.equal(isRequester(null, "user_1"), false);
  });
});
