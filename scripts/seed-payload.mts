/**
 * Seeds the Payload CMS collections (Phase 12).
 *
 * Creates, idempotently:
 *   1. A CMS operator in `cms_users` from .env ADMIN_EMAIL / ADMIN_PASSWORD
 *      (skipped if a user with that email already exists).
 *   2. One sample published post in `posts`.
 *   3. One docs page in `pages`.
 *
 * Tables are created on init via the adapter's `push: true` (payload.config.ts);
 * the `payload` schema is created here first with plain pg so drizzle's push
 * never has to guess about it.
 *
 * Env is parsed from .env manually — NEVER `source` .env (values contain
 * $/backticks that shell-expand and corrupt).
 *
 * Same two interop workarounds as scripts/payload-importmap.mts:
 * dynamic import() (TLA in the config graph breaks require()) and a
 * synthesized default export for @next/env (Next 16 ships named-only).
 *
 * Run: npx tsx scripts/seed-payload.mts
 */
import { Module } from "node:module";
import fs from "node:fs";
import path from "node:path";

const ROOT = "/home/hatch/workspace/marketr";
process.chdir(ROOT);

// --- load .env manually (no sourcing) ---------------------------------------
for (const line of fs.readFileSync(path.join(ROOT, ".env"), "utf8").split("\n")) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && process.env[m[1]] === undefined) {
    let v = m[2].trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    process.env[m[1]] = v;
  }
}

// --- @next/env default-export shim -------------------------------------------
const originalLoad = (Module as any)._load;
(Module as any)._load = function (
  request: string,
  parent: any,
  isMain: boolean,
) {
  if (request === "@next/env") {
    const actual = originalLoad.call(this, request, parent, isMain);
    if (actual && !(actual as any).default) {
      return { ...actual, default: actual, __esModule: true };
    }
    return actual;
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { Client } = await import("pg");
const { getPayload } = await import("payload");
const configModule = await import(path.join(ROOT, "payload.config.ts"));
const config = await configModule.default;

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL missing from .env");

// 1. Ensure the payload schema exists ------------------------------------------
const client = new Client({ connectionString: DATABASE_URL });
await client.connect();
await client.query("CREATE SCHEMA IF NOT EXISTS payload");
await client.end();
console.log("schema payload: ok");

// 2. Init Payload (push:true syncs tables) --------------------------------------
const payload = await getPayload({ config });
console.log("payload init: ok");

// 3. CMS operator ----------------------------------------------------------------
const adminEmail = process.env.ADMIN_EMAIL;
const adminPassword = process.env.ADMIN_PASSWORD;
if (!adminEmail || !adminPassword) {
  throw new Error("ADMIN_EMAIL / ADMIN_PASSWORD missing from .env");
}
const existing = await payload.find({
  collection: "cms_users",
  where: { email: { equals: adminEmail } },
  limit: 1,
});
if (existing.totalDocs === 0) {
  await payload.create({
    collection: "cms_users",
    data: { email: adminEmail, password: adminPassword, name: "Marketr CMS Admin" },
  });
  console.log(`cms_users: created operator ${adminEmail}`);
} else {
  console.log(`cms_users: operator ${adminEmail} already exists`);
}

// 4. Sample post ------------------------------------------------------------------
const lexicalDoc = (text: string) => ({
  root: {
    type: "root",
    format: "",
    indent: 0,
    version: 1,
    direction: "ltr",
    children: [
      {
        type: "paragraph",
        format: "",
        indent: 0,
        version: 1,
        children: [{ type: "text", text, version: 1, format: 0 }],
        direction: "ltr",
      },
    ],
  },
});

const posts = await payload.find({ collection: "posts", limit: 1 });
if (posts.totalDocs === 0) {
  await payload.create({
    collection: "posts",
    data: {
      title: "Welcome to the Marketr CMS",
      slug: "welcome-to-the-marketr-cms",
      status: "published",
      publishedAt: new Date().toISOString(),
      excerpt:
        "The Payload-powered content layer is live: posts, docs pages, and media, all inside the Marketr app.",
      content: lexicalDoc(
        "This is the first post in the Marketr CMS. Content editors can manage posts, docs pages, and media uploads from /admin — no deploy required.",
      ),
    },
  });
  console.log("posts: seeded 1 sample post");
} else {
  console.log(`posts: already has ${posts.totalDocs} doc(s), skipped`);
}

// 5. Docs page ----------------------------------------------------------------------
const pages = await payload.find({ collection: "pages", limit: 1 });
if (pages.totalDocs === 0) {
  await payload.create({
    collection: "pages",
    data: {
      title: "CMS Docs",
      slug: "cms-docs",
      status: "published",
      content: lexicalDoc(
        "Docs pages live here. Use the Pages collection for long-lived content like help articles, changelogs, and landing copy.",
      ),
    },
  });
  console.log("pages: seeded 1 docs page");
} else {
  console.log(`pages: already has ${pages.totalDocs} doc(s), skipped`);
}

await payload.db.destroy?.();
console.log("seed complete");
