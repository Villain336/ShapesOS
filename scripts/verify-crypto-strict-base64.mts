// Marketr crypto hardening — strict base64 validation regression tests.
//
// Run: npx tsx scripts/verify-crypto-strict-base64.mts
// Run 3x green before calling this done.
//
// Covers lib/sitefiles/crypto.ts after the strict-base64 hardening:
//  1. Round-trip: encrypt→decrypt of valid inputs is byte-identical
//     (empty, unicode, long, binary-ish plaintexts).
//  2. Tamper/corruption rejection: truncated envelopes, bad padding,
//     non-alphabet chars, whitespace injection, non-zero padding bits,
//     wrong version, wrong part count — all REJECTED before decoding.
//  3. The M21 finding specifically: corruption in the tag's trailing
//     padding that Node's lenient decoder used to silently repair
//     (→ GCM verified → tamper undetected) must now be rejected.
//  4. GCM still rejects canonical-but-forged parts (defense in depth).
//
// No DB, no network, no live third-party calls.

if (!process.env.MARKETR_CREDENTIALS_KEY) {
  process.env.MARKETR_CREDENTIALS_KEY =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
}

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean) {
  if (cond) {
    passed++;
  } else {
    failed++;
    failures.push(name);
    console.log(`  FAIL: ${name}`);
  }
}

function rejects(name: string, fn: () => unknown) {
  try {
    fn();
    check(name, false);
  } catch {
    check(name, true);
  }
}

async function main() {
  console.log("== crypto strict-base64 verification ==");

  const { encryptSecret, decryptSecret } = await import(
    "@/lib/sitefiles/crypto"
  );
  const { secrets } = await import("@/lib/secrets");

  // ---------------------------------------------------------------- round-trip
  const plaintexts = [
    "super-secret-token",
    "",
    "unicode: héllo wörld 🔐",
    "x".repeat(4096),
    "line1\nline2\ttab\r\n",
  ];
  for (const [i, pt] of plaintexts.entries()) {
    const env = encryptSecret(pt);
    check(`round-trip plaintext #${i}`, decryptSecret(env) === pt);
    // Envelope shape: v2 + key id + 3 canonical base64 parts
    // (ciphertext may be empty for an empty plaintext).
    check(
      `envelope shape plaintext #${i}`,
      /^v2:[0-9a-f]{8}:[A-Za-z0-9+/]+={0,2}:[A-Za-z0-9+/]*={0,2}:[A-Za-z0-9+/]+={0,2}$/.test(
        env,
      ),
    );
  }

  // SecretsProvider delegates to the same helpers.
  const blob = secrets().encrypt("provider-level secret");
  check(
    "secrets() encrypt→decrypt round-trip",
    secrets().decrypt(blob) === "provider-level secret",
  );

  // Determinism sanity: decrypting the same envelope twice works.
  const env = encryptSecret("stable");
  check(
    "double decrypt",
    decryptSecret(env) === "stable" && decryptSecret(env) === "stable",
  );

  // ------------------------------------------------- corruption / tamper cases
  const valid = encryptSecret("do-not-tamper");
  // v2 envelopes carry a key id: "v2:<kid>:iv:ct:tag" (Phase 1 rotation).
  const [v, kid, ivB64, ctB64, tagB64] = valid.split(":");
  const ver = `${v}:${kid}`;

  rejects("truncated envelope", () => decryptSecret(valid.slice(0, -6)));
  rejects("truncated tag part", () =>
    decryptSecret(`${ver}:${ivB64}:${ctB64}:${tagB64.slice(0, -2)}`),
  );
  rejects("stripped padding on tag", () =>
    decryptSecret(`${ver}:${ivB64}:${ctB64}:${tagB64.replace(/=+$/, "")}`),
  );
  rejects("truncated iv (bad length mod 4)", () =>
    decryptSecret(`${ver}:${ivB64.slice(0, -2)}:${ctB64}:${tagB64}`),
  );
  rejects("non-alphabet chars in tag (!!)", () =>
    decryptSecret(`${ver}:${ivB64}:${ctB64}:${tagB64.slice(0, -2)}!!`),
  );
  rejects("non-alphabet chars in iv (~)", () =>
    decryptSecret(`${ver}:~${ivB64.slice(1)}:${ctB64}:${tagB64}`),
  );
  rejects("non-alphabet chars in ciphertext", () =>
    decryptSecret(`${ver}:${ivB64}:***${ctB64.slice(3)}:${tagB64}`),
  );
  rejects("space injected into tag", () =>
    decryptSecret(`${ver}:${ivB64}:${ctB64}:${tagB64.slice(0, -2)} ==`),
  );
  rejects("newline injected into envelope", () =>
    decryptSecret(valid.replace(":", ":\n")),
  );
  rejects("tab injected into ciphertext", () =>
    decryptSecret(`${ver}:${ivB64}:\t${ctB64}:${tagB64}`),
  );
  rejects("base64url chars in tag (-_)", () =>
    decryptSecret(`${ver}:${ivB64}:${ctB64}:${tagB64.slice(0, -2)}-_`),
  );
  rejects("padding in the middle of a part", () =>
    decryptSecret(`${ver}:${ivB64.slice(0, 4)}==${ivB64.slice(4)}:${ctB64}:${tagB64}`),
  );
  rejects("wrong version", () =>
    decryptSecret(`v9:${kid}:${ivB64}:${ctB64}:${tagB64}`),
  );
  rejects("three parts only", () => decryptSecret(`${ver}:${ivB64}:${ctB64}`));
  rejects("five parts (trailing junk)", () =>
    decryptSecret(`${ver}:${ivB64}:${ctB64}:${tagB64}:junk`),
  );
  rejects("empty envelope", () => decryptSecret(""));
  rejects("empty parts", () => decryptSecret("v1:::"));
  rejects("not an envelope at all", () => decryptSecret("hello-world"));

  // The M21 finding, targeted: the tag's trailing "==" replaced with bytes
  // outside the base64 alphabet. Node's lenient decoder used to drop them,
  // decode the original 16-byte tag, and GCM would verify — tamper
  // undetected. Must now be rejected structurally.
  const tagNoPad = tagB64.replace(/=+$/, "");
  rejects("M21 tail-corruption: tag '==' -> raw bytes", () =>
    decryptSecret(`${ver}:${ivB64}:${ctB64}:${tagNoPad}\xa6\x9a`),
  );
  rejects("M21 tail-corruption: tag '==' -> '??'", () =>
    decryptSecret(`${ver}:${ivB64}:${ctB64}:${tagNoPad}??`),
  );

  // Non-zero padding bits: alphabet-valid and length-valid, but decodes to
  // identical bytes only because the trailing bits are non-zero. Craft by
  // flipping the last data char of a padded quantum to a neighbor whose
  // low bits differ (stays in-alphabet, stays canonical-shaped).
  const paddedPart = [ivB64, ctB64, tagB64].find((p) => p.endsWith("=="));
  if (paddedPart) {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const idx = paddedPart.length - 3; // last data char before "=="
    const orig = paddedPart[idx];
    const alt = chars[(chars.indexOf(orig) + 1) % 64];
    const mutated = paddedPart.slice(0, idx) + alt + "==";
    if (mutated !== paddedPart) {
      rejects("non-zero padding bits rejected", () =>
        decryptSecret(
          valid.replace(paddedPart, mutated),
        ),
      );
    }
  } else {
    // Force a padded quantum with a 1-byte plaintext so the check runs.
    const oneByte = encryptSecret("z");
    const parts1 = oneByte.split(":");
    const padded = parts1.find((p) => p.endsWith("=="));
    check("padded quantum available for padding-bit test", !!padded);
  }

  // Canonical-but-forged: single alphabet-char substitution. Strict base64
  // passes, GCM must reject. (Already worked pre-hardening; keep as sanity.)
  const forgedTag =
    tagB64[0] === "A" ? "B" + tagB64.slice(1) : "A" + tagB64.slice(1);
  rejects("forged tag fails GCM", () =>
    decryptSecret(`${ver}:${ivB64}:${ctB64}:${forgedTag}`),
  );

  // ------------------------------------------------------- M21 vault integration
  // OAuth state envelopes flow through secrets() → decryptSecret; the
  // vault-local validator stays as defense-in-depth. Round-trip must work.
  process.env.GOOGLE_OAUTH_CLIENT_ID = "test-client-id";
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = "test-client-secret";
  const { signOAuthState, parseOAuthState } = await import(
    "@/lib/vault/oauth"
  );
  const state = signOAuthState({
    userId: "user-test",
    workspaceId: "ws-test",
    connectorKey: "google-drive",
    exp: Date.now() + 60_000,
    nonce: "test-nonce",
  });
  const parsed = parseOAuthState(state);
  check(
    "OAuth state sign/verify round-trip",
    parsed.connectorKey === "google-drive" && parsed.nonce === "test-nonce",
  );
  rejects("OAuth state tamper rejected", () =>
    parseOAuthState(state.slice(0, -4) + "AAAA"),
  );

  console.log(
    `\n${passed} passed, ${failed} failed${failed ? `: ${failures.join("; ")}` : ""}`,
  );
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error("verify script crashed:", e);
  process.exit(1);
});
