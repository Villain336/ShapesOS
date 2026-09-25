// Marketr — Phase 4 T2 (Creative Studio) verification battery.
//
// Run: DATABASE_URL=<redacted> npx tsx scripts/verify-phase4-studio.mts
// Run 3x green before calling this done.
//
// Covers:
//   A. Format validation matrix (pure): 4x6 ok for addressed; 4x6 REJECTED
//      for EDDM; oversized flat rejected; undersized flat rejected; in-range
//      EDDM flat accepted; #10 letter accepted; non-PDF rejected; page-count
//      violations rejected; bleed-sized PDF warns (not fails).
//   B. Hash determinism: same bytes -> same SHA-256; different bytes differ.
//   C. Versioning + lifecycle on a fresh DB: new row per version, prior row
//      archived, ready rows immutable, mark-ready gating (passing validation
//      + §7 no-government-impersonation attestation), attestation persisted.
//   D. Channel-template extensibility: email/social creatives creatable as
//      drafts; validation is a no-op info note; mark-ready gated until their
//      tracks are defined.
//   E. Tenant isolation: workspace B sees nothing of workspace A.
//   F. Canva flows against the MOCK port only: brand-template list,
//      Enterprise 409 gate ("requires Canva Enterprise" — never faked),
//      plan-limited autofill raises instead of faking, PDF Print export
//      poll -> download -> store -> hash, design-link round-trip resolution,
//      no connected account -> clean 409. Asserts no real Canva API host is
//      ever fetched.
//
// Strategy: real lib modules (lib/studio/formats, lib/studio/creatives,
// lib/studio/canva mock port, lib/studio/service) against a fresh Postgres
// database. Each run uses uniquely-named workspaces so runs never interfere.
// The PDF store and the export-download fetch are stubbed in-memory — the
// battery never touches the workspace filesystem, the network, or real Canva.

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required.");
  process.exit(2);
}

process.env.MARKETR_CREDENTIALS_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const { prisma } = await import("@/lib/prisma");
const creatives = await import("@/lib/studio/creatives");
const formats = await import("@/lib/studio/formats");
const canva = await import("@/lib/studio/canva");
const service = await import("@/lib/studio/service");
const { secrets } = await import("@/lib/secrets");

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    passed++;
    console.log(`  PASS ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function throwsAsync(
  fn: () => Promise<unknown>,
  needle: string,
): Promise<boolean> {
  try {
    await fn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const status = (e as { status?: number }).status;
    return (
      msg.toLowerCase().includes(needle.toLowerCase()) ||
      String(status ?? "") === needle
    );
  }
  return false;
}

const RUN = `zz-studio-${Date.now()}-${process.pid}`;
const tag = (s: string) => `${RUN}-${s}`;

async function makeWorkspace(name: string) {
  return prisma.workspace.create({
    data: { name: tag(name), ownerUserId: `battery-${process.pid}` },
  });
}

// --- Minimal PDF builder -----------------------------------------------------
// Plain page tree (no compressed object streams) so parsePdfInfo can read the
// MediaBox and /Count — the same shape Canva exports and most print PDFs use.

function makePdf(widthPt: number, heightPt: number, pages = 1): Buffer {
  const kids = Array.from({ length: pages }, (_, i) => `${3 + i} 0 R`).join(" ");
  let objs = "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n";
  objs += `2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pages} >>\nendobj\n`;
  for (let i = 0; i < pages; i++) {
    objs += `${3 + i} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${widthPt} ${heightPt}] >>\nendobj\n`;
  }
  return Buffer.from(`%PDF-1.4\n${objs}%%EOF`, "latin1");
}

const PT = 72;
const p46 = () => makePdf(4 * PT, 6 * PT); // 4x6 postcard
const p46Bleed = () => makePdf(4.25 * PT, 6.25 * PT); // 4x6 with bleed
const pEddmOk = () => makePdf(11.5 * PT, 6.625 * PT); // in-range EDDM flat
const pEddmSmall = () => makePdf(6 * PT, 10 * PT); // below USPS minimum
const pEddmBig = () => makePdf(12.5 * PT, 15 * PT); // above USPS maximum
const pLetter = () => makePdf(8.5 * PT, 11 * PT); // #10 letter page
const notPdf = () => Buffer.from("this is not a pdf", "utf8");

// --- Stub PDF store (in-memory; the real filesystem is never touched) --------

const storedPdfs = new Map<string, Buffer>();
let storeCalls = 0;
async function stubStorePdf(
  _workspaceId: string,
  creativeId: string,
  version: number,
  bytes: Buffer,
  _createdBy: string,
): Promise<{ fileId: string }> {
  storeCalls++;
  const fileId = `stub-file-${creativeId}-v${version}-${storeCalls}`;
  storedPdfs.set(fileId, bytes);
  return { fileId };
}

// --- Stub download fetch: serves mock Canva URLs from memory, throws on
// anything else — proving the battery never hits the real network. ----------

let nextDownloadBytes: Buffer = p46();
let realNetworkAttempts = 0;
async function stubFetch(input: string | URL | Request): Promise<Response> {
  const u = String(input);
  if (u.startsWith("https://mock.canva.example/")) {
    // Copy into a fresh ArrayBuffer so the Response body typing is exact.
    const bytes = Uint8Array.from(nextDownloadBytes);
    return new Response(bytes.buffer as ArrayBuffer, {
      status: 200,
      headers: { "content-type": "application/pdf" },
    });
  }
  realNetworkAttempts++;
  throw new Error(`BLOCKED real network fetch: ${u}`);
}

// --- A. Format validation matrix (pure) --------------------------------------

console.log("A. format validation matrix");
{
  const v = (track: string, size: string, bytes: Buffer | null) =>
    creatives.validateFormat("print", track, size, bytes, { source: "upload" });

  const r46 = v("addressed", "4x6_postcard", p46());
  check("4x6 accepted on addressed track", r46.ok === true);
  check(
    "4x6 dimensions parsed",
    r46.widthIn === 4 && r46.heightIn === 6 && r46.pages === 1,
    JSON.stringify({ w: r46.widthIn, h: r46.heightIn, p: r46.pages }),
  );

  const r46eddm = v("eddm", "eddm_flat", p46());
  check("4x6 REJECTED for eddm", r46eddm.ok === false);
  check(
    "4x6 eddm rejection names the USPS minimum",
    r46eddm.issues.some(
      (i) =>
        i.severity === "error" &&
        /6\.125.*11\.5/.test(i.message) &&
        /does NOT qualify/i.test(i.message),
    ),
    r46eddm.issues.map((i) => i.message).join(" | "),
  );

  const rSmall = v("eddm", "eddm_flat", pEddmSmall());
  check("undersized flat rejected for eddm", rSmall.ok === false);
  check(
    "undersized flat rejection cites minimum",
    rSmall.issues.some((i) => i.severity === "error" && /minimum of 6\.125/.test(i.message)),
  );

  const rBig = v("eddm", "eddm_flat", pEddmBig());
  check("oversized flat rejected for eddm", rBig.ok === false);
  check(
    "oversized flat rejection cites maximum",
    rBig.issues.some((i) => i.severity === "error" && /no larger than 12/.test(i.message)),
  );

  const rEddmOk = v("eddm", "eddm_flat", pEddmOk());
  check("in-range EDDM flat accepted", rEddmOk.ok === true);

  const rLetter = v("addressed", "#10_letter", pLetter());
  check("#10 letter accepted on addressed track", rLetter.ok === true);

  const rNotPdf = v("addressed", "4x6_postcard", notPdf());
  check("non-PDF rejected", rNotPdf.ok === false);
  check(
    "non-PDF error mentions %PDF-",
    rNotPdf.issues.some((i) => i.severity === "error" && /%PDF-/.test(i.message)),
  );

  const rPages = v("addressed", "4x6_postcard", makePdf(4 * PT, 6 * PT, 3));
  check("3-page 4x6 rejected (max 2 pages)", rPages.ok === false);
  check(
    "page-count error names the range",
    rPages.issues.some((i) => i.severity === "error" && /1–2 page/.test(i.message)),
  );

  const rBleed = v("addressed", "4x6_postcard", p46Bleed());
  check("bleed-sized 4x6 passes with warning", rBleed.ok === true);
  check(
    "bleed produces a warning, not an error",
    rBleed.issues.some((i) => i.severity === "warning" && /bleed/i.test(i.message)),
  );

  // Valid PDF header but no readable page dimensions (e.g. compressed object
  // streams): print validation FAILS — dimensions are load-bearing.
  const rNoDims = v(
    "addressed",
    "4x6_postcard",
    Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n%%EOF", "latin1"),
  );
  check("unreadable-dimensions PDF rejected for print", rNoDims.ok === false);
  check(
    "unreadable-dimensions error is actionable",
    rNoDims.issues.some((i) => i.severity === "error" && /page dimensions/i.test(i.message)),
  );

  const rEmail = creatives.validateFormat("email", "newsletter", "x", null);
  check("email channel validation is a no-op info", rEmail.ok === true);
  check(
    "email validation notes coming-soon",
    rEmail.issues.some((i) => i.severity === "info" && /coming soon/i.test(i.message)),
  );

  check(
    "formats registry: email/social registered coming_soon",
    formats.CHANNEL_TEMPLATES.email.status === "coming_soon" &&
      formats.CHANNEL_TEMPLATES.social.status === "coming_soon" &&
      formats.CHANNEL_TEMPLATES.print.status === "live",
  );
}

// --- B. Hash determinism (pure) ----------------------------------------------

console.log("B. creative hash determinism");
{
  const a = p46();
  const b = Buffer.from(a);
  const c = makePdf(4 * PT, 6 * PT, 2);
  const h1 = creatives.computeCreativeHash(a);
  check("same bytes -> same SHA-256", h1 === creatives.computeCreativeHash(b));
  check("hash is 64 hex chars", /^[0-9a-f]{64}$/.test(h1));
  check("different bytes -> different hash", h1 !== creatives.computeCreativeHash(c));
}

// --- C–F run against a fresh database ----------------------------------------

const wsA = await makeWorkspace("a");
const wsB = await makeWorkspace("b");

async function seedCanvaAccount(workspaceId: string, scopes: string) {
  return prisma.studioCanvaAccount.create({
    data: {
      workspaceId,
      canvaUserId: "mock-user-1",
      accessTokenEnc: secrets().encrypt("mock-access-token"),
      refreshTokenEnc: secrets().encrypt("mock-refresh-token"),
      tokenExpiresAt: new Date(Date.now() + 3 * 3600 * 1000),
      scopes,
    },
  });
}

const mockPort = canva.createMockCanvaPort();
const noBrandScopes = "design:meta:read design:content:read";
const canvaClient = { clientId: "test-client", clientSecret: "test-secret" };

try {
  // --- C. Versioning + lifecycle ---------------------------------------------
  console.log("C. versioning + lifecycle");
  {
    const created = await creatives.createCreative(prisma, wsA.id, {
      name: tag("fall mailer"),
      channelTemplate: "print",
      formatTrack: "addressed",
      size: "4x6_postcard",
      source: "upload",
    });
    check("create: draft v1", created.status === "draft" && created.version === 1);
    check("create: no hash before PDF", created.creativeHash === null);

    const withPdf = await creatives.setCreativePdf(prisma, wsA.id, created.id, p46(), {
      storePdf: stubStorePdf,
      createdBy: "battery",
    });
    check("setCreativePdf: validation passed", withPdf.validation?.ok === true);
    check(
      "setCreativePdf: hash stamped == computeCreativeHash(bytes)",
      withPdf.creativeHash === creatives.computeCreativeHash(p46()),
    );
    check("setCreativePdf: pdfUrl set", (withPdf.pdfUrl ?? "").includes(withPdf.id));
    check(
      "stored bytes match uploaded bytes (canonical hash input)",
      storedPdfs.get(withPdf.validation?.fileId ?? "")?.equals(p46()) === true,
    );

    // mark-ready gating
    check(
      "markReady without attestation -> 400",
      await throwsAsync(
        () => creatives.markReady(prisma, wsA.id, withPdf.id, { attested: false }),
        "impersonation",
      ),
    );
    const ready = await creatives.markReady(prisma, wsA.id, withPdf.id, {
      attested: true,
      attestedBy: "battery",
    });
    check("markReady with attestation -> ready", ready.status === "ready");
    check(
      "attestation stored on validation report",
      ready.validation?.attestation?.noGovernmentImpersonation === true &&
        ready.validation?.attestation?.attestedBy === "battery",
    );

    check(
      "ready creative rejects new PDF (version instead)",
      await throwsAsync(
        () => creatives.setCreativePdf(prisma, wsA.id, ready.id, p46(), { storePdf: stubStorePdf }),
        "new version",
      ),
    );

    // versioning: new row, prior archived
    const { previous, next } = await creatives.versionCreative(prisma, wsA.id, ready.id, {
      createdBy: "battery",
    });
    check("version: next is draft v2", next.version === 2 && next.status === "draft");
    check("version: previous archived", previous.version === 1 && previous.status === "archived");
    check("version: new row id differs", next.id !== previous.id);
    check("version: new row has no PDF/hash yet", next.creativeHash === null && next.pdfUrl === null);

    // failing validation blocks mark-ready
    const bad = await creatives.createCreative(prisma, wsA.id, {
      name: tag("4x6 on eddm"),
      channelTemplate: "print",
      formatTrack: "eddm",
      size: "eddm_flat",
      source: "upload",
    });
    const badPdf = await creatives.setCreativePdf(prisma, wsA.id, bad.id, p46(), {
      storePdf: stubStorePdf,
    });
    check("4x6-on-eddm creative: validation FAIL persisted", badPdf.validation?.ok === false);
    check(
      "4x6-on-eddm creative: markReady -> 409",
      await throwsAsync(
        () => creatives.markReady(prisma, wsA.id, bad.id, { attested: true }),
        "did not pass",
      ),
    );

    check(
      "unknown format track -> 400",
      await throwsAsync(
        () =>
          creatives.createCreative(prisma, wsA.id, {
            name: tag("bad track"),
            formatTrack: "nope",
            size: "x",
          }),
        "400",
      ),
    );
    check(
      "setCreativePdf on archived row -> 409",
      await throwsAsync(
        () => creatives.setCreativePdf(prisma, wsA.id, previous.id, p46(), { storePdf: stubStorePdf }),
        "archived",
      ),
    );
  }

  // --- D. Channel-template extensibility --------------------------------------
  console.log("D. channel-template extensibility");
  {
    for (const ch of ["email", "social"] as const) {
      const draft = await creatives.createCreative(prisma, wsA.id, {
        name: tag(`${ch} draft`),
        channelTemplate: ch,
        formatTrack: "newsletter",
        size: "x",
        source: "upload",
      });
      check(`${ch}: draft creatable`, draft.status === "draft" && draft.channelTemplate === ch);
      check(
        `${ch}: markReady gated until tracks defined`,
        await throwsAsync(
          () => creatives.markReady(prisma, wsA.id, draft.id, { attested: true }),
          "coming soon",
        ),
      );
    }
  }

  // --- E. Tenant isolation ----------------------------------------------------
  console.log("E. tenant isolation");
  {
    const aList = await creatives.listCreatives(prisma, wsA.id, {});
    check("wsA sees its creatives", aList.length >= 4);
    const bList = await creatives.listCreatives(prisma, wsB.id, {});
    check("wsB sees none of wsA's creatives", bList.length === 0);
    check(
      "wsB getCreative(wsA id) -> null",
      (await creatives.getCreative(prisma, wsB.id, aList[0].id)) === null,
    );
    check(
      "wsB setCreativePdf(wsA id) -> 404",
      await throwsAsync(
        () => creatives.setCreativePdf(prisma, wsB.id, aList[0].id, p46(), { storePdf: stubStorePdf }),
        "404",
      ),
    );
    const filtered = await creatives.listCreatives(prisma, wsA.id, { channelTemplate: "email" });
    check(
      "channelTemplate filter works",
      filtered.length >= 1 && filtered.every((c) => c.channelTemplate === "email"),
    );
  }

  // --- F. Canva flows (MOCK port only) -----------------------------------------
  console.log("F. canva mock-port flows");
  {
    // No account connected -> clean 409, never a fake export
    const lonely = await creatives.createCreative(prisma, wsB.id, {
      name: tag("lonely"),
      channelTemplate: "print",
      formatTrack: "addressed",
      size: "4x6_postcard",
      source: "canva",
    });
    check(
      "export with no Canva account -> 409",
      await throwsAsync(
        () => creatives.startCreativePdfExport(prisma, wsB.id, mockPort, canvaClient, lonely.id, "DAGmock001", "user"),
        "409",
      ),
    );

    await seedCanvaAccount(wsA.id, noBrandScopes);
    const status = await service.getCanvaStatus(prisma, wsA.id);
    check("getCanvaStatus: connected, no tokens exposed", status.connected === true);
    check(
      "getCanvaStatus never exposes token material",
      !("accessToken" in status) && !("accessTokenEnc" in status) && !("refreshTokenEnc" in status),
    );

    // Enterprise gate: scopes without brandtemplate:* -> clean 409
    const scopesForGate = status.connected ? status.scopes : [];
    check(
      "requireCanvaEnterprise without brand scopes -> 409 requires Canva Enterprise",
      await throwsAsync(() => Promise.resolve(creatives.requireCanvaEnterprise(scopesForGate)), "requires Canva Enterprise"),
    );
    check(
      "requireCanvaEnterprise with brand scopes -> passes",
      await (async () => {
        creatives.requireCanvaEnterprise(["brandtemplate:meta:read", "design:content:read"]);
        return true;
      })(),
    );

    // Brand-template list via mock port
    const token = (await service.getValidCanvaToken(prisma, wsA.id, mockPort, canvaClient)) ?? "";
    check("getValidCanvaToken resolves from seeded account", token === "mock-access-token");
    const templates = await mockPort.listBrandTemplates(token);
    check("mock brand templates listed", templates.length === 1 && templates[0].id === "TPLmock001");

    // Plan-limited autofill is never faked — it raises
    const limitedPort = canva.createMockCanvaPort({ planLimited: true });
    check(
      "plan-limited autofill raises (never faked)",
      await throwsAsync(
        () => limitedPort.autofill("t", "TPLmock001", { headline: { type: "text", text: "hi" } }),
        "not available on this Canva plan",
      ),
    );

    // Design-link round-trip: bad URL -> 400; good URL resolves via mock
    check(
      "bad share URL -> 400",
      await throwsAsync(
        () => creatives.resolveCanvaDesignLink(prisma, wsA.id, mockPort, canvaClient, "https://example.com/nope"),
        "400",
      ),
    );
    const resolved = await creatives.resolveCanvaDesignLink(
      prisma, wsA.id, mockPort, canvaClient,
      "https://www.canva.com/design/DAGmock001/edit",
    );
    check("share URL resolves to mock design", resolved.designId === "DAGmock001");

    // Export flow: start -> poll -> download (stub fetch) -> store -> hash
    const exp = await creatives.createCreative(prisma, wsA.id, {
      name: tag("canva export"),
      channelTemplate: "print",
      formatTrack: "addressed",
      size: "4x6_postcard",
      source: "canva",
      canvaDesignId: "DAGmock001",
    });
    nextDownloadBytes = p46();
    const { exportId } = await creatives.startCreativePdfExport(
      prisma, wsA.id, mockPort, canvaClient, exp.id, "DAGmock001", "user",
    );
    check("export started with job id", exportId.length > 0);
    check(
      "export requested as pdf_print (max-quality alias)",
      mockPort.calls.some((c) => c.method === "startExport" && (c.args as { format: string }).format === "pdf_print"),
    );
    const polled = await creatives.pollCreativePdfExport(prisma, wsA.id, mockPort, canvaClient, exp.id, {
      fetchImpl: stubFetch as unknown as typeof fetch,
      storePdf: stubStorePdf,
      createdBy: "battery",
    });
    check("export poll -> success with creative", polled.status === "success" && polled.creative !== null);
    check(
      "exported creative hash == hash of downloaded bytes",
      polled.creative?.creativeHash === creatives.computeCreativeHash(p46()),
    );
    check(
      "exported creative validation passed (4x6 pdf on addressed)",
      polled.creative?.validation?.ok === true,
    );

    // Idempotent re-poll: no second download
    const callsBefore = mockPort.calls.filter((c) => c.method === "getExport").length;
    const repolled = await creatives.pollCreativePdfExport(prisma, wsA.id, mockPort, canvaClient, exp.id, {
      fetchImpl: stubFetch as unknown as typeof fetch,
      storePdf: stubStorePdf,
    });
    check("re-poll after success is a no-op success", repolled.status === "success");
    check(
      "re-poll made no extra export calls",
      mockPort.calls.filter((c) => c.method === "getExport").length === callsBefore,
    );

    // Full convenience flow with bounded polling
    const exp2 = await creatives.createCreative(prisma, wsA.id, {
      name: tag("canva export 2"),
      channelTemplate: "print",
      formatTrack: "addressed",
      size: "4x6_postcard",
      source: "canva_link",
    });
    nextDownloadBytes = p46Bleed(); // bleed-sized: validation passes with warning
    const done = await creatives.exportCreativePdf(prisma, wsA.id, mockPort, canvaClient, exp2.id, "DAGmock002", {
      fetchImpl: stubFetch as unknown as typeof fetch,
      storePdf: stubStorePdf,
      createdBy: "battery",
      pollIntervalMs: 1,
      maxAttempts: 10,
    });
    check("exportCreativePdf full flow -> creative", done.creativeHash !== null);
    check(
      "bleed export: validation ok with bleed warning note",
      done.validation?.ok === true &&
        (done.validation?.issues ?? []).some((i) => i.severity === "warning" && /bleed/i.test(i.message)),
    );
    check(
      "canva-sourced validation carries print-production notes",
      (done.validation?.printNotes ?? []).some((n) => /bleed\/crop/i.test(n)),
    );

    check("no real network fetches attempted", realNetworkAttempts === 0);
    check(
      "no call ever targeted api.canva.com",
      !mockPort.calls.some((c) => JSON.stringify(c.args).includes("api.canva.com")),
    );

    // Failed export surfaces cleanly
    const failingPort = canva.createMockCanvaPort({ failNext: 1, failMessage: "Mock export boom" });
    const exp3 = await creatives.createCreative(prisma, wsA.id, {
      name: tag("canva export 3"),
      channelTemplate: "print",
      formatTrack: "addressed",
      size: "4x6_postcard",
      source: "canva",
    });
    check(
      "export start failure surfaces as error",
      await throwsAsync(
        () => creatives.startCreativePdfExport(prisma, wsA.id, failingPort, canvaClient, exp3.id, "DAGmock001", "user"),
        "Mock export boom",
      ),
    );
  }
} finally {
  // Unique workspaces cascade-delete creatives, canva accounts, and audit rows.
  await prisma.workspace.deleteMany({ where: { id: { in: [wsA.id, wsB.id] } } });
  await prisma.$disconnect();
}

console.log(`\nStudio battery: ${passed} passed, ${failed} failed.`);
if (failed > 0) {
  console.log(`Failed: ${failures.join(", ")}`);
  process.exit(1);
}
console.log(`Done. (run id ${RUN})`);
