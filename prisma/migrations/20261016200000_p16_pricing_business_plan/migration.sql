-- Phase 15.3 (pricing): the Business plan (base fee + 25 seats + 40,000
-- credits, SSO/SCIM, unlimited twin sites). Plan numbers live in
-- lib/billing/plans.ts, lib/billing/entitlements.ts and
-- lib/metering/credits.ts; no workspace is moved onto it here (there are no
-- paying customers yet, so nothing to grandfather).

-- AlterEnum
ALTER TYPE "Plan" ADD VALUE 'business';
