// Marketr mobile — registry subset test.
//
// The web registry (lib/agents/components/registry.ts) is the allowlist
// authority. This test reads the REAL registry file (no import — the web
// module pulls in web-only components) and asserts:
//   1. every natively-mapped name is on the web allowlist (subset rule);
//   2. the mobile WEB_REGISTRY_NAMES mirror matches the web registry exactly;
//   3. approval_card (the required minimum) is natively mapped.
//
// Parsed as text on purpose: importing the web registry would drag React DOM
// components into the native bundle's test graph.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const WEB_REGISTRY_PATH = join(__dirname, "..", "..", "lib", "agents", "components", "registry.ts");
const NATIVE_REGISTRY_PATH = join(__dirname, "..", "src", "components", "registry.native.ts");

/** Keys of the GENERATIVE_COMPONENT_REGISTRY object literal. */
function webRegistryNames(): string[] {
  const src = readFileSync(WEB_REGISTRY_PATH, "utf8");
  const start = src.indexOf("GENERATIVE_COMPONENT_REGISTRY = {");
  const end = src.indexOf("} as const satisfies", start);
  if (start < 0 || end < 0) throw new Error("could not locate GENERATIVE_COMPONENT_REGISTRY in the web registry");
  const literal = src.slice(start, end);
  const names = [...literal.matchAll(/^\s{2}([A-Za-z0-9_]+):\s*\{/gm)].map((m) => m[1]!);
  if (names.length === 0) throw new Error("parsed zero component names from the web registry");
  return names;
}

/** Keys of the mobile NATIVE_GENERATIVE_COMPONENTS object literal. */
function nativeMappedNames(): string[] {
  const src = readFileSync(NATIVE_REGISTRY_PATH, "utf8");
  const start = src.indexOf("NATIVE_GENERATIVE_COMPONENTS = {");
  const end = src.indexOf("} as const satisfies", start);
  if (start < 0 || end < 0) throw new Error("could not locate NATIVE_GENERATIVE_COMPONENTS in the native registry");
  const literal = src.slice(start, end);
  return [...literal.matchAll(/^\s{2}([A-Za-z0-9_]+):\s*\{/gm)].map((m) => m[1]!);
}

/** The mobile WEB_REGISTRY_NAMES mirror set literal. */
function nativeWebMirrorNames(): string[] {
  const src = readFileSync(NATIVE_REGISTRY_PATH, "utf8");
  const m = /WEB_REGISTRY_NAMES[^=]*=\s*new Set\(\[([^\]]*)\]\)/.exec(src);
  if (!m) throw new Error("could not locate WEB_REGISTRY_NAMES in the native registry");
  return [...m[1]!.matchAll(/"([A-Za-z0-9_]+)"/g)].map((x) => x[1]!);
}

describe("native registry subset", () => {
  it("every natively-mapped name is on the web allowlist", () => {
    const web = new Set(webRegistryNames());
    for (const name of nativeMappedNames()) {
      expect(web.has(name), `native component "${name}" is not on the web allowlist`).toBe(true);
    }
  });

  it("the WEB_REGISTRY_NAMES mirror matches the web registry exactly", () => {
    expect([...nativeWebMirrorNames()].sort()).toEqual([...webRegistryNames()].sort());
  });

  it("approval_card is natively mapped (required minimum)", () => {
    expect(nativeMappedNames()).toContain("approval_card");
  });

  it("the web allowlist currently under test is the expected set", () => {
    // Guards against silent registry growth: a new web component must get an
    // explicit mobile mapping decision (map it or document the fallback).
    // Phase 17 slice 7 decision: the three ops cards are WEB-ONLY — mobile
    // falls back to "open on web" for them (ops_invoice_card,
    // ops_order_card, ops_workflow_run_card are not natively mapped).
    expect([...webRegistryNames()].sort()).toEqual([
      "approval_card",
      "ops_invoice_card",
      "ops_order_card",
      "ops_workflow_run_card",
      "report_preview",
    ]);
  });
});
