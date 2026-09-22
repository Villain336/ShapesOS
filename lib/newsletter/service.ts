// Marketr — newsletter service (milestone 19).
//
// Prisma-backed orchestration for templates, lists, subscribers, domains,
// and broadcast delivery. Pure rendering/guardrail logic lives in
// ./blocks.ts and ./render.tsx; Resend I/O goes through the injected
// ResendPort (real SDK in production, MockResendPort in tests).

import type { Prisma, PrismaClient } from "@prisma/client";
import { secrets } from "@/lib/secrets";
import { emitAlert } from "@/lib/alerts/evaluate";
import { parseCsv } from "@/lib/seo/programmatic";
import {
  brandFromKit,
  checkBroadcastGuardrails,
  docWordCount,
  isValidEmail,
  mapSubscriberColumns,
  normalizeDoc,
  parseSubscriberCsv,
  unsubscribeUrlFor,
  type EmailTiptapDoc,
  type NewsletterBrand,
} from "./blocks";
import { renderNewsletter } from "./render";
import { STARTER_TEMPLATES } from "./starters";
import type { BatchEmail, ResendPort } from "./resend";

type Db = PrismaClient;

/** Absolute app URL for unsubscribe links and asset URLs. */
export function appBaseUrl(): string {
  return (
    (process.env.MARKETR_BASE_URL ?? "").trim().replace(/\/$/, "") ||
    (process.env.NEXTAUTH_URL ?? "").trim().replace(/\/$/, "") ||
    "http://localhost:3000"
  );
}

type AuditAction =
  | "newsletter_template_created"
  | "newsletter_template_updated"
  | "newsletter_template_deleted"
  | "newsletter_list_created"
  | "newsletter_list_deleted"
  | "newsletter_subscribers_imported"
  | "newsletter_subscriber_unsubscribed"
  | "newsletter_domain_added"
  | "newsletter_domain_verified"
  | "newsletter_test_sent"
  | "newsletter_broadcast_created"
  | "newsletter_broadcast_scheduled"
  | "newsletter_broadcast_sent"
  | "newsletter_broadcast_failed"
  | "newsletter_broadcast_cancelled"
  | "newsletter_resend_key_updated";

/** Shared audit helper — every newsletter mutation is audit-logged. */
export async function auditNewsletter(
  db: Db,
  workspaceId: string,
  projectId: string | null,
  action: AuditAction,
  summary: string,
  actor: "user" | "system" = "user",
): Promise<void> {
  await db.fileChangeLog.create({
    data: {
      workspaceId,
      projectId: projectId ?? "",
      connectionId: null,
      filePath: "",
      actor,
      action,
      summary: summary.slice(0, 280),
    },
  });
}

// ---------------------------------------------------------------------------
// Settings — BYO Resend key (encrypted, never returned to clients)
// ---------------------------------------------------------------------------

export async function getSettings(db: Db, workspaceId: string) {
  return db.newsletterSettings.upsert({
    where: { workspaceId },
    update: {},
    create: { workspaceId },
  });
}

/** Store/rotate the workspace Resend key. Returns only the hint. */
export async function setResendKey(
  db: Db,
  workspaceId: string,
  apiKey: string,
  actor: "user" | "system" = "user",
): Promise<{ hint: string }> {
  const key = apiKey.trim();
  if (!/^re_[A-Za-z0-9_-]{10,}$/.test(key)) {
    throw new Error("That doesn't look like a Resend API key (expected re_…).");
  }
  const hint = secrets().hint(key);
  await db.newsletterSettings.upsert({
    where: { workspaceId },
    update: { resendKeyEnc: secrets().encrypt(key), resendKeyHint: hint },
    create: { workspaceId, resendKeyEnc: secrets().encrypt(key), resendKeyHint: hint },
  });
  await auditNewsletter(db, workspaceId, null, "newsletter_resend_key_updated", `Resend API key updated (${hint}).`, actor);
  return { hint };
}

/** Build a live Resend port from the workspace's decrypted key, or null. */
export async function getResendPort(
  db: Db,
  workspaceId: string,
  factory: (apiKey: string) => ResendPort,
): Promise<ResendPort | null> {
  const settings = await db.newsletterSettings.findUnique({ where: { workspaceId } });
  if (!settings?.resendKeyEnc) return null;
  return factory(secrets().decrypt(settings.resendKeyEnc));
}

// ---------------------------------------------------------------------------
// Sending domains — SPF/DKIM/DMARC setup wizard backend
// ---------------------------------------------------------------------------

export async function addDomain(
  db: Db,
  workspaceId: string,
  domain: string,
  port: ResendPort,
  actor: "user" | "system" = "user",
) {
  const clean = domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(clean)) {
    throw new Error("Invalid domain name.");
  }
  const existing = await db.newsletterDomain.findUnique({ where: { workspaceId_domain: { workspaceId, domain: clean } } });
  if (existing) throw new Error("This domain is already set up.");
  const created = await port.createDomain(clean);
  const row = await db.newsletterDomain.create({
    data: {
      workspaceId,
      domain: clean,
      resendDomainId: created.id,
      status: "pending",
      dnsRecords: created.records as unknown as Prisma.InputJsonValue,
    },
  });
  await auditNewsletter(db, workspaceId, null, "newsletter_domain_added", `Sending domain added: ${clean}.`, actor);
  return row;
}

/** Re-check verification with Resend; flips to verified when confirmed. */
export async function refreshDomain(
  db: Db,
  domainId: string,
  port: ResendPort,
  actor: "user" | "system" = "user",
) {
  const row = await db.newsletterDomain.findUnique({ where: { id: domainId } });
  if (!row || !row.resendDomainId) throw new Error("Domain not found.");
  // Ask Resend to re-check DNS first (its verify endpoint returns no status),
  // then read the current status via getDomain.
  await port.verifyDomain(row.resendDomainId);
  const live = await port.getDomain(row.resendDomainId);
  const status = live.status === "verified" ? "verified" : live.status === "failed" ? "failed" : "pending";
  const updated = await db.newsletterDomain.update({
    where: { id: domainId },
    data: { status, dnsRecords: live.records as unknown as Prisma.InputJsonValue, verifiedAt: status === "verified" ? new Date() : row.verifiedAt },
  });
  if (status === "verified" && row.status !== "verified") {
    await auditNewsletter(db, row.workspaceId, null, "newsletter_domain_verified", `Sending domain verified: ${row.domain}.`, actor);
  }
  return updated;
}

/** Throw unless the domain exists and is verified (server-side gate). */
export async function requireVerifiedDomain(db: Db, domainId: string, workspaceId: string) {
  const row = await db.newsletterDomain.findFirst({ where: { id: domainId, workspaceId } });
  if (!row) throw new Error("Sending domain not found.");
  if (row.status !== "verified") throw new Error(`Domain ${row.domain} is not verified — finish the DNS setup first.`);
  return row;
}

// ---------------------------------------------------------------------------
// Lists & subscribers
// ---------------------------------------------------------------------------

export async function createList(
  db: Db,
  projectId: string,
  workspaceId: string,
  name: string,
  doubleOptIn: boolean,
  port: ResendPort | null,
  actor: "user" | "system" = "user",
) {
  const clean = name.trim();
  if (!clean) throw new Error("List name is required.");
  let resendAudienceId: string | null = null;
  if (port) {
    try {
      resendAudienceId = (await port.createSegment(`Marketr · ${clean}`)).id;
    } catch {
      // Segment creation is best-effort here; import/send will retry.
      resendAudienceId = null;
    }
  }
  const list = await db.newsletterList.create({
    data: { projectId, name: clean, doubleOptIn, resendAudienceId },
  });
  await auditNewsletter(db, workspaceId, projectId, "newsletter_list_created", `Subscriber list created: ${clean}.`, actor);
  return list;
}

export async function deleteList(db: Db, listId: string, workspaceId: string, projectId: string, port: ResendPort | null) {
  const list = await db.newsletterList.findFirst({
    where: { id: listId, projectId },
    include: { _count: { select: { broadcasts: true } } },
  });
  if (!list) throw new Error("List not found.");
  if (list._count.broadcasts > 0) throw new Error("List has broadcasts — it can't be deleted (history is preserved).");
  if (port && list.resendAudienceId) {
    try { await port.removeSegment(list.resendAudienceId); } catch { /* best effort */ }
  }
  await db.newsletterList.delete({ where: { id: listId } });
  await auditNewsletter(db, workspaceId, projectId, "newsletter_list_deleted", `Subscriber list deleted: ${list.name}.`);
}

export interface ImportOutcome {
  imported: number;
  skipped: number;
  errors: { row: number; message: string }[];
}

/**
 * CSV subscriber import. `csvText` is parsed with the shared M17 parser;
 * columns are mapped via mapSubscriberColumns(). Contacts are pushed to the
 * Resend segment in batches (rate-limit aware). Existing emails are skipped.
 */
export async function importSubscribers(
  db: Db,
  listId: string,
  workspaceId: string,
  projectId: string,
  csvText: string,
  port: ResendPort | null,
  actor: "user" | "system" = "user",
): Promise<ImportOutcome> {
  const list = await db.newsletterList.findFirst({ where: { id: listId, projectId } });
  if (!list) throw new Error("List not found.");

  const parsed = parseCsv(csvText);
  if (!parsed.columns.length) throw new Error("CSV has no header row.");
  const mapping = mapSubscriberColumns(parsed.columns);
  if (!mapping) throw new Error('CSV needs an "email" column (optional "name" column).');

  const rows = parsed.rows.map((values, i) => {
    const rec: Record<string, string> = {};
    if (mapping.email) rec.email = values[mapping.email] ?? "";
    if (mapping.name) rec.name = values[mapping.name] ?? "";
    return { row: i + 2, values: rec };
  });
  const { valid, errors } = parseSubscriberCsv(rows);

  const existing = await db.subscriber.findMany({ where: { listId }, select: { email: true } });
  const seen = new Set(existing.map((s) => s.email.toLowerCase()));

  let segmentId = list.resendAudienceId;
  if (port && !segmentId && valid.length) {
    segmentId = (await port.createSegment(`Marketr · ${list.name}`)).id;
    await db.newsletterList.update({ where: { id: listId }, data: { resendAudienceId: segmentId } });
  }

  let imported = 0;
  let skipped = 0;
  const importErrors = [...errors];
  const BATCH = 50;
  for (let i = 0; i < valid.length; i += BATCH) {
    const chunk = valid.slice(i, i + BATCH);
    for (const row of chunk) {
      if (seen.has(row.email)) {
        skipped += 1;
        continue;
      }
      seen.add(row.email);
      try {
        await db.subscriber.create({
          data: { listId, email: row.email, name: row.name, status: "subscribed" },
        });
        imported += 1;
        if (port && segmentId) {
          const [firstName, ...rest] = (row.name ?? "").split(" ");
          await port.createContact(segmentId, {
            email: row.email,
            firstName: firstName || undefined,
            lastName: rest.join(" ") || undefined,
          });
        }
      } catch (err) {
        importErrors.push({ row: row.row, message: err instanceof Error ? err.message : "Insert failed." });
      }
    }
    // Rate-limit courtesy between chunks.
    if (port && i + BATCH < valid.length) await new Promise((r) => setTimeout(r, 400));
  }

  await auditNewsletter(
    db, workspaceId, projectId, "newsletter_subscribers_imported",
    `Imported ${imported} subscribers into "${list.name}" (${skipped} skipped, ${importErrors.length} errors).`,
    actor,
  );
  return { imported, skipped, errors: importErrors };
}

/** Public unsubscribe by token (no auth — the token is the capability). */
export async function unsubscribeByToken(db: Db, token: string) {
  const sub = await db.subscriber.findUnique({
    where: { token },
    include: { list: { select: { id: true, name: true, projectId: true, resendAudienceId: true, project: { select: { workspaceId: true } } } } },
  });
  if (!sub) return null;
  if (sub.status !== "unsubscribed") {
    await db.subscriber.update({ where: { id: sub.id }, data: { status: "unsubscribed" } });
    await auditNewsletter(
      db, sub.list.project.workspaceId, sub.list.projectId,
      "newsletter_subscriber_unsubscribed", `Unsubscribed ${sub.email} from "${sub.list.name}".`, "system",
    );
  }
  return { email: sub.email, listName: sub.list.name, already: sub.status === "unsubscribed" };
}

export async function subscriberCount(db: Db, listId: string): Promise<number> {
  return db.subscriber.count({ where: { listId, status: "subscribed" } });
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export async function createTemplate(
  db: Db, projectId: string, workspaceId: string,
  name: string, tiptap: unknown, brandKitId: string | null,
  actor: "user" | "system" = "user",
) {
  const doc = normalizeDoc(tiptap);
  if (!doc.content.length) throw new Error("Template needs at least one block.");
  const row = await db.newsletterTemplate.create({
    data: { projectId, name: name.trim() || "Untitled", tiptap: doc as unknown as Prisma.InputJsonValue, brandKitId },
  });
  await auditNewsletter(db, workspaceId, projectId, "newsletter_template_created", `Newsletter template created: ${row.name}.`, actor);
  return row;
}

export async function updateTemplate(
  db: Db, templateId: string, projectId: string, workspaceId: string,
  patch: { name?: string; tiptap?: unknown; brandKitId?: string | null },
) {
  const data: { name?: string; tiptap?: Prisma.InputJsonValue; brandKitId?: string | null } = {};
  if (patch.name !== undefined) data.name = patch.name.trim() || "Untitled";
  if (patch.tiptap !== undefined) {
    const doc = normalizeDoc(patch.tiptap);
    if (!doc.content.length) throw new Error("Template needs at least one block.");
    data.tiptap = doc as unknown as Prisma.InputJsonValue;
  }
  if (patch.brandKitId !== undefined) data.brandKitId = patch.brandKitId;
  const row = await db.newsletterTemplate.update({ where: { id: templateId, projectId }, data });
  await auditNewsletter(db, workspaceId, projectId, "newsletter_template_updated", `Newsletter template updated: ${row.name}.`);
  return row;
}

export async function deleteTemplate(db: Db, templateId: string, projectId: string, workspaceId: string) {
  const row = await db.newsletterTemplate.findFirst({ where: { id: templateId, projectId } });
  if (!row) throw new Error("Template not found.");
  await db.newsletterTemplate.delete({ where: { id: templateId } });
  await auditNewsletter(db, workspaceId, projectId, "newsletter_template_deleted", `Newsletter template deleted: ${row.name}.`);
}

/** Seed the three starter templates once per project. */
export async function seedStarterTemplates(db: Db, projectId: string, workspaceId: string) {
  const count = await db.newsletterTemplate.count({ where: { projectId } });
  if (count > 0) return 0;
  for (const s of STARTER_TEMPLATES) {
    await db.newsletterTemplate.create({
      data: { projectId, name: s.name, tiptap: s.doc as unknown as Prisma.InputJsonValue, isStarter: true },
    });
  }
  await auditNewsletter(db, workspaceId, projectId, "newsletter_template_created", "Starter newsletter templates seeded.", "system");
  return STARTER_TEMPLATES.length;
}

// ---------------------------------------------------------------------------
// Broadcasts
// ---------------------------------------------------------------------------

async function resolveBrand(db: Db, brandKitId: string | null, workspaceId: string): Promise<NewsletterBrand> {
  if (brandKitId) {
    const kit = await db.brandKit.findFirst({ where: { id: brandKitId, workspaceId } });
    if (kit) return brandFromKit({ colors: kit.colors, fonts: kit.fonts, logoPath: kit.logoPath, name: kit.name });
  }
  return brandFromKit({});
}

export async function createBroadcast(
  db: Db, projectId: string, workspaceId: string,
  args: {
    subject: string; listId: string; domainId: string;
    templateId?: string; tiptap?: unknown; brandKitId?: string | null;
    scheduledAt?: string | null;
  },
  actor: "user" | "system" = "user",
) {
  const subject = args.subject.trim();
  if (!subject) throw new Error("Subject is required.");
  const list = await db.newsletterList.findFirst({ where: { id: args.listId, projectId } });
  if (!list) throw new Error("List not found.");
  const domain = await db.newsletterDomain.findFirst({ where: { id: args.domainId, workspaceId } });
  if (!domain) throw new Error("Sending domain not found.");

  let snapshot: EmailTiptapDoc;
  let brandKitId: string | null = args.brandKitId ?? null;
  if (args.templateId) {
    const tpl = await db.newsletterTemplate.findFirst({ where: { id: args.templateId, projectId } });
    if (!tpl) throw new Error("Template not found.");
    snapshot = normalizeDoc(tpl.tiptap);
    if (!brandKitId) brandKitId = tpl.brandKitId;
  } else if (args.tiptap) {
    snapshot = normalizeDoc(args.tiptap);
  } else {
    throw new Error("Provide a template or editor content.");
  }
  if (!snapshot.content.length) throw new Error("Broadcast content is empty.");

  const broadcast = await db.newsletterBroadcast.create({
    data: {
      projectId,
      listId: list.id,
      domainId: domain.id,
      subject,
      templateSnapshot: snapshot as unknown as Prisma.InputJsonValue,
      brandKitId,
      status: args.scheduledAt ? "scheduled" : "draft",
      scheduledAt: args.scheduledAt ? new Date(args.scheduledAt) : null,
    },
  });
  await auditNewsletter(
    db, workspaceId, projectId,
    args.scheduledAt ? "newsletter_broadcast_scheduled" : "newsletter_broadcast_created",
    `Broadcast "${subject}" ${args.scheduledAt ? `scheduled for ${args.scheduledAt}` : "drafted"} → list "${list.name}".`,
    actor,
  );
  return broadcast;
}

/** Render a broadcast to final HTML (shared by preview, test send, send). */
export async function renderBroadcast(
  db: Db, broadcastId: string, workspaceId: string,
  opts: { unsubscribeToken?: string; previewText?: string } = {},
): Promise<{ html: string; subject: string; words: number }> {
  const b = await db.newsletterBroadcast.findUnique({ where: { id: broadcastId } });
  if (!b) throw new Error("Broadcast not found.");
  const doc = normalizeDoc(b.templateSnapshot);
  const brand = await resolveBrand(db, b.brandKitId, workspaceId);
  const html = await renderNewsletter(doc, {
    brand,
    baseUrl: appBaseUrl(),
    unsubscribeToken: opts.unsubscribeToken,
    previewText: opts.previewText ?? b.subject,
  });
  return { html, subject: b.subject, words: docWordCount(doc) };
}

/** Guardrail: test-send to yourself before any broadcast. */
export async function testSend(
  db: Db, broadcastId: string, workspaceId: string, projectId: string,
  to: string, port: ResendPort,
  actor: "user" | "system" = "user",
) {
  const clean = to.trim().toLowerCase();
  if (!isValidEmail(clean)) throw new Error("Enter a valid test recipient email.");
  const b = await db.newsletterBroadcast.findFirst({
    where: { id: broadcastId, projectId },
    include: { domain: true },
  });
  if (!b) throw new Error("Broadcast not found.");
  // Sending from an unverified domain is blocked server-side, including tests.
  await requireVerifiedDomain(db, b.domainId, workspaceId);
  const fromName = (await db.newsletterSettings.findUnique({ where: { workspaceId } }))?.defaultFromName;
  const from = fromName ? `${fromName} <newsletter@${b.domain.domain}>` : `newsletter@${b.domain.domain}`;
  const { html, subject } = await renderBroadcast(db, broadcastId, workspaceId, { unsubscribeToken: "test" });
  const htmlWithBanner = html.replace(
    "<body",
    `<body data-marketr-test="true"`,
  );
  await port.sendEmail({ from, to: clean, subject: `[TEST] ${subject}`, html: htmlWithBanner });
  await db.newsletterBroadcast.update({
    where: { id: broadcastId },
    data: { testSentAt: new Date(), testSentTo: clean },
  });
  await auditNewsletter(db, workspaceId, projectId, "newsletter_test_sent", `Test send for "${b.subject}" → ${clean}.`, actor);
}

/** Build the From header for a broadcast. */
async function fromHeader(db: Db, workspaceId: string, domain: string): Promise<string> {
  const name = (await db.newsletterSettings.findUnique({ where: { workspaceId } }))?.defaultFromName?.trim();
  return name ? `${name} <newsletter@${domain}>` : `newsletter@${domain}`;
}

function oneClickHeaders(baseUrl: string, token: string): Record<string, string> {
  const url = unsubscribeUrlFor(baseUrl, token);
  return {
    "List-Unsubscribe": `<${url}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}

async function alertBroadcastFailed(args: {
  workspaceId: string; projectId: string; subject: string; error: string;
}) {
  try {
    await emitAlert({
      workspaceId: args.workspaceId,
      projectId: args.projectId,
      trigger: "newsletter_broadcast_failed",
      severity: "critical",
      title: `Newsletter broadcast failed: ${args.subject}`,
      body: args.error,
      link: `/dashboard/projects/${args.projectId}/newsletter`,
      dedupKey: `newsletter_broadcast_failed:${args.projectId}:${Date.now()}`,
    });
  } catch {
    // alert failures never break the send path
  }
}

/**
 * Send a broadcast. Guardrails (verified domain, test send, ≥1 subscriber,
 * unsubscribe link) are enforced server-side; failures are audit-logged and
 * fire an M13 alert.
 */
export async function sendBroadcast(
  db: Db, broadcastId: string, workspaceId: string, projectId: string,
  port: ResendPort,
  actor: "user" | "system" = "user",
): Promise<{ sent: number }> {
  const b = await db.newsletterBroadcast.findFirst({
    where: { id: broadcastId, projectId },
    include: { list: true, domain: true },
  });
  if (!b) throw new Error("Broadcast not found.");
  if (b.status === "sent") throw new Error("Broadcast already sent.");
  if (b.status === "sending") throw new Error("Broadcast is already sending.");

  const fail = async (message: string) => {
    await db.newsletterBroadcast.update({ where: { id: broadcastId }, data: { status: "failed", error: message } });
    await auditNewsletter(db, workspaceId, projectId, "newsletter_broadcast_failed", `Broadcast "${b.subject}" failed: ${message}`, actor);
    await alertBroadcastFailed({ workspaceId, projectId, subject: b.subject, error: message });
    throw new Error(message);
  };

  // Server-side guardrails — no broadcast without all four.
  const count = await subscriberCount(db, b.listId);
  const doc = normalizeDoc(b.templateSnapshot);
  const guard = checkBroadcastGuardrails({
    domainStatus: b.domain.status,
    testSentAt: b.testSentAt,
    subscriberCount: count,
    doc,
    unsubscribeUrl: unsubscribeUrlFor(appBaseUrl(), "guardrail-check"),
  });
  if (!guard.ok) return fail(guard.failures.join(" "));

  await db.newsletterBroadcast.update({ where: { id: broadcastId }, data: { status: "sending", error: null } });

  try {
    const brand = await resolveBrand(db, b.brandKitId, workspaceId);
    const from = await fromHeader(db, workspaceId, b.domain.domain);
    const base = appBaseUrl();
    const recipients = await db.subscriber.findMany({
      where: { listId: b.listId, status: "subscribed" },
      select: { email: true, token: true },
      orderBy: { createdAt: "asc" },
    });
    // Per-recipient render (tokenized unsubscribe link) in batches.
    const emails: BatchEmail[] = [];
    for (const r of recipients) {
      const html = await renderNewsletter(doc, { brand, baseUrl: base, unsubscribeToken: r.token, previewText: b.subject });
      emails.push({
        from, to: r.email, subject: b.subject, html,
        headers: oneClickHeaders(base, r.token),
      });
    }
    const { ids } = await port.sendBatch(emails);
    await db.newsletterBroadcast.update({
      where: { id: broadcastId },
      data: {
        status: "sent",
        resendBroadcastId: ids[0] ?? null,
        stats: { sent: recipients.length, messageIds: ids.length, sentAt: new Date().toISOString() } as unknown as Prisma.InputJsonValue,
      },
    });
    await auditNewsletter(db, workspaceId, projectId, "newsletter_broadcast_sent", `Broadcast "${b.subject}" sent to ${recipients.length} recipients.`, actor);
    return { sent: recipients.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Send failed.";
    return fail(message);
  }
}

/** Cron: send due scheduled broadcasts (guardrails still apply). */
export async function runDueBroadcasts(
  db: Db,
  makePort: (workspaceId: string) => Promise<ResendPort | null>,
  workspaceId?: string,
): Promise<{ checked: number; sent: number; failed: number }> {
  const now = new Date();
  const due = await db.newsletterBroadcast.findMany({
    where: {
      status: "scheduled",
      scheduledAt: { lte: now },
      ...(workspaceId ? { project: { workspaceId } } : {}),
    },
    include: { project: { select: { workspaceId: true } } },
    orderBy: { scheduledAt: "asc" },
    take: 25,
  });
  let sent = 0;
  let failed = 0;
  for (const b of due) {
    const port = await makePort(b.project.workspaceId);
    if (!port) {
      await db.newsletterBroadcast.update({
        where: { id: b.id },
        data: { status: "failed", error: "No Resend API key configured for this workspace." },
      });
      failed += 1;
      continue;
    }
    try {
      await sendBroadcast(db, b.id, b.project.workspaceId, b.projectId, port, "system");
      sent += 1;
    } catch {
      failed += 1;
    }
  }
  return { checked: due.length, sent, failed };
}

/** Cancel a draft/scheduled broadcast. */
export async function cancelBroadcast(db: Db, broadcastId: string, workspaceId: string, projectId: string) {
  const b = await db.newsletterBroadcast.findFirst({ where: { id: broadcastId, projectId } });
  if (!b) throw new Error("Broadcast not found.");
  if (b.status === "sent" || b.status === "sending") throw new Error("Cannot cancel a broadcast that is sending or sent.");
  await db.newsletterBroadcast.update({ where: { id: broadcastId }, data: { status: "cancelled" } });
  await auditNewsletter(db, workspaceId, projectId, "newsletter_broadcast_cancelled", `Broadcast "${b.subject}" cancelled.`);
}

/**
 * Resend webhook handler: email.bounced / email.complained →
 * subscriber status update. Matches by recipient email across the
 * workspace's lists (event payloads carry no workspace id).
 */
export async function handleResendWebhook(
  db: Db,
  event: { type?: string; data?: { to?: string[]; email?: string; bounce?: unknown; complaint?: unknown } },
): Promise<{ handled: boolean; updated: number }> {
  const type = event.type ?? "";
  if (type !== "email.bounced" && type !== "email.complained") return { handled: false, updated: 0 };
  const emails = [...(event.data?.to ?? [])];
  if (event.data?.email) emails.push(event.data.email);
  const status = type === "email.bounced" ? "bounced" : "complained";
  let updated = 0;
  for (const raw of emails) {
    const email = raw.trim().toLowerCase();
    if (!email) continue;
    const res = await db.subscriber.updateMany({ where: { email, status: "subscribed" }, data: { status } });
    updated += res.count;
  }
  return { handled: true, updated };
}
