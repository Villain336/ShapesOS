// ShapesOS — Phase 21B (WS=drive): AWS Signature V4 by query string (presigned
// URLs), PURE. Used to hand the browser a short-lived URL for ONE part of a
// multipart upload so large files go straight to object storage and never
// through the app server. The headers-based signer is storage.ts signV4.
// https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html

import { createHmac } from "node:crypto";
import { amzDate, rfc3986, s3CanonicalQuery, sha256Hex, type S3Credentials } from "./storage";

export interface PresignInput {
  method: string;
  /** Host header value (host[:port]). */
  host: string;
  /** Already-canonical URI path. */
  canonicalPath: string;
  /** Extra query parameters to sign (partNumber, uploadId …). */
  query: Record<string, string>;
  region: string;
  service?: string;
  credentials: S3Credentials;
  now: Date;
  expiresSec: number;
}

export interface Presigned {
  /** The full signed query string, signature last. */
  queryString: string;
  signature: string;
  canonicalRequest: string;
}

const hmac = (key: Buffer | string, data: string) => createHmac("sha256", key).update(data, "utf8").digest();

export function presignV4(input: PresignInput): Presigned {
  if (!Number.isInteger(input.expiresSec) || input.expiresSec < 1 || input.expiresSec > 604800) {
    throw new Error("A presigned URL's expiry must be 1 second to 7 days.");
  }
  const service = input.service ?? "s3";
  const { short, long } = amzDate(input.now);
  const scope = `${short}/${input.region}/${service}/aws4_request`;
  const q: Record<string, string> = {
    ...input.query,
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${input.credentials.accessKeyId}/${scope}`,
    "X-Amz-Date": long,
    "X-Amz-Expires": String(input.expiresSec),
    "X-Amz-SignedHeaders": "host",
  };
  if (input.credentials.sessionToken) q["X-Amz-Security-Token"] = input.credentials.sessionToken;
  const canonicalQuery = s3CanonicalQuery(q);
  const canonicalRequest = [input.method.toUpperCase(), input.canonicalPath, canonicalQuery, `host:${input.host}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", long, scope, sha256Hex(canonicalRequest)].join("\n");
  const kDate = hmac(`AWS4${input.credentials.secretAccessKey}`, short);
  const kSigning = hmac(hmac(hmac(kDate, input.region), service), "aws4_request");
  const signature = hmac(kSigning, stringToSign).toString("hex");
  return { queryString: `${canonicalQuery}&X-Amz-Signature=${rfc3986(signature)}`, signature, canonicalRequest };
}
