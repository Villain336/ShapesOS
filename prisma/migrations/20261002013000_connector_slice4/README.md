# Connector slice 4 — double-opt-in lifecycle

Applies `ConnectorIntroduction` + `ConnectorIntroductionEvent` tables,
three enums, FK constraints, indexes, and the partial unique index
`connector_agent_introductions_active_pair_uk` (one active intro per pair —
Prisma cannot express partial indexes, so it lives only in this migration).

Applied manually via psql + `migrate resolve --applied` (migrate dev is
broken on this box — pgcrypto shadow-DB issue). Pre-existing schema↔DB
drift left untouched.
