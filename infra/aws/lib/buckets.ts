import { Duration, RemovalPolicy } from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import type { Construct } from "constructs";

/** Private, versioned, TLS-only, encrypted, kept if the stack is deleted. */
export function privateBucket(scope: Construct, id: string): s3.Bucket {
  return new s3.Bucket(scope, id, {
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    encryption: s3.BucketEncryption.S3_MANAGED,
    enforceSSL: true,
    versioned: true,
    objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
    removalPolicy: RemovalPolicy.RETAIN,
    lifecycleRules: [{ noncurrentVersionExpiration: Duration.days(30), abortIncompleteMultipartUploadAfter: Duration.days(7) }],
  });
}
