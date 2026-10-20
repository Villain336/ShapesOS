// ShapesOS — /privacy: privacy policy, DRAFT TEMPLATE (beta readiness,
// WS=legal). Written from the code: what is stored, which providers see
// what (lib/legal/subprocessors.ts feeds the sharing section), the cookies
// (lib/legal/cookies.ts), retention periods, the GDPR export and deletion
// routes, breach notification. Not legal advice; pending lawyer review.

import Link from "next/link";
import { LegalPage, Placeholder, Section } from "@/components/site/LegalPage";
import { supportEmail } from "@/lib/legal/public-pages";
import { SUBPROCESSOR_BASIS_LABEL, subprocessorsByBasis } from "@/lib/legal/subprocessors";

export const metadata = { title: "Privacy policy — ShapesOS", description: "What ShapesOS stores, who processes it, how long it is kept and your rights (draft, pending legal review)." };

const SECTIONS = [
  { id: "scope", title: "Scope and roles" },
  { id: "data", title: "What we store" },
  { id: "purposes", title: "What we use it for" },
  { id: "ai", title: "AI processing" },
  { id: "sharing", title: "Who processes it for us" },
  { id: "transfers", title: "Where it is processed" },
  { id: "retention", title: "How long we keep it" },
  { id: "rights", title: "Your rights and the tools for them" },
  { id: "security", title: "Security and breach notification" },
  { id: "cookies", title: "Cookies" },
  { id: "children", title: "Children" },
  { id: "changes", title: "Changes and contact" },
] as const;

export default function PrivacyPage() {
  const email = supportEmail();
  const platform = subprocessorsByBasis("platform");
  const configured = subprocessorsByBasis("when_configured");
  return (
    <LegalPage pageKey="privacy" path="/privacy" title="Privacy policy" lede="What the hosted ShapesOS service stores about you and your workspace, who processes it, how long it is kept, and how you export or delete it." sections={SECTIONS}>
      <Section id="scope" title="1. Scope and roles">
        <p>
          This policy covers the hosted ShapesOS service operated by <Placeholder>legal entity</Placeholder>. For your account data (sign-in,
          sessions, preferences) we are the <strong>controller</strong>. For the content of your workspace — your customers, leads, calls, files and
          everything agents produce from them — your organisation is the controller and we are its <strong>processor</strong> under the{" "}
          <Link href="/dpa">Data processing addendum</Link>. A self-hosted ShapesOS install is run by its operator; this policy does not apply to it.
        </p>
      </Section>

      <Section id="data" title="2. What we store">
        <h3>Account and sign-in</h3>
        <ul>
          <li>Your email address and name; with Google sign-in, your Google subject id. There is no separate user profile table: your user id is the sign-in subject.</li>
          <li>For email accounts, a password hash (scrypt with stored parameters), the verification state and single-use sign-in and reset tokens stored as SHA-256 hashes.</li>
          <li>Two-factor secrets sealed with AES-256-GCM, passkey public keys and credential ids, recovery codes as SHA-256 hashes.</li>
          <li>A session registry: device label derived from the browser&apos;s user agent (for example &quot;Chrome on macOS&quot;), the first three octets of the IP address (/24 prefix, never the full address), sign-in time and expiry.</li>
          <li>Display and language preferences, notification choices, Web Push subscriptions you opt into, and the items you pinned or opened recently.</li>
        </ul>
        <h3>Workspace content</h3>
        <ul>
          <li>Everything you and your team put in: projects, keywords and rankings, pages and posts, designs, CRM leads and contacts, prospects you enrich, messages, email replies, call recordings and transcripts, bookings, invoices, files and notes.</li>
          <li>What agents produce and record: runs and their transcripts and events, tool calls and results, run recordings (trace and video), what agents remember (episodes, facts, lessons, company knowledge), approvals and automation rules.</li>
          <li>Connected-account tokens and the API keys you add, encrypted with AES-256-GCM under a server-side key.</li>
          <li>A tamper-evident audit log (hash-chained) of who did what, including agents; an append-only usage ledger (credits, model calls with provider response ids).</li>
        </ul>
        <h3>Billing</h3>
        <ul>
          <li>Plan, seats, credit balance and top-ups, the Stripe customer and subscription ids. Payment details are entered on Stripe&apos;s pages and stay with Stripe.</li>
        </ul>
        <h3>Technical and security data</h3>
        <ul>
          <li>Request logs with a request id, route, method, status and timing; rate-limit counters per user or IP; sign-in failure counters for lockout and CAPTCHA step-up.</li>
          <li>Error reports (when the operator enables Sentry) with the error type, a scrubbed message and stack, route and request id — never headers, cookies, bodies, user ids or emails.</li>
        </ul>
      </Section>

      <Section id="purposes" title="3. What we use it for">
        <ul>
          <li>Providing the service you signed up for: running your workspace, your agents, your automations and your integrations.</li>
          <li>Billing and usage metering.</li>
          <li>Keeping accounts safe: sessions, rate limits, lockout after failed sign-ins, CAPTCHA step-up, two-factor authentication, the audit log.</li>
          <li>Support, when you write to us, and notifications you turned on.</li>
          <li>Meeting legal obligations and enforcing the <Link href="/terms">Terms</Link>.</li>
        </ul>
        <p>We do not sell personal data and we do not use your workspace content to train models.</p>
      </Section>

      <Section id="ai" title="4. AI processing">
        <ul>
          <li>
            When an agent works, the prompt it sends to the model provider contains the messages, records, documents and tool results it is working
            on. Providers see that content; they never see your vault secrets or provider keys.
          </li>
          <li>
            Anthropic is used for the lead agent, sub-agents, the code agent and client-facing copy; OpenAI for bulk and background text, failover,
            images, transcription and extraction. Models that are blocked for data-handling reasons are never routed to.
          </li>
          <li>
            Retention at the provider: by default only zero-data-retention-eligible Anthropic models are used, and OpenAI text calls are sent with{" "}
            <code>store: false</code>. The operator can opt into Anthropic models that require 30-day retention (<code>LLM_ALLOW_RETENTION_MODELS=1</code>);
            if that is on for this install it is stated on the <Link href="/subprocessors">subprocessors page</Link>.
          </li>
          <li>A workspace that adds its own model key sends the same calls under its own provider account and terms.</li>
          <li>Agents remember what they learn in your workspace; Settings → You → Privacy shows those memories and lets you forget them, which deletes the row and its embedding.</li>
          <li>Agent outputs are synthetic. Money and irreversible actions are never taken without a human approval (<Link href="/terms#ai">Terms, section 5</Link>).</li>
        </ul>
      </Section>

      <Section id="sharing" title="5. Who processes it for us">
        <p>
          The full list, with what each provider receives and where, is the <Link href="/subprocessors">subprocessors page</Link>, generated from the
          same registry as this section. In summary:
        </p>
        <h3>{SUBPROCESSOR_BASIS_LABEL.platform}</h3>
        <ul>
          {platform.map((s) => (
            <li key={s.id}>
              <strong>{s.name}</strong> — {s.purpose}
            </li>
          ))}
        </ul>
        <h3>{SUBPROCESSOR_BASIS_LABEL.when_configured}</h3>
        <p>Used only when the operator has turned them on: {configured.map((s) => s.name).join("; ")}.</p>
        <h3>Services you connect or bring yourself</h3>
        <p>
          Google, Microsoft, Slack, HubSpot, Linear, Jira, Airtable, Notion, Webflow, Buffer, Meta, Amazon Ads, Shopify, QuickBooks, Xero, Gusto and
          GitHub only receive data for the workspace that connected them, through the ShapesOS OAuth app, under your authorisation. Providers you
          bring your own account or key for (your Stripe, Lob/PostGrid, Smartlead, Instantly, your hosting, self-hosted sidecars) are your contracts.
        </p>
        <p>We also disclose data when the law requires it, and to a successor if ShapesOS is acquired, under this policy.</p>
      </Section>

      <Section id="transfers" title="6. Where it is processed">
        <p>
          The hosted service runs on Render in Virginia, United States; Cloudflare fronts every request on its global network and stores files and
          backups in R2 (&quot;auto&quot; jurisdiction). Model providers process in the United States. For customers in the EEA, the UK and
          Switzerland, transfers rest on <Placeholder>the EU Standard Contractual Clauses and the UK Addendum, incorporated in the DPA; lawyer to
          confirm the module and any adequacy reliance</Placeholder>.
        </p>
      </Section>

      <Section id="retention" title="7. How long we keep it">
        <table>
          <thead>
            <tr>
              <th scope="col">Data</th>
              <th scope="col">Kept</th>
            </tr>
          </thead>
          <tbody>
            <tr><td>Account and workspace content</td><td>Until you delete the workspace or your account, or the beta ends and the export window passes.</td></tr>
            <tr><td>Sign-in sessions</td><td>12 hours (the session token and its registry row expire together); revoked sessions end at once.</td></tr>
            <tr><td>Sign-in links, verification and reset tokens</td><td>Magic links 15 minutes; password-reset links 1 hour; email-verification links 24 hours; all single use.</td></tr>
            <tr><td>Client portal and data-room viewer sessions</td><td>7 days and 12 hours respectively.</td></tr>
            <tr><td>Agent run recordings</td><td>Video dropped after 30 days unless pinned; the trace is kept with the run.</td></tr>
            <tr><td>Audit log and usage ledger</td><td>For the life of the workspace. On account deletion your references are pseudonymised (&quot;deleted-user-…&quot;); hash-chained audit rows are not rewritten so the chain stays tamper-evident.</td></tr>
            <tr><td>Time Machine snapshots</td><td>Per the workspace&apos;s own snapshot settings; admins delete them.</td></tr>
            <tr><td>Database backups</td><td>Point-in-time recovery for 7 days; nightly backups in object storage removed after 35 days. A deleted record can survive in a backup until then and is never restored into a live workspace on its own.</td></tr>
            <tr><td>Error reports (if enabled)</td><td>Per the error tracker&apos;s retention setting.</td></tr>
          </tbody>
        </table>
      </Section>

      <Section id="rights" title="8. Your rights and the tools for them">
        <ul>
          <li><strong>Export:</strong> Settings → You → Export downloads everything keyed to your account as JSON; workspace owners and admins export a whole workspace (secrets left out, the download is audited).</li>
          <li><strong>Delete your account:</strong> Settings → You → Delete account, confirmed by typing your email. It deletes workspaces only you belong to, leaves the others, removes your personal rows and pseudonymises the rest. It is refused while you are the only owner of a workspace with other members or a paid subscription — transfer ownership first.</li>
          <li><strong>Delete a workspace:</strong> Settings → Workspace; everything it owns is purged.</li>
          <li><strong>See what agents read and remember:</strong> Settings → You → Privacy (data access log and memory controls, including forget).</li>
          <li><strong>Sessions:</strong> Settings → You → Security lists where you are signed in and signs out other sessions.</li>
          <li>
            <strong>Everything else</strong> (access, correction, restriction, objection, portability in another form, a complaint): write to{" "}
            <code>{email}</code> from the email on your account. We answer within 30 days. <Placeholder>EU/UK representative and supervisory
            authority wording</Placeholder>.
          </li>
          <li>If you are a user of one of our customers (for example a lead in their CRM), contact that customer; we act on their instructions.</li>
        </ul>
      </Section>

      <Section id="security" title="9. Security and breach notification">
        <p>
          How we protect data is on the <Link href="/security">Security page</Link>. If we confirm a breach of personal data affecting your
          workspace, we notify the workspace owners by email <strong>without undue delay and within 72 hours</strong> of confirming it, with what
          happened, what data, what we did and what you should do, and we post a notice on the <Link href="/status">status page</Link>.
        </p>
      </Section>

      <Section id="cookies" title="10. Cookies">
        <p>
          ShapesOS sets only strictly necessary cookies (sign-in, CSRF, your active workspace, display preferences, scoped access tokens, a
          storefront cart). No analytics or advertising cookies, so there is no consent banner. The full list is on the{" "}
          <Link href="/cookies">Cookies page</Link>.
        </p>
      </Section>

      <Section id="children" title="11. Children">
        <p>The service is for businesses and not directed at children under <Placeholder>16 / 18</Placeholder>. If you believe a child created an account, write to <code>{email}</code>.</p>
      </Section>

      <Section id="changes" title="12. Changes and contact">
        <p>
          The revision date is at the top of this page; material changes are emailed to workspace owners before they apply. Contact for privacy
          matters: <code>{email}</code> (<Link href="/contact">Contact</Link>). <Placeholder>Data protection officer, if appointed</Placeholder>.
        </p>
      </Section>
    </LegalPage>
  );
}
