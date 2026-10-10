# Signed, honest agent traffic (Web Bot Auth) and agent commerce

Phase 21A round 2 (M4). What ShapesOS agents send to other people's sites, how a site can check it, and
how money is kept out of an agent's hands.

## What an agent request looks like

- `User-Agent: ShapesOS-Agent/1.0 (+https://shapesos.com/agents)`. Always. Never a browser string, never rotated.
- With an identity configured (the deployment's public origin is https: `APP_URL`, else `NEXTAUTH_URL`) every
  agent fetch and every top-level navigation of the server browser also carries Web Bot Auth headers
  (RFC 9421 HTTP message signatures, Ed25519, profile of draft-meunier-web-bot-auth-architecture-05 and
  Cloudflare's Web Bot Auth page): `Signature-Agent`, `Signature-Input`, `Signature`.
  The signature covers `@authority` and `signature-agent`, is valid 60 seconds, carries a random nonce, and is
  made again for every redirect hop, so it never reaches a host it was not made for.
- Without an https identity (local dev, a LAN install) requests go out unsigned, with the honest user agent.

## The key directory

`GET /.well-known/http-message-signatures-directory` returns the public keys
(`application/http-message-signatures-directory+json`), signed with `tag="http-message-signatures-directory"`
over the request authority. It lists public members only.

## Keys, and how they rotate

- One Ed25519 key pair per deployment, created on the first request that needs it.
- The private half is stored only as a `secrets()` envelope in `agentweb_identity_keys`
  (AES-256-GCM under `MARKETR_CREDENTIALS_KEY`; on hosted, the managed KMS provider in `lib/secrets`).
  There is no environment variable that holds the signing key, plaintext or otherwise.
- A key is active for 90 days. The first signing request after that creates a new key and retires the old one.
  A retired key stays in the directory for 7 days (signatures live at most a minute; verifiers cache the
  directory), then it is pruned (`pruneRetiredKeys`).
- Emergency rotation (suspected leak): call `rotateKey()` then `pruneRetiredKeys(now, { immediately: true })`.
  Verifiers pick up the new key from the directory the next time they see an unknown `keyid`.
- Joining Cloudflare's verified-agents programme is an owner step. UNVERIFIED-LIVE: no real site or
  Cloudflare has been asked to accept these signatures.

## When a site says no

No evasion and no CAPTCHA solving. A 401/403, a bot challenge page or a 429 becomes the typed outcome
`blocked_by_site` (reason: challenge, forbidden, unauthorized, rate_limited); the answer card and the browser
tools say so, tell the agent not to work around it, and give the person the link to open themselves.
`robots.txt` and the site's AI-usage preference (`Content-Signal: ai-input=no`) are honoured before any read.
HTTP 402 becomes `payment_required` (a `crawler-price` header is shown if the site sends one): a person decides,
nothing is paid automatically.

## Delegation records

Every agent web action stores who delegated it, the scope (origins and action classes), the run, when the
delegation expires and the tier decision (`agentweb_delegations`), mirrors them in its audit-chain entry, and
shows them on the receipt. Presenting a delegation to the site itself has no settled standard and is not done.

## Commerce: a person signs, always

- An agent can put a **cart** in front of the person (`cart_request_signature`): a card in Needs you with
  merchant, items, total and expiry. Nothing is paid or ordered by asking.
- The person's click on that card signs a **cart mandate** (`POST /api/agentweb/mandates/:id/sign`, session route,
  same-origin JSON, `channel: "ui_click"`). Voice or chat confirmations, API keys, agents, automations and MCP
  cannot sign. The mandate binds cart hash, amount, currency, merchant, run, workspace and expiry; it is single
  use. There is no unsigned mode.
- A checkout can only be completed with a mandate verified for exactly that cart. If the merchant offers no
  checkout we can drive (ACP), or no payment rail is wired, the agent fills the cart and STOPS: the person
  finishes at the merchant. Card numbers are refused everywhere (cart, adapter input, logs).
- **AP2 human-not-present intent mandates are not implemented** and `createIntentMandate` always refuses: they
  would let an agent buy without the person, which the owner rule (Tier 3 is never auto-approved) forbids.
- ACP and AP2 adapters are tested against labelled mock merchants only: UNVERIFIED-LIVE.
