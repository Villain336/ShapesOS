// ShapesOS — Phase 21B (WS=drive): which roots a person may write to (unit).
// Run: npx tsx --test lib/drive/__tests__/roots.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeFolderPath } from "../../filesystem/paths";
import { personMayWriteTo } from "../roots";

const info = (p: string) => {
  const r = normalizeFolderPath(p);
  assert.ok(r.ok, p);
  return r;
};

describe("personMayWriteTo", () => {
  it("allows /files, /memory, /shared and their own home", () => {
    for (const p of ["/files/a", "/memory", "/shared/Marketing", "/home/u1/Docs", "/home/u1"]) {
      assert.deepEqual(personMayWriteTo(info(p), "u1"), { ok: true }, p);
    }
  });
  it("refuses someone else's home, even by id", () => {
    assert.equal(personMayWriteTo(info("/home/u2/Docs"), "u1").ok, false);
  });
  it("refuses roots that belong to the system: skills, artifacts, app containers, mounts", () => {
    for (const p of ["/skills/x", "/artifacts/x", "/apps/crm/i1/x", "/mounts/google-drive/x"]) {
      const v = personMayWriteTo(info(p), "u1");
      assert.equal(v.ok, false, p);
    }
  });
  it("lets a person add to an agent run's workspace", () => {
    assert.deepEqual(personMayWriteTo(info("/agents/run1/notes"), "u1"), { ok: true });
  });
});
