// Edge: CloudFront in front of the internal load balancer (a VPC origin:
// CloudFront reaches the ALB privately, so the ALB has no public listener).
//
//   default      → ALB: no caching (the app and /api are dynamic), every
//                  viewer header, cookie and query string forwarded — Host
//                  included, which proxy.ts uses to split shapesos.com
//                  (website) from app.<domain> (the OS). WebSockets work
//                  through CloudFront without extra settings.
//   /_next/static/* → ALB, cached (content-hashed build assets).
//   /updates/*   → the desktop-updates bucket (origin access control).
//
// Long-lived streams: CloudFront closes an origin connection that sends no
// byte for `readTimeout`; every SSE stream sends a heartbeat at least every
// 15 s, below the 60 s set here (the default quota allows up to 120 s for VPC
// origins; aws-cdk-lib VpcOriginProps). Behind it the ALB idle timeout is
// 300 s and Next's keep-alive 310 s.
// https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-vpc-origins.html
// https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/DownloadDistValuesOrigin.html

import { Duration, Stack, type StackProps } from "aws-cdk-lib";
import type * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import type * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as targets from "aws-cdk-lib/aws-route53-targets";
import type * as s3 from "aws-cdk-lib/aws-s3";
import { privateBucket } from "./buckets.ts";
import type { Construct } from "constructs";
import { appHost, type ShapesConfig } from "./config.ts";

export interface EdgeStackProps extends StackProps {
  config: ShapesConfig;
  alb: elbv2.IApplicationLoadBalancer;
  certificate: acm.ICertificate;
  webAclArn: string;
}

export const ORIGIN_READ_TIMEOUT_SECONDS = 60;
export const ORIGIN_KEEPALIVE_SECONDS = 60;

export class EdgeStack extends Stack {
  readonly distribution: cloudfront.Distribution;
  /** Desktop app releases and update feeds (electron-updater generic feed), served at /updates/*. */
  readonly desktopBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: EdgeStackProps) {
    super(scope, id, props);
    const { config } = props;

    this.desktopBucket = privateBucket(this, "DesktopUpdates");

    const app = origins.VpcOrigin.withApplicationLoadBalancer(props.alb, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
      readTimeout: Duration.seconds(ORIGIN_READ_TIMEOUT_SECONDS),
      keepaliveTimeout: Duration.seconds(ORIGIN_KEEPALIVE_SECONDS),
    });

    this.distribution = new cloudfront.Distribution(this, "Cdn", {
      comment: "ShapesOS: website + OS",
      domainNames: [config.domain, appHost(config)],
      certificate: props.certificate,
      webAclId: props.webAclArn,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      defaultBehavior: {
        origin: app,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
        compress: false,
      },
      additionalBehaviors: {
        "/_next/static/*": {
          origin: app,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          compress: true,
        },
        "/updates/*": {
          origin: origins.S3BucketOrigin.withOriginAccessControl(this.desktopBucket),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        },
      },
    });

    if (config.hostedZoneId) {
      const zone = route53.HostedZone.fromHostedZoneAttributes(this, "Zone", { hostedZoneId: config.hostedZoneId, zoneName: config.domain });
      const target = route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(this.distribution));
      new route53.ARecord(this, "Apex", { zone, target });
      new route53.ARecord(this, "AppHost", { zone, recordName: "app", target });
    }
  }
}
