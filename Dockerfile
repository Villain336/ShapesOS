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
RUN npm run build

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
CMD ["sh", "scripts/db/migrate.sh"]

# --- runner ---
FROM base AS runner
RUN apk add --no-cache openssl
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
CMD ["node", "server.js"]
