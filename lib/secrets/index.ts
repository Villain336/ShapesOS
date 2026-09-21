// Marketr — secrets provider abstraction (milestone 11).
//
// All credential encryption/decryption flows through this interface so the
// hosted SaaS can swap the env-key scheme for a managed KMS/vault WITHOUT
// touching call sites. Today the default is EnvSecretsProvider (AES-256-GCM
// via MARKETR_CREDENTIALS_KEY — see lib/sitefiles/crypto.ts), acceptable for
// self-hosted single-node deployments.
//
// Production recommendation (hosted): implement SecretsProvider against
// AWS KMS (per-workspace data keys, automatic rotation), GCP KMS, or
// HashiCorp Vault transit, and set SECRETS_PROVIDER accordingly. The
// AwsKmsSecretsProvider stub below shows the intended shape.
//
// Secrets are NEVER sent to the client — encrypt/decrypt happen server-side
// only, at the connector/provider boundary.

import { decryptSecret, encryptSecret, secretHint } from "@/lib/sitefiles/crypto";

export interface SecretsProvider {
  /** Stable id for logging/config, e.g. "env" or "aws-kms". */
  readonly id: string;
  /** Encrypt a plaintext secret. Returns an opaque versioned envelope. */
  encrypt(plaintext: string): string;
  /** Decrypt an envelope produced by encrypt(). Throws on tamper/format errors. */
  decrypt(envelope: string): string;
  /** Non-sensitive UI hint (e.g. "••••a1b2c3d4") — never the secret. */
  hint(plaintext: string): string;
}

/** Default provider: AES-256-GCM with the MARKETR_CREDENTIALS_KEY env key. */
export class EnvSecretsProvider implements SecretsProvider {
  readonly id = "env";
  encrypt(plaintext: string): string {
    return encryptSecret(plaintext);
  }
  decrypt(envelope: string): string {
    return decryptSecret(envelope);
  }
  hint(plaintext: string): string {
    return secretHint(plaintext);
  }
}

/**
 * Documented stub for a managed-KMS provider (milestone 11 scope: interface +
 * selection plumbing, NOT a live AWS integration — no AWS SDK is installed and
 * the sandbox has no credentials to test against).
 *
 * Intended implementation:
 *   1. `npm i @aws-sdk/client-kms`
 *   2. Generate a per-workspace data key via GenerateDataKey (kms:GenerateDataKey
 *      on a CMK), encrypt secrets with the data key (AES-256-GCM, same envelope
 *      format with a "k2:" version prefix), store the encrypted data key
 *      alongside the envelope.
 *   3. Decrypt: KMS Decrypt the data key, then AES-GCM decrypt the envelope.
 *   4. Rotation: re-wrap data keys on SECRETS_ROTATION_INTERVAL; keep old
 *      versions readable until re-encrypted.
 * Set SECRETS_PROVIDER=aws-kms once implemented.
 */
export class AwsKmsSecretsProvider implements SecretsProvider {
  readonly id = "aws-kms";
  encrypt(): string {
    throw new Error(
      "AwsKmsSecretsProvider is a documented stub (milestone 11). " +
        "Implement it against @aws-sdk/client-kms per lib/secrets/index.ts docs, " +
        "then set SECRETS_PROVIDER=aws-kms.",
    );
  }
  decrypt(): string {
    throw new Error(
      "AwsKmsSecretsProvider is a documented stub (milestone 11). " +
        "Implement it against @aws-sdk/client-kms per lib/secrets/index.ts docs, " +
        "then set SECRETS_PROVIDER=aws-kms.",
    );
  }
  hint(plaintext: string): string {
    return secretHint(plaintext);
  }
}

let singleton: SecretsProvider | null = null;

/** Process-wide provider selected by SECRETS_PROVIDER (default "env"). */
export function getSecretsProvider(): SecretsProvider {
  if (singleton) return singleton;
  const which = (process.env.SECRETS_PROVIDER ?? "env").trim().toLowerCase();
  if (which === "aws-kms") {
    const missing = ["AWS_KMS_KEY_ID", "AWS_REGION"].filter((k) => !process.env[k]);
    if (missing.length) {
      throw new Error(
        `SECRETS_PROVIDER=aws-kms requires ${missing.join(", ")} — and a real ` +
          `AwsKmsSecretsProvider implementation (currently a documented stub).`,
      );
    }
    singleton = new AwsKmsSecretsProvider();
  } else {
    singleton = new EnvSecretsProvider();
  }
  return singleton;
}

/** Shorthand used at call sites: secrets().encrypt(…), secrets().decrypt(…). */
export function secrets(): SecretsProvider {
  return getSecretsProvider();
}
