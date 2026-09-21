// Marketr — site-file provider factory.
// Demo connections get the mock provider; everything else gets SFTP.
// Secrets are decrypted here, server-side only, and never leave the server.

import { decryptSecret } from "./crypto";
import { MockSiteFileProvider } from "./mock";
import { SftpSiteFileProvider } from "./sftp";
import type { SiteConnectionConfig, SiteFileProvider } from "./types";

export type { SiteConnectionConfig };

/** Build a provider for a stored connection. Decrypts the secret server-side. */
export function getSiteFileProvider(conn: {
  id: string;
  label: string;
  host: string;
  port: number;
  username: string;
  authType: "password" | "key";
  secretEnc: string;
  demo: boolean;
}): SiteFileProvider {
  if (conn.demo) return new MockSiteFileProvider();
  const secret = decryptSecret(conn.secretEnc);
  const config: SiteConnectionConfig = {
    id: conn.id,
    label: conn.label,
    host: conn.host,
    port: conn.port,
    username: conn.username,
    authType: conn.authType,
    secret,
    demo: false,
  };
  return new SftpSiteFileProvider(config);
}

/** Public-safe connection summary — no secrets, ever. */
export function publicConnection(conn: {
  id: string;
  label: string;
  host: string;
  port: number;
  username: string;
  authType: string;
  secretHint: string | null;
  demo: boolean;
  lastTestedAt: Date | null;
  lastTestOk: boolean | null;
  createdAt: Date;
}) {
  return {
    id: conn.id,
    label: conn.label,
    host: conn.host,
    port: conn.port,
    username: conn.username,
    authType: conn.authType,
    secretHint: conn.secretHint,
    demo: conn.demo,
    isLive: !conn.demo,
    lastTestedAt: conn.lastTestedAt ? conn.lastTestedAt.toISOString() : null,
    lastTestOk: conn.lastTestOk,
    createdAt: conn.createdAt.toISOString(),
  };
}
