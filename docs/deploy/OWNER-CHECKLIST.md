# Owner checklist

Only the steps that need you: identity, payment and legal. About 45 minutes in total. Everything else is in the repo and the workflows; the full guides are [RENDER.md](RENDER.md) and [AWS.md](AWS.md). Never paste a secret into chat, an issue or a pull request.

## 1. GitHub (10 min)

- [ ] **Fix the Actions limit.** Settings → Billing and plans → Actions: check the minutes used and the spending limit. The `verify` job on #23 and #24 never got a runner; nothing builds until this is fixed. Then re-run the failed jobs on both runs.
- [ ] **Create the `production` environment.** Repo → Settings → Environments → New environment `production`:
  - Required reviewers: you.
  - Deployment branches: selected branches → `main`.
- [ ] **Add the Render key** (after step 2): Settings → Secrets and variables → Actions → New repository secret `RENDER_API_KEY`.
- [ ] **Add the variables** (after step 2): `RENDER_WEB_SERVICE_ID`, `RENDER_WORKER_SERVICE_ID`, `RENDER_MIGRATE_SERVICE_ID` (from each service's URL in Render) and `APP_URL` = `https://app.shapesos.com`.
- [ ] **A classic personal access token** with only `read:packages`, for Render to pull the images (RENDER.md step 3).

## 2. Render (10 min)

- [ ] Create a **Pro** workspace, turn on 2FA, add a payment method.
- [ ] Install Render's GitHub app on `Villain336/ShapesOS`.
- [ ] Workspace settings → Container Registry Credentials → add `ghcr-shapesos` (GitHub username + the token from step 1).
- [ ] Account settings → API keys → create one; it goes into GitHub (step 1) and the `shapesos-backup` job.
- [ ] Run **release** once on `main` with dry run unchecked and leave it waiting for approval (RENDER.md step 4). Then New → Blueprint → this repo → Apply (RENDER.md step 5).
- [ ] Copy the generated `MARKETR_CREDENTIALS_KEY` (env group `shapesos-shared`) into your password manager.

## 3. Domain and Cloudflare (10 min)

- [ ] Own `shapesos.com` and move its nameservers to Cloudflare.
- [ ] Add the DNS records from RENDER.md step 9 (DNS only), verify the domains in Render, then switch to Proxied and SSL/TLS → **Full (strict)**.
- [ ] Add the one rate-limiting rule on `/api/auth/` (RENDER.md step 9.5).

## 4. Cloudflare R2 (5 min)

- [ ] Create buckets `shapesos-files`, `shapesos-backups` (lifecycle: delete `render/` objects after 35 days) and `shapesos-desktop`.
- [ ] Create two API tokens: Object Read & Write on `shapesos-files` only, and on `shapesos-backups` only.

## 5. Provider keys (10 min, plus each provider's own sign-up)

- [ ] Sign up and create keys: Anthropic, OpenAI, Stripe (and its four plan prices), Resend (verify the sending domain), E2B, Zernio.
- [ ] Paste them, with the R2 values, into the Render env groups: the lists are in RENDER.md step 7 ("Needed before the first deploy"). Either in the dashboard or with `node scripts/deploy/render-env.mjs push --file <a file outside the repo>`.
- [ ] Set `MARKETR_PLATFORM_OPERATORS` to your user id or email.
- [ ] Register OAuth apps on `https://app.shapesos.com` (Google, Microsoft, Slack, …) when you turn each connector on; the callback paths are in `.env.example`.
- [ ] Approve the waiting release (Actions → release → Review deployments → production). I check the result and hand you the URLs.

## Later

- [ ] **AWS** (when a trigger in AWS.md hits): create the account (an Organization with prod and staging), MFA on root, an Identity Center admin; in CloudShell deploy `infra/aws/bootstrap/bootstrap.yaml` and run `cdk bootstrap` (AWS.md step 2); add the GitHub variables from AWS.md step 3.
- [ ] **Desktop app signing** (Phase 19A): Apple Developer Program ($99/year) and Azure Trusted Signing.
- [ ] **HIPAA only**: accept the AWS BAA in AWS Artifact, or upgrade Render to Scale and sign Render's BAA (adds 20 % to usage, irreversible). Sign DPAs or BAAs with providers that touch personal data.
