// Phase 11 (conncore): Gmail send / reply-in-thread and Outlook (Graph) mail.
// Request shapes follow the provider docs; fetch is scripted (no network).
// Run: npx tsx --test lib/connectors/m21/live/__tests__/mail-writes.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { GmailAdapter } from "../../native/gmail";
import { OutlookAdapter } from "../../native/outlook";
import { buildMimeMessage, encodeHeaderText, parseRecipients, replySubject, MimeInputError } from "../mime";
import { OAUTH_CONFIGS, startOAuthFlow } from "@/lib/vault/oauth";
import { connectorAction, connectorGroup } from "@/lib/agents/grants";
import { jsonResponse, scriptedFetch, liveDeps, oauthCred, ctxWith, refreshingCtx } from "./fixtures";

function decodeRaw(raw: string): string {
  return Buffer.from(raw, "base64url").toString("utf8");
}

function decodeTextPart(mime: string): string {
  const [, body] = mime.split("\r\n\r\n");
  return Buffer.from(body.replace(/\r\n/g, ""), "base64").toString("utf8");
}

describe("MIME builder", () => {
  it("strips CR/LF from headers (no header injection) and encodes non-ASCII subjects", () => {
    const m = buildMimeMessage({ to: ["a@x.com"], subject: "Hi\r\nBcc: evil@x.com", text: "hello" });
    assert.doesNotMatch(m, /\r\nBcc:/);
    assert.match(m, /^To: a@x\.com\r\nSubject: Hi Bcc: evil@x\.com\r\n/);
    assert.equal(encodeHeaderText("Grüße"), `=?UTF-8?B?${Buffer.from("Grüße").toString("base64")}?=`);
    assert.equal(decodeTextPart(m), "hello");
  });

  it("validates recipients and dedupes", () => {
    assert.deepEqual(parseRecipients("Ada <ADA@x.com>, b@y.org; ada@x.com", "to"), ["ada@x.com", "b@y.org"]);
    assert.throws(() => parseRecipients("not-an-email", "to"), MimeInputError);
    assert.throws(() => parseRecipients("a@x.com\r\nBcc: e@x.com", "to"), MimeInputError);
  });

  it("html makes a multipart/alternative message; reply subjects never double up", () => {
    const m = buildMimeMessage({ to: ["a@x.com"], subject: "s", text: "t", html: "<p>t</p>" });
    assert.match(m, /Content-Type: multipart\/alternative; boundary="shapes_[0-9a-f]+"/);
    assert.match(m, /Content-Type: text\/html; charset=UTF-8/);
    assert.equal(replySubject("Hello"), "Re: Hello");
    assert.equal(replySubject("RE: Hello"), "RE: Hello");
  });
});

describe("Gmail writes", () => {
  it("send_email: POST users/me/messages/send with a base64url RFC 5322 raw message", async () => {
    const f = scriptedFetch([jsonResponse(200, { id: "m1", threadId: "t1", labelIds: ["SENT"] })]);
    const r = await new GmailAdapter(liveDeps(f.fetchImpl).deps).invoke(
      "send_email",
      { to: "ada@example.com, Bob <bob@example.org>", cc: "c@example.com", subject: "Proposal", body: "Hi Ada" },
      oauthCred("gtok"),
      ctxWith(),
    );
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(r.data, { id: "m1", threadId: "t1" });
    const c = f.calls[0];
    assert.equal(c.method, "POST");
    assert.equal(c.url.href, "https://gmail.googleapis.com/gmail/v1/users/me/messages/send");
    assert.equal(c.headers.authorization, "Bearer gtok");
    const raw = decodeRaw((c.body as { raw: string }).raw);
    assert.match(raw, /^To: ada@example\.com, bob@example\.org\r\nCc: c@example\.com\r\nSubject: Proposal\r\n/);
    assert.equal(decodeTextPart(raw), "Hi Ada");
  });

  it("reply_to_message: reads the original's headers, then sends in its thread with In-Reply-To/References", async () => {
    const f = scriptedFetch([
      jsonResponse(200, {
        id: "orig1234",
        threadId: "thr9",
        payload: {
          headers: [
            { name: "Message-ID", value: "<abc@mail.example.com>" },
            { name: "References", value: "<root@mail.example.com>" },
            { name: "Subject", value: "Pricing" },
            { name: "From", value: "Ada <ada@example.com>" },
          ],
        },
      }),
      jsonResponse(200, { id: "m2", threadId: "thr9" }),
    ]);
    const r = await new GmailAdapter(liveDeps(f.fetchImpl).deps).invoke(
      "reply_to_message",
      { messageId: "orig1234", body: "Thanks!" },
      oauthCred(),
      ctxWith(),
    );
    assert.equal(r.ok, true, r.error);
    const get = f.calls[0];
    assert.equal(get.url.pathname, "/gmail/v1/users/me/messages/orig1234");
    assert.equal(get.url.searchParams.get("format"), "metadata");
    assert.ok(get.url.searchParams.getAll("metadataHeaders").includes("Message-ID"));
    const send = f.calls[1].body as { raw: string; threadId: string };
    assert.equal(send.threadId, "thr9");
    const raw = decodeRaw(send.raw);
    assert.match(raw, /^To: ada@example\.com\r\n/);
    assert.match(raw, /\r\nSubject: Re: Pricing\r\n/);
    assert.match(raw, /\r\nIn-Reply-To: <abc@mail\.example\.com>\r\n/);
    assert.match(raw, /\r\nReferences: <root@mail\.example\.com> <abc@mail\.example\.com>\r\n/);
  });

  it("a send is never retried on 5xx (no double send); 401 refreshes once", async () => {
    const f = scriptedFetch([jsonResponse(503, { error: { message: "backend" } })]);
    const r = await new GmailAdapter(liveDeps(f.fetchImpl).deps).invoke("send_email", { to: "a@x.com", subject: "s", body: "b" }, oauthCred(), ctxWith());
    assert.equal(r.ok, false);
    assert.equal(r.errorCode, "provider_error");
    assert.equal(f.calls.length, 1);

    const g = scriptedFetch([jsonResponse(401, { error: { message: "expired" } }), jsonResponse(200, { id: "m", threadId: "t" })]);
    const ctx = refreshingCtx();
    const ok = await new GmailAdapter(liveDeps(g.fetchImpl).deps).invoke("send_email", { to: "a@x.com", subject: "s", body: "b" }, oauthCred(), ctx);
    assert.equal(ok.ok, true, ok.error);
    assert.equal(g.calls[1].headers.authorization, "Bearer tok-2");
  });

  it("bad input is a bad_request before any call; no credential is not_connected (no mock send)", async () => {
    const f = scriptedFetch([]);
    const bad = await new GmailAdapter(liveDeps(f.fetchImpl).deps).invoke("send_email", { to: "nope", subject: "s", body: "b" }, oauthCred(), ctxWith());
    assert.equal(bad.errorCode, "bad_request");
    const none = await new GmailAdapter(liveDeps(f.fetchImpl).deps).invoke("send_email", { to: "a@x.com", subject: "s", body: "b" }, null, ctxWith());
    assert.equal(none.errorCode, "not_connected");
    assert.equal(f.calls.length, 0);
  });

  it("send tools are mutating, in the email group, and map to the Tier-2 outreach action", () => {
    const tools = new GmailAdapter().listTools();
    for (const name of ["send_email", "reply_to_message"]) {
      assert.equal(tools.find((t) => t.name === name)?.mutating, true, name);
      assert.equal(connectorAction("gmail", name), "send_outreach_email");
    }
    assert.equal(tools.find((t) => t.name === "list_network_contacts")?.mutating, false);
    assert.equal(connectorGroup("gmail"), "email");
    assert.ok(OAUTH_CONFIGS.gmail.scopes.includes("https://www.googleapis.com/auth/gmail.send"));
  });
});

describe("Outlook (Microsoft Graph) mail", () => {
  it("list_messages: GET /me/messages with $select/$orderby; $search drops $orderby", async () => {
    const f = scriptedFetch([
      jsonResponse(200, { value: [{ id: "AAMkAD1", subject: "Hi", from: { emailAddress: { address: "a@x.com" } }, receivedDateTime: "2026-10-01T00:00:00Z", bodyPreview: "p", conversationId: "c1", isRead: false }] }),
      jsonResponse(200, { value: [] }),
    ]);
    const a = new OutlookAdapter(liveDeps(f.fetchImpl).deps);
    const r = await a.invoke("list_messages", { limit: 10 }, oauthCred("mtok"), ctxWith());
    assert.equal(r.ok, true, r.error);
    const c = f.calls[0];
    assert.equal(c.url.origin + c.url.pathname, "https://graph.microsoft.com/v1.0/me/messages");
    assert.equal(c.url.searchParams.get("$top"), "10");
    assert.equal(c.url.searchParams.get("$orderby"), "receivedDateTime desc");
    assert.equal(c.headers.authorization, "Bearer mtok");
    assert.deepEqual(r.data, [{ id: "AAMkAD1", subject: "Hi", from: "a@x.com", receivedAt: "2026-10-01T00:00:00Z", preview: "p", conversationId: "c1", isRead: false }]);
    await a.invoke("list_messages", { search: 'invoice "march"' }, oauthCred(), ctxWith());
    assert.equal(f.calls[1].url.searchParams.get("$search"), '"invoice march"');
    assert.equal(f.calls[1].url.searchParams.get("$orderby"), null);
  });

  it("send_email: POST /me/sendMail with the Graph message shape (202, no retry)", async () => {
    const f = scriptedFetch([new Response(null, { status: 202 })]);
    const r = await new OutlookAdapter(liveDeps(f.fetchImpl).deps).invoke(
      "send_email",
      { to: "ada@example.com", cc: "c@example.com", subject: "Hello", body: "Text body" },
      oauthCred(),
      ctxWith(),
    );
    assert.equal(r.ok, true, r.error);
    assert.equal(f.calls[0].method, "POST");
    assert.equal(f.calls[0].url.href, "https://graph.microsoft.com/v1.0/me/sendMail");
    assert.deepEqual(f.calls[0].body, {
      message: {
        subject: "Hello",
        body: { contentType: "Text", content: "Text body" },
        toRecipients: [{ emailAddress: { address: "ada@example.com" } }],
        ccRecipients: [{ emailAddress: { address: "c@example.com" } }],
        bccRecipients: [],
      },
      saveToSentItems: true,
    });
  });

  it("reply_to_message: POST /me/messages/{id}/reply (or replyAll) with a comment", async () => {
    const f = scriptedFetch([new Response(null, { status: 202 }), new Response(null, { status: 202 })]);
    const a = new OutlookAdapter(liveDeps(f.fetchImpl).deps);
    await a.invoke("reply_to_message", { messageId: "AAMkAD1xyz", body: "Thanks" }, oauthCred(), ctxWith());
    await a.invoke("reply_to_message", { messageId: "AAMkAD1xyz", body: "Thanks all", replyAll: true }, oauthCred(), ctxWith());
    assert.equal(f.calls[0].url.pathname, "/v1.0/me/messages/AAMkAD1xyz/reply");
    assert.deepEqual(f.calls[0].body, { comment: "Thanks" });
    assert.equal(f.calls[1].url.pathname, "/v1.0/me/messages/AAMkAD1xyz/replyAll");
  });

  it("get_message asks Graph for a text body; health check reads /me", async () => {
    const f = scriptedFetch([
      jsonResponse(200, { id: "AAMkAD1xyz", subject: "S", body: { contentType: "text", content: "Plain" }, toRecipients: [{ emailAddress: { address: "me@x.com" } }] }),
      jsonResponse(200, { mail: "me@x.com", displayName: "Me" }),
    ]);
    const a = new OutlookAdapter(liveDeps(f.fetchImpl).deps);
    const r = await a.invoke("get_message", { messageId: "AAMkAD1xyz" }, oauthCred(), ctxWith());
    assert.equal(f.calls[0].headers.prefer, 'outlook.body-content-type="text"');
    assert.equal((r.data as { bodyText: string }).bodyText, "Plain");
    const h = await a.healthCheck(oauthCred(), ctxWith());
    assert.deepEqual(h.data, { email: "me@x.com", name: "Me" });
  });

  it("labelled mock without a credential (dev/test): sends nothing", async () => {
    const f = scriptedFetch([]);
    const r = await new OutlookAdapter(liveDeps(f.fetchImpl).deps).invoke("send_email", { to: "a@x.com", subject: "s", body: "b" }, null, ctxWith());
    assert.equal(r.mock, true);
    assert.equal((r.data as { sent: boolean }).sent, false);
    assert.equal(f.calls.length, 0);
  });

  it("OAuth: Microsoft identity platform v2 authorize URL with offline_access + Graph scopes", () => {
    process.env.MICROSOFT_OAUTH_CLIENT_ID = "ms-client";
    process.env.MARKETR_CREDENTIALS_KEY ||= "0".repeat(64);
    try {
      const { url } = startOAuthFlow("u1", "ws1", "outlook", "https://app.example.com");
      const u = new URL(url);
      assert.equal(u.origin + u.pathname, "https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
      assert.equal(u.searchParams.get("redirect_uri"), "https://app.example.com/api/oauth/callback");
      const scope = u.searchParams.get("scope") ?? "";
      for (const s of ["offline_access", "https://graph.microsoft.com/Mail.Send", "https://graph.microsoft.com/Mail.Read"]) assert.ok(scope.includes(s), s);
      assert.equal(OAUTH_CONFIGS.outlook.tokenUrl, "https://login.microsoftonline.com/common/oauth2/v2.0/token");
    } finally {
      delete process.env.MICROSOFT_OAUTH_CLIENT_ID;
    }
    assert.equal(connectorGroup("outlook"), "email");
    assert.equal(connectorAction("outlook", "send_email"), "send_outreach_email");
  });
});
