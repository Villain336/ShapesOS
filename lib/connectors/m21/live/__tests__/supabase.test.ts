// Phase 11 (devtools): Supabase adapter + the read-only SQL guard. The guard
// must refuse DML, DDL, multi-statement input and side-effect functions —
// including when they hide in comments, quoted identifiers or literals — and
// the client must send only guarded, read-only-wrapped SQL with
// read_only:true. fetch is scripted (no network). The wrapper's READ ONLY
// transaction behaviour is also checked against a real local PostgreSQL when
// one is reachable (skipped otherwise).
// Run: npx tsx --test lib/connectors/m21/live/__tests__/supabase.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import { SupabaseAdapter } from "../../native/supabase";
import { SqlGuardError, assertReadOnlySql, readOnlyWrapped, sqlSkeleton } from "../sql-guard";
import { connectorGroup } from "@/lib/agents/grants";
import { jsonResponse, scriptedFetch, liveDeps, ctxWith } from "./fixtures";

const REF = "abcdefghijklmnopqrst";
const pat = (token = "sbp_test_token_123456") => ({ kind: "api_key" as const, payload: { apiKey: token } });

function adapter(script: Parameters<typeof scriptedFetch>[0]) {
  const f = scriptedFetch(script);
  const { deps, sleeps } = liveDeps(f.fetchImpl);
  return { a: new SupabaseAdapter(deps), f, sleeps };
}

describe("SQL guard: allowed", () => {
  for (const q of [
    "select * from orders",
    "SELECT count(*) FROM public.orders WHERE status = 'paid';",
    "with recent as (select * from orders where created_at > now() - interval '7 days') select count(*) from recent",
    "TABLE public.products",
    "values (1), (2)",
    "select 'insert into x; delete from y' as label",
    "select $$drop table x; update y$$ as txt, $tag$ ; $tag$",
    "select updated_at, is_deleted, created_by from audit -- delete me later\n",
    "select e'it\\'s; fine' as s",
    "select * from t where note = 'a''; drop table t; --'",
  ]) {
    it(JSON.stringify(q.slice(0, 60)), () => {
      assert.doesNotThrow(() => assertReadOnlySql(q));
    });
  }
  it("trailing semicolons and whitespace are removed", () => {
    assert.equal(assertReadOnlySql("  select 1 ;  ;\n"), "select 1");
  });
});

describe("SQL guard: refused (DML / DDL / multi-statement / side effects)", () => {
  const refused: Array<[string, RegExp]> = [
    ["insert into t values (1)", /must start with SELECT/],
    ["update t set a = 1", /must start with SELECT/],
    ["delete from t", /must start with SELECT/],
    ["drop table t", /must start with SELECT/],
    ["create table t (a int)", /must start with SELECT/],
    ["alter table t add column b int", /must start with SELECT/],
    ["truncate t", /must start with SELECT/],
    ["grant all on t to anon", /must start with SELECT/],
    ["copy t to '/tmp/x'", /must start with SELECT/],
    ["do $$ begin perform 1; end $$", /must start with SELECT/],
    ["explain analyze select 1", /must start with SELECT/],
    ["select 1; select 2", /one statement/],
    ["select 1; delete from t", /one statement/],
    ["select 1 /* ; */ ; drop table t", /one statement/],
    ["with x as (delete from t returning *) select * from x", /DELETE/],
    ["with x as (insert into t values (1) returning *) select * from x", /INSERT/],
    ["with x as (update t set a = 1 returning *) select * from x", /UPDATE/],
    ["select * into new_table from t", /INTO/],
    ["select * from t for update", /UPDATE|row locks/],
    ["select * from t for share", /row locks/],
    ["select set_config('transaction_read_only', 'off', true)", /set_config/],
    ["select pg_sleep(100)", /pg_sleep/],
    ["select nextval('s')", /nextval/],
    ["select query_to_xml('delete from t', true, true, '')", /query_to_xml/],
    ["select * from dblink('host=x', 'select 1') as t(a int)", /dblink/],
    ["select net.http_get('https://evil.example')", /HTTP/],
    ["select lo_import('/etc/passwd')", /large-object/],
    ["select pg_read_file('/etc/passwd')", /pg_read_file/],
    ['select "set_config"(\'a\', \'b\', false)', /set_config/],
    ['select * from "x"; drop table "y"', /one statement/],
    ["select 1) as q, (select 2", /unbalanced/],
    ["select 'unterminated", /unterminated string/],
    ["select 1 /* unterminated", /unterminated comment/],
    ["select $$ unterminated", /unterminated dollar/],
    ["", /query is required/],
  ];
  for (const [q, re] of refused) {
    it(JSON.stringify(q.slice(0, 60)), () => {
      assert.throws(() => assertReadOnlySql(q), (err: unknown) => err instanceof SqlGuardError && re.test(err.message));
    });
  }
  it("keywords inside quoted identifiers are still seen", () => {
    assert.match(sqlSkeleton('select "a;b" from t'), /a_b/);
    assert.doesNotMatch(sqlSkeleton("select 'a;b'"), /;/);
  });
});

describe("read-only wrapper", () => {
  it("SET TRANSACTION READ ONLY + statement timeout + row cap, SELECT last", () => {
    const w = readOnlyWrapped("select * from t", { maxRows: 50, timeoutMs: 15_000 });
    assert.equal(w, "SET TRANSACTION READ ONLY;\nSET LOCAL statement_timeout = 15000;\nSELECT * FROM (\nselect * from t\n) AS shapes_readonly_query LIMIT 50;");
  });

  // Live check against the local PostgreSQL the repo's DB tests use (skipped when absent).
  const PG = "postgresql://marketr:marketr@localhost:5432/postgres";
  const psql = (sql: string) => spawnSync("psql", [PG, "-X", "-q", "-A", "-t", "-c", sql], { encoding: "utf8", timeout: 10_000 });
  const reachable = (() => {
    try {
      return psql("select 1").stdout?.trim() === "1";
    } catch {
      return false;
    }
  })();
  it("in PostgreSQL the wrapper runs a guarded SELECT and refuses a write in the same transaction", { skip: !reachable && "no local PostgreSQL" }, () => {
    const ok = psql(readOnlyWrapped("select 41 + 1 as answer", { maxRows: 5, timeoutMs: 5000 }));
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /42/);
    // Even if a write got past the guard, the transaction refuses it.
    const write = psql("SET TRANSACTION READ ONLY;\nSET LOCAL statement_timeout = 5000;\nCREATE TEMP TABLE shapes_guard_probe (a int);");
    assert.match(write.stderr, /read-only transaction/);
  });
});

describe("Supabase Management API", () => {
  it("list_projects: GET /v1/projects with the PAT as bearer", async () => {
    const { a, f } = adapter([jsonResponse(200, [{ id: REF, ref: REF, name: "Prod", region: "eu-west-1", status: "ACTIVE_HEALTHY", organization_id: "org1", created_at: "2026-01-01" }])]);
    const r = await a.invoke("list_projects", {}, pat("sbp_abc_123456"), ctxWith());
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(r.data, [{ ref: REF, name: "Prod", region: "eu-west-1", status: "ACTIVE_HEALTHY", organizationId: "org1", createdAt: "2026-01-01" }]);
    assert.equal(f.calls[0].url.href, "https://api.supabase.com/v1/projects");
    assert.equal(f.calls[0].headers.authorization, "Bearer sbp_abc_123456");
  });

  it("list_buckets: uses the data source's projectRef when none is given", async () => {
    const { a, f } = adapter([jsonResponse(200, [{ id: "avatars", name: "avatars", public: false, created_at: "2026-02-01" }])]);
    const r = await a.invoke("list_buckets", {}, pat(), ctxWith({ projectConfig: { projectRef: REF } }));
    assert.deepEqual(r.data, [{ id: "avatars", name: "avatars", public: false, createdAt: "2026-02-01" }]);
    assert.equal(f.calls[0].url.pathname, `/v1/projects/${REF}/storage/buckets`);
  });

  it("run_sql: POSTs the guarded, wrapped statement with read_only:true and caps rows", async () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({ id: i }));
    const { a, f } = adapter([jsonResponse(201, rows)]);
    const r = await a.invoke("run_sql", { projectRef: REF, query: "select id from orders;", maxRows: 3 }, pat(), ctxWith());
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(r.data, { rows, rowCount: 3, capped: true, truncated: false });
    const c = f.calls[0];
    assert.equal(c.method, "POST");
    assert.equal(c.url.pathname, `/v1/projects/${REF}/database/query`);
    assert.deepEqual(c.body, { query: readOnlyWrapped("select id from orders", { maxRows: 3, timeoutMs: 15_000 }), read_only: true });
  });

  it("run_sql: DML, DDL and multi-statement queries are refused before any request", async () => {
    const { a, f } = adapter([]);
    for (const query of ["delete from orders", "drop table orders", "select 1; delete from orders", "with x as (update t set a=1 returning 1) select 1"]) {
      const r = await a.invoke("run_sql", { projectRef: REF, query }, pat(), ctxWith());
      assert.equal(r.ok, false, query);
      assert.equal(r.errorCode, "bad_request", query);
      assert.match(r.error ?? "", /^Refused: /);
    }
    assert.equal(f.calls.length, 0);
  });

  it("run_sql: a bad project ref is bad_request; provider errors are closed codes with the token scrubbed", async () => {
    const { a, f } = adapter([jsonResponse(400, { message: "ERROR: relation \"nope\" does not exist (token sbp_secret_999999)" })]);
    const bad = await a.invoke("run_sql", { projectRef: "x", query: "select 1" }, pat(), ctxWith());
    assert.equal(bad.errorCode, "bad_request");
    const r = await a.invoke("run_sql", { projectRef: REF, query: "select * from nope" }, pat("sbp_secret_999999"), ctxWith());
    assert.equal(r.errorCode, "bad_request");
    assert.doesNotMatch(r.error ?? "", /sbp_secret_999999/);
    assert.equal(f.calls.length, 1);
  });

  it("reads retry on 429 / 5xx (the query is read-only, so a retry is safe)", async () => {
    const { a, f, sleeps } = adapter([jsonResponse(503, { message: "busy" }), jsonResponse(200, [])]);
    const r = await a.invoke("list_projects", {}, pat(), ctxWith());
    assert.equal(r.ok, true, r.error);
    assert.equal(f.calls.length, 2);
    assert.equal(sleeps.length, 1);
  });

  it("v1 is read-only: no tool is mutating; group is data", () => {
    const a = new SupabaseAdapter();
    for (const t of a.listTools()) assert.equal(t.mutating, false, t.name);
    assert.equal(connectorGroup("supabase"), "data");
  });

  it("mock mode is labelled and still applies the guard", async () => {
    const a = new SupabaseAdapter();
    const ok = await a.invoke("run_sql", { query: "select 1" }, null, ctxWith());
    assert.equal(ok.mock, true);
    const refused = await a.invoke("run_sql", { query: "drop table t" }, null, ctxWith());
    assert.equal(refused.ok, false);
    assert.equal(refused.errorCode, "bad_request");
  });
});
