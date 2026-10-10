// ShapesOS — Phase 21B (WS=drive): the NATIVE provider (Postgres registry + local-disk
// storage, as the least-privilege app role) passes the same contract suite as every
// other provider, and cannot see more than its actor can.
// Run: DATABASE_URL=<app role url> npx tsx --test lib/drive/providers/__tests__/native-db.test.ts
// Listed in scripts/test/db-tests.txt.

import "dotenv/config";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.MARKETR_STORAGE = "local";
process.env.MARKETR_STORAGE_DIR = mkdtempSync(join(tmpdir(), "p21b-native-"));
delete process.env.DEPLOYMENT_MODE;
delete process.env.CLAMAV_HOST;

import { prisma } from "@/lib/prisma";
import { NativeProvider } from "../native";
import { createFolderAs } from "../../ops";
import { ProviderError } from "../types";
import { runProviderContract } from "./contract-suite";

const RUN = randomUUID().slice(0, 8);
const WS = `p21n-${RUN}`;
const ANA = `p21n-ana-${RUN}`;
const BEN = `p21n-ben-${RUN}`;
const ana = { workspaceId: WS, userId: ANA, role: "editor" as const };
const ben = { workspaceId: WS, userId: BEN, role: "editor" as const };

before(async () => {
  await prisma.workspace.deleteMany({ where: { id: WS } });
  await prisma.workspace.create({ data: { id: WS, name: WS, ownerUserId: ANA } });
  await prisma.workspaceMember.createMany({
    data: [
      { workspaceId: WS, userId: ANA, role: "editor", email: `ana-${RUN}@example.test`, name: "Ana" },
      { workspaceId: WS, userId: BEN, role: "editor", email: `ben-${RUN}@example.test`, name: "Ben" },
    ],
  });
  await createFolderAs(ana, "/shared/ProviderRoot");
  await createFolderAs(ana, `/home/${ANA}/Private`);
});
after(async () => {
  await new Promise((r) => setTimeout(r, 300));
  await prisma.workspace.deleteMany({ where: { id: WS } });
  await prisma.$disconnect();
});

runProviderContract("native (Postgres registry + local-disk storage)", async () => ({
  provider: new NativeProvider(ana, "/shared/ProviderRoot"),
  sampleText: (s) => Buffer.from(s, "utf8"),
}));

describe("native provider scoping", () => {
  it("a provider rooted in one person's private home is invisible to another person's provider", async () => {
    const mine = new NativeProvider(ana, `/home/${ANA}/Private`);
    await mine.write("/secret.txt", Buffer.from("s3cret"));
    const theirs = new NativeProvider(ben, `/home/${ANA}/Private`);
    assert.equal(await theirs.stat("/secret.txt"), null);
    await assert.rejects(() => theirs.list("/"), (e: unknown) => e instanceof ProviderError && e.code === "not_found");
    await assert.rejects(() => theirs.write("/x.txt", Buffer.from("x")), (e: unknown) => e instanceof ProviderError && e.code === "not_found");
  });
});
