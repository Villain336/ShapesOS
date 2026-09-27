import path from "node:path";
import { buildConfig } from "payload";
import { postgresAdapter } from "@payloadcms/db-postgres";
import { lexicalEditor } from "@payloadcms/richtext-lexical";

import { CMSUsers } from "./payload/collections/CMSUsers";
import { Media } from "./payload/collections/Media";
import { Pages } from "./payload/collections/Pages";
import { Posts } from "./payload/collections/Posts";

/**
 * Payload CMS config (Phase 12).
 *
 * - Runs INSIDE the Marketr Next.js app via @payloadcms/next.
 * - Reuses the existing Postgres 16 (role/db `marketr`, port 5433) but in a
 *   SEPARATE schema (`payload`) so Payload tables never collide with
 *   Marketr's Prisma-managed tables.
 * - Admin UI at `/admin`; REST/GraphQL API at `/cms-api/*` — deliberately NOT
 *   `/api/*`, which is Marketr's own API surface (e.g. `/api/media` exists
 *   and would shadow Payload's media endpoint; `/api/*` is also behind the
 *   proxy.ts rate limiter).
 * - `push: true` syncs the schema on init (dev-friendly). Switch to
 *   migration files (`payload migrate:create`) before any production use.
 *
 * Env: DATABASE_URL (shared with Marketr), PAYLOAD_SECRET (auth tokens).
 * Next loads .env natively; scripts parse .env manually — never `source` it.
 */
export default buildConfig({
  admin: {
    user: CMSUsers.slug,
  },
  collections: [CMSUsers, Posts, Pages, Media],
  editor: lexicalEditor(),
  secret:
    process.env.PAYLOAD_SECRET ?? "marketr-payload-dev-secret-CHANGE-ME",
  db: postgresAdapter({
    pool: {
      connectionString: process.env.DATABASE_URL ?? "",
    },
    schemaName: "payload",
    push: true,
  }),
  routes: {
    admin: "/admin",
    api: "/cms-api",
  },
  typescript: {
    outputFile: path.resolve(process.cwd(), "payload", "payload-types.ts"),
  },
});
