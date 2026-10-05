# Production image for Marketr (Next.js standalone)
FROM node:22-alpine AS base

# --- deps ---
FROM base AS deps
RUN apk add --no-cache libc6-compat openssl
WORKDIR /app
# .npmrc carries legacy-peer-deps (next-auth's nodemailer peer range lags).
COPY package.json package-lock.json .npmrc ./
COPY prisma ./prisma
RUN npm ci

# --- builder ---
FROM base AS builder
RUN apk add --no-cache libc6-compat openssl
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Prisma client needs DATABASE_URL at build time for `prisma generate`;
# a dummy value is enough since no DB access happens during build.
ENV DATABASE_URL="postgresql://marketr:marketr@localhost:5432/marketr?schema=public"
RUN npx prisma generate
# The type-check step of `next build` needs more than the default heap.
ENV NODE_OPTIONS=--max-old-space-size=8192
# Release builds (.github/workflows/release.yml) pass these; a plain
# `docker build` / `docker compose build` passes none and builds exactly as
# before. CI=1 + SKIP_BUILD_TYPECHECK=1 are the CI memory settings
# (next.config.ts: no Turbopack disk cache or source maps, no second type
# check — types are gated by the ci workflow) so the build fits a standard
# 8 GB GitHub runner. NEXT_PUBLIC_APP_URL is inlined by `next build` into
# every bundle, server code included, so it must be known here, not at run
# time; an empty value is unset so the code's own fallbacks still apply.
ARG CI=""
ARG SKIP_BUILD_TYPECHECK=""
ARG NEXT_PUBLIC_APP_URL=""
RUN if [ -z "$CI" ]; then unset CI; fi; \
    if [ -z "$SKIP_BUILD_TYPECHECK" ]; then unset SKIP_BUILD_TYPECHECK; fi; \
    if [ -z "$NEXT_PUBLIC_APP_URL" ]; then unset NEXT_PUBLIC_APP_URL; fi; \
    npm run build

# --- migrate --- one-shot migrator (compose `migrate` service). Carries the
# full dependency tree so the Prisma CLI is available; the slim runner is not.
FROM base AS migrate
# psql runs scripts/db/create-app-role.sql (\gexec / psql variables).
RUN apk add --no-cache openssl postgresql-client
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json prisma.config.ts ./
COPY prisma ./prisma
COPY scripts/db ./scripts/db
# AWS migrate task: `sh scripts/deploy/with-runtime-env.sh --owner sh
# scripts/db/migrate.sh` composes the owner's DATABASE_URL from the RDS secret.
COPY scripts/deploy/runtime-env.mjs scripts/deploy/with-runtime-env.sh ./scripts/deploy/
CMD ["sh", "scripts/db/migrate.sh"]

# --- backup --- scheduled pg_dump (compose `backup` service; Phase 4a).
# Same major version as the db service so pg_dump matches the server. curl
# signs the optional S3/MinIO upload (SigV4) without an AWS CLI. jq reads the
# Render API's JSON in BACKUP_SOURCE=render-export mode (the hosted nightly
# copy, render.yaml shapesos-backup).
FROM postgres:16-alpine AS backup
RUN apk add --no-cache curl jq
COPY scripts/ops/backup.sh /usr/local/bin/shapesos-backup
RUN chmod 0755 /usr/local/bin/shapesos-backup \
 && mkdir -p /backups && chown postgres:postgres /backups && chmod 0700 /backups
USER postgres
CMD ["shapesos-backup", "--loop"]

# --- worker --- Phase 8 agent worker (compose `worker` service): claims
# agent_jobs and runs the agent loop (scripts/worker.mts). Same source and
# dependencies as the app, run with tsx (no Next build needed).
FROM base AS worker
RUN apk add --no-cache libc6-compat openssl
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV DATABASE_URL="postgresql://marketr:marketr@localhost:5432/marketr?schema=public"
RUN npx prisma generate
ENV DATABASE_URL=""
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs \
 && mkdir -p /app/.data /app/.run-artifacts \
 && chown -R nextjs:nodejs /app/.data /app/.run-artifacts
USER nextjs
CMD ["node", "node_modules/tsx/dist/cli.mjs", "scripts/worker.mts"]

# --- runner ---
FROM base AS runner
RUN apk add --no-cache openssl
WORKDIR /app
ENV NODE_ENV=production
# Build commit for GET /api/health and error reports (compose passes it as a
# build arg: MARKETR_GIT_COMMIT=$(git rev-parse --short HEAD) docker compose build).
ARG MARKETR_GIT_COMMIT=""
ENV MARKETR_GIT_COMMIT=$MARKETR_GIT_COMMIT
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs
# Runtime state directories (compose mounts named volumes here). Created and
# owned by the app user so a fresh named volume inherits that ownership and is
# writable: .data (reports, logos, site copies, local files), .run-artifacts
# (agent run recordings), data/corpus (knowledge corpus).
RUN mkdir -p /app/.data /app/.run-artifacts /app/data/corpus \
 && chown -R nextjs:nodejs /app/.data /app/.run-artifacts /app/data
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
# Hosted start wrapper (render.yaml dockerCommand, infra/aws): loads secret
# blobs and composes DATABASE_URL for the app role, then exec's
# `node server.js`. Unused by compose.
COPY --from=builder /app/scripts/deploy/runtime-env.mjs /app/scripts/deploy/with-runtime-env.sh ./scripts/deploy/
USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
CMD ["node", "server.js"]
