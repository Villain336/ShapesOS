// Phase 11 (devtools): the Netlify connector's hosting-connection reference
// against Postgres (as the app role). The vault stores only
// { hostingConnectionId }; at invoke time the adapter loads and decrypts that
// hosting connection through lib/deploy — but only inside the calling
// workspace and only for a Netlify target. Netlify itself is stubbed.
// Listed in scripts/test/db-tests.txt.
// Run: DATABASE_URL=… MARKETR_CREDENTIALS_KEY=… npx tsx --test lib/connectors/m21/live/__tests__/netlify-hosting-db.test.ts

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import { encryptHostingConfig } from "@/lib/deploy";
import { storeCredentialPayload } from "@/lib/vault/apikey";
import { getDecryptedCredential } from "@/lib/vault/refresh";
import { NetlifyM21Adapter } from "../../native/netlify";
import { jsonResponse, scriptedFetch } from "./fixtures";

const RUN = `p11d-${Date.now().toString(36)}`;
const WS_A = `${RUN}-a`;
const WS_B = `${RUN}-b`;
const USER = `${RUN}-user`;
let netlifyConn = "";
let vercelConn = "";

before(async () => {
  for (const id of [WS_A, WS_B]) await prisma.workspace.create({ data: { id, name: `P11 ${id}`, ownerUserId: USER } });
  const project = await prisma.project.create({ data: { workspaceId: WS_A, domain: `${RUN}.example` } });
  netlifyConn = (
    await prisma.hostingConnection.create({
      data: { projectId: project.id, name: "Prod Netlify", target: "netlify", configEnc: encryptHostingConfig({ token: "nfp_db_test_token_1", siteId: "acme-site" }) },
    })
  ).id;
  vercelConn = (
    await prisma.hostingConnection.create({
      data: { projectId: project.id, name: "Vercel", target: "vercel", configEnc: encryptHostingConfig({ token: "vercel_tok" }) },
    })
  ).id;
});

after(async () => {
  await prisma.connectorConnection.deleteMany({ where: { workspaceId: { in: [WS_A, WS_B] } } });
  for (const id of [WS_A, WS_B]) await prisma.workspace.deleteMany({ where: { id } });
  await prisma.$disconnect();
});

describe("Netlify connector ↔ hosting connection", () => {
  it("the vault stores only the reference, never the Netlify token", async () => {
    const conn = await storeCredentialPayload(USER, WS_A, "netlify", "Prod Netlify", { hostingConnectionId: netlifyConn });
    assert.equal(conn.status, "active");
    const cred = await getDecryptedCredential(conn.id);
    assert.deepEqual(cred, { kind: "api_key", payload: { hostingConnectionId: netlifyConn } });
    const row = await prisma.connectorCredential.findUnique({ where: { connectionId: conn.id } });
    assert.doesNotMatch(row?.encryptedBlob ?? "", /nfp_db_test_token_1/);
  });

  it("invoke in the owning workspace decrypts the hosting token and uses its site", async () => {
    const f = scriptedFetch([jsonResponse(200, [{ id: "d1aaaaaaaaaaaaaaaaaaaaaa", state: "ready", ssl_url: "https://acme.netlify.app" }])]);
    const a = new NetlifyM21Adapter({ fetchImpl: f.fetchImpl });
    const r = await a.invoke("list_deploys", {}, { kind: "api_key", payload: { hostingConnectionId: netlifyConn } }, { workspaceId: WS_A, userId: USER });
    assert.equal(r.ok, true, r.error);
    assert.equal(f.calls[0].headers.authorization, "Bearer nfp_db_test_token_1");
    assert.equal(f.calls[0].url.pathname, "/api/v1/sites/acme-site/deploys");
  });

  it("another workspace cannot use the reference; a non-Netlify hosting connection is never loaded", async () => {
    const f = scriptedFetch([]);
    const a = new NetlifyM21Adapter({ fetchImpl: f.fetchImpl });
    const cross = await a.invoke("list_sites", {}, { kind: "api_key", payload: { hostingConnectionId: netlifyConn } }, { workspaceId: WS_B, userId: USER });
    assert.equal(cross.ok, false);
    assert.equal(cross.errorCode, "not_found");
    const vercel = await a.invoke("list_sites", {}, { kind: "api_key", payload: { hostingConnectionId: vercelConn } }, { workspaceId: WS_A, userId: USER });
    assert.equal(vercel.errorCode, "not_found");
    assert.equal(f.calls.length, 0, "no Netlify call without a valid, in-workspace hosting connection");
  });
});
