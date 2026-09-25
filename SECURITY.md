# Security Policy

## Reporting a vulnerability

**Do not open a public issue.** Report privately:

- **Email:** `[SECURITY-CONTACT — set before public, e.g. security@<your-domain>]`
  _(This is a placeholder. A real, monitored private channel is a launch blocker —
  tracked as a launch-readiness item. Do not go public without it.)_
- Include: affected version/commit, steps to reproduce, impact assessment, and any
  suggested fix. Encrypted reports welcome — publish a PGP key alongside the real
  contact address when it's set.

### Response SLA

| Stage | Target |
|---|---|
| Acknowledge receipt | **48 hours** |
| Initial triage + severity call | **5 business days** |
| Fix for critical (RCE, auth bypass, secret exfiltration) | **14 days**, coordinated disclosure |
| Fix for high (privilege escalation, IDOR on client data) | **30 days** |
| Public disclosure | After a fix ships, or **90 days** — whichever comes first, coordinated with the reporter |

We will credit reporters (or keep them anonymous — their choice).

## Scope

**In scope:**

- The Marketr application (`app/`, `lib/`, `prisma/`, API routes, MCP server)
- Authentication & authorization (workspace RBAC, SSO/OIDC, approval flows)
- Secret handling (vault, KMS abstraction, encrypted credential storage)
- The hosted reference deployment, when it exists

**Out of scope:**

- Third-party services Marketr integrates with (report to the vendor)
- Social engineering, physical attacks, or attacks on contributors' machines
- `scripts/e2e/` mock endpoints (`/api/e2e/*` — test doubles by design, never deployed)
- Denial-of-service volume testing against any hosted instance

## Ground rules for researchers

- Don't exfiltrate, modify, or delete data that isn't yours. Stop at proof-of-concept.
- Don't degrade service for others. No automated scanners against hosted instances
  without prior written permission.
- Secrets you find in the repo history: this repo is pre-public and audited
  (see `docs/` launch-readiness notes). If you find a *live* credential, report it
  immediately and don't use it.

## Known posture (2026-09-25)

- Full-history secret scan: clean (fixtures only — mock tokens, placeholder keys).
- M11 security battery (`node scripts/verify-m11-security.mjs`) gates authz coverage.
- Approval HMAC secrets fail closed in production (no hardcoded fallbacks).
- Money movement is human-signed by structural invariant (`docs/MASTER-PLAN.md` §3.1);
  the security model treats "autopilot buys" as a vulnerability-class bug.
