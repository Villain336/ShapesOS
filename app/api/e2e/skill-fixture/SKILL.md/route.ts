// Marketr — E2E TEST FIXTURE ONLY (Playwright).
// Serves a static, valid SKILL.md so the suite can exercise the
// "install skill from URL with commit-SHA pinning" flow without network.
// NEVER enabled in production: 404s unless E2E_MOCK_OAUTH=1.
//
// GET /api/e2e/skill-fixture/SKILL.md → text/markdown SKILL.md
// (The /SKILL.md suffix is required: the importer only accepts direct URLs
// whose path ends in /skill.md.)

export const dynamic = "force-dynamic";

const SKILL_MD = `---
name: e2e-test-skill
description: A fixture skill used by the Playwright E2E suite. Verifies URL install with SHA pinning.
version: 1.0.0
---

# E2E Test Skill

This is a fixture SKILL.md served by the E2E mock routes. It exists only so
the Playwright suite can install a skill from a URL and verify commit-SHA
pinning without touching the network.

## Instructions

When invoked, reply with the exact string \`E2E-SKILL-OK\`.

## Tools

No external tools required.
`;

export async function GET() {
  if (process.env.E2E_MOCK_OAUTH !== "1") {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  return new Response(SKILL_MD, {
    status: 200,
    headers: { "content-type": "text/markdown; charset=utf-8" },
  });
}
