-- billing_subscriptions was only ever created by runtime DDL in
-- lib/metering/billing.ts. Under the least-privilege app role (no CREATE on
-- the schema) that DDL can never run, so create it here. IF NOT EXISTS:
-- databases that already created it at runtime are unaffected.
CREATE TABLE IF NOT EXISTS "billing_subscriptions" (
  workspace_id               TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  stripe_subscription_id     TEXT NOT NULL UNIQUE,
  stripe_customer_id         TEXT NOT NULL,
  stripe_checkout_session_id TEXT,
  plan_id                    TEXT NOT NULL,
  status                     TEXT NOT NULL,
  cancel_at_period_end       BOOLEAN NOT NULL DEFAULT false,
  current_period_end         TIMESTAMPTZ,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
);
