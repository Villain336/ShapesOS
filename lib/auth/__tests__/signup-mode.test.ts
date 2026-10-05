// ShapesOS — Phase 1: SIGNUP_MODE=open|invite.
// DB-backed (scripts/test/db-tests.txt).

import "dotenv/config";
import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { prisma } from "@/lib/prisma";
import {
  InviteRequiredError,
  mayProvisionWorkspace,
  signInAllowed,
  signupMode,
} from "../signup";

const env = (mode?: string) => ({ ...(mode ? { SIGNUP_MODE: mode } : {}) }) as NodeJS.ProcessEnv;
const WS = "p1-signup-ws";
const STRANGER = "p1-signup-stranger";
const MEMBER = "p1-signup-member";

describe("signupMode / mayProvisionWorkspace (pure)", () => {
  it("defaults to open; only 'invite' switches", () => {
    assert.equal(signupMode(env()), "open");
    assert.equal(signupMode(env("open")), "open");
    assert.equal(signupMode(env(" Invite ")), "invite");
    assert.equal(signupMode(env("nonsense")), "open");
  });
  it("invite mode provisions only the operator", () => {
    assert.equal(mayProvisionWorkspace(STRANGER, env()), true);
    assert.equal(mayProvisionWorkspace(STRANGER, env("invite")), false);
    assert.equal(mayProvisionWorkspace("admin:ops@x.test", env("invite")), true);
  });
});

describe("invite mode (DB)", () => {
  const prevMode = process.env.SIGNUP_MODE;
  before(async () => {
    await prisma.$executeRaw`DELETE FROM workspaces WHERE id = ${WS} OR owner_user_id IN (${STRANGER}, ${MEMBER})`;
    await prisma.$executeRaw`INSERT INTO workspaces (id, name, owner_user_id, updated_at)
      VALUES (${WS}, ${WS}, ${"p1-signup-owner"}, now())`;
    await prisma.workspaceMember.create({ data: { workspaceId: WS, userId: MEMBER, role: "editor", email: "member@signup.test" } });
    await prisma.workspaceMember.create({
      data: {
        workspaceId: WS,
        email: "invitee@signup.test",
        role: "viewer",
        inviteToken: "p1-signup-token-live",
        inviteExpiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    await prisma.workspaceMember.create({
      data: {
        workspaceId: WS,
        email: "late@signup.test",
        role: "viewer",
        inviteToken: "p1-signup-token-expired",
        inviteExpiresAt: new Date(Date.now() - 1000),
      },
    });
  });
  afterEach(() => {
    if (prevMode === undefined) delete process.env.SIGNUP_MODE;
    else process.env.SIGNUP_MODE = prevMode;
  });
  after(async () => {
    await prisma.$executeRaw`DELETE FROM workspaces WHERE id = ${WS} OR owner_user_id IN (${STRANGER}, ${MEMBER})`;
    await prisma.$disconnect();
  });

  it("sign-in: strangers refused; operator, members and live invitees allowed", async () => {
    const inv = env("invite");
    assert.equal(await signInAllowed(STRANGER, "stranger@signup.test", inv), false);
    assert.equal(await signInAllowed("admin:ops@signup.test", "ops@signup.test", inv), true);
    assert.equal(await signInAllowed(MEMBER, "member@signup.test", inv), true);
    assert.equal(await signInAllowed("p1-signup-new", "INVITEE@signup.test", inv), true);
    assert.equal(await signInAllowed("p1-signup-late", "late@signup.test", inv), false);
    assert.equal(await signInAllowed(undefined, undefined, inv), false);
    // Open mode lets everyone in.
    assert.equal(await signInAllowed(STRANGER, "stranger@signup.test", env("open")), true);
  });

  it("getOrCreateWorkspace: invite mode refuses to provision a stranger", async () => {
    process.env.SIGNUP_MODE = "invite";
    const { getOrCreateWorkspace } = await import("@/lib/session");
    await assert.rejects(() => getOrCreateWorkspace(STRANGER, "stranger@signup.test"), InviteRequiredError);
    assert.equal(await prisma.workspace.count({ where: { ownerUserId: STRANGER } }), 0);
    // Existing members still resolve their workspace.
    const ws = await getOrCreateWorkspace(MEMBER, "member@signup.test");
    assert.equal(ws.id, WS);
  });

  it("getOrCreateWorkspace: open mode still provisions", async () => {
    process.env.SIGNUP_MODE = "open";
    const { getOrCreateWorkspace } = await import("@/lib/session");
    const ws = await getOrCreateWorkspace(STRANGER, "stranger@signup.test");
    assert.equal(ws.ownerUserId, STRANGER);
  });

  it("auth.ts signIn callback routes refused users to /invite-required (text pin)", () => {
    const src = readFileSync("auth.ts", "utf8");
    assert.match(src, /signupMode\(\) === "invite"/);
    assert.match(src, /signInAllowed\(user\?\.id, user\?\.email\)\)\) return INVITE_REQUIRED_PATH/);
  });
});
