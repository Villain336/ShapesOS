// Deploy PR: every .env.example key has a Render decision, the generated
// render.yaml env groups and RENDER.md block are fresh, and `push` only ever
// writes owner-pasted keys (against a FAKE fetch — no Render API is called).
// Run: npx tsx --test scripts/deploy/__tests__/render-env.test.mts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  APP_ORIGIN,
  GROUPS,
  TABLE,
  envExampleKeys,
  expectedFiles,
  parseDotenv,
  pushSecrets,
  renderYamlGroups,
  tableMap,
  validate,
} from "../render-env.mjs";

describe("render-env table", () => {
  it("classifies every .env.example key exactly once, with no problems", () => {
    assert.deepEqual(validate(readFileSync(".env.example", "utf8")), []);
  });

  it("an unclassified .env.example key is reported", () => {
    const problems = validate(readFileSync(".env.example", "utf8") + "\n#BRAND_NEW_SETTING=\"\"\n");
    assert.deepEqual(problems, ["BRAND_NEW_SETTING is in .env.example but not classified in scripts/deploy/render-env.mjs"]);
  });

  it("render.yaml and docs/deploy/RENDER.md hold the generated output (run --write after editing the table)", () => {
    for (const [file, text] of Object.entries(expectedFiles())) {
      assert.equal(readFileSync(file, "utf8"), text, `${file} is stale: node scripts/deploy/render-env.mjs --write`);
    }
  });

  it("hosted essentials are set the way the plan requires", () => {
    const m = tableMap();
    const v = (k: string) => m.get(k);
    assert.equal(v("DEPLOYMENT_MODE")?.value, "hosted");
    assert.equal(v("MARKETR_STORAGE")?.value, "s3");
    assert.equal(v("CRON_RUNNER")?.value, "internal");
    assert.equal(v("CRON_RUNNER")?.group, "shapesos-web");
    assert.equal(v("AGENT_WORKER")?.value, "external");
    assert.equal(v("KEEP_ALIVE_TIMEOUT")?.value, "310000");
    for (const k of ["NEXTAUTH_URL", "AUTH_URL", "APP_URL", "NEXT_PUBLIC_APP_URL"]) assert.equal(v(k)?.value, APP_ORIGIN, k);
    for (const k of ["AUTH_SECRET", "MARKETR_CREDENTIALS_KEY", "CRON_SECRET", "APP_DB_PASSWORD"]) assert.equal(v(k)?.cls, "generate", k);
    // The owner's URL must never reach web or worker through a group.
    assert.equal(v("DATABASE_URL")?.cls, "service");
  });

  it("platform and connect keys from docs/KEYS.md are pasted, not dropped", () => {
    const keysMd = readFileSync("docs/KEYS.md", "utf8");
    const table = keysMd.slice(keysMd.indexOf("<!-- BEGIN keys-table"), keysMd.indexOf("<!-- END keys-table"));
    const m = tableMap();
    // Deliberate: LLM_API_KEY would override OPENAI_API_KEY; hosted uses the latter.
    const deliberate = new Set(["LLM_API_KEY"]);
    for (const row of table.split("\n").filter((l) => /\| (Platform|Both|Connect) \|/.test(l))) {
      for (const [, key] of row.matchAll(/`([A-Z][A-Z0-9_]+)`/g)) {
        const spec = m.get(key!);
        assert.ok(spec, `${key} (docs/KEYS.md) is not classified`);
        // A few defaults are deliberately not set (e.g. ZERNIO_BASE_URL); the
        // credentials themselves must be settable.
        if (/_(KEY|SECRET|TOKEN|PASSWORD|LOGIN|SID|ID)$/.test(key!) && !deliberate.has(key!)) {
          assert.ok(["paste", "generate"].includes(spec!.cls), `${key} must be pasteable on Render, is ${spec!.cls}`);
        }
      }
    }
  });

  it("no key sits in two groups and every group is real", () => {
    const seen = new Set<string>();
    for (const [k, s] of TABLE) {
      assert.ok(!seen.has(k), k);
      seen.add(k);
      if (s.group) assert.ok(s.group in GROUPS, `${k}: ${s.group}`);
    }
  });

  it("generated values are YAML-safe double-quoted strings", () => {
    const yaml = renderYamlGroups();
    assert.match(yaml, /- key: NEXT_PUBLIC_APP_URL\n {8}value: "https:\/\/app\.shapesos\.com"/);
    assert.doesNotMatch(yaml, /^\s+sync:/m);
  });

  it("envExampleKeys reads commented and uncommented keys", () => {
    assert.deepEqual(envExampleKeys('A=1\n#B=""\n# C=x\n#  D=no\nlower=no\n'), ["A", "B", "C"]);
  });
});

describe("parseDotenv", () => {
  it("handles quotes, comments, export and \\n in double quotes; drops empty values", () => {
    const m = parseDotenv(
      [
        "# comment",
        "A=plain   # trailing comment",
        'B="quoted # not a comment"',
        "C='single'",
        "export D=exported",
        'PEM="-----BEGIN-----\\nabc\\n-----END-----"',
        "EMPTY=",
        "  ",
        "not a line",
      ].join("\n"),
    );
    assert.deepEqual(Object.fromEntries(m), {
      A: "plain",
      B: "quoted # not a comment",
      C: "single",
      D: "exported",
      PEM: "-----BEGIN-----\nabc\n-----END-----",
    });
  });
});

describe("pushSecrets (fake fetch)", () => {
  function fakeFetch() {
    const calls: Array<{ url: string; method: string; body?: string; auth?: string }> = [];
    const fn = async (url: string, init: RequestInit = {}) => {
      const headers = init.headers as Record<string, string>;
      calls.push({ url, method: init.method ?? "GET", body: init.body as string | undefined, auth: headers?.Authorization });
      if (url.includes("/env-groups?name=")) {
        const name = decodeURIComponent(/name=([^&]+)/.exec(url)![1]!);
        return new Response(JSON.stringify([{ envGroup: { id: `evg-${name}`, name } }]), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    };
    return { fn: fn as unknown as typeof fetch, calls };
  }

  it("puts each pasted key into its group and logs names only", async () => {
    const { fn, calls } = fakeFetch();
    const logs: string[] = [];
    const values = new Map([
      ["ANTHROPIC_API_KEY", "sk-ant-secret"],
      ["STRIPE_WEBHOOK_SECRET", "whsec_secret"],
    ]);
    const plan = await pushSecrets({ values, apiKey: "rnd_key", fetchImpl: fn, base: "https://api.example.test/v1", log: (l: string) => logs.push(l) });
    assert.deepEqual(plan, [
      ["ANTHROPIC_API_KEY", "shapesos-shared"],
      ["STRIPE_WEBHOOK_SECRET", "shapesos-web"],
    ]);
    const puts = calls.filter((c) => c.method === "PUT");
    assert.deepEqual(
      puts.map((c) => [c.url, JSON.parse(c.body!)]),
      [
        ["https://api.example.test/v1/env-groups/evg-shapesos-shared/env-vars/ANTHROPIC_API_KEY", { value: "sk-ant-secret" }],
        ["https://api.example.test/v1/env-groups/evg-shapesos-web/env-vars/STRIPE_WEBHOOK_SECRET", { value: "whsec_secret" }],
      ],
    );
    for (const c of calls) assert.equal(c.auth, "Bearer rnd_key");
    assert.ok(logs.every((l) => !/secret|sk-ant/.test(l.replace(/STRIPE_WEBHOOK_SECRET/, ""))), logs.join("\n"));
  });

  it("refuses generated, fixed, excluded and unknown keys before calling anything", async () => {
    const { fn, calls } = fakeFetch();
    for (const k of ["AUTH_SECRET", "DEPLOYMENT_MODE", "LIVE_GITHUB_TOKEN", "NOT_A_KEY", "DATABASE_URL"]) {
      await assert.rejects(
        pushSecrets({ values: new Map([[k, "x"]]), apiKey: "k", fetchImpl: fn, log: () => {} }),
        /refusing keys that are not owner-pasted/,
        k,
      );
    }
    assert.equal(calls.length, 0);
  });

  it("dry run calls nothing and needs no key", async () => {
    const { fn, calls } = fakeFetch();
    const logs: string[] = [];
    await pushSecrets({ values: new Map([["E2B_API_KEY", "e2b_x"]]), apiKey: undefined, dryRun: true, fetchImpl: fn, log: (l: string) => logs.push(l) });
    assert.deepEqual(logs, ["would set E2B_API_KEY in shapesos-shared"]);
    assert.equal(calls.length, 0);
  });

  it("stops when the env group does not exist yet", async () => {
    const fn = (async () => new Response("[]", { status: 200 })) as unknown as typeof fetch;
    await assert.rejects(
      pushSecrets({ values: new Map([["E2B_API_KEY", "x"]]), apiKey: "k", fetchImpl: fn, log: () => {} }),
      /env group shapesos-shared not found/,
    );
  });
});
