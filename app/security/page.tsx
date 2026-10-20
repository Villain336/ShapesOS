// ShapesOS — /security: the security posture of the hosted service, written
// from the code and the deploy docs (beta readiness, WS=legal). Honest about
// what is NOT in place (no certification of our own, no external pen test
// yet). Not legal advice; pending lawyer review for the policy parts.

import Link from "next/link";
import { LegalPage, Section } from "@/components/site/LegalPage";
import { supportEmail } from "@/lib/legal/public-pages";

export const metadata = { title: "Security — ShapesOS", description: "How the hosted ShapesOS service protects your data: tenant isolation, encryption, sign-in, agent safety, logging, backups and disclosure." };

const SECTIONS = [
  { id: "summary", title: "In one paragraph" },
  { id: "architecture", title: "Architecture and tenant isolation" },
  { id: "encryption", title: "Encryption and secrets" },
  { id: "signin", title: "Sign-in and sessions" },
  { id: "agents", title: "Agent safety" },
  { id: "app", title: "Application security" },
  { id: "logging", title: "Logging and monitoring" },
  { id: "backups", title: "Backups and recovery" },
  { id: "disclosure", title: "Reporting a vulnerability" },
  { id: "not-yet", title: "What is not in place yet" },
] as const;

export default function SecurityPage() {
  const email = supportEmail();
  return (
    <LegalPage pageKey="security" path="/security" title="Security" lede="What protects your data on the hosted service, as built, and what is still missing." sections={SECTIONS}>
      <Section id="summary" title="1. In one paragraph">
        <p>
          ShapesOS runs on Render behind Cloudflare, with one PostgreSQL database where every tenant table is under forced row-level security and
          the app connects as a role that cannot bypass it. Secrets are encrypted at rest, passwords are hashed with scrypt, two-factor
          authentication and passkeys are built in, every mutating route is authorisation-gated and checked by an automated battery, agent
          actions are classed by their effect with money and deletion always behind a human, and the source code is public under the AGPL so
          anyone can check these claims.
        </p>
      </Section>

      <Section id="architecture" title="2. Architecture and tenant isolation">
        <ul>
          <li>Web service, agent worker, scheduled jobs and PostgreSQL 16 on Render (Virginia); Cloudflare for DNS, TLS and the proxy; Cloudflare R2 for files and backups. No shared disks; every replica is stateless.</li>
          <li>Tenant tables carry <code>workspace_id</code> and <code>FORCE ROW LEVEL SECURITY</code> policies keyed to a per-request setting; the runtime role is <code>NOSUPERUSER NOBYPASSRLS</code> and a script refuses to continue if it is not. The database suite runs as that role so a missing policy fails the build.</li>
          <li>Platform-wide data (the status page, the shared knowledge corpus) is the only data without a tenant scope, and only platform operators can write it.</li>
          <li>Agent code runs in disposable sandboxes (E2B) that are destroyed when the run ends; previews of a run are reachable only with a scoped, short-lived token.</li>
        </ul>
      </Section>

      <Section id="encryption" title="3. Encryption and secrets">
        <ul>
          <li>TLS everywhere in transit; Cloudflare to Render on SSL Full (strict).</li>
          <li>API keys you add, connected-account tokens, site credentials and two-factor secrets are sealed with AES-256-GCM under a server-side key (<code>MARKETR_CREDENTIALS_KEY</code>) that supports rotation with previous keys; they are decrypted only server-side at use.</li>
          <li>Passwords: scrypt with stored parameters; recovery codes and email sign-in tokens: SHA-256 hashes; magic-link and reset tokens travel in the URL fragment so they never reach server logs.</li>
          <li>Secrets live in the hosting platform&apos;s environment groups. The repository holds placeholders only; a full-history secret scan of the repository came back clean (test fixtures only).</li>
        </ul>
      </Section>

      <Section id="signin" title="4. Sign-in and sessions">
        <ul>
          <li>Email and password (10-character minimum, common passwords refused), Google, or your own OIDC / SAML identity provider.</li>
          <li>Two-factor authentication (authenticator app, recovery codes) and passkeys; a sign-in waiting on its second factor cannot reach the app.</li>
          <li>Lockout with backoff after repeated failures per account and per IP, and a CAPTCHA step-up after that (when the operator configures a provider).</li>
          <li>Sessions last 12 hours and are registered server-side: Settings → You → Security lists them with device and IP prefix, revokes any of them, and &quot;sign out other sessions&quot; ends the rest at once.</li>
        </ul>
      </Section>

      <Section id="agents" title="5. Agent safety">
        <ul>
          <li>Every action is classed at execution time by what it does — never by what the agent says it does. Tier 3 (money, purchases, refunds, payouts, contracts, deleting or purging data) always needs a human approval; no setting, rule, sub-agent or plan can change that, and the test suite asserts it.</li>
          <li>Destructive tools never auto-run. Amounts over your threshold, or in an unknown currency, always ask.</li>
          <li>Admins can block an app (for example Mail) for agents workspace-wide; the next turn loses those tools and a blocked tool is refused even with a stale grant.</li>
          <li>The data access log shows which agent read which app&apos;s data; memory controls let you see and forget what agents remember.</li>
          <li>The web layer does not evade bot detection or solve CAPTCHAs. Content agents read (web pages, email, uploads) is treated as untrusted input.</li>
        </ul>
      </Section>

      <Section id="app" title="6. Application security">
        <ul>
          <li>A Content-Security-Policy with a fresh nonce on every request; API routes get a script-less policy; user file bytes get a sandboxed one.</li>
          <li>Tiered rate limits (sign-in 10/min per IP, reads 120/min, writes 60/min, AI routes 20/min per user), shared across replicas; a 10 MiB body cap; schema validation of every request body with no echoing of values.</li>
          <li>Every mutating API route must use a recognised authorisation primitive; a scan of all route files fails the release if one does not, and every public route needs a documented reason.</li>
          <li>Every inbound webhook (Stripe, Resend, Twilio, GitHub, platform connectors) verifies its signature before parsing and fails closed without a secret.</li>
          <li>Dependencies are locked; CI runs the unit, database and end-to-end suites and the security batteries on every change.</li>
        </ul>
      </Section>

      <Section id="logging" title="7. Logging and monitoring">
        <ul>
          <li>Every response carries a request id; structured error logs never include request bodies, cookies or secrets.</li>
          <li>Each workspace has a hash-chained audit log (people and agents) that detects tampering, and a data access log of agent reads.</li>
          <li>Error reports (Sentry, when enabled) carry the error type, a scrubbed message, route and request id only.</li>
          <li>Live health (web, database, worker, queue) and incidents are public on the <Link href="/status">status page</Link>.</li>
        </ul>
      </Section>

      <Section id="backups" title="8. Backups and recovery">
        <ul>
          <li>Point-in-time recovery for the last 7 days on the database; a nightly export copied to object storage and removed after 35 days.</li>
          <li>Releases deploy an exact image tag per commit, behind an approval, with a health smoke and a rollback path; a restore drill and a rollback test are part of the beta gate.</li>
          <li>Workspace-level Time Machine snapshots restore into a new workspace, never over the live one.</li>
        </ul>
      </Section>

      <Section id="disclosure" title="9. Reporting a vulnerability">
        <p>
          Please do not open a public issue. Email <code>{email}</code> with &quot;Security&quot; in the subject, with the affected version or
          commit, steps to reproduce and impact. We acknowledge within 48 hours, triage within 5 business days, fix critical issues within 14
          days and high ones within 30, and coordinate disclosure with you (public after a fix ships or 90 days, whichever comes first). We credit
          reporters who want credit. Please stop at a proof of concept, never touch data that is not yours, and do not run volume tests against
          the hosted service. Out of scope: third-party services we integrate with (report to them) and the labelled test doubles.
        </p>
      </Section>

      <Section id="not-yet" title="10. What is not in place yet">
        <ul>
          <li>No SOC 2 or ISO 27001 certification of our own. Render&apos;s SOC 2 covers Render&apos;s infrastructure only.</li>
          <li>No external penetration test has been performed yet on the hosted service; the first one is planned before general availability and its date will be published here.</li>
          <li>No formal uptime commitment during the beta.</li>
          <li>A dedicated security address with a PGP key will replace the shared support address after legal review.</li>
        </ul>
      </Section>
    </LegalPage>
  );
}
