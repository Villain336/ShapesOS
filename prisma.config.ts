// Marketr — Prisma v6 config (replaces the deprecated package.json#prisma key).
import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    // Dummy fallback so `prisma validate`/`generate` work without a live DB;
    // the real DATABASE_URL always wins at runtime (Docker, .env, shell).
    url:
      process.env.DATABASE_URL ?? "postgresql://localhost:5432/marketr",
  },
});
