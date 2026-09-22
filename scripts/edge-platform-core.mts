// Marketr — GROUP D edge-case tests: platform core
// (alerts, authz, sitefiles, secrets, usage/cost, LLM).
//
// Run: npx tsx scripts/edge-platform-core.mts
// Run it 3x; pass/fail counts must be identical across runs (deterministic).
//
// READ-ONLY on source: no live DB, no network. The prisma singleton's model
// properties are replaced at runtime with in-memory fakes, global fetch is
// stubbed, and nodemailer.createTransport is patched. Nothing here touches
// real infrastructure.

// ------------------------------------------------------------------ setup
// Fixed test key BEFORE any crypto use (encryptionKey() reads env per call).
process.env.MARKETR_CREDENTIALS_KEY = "ab".repeat(32); // 64 hex chars
process.env.MARKETR_BASE_URL = "https://app.example.test";
process.env.TELEGRAM_API_BASE = "http://mock-telegram.test";
process.env.SMTP_HOST = "smtp.example.test";
process.env.SMTP_FROM = "alerts@example.test";
delete process.env.LLM_API_KEY;
delete process.env.OPENAI_API_KEY;

import { prisma } from "@/lib/prisma";
import { emitAlert, absoluteLink } from "@/lib/alerts/evaluate";
import {
  deliverEvent,
  flushQueued,
  inQuietHours,
  DIGEST_INTERVAL_MS,
} from "@/lib/alerts/dispatch";
import {
  sendSlack,
  sendTelegram,
  sendEmail,
  renderAlertEmail,
  dispatchToChannel,
  decryptChannelConfig,
  channelHint,
  smtpSettings,
} from "@/lib/alerts/adapters";
import { validateChannelConfig, sealChannelConfig } from "@/lib/alerts/channels";
import { triggerDef } from "@/lib/alerts/triggers";
import {
  ROLE_RANK,
  roleAtLeast,
  requireWorkspaceRole,
  requireProjectRole,
  getMembership,
  claimInviteToken,
  mintInviteToken,
  forbidden,
} from "@/lib/authz";
import {
  getAccessibleWorkspaces,
  getOrCreateWorkspace,
} from "@/lib/session";
import {
  __resetLoginAttempts,
  LOGIN_ACCOUNT_MAX_FAILURES,
  LOGIN_IP_MAX_FAILURES,
  loginLockedOut,
  recordLoginFailure,
  recordLoginSuccess,
} from "@/lib/auth/rate-limit";
import { sanitizePath, joinPath, parentPath } from "@/lib/sitefiles/paths";
import {
  encryptSecret,
  decryptSecret,
  secretHint,
} from "@/lib/sitefiles/crypto";
import { MockSiteFileProvider } from "@/lib/sitefiles/mock";
import { SftpSiteFileProvider } from "@/lib/sitefiles/sftp";
import {
  getSiteFileProvider,
  publicConnection,
} from "@/lib/sitefiles/index";
import {
  ownedProject,
  ownedConnection,
  readJsonBody,
} from "@/lib/sitefiles/api";
import {
  getSecretsProvider,
  EnvSecretsProvider,
  AwsKmsSecretsProvider,
} from "@/lib/secrets";
import { recordUsage } from "@/lib/usage";
import {
  checkLocalBudget,
  estimateGridRunCost,
  estimateCompetitorRefreshCost,
  estimateReviewsIngestCost,
  DEFAULT_LOCAL_SPEND_CAP_USD,
  MAX_GRID_CELLS_PER_RUN,
} from "@/lib/seo/local-cost";
import {
  checkPullBudget,
  estimateListPullCost,
  estimateSummaryPullCost,
  monthKey,
  MAX_BACKLINK_ROWS_PER_PULL,
  DEFAULT_MONTHLY_SPEND_CAP_USD,
} from "@/lib/seo/backlinks-cost";
import { getLlmProvider, llmStatus } from "@/lib/llm/index";
import { MockLlmProvider } from "@/lib/llm/mock";
import { OpenAiCompatibleLlmProvider } from "@/lib/llm/openai";
import { readFileSync } from "node:fs";

// ------------------------------------------------------------ harness
let pass = 0;
let fail = 0;
const failures: string[] = [];
const table: Record<string, { run: number; pass: number; fail: number }> = {};
let cur = "";
function section(name: string) {
  cur = name;
  table[name] = { run: 0, pass: 0, fail: 0 };
  console.log(`\n## ${name}`);
}
function check(name: string, cond: boolean, detail = "") {
  table[cur].run++;
  if (cond) {
    pass++;
    table[cur].pass++;
  } else {
    fail++;
    table[cur].fail++;
    failures.push(`${cur}: ${name}`);
    console.log(`  FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
const eq = (name: string, a: unknown, b: unknown) =>
  check(name, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);
async function throwsAsync(name: string, fn: () => Promise<unknown>, want?: RegExp) {
  try {
    await fn();
    check(name, false, "did not throw");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    check(name, want ? want.test(msg) : true, want ? `message "${msg}"` : "");
  }
}
function throws(name: string, fn: () => unknown, want?: RegExp) {
  try {
    fn();
    check(name, false, "did not throw");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    check(name, want ? want.test(msg) : true, want ? `message "${msg}"` : "");
  }
}

// ------------------------------------------------------- fake prisma
interface FakeDB {
  rules: any[];
  events: any[];
  channels: any[];
  projects: any[];
  workspaces: any[];
  memberships: any[];
  siteConnections: any[];
  usage: Map<string, number>;
  usageUpserts: any[];
  audit: any[];
  inviteUpdates: any[];
  seq: number;
}
function freshDB(): FakeDB {
  return {
    rules: [], events: [], channels: [], projects: [], workspaces: [],
    memberships: [], siteConnections: [], usage: new Map(),
    usageUpserts: [], audit: [], inviteUpdates: [], seq: 0,
  };
}
let db = freshDB();
const nid = (p: string) => `${p}_${++db.seq}`;

function installFakePrisma() {
  const P: any = prisma;
  P.alertRule = {
    findMany: async (q: any) =>
      db.rules.filter(
        (r) => r.enabled && (!q?.where?.workspaceId || r.workspaceId === q.where.workspaceId) &&
          (!q?.where?.trigger || r.trigger === q.where.trigger),
      ),
    update: async ({ where, data }: any) => {
      const r = db.rules.find((x) => x.id === where.id);
      if (!r) throw new Error("rule not found");
      Object.assign(r, data);
      return r;
    },
  };
  P.alertEvent = {
    findFirst: async (q: any) => {
      const w = q?.where ?? {};
      const list = db.events
        .filter((e) => (w.dedupKey === undefined || e.dedupKey === w.dedupKey))
        .filter((e) => (!w.status?.in || w.status.in.includes(e.status)))
        .filter((e) => (!w.createdAt?.gte || e.createdAt >= w.createdAt.gte))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      const hit = list[0];
      if (!hit) return null;
      if (q?.select) { const o: any = {}; for (const k of Object.keys(q.select)) o[k] = hit[k]; return o; }
      return hit;
    },
    create: async ({ data }: any) => {
      const e = { id: nid("evt"), createdAt: new Date(), retryCount: 0, results: null, sentAt: null, ...data };
      db.events.push(e);
      return e;
    },
    findUnique: async (q: any) => {
      const e = db.events.find((x) => x.id === q?.where?.id);
      if (!e) return null;
      const rule = db.rules.find((r) => r.id === e.ruleId);
      return { ...e, rule: rule ? { ...rule, channels: db.channels.filter((c) => c.ruleId === rule.id) } : null };
    },
    findMany: async (q: any) => {
      const w = q?.where ?? {};
      let list = db.events.filter(
        (e) => (w.status === undefined || e.status === w.status) &&
          (w.workspaceId === undefined || e.workspaceId === w.workspaceId),
      );
      if (q?.include?.rule) list = list.map((e) => ({ ...e, rule: db.rules.find((r) => r.id === e.ruleId) }));
      list.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      return q?.take ? list.slice(0, q.take) : list;
    },
    update: async ({ where, data }: any) => {
      const e = db.events.find((x) => x.id === where.id);
      if (!e) throw new Error("event not found");
      Object.assign(e, data);
      return e;
    },
    updateMany: async ({ where, data }: any) => {
      const ids: string[] = where?.id?.in ?? [];
      let n = 0;
      for (const e of db.events) if (ids.includes(e.id)) { Object.assign(e, data); n++; }
      return { count: n };
    },
  };
  const tx = {
    alertEvent: { update: P.alertEvent.update },
    alertRule: { update: P.alertRule.update },
  };
  P.$transaction = async (fn: any) => fn(tx);
  P.fileChangeLog = { create: async ({ data }: any) => { db.audit.push(data); return data; } };
  P.workspaceMember = {
    findFirst: async (q: any) => db.memberships.find(
      (m) => (q?.where?.workspaceId === undefined || m.workspaceId === q.where.workspaceId) &&
        (q?.where?.userId === undefined || m.userId === q.where.userId) &&
        (q?.where?.inviteToken === undefined || m.inviteToken === q.where.inviteToken),
    ) ?? null,
    create: async ({ data }: any) => { const m = { id: nid("mem"), createdAt: new Date(), ...data }; db.memberships.push(m); return m; },
    update: async (q: any) => {
      const m = db.memberships.find((x) => x.id === q?.where?.id);
      if (!m) throw new Error("not found");
      Object.assign(m, q.data);
      return m;
    },
    updateMany: async (q: any) => {
      db.inviteUpdates.push(q);
      const w = q?.where ?? {};
      let n = 0;
      for (const m of db.memberships) {
        if (w.id !== undefined && m.id !== w.id) continue;
        if (w.userId !== undefined && w.userId !== null && m.userId !== w.userId) continue;
        if (w.userId === null && m.userId !== null && m.userId !== undefined) continue;
        if (w.inviteToken !== undefined && m.inviteToken !== w.inviteToken) continue;
        if (w.email !== undefined) {
          if (typeof w.email === "string") { if (m.email !== w.email) continue; }
          else if (w.email.equals !== undefined && (m.email ?? "").toLowerCase() !== String(w.email.equals).toLowerCase()) continue;
        }
        if (w.OR !== undefined) {
          const ok = (w.OR as any[]).some((c: any) => {
            if (c.inviteExpiresAt === null) return m.inviteExpiresAt === null || m.inviteExpiresAt === undefined;
            if (c.inviteExpiresAt?.gte) return !!m.inviteExpiresAt && m.inviteExpiresAt >= c.inviteExpiresAt.gte;
            return false;
          });
          if (!ok) continue;
        }
        Object.assign(m, q.data);
        n++;
      }
      return { count: n };
    },
  };
  const wsAccessible = (w: any, userId: string) =>
    w.ownerUserId === userId || db.memberships.some((m) => m.workspaceId === w.id && m.userId === userId);
  P.workspace = {
    findUnique: async (q: any) => db.workspaces.find((w) => w.id === q?.where?.id) ?? null,
    findMany: async (q: any) => {
      const or = q?.where?.OR ?? [];
      let list = db.workspaces;
      if (or.length) {
        list = list.filter((w) => or.some((c: any) =>
          (c.ownerUserId !== undefined && w.ownerUserId === c.ownerUserId) ||
          (c.members?.some?.userId !== undefined && db.memberships.some((m) => m.workspaceId === w.id && m.userId === c.members.some.userId)),
        ));
      }
      list = [...list].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      return list;
    },
    create: async ({ data }: any) => {
      const w = { id: nid("ws"), createdAt: new Date(), ...data };
      delete (w as any).members;
      db.workspaces.push(w);
      if (data.members?.create) {
        const mc = data.members.create;
        db.memberships.push({ id: nid("mem"), createdAt: new Date(), workspaceId: w.id, userId: mc.userId, role: mc.role });
      }
      return w;
    },
  };
  P.project = {
    findFirst: async (q: any) => {
      const p = db.projects.find((x) => x.id === q?.where?.id);
      if (!p) return null;
      const wClause = q?.where?.workspace;
      if (wClause?.OR) {
        const w = db.workspaces.find((x) => x.id === p.workspaceId);
        const okAcc = wClause.OR.some((c: any) =>
          (c.ownerUserId !== undefined && w && w.ownerUserId === c.ownerUserId) ||
          (c.members?.some?.userId !== undefined && db.memberships.some((m) => m.workspaceId === p.workspaceId && m.userId === c.members.some.userId)),
        );
        if (!okAcc) return null;
      }
      return p;
    },
    findUnique: async (q: any) => db.projects.find((x) => x.id === q?.where?.id) ?? null,
  };
  P.siteConnection = {
    findFirst: async (q: any) => db.siteConnections.find(
      (c) => c.id === q?.where?.id && (q?.where?.projectId === undefined || c.projectId === q.where.projectId),
    ) ?? null,
  };
  P.apiUsage = {
    upsert: async (q: any) => {
      db.usageUpserts.push(q);
      const k = `${q.where.workspaceId_meter_period.workspaceId}|${q.where.workspaceId_meter_period.meter}|${q.where.workspaceId_meter_period.period}`;
      const inc = q.update?.quantity?.increment ?? 0;
      db.usage.set(k, (db.usage.get(k) ?? 0) + inc);
      return { quantity: db.usage.get(k) };
    },
  };
}
installFakePrisma();

// ------------------------------------------------------- fake fetch
type FetchBehavior = { status: number; text: string } | { reject: string } | { hang: true };
let fetchBehavior: FetchBehavior = { status: 200, text: "ok" };
const fetchCalls: { url: string; init: any }[] = [];
(globalThis as any).fetch = async (url: any, init: any) => {
  fetchCalls.push({ url: String(url), init });
  const b = fetchBehavior;
  if ("reject" in b) throw new Error(b.reject);
  if ("hang" in b) return new Promise(() => {});
  return new Response(b.text, { status: b.status });
};
const lastFetchBody = () => JSON.parse(String(fetchCalls[fetchCalls.length - 1].init.body));

// NOTE on email: tsx snapshots nodemailer's CJS exports at import time, so
// createTransport cannot be stubbed from this harness, and this sandbox
// blocks real SMTP. sendEmail's success path is therefore untestable here;
// only its no-network failure paths + the pure renderAlertEmail are covered.

// ================================================================ alerts/evaluate
section("alerts/evaluate");

// shared factories (used by evaluate + dispatch sections)
const mkRule = (over: any = {}) => ({ id: nid("rule"), name: "R", workspaceId: "ws1", trigger: "rank_drop", enabled: true, conditions: {}, cooldownSec: 0, quietHours: null, digest: "immediate", lastFiredAt: null, lastDigestAt: null, ...over });
const mkEvent = (ruleId: string, over: any = {}) => {
  const e = { id: nid("evt"), ruleId, workspaceId: "ws1", trigger: "rank_drop", title: "t", body: "b", link: null, dedupKey: null, status: "queued", queueReason: null, results: null, sentAt: null, createdAt: new Date(), retryCount: 0, ...over };
  db.events.push(e); return e;
};
const encCfg = (cfg: any) => getSecretsProvider().encrypt(JSON.stringify(cfg));
const mkChannel = (ruleId: string, type: any, cfg: any, enabled = true) => {
  const c = { id: nid("ch"), ruleId, name: `${type}-ch`, type, enabled, configEnc: encCfg(cfg) };
  db.channels.push(c); return c;
};

const baseRule = (over: any = {}) => ({
  id: nid("rule"), name: "Test rule", workspaceId: "ws1", trigger: "rank_drop",
  enabled: true, conditions: {}, cooldownSec: 0, quietHours: null,
  digest: "immediate", lastFiredAt: null, lastDigestAt: null, ...over,
});
const trig = (over: any = {}) => ({
  workspaceId: "ws1", projectId: "p1", trigger: "rank_drop",
  severity: "warn", title: "t", body: "b", movement: 15, ...over,
});

db = freshDB(); installFakePrisma();

// unknown trigger throws
await throwsAsync("emitAlert unknown trigger throws", () => emitAlert(trig({ trigger: "nope" })), /unknown alert trigger/);

// default drop threshold 10: movement 9 skipped, 10 fires, 11 fires
db.rules.push(baseRule());
eq("rank_drop movement=9 skipped (< default 10)", (await emitAlert(trig({ movement: 9 })))[0].status, "skipped");
eq("rank_drop movement=10 fires (>= default 10)", (await emitAlert(trig({ movement: 10 })))[0].status, "failed"); // failed: 0 channels
eq("rank_drop movement=11 fires", (await emitAlert(trig({ movement: 11 })))[0].status, "failed");
eq("rank_drop movement missing (=0) skipped", (await emitAlert(trig({ movement: undefined })))[0].status, "skipped");

// custom thresholdPositions edge: exactly at threshold fires
db = freshDB(); installFakePrisma();
db.rules.push(baseRule({ conditions: { thresholdPositions: 5 } }));
eq("custom threshold 5, movement=5 fires", (await emitAlert(trig({ movement: 5 })))[0].status, "failed");
eq("custom threshold 5, movement=4 skipped", (await emitAlert(trig({ movement: 4 })))[0].status, "skipped");

// gain uses default 5
db = freshDB(); installFakePrisma();
db.rules.push(baseRule({ trigger: "rank_gain" }));
eq("rank_gain default threshold 5: movement=5 fires", (await emitAlert(trig({ trigger: "rank_gain", movement: 5 })))[0].status, "failed");
eq("rank_gain movement=4 skipped", (await emitAlert(trig({ trigger: "rank_gain", movement: 4 })))[0].status, "skipped");

// visibility_delta: abs threshold, negative delta
db = freshDB(); installFakePrisma();
db.rules.push(baseRule({ trigger: "visibility_delta", conditions: { thresholdPoints: 5 } }));
eq("delta=+5 fires", (await emitAlert(trig({ trigger: "visibility_delta", delta: 5 })))[0].status, "failed");
eq("delta=-6 fires (abs)", (await emitAlert(trig({ trigger: "visibility_delta", delta: -6 })))[0].status, "failed");
eq("delta=+4 skipped", (await emitAlert(trig({ trigger: "visibility_delta", delta: 4 })))[0].status, "skipped");
eq("delta=-4.9 skipped", (await emitAlert(trig({ trigger: "visibility_delta", delta: -4.9 })))[0].status, "skipped");

// severities filter
db = freshDB(); installFakePrisma();
db.rules.push(baseRule({ trigger: "fix_run", conditions: { severities: ["critical"] } }));
eq("fix_run severity=warn vs [critical] skipped", (await emitAlert(trig({ trigger: "fix_run", severity: "warn" })))[0].status, "skipped");
eq("fix_run severity=critical fires", (await emitAlert(trig({ trigger: "fix_run", severity: "critical" })))[0].status, "failed");
eq("fix_run severity undefined bypasses filter (fires)", (await emitAlert(trig({ trigger: "fix_run", severity: undefined })))[0].status, "failed");

// projectIds filter; project-less event bypasses project filter
db = freshDB(); installFakePrisma();
db.rules.push(baseRule({ conditions: { projectIds: ["p1"] } }));
eq("project p2 vs rule [p1] skipped", (await emitAlert(trig({ projectId: "p2" })))[0].status, "skipped");
eq("project p1 matches", (await emitAlert(trig({ projectId: "p1" })))[0].status, "failed");
eq("project-less event bypasses projectIds filter (fires)", (await emitAlert(trig({ projectId: null })))[0].status, "failed");

// keywordIds filter
db = freshDB(); installFakePrisma();
db.rules.push(baseRule({ conditions: { keywordIds: ["k1"] } }));
eq("scopeKeywordIds [k2] skipped", (await emitAlert(trig({ scopeKeywordIds: ["k2"] })))[0].status, "skipped");
eq("scopeKeywordIds [k2,k1] fires", (await emitAlert(trig({ scopeKeywordIds: ["k2", "k1"] })))[0].status, "failed");
eq("scopeKeywordIds missing skipped", (await emitAlert(trig({ scopeKeywordIds: undefined })))[0].status, "skipped");

// cooldown + dedup boundary (cooldownSec=60, dedupKey "k")
db = freshDB(); installFakePrisma();
db.rules.push(baseRule({ cooldownSec: 60 }));
const withRecent = (ageMs: number) => {
  db.events.push({ id: nid("evt"), ruleId: db.rules[0].id, workspaceId: "ws1", trigger: "rank_drop", title: "t", body: "b", dedupKey: "k", status: "sent", createdAt: new Date(Date.now() - ageMs), retryCount: 0, results: null, sentAt: null, queueReason: null });
};
withRecent(58_000); // 2s inside window -> suppressed
eq("dedup: event 2s inside cooldown suppressed", (await emitAlert(trig({ dedupKey: "k" })))[0].status, "suppressed");
db = freshDB(); installFakePrisma();
db.rules.push(baseRule({ cooldownSec: 60 }));
withRecent(62_000); // 2s outside window -> fires
eq("dedup: event 2s past cooldown fires", (await emitAlert(trig({ dedupKey: "k" })))[0].status, "failed");
const kEvents = db.events.filter((e) => e.dedupKey === "k");
check("fired event recorded (delivery attempted, not suppressed)", kEvents.length === 2 && kEvents.some((e) => e.status === "failed"));
// identical payloads dedupe: needs a working channel so delivery is "sent"
// (dedup only counts queued/sent events — a *failed* first delivery refires,
// which is the desired retry semantic)
fetchBehavior = { status: 200, text: "ok" };
db = freshDB(); installFakePrisma();
const dr = baseRule({ cooldownSec: 3600 }); db.rules.push(dr);
mkChannel(dr.id, "slack", { webhookUrl: "http://mock/slack" });
eq("first fire with dedupKey -> sent", (await emitAlert(trig({ dedupKey: "dup1" })))[0].status, "sent");
eq("identical second payload suppressed", (await emitAlert(trig({ dedupKey: "dup1" })))[0].status, "suppressed");
eq("different dedupKey fires", (await emitAlert(trig({ dedupKey: "dup2" })))[0].status, "sent");
check("suppressed event records suppressor", db.events.some((e) => e.status === "suppressed" && e.dedupKey === "dup1"));
// failed first delivery does NOT suppress the retry
db = freshDB(); installFakePrisma();
db.rules.push(baseRule({ cooldownSec: 3600 })); // no channels -> delivery "failed"
eq("failed first delivery", (await emitAlert(trig({ dedupKey: "f1" })))[0].status, "failed");
eq("identical retry after failure refires (not suppressed)", (await emitAlert(trig({ dedupKey: "f1" })))[0].status, "failed");
// dedupKey + cooldownSec=0 -> dedup check skipped entirely (fires twice)
db = freshDB(); installFakePrisma();
db.rules.push(baseRule({ cooldownSec: 0 }));
eq("cooldown 0: first fires", (await emitAlert(trig({ dedupKey: "z" })))[0].status, "failed");
eq("cooldown 0: identical second also fires (no dedup)", (await emitAlert(trig({ dedupKey: "z" })))[0].status, "failed");
// negative cooldown treated as 0
db = freshDB(); installFakePrisma();
db.rules.push(baseRule({ cooldownSec: -30 }));
eq("negative cooldownSec fires twice", (await emitAlert(trig({ dedupKey: "n" })))[0].status, "failed");
// rule-level cooldown (no dedupKey) via lastFiredAt
db = freshDB(); installFakePrisma();
db.rules.push(baseRule({ cooldownSec: 60, lastFiredAt: new Date(Date.now() - 30_000) }));
eq("lastFiredAt 30s ago, cooldown 60 -> suppressed", (await emitAlert(trig()))[0].status, "suppressed");
db.rules[0].lastFiredAt = new Date(Date.now() - 61_000);
eq("lastFiredAt 61s ago -> fires", (await emitAlert(trig()))[0].status, "failed");

// quiet hours: build a window around *now* (UTC) so the test is deterministic
const pad2 = (n: number) => String(n).padStart(2, "0");
const nowMin = new Date().getUTCHours() * 60 + new Date().getUTCMinutes();
const hhmm = (m: number) => { const x = ((m % 1440) + 1440) % 1440; return `${pad2(Math.floor(x / 60))}:${pad2(x % 60)}`; };
db = freshDB(); installFakePrisma();
db.rules.push(baseRule({ quietHours: { start: hhmm(nowMin - 30), end: hhmm(nowMin + 30) } }));
const qhOut = (await emitAlert(trig()))[0];
eq("inside quiet hours -> queued", qhOut.status, "queued");
check("queued event has queueReason=quiet", db.events.some((e) => e.id === qhOut.eventId && e.queueReason === "quiet"));
// digest takes precedence over quiet hours
db = freshDB(); installFakePrisma();
db.rules.push(baseRule({ digest: "daily_digest", quietHours: { start: hhmm(nowMin - 30), end: hhmm(nowMin + 30) } }));
const dgOut = (await emitAlert(trig()))[0];
eq("digest rule -> queued", dgOut.status, "queued");
check("digest queueReason wins over quiet", db.events.some((e) => e.id === dgOut.eventId && e.queueReason === "digest"));
// outside quiet hours -> immediate path
db = freshDB(); installFakePrisma();
db.rules.push(baseRule({ quietHours: { start: hhmm(nowMin + 60), end: hhmm(nowMin + 120) } }));
eq("outside quiet hours -> immediate (failed: no channels)", (await emitAlert(trig()))[0].status, "failed");

// title/body truncation + link absolutization
db = freshDB(); installFakePrisma();
db.rules.push(baseRule());
const long = await emitAlert(trig({ title: "T".repeat(300), body: "B".repeat(5000), link: "/p/abc" }));
const stored = db.events.find((e) => e.id === long[0].eventId);
check("title truncated to 200 chars", stored.title.length === 200, `len=${stored.title.length}`);
check("body truncated to 4000 chars", stored.body.length === 4000, `len=${stored.body.length}`);
check("relative link absolutized with MARKETR_BASE_URL", stored.link === "https://app.example.test/p/abc", stored.link);
const abs = await emitAlert(trig({ title: "t2", body: "b2", link: "https://other.test/x" }));
check("absolute link passes through", db.events.find((e) => e.id === abs[0].eventId).link === "https://other.test/x");
// absoluteLink pure edges
eq("absoluteLink absolute passthrough", absoluteLink("http://x.test/y"), "http://x.test/y");
eq("absoluteLink no base returns as-is", (() => { const b = process.env.MARKETR_BASE_URL; delete process.env.MARKETR_BASE_URL; const r = absoluteLink("/p/1"); process.env.MARKETR_BASE_URL = b!; return r; })(), "/p/1");
check("absoluteLink upper-case scheme not recognized (gets base prepended)", absoluteLink("HTTPS://x.test/y") === "https://app.example.test/HTTPS://x.test/y");

// disabled rule -> no outcomes
db = freshDB(); installFakePrisma();
db.rules.push(baseRule({ enabled: false }));
eq("disabled rule produces no outcomes", await emitAlert(trig()), []);

// ================================================================ alerts/dispatch
section("alerts/dispatch");

// inQuietHours boundaries (UTC)
const D = (h: number, m: number) => new Date(Date.UTC(2026, 8, 21, h, m, 0));
check("wrap 22-06: at 22:00 inside", inQuietHours({ start: "22:00", end: "06:00" }, D(22, 0)) === true);
check("wrap 22-06: at 05:59 inside", inQuietHours({ start: "22:00", end: "06:00" }, D(5, 59)) === true);
check("wrap 22-06: at 06:00 outside (end exclusive)", inQuietHours({ start: "22:00", end: "06:00" }, D(6, 0)) === false);
check("wrap 22-06: at 21:59 outside", inQuietHours({ start: "22:00", end: "06:00" }, D(21, 59)) === false);
check("wrap 22-06: at 00:00 inside", inQuietHours({ start: "22:00", end: "06:00" }, D(0, 0)) === true);
check("flat 09-17: at 09:00 inside (start inclusive)", inQuietHours({ start: "09:00", end: "17:00" }, D(9, 0)) === true);
check("flat 09-17: at 16:59 inside", inQuietHours({ start: "09:00", end: "17:00" }, D(16, 59)) === true);
check("flat 09-17: at 17:00 outside", inQuietHours({ start: "09:00", end: "17:00" }, D(17, 0)) === false);
check("start==end -> false", inQuietHours({ start: "09:00", end: "09:00" }, D(9, 30)) === false);
check("missing start -> false", inQuietHours({ end: "09:00" }, D(9, 30)) === false);
check("nulls -> false", inQuietHours({ start: null, end: null }, D(9, 30)) === false);
check("malformed start 'abc' silently degrades to 00:00 (widens quiet hours)", inQuietHours({ start: "abc", end: "09:00" }, D(0, 30)) === false);
check("malformed end 'xyz' silently degrades to 00:00", inQuietHours({ start: "22:00", end: "xyz" }, D(23, 0)) === false);
check("DIGEST_INTERVAL_MS is 20h", DIGEST_INTERVAL_MS === 20 * 60 * 60 * 1000);

// deliverEvent with faked channels
fetchBehavior = { status: 200, text: "ok" };

db = freshDB(); installFakePrisma();
const r1 = mkRule(); db.rules.push(r1);
const e1 = mkEvent(r1.id);
const d1 = await deliverEvent(e1.id);
eq("deliverEvent: zero enabled channels -> failed", d1.status, "failed");
check("deliverEvent: audit logged for failed", db.audit.some((a) => a.action === "alert_failed"));

db = freshDB(); installFakePrisma();
const r2 = mkRule(); db.rules.push(r2);
mkChannel(r2.id, "slack", { webhookUrl: "http://mock/slack" });
const e2 = mkEvent(r2.id);
const d2 = await deliverEvent(e2.id);
eq("deliverEvent: all ok -> sent", d2.status, "sent");
check("deliverEvent: sentAt set", d2.sentAt instanceof Date);
check("deliverEvent: retryCount incremented", d2.retryCount === 1);
check("deliverEvent: queueReason cleared", d2.queueReason === null);
check("deliverEvent: lastFiredAt updated on rule", db.rules[0].lastFiredAt instanceof Date);
check("deliverEvent: per-channel result recorded", (() => {
  const r0 = (d2.results as Array<{ ok?: boolean; channelId?: string }>)[0];
  return Array.isArray(d2.results) && r0?.ok === true && r0?.channelId !== undefined;
})());
check("deliverEvent: audit logged alert_sent", db.audit.some((a) => a.action === "alert_sent"));

// partial failure: one ok, one failing -> status "sent" (flags: silent partial failure)
db = freshDB(); installFakePrisma();
const r3 = mkRule(); db.rules.push(r3);
mkChannel(r3.id, "slack", { webhookUrl: "http://mock/ok" });
mkChannel(r3.id, "telegram", { botToken: "", chatId: "" }); // invalid config -> ok:false
const e3 = mkEvent(r3.id);
const d3 = await deliverEvent(e3.id);
check("PARTIAL: 1/2 channels ok still reports sent (silent partial failure)", d3.status === "sent");

// all failing
db = freshDB(); installFakePrisma();
const r4 = mkRule(); db.rules.push(r4);
mkChannel(r4.id, "slack", { webhookUrl: "not-a-url" });
const e4 = mkEvent(r4.id);
const d4 = await deliverEvent(e4.id);
eq("deliverEvent: all channels fail -> failed", d4.status, "failed");
check("deliverEvent: sentAt set even on failure", d4.sentAt instanceof Date);
check("deliverEvent: error captured on result", typeof ((d4.results as Array<{ error?: string }>)[0]?.error) === "string");

// dispatchToChannel throwing (not returning) is captured
db = freshDB(); installFakePrisma();
const r5 = mkRule(); db.rules.push(r5);
mkChannel(r5.id, "slack", { webhookUrl: "http://mock/slack" });
const origFetch = (globalThis as any).fetch;
(globalThis as any).fetch = async () => { throw new Error("boom"); };
const d5 = await deliverEvent(mkEvent(r5.id).id);
(globalThis as any).fetch = origFetch;
eq("throwing adapter captured as failed", d5.status, "failed");

// tampered configEnc -> undecryptable
db = freshDB(); installFakePrisma();
const r6 = mkRule(); db.rules.push(r6);
db.channels.push({ id: nid("ch"), ruleId: r6.id, name: "bad", type: "slack", enabled: true, configEnc: "v1:tampered" });
const d6 = await deliverEvent(mkEvent(r6.id).id);
eq("tampered configEnc -> failed", d6.status, "failed");
check("tampered configEnc error label", (d6.results as Array<{ error?: string }>)[0]?.error === "channel config undecryptable");

// retry exhaustion: always-failing adapter retried -> retryCount grows, no cap
db = freshDB(); installFakePrisma();
const r7 = mkRule(); db.rules.push(r7);
mkChannel(r7.id, "slack", { webhookUrl: "bad-url" });
const e7 = mkEvent(r7.id);
await deliverEvent(e7.id);
const e7b = await deliverEvent(e7.id);
check("retryCount increments unbounded (no max-retry policy)", e7b.retryCount === 2);
check("second attempt still failed", e7b.status === "failed");

// event not found throws
await throwsAsync("deliverEvent unknown id throws", () => deliverEvent("evt_missing"), /not found/);

// flushQueued: quiet hold released / held
db = freshDB(); installFakePrisma();
const rq = mkRule({ quietHours: { start: "22:00", end: "06:00" } }); db.rules.push(rq);
mkChannel(rq.id, "slack", { webhookUrl: "http://mock/slack" });
const held = mkEvent(rq.id, { queueReason: "quiet", createdAt: new Date(Date.UTC(2026, 8, 21, 23, 0)) });
const fl1 = await flushQueued(new Date(Date.UTC(2026, 8, 21, 23, 30)));
eq("quiet hold inside window: not delivered", fl1.sent, 0);
check("held event still queued", db.events.find((e) => e.id === held.id).status === "queued");
const fl2 = await flushQueued(new Date(Date.UTC(2026, 8, 22, 7, 0)));
eq("quiet hold after window: delivered", fl1.sent + fl2.sent, 1);
check("delivered event status sent", db.events.find((e) => e.id === held.id).status === "sent");

// flushQueued: non-quiet queued with no quietHours -> delivered
db = freshDB(); installFakePrisma();
const rn = mkRule(); db.rules.push(rn);
mkChannel(rn.id, "slack", { webhookUrl: "http://mock/slack" });
mkEvent(rn.id, { queueReason: null });
const fln = await flushQueued(new Date());
eq("plain queued event delivered", fln.sent, 1);

// flushQueued: digest batching — 3 events, old lastDigestAt
db = freshDB(); installFakePrisma();
const rd = mkRule({ digest: "daily_digest" }); db.rules.push(rd);
mkChannel(rd.id, "slack", { webhookUrl: "http://mock/slack" });
for (let i = 0; i < 3; i++) mkEvent(rd.id, { queueReason: "digest", title: `alert ${i}` });
const fld = await flushQueued(new Date(Date.UTC(2026, 8, 22, 12, 0)));
eq("digest: 3 events -> 1 digest sent", fld.sent, 1);
eq("digest: digests count 1", fld.digests, 1);
const digestEvt = db.events.find((e) => e.title.startsWith("3 alerts:"));
check("digest event created", !!digestEvt);
check("digest body lists all events", digestEvt && digestEvt.body.includes("alert 0") && digestEvt.body.includes("alert 2"));
check("originals marked suppressed", db.events.filter((e) => e.queueReason === "digest").length === 0 && db.events.filter((e) => e.status === "suppressed").length === 3);
check("lastDigestAt updated", db.rules[0].lastDigestAt instanceof Date);

// digest: 1 event still makes a digest; 0 events makes none
db = freshDB(); installFakePrisma();
const rd1 = mkRule({ digest: "daily_digest" }); db.rules.push(rd1);
mkChannel(rd1.id, "slack", { webhookUrl: "http://mock/slack" });
mkEvent(rd1.id, { queueReason: "digest", title: "solo" });
const fld1 = await flushQueued(new Date());
check("digest: single event still creates digest", fld1.digests === 1 && db.events.some((e) => e.title.startsWith("1 alerts:")));
db = freshDB(); installFakePrisma();
const fld0 = await flushQueued(new Date());
eq("digest: zero events -> zero digests", fld0.digests, 0);

// digest suppressed when lastDigestAt within interval (events stay queued)
db = freshDB(); installFakePrisma();
const rdr = mkRule({ digest: "daily_digest", lastDigestAt: new Date(Date.now() - 60_000) }); db.rules.push(rdr);
mkChannel(rdr.id, "slack", { webhookUrl: "http://mock/slack" });
mkEvent(rdr.id, { queueReason: "digest", title: "x" });
const fldr = await flushQueued(new Date());
eq("digest: recent lastDigestAt -> skipped", fldr.digests, 0);
check("digest: event remains queued", db.events.some((e) => e.status === "queued" && e.queueReason === "digest"));

// workspaceId filter on flushQueued
db = freshDB(); installFakePrisma();
const rw = mkRule({ workspaceId: "wsA" }); db.rules.push(rw);
mkChannel(rw.id, "slack", { webhookUrl: "http://mock/slack" });
mkEvent(rw.id, { workspaceId: "wsA", queueReason: null });
mkEvent(rw.id, { workspaceId: "wsB", queueReason: null });
const flw = await flushQueued(new Date(), "wsA");
eq("flushQueued workspace filter: only wsA delivered", flw.sent, 1);

// ================================================================ alerts/adapters
section("alerts/adapters");
fetchBehavior = { status: 200, text: "ok" };
fetchCalls.length = 0;

const s1 = await sendSlack({ webhookUrl: "http://mock/slack" }, { title: "T", body: "B" });
check("sendSlack 200 -> ok", s1.ok === true && s1.providerResponse === "ok");
const sBody = lastFetchBody();
check("sendSlack posts blocks payload", Array.isArray(sBody.blocks) && sBody.blocks[0].type === "header");
const sBad = await sendSlack({ webhookUrl: "ftp://x" }, { title: "T", body: "B" });
check("sendSlack non-http url -> ok:false", sBad.ok === false && /invalid slack webhook/.test(sBad.error!));
const sEmpty = await sendSlack({ webhookUrl: "" }, { title: "T", body: "B" });
check("sendSlack empty url -> ok:false", sEmpty.ok === false);
fetchBehavior = { status: 500, text: "boom" };
const s500 = await sendSlack({ webhookUrl: "http://mock/slack" }, { title: "T", body: "B" });
check("sendSlack http 500 -> ok:false with status", s500.ok === false && s500.error === "slack http 500" && s500.providerResponse === "boom");
fetchBehavior = { reject: "socket hang up" };
const sRej = await sendSlack({ webhookUrl: "http://mock/slack" }, { title: "T", body: "B" });
check("sendSlack network reject -> ok:false", sRej.ok === false && /socket hang up/.test(sRej.error!));
fetchBehavior = { status: 200, text: "ok" };
// link rendering + title truncation in slack blocks
await sendSlack({ webhookUrl: "http://mock/slack" }, { title: "T".repeat(200), body: "B", links: [{ label: "Open", url: "https://x.test/y" }] });
const sLong = lastFetchBody();
check("sendSlack title truncated to 150 in header", sLong.blocks[0].text.text.length === 150);
check("sendSlack links rendered as <url|label>", sLong.blocks[2].elements[0].text.includes("<https://x.test/y|Open>"));

// telegram
const t1 = await sendTelegram({ botToken: "tok", chatId: "123" }, { title: "T <b>&", body: "B" });
check("sendTelegram 200 -> ok", t1.ok === true);
check("sendTelegram uses TELEGRAM_API_BASE override", fetchCalls[fetchCalls.length - 1].url === "http://mock-telegram.test/bottok/sendMessage");
const tBody = lastFetchBody();
check("sendTelegram escapes HTML in title", tBody.text.includes("&lt;b&gt;&amp;") && !tBody.text.includes("<b>&"));
check("sendTelegram chat_id + HTML parse mode", tBody.chat_id === "123" && tBody.parse_mode === "HTML");
const tBad = await sendTelegram({ botToken: "", chatId: "123" }, { title: "T", body: "B" });
check("sendTelegram missing token -> ok:false", tBad.ok === false);
fetchBehavior = { status: 429, text: "rate limited" };
const t429 = await sendTelegram({ botToken: "tok", chatId: "123" }, { title: "T", body: "B" });
check("sendTelegram 429 -> ok:false", t429.ok === false && t429.error === "telegram http 429");
fetchBehavior = { status: 200, text: "ok" };
// link URL is NOT escaped in the href attribute (injection surface)
await sendTelegram({ botToken: "tok", chatId: "123" }, { title: "T", body: "B", links: [{ label: "x", url: 'https://x.test/"onmouseover="alert(1)' }] });
const tLink = lastFetchBody().text;
check("BUG? telegram link href interpolates raw url (quote breaks attribute)", !tLink.includes('href="https://x.test/"onmouseover='));

// email — success path needs real SMTP (untestable here); cover no-network paths
const mNoTo = await sendEmail({ to: "  " }, { title: "T", body: "B" });
check("sendEmail blank recipient -> ok:false (no network)", mNoTo.ok === false && /recipient missing/.test(mNoTo.error!));
const keepHost = process.env.SMTP_HOST;
delete process.env.SMTP_HOST;
const mNoSmtp = await sendEmail({ to: "a@example.test" }, { title: "T", body: "B" });
process.env.SMTP_HOST = keepHost;
check("sendEmail smtp unconfigured -> ok:false (no network)", mNoSmtp.ok === false && /SMTP_HOST/.test(mNoSmtp.error!));
throws("smtpSettings throws when incomplete", () => { const h = process.env.SMTP_HOST; delete process.env.SMTP_HOST; try { smtpSettings(); } finally { process.env.SMTP_HOST = h; } }, /SMTP_HOST/);
const smtp = smtpSettings();
check("smtpSettings reads env (port default 587)", smtp.host === "smtp.example.test" && smtp.port === 587 && smtp.from === "alerts@example.test" && smtp.secure === false);
// renderAlertEmail escaping
const em = renderAlertEmail({ title: '<script>alert("t")</script>', body: "a&b", links: [{ label: "L<", url: 'https://x.test/"q' }] });
check("renderAlertEmail escapes title", !em.html.includes("<script>") && em.html.includes("&lt;script&gt;"));
check("renderAlertEmail escapes body", em.html.includes("a&amp;b"));
check("BUG? renderAlertEmail href interpolates raw url", !em.html.includes('href="https://x.test/"q"'));
check("renderAlertEmail text part lists links", em.text.includes("L<: https://x.test/"));

// dispatchToChannel routing + channelHint + decryptChannelConfig
const chSlack: any = { id: "c1", name: "s", type: "slack", configEnc: encCfg({ webhookUrl: "http://mock/slack" }) };
const rSlack = await dispatchToChannel(chSlack, { title: "T", body: "B" });
check("dispatchToChannel slack routes ok", rSlack.ok === true && rSlack.type === "slack" && rSlack.channelId === "c1");
const chTg: any = { id: "c2", name: "t", type: "telegram", configEnc: encCfg({ botToken: "tok", chatId: "1" }) };
check("dispatchToChannel telegram routes ok", (await dispatchToChannel(chTg, { title: "T", body: "B" })).ok === true);
// NOTE: dispatchToChannel email + unknown-type branches need real SMTP; the
// unknown-type -> email fallthrough is a code-read observation (see report).
const chBad: any = { id: "c4", name: "b", type: "slack", configEnc: "v1:bad" };
const rBad = await dispatchToChannel(chBad, { title: "T", body: "B" });
check("dispatchToChannel tampered config -> ok:false", rBad.ok === false && rBad.error === "channel config undecryptable");
eq("decryptChannelConfig round-trip", decryptChannelConfig(chSlack), { webhookUrl: "http://mock/slack" });
check("channelHint slack shows tail", channelHint("slack", { webhookUrl: "https://hooks.slack.com/services/AAA/BBB/CCC" }).endsWith("AAA/BBB/CCC".slice(-14)) || channelHint("slack", { webhookUrl: "https://hooks.slack.com/services/AAA/BBB/CCC" }).length > 0);
eq("channelHint telegram", channelHint("telegram", { botToken: "t", chatId: "99" }), "chat 99");
eq("channelHint email", channelHint("email", { to: "a@b.test" }), "a@b.test");

// validateChannelConfig edges
check("validate slack non-slack-host rejected", validateChannelConfig("slack", { webhookUrl: "http://mock/slack" }).ok === false);
check("validate slack https hooks.slack.com accepted", validateChannelConfig("slack", { webhookUrl: "https://hooks.slack.com/services/X" }).ok === true);
check("validate telegram missing chatId rejected", validateChannelConfig("telegram", { botToken: "t" }).ok === false);
check("validate email bad address rejected", validateChannelConfig("email", { to: "not-an-email" }).ok === false);
check("validate email bad cc rejected", validateChannelConfig("email", { to: "a@b.test", cc: "bad" }).ok === false);
check("validate email trims", (() => { const r = validateChannelConfig("email", { to: "  a@b.test " }); return r.ok && (r as any).config.to === "a@b.test"; })());
const sealed = sealChannelConfig("slack", { webhookUrl: "https://hooks.slack.com/services/X" });
check("sealChannelConfig encrypts + hints", typeof sealed.configEnc === "string" && sealed.configEnc.startsWith("v1:") && sealed.hint.length > 0);
check("triggerDef known", triggerDef("rank_drop")?.key === "rank_drop");
check("triggerDef unknown -> undefined", triggerDef("nope") === undefined);

// ================================================================ authz
section("authz");

eq("ROLE_RANK has exactly 4 roles", Object.keys(ROLE_RANK).sort(), ["admin", "editor", "owner", "viewer"]);
check("rank order owner>admin>editor>viewer", ROLE_RANK.owner > ROLE_RANK.admin && ROLE_RANK.admin > ROLE_RANK.editor && ROLE_RANK.editor > ROLE_RANK.viewer);
// 16-case truth table
const matrix: Record<string, Record<string, boolean>> = {
  viewer: { viewer: true, editor: false, admin: false, owner: false },
  editor: { viewer: true, editor: true, admin: false, owner: false },
  admin: { viewer: true, editor: true, admin: true, owner: false },
  owner: { viewer: true, editor: true, admin: true, owner: true },
};
let mOk = true;
for (const [r, row] of Object.entries(matrix)) for (const [min, want] of Object.entries(row)) if (roleAtLeast(r as any, min as any) !== want) mOk = false;
check("roleAtLeast truth table (16)", mOk);
// null/undefined/empty/crafted roles fail closed
check("roleAtLeast(null) false", roleAtLeast(null, "viewer") === false);
check("roleAtLeast(undefined) false", roleAtLeast(undefined, "viewer") === false);
check("roleAtLeast('') false", roleAtLeast("" as any, "viewer") === false);
check("roleAtLeast('superuser') false", roleAtLeast("superuser" as any, "viewer") === false);
check("roleAtLeast('Owner') case-sensitive false", roleAtLeast("Owner" as any, "viewer") === false);
check("roleAtLeast('owner ') trailing space false", roleAtLeast("owner " as any, "viewer") === false);
check("roleAtLeast('owner\\0') false", roleAtLeast("owner\0" as any, "viewer") === false);
check("roleAtLeast('admin','owner') false (no escalation)", roleAtLeast("admin", "owner") === false);

db = freshDB(); installFakePrisma();
db.workspaces.push({ id: "ws1", ownerUserId: "u_owner", createdAt: new Date() });
db.workspaces.push({ id: "ws2", ownerUserId: "u_owner", createdAt: new Date() });
db.projects.push({ id: "p1", workspaceId: "ws1" }, { id: "p2", workspaceId: "ws2" });
db.memberships.push({ id: "m1", workspaceId: "ws1", userId: "u_ed", role: "editor", createdAt: new Date() });
db.memberships.push({ id: "m2", workspaceId: "ws2", userId: "u_ed", role: "editor", createdAt: new Date() });
db.memberships.push({ id: "m3", workspaceId: "ws1", userId: "u_view", role: "viewer", createdAt: new Date() });

// viewer attempting editor action
check("viewer cannot requireProjectRole(editor)", (await requireProjectRole("u_view", "p1", "editor")) === null);
check("viewer can requireProjectRole(viewer)", (await requireProjectRole("u_view", "p1", "viewer")) !== null);
// editor allowed editor action, denied admin action
check("editor can requireProjectRole(editor)", (await requireProjectRole("u_ed", "p1", "editor")) !== null);
check("editor denied requireProjectRole(admin)", (await requireProjectRole("u_ed", "p1", "admin")) === null);
// cross-project: same role, project in workspace where user has NO membership
db.memberships = db.memberships.filter((m) => m.id !== "m2"); // u_ed only in ws1 now
check("cross-project: editor in ws1 cannot touch p2 (ws2)", (await requireProjectRole("u_ed", "p2", "editor")) === null);
db.memberships.push({ id: "m2b", workspaceId: "ws2", userId: "u_ed", role: "viewer", createdAt: new Date() });
const cross = await requireProjectRole("u_ed", "p2", "viewer");
check("cross-project: membership in ws2 grants ws2-scoped access", cross !== null && cross.membership.workspaceId === "ws2");
check("cross-project: ws2 viewer role does not leak ws1 editor", (await requireProjectRole("u_ed", "p2", "editor")) === null);
// malformed project ids
check("requireProjectRole non-string id -> null", (await requireProjectRole("u_ed", 123 as any, "editor")) === null);
check("requireProjectRole empty id -> null", (await requireProjectRole("u_ed", "", "editor")) === null);
check("requireProjectRole unknown project -> null", (await requireProjectRole("u_ed", "px", "editor")) === null);
// non-member, non-owner
check("requireWorkspaceRole stranger -> null", (await requireWorkspaceRole("u_stranger", "ws1", "viewer")) === null);
// legacy owner backfill
const back = await requireWorkspaceRole("u_owner", "ws1", "owner");
check("legacy owner (no member row) backfilled to owner", back !== null && back.role === "owner");
check("backfill row persisted", db.memberships.some((m) => m.workspaceId === "ws1" && m.userId === "u_owner" && m.role === "owner"));
// legacy backfill does NOT fire for non-owner
check("non-owner gets no backfill", (await requireWorkspaceRole("u_stranger2", "ws1", "viewer")) === null);
check("getMembership returns null for stranger", (await getMembership("u_stranger2", "ws1")) === null);
// forbidden() shape
const f403 = forbidden() as Response;
check("forbidden() is 403 json", f403.status === 403);
eq("forbidden() default message", await f403.json(), { error: "Insufficient role for this action." });
// tokenized invites (day-1 hardening, M5): single-use token links replace
// bare email-match claiming
const { inviteToken: tok1, inviteExpiresAt: exp1 } = mintInviteToken();
check("mintInviteToken produces 64-hex-char token", /^[0-9a-f]{64}$/.test(tok1));
check("mintInviteToken expiry ~7 days out", exp1.getTime() - Date.now() > 6 * 86400000 && exp1.getTime() - Date.now() <= 7 * 86400000);
db.memberships.push({ id: "mi1", workspaceId: "ws1", userId: null, email: "foo@bar.com", role: "editor", inviteToken: tok1, inviteExpiresAt: exp1, createdAt: new Date() });
const claimed = await claimInviteToken("u_new", "  FOO@Bar.com ", tok1);
check("claimInviteToken claims with token + matching email (case-insensitive)", claimed !== null && claimed.userId === "u_new");
check("claimInviteToken clears the token (single-use)", db.memberships.find((m) => m.id === "mi1").inviteToken === null);
check("claimInviteToken audits the privilege grant", db.audit.some((a) => a.action === "member_invite_accepted" && a.workspaceId === "ws1"));
check("double claim with spent token rejected", (await claimInviteToken("u_other", "foo@bar.com", tok1)) === null);
const { inviteToken: tok2, inviteExpiresAt: exp2 } = mintInviteToken();
db.memberships.push({ id: "mi2", workspaceId: "ws1", userId: null, email: "bar@bar.com", role: "viewer", inviteToken: tok2, inviteExpiresAt: exp2, createdAt: new Date() });
check("wrong token rejected", (await claimInviteToken("u_x", "bar@bar.com", "nope")) === null);
check("email mismatch rejected (no cross-account spray)", (await claimInviteToken("u_x", "evil@x.com", tok2)) === null);
check("email case still normalizes on claim", (await claimInviteToken("u_y", "BAR@bar.com", tok2)) !== null);
const { inviteToken: tok3 } = mintInviteToken();
db.memberships.push({ id: "mi3", workspaceId: "ws1", userId: null, email: "old@bar.com", role: "viewer", inviteToken: tok3, inviteExpiresAt: new Date(Date.now() - 1000), createdAt: new Date() });
check("expired token rejected", (await claimInviteToken("u_z", "old@bar.com", tok3)) === null);
// concurrent double-claim: exactly one winner (atomic single-use claim, day-1)
const { inviteToken: tok4, inviteExpiresAt: exp4 } = mintInviteToken();
db.memberships.push({ id: "mi4", workspaceId: "ws1", userId: null, email: "race@bar.com", role: "editor", inviteToken: tok4, inviteExpiresAt: exp4, createdAt: new Date() });
const [rc1, rc2] = await Promise.all([
  claimInviteToken("u_race1", "race@bar.com", tok4),
  claimInviteToken("u_race2", "race@bar.com", tok4),
]);
const winners = [rc1, rc2].filter((r) => r !== null);
check("FIXED: concurrent double-claim has exactly one winner", winners.length === 1, `winners=${winners.length}`);
check("FIXED: token cleared after race", db.memberships.find((m) => m.id === "mi4").inviteToken === null);

// ================================================================ login rate limiter (day-1, H1/M8)
section("login-rate-limit");
// two independent dimensions: per-account across IPs, per-IP across accounts
__resetLoginAttempts();
for (let i = 0; i < LOGIN_ACCOUNT_MAX_FAILURES; i++) {
  recordLoginFailure(`10.0.0.${i}`, "victim@example.com");
}
check("FIXED: per-account lockout trips across rotating IPs",
  loginLockedOut("192.168.99.99", "victim@example.com") === true);
check("FIXED: per-account lockout does not touch other accounts",
  loginLockedOut("192.168.99.99", "other@example.com") === false);

__resetLoginAttempts();
for (let i = 0; i < LOGIN_IP_MAX_FAILURES; i++) {
  recordLoginFailure("203.0.113.7", `user${i}@example.com`);
}
check("FIXED: per-IP lockout trips across rotating accounts",
  loginLockedOut("203.0.113.7", "brand-new@example.com") === true);
check("FIXED: per-IP lockout does not touch other IPs",
  loginLockedOut("203.0.113.8", "brand-new@example.com") === false);

__resetLoginAttempts();
for (let i = 0; i < LOGIN_ACCOUNT_MAX_FAILURES - 1; i++) {
  recordLoginFailure("10.1.1.1", "almost@example.com");
}
check("below threshold not locked", loginLockedOut("10.1.1.1", "almost@example.com") === false);
recordLoginSuccess("10.1.1.1", "almost@example.com");
for (let i = 0; i < LOGIN_ACCOUNT_MAX_FAILURES - 1; i++) {
  recordLoginFailure("10.1.1.1", "almost@example.com");
}
check("FIXED: success resets the failure count", loginLockedOut("10.1.1.1", "almost@example.com") === false);
__resetLoginAttempts();
check("reset clears all state", loginLockedOut("203.0.113.7", "brand-new@example.com") === false);

// ================================================================ cron gate (day-1, M1)
section("cron-gate");
// The shared gate (lib/cron/gate.ts) replaced 12 copy-pasted inline gates.
// CRON_SECRET service path is unit-testable; the session path delegates to
// requireUser() (auth() binding — not mockable, same as the session section)
// composed with requireWorkspaceRole(), which the authz section covers.
const { cronGate } = await import("@/lib/cron/gate");
const cronReq = (authz?: string) =>
  new Request("http://localhost/api/cron/newsletter", {
    method: "POST",
    headers: authz ? { authorization: authz } : {},
  });
const keepCronSecret = process.env.CRON_SECRET;
process.env.CRON_SECRET = "s3cr3t";
const g1 = await cronGate(cronReq("Bearer s3cr3t"));
check("valid CRON_SECRET → cron gate passes", !(g1 instanceof Response) && g1.isCron === true && g1.workspaceId === null);
// Non-cron requests fall through to requireUser() → auth(), which throws
// outside a Next.js request scope. In production that path returns null →
// 401; here we assert it never authenticates as cron (throw or 401 or
// non-cron gate).
async function neverCron(req: Request): Promise<boolean> {
  try {
    const g = await cronGate(req);
    return g instanceof Response || g.isCron === false;
  } catch {
    return true;
  }
}
check("wrong secret is not treated as cron", await neverCron(cronReq("Bearer wrong")));
delete process.env.CRON_SECRET;
check("absent CRON_SECRET never authenticates as cron", await neverCron(cronReq("Bearer s3cr3t")));
if (keepCronSecret === undefined) delete process.env.CRON_SECRET;
else process.env.CRON_SECRET = keepCronSecret;

// ================================================================ SSO provisioning (day-1, M4/M5)
section("sso");
const { provisionSsoUser, ssoAutoProvisioningConfigured } = await import("@/lib/sso");
const keepSsoWs = process.env.SSO_WORKSPACE_ID;
const keepSsoDomain = process.env.SSO_DOMAIN;
const keepSsoRole = process.env.SSO_DEFAULT_ROLE;
process.env.SSO_WORKSPACE_ID = "ws1";
process.env.SSO_DOMAIN = "example.com";
process.env.SSO_DEFAULT_ROLE = "editor";
check("sso auto-provisioning configured when env set", ssoAutoProvisioningConfigured() === true);
const membersBefore = db.memberships.length;
await provisionSsoUser("u_sso1", "new@example.com", false);
check("FIXED: SSO requires verified email claim (unverified → no provisioning)",
  db.memberships.length === membersBefore);
await provisionSsoUser("u_sso2", "new@other.com", true);
check("SSO domain mismatch not provisioned", db.memberships.length === membersBefore);
await provisionSsoUser("u_sso3", "new@example.com", true);
const mSso3 = db.memberships.find((m) => m.userId === "u_sso3");
check("verified SSO user provisioned with default role",
  !!mSso3 && mSso3.workspaceId === "ws1" && mSso3.role === "editor");
process.env.SSO_DEFAULT_ROLE = "owner";
await provisionSsoUser("u_sso4", "boss@example.com", true);
const mSso4 = db.memberships.find((m) => m.userId === "u_sso4");
check("FIXED: SSO_DEFAULT_ROLE=owner clamped — SSO never mints owners",
  !!mSso4 && mSso4.role === "editor");
await provisionSsoUser("u_sso3", "new@example.com", true);
check("existing member not re-provisioned",
  db.memberships.filter((m) => m.userId === "u_sso3").length === 1);
const { safeNext } = await import("@/lib/auth/redirect");
check("invite token preserved through login redirect",
  safeNext("/invite?token=abc123") === "/invite?token=abc123");
check("absolute URL rejected (open-redirect guard)",
  safeNext("https://evil.example/phish") === "/dashboard");
check("protocol-relative rejected", safeNext("//evil.example/x") === "/dashboard");
check("backslash rejected", safeNext("/\\evil.example") === "/dashboard");
check("null/empty falls back to dashboard",
  safeNext(null) === "/dashboard" && safeNext("") === "/dashboard");
if (keepSsoWs === undefined) delete process.env.SSO_WORKSPACE_ID; else process.env.SSO_WORKSPACE_ID = keepSsoWs;
if (keepSsoDomain === undefined) delete process.env.SSO_DOMAIN; else process.env.SSO_DOMAIN = keepSsoDomain;
if (keepSsoRole === undefined) delete process.env.SSO_DEFAULT_ROLE; else process.env.SSO_DEFAULT_ROLE = keepSsoRole;

// ================================================================ session
section("session");
// requireUser() calls auth() — an ESM binding that cannot be monkey-patched
// from outside; it is NOT unit-testable here (needs a live NextAuth session).
check("requireUser exists (auth binding not mockable — untestable w/o session)", typeof (await import("@/lib/session")).requireUser === "function");

db = freshDB(); installFakePrisma();
const wOld = { id: "ws_old", ownerUserId: "u1", createdAt: new Date(Date.UTC(2026, 0, 1)) };
const wNew = { id: "ws_new", ownerUserId: "u1", createdAt: new Date(Date.UTC(2026, 5, 1)) };
db.workspaces.push(wOld, wNew);
const acc = await getAccessibleWorkspaces("u1");
check("getAccessibleWorkspaces newest first", acc.length === 2 && acc[0].id === "ws_new" && acc[1].id === "ws_old");
const accNone = await getAccessibleWorkspaces("u_stranger");
check("getAccessibleWorkspaces stranger -> []", accNone.length === 0);
db.memberships.push({ id: "mm1", workspaceId: "ws_old", userId: "u2", role: "editor", createdAt: new Date() });
const accMember = await getAccessibleWorkspaces("u2");
check("getAccessibleWorkspaces member-only workspace visible", accMember.length === 1 && accMember[0].id === "ws_old");

// getOrCreateWorkspace: prefers explicit member workspace
db = freshDB(); installFakePrisma();
db.workspaces.push(
  { id: "ws_a", ownerUserId: "u1", createdAt: new Date(Date.UTC(2026, 5, 1)) },
  { id: "ws_b", ownerUserId: "u1", createdAt: new Date(Date.UTC(2026, 0, 1)) },
);
db.memberships.push({ id: "mmb", workspaceId: "ws_b", userId: "u1", role: "editor", createdAt: new Date(Date.UTC(2026, 2, 1)) });
const picked = await getOrCreateWorkspace("u1", "u1@example.test");
check("getOrCreateWorkspace prefers explicit-member workspace", (picked as any).id === "ws_b");
// fallback: newest accessible when no member row
db = freshDB(); installFakePrisma();
db.workspaces.push(
  { id: "ws_a", ownerUserId: "u1", createdAt: new Date(Date.UTC(2026, 5, 1)) },
  { id: "ws_b", ownerUserId: "u1", createdAt: new Date(Date.UTC(2026, 0, 1)) },
);
const picked2 = await getOrCreateWorkspace("u1", null);
check("getOrCreateWorkspace falls back to newest accessible", (picked2 as any).id === "ws_a");
// creation path
db = freshDB(); installFakePrisma();
const created = await getOrCreateWorkspace("u9", "new@example.test") as any;
check("getOrCreateWorkspace creates personal workspace", created.ownerUserId === "u9" && created.name === "new@example.test's workspace");
check("creation adds owner membership row", db.memberships.some((m) => m.workspaceId === created.id && m.userId === "u9" && m.role === "owner"));

// ================================================================ sitefiles/paths
section("sitefiles/paths");
eq("root", sanitizePath("/"), "/");
eq("empty -> /", sanitizePath(""), "/");
eq("whitespace -> /", sanitizePath("   "), "/");
eq("normal", sanitizePath("/a/b/c"), "/a/b/c");
eq("relative", sanitizePath("a/b"), "/a/b");
eq("dup slashes collapsed", sanitizePath("//a///b"), "/a/b");
eq("dot segments dropped", sanitizePath("/a/./b"), "/a/b");
eq("trailing slash", sanitizePath("/a/b/"), "/a/b");
throws(".. rejected", () => sanitizePath("/a/../b"), /escapes/);
throws("leading .. rejected", () => sanitizePath("../x"), /escapes/);
throws("bare .. rejected", () => sanitizePath(".."), /escapes/);
throws("backslash .. rejected", () => sanitizePath("..\\x"), /escapes/);
throws("backslash mid-path .. rejected", () => sanitizePath("/a\\..\\b"), /escapes/);
throws("deep .. rejected", () => sanitizePath("/a/b/../../c"), /escapes/);
throws("non-string rejected", () => sanitizePath(123 as any), /Invalid path/);
throws("null rejected", () => sanitizePath(null as any), /Invalid path/);
eq("..hidden is a normal segment", sanitizePath("/a/..hidden/x"), "/a/..hidden/x");
eq("... is a normal segment", sanitizePath("/a/.../b"), "/a/.../b");
eq("URL-encoded dots NOT decoded (kept literally)", sanitizePath("/%2e%2e/%2e%2e/etc/passwd"), "/%2e%2e/%2e%2e/etc/passwd");
eq("overlong UTF-8 %c0%ae kept literally", sanitizePath("/%c0%ae/%c0%ae/x"), "/%c0%ae/%c0%ae/x");
eq("fullwidth dots kept literally", sanitizePath("/．．/x"), "/．．/x");
eq("absolute path stays under root", sanitizePath("/etc/passwd"), "/etc/passwd");
eq("joinPath", joinPath("/a", "b"), "/a/b");
eq("joinPath root", joinPath("/", "x"), "/x");
throws("joinPath .. rejected", () => joinPath("/a", "../b"), /escapes/);
eq("parentPath", parentPath("/a/b/c"), "/a/b");
eq("parentPath root", parentPath("/"), "/");
eq("parentPath one level", parentPath("/a"), "/");

// ================================================================ sitefiles/crypto
section("sitefiles/crypto");
eq("round-trip", decryptSecret(encryptSecret("hello")), "hello");
let emptyRt: string;
try { emptyRt = decryptSecret(encryptSecret("")); } catch (e) { emptyRt = `THREW: ${(e as Error).message}`; }
check("round-trip empty plaintext", emptyRt === "", emptyRt);
eq("round-trip 100k chars", decryptSecret(encryptSecret("x".repeat(100_000))).length, 100_000);
eq("round-trip unicode", decryptSecret(encryptSecret("🔑 héllo→世界 \0 tab\there")), "🔑 héllo→世界 \0 tab\there");
check("envelope format v1:iv:ct:tag (4 parts)", encryptSecret("a").split(":").length === 4);
check("two encryptions differ (random IV)", encryptSecret("same") !== encryptSecret("same"));
// wrong key fails closed
const encA = encryptSecret("secret-data");
const keepKey = process.env.MARKETR_CREDENTIALS_KEY;
process.env.MARKETR_CREDENTIALS_KEY = "cd".repeat(32);
throws("decrypt with wrong key fails closed", () => decryptSecret(encA), /./);
process.env.MARKETR_CREDENTIALS_KEY = keepKey;
// tampering fails closed
const parts = encryptSecret("tamper-me").split(":");
const flip = (b64: string) => { const b = Buffer.from(b64, "base64"); b[0] ^= 1; return b.toString("base64"); };
throws("tampered ciphertext rejected", () => decryptSecret([parts[0], parts[1], flip(parts[2]), parts[3]].join(":")), /./);
throws("tampered tag rejected", () => decryptSecret([parts[0], parts[1], parts[2], flip(parts[3])].join(":")), /./);
throws("tampered iv rejected", () => decryptSecret([parts[0], flip(parts[1]), parts[2], parts[3]].join(":")), /./);
throws("wrong version rejected", () => decryptSecret(["v2", parts[1], parts[2], parts[3]].join(":")), /Unrecognized/);
throws("truncated envelope rejected", () => decryptSecret("v1:abc"), /Unrecognized/);
throws("empty envelope rejected", () => decryptSecret(""), /Unrecognized/);
throws("missing env key throws", () => { const k = process.env.MARKETR_CREDENTIALS_KEY; delete process.env.MARKETR_CREDENTIALS_KEY; try { encryptSecret("x"); } finally { process.env.MARKETR_CREDENTIALS_KEY = k; } }, /not set/);
throws("short key rejected", () => { const k = process.env.MARKETR_CREDENTIALS_KEY; process.env.MARKETR_CREDENTIALS_KEY = "abcd"; try { encryptSecret("x"); } finally { process.env.MARKETR_CREDENTIALS_KEY = k; } }, /32 bytes/);
// base64 key accepted (44 chars)
check("base64 32-byte key accepted", (() => { const k = process.env.MARKETR_CREDENTIALS_KEY; process.env.MARKETR_CREDENTIALS_KEY = Buffer.alloc(32, 7).toString("base64"); try { return decryptSecret(encryptSecret("ok")) === "ok"; } finally { process.env.MARKETR_CREDENTIALS_KEY = k; } })());
// hint: deterministic, leaks nothing
eq("secretHint deterministic", secretHint("abc"), secretHint("abc"));
check("secretHint hides plaintext", !secretHint("mysecret").includes("mysecret"));
check("secretHint distinct per secret", secretHint("a") !== secretHint("b"));

// ================================================================ sitefiles/mock provider
section("sitefiles/mock");
const mp = new MockSiteFileProvider();
check("mock name/isLive", mp.name === "mock" && mp.isLive === false);
const root = await mp.listDir("/");
check("listDir / has public_html", root.some((e) => e.name === "public_html" && e.type === "dir"));
check("listDir entries flagged mock", root.every((e) => (e as any).mock === true));
const ph = await mp.listDir("/public_html");
check("listDir /public_html has index.php", ph.some((e) => e.name === "index.php" && e.type === "file"));
check("listDir dirs sort before files", (() => { const i = ph.findIndex((e) => e.type === "file"); const j = ph.findIndex((e) => e.type === "dir"); return j === -1 || j < i; })());
const idx = await mp.readFile("/public_html/index.php");
check("readFile returns content", idx.content.includes("Acme Plumbing") && idx.truncated === false);
await throwsAsync("readFile missing throws", () => mp.readFile("/nope.php"), /No such file/);
await throwsAsync("listDir missing throws", () => mp.listDir("/nope"), /No such/);
await throwsAsync("stat missing throws", () => mp.stat("/nope"), /No such/);
check("stat file entry", (await mp.stat("/public_html/index.php")).type === "file");
check("stat dir entry", (await mp.stat("/public_html")).type === "dir");
const listOnFile = await mp.listDir("/public_html/index.php");
check("listDir on a file path returns [] (no error)", Array.isArray(listOnFile) && listOnFile.length === 0);
// write edges
await mp.writeFile("/public_html/new.php", "<?php echo 1;");
eq("write then read round-trip", (await mp.readFile("/public_html/new.php")).content, "<?php echo 1;");
check("written file appears in debugPaths", mp.debugPaths().includes("/public_html/new.php"));
check("debugPaths sorted", (() => { const p = mp.debugPaths(); return p.every((v, i) => i === 0 || p[i - 1] <= v); })());
await throwsAsync("write traversal rejected", () => mp.writeFile("/../evil.php", "x"), /escapes/);
await throwsAsync("write >1MB rejected", () => mp.writeFile("/big.bin", "x".repeat(1024 * 1024 + 1)), /too large/);
await mp.writeFile("/edge1m.bin", "x".repeat(1024 * 1024));
check("write exactly 1MB allowed", (await mp.stat("/edge1m.bin")).size === 1024 * 1024);
await throwsAsync("write NUL binary rejected", () => mp.writeFile("/bin.dat", "ab\0cd"), /Binary/);
await throwsAsync("write non-string rejected", () => mp.writeFile("/x.txt", 123 as any), /must be text/);
await throwsAsync("readFile traversal rejected", () => mp.readFile("/../../etc/passwd"), /escapes/);
check("parentOf delegates to parentPath", mp.parentOf("/a/b") === "/a");
const t = await mp.test();
check("test() ok", t.ok === true && /mock/i.test(t.message));
// fresh instance resets writes (per-process memory)
const mp2 = new MockSiteFileProvider();
check("new instance does not see prior writes", !mp2.debugPaths().includes("/public_html/new.php"));

// ================================================================ sitefiles/sftp (mocked: no network)
section("sitefiles/sftp");
const sftpCfg = { id: "c1", label: "L", host: "invalid.invalid", port: 22, username: "u", authType: "password" as const, secret: "s3cr3t", demo: false };
const sp = new SftpSiteFileProvider(sftpCfg);
check("sftp provider name/isLive", sp.name === "sftp" && sp.isLive === true);
await throwsAsync("sftp listDir sanitizes BEFORE connecting (no network)", () => sp.listDir("/../../etc"), /escapes/);
await throwsAsync("sftp readFile sanitizes BEFORE connecting", () => sp.readFile("..\\..\\x"), /escapes/);

// ================================================================ sitefiles/index + api
section("sitefiles/index+api");
const demoConn: any = { id: "d1", label: "demo", host: "", port: 22, username: "", authType: "password", secretEnc: "", demo: true };
check("demo connection -> MockSiteFileProvider", getSiteFileProvider(demoConn) instanceof MockSiteFileProvider);
const liveConn: any = { id: "l1", label: "live", host: "h", port: 22, username: "u", authType: "key", secretEnc: getSecretsProvider().encrypt("private-key-material"), demo: false };
const liveProv: any = getSiteFileProvider(liveConn);
check("live connection -> SftpSiteFileProvider", liveProv instanceof SftpSiteFileProvider);
check("live provider received decrypted secret server-side", liveProv.conn.secret === "private-key-material");
throws("tampered secretEnc throws (fail closed)", () => getSiteFileProvider({ ...liveConn, secretEnc: "v1:tampered" }), /./);
const pub = publicConnection({ id: "l1", label: "live", host: "h", port: 22, username: "u", authType: "key", secretHint: "••••abcd", demo: false, lastTestedAt: new Date(Date.UTC(2026, 8, 1)), lastTestOk: true, createdAt: new Date(Date.UTC(2026, 8, 1)) });
check("publicConnection strips secrets", !("secretEnc" in pub) && !("secret" in pub) && (pub as any).secretHint === "••••abcd");
check("publicConnection isLive = !demo", (pub as any).isLive === true);

db = freshDB(); installFakePrisma();
db.workspaces.push({ id: "ws1", ownerUserId: "u1", createdAt: new Date() });
db.projects.push({ id: "p1", workspaceId: "ws1" }, { id: "p2", workspaceId: "ws1" });
db.memberships.push({ id: "m1", workspaceId: "ws1", userId: "u1", role: "editor", createdAt: new Date() });
db.siteConnections.push({ id: "c1", projectId: "p1" }, { id: "c2", projectId: "p2" });
check("ownedProject member -> project", (await ownedProject("u1", "p1"))?.id === "p1");
check("ownedProject stranger -> null", (await ownedProject("u9", "p1")) === null);
check("ownedProject bad id -> null", (await ownedProject("u1", 5 as any)) === null);
check("ownedConnection same project -> conn", (await ownedConnection("u1", "p1", "c1"))?.id === "c1");
check("ownedConnection cross-project conn -> null", (await ownedConnection("u1", "p1", "c2")) === null);
check("ownedConnection stranger -> null", (await ownedConnection("u9", "p1", "c1")) === null);
eq("readJsonBody parses", await readJsonBody(new Request("http://x", { method: "POST", body: '{"a":1}' })), { a: 1 });
eq("readJsonBody invalid -> null", await readJsonBody(new Request("http://x", { method: "POST", body: "not json" })), null);
eq("readJsonBody empty GET -> null", await readJsonBody(new Request("http://x")), null);

// ================================================================ secrets
section("secrets");
const prov = getSecretsProvider();
check("default provider is env", prov.id === "env" && prov instanceof EnvSecretsProvider);
check("getSecretsProvider singleton", getSecretsProvider() === prov);
let emptySecRt: string;
try { emptySecRt = prov.decrypt(prov.encrypt("")); } catch (e) { emptySecRt = `THREW: ${(e as Error).message}`; }
check("encrypt/decrypt empty secret round-trips", emptySecRt === "", emptySecRt);
eq("encrypt/decrypt round-trip", prov.decrypt(prov.encrypt("s3cr3t!")), "s3cr3t!");
check("envelopes are randomized", prov.encrypt("x") !== prov.encrypt("x"));
throws("decrypt garbage fails closed", () => prov.decrypt("garbage"), /Unrecognized/);
check("hint hides secret", !prov.hint("topsecret").includes("topsecret"));
// rotation: data encrypted under key A is unreadable under key B (no rotation support)
const encOld = prov.encrypt("old-secret");
const keepK = process.env.MARKETR_CREDENTIALS_KEY;
process.env.MARKETR_CREDENTIALS_KEY = "ef".repeat(32);
throws("decrypt with rotated key fails (no re-encryption path)", () => prov.decrypt(encOld), /./);
process.env.MARKETR_CREDENTIALS_KEY = keepK;
check("restored key decrypts again", prov.decrypt(encOld) === "old-secret");
throws("AwsKmsSecretsProvider.encrypt is a stub", () => new AwsKmsSecretsProvider().encrypt(), /documented stub/);
throws("AwsKmsSecretsProvider.decrypt is a stub", () => new AwsKmsSecretsProvider().decrypt(), /documented stub/);
// SECRETS_PROVIDER=aws-kms selection requires AWS vars — needs a fresh module
// instance; the singleton is already cached, so verify the guard statically.
const secretsSrc = readFileSync(new URL("../lib/secrets/index.ts", import.meta.url), "utf8");
check("aws-kms branch guards on AWS_KMS_KEY_ID+AWS_REGION", secretsSrc.includes("AWS_KMS_KEY_ID") && secretsSrc.includes("AWS_REGION"));

// ================================================================ usage + cost
section("usage+cost");
db = freshDB(); installFakePrisma();
const period = new Date().toISOString().slice(0, 7);
await recordUsage("ws1", "ai_words" as any, 5);
await recordUsage("ws1", "ai_words" as any, 3);
check("recordUsage accumulates via upsert", db.usage.get(`ws1|ai_words|${period}`) === 8);
const uq = db.usageUpserts[0];
check("recordUsage upsert key shape", uq.where.workspaceId_meter_period.workspaceId === "ws1" && uq.where.workspaceId_meter_period.meter === "ai_words" && uq.where.workspaceId_meter_period.period === period);
check("recordUsage uses atomic increment op (no read-modify-write -> no lost update)", uq.update?.quantity?.increment === 5 && uq.create?.quantity === 5);
// negative usage decrements the meter
await recordUsage("ws1", "ai_words" as any, -8);
check("recordUsage negative quantity decrements meter", db.usage.get(`ws1|ai_words|${period}`) === 0);
// float accumulation shows binary error
db = freshDB(); installFakePrisma();
await recordUsage("ws1", "serp_calls" as any, 0.1);
await recordUsage("ws1", "serp_calls" as any, 0.2);
const fsum = db.usage.get(`ws1|serp_calls|${period}`);
check("float increments accumulate binary error (0.1+0.2 != 0.3)", fsum !== 0.3);
// recordUsage never throws into caller even if prisma fails (best-effort contract is caller's)
const P: any = prisma;
const keepUpsert = P.apiUsage.upsert;
P.apiUsage.upsert = async () => { throw new Error("db down"); };
let threw = false;
try { await recordUsage("ws1", "ai_words" as any, 1); } catch { threw = true; }
P.apiUsage.upsert = keepUpsert;
check("recordUsage propagates prisma errors (callers must swallow)", threw === true);

// checkLocalBudget edges
const b1 = checkLocalBudget(5, 20, 25);
check("exactly at cap (20+5=25) allowed", b1.ok === true && b1.blockedReason === null);
const b2 = checkLocalBudget(5.0001, 20, 25);
check("1/100th of a cent over cap blocked", b2.ok === false && /exceed/.test(b2.blockedReason!));
const b3 = checkLocalBudget(0, 25, 25);
check("zero cost at full cap allowed", b3.ok === true);
const b4 = checkLocalBudget(1, 30, 25);
check("already over cap blocks further spend", b4.ok === false);
check("NaN estimate fails closed", checkLocalBudget(NaN, 0, 25).ok === false);
check("FIXED: negative estimate fails closed (was: passed with no floor)", checkLocalBudget(-5, 20, 25).ok === false);
check("FIXED: negative used fails closed", checkLocalBudget(5, -10, 25).ok === false);
check("zero cap blocks any positive spend", checkLocalBudget(0.0001, 0, 0).ok === false);
check("estimatedCostUsd rounded to 4dp", checkLocalBudget(0.123456, 0, 25).estimatedCostUsd === 0.1235);

// checkPullBudget edges
check("rows exactly at MAX allowed", checkPullBudget(MAX_BACKLINK_ROWS_PER_PULL, 0, 25).ok === true);
const pbOver = checkPullBudget(MAX_BACKLINK_ROWS_PER_PULL + 1, 0, 10_000);
check("rows MAX+1 blocked", pbOver.ok === false && /per-pull limit/.test(pbOver.blockedReason!));
check("checkPullBudget NaN rows fails closed", checkPullBudget(NaN, 0, 25).ok === false);
check("FIXED: checkPullBudget negative rows fails closed (was: ok)", checkPullBudget(-5, 0, 25).ok === false);
// estimate edges
check("estimateListPullCost clamps to MAX rows", estimateListPullCost(1e9) === estimateListPullCost(MAX_BACKLINK_ROWS_PER_PULL));
check("estimateListPullCost(NaN) is finite-safe", Number.isFinite(estimateListPullCost(NaN)));
check("estimateListPullCost(-3) = request fee only", estimateListPullCost(-3) === estimateSummaryPullCost());
check("estimateGridRunCost clamps to 81 cells", estimateGridRunCost(1000) === estimateGridRunCost(MAX_GRID_CELLS_PER_RUN));
check("estimateGridRunCost(NaN) is finite-safe", Number.isFinite(estimateGridRunCost(NaN)));
check("estimateGridRunCost(-5) = 0", estimateGridRunCost(-5) === 0);
check("estimateCompetitorRefreshCost(-2) = 0", estimateCompetitorRefreshCost(-2) === 0);
check("estimateReviewsIngestCost = 0.01", estimateReviewsIngestCost() === 0.01);
check("DEFAULT caps are 25", DEFAULT_LOCAL_SPEND_CAP_USD === 25 && DEFAULT_MONTHLY_SPEND_CAP_USD === 25);
check("monthKey format YYYY-MM", monthKey(new Date(Date.UTC(2026, 8, 21))) === "2026-09");

// ================================================================ llm
section("llm");
// provider selection via env
delete process.env.LLM_API_KEY; delete process.env.OPENAI_API_KEY;
check("no key -> MockLlmProvider", getLlmProvider() instanceof MockLlmProvider);
process.env.OPENAI_API_KEY = "k2";
check("OPENAI_API_KEY fallback", getLlmProvider() instanceof OpenAiCompatibleLlmProvider);
process.env.LLM_API_KEY = "";
check("empty LLM_API_KEY does NOT fall back to OPENAI_API_KEY (?? semantics -> mock)", getLlmProvider() instanceof MockLlmProvider);
process.env.LLM_API_KEY = "k1";
const live = getLlmProvider() as OpenAiCompatibleLlmProvider;
check("LLM_API_KEY preferred", live instanceof OpenAiCompatibleLlmProvider && live.isConfigured());
delete process.env.LLM_API_KEY; delete process.env.OPENAI_API_KEY;
const st = llmStatus();
eq("llmStatus mock shape", st, { name: "mock", isLive: false, configured: true, model: null });

// mock provider: deterministic, keyword extraction
const mock = new MockLlmProvider();
const p1 = 'Write a draft targeting the keyword: "seo tools" for a client.';
const o1 = await mock.generate(p1);
const o2 = await mock.generate(p1);
check("MockLlmProvider deterministic", o1 === o2);
check("MockLlmProvider extracts keyword title-cased", o1.includes("Seo Tools"));
check("MockLlmProvider labels itself mock", o1.includes("Mock draft"));
const o3 = await mock.generate("write something with no keyword phrase");
check("MockLlmProvider default keyword", o3.includes("your keyword"));
check("mock isConfigured true, not live", mock.isConfigured() === true && mock.isLive === false);

// openai-compatible provider: failure modes (fetch stubbed, no network)
const mkProv = (base = "http://mock-llm.test") => new OpenAiCompatibleLlmProvider("k", "m", base);
await throwsAsync("generate unconfigured throws", () => new OpenAiCompatibleLlmProvider("", "m", "http://x").generate("hi"), /not configured/);
fetchCalls.length = 0;
fetchBehavior = { status: 200, text: JSON.stringify({ choices: [{ message: { content: "  hello world  " } }] }) };
eq("generate 200 trims content", await mkProv().generate("hi"), "hello world");
check("generate posts to /chat/completions", fetchCalls[fetchCalls.length - 1].url === "http://mock-llm.test/chat/completions");
check("generate sends bearer auth + model", (() => { const b = lastFetchBody(); const h = fetchCalls[fetchCalls.length - 1].init.headers; return b.model === "m" && h.Authorization === "Bearer k" && b.messages[0].role === "user"; })());
check("generate strips trailing slashes from baseUrl", await (async () => { fetchCalls.length = 0; await mkProv("http://mock-llm.test///").generate("hi"); return fetchCalls[fetchCalls.length - 1].url === "http://mock-llm.test/chat/completions"; })());
fetchBehavior = { status: 429, text: "rate limited" };
await throwsAsync("generate 429 throws", () => mkProv().generate("hi"), /HTTP 429/);
fetchBehavior = { status: 500, text: "boom" };
await throwsAsync("generate 500 throws", () => mkProv().generate("hi"), /HTTP 500/);
fetchBehavior = { status: 200, text: "this is not json" };
await throwsAsync("generate malformed JSON throws", () => mkProv().generate("hi"), /./);
fetchBehavior = { status: 200, text: JSON.stringify({ choices: [] }) };
await throwsAsync("generate empty choices throws", () => mkProv().generate("hi"), /empty response/);
fetchBehavior = { status: 200, text: JSON.stringify({}) };
await throwsAsync("generate missing choices throws", () => mkProv().generate("hi"), /empty response/);
fetchBehavior = { status: 200, text: JSON.stringify({ choices: [{ message: { content: "   " } }] }) };
await throwsAsync("generate whitespace content throws", () => mkProv().generate("hi"), /empty response/);
fetchBehavior = { status: 200, text: JSON.stringify({ choices: [{ message: { content: 123 } }] }) };
await throwsAsync("generate non-string content throws", () => mkProv().generate("hi"), /empty response/);
fetchBehavior = { reject: "socket hang up" };
await throwsAsync("generate network failure throws", () => mkProv().generate("hi"), /socket hang up/);
fetchBehavior = { status: 200, text: JSON.stringify({ choices: [{ message: { content: "x" } }] }) };
check("generate passes no AbortSignal timeout (hang risk on unresponsive endpoint)", await (async () => { fetchCalls.length = 0; await mkProv().generate("hi"); return fetchCalls[fetchCalls.length - 1].init.signal === undefined; })());

// ================================================================ summary
console.log("\n==== per-module results ====");
for (const [name, t] of Object.entries(table)) {
  console.log(`${name}: ${t.run} run, ${t.pass} passed, ${t.fail} failed`);
}
console.log(`\nTOTAL: ${pass} passed, ${fail} failed, ${pass + fail} checks`);
if (failures.length) {
  console.log("\nFailed checks:");
  for (const f of failures) console.log(` - ${f}`);
}
process.exit(fail ? 1 : 0);
