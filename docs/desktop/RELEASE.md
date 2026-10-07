# ShapesOS Desktop: release and signing checklist

ShapesOS Desktop (`apps/desktop`) ships for macOS (Apple silicon and Intel) and Windows (x64). The workflow `.github/workflows/desktop.yml` does the build. It reads its accounts and keys from repository settings, so nothing secret lives in the repo. This page is the owner's one-time setup and the steps for each release.

Until every box in "One-time setup" is ticked, leave `DESKTOP_RELEASE_ENABLED` unset. Manual runs of the workflow still work then: they build unsigned artifacts you can download from the run (macOS and Windows will warn when you open them).

## One-time setup

### 1. Apple (macOS signing and notarization)

- [ ] **Join the Apple Developer Program** (organisation, $99/year): https://developer.apple.com/programs/. Enrolling as an organisation needs a D-U-N-S number.
- [ ] **Create a "Developer ID Application" certificate.** In Xcode: Settings → Accounts → Manage Certificates → + → Developer ID Application. Or use https://developer.apple.com/account/resources/certificates.
- [ ] **Export it with its private key as a .p12** (Keychain Access → My Certificates → right-click → Export), and set a strong password.
  - Secret `MAC_CSC_LINK` = `base64 -i cert.p12`
  - Secret `MAC_CSC_KEY_PASSWORD` = the password
- [ ] **Create an App Store Connect API key for notarization** (App Store Connect → Users and Access → Integrations → App Store Connect API → Team keys, role "Developer"). Download the `.p8` (you can download it only once).
  - Secret `APPLE_API_KEY_P8` = the file's contents
  - Secret `APPLE_API_KEY_ID` = the Key ID
  - Secret `APPLE_API_ISSUER` = the Issuer ID
  - *Alternative:* an Apple ID with an app-specific password (appleid.apple.com → Sign-In and Security → App-Specific Passwords) plus your Team ID. electron-builder reads these as `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID`. To use them, change the macOS step's `env:` to pass those three instead of the API key.

**What the build already does:** hardened runtime, the entitlements in `apps/desktop/build/entitlements.mac.plist` (JIT and unsigned executable memory for V8, audio input) and `NSMicrophoneUsageDescription`. With `-c.mac.notarize=true`, electron-builder submits the app with `notarytool` and staples the ticket.

### 2. Microsoft (Windows signing through Azure Trusted Signing)

- [ ] **Create an Azure subscription and a Trusted Signing account:** Azure portal → "Trusted Signing Accounts" → Create. Note the region's endpoint, for example `https://eus.codesigning.azure.net`.
- [ ] **Complete identity validation** (Organization; it can take several business days), then create a **certificate profile** of type "Public Trust".
- [ ] **Create an app registration** (Microsoft Entra ID → App registrations), add a client secret, and grant it the role **"Trusted Signing Certificate Profile Signer"** on the Trusted Signing account.
  - Secrets: `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`
  - Variables: `AZURE_SIGN_ENDPOINT`, `AZURE_SIGN_ACCOUNT` (account name), `AZURE_SIGN_PROFILE` (certificate profile name), `AZURE_SIGN_PUBLISHER` (the publisher name exactly as on the certificate, e.g. `ShapesOS Inc.`)
- *Alternative:* an EV code-signing certificate on a hardware token or cloud HSM. This needs a self-hosted runner or the vendor's signing service, and `win.signtoolOptions` in place of `azureSignOptions`.

### 3. Cloudflare R2 (downloads and the auto-update feed)

- [ ] **Create a bucket**, e.g. `shapesos-desktop`, and give it a **public URL**: a custom domain such as `https://updates.shapesos.com` (recommended), or the r2.dev URL.
- [ ] **Create an R2 API token** with Object Read & Write on that bucket only.
  - Secrets: `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`
  - Variables: `R2_ACCOUNT_ID`, `DESKTOP_R2_BUCKET`
- [ ] **Set the variable `DESKTOP_UPDATE_URL`** to the public URL, with no trailing slash and no channel. The app adds `/stable` or `/beta`. **Set the same value as the web app's `DESKTOP_UPDATE_URL` env var**, so `/download` (`GET /api/desktop/releases`) lists the files.

The bucket layout the workflow writes and electron-updater reads:

```
<bucket>/stable/latest.yml          Windows feed (written last)
<bucket>/stable/latest-mac.yml      macOS feed (written last)
<bucket>/stable/ShapesOS-<v>-mac-arm64.dmg / .zip, ShapesOS-<v>-mac-x64.dmg / .zip
<bucket>/stable/ShapesOS-<v>-win-x64.exe (+ .blockmap)
<bucket>/beta/…                     the same files for the beta channel
```

### 4. Turn it on

- [ ] **Set the variable `DESKTOP_RELEASE_ENABLED` = `true`.**

## Each release

1. **Bump `apps/desktop/package.json` "version"** (optional: the workflow also sets the version from the tag).
2. **Tag and push:** `git tag desktop-v0.2.0 && git push origin desktop-v0.2.0`. A tag containing `-beta` (e.g. `desktop-v0.2.0-beta.1`) goes to the beta channel.
3. **Watch Actions → desktop.** Each platform job:
   - runs the unit tests and typecheck;
   - builds;
   - signs (and notarizes on macOS);
   - keeps the artifacts on the run;
   - uploads the binaries to R2, then the `latest*.yml` feed files.
4. **Check the release:**
   - [ ] `https://<update-url>/stable/latest-mac.yml` and `latest.yml` show the new version.
   - [ ] On a Mac, `spctl -a -vvv -t install ShapesOS-<v>-mac-arm64.dmg` says "accepted, source=Notarized Developer ID".
   - [ ] On Windows, the .exe's Properties → Digital Signatures shows your publisher.
   - [ ] The website's `/download` lists the new files.
   - [ ] An installed older build offers the update (Settings → App → Check for updates).

**Dry run (unsigned):** Actions → desktop → Run workflow, leaving "publish" unticked. Nothing is signed or uploaded, and the artifacts stay on the run for 14 days.

**Roll back:** re-upload the previous release's `latest.yml` / `latest-mac.yml` to the channel folder. Clients only move forward, so people who already updated keep the new build until a newer one ships.

## Manual checks on real machines (before the first public release)

The Linux smoke (Playwright + Xvfb against a fake server) proves the app's logic. It cannot prove OS permissions, real hotkeys, signing or real providers. Run these on a real Mac and a real Windows PC against a staging ShapesOS that has real provider keys.

### macOS (Apple silicon and an Intel Mac if you can)

- [ ] **Install.** Open the notarized .dmg, drag to Applications and launch. There should be no Gatekeeper warning.
- [ ] **Sign in.** Sign in inside the main window (SSO / passkey / TOTP). The tray shows the Needs-you count.
- [ ] **Permissions.** On first launch Settings opens and explains Microphone, Screen Recording and Accessibility. For each:
  - [ ] "Allow" or "Open System Settings" goes to the right pane.
  - [ ] Once granted, it reads "Allowed".
  - [ ] Screen Recording needs an app restart; the Screen recording row says so until it's allowed.
- [ ] **Hold-to-talk.**
  - [ ] Hold Ctrl+Option in another app (Safari, Notes). Captions appear near the cursor, the capture indicator shows while held and disappears on release, and the answer is spoken.
  - [ ] Press the key again mid-answer: speech stops at once. Escape (the stop key) also stops it.
- [ ] **Exclusions.** Focus 1Password and hold the key. Nothing is captured, and the answer says 1Password is excluded.
- [ ] **Pointing.**
  - [ ] Ask "where is the Wi-Fi menu?" The pointer flies to the right spot on a Retina display.
  - [ ] Repeat with a second monitor arranged left of and above the main display (negative coordinates) at a different scale.
- [ ] **Inside ShapesOS.** Ask "where do I approve a pay run?" with the ShapesOS window focused. The pointer lands on the exact sidebar item.
- [ ] **Approvals.**
  - [ ] "Draft an invoice for Acme for $200": a proposal card; "yes" approves it.
  - [ ] A Tier 3 action (a pay run, a refund): the card says "Click to approve; voice can't approve this", "yes" is ignored, and only the click works.
- [ ] **Dictation.** In Mail, ask "write a reply saying I'll be there at 3". Preview → Paste: the text lands in the field and your previous clipboard comes back.
- [ ] **Background runs.** "Research our competitors in the background, max $3". The tray shows the run, and a spoken "done" plus a notification follows.
- [ ] **Auto-update.** Install version N, publish N+1 to the beta channel, switch Settings → App → Update channel to Beta, then Check for updates. It downloads and installs on quit.

### Windows 10/11 (x64)

- [ ] **Install.** Run the signed .exe. SmartScreen shows your publisher (reputation builds over time with a non-EV certificate).
- [ ] **Microphone.** The first hold triggers the Windows microphone prompt. If microphone access is off in Privacy settings, the app explains and deep-links to `ms-settings:privacy-microphone`.
- [ ] **Hold key.** Ctrl+Alt works in Notepad, a browser and an elevated app (where uiohook can't hear an elevated window, the toggle key and the tray "Ask" still work).
- [ ] **DPI.**
  - [ ] Test at 125% and 150% scaling, and with mixed-DPI monitors (a 4K at 150% beside a 1080p at 100%). The pointer and drawings land on target on both.
  - [ ] The capture fits under 6 MB.
- [ ] **Exclusions.** A banking site in Edge is excluded by its tab title; a password-manager app is excluded by its exe name.
- [ ] **Dictation.** Dictation pastes with Ctrl+V into Word/Outlook and restores the clipboard.
- [ ] **Tray.** The count and the running agents update, and closing the main window keeps the app in the tray.
- [ ] **Auto-update.** The same as macOS, from the NSIS install.
