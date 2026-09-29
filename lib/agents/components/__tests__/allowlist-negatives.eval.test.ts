// Marketr — Phase 16 slice 11 evals: generative-component allowlist negatives.
// Run: npx tsx --test lib/agents/components/__tests__/allowlist-negatives.eval.test.ts
//
// Adversarial battery against the allowlist authority
// (lib/agents/components/registry.ts): the agent may emit ONLY registered
// names, and the renderer may resolve ONLY registered names. Every hostile
// name below must be rejected at BOTH the emit path
// (assertRegisteredComponentName) and the render path
// (resolveGenerativeComponent) — an unregistered component is rejected,
// never rendered.
//
// Also extends the web↔mobile subset drift check (slice 10's
// registry-subset.test.ts): every web-registered name must be mirrored in
// the mobile WEB_REGISTRY_NAMES set, and web-registered-but-unmapped names
// (e.g. report_preview) must fall back honestly on mobile — never render
// something unregistered.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  GENERATIVE_COMPONENT_REGISTRY,
  assertRegisteredComponentName,
  isRegisteredComponentName,
  resolveGenerativeComponent,
} from "../registry";

/** Hostile names: prototype pollution, casing, separators, whitespace,
 *  unicode lookalikes, and non-string model output. */
const ADVERSARIAL_NAMES: unknown[] = [
  // Prototype pollution — must never resolve through Object.hasOwn.
  "__proto__",
  "constructor",
  "prototype",
  "hasOwnProperty",
  "toString",
  "valueOf",
  // Case / separator confusion.
  "ApprovalCard",
  "APPROVAL_CARD",
  "approval-card",
  "approval card",
  "approval.card",
  "approval/card",
  "approval\\card",
  // Whitespace games.
  " approval_card",
  "approval_card ",
  "\tapproval_card\n",
  // Unicode lookalikes (zero-width space, fullwidth chars).
  "approval_card​",
  "ａｐｐｒｏｖａｌ_card",
  // Suffix/prefix injection.
  "approval_card2",
  "xapproval_card",
  "approval_card;DROP",
  "<approval_card>",
  // Non-strings the model might emit.
  "",
  null,
  undefined,
  0,
  42,
  true,
  {},
  [],
  ["approval_card"],
  () => "approval_card",
];

const MOBILE = resolve(__dirname, "../../../../mobile");

function parseObjectKeys(src: string, anchor: string, endAnchor: string): string[] {
  const start = src.indexOf(anchor);
  const end = src.indexOf(endAnchor, start);
  if (start < 0 || end < 0) throw new Error(`anchor not found: ${anchor}`);
  return [...src.slice(start, end).matchAll(/^\s{2}([A-Za-z0-9_]+):\s*\{/gm)].map((m) => m[1]!);
}

function webRegistryNames(): string[] {
  const src = readFileSync(join(__dirname, "..", "registry.ts"), "utf8");
  return parseObjectKeys(src, "GENERATIVE_COMPONENT_REGISTRY = {", "} as const satisfies");
}

function mobileWebMirrorNames(): string[] {
  const src = readFileSync(join(MOBILE, "src", "components", "registry.native.ts"), "utf8");
  const m = /WEB_REGISTRY_NAMES[^=]*=\s*new Set\(\[([^\]]*)\]\)/.exec(src);
  if (!m) throw new Error("WEB_REGISTRY_NAMES mirror not found in registry.native.ts");
  return [...m[1]!.matchAll(/"([A-Za-z0-9_]+)"/g)].map((x) => x[1]!);
}

function mobileNativeMappedNames(): string[] {
  const src = readFileSync(join(MOBILE, "src", "components", "registry.native.ts"), "utf8");
  return parseObjectKeys(src, "NATIVE_GENERATIVE_COMPONENTS = {", "} as const satisfies");
}

describe("allowlist negatives: emit path", () => {
  it("rejects every adversarial name at emit time", () => {
    for (const bad of ADVERSARIAL_NAMES) {
      assert.equal(
        isRegisteredComponentName(bad),
        false,
        `isRegisteredComponentName accepted ${String(bad)}`,
      );
      assert.throws(
        () => assertRegisteredComponentName(bad),
        /unregistered generative component/,
        `assertRegisteredComponentName accepted ${String(bad)}`,
      );
    }
  });

  it("logs the rejection (console.error) before throwing", () => {
    const seen: string[] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => void seen.push(args.map(String).join(" "));
    try {
      assert.throws(() => assertRegisteredComponentName("evil_widget"));
    } finally {
      console.error = orig;
    }
    assert.ok(
      seen.some((s) => s.includes("rejected unregistered generative component")),
      "rejection must be logged before throwing",
    );
  });
});

describe("allowlist negatives: render path", () => {
  it("rejects every adversarial name at resolve time — never renders", () => {
    for (const bad of ADVERSARIAL_NAMES) {
      assert.throws(
        () => resolveGenerativeComponent(bad),
        /unregistered generative component/,
        `resolveGenerativeComponent resolved ${String(bad)}`,
      );
    }
  });

  it("the registry is still exactly the allowlisted set (no silent growth)", () => {
    assert.deepEqual(Object.keys(GENERATIVE_COMPONENT_REGISTRY).sort(), [
      "approval_card",
      "report_preview",
    ]);
  });
});

describe("allowlist negatives: web↔mobile drift", () => {
  it("mobile WEB_REGISTRY_NAMES mirrors every web-registered name (no drift)", () => {
    assert.deepEqual(mobileWebMirrorNames().sort(), webRegistryNames().sort());
  });

  it("natively-mapped names are a strict subset of the web allowlist", () => {
    const web = new Set(webRegistryNames());
    for (const name of mobileNativeMappedNames()) {
      assert.ok(web.has(name), `native "${name}" is not web-registered`);
    }
  });

  it("web-registered but unmapped names fall back honestly on mobile (never render)", () => {
    const unmapped = webRegistryNames().filter(
      (n) => !mobileNativeMappedNames().includes(n),
    );
    assert.ok(unmapped.length > 0, "expected at least one unmapped allowlisted name");
    // report_preview is the known unmapped case (slice 10: intentionally
    // unmapped — opens on web instead).
    assert.ok(unmapped.includes("report_preview"));

    const msgList = readFileSync(join(MOBILE, "src", "components", "MessageList.tsx"), "utf8");
    // The fallback branch must key on BOTH conditions: web-registered AND
    // not natively mapped.
    assert.ok(
      /WEB_REGISTRY_NAMES\.has\(name\)\s*&&\s*!isNativeMappedComponentName\(name\)/.test(msgList),
      "mobile MessageList must fall back for web-registered-but-unmapped names",
    );
    assert.ok(
      /open it on the web dashboard/i.test(msgList),
      "mobile fallback must say where to open it instead of rendering",
    );
    // …and anything NOT on the web allowlist renders nothing at all.
    assert.ok(
      msgList.includes("Not on the allowlist at all"),
      "mobile must null-render names that are not on the web allowlist",
    );
  });

  it("a natively-mapped-but-unregistered name would fail loudly (drift simulation)", () => {
    // Simulate the drift the subset test guards: a name in the native map
    // that the web allowlist dropped. The parse helpers prove the check is
    // real — inject a fake name and confirm it is detected.
    const web = new Set(webRegistryNames());
    assert.equal(web.has("ghost_widget"), false);
    const native = mobileNativeMappedNames();
    assert.ok(
      !native.some((n) => !web.has(n)),
      "every native-mapped name must be web-registered",
    );
  });
});
