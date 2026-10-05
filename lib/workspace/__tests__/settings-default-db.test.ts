// Regression (Phase 6, found by the e2e CI job): a workspace's first
// workspace_settings row must be creatable without listing every column —
// agent_allow_list (NOT NULL) had lost its default, so the Governance and
// Defaults pages 500'd for any workspace that never saved settings.
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";

const WS = `ws-settings-default-${Date.now().toString(36)}`;

after(async () => {
  await prisma.workspace.deleteMany({ where: { id: WS } });
  await prisma.$disconnect();
});

describe("workspace_settings defaults", () => {
  it("creates the first settings row with only the workspace id", async () => {
    await prisma.workspace.create({ data: { id: WS, name: "Settings default", ownerUserId: "settings-default-owner" } });
    const row = await prisma.workspaceSettings.create({ data: { workspaceId: WS, updatedBy: "settings-default-owner" } });
    assert.deepEqual(row.agentAllowList, []);
    const raw = await prisma.$queryRaw<Array<{ d: string | null }>>`
      SELECT column_default AS d FROM information_schema.columns
      WHERE table_name = 'workspace_settings' AND column_name = 'agent_allow_list'`;
    assert.ok(raw[0]?.d, "agent_allow_list keeps a database default");
  });
});
