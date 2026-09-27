# Coolify White-Label Guide — provisioning client-owned Marketr instances

**Status:** Phase 12 "embeds" · **docs only** · NOT a product feature

> Strategic verdict (docs/phase12/integration-survey.md §2g): Coolify is
> **AGAINST as a product, FOR as the deployment plane**. Marketr does not
> offer hosting. Coolify provisions isolated, client-owned white-label
> Marketr instances on infrastructure the *agency* controls — "own your
> stack" as a selling point, near-zero marginal commitment for Marketr.

## 1. The shape of the deal

- Each agency client gets **one isolated Marketr instance**: its own
  Postgres, Redis, MinIO bucket prefix, and (optionally) its own Umami /
  GrowthBook sidecars.
- The instance runs on **the agency's own server** (Hetzner, DigitalOcean,
  or on-prem) managed by the agency's Coolify. Marketr's company never sees
  the client's data plane.
- Billing stays between agency and client. Marketr's commercial license is
  per-instance (see LICENSE); the agency holds the license, the client
  holds the infrastructure.

## 2. One-click template

Coolify supports custom "services" from a docker-compose file. Publish a
template pointing at this repo's `docker-compose.yml` plus the sidecar
profiles the client needs:

```yaml
# coolify template sketch — agency fills in the env vars per client
services:
  app:
    image: ghcr.io/<agency>/marketr:${MARKETR_VERSION:-latest}
```

Recommended per-client env vars (Coolify "Environment Variables" screen):

| Var | Purpose |
|---|---|
| `APP_PORT` | Host port for this client's app (3000, 3001, …) |
| `POSTGRES_PASSWORD` | Per-client DB password |
| `DATABASE_URL` | Points at the client's own `db` service |
| `NEXTAUTH_SECRET` / auth secrets | Per-client; never shared across instances |
| `LLM_API_KEY` | Client's own key (BYO) or the agency's pooled key |
| `DATAFORSEO_LOGIN/PASSWORD` | Client's own or pooled |
| `UMAMI_*` | Only if the client bought the analytics add-on (see docker/profiles/umami.yml) |
| `GROWTHBOOK_*` | Only if the client bought experiments (see docker/profiles/growthbook.yml) |

Sidecar profiles are opt-in per client — most clients need only
app + db + redis + minio.

## 3. What the agency owns (and Marketr never touches)

1. **The server and Coolify itself** — OS patching, firewall, backups.
2. **Secrets** — every env var above is entered in the agency's Coolify;
   Marketr's company has no access.
3. **Domains + TLS** — Coolify's built-in reverse proxy; one domain per
   client instance (`client1.agencytools.com`).
4. **Backups** — Postgres volume snapshots; MinIO bucket replication.
5. **Abuse liability** — the agency is the operator of record for its
   clients' sending (email, SMS). Marketr is software, not the sender.

## 4. Upgrade flow

1. Agency pins `MARKETR_VERSION` per client (never `latest` in production).
2. Coolify redeploys the `app` service; the container entrypoint runs
   `prisma migrate deploy` before starting Next, so schema upgrades are
   automatic and ordered.
3. Rollback = re-pin the previous version and redeploy; Postgres volume
   snapshots cover data rollback.

## 5. What this is NOT

- Not multi-tenancy inside one Marketr database. Tenant isolation is a
  convenience; **client data separation is a contract** — separate
  databases per client is the white-label posture.
- Not Marketr-operated hosting. If the agency wants us to run it, that's a
  separate managed-hosting offer with its own SLA, pricing, and SOC 2 scope
  — deliberately out of Phase 12.
- Not a Coolify fork or modification. Coolify stays upstream (Apache-2.0);
  Marketr only ships a template + this guide.

## 6. Checklist for a new client instance

- [ ] Coolify project created on the agency server
- [ ] `docker-compose.yml` (+ sidecar profiles if sold) deployed
- [ ] Per-client env vars entered; secrets generated (no defaults in prod)
- [ ] Domain + TLS attached
- [ ] Postgres volume backup scheduled
- [ ] Smoke test: login → create project → keyword research
- [ ] License recorded against the agency's commercial license seat count
