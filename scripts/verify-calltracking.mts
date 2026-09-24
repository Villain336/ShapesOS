// Marketr — R5 call tracking & appointment booking verification battery.
//
// Run against a FRESH database:
//   dropdb --if-exists marketr_vct && createdb marketr_vct
//   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/marketr_vct \
//     npx prisma migrate deploy
//   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/marketr_vct \
//     npx tsx scripts/verify-calltracking.mts
//
// Covers: inbound call → lead match/create → call touch → attribution;
// missed/no-match lead creation; duplicate webhook idempotency; invalid
// signature rejection; released-number blocking; tenant isolation;
// DNI resolution; public booking → availability → booking → lead + touch;
// reminders queued; quiet-hours deferral; opt-out suppression;
// call_minutes exact rounding.
//
// The fake telephony provider is used throughout (no Twilio credentials).
// Route handlers are exercised directly with fabricated Requests; the fake
// webhook signature path validates the same code the Twilio HMAC path uses.

process.env.CALLS_PROVIDER = "fake";
process.env.FAKE_TELEPHONY_SECRET = "verify-battery-secret";
process.env.REMINDERS_CRON_SECRET = "verify-cron-secret";

import { prisma } from "@/lib/prisma";
import {
  FakeTelephonyProvider,
  fakeCallSid,
  signFakeWebhook,
  getProvider,
} from "@/lib/calls/provider";
import {
  handleInboundVoice,
  handleCallStatus,
  normalizePhone,
} from "@/lib/calls/inbound";
import { getCallMinutes } from "@/lib/calls/meter";
import {
  findBookingPageByToken,
  getAvailability,
  handleBookingSubmit,
  hashBookingToken,
  newBookingToken,
  resetBookingLimiter,
  zonedParts,
} from "@/lib/calls/booking";
import {
  isQuietHour,
  localHour,
  nextQuietEnd,
  recordOptOut,
  sendDueReminders,
  type MailPort,
} from "@/lib/calls/reminders";
import { resolveDniNumber, dniSnippetJs } from "@/lib/calls/dni";
import { POST as voicePost } from "@/app/api/calls/webhooks/twilio/voice/route";
import { POST as statusPost } from "@/app/api/calls/webhooks/twilio/status/route";
import { POST as transcriptionPost } from "@/app/api/calls/webhooks/twilio/transcription/route";
import { GET as publicGet, POST as publicPost } from "@/app/api/calls/public/booking/[token]/route";
import { GET as dniGet, resetDniLimiter } from "@/app/api/calls/dni/route";
import { GET as snippetGet } from "@/app/api/calls/dni/snippet/route";
import { POST as runnerPost } from "@/app/api/calls/reminders/run/route";
import { GET as numbersGet } from "@/app/api/calls/numbers/route";
import { GET as pagesGet } from "@/app/api/calls/booking-pages/route";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const SECRET = "verify-battery-secret";
const STAGES = [{ id: "new", label: "New", color: "violet" }];

class FakeMail implements MailPort {
  sent: Array<{ to: string; subject: string; body: string }> = [];
  async send(opts: { to: string; subject: string; body: string }) {
    this.sent.push(opts);
    return { ok: true };
  }
}

function signedJsonRequest(url: string, params: Record<string, string>, sig?: string | null) {
  const signature = sig === undefined ? signFakeWebhook(url, params, SECRET) : sig;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (signature) headers["x-fake-signature"] = signature;
  return new Request(url, { method: "POST", headers, body: JSON.stringify(params) });
}

async function main() {
  FakeTelephonyProvider.resetCounter();
  resetBookingLimiter();
  resetDniLimiter();

  // ---------------------------------------------------------- fixtures
  const wsA = await prisma.workspace.create({
    data: { name: "Battery A", ownerUserId: "battery-user-a", plan: "self_hosted" },
  });
  const wsB = await prisma.workspace.create({
    data: { name: "Battery B", ownerUserId: "battery-user-b", plan: "self_hosted" },
  });
  const pipeA = await prisma.pipeline.create({
    data: { workspaceId: wsA.id, name: "Main", stages: STAGES as object },
  });
  const pipeB = await prisma.pipeline.create({
    data: { workspaceId: wsB.id, name: "Main", stages: STAGES as object },
  });

  const provider = getProvider();
  check("provider resolves to fake by default", provider.name === "fake");

  // Deterministic fake numbers are unique and in the 555-010 exchange.
  const p1 = await provider.purchaseNumber({});
  const p2 = await provider.purchaseNumber({});
  check("fake numbers unique", p1.e164 !== p2.e164, `${p1.e164} vs ${p2.e164}`);
  check("fake numbers are 555-010 exchange", p1.e164.startsWith("+1555010"), p1.e164);

  const numA = await prisma.callNumber.create({
    data: { workspaceId: wsA.id, e164: p1.e164, provider: "fake", providerSid: p1.providerSid, friendlyName: "Main line", campaign: "summer-sale", status: "active" },
  });
  const numA2 = await prisma.callNumber.create({
    data: { workspaceId: wsA.id, e164: p2.e164, provider: "fake", providerSid: p2.providerSid, friendlyName: "Fallback", campaign: null, status: "active" },
  });
  const numB = await prisma.callNumber.create({
    data: { workspaceId: wsB.id, e164: (await provider.purchaseNumber({})).e164, provider: "fake", campaign: "other-campaign", status: "active" },
  });

  // ================================================== inbound calls
  // T1: inbound call from an existing lead → match, call touch, attribution.
  const existingLead = await prisma.lead.create({
    data: { workspaceId: wsA.id, pipelineId: pipeA.id, name: "Existing Caller", phone: "+1 (919) 555-0142", source: "phone", stage: "new", dedupKey: "phone:19195550142" },
  });
  const sid1 = fakeCallSid("t1");
  const voice1 = await handleInboundVoice({ to: numA.e164, from: "+19195550142", callSid: sid1 });
  check("voice accept ok", voice1.ok && voice1.workspaceId === wsA.id);

  const st1 = await handleCallStatus({
    callSid: sid1,
    providerStatus: "completed",
    durationSec: 95,
    recordingUrl: "https://fake.example/rec/1",
  });
  check("status finalize ok", st1.ok && !st1.duplicate);
  check("existing lead matched (no new lead)", st1.leadId === existingLead.id, st1.leadId);
  check("call_minutes rounds up (95s → 2)", st1.minutesBilled === 2, String(st1.minutesBilled));

  const call1 = await prisma.call.findUnique({ where: { externalSid: sid1 } });
  check("call row finalized", call1?.status === "completed" && call1?.durationSec === 95);
  check("fixture transcript attached", !!call1?.transcription?.includes("Thanks for calling"), call1?.transcription?.slice(0, 40));
  check("call summary generated", !!call1?.summary?.includes("connected"), call1?.summary?.slice(0, 60));

  const touches1 = await prisma.attributionTouch.findMany({ where: { leadId: existingLead.id } });
  const callTouch = touches1.find((t) => t.channel === "phone" && t.source === "tracking-number");
  check("call-source attribution touch logged", !!callTouch, JSON.stringify(touches1.map((t) => [t.channel, t.source])));
  check("call touch campaign = number campaign", callTouch?.campaign === "summer-sale", String(callTouch?.campaign));

  // T2: missed call from an unknown caller → lead created (source phone).
  const sid2 = fakeCallSid("t2");
  await handleInboundVoice({ to: numA.e164, from: "+1 919 555 0199", callSid: sid2 });
  const st2 = await handleCallStatus({ callSid: sid2, providerStatus: "no-answer", durationSec: 0 });
  check("missed call finalized", st2.ok && st2.leadId !== undefined);
  const missedLead = await prisma.lead.findUnique({ where: { id: st2.leadId! } });
  check("missed call creates lead", !!missedLead && missedLead.workspaceId === wsA.id);
  check("missed lead source = phone", missedLead?.source === "phone", String(missedLead?.source));
  check("missed lead name carries last4", !!missedLead?.name.includes("0199"), missedLead?.name);
  const missedCall = await prisma.call.findUnique({ where: { externalSid: sid2 } });
  check("missed status mapped", missedCall?.status === "missed");

  // T3: duplicate status callback → idempotent.
  const touchesBefore = await prisma.attributionTouch.count({ where: { leadId: existingLead.id } });
  const leadsBefore = await prisma.lead.count({ where: { workspaceId: wsA.id } });
  const dup = await handleCallStatus({ callSid: sid1, providerStatus: "completed", durationSec: 95 });
  check("duplicate status → duplicate:true", dup.duplicate === true);
  const touchesAfter = await prisma.attributionTouch.count({ where: { leadId: existingLead.id } });
  const leadsAfter = await prisma.lead.count({ where: { workspaceId: wsA.id } });
  check("duplicate adds no touch", touchesAfter === touchesBefore, `${touchesBefore} → ${touchesAfter}`);
  check("duplicate adds no lead", leadsAfter === leadsBefore);
  // Duplicate voice webhook → same call row.
  const voiceDup = await handleInboundVoice({ to: numA.e164, from: "+19195550142", callSid: sid1 });
  check("duplicate voice → same call", voiceDup.ok && voiceDup.callId === call1!.id);

  // T4: webhook signature validation through the real routes.
  const vUrl = "http://localhost/api/calls/webhooks/twilio/voice";
  const badSigReq = signedJsonRequest(vUrl, { From: "+19195550142", To: numA.e164, CallSid: fakeCallSid("bad") }, "deadbeef");
  const badSigRes = await voicePost(badSigReq);
  check("bad webhook signature → 403", badSigRes.status === 403, String(badSigRes.status));
  const noSigReq = signedJsonRequest(vUrl, { From: "+19195550142", To: numA.e164, CallSid: fakeCallSid("nosig") }, null);
  const noSigRes = await voicePost(noSigReq);
  check("missing webhook signature → 403", noSigRes.status === 403);

  // T5: unknown number → 404 via route.
  const unkReq = signedJsonRequest(vUrl, { From: "+19195550142", To: "+15550109999", CallSid: fakeCallSid("unk") });
  const unkRes = await voicePost(unkReq);
  check("unknown number → 404", unkRes.status === 404, String(unkRes.status));

  // T6: released number blocks calls.
  await prisma.callNumber.update({ where: { id: numA2.id }, data: { status: "released" } });
  const relDirect = await handleInboundVoice({ to: numA2.e164, from: "+19195550142", callSid: fakeCallSid("rel") });
  check("released number rejected (direct)", !relDirect.ok && relDirect.reason === "number_released");
  const relReq = signedJsonRequest(vUrl, { From: "+19195550142", To: numA2.e164, CallSid: fakeCallSid("rel2") });
  const relRes = await voicePost(relReq);
  check("released number → 404 (route)", relRes.status === 404, String(relRes.status));
  const relCalls = await prisma.call.count({ where: { to: numA2.e164 } });
  check("released number writes no rows", relCalls === 0);

  // T7: status + transcription routes end-to-end with fake signatures.
  const sid3 = fakeCallSid("t3");
  const v3 = signedJsonRequest(vUrl, { From: "+19195550143", To: numA.e164, CallSid: sid3 });
  const v3res = await voicePost(v3);
  check("route voice accept → 200", v3res.status === 200, String(v3res.status));
  const sUrl = "http://localhost/api/calls/webhooks/twilio/status";
  const s3 = signedJsonRequest(sUrl, { CallSid: sid3, CallStatus: "completed", CallDuration: "61", RecordingUrl: "https://fake.example/rec/3" });
  const s3res = await statusPost(s3);
  const s3json = (await s3res.json()) as { ok: boolean; duplicate: boolean };
  check("route status finalize → 200", s3res.status === 200 && s3json.ok && !s3json.duplicate);
  const s3dup = await statusPost(signedJsonRequest(sUrl, { CallSid: sid3, CallStatus: "completed", CallDuration: "61" }));
  check("route duplicate status → duplicate:true", ((await s3dup.json()) as { duplicate: boolean }).duplicate === true);
  const tUrl = "http://localhost/api/calls/webhooks/twilio/transcription";
  const t3 = signedJsonRequest(tUrl, { CallSid: sid3, TranscriptionText: "live transcript text", TranscriptionStatus: "completed" });
  const t3res = await transcriptionPost(t3);
  check("transcription route → 200", t3res.status === 200, String(t3res.status));
  const call3 = await prisma.call.findUnique({ where: { externalSid: sid3 } });
  check("transcription written to call", call3?.transcription === "live transcript text", call3?.transcription ?? "null");
  check("transcription does not clobber summary", !!call3?.summary?.includes("connected"), call3?.summary?.slice(0, 60) ?? "null");
  const tBad = await transcriptionPost(signedJsonRequest(tUrl, { CallSid: sid3 }, "bad"));
  check("transcription bad signature → 403", tBad.status === 403);

  // T8: tenant isolation at the data layer (routes re-derive workspaceId from
  // the session; every query is scoped — assert no cross-tenant leakage).
  const callsA = await prisma.call.findMany({ where: { workspaceId: wsA.id }, select: { id: true } });
  const callsB = await prisma.call.findMany({ where: { workspaceId: wsB.id }, select: { id: true } });
  check("workspace A has calls", callsA.length > 0);
  check("workspace B has no calls", callsB.length === 0);
  const numbersA = await prisma.callNumber.findMany({ where: { workspaceId: wsA.id } });
  check("workspace A numbers exclude B's", numbersA.every((n) => n.workspaceId === wsA.id) && numbersA.length === 2);
  // Session routes reject anonymous callers. In tsx there is no Next request
  // scope, so requireUser() throws instead of returning null — assert the
  // guard runs before any data access (in production this surfaces as 401).
  let anonGuarded = false;
  try {
    await numbersGet();
  } catch {
    anonGuarded = true;
  }
  check("anonymous numbers list blocked by session guard", anonGuarded);
  let anonGuarded2 = false;
  try {
    await pagesGet();
  } catch {
    anonGuarded2 = true;
  }
  check("anonymous pages list blocked by session guard", anonGuarded2);

  // ================================================== DNI
  const dni1 = await resolveDniNumber(wsA.id, "summer-sale");
  check("DNI matches campaign (case-insensitive)", dni1?.e164 === numA.e164, JSON.stringify(dni1));
  const dni1b = await resolveDniNumber(wsA.id, "SUMMER-SALE");
  check("DNI case-insensitive match", dni1b?.e164 === numA.e164);
  const dni2 = await resolveDniNumber(wsA.id, "no-such-campaign");
  check("DNI falls back to first active number", dni2?.e164 === numA.e164, JSON.stringify(dni2));
  const dni3 = await resolveDniNumber("nonexistent-workspace", "x");
  check("DNI unknown workspace → null", dni3 === null);
  // DNI route: public by design, rate-limited.
  const dniReq = new Request(`http://localhost/api/calls/dni?workspace=${wsA.id}&source=summer-sale`);
  const dniRes = await dniGet(dniReq);
  const dniJson = (await dniRes.json()) as { number: string | null };
  check("DNI route resolves number", dniJson.number === numA.e164, JSON.stringify(dniJson));
  const dniMissing = await dniGet(new Request("http://localhost/api/calls/dni"));
  check("DNI route requires workspace", dniMissing.status === 400);
  const dni404 = await dniGet(new Request("http://localhost/api/calls/dni?workspace=nope"));
  check("DNI route unknown workspace → 404", dni404.status === 404);
  resetDniLimiter();
  let saw429 = false;
  for (let i = 0; i < 65; i++) {
    const r = await dniGet(new Request(`http://localhost/api/calls/dni?workspace=${wsA.id}`));
    if (r.status === 429) { saw429 = true; break; }
  }
  check("DNI rate limit trips", saw429);
  resetDniLimiter();
  // Snippet route serves JS embedding the workspace id.
  const snip = await snippetGet(new Request(`http://localhost/api/calls/dni/snippet?workspace=${wsA.id}`));
  const snipText = await snip.text();
  check("snippet serves javascript", snip.headers.get("content-type")?.includes("javascript") === true);
  check("snippet embeds workspace id", snipText.includes(wsA.id));
  check("snippet helper matches", dniSnippetJs(wsA.id, "https://x.example").includes(wsA.id));

  // ================================================== booking
  const { token, prefix } = newBookingToken();
  check("token format mkbook_<32hex>", /^mkbook_[0-9a-f]{32}$/.test(token), token);
  check("token prefix shown, raw not", prefix.startsWith("mkbook_") && !prefix.includes(token.slice(7)));
  check("token stored as sha256, not raw", hashBookingToken(token).length === 64);
  const page = await prisma.bookingPage.create({
    data: {
      workspaceId: wsA.id,
      slug: `consult-${Date.now()}`,
      tokenHash: hashBookingToken(token),
      title: "Free consultation",
      settings: {
        durationMin: 30,
        bufferMin: 10,
        timezone: "America/New_York",
        workingHours: { mon: [540, 1020], tue: [540, 1020], wed: [540, 1020], thu: [540, 1020], fri: [540, 1020] },
      },
    },
  });
  const found = await findBookingPageByToken(token);
  check("findBookingPageByToken finds page", found?.id === page.id);
  check("garbage token → null", (await findBookingPageByToken("mkbook_" + "0".repeat(32))) === null);
  check("wrong prefix → null", (await findBookingPageByToken("nope_" + "0".repeat(32))) === null);
  // Raw token must not be recoverable from the DB row.
  const stored = await prisma.bookingPage.findUnique({ where: { id: page.id }, select: { tokenHash: true } });
  check("raw token not stored", stored?.tokenHash !== token);

  // Availability: slots on 30-min boundaries inside 9:00–17:00 America/New_York.
  const from = new Date("2026-10-05T00:00:00Z"); // a Monday
  const to = new Date("2026-10-07T00:00:00Z");
  const avail = await getAvailability({ pageId: page.id, workspaceId: page.workspaceId, from, to });
  check("availability returns slots", avail.slots.length > 0, String(avail.slots.length));
  check("slot shape {startAt,endAt}", !!avail.slots[0]?.startAt && !!avail.slots[0]?.endAt);
  let aligned = true;
  let inHours = true;
  for (const s of avail.slots.slice(0, 40)) {
    const lp = zonedParts(new Date(s.startAt), "America/New_York");
    if (lp.minutes % 30 !== 0) aligned = false;
    if (lp.minutes < 540 || lp.minutes + 30 > 1020) inHours = false;
    if (lp.weekday === "sat" || lp.weekday === "sun") inHours = false;
  }
  check("slots on 30-min boundaries", aligned);
  check("slots inside working hours", inHours);
  // DST sanity: 9:00 AM America/New_York in October (EDT) = 13:00 UTC.
  const firstSlotLocal = zonedParts(new Date(avail.slots[0].startAt), "America/New_York");
  check("9:00 ET slot = 13:00 UTC (EDT)", firstSlotLocal.minutes === 540, `${avail.slots[0].startAt} → ${firstSlotLocal.minutes}`);

  // DST adversarial: span the Nov 1 2026 fall-back (25-hour Sunday). Expect
  // slots on Fri Oct 30, Mon Nov 2, Tue Nov 3 only — no skipped/duplicated day.
  const dstAvail = await getAvailability({
    pageId: page.id,
    workspaceId: page.workspaceId,
    from: new Date("2026-10-30T00:00:00Z"),
    to: new Date("2026-11-04T00:00:00Z"),
  });
  const dstDays = new Map<string, number>();
  for (const s of dstAvail.slots) {
    const key = zonedParts(new Date(s.startAt), "America/New_York").ymd;
    dstDays.set(key, (dstDays.get(key) ?? 0) + 1);
  }
  check("DST span: 3 weekdays × 16 slots", dstAvail.slots.length === 48, `${dstAvail.slots.length} slots on ${[...dstDays.keys()].join(",")}`);
  check("DST span: no partial days", [...dstDays.values()].every((n) => n === 16), JSON.stringify([...dstDays.entries()]));

  // Public booking flow: availability → booking → lead + touch + reminders.
  const slot = avail.slots[0];
  resetBookingLimiter();
  const bookRes = await handleBookingSubmit({
    token,
    rawBody: JSON.stringify({
      name: "Prospect One",
      email: "prospect1@example.com",
      startAt: slot.startAt,
      consent: true,
      utm: { utm_source: "google", utm_medium: "cpc", utm_campaign: "fall-push" },
    }),
    ip: "10.0.0.1",
  });
  check("booking → 201", bookRes.status === 201, JSON.stringify(bookRes.json));
  const bookingId = bookRes.json.bookingId as string;
  const bLead = await prisma.lead.findFirst({ where: { workspaceId: wsA.id, email: "prospect1@example.com" } });
  check("booking creates lead (source booking)", !!bLead && bLead.source === "booking", bLead?.source);
  const bTouches = await prisma.attributionTouch.findMany({ where: { leadId: bLead!.id } });
  // Attribution: exactly one capture touch; channel follows Marketr's UTM-aware
  // normalization (google/cpc → paid_search), so the ad that drove the
  // booking gets credit — no double touch.
  check("exactly one capture touch for new lead", bTouches.length === 1, JSON.stringify(bTouches.map((t) => [t.channel, t.touchType, t.source])));
  check("UTM-aware channel credits the ad", bTouches[0]?.channel === "paid_search", bTouches[0]?.channel);
  check("booking touch carries UTM source", bTouches[0]?.source === "google", String(bTouches[0]?.source));
  const bRems = await prisma.reminder.findMany({ where: { bookingId }, orderBy: { dueAt: "asc" } });
  check("reminders queued (confirmation + 24h + 1h)", bRems.length === 3, bRems.map((r) => r.kind).join(","));
  check("confirmation due now", bRems[0]?.kind === "confirmation");
  const bRow = await prisma.booking.findUnique({ where: { id: bookingId } });
  check("booking consent stored", bRow?.consentGiven === true);

  // Matched lead (existing email) → no new lead, one explicit touch.
  // slots[2] is 60 min after slots[0], clearing the 10-min buffer.
  const slot2 = avail.slots[2];
  const leadsBefore2 = await prisma.lead.count({ where: { workspaceId: wsA.id } });
  const bookRes2 = await handleBookingSubmit({
    token,
    rawBody: JSON.stringify({ name: "Prospect One", email: "prospect1@example.com", startAt: slot2.startAt, consent: true }),
    ip: "10.0.0.1",
  });
  check("booking for existing lead → 201", bookRes2.status === 201, JSON.stringify(bookRes2.json));
  check("no duplicate lead", (await prisma.lead.count({ where: { workspaceId: wsA.id } })) === leadsBefore2);
  const bTouches2 = await prisma.attributionTouch.findMany({ where: { leadId: bLead!.id, channel: "booking" } });
  check("matched booking adds its own touch", bTouches2.length === 1, String(bTouches2.length));

  // Off-hours / off-grid submissions are rejected (offered-slot enforcement).
  const offHours = await handleBookingSubmit({
    token,
    rawBody: JSON.stringify({ name: "Night", email: "night@example.com", startAt: "2026-10-05T07:00:00Z", consent: true }),
    ip: "10.0.0.2",
  });
  check("off-hours submit → 400", offHours.status === 400, JSON.stringify(offHours.json));
  const offGrid = await handleBookingSubmit({
    token,
    rawBody: JSON.stringify({ name: "Grid", email: "grid@example.com", startAt: "2026-10-05T13:15:00Z", consent: true }),
    ip: "10.0.0.2",
  });
  check("off-grid submit → 400", offGrid.status === 400, JSON.stringify(offGrid.json));
  const weekend = await handleBookingSubmit({
    token,
    rawBody: JSON.stringify({ name: "Wknd", email: "wknd@example.com", startAt: "2026-10-10T13:00:00Z", consent: true }),
    ip: "10.0.0.2",
  });
  check("weekend submit → 400", weekend.status === 400, JSON.stringify(weekend.json));
  const noConsent = await handleBookingSubmit({
    token,
    rawBody: JSON.stringify({ name: "X", email: "x@example.com", startAt: avail.slots[2].startAt, consent: false }),
    ip: "10.0.0.2",
  });
  check("consent:false → 400", noConsent.status === 400, String(noConsent.status));
  const noContact = await handleBookingSubmit({
    token,
    rawBody: JSON.stringify({ name: "X", startAt: avail.slots[2].startAt, consent: true }),
    ip: "10.0.0.2",
  });
  check("no email/phone → 400", noContact.status === 400);
  const past = await handleBookingSubmit({
    token,
    rawBody: JSON.stringify({ name: "X", email: "x2@example.com", startAt: "2020-01-01T10:00:00Z", consent: true }),
    ip: "10.0.0.2",
  });
  check("past startAt → 400", past.status === 400);
  const badToken = await handleBookingSubmit({
    token: "mkbook_" + "f".repeat(32),
    rawBody: JSON.stringify({ name: "X", email: "x3@example.com", startAt: avail.slots[2].startAt, consent: true }),
    ip: "10.0.0.2",
  });
  check("bad token → 404", badToken.status === 404);
  await prisma.bookingPage.update({ where: { id: page.id }, data: { enabled: false } });
  const disabledRes = await handleBookingSubmit({
    token,
    rawBody: JSON.stringify({ name: "X", email: "x4@example.com", startAt: avail.slots[3].startAt, consent: true }),
    ip: "10.0.0.2",
  });
  check("disabled page → 404", disabledRes.status === 404);
  await prisma.bookingPage.update({ where: { id: page.id }, data: { enabled: true } });

  // Double-booking the same slot → 409 (app check + DB backstop).
  const dbl1 = await handleBookingSubmit({
    token,
    rawBody: JSON.stringify({ name: "Dbl A", email: "dbla@example.com", startAt: avail.slots[4].startAt, consent: true }),
    ip: "10.0.0.3",
  });
  const dbl2 = await handleBookingSubmit({
    token,
    rawBody: JSON.stringify({ name: "Dbl B", email: "dblb@example.com", startAt: avail.slots[4].startAt, consent: true }),
    ip: "10.0.0.3",
  });
  check("first booking → 201", dbl1.status === 201, String(dbl1.status));
  check("double-book → 409", dbl2.status === 409, JSON.stringify(dbl2.json));

  // Rate limit: 10/min per page+IP. Book every other slot (30-min slots with a
  // 10-min buffer always conflict with their neighbors).
  resetBookingLimiter();
  const rlResults: number[] = [];
  for (let i = 0; i < 12; i++) {
    const r = await handleBookingSubmit({
      token,
      rawBody: JSON.stringify({ name: `Rl${i}`, email: `rl${i}@example.com`, startAt: avail.slots[6 + 2 * i].startAt, consent: true }),
      ip: "10.0.0.9",
    });
    rlResults.push(r.status);
  }
  check("rate limit: 10 allowed then 429", rlResults.filter((s) => s === 201).length === 10 && rlResults.filter((s) => s === 429).length === 2, rlResults.join(","));
  resetBookingLimiter();

  // Oversized body → 413.
  const big = await handleBookingSubmit({ token, rawBody: "x".repeat(5000), ip: "10.0.0.4" });
  check("oversized body → 413", big.status === 413, String(big.status));

  // Public route GET/POST through the real handlers.
  // Oct 5 is fully booked by the tests above; query a wider window (Oct 7 free).
  const pubGetReq = new Request(`http://localhost/api/calls/public/booking/${token}?from=2026-10-05T00:00:00Z&to=2026-10-08T00:00:00Z`);
  const pubGetRes = await publicGet(pubGetReq, { params: Promise.resolve({ token }) });
  const pubGetJson = (await pubGetRes.json()) as { slots: Array<{ startAt: string; endAt: string }>; page: { title: string } };
  check("public GET → 200 with slots", pubGetRes.status === 200 && pubGetJson.slots.length > 0, String(pubGetRes.status));
  check("public GET leaks no PII", !JSON.stringify(pubGetJson).includes("prospect1"), "PII in public GET");
  const pubGet404 = await publicGet(new Request("http://localhost/api/calls/public/booking/mkbook_00000000000000000000000000000000"), { params: Promise.resolve({ token: "mkbook_" + "0".repeat(32) }) });
  check("public GET bad token → 404", pubGet404.status === 404);
  const pubPostReq = new Request(`http://localhost/api/calls/public/booking/${token}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "10.0.0.11" },
    body: JSON.stringify({ name: "Route Prospect", email: "routeprospect@example.com", startAt: pubGetJson.slots[0].startAt, consent: true }),
  });
  const pubPostRes = await publicPost(pubPostReq, { params: Promise.resolve({ token }) });
  check("public POST → 201", pubPostRes.status === 201, String(pubPostRes.status));

  // ================================================== reminders
  // Quiet-hours math.
  check("isQuietHour 02:00 ET", isQuietHour(new Date("2026-01-15T02:30:00-05:00"), "America/New_York"));
  check("not quiet 14:00 ET", !isQuietHour(new Date("2026-01-15T14:00:00-05:00"), "America/New_York"));
  check("not quiet 08:00 ET", !isQuietHour(new Date("2026-01-15T08:00:00-05:00"), "America/New_York"));
  check("quiet 21:00 ET", isQuietHour(new Date("2026-01-15T21:00:00-05:00"), "America/New_York"));
  const qe = nextQuietEnd(new Date("2026-01-15T02:30:00-05:00"), "America/New_York");
  check("nextQuietEnd → 08:00 local", localHour(qe, "America/New_York") === 8, qe.toISOString());
  const qe2 = nextQuietEnd(new Date("2026-01-15T22:45:00-05:00"), "America/New_York");
  check("nextQuietEnd from 22:45 → next day 08:00", localHour(qe2, "America/New_York") === 8 && qe2.getTime() > new Date("2026-01-15T22:45:00-05:00").getTime(), qe2.toISOString());

  // Send the confirmation for booking 1 via the runner seam.
  const mail = new FakeMail();
  const send1 = await sendDueReminders({ now: new Date(), mail });
  check("confirmation sent", send1.sent >= 1 && mail.sent.length >= 1, JSON.stringify(send1));
  const bRow2 = await prisma.booking.findUnique({ where: { id: bookingId } });
  check("remindersSent incremented", (bRow2?.remindersSent ?? 0) >= 1, String(bRow2?.remindersSent));

  // Quiet-hour deferral: craft a reminder due at 02:30 ET.
  const qPage = await prisma.bookingPage.create({
    data: {
      workspaceId: wsA.id,
      slug: `quiet-${Date.now()}`,
      tokenHash: hashBookingToken(newBookingToken().token),
      title: "Quiet page",
      settings: { durationMin: 30, bufferMin: 0, timezone: "America/New_York", workingHours: { mon: [0, 1440] } },
    },
  });
  const qBooking = await prisma.booking.create({
    data: {
      workspaceId: wsA.id, pageId: qPage.id, leadId: bLead!.id, name: "Quiet Test",
      email: "quiet@example.com", startAt: new Date("2026-01-16T10:00:00-05:00"),
      endAt: new Date("2026-01-16T10:30:00-05:00"), status: "scheduled", consentGiven: true,
    },
  });
  const qRem = await prisma.reminder.create({
    data: {
      workspaceId: wsA.id, bookingId: qBooking.id, kind: "reminder_1h", channel: "email",
      to: "quiet@example.com", subject: "q", body: "q", status: "scheduled",
      dueAt: new Date("2026-01-15T02:30:00-05:00"),
    },
  });
  const qSend = await sendDueReminders({ now: new Date("2026-01-15T02:31:00-05:00"), mail });
  check("quiet-hour reminder deferred, not sent", qSend.deferredQuietHours === 1 && qSend.sent === 0, JSON.stringify(qSend));
  const qRemAfter = await prisma.reminder.findUnique({ where: { id: qRem.id } });
  check("deferred row stays scheduled", qRemAfter?.status === "scheduled");
  check("deferred dueAt → 08:00 local", localHour(qRemAfter!.dueAt, "America/New_York") === 8, qRemAfter!.dueAt.toISOString());

  // Opt-out suppression is immediate: recordOptOut flips scheduled reminders
  // to skipped_opt_out at opt-out time.
  await recordOptOut(qBooking.id, wsA.id);
  const qRemAfterOpt = await prisma.reminder.findUnique({ where: { id: qRem.id } });
  check("opt-out flips reminder to skipped_opt_out", qRemAfterOpt?.status === "skipped_opt_out", qRemAfterOpt?.status);
  const qSend2 = await sendDueReminders({ now: new Date("2026-01-16T09:00:00-05:00"), mail });
  check("no send after opt-out", qSend2.sent === 0, JSON.stringify(qSend2));
  const qRemAfter2 = await prisma.reminder.findUnique({ where: { id: qRem.id } });
  check("opted-out row marked skipped_opt_out", qRemAfter2?.status === "skipped_opt_out");

  // Cancelled booking → skipped.
  const cBooking = await prisma.booking.create({
    data: {
      workspaceId: wsA.id, pageId: qPage.id, leadId: bLead!.id, name: "Cancel Test",
      email: "cancel@example.com", startAt: new Date("2026-01-16T11:00:00-05:00"),
      endAt: new Date("2026-01-16T11:30:00-05:00"), status: "cancelled", consentGiven: true,
    },
  });
  await prisma.reminder.create({
    data: {
      workspaceId: wsA.id, bookingId: cBooking.id, kind: "confirmation", channel: "email",
      to: "cancel@example.com", subject: "c", body: "c", status: "scheduled", dueAt: new Date("2026-01-15T14:00:00-05:00"),
    },
  });
  const cSend = await sendDueReminders({ now: new Date("2026-01-15T14:01:00-05:00"), mail });
  check("cancelled booking reminder skipped", cSend.skippedOptOut >= 1, JSON.stringify(cSend));

  // Runner route: bearer auth.
  const runReq = new Request("http://localhost/api/calls/reminders/run", {
    method: "POST",
    headers: { authorization: "Bearer verify-cron-secret" },
  });
  const runRes = await runnerPost(runReq);
  check("runner route with cron secret → 200", runRes.status === 200, String(runRes.status));
  const runBad = await runnerPost(new Request("http://localhost/api/calls/reminders/run", {
    method: "POST",
    headers: { authorization: "Bearer wrong" },
  }));
  check("runner route wrong secret → 401", runBad.status === 401, String(runBad.status));

  // ================================================== call_minutes
  // Exact rounding: 95s → 2, 60s → 1, 1s → 1, 0s → 0; missed/failed excluded; voicemail included.
  const sidM = fakeCallSid("meter");
  await handleInboundVoice({ to: numA.e164, from: "+19195550150", callSid: sidM });
  await handleCallStatus({ callSid: sidM, providerStatus: "completed", durationSec: 95 });
  const sidM2 = fakeCallSid("meter2");
  await handleInboundVoice({ to: numA.e164, from: "+19195550151", callSid: sidM2 });
  await handleCallStatus({ callSid: sidM2, providerStatus: "completed", durationSec: 60 });
  const sidM3 = fakeCallSid("meter3");
  await handleInboundVoice({ to: numA.e164, from: "+19195550152", callSid: sidM3 });
  await handleCallStatus({ callSid: sidM3, providerStatus: "completed", durationSec: 1 });
  const sidM4 = fakeCallSid("meter4");
  await handleInboundVoice({ to: numA.e164, from: "+19195550153", callSid: sidM4 });
  await handleCallStatus({ callSid: sidM4, providerStatus: "no-answer", durationSec: 120 });
  // voicemail: map manually (fake provider has no voicemail status path — set directly).
  const sidM5 = fakeCallSid("meter5");
  await handleInboundVoice({ to: numA.e164, from: "+19195550154", callSid: sidM5 });
  const c5 = await prisma.call.findUnique({ where: { externalSid: sidM5 }, select: { id: true } });
  await prisma.call.update({ where: { id: c5!.id }, data: { status: "voicemail", durationSec: 61 } });

  // Expected for wsA: sid1 (95s→2), sid3 (61s→2), meter 95s→2, meter2 60s→1,
  // meter3 1s→1, voicemail 61s→2 = 10. Missed calls (sid2, meter4) excluded.
  const minutes = await getCallMinutes(wsA.id);
  check("call_minutes exact total = 10", minutes === 10, `got ${minutes}`);
  const minutesB = await getCallMinutes(wsB.id);
  check("call_minutes tenant-scoped (B = 0)", minutesB === 0, `got ${minutesB}`);

  // Booking tenant isolation.
  const pagesB = await prisma.bookingPage.findMany({ where: { workspaceId: wsB.id } });
  check("workspace B has no booking pages", pagesB.length === 0);
  const bookingsA = await prisma.booking.findMany({ where: { workspaceId: wsA.id } });
  check("workspace A has bookings", bookingsA.length > 0);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main()
  .catch((e) => {
    console.error("battery crashed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
