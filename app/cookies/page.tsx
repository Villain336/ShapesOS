// ShapesOS — /cookies: generated from lib/legal/cookies.ts (beta readiness,
// WS=legal). Every cookie is strictly necessary, so there is no consent
// banner; the unit test asserts both. Pending lawyer review for the policy
// wording.

import Link from "next/link";
import { LegalPage, Section } from "@/components/site/LegalPage";
import { BROWSER_STORAGE_NOTES, COOKIES, COOKIE_CATEGORY_LABEL, THIRD_PARTY_COOKIE_NOTES, needsConsentBanner } from "@/lib/legal/cookies";

export const metadata = { title: "Cookies — ShapesOS", description: "Every cookie the hosted ShapesOS service sets, what it is for and how long it lasts. No analytics or advertising cookies." };

const SECTIONS = [
  { id: "summary", title: "Summary" },
  { id: "list", title: "Every cookie we set" },
  { id: "storage", title: "Other browser storage" },
  { id: "third-party", title: "Third-party cookies" },
  { id: "control", title: "How to control them" },
] as const;

export default function CookiesPage() {
  const banner = needsConsentBanner();
  return (
    <LegalPage pageKey="cookies" path="/cookies" title="Cookies" lede="Every cookie the hosted service sets, read from the code that sets it." sections={SECTIONS}>
      <Section id="summary" title="1. Summary">
        <p>
          ShapesOS sets <strong>only strictly necessary cookies</strong>: your sign-in session, CSRF protection, which workspace is open, your
          display preferences, scoped access tokens for previews, data rooms and the client portal, and a cart on a hosted storefront. There are no
          analytics, advertising or cross-site tracking cookies, and we load no third-party tracking scripts.{" "}
          {banner ? "A consent banner is shown." : "That is why there is no cookie consent banner: nothing here needs consent under the ePrivacy rules."}
        </p>
      </Section>

      <Section id="list" title="2. Every cookie we set">
        <table>
          <thead>
            <tr>
              <th scope="col">Cookie</th>
              <th scope="col">Purpose</th>
              <th scope="col">Lifetime and scope</th>
            </tr>
          </thead>
          <tbody>
            {COOKIES.map((c) => (
              <tr key={c.name} data-cookie={c.name}>
                <th scope="row">
                  <code>{c.name}</code>
                  {c.aliases?.length ? <span className="mt-1 block text-xs text-muted">also {c.aliases.map((a) => a).join(", ")}</span> : null}
                  <span className="mt-1 block text-xs text-muted">{COOKIE_CATEGORY_LABEL[c.category]} · {c.httpOnly ? "HttpOnly" : "readable by scripts"}</span>
                </th>
                <td>
                  {c.purpose}
                  <br />
                  <span className="text-muted">{c.setBy}</span>
                </td>
                <td>
                  {c.lifetime}
                  <br />
                  <span className="text-muted">{c.scope}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section id="storage" title="3. Other browser storage">
        <ul>
          {BROWSER_STORAGE_NOTES.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      </Section>

      <Section id="third-party" title="4. Third-party cookies">
        <ul>
          {THIRD_PARTY_COOKIE_NOTES.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      </Section>

      <Section id="control" title="5. How to control them">
        <p>
          Your browser can block or delete cookies; blocking the session cookie signs you out and blocking the preference cookie resets your
          theme and language to the defaults. Signing out clears the session and workspace cookies. Questions: see <Link href="/contact">Contact</Link>.
        </p>
      </Section>
    </LegalPage>
  );
}
