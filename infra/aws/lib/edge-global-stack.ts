// Edge, global part — always us-east-1: CloudFront only accepts viewer
// certificates from ACM in us-east-1 and web ACLs with scope CLOUDFRONT
// created in us-east-1
// (https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cnames-and-https-requirements.html,
// https://docs.aws.amazon.com/waf/latest/developerguide/how-aws-waf-works-resources.html).
//
//   certificate  <domain> + app.<domain>; DNS-validated (automatically when
//                -c hostedZoneId is given, otherwise ACM shows the CNAMEs to add)
//   web ACL      AWS managed rules (IP reputation, common, known bad inputs)
//                + a rate-based rule on /api/auth/* per client IP.

import { Stack, type StackProps } from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as wafv2 from "aws-cdk-lib/aws-wafv2";
import type { Construct } from "constructs";
import { appHost, type ShapesConfig } from "./config.ts";

export interface EdgeGlobalStackProps extends StackProps {
  config: ShapesConfig;
}

/** Requests to /api/auth/* per client IP per 5 minutes before WAF blocks (the app limits too). */
export const AUTH_RATE_LIMIT_PER_5_MIN = 100;

export class EdgeGlobalStack extends Stack {
  readonly certificate: acm.ICertificate;
  readonly webAclArn: string;

  constructor(scope: Construct, id: string, props: EdgeGlobalStackProps) {
    super(scope, id, props);
    const { config } = props;

    const zone = config.hostedZoneId
      ? route53.HostedZone.fromHostedZoneAttributes(this, "Zone", { hostedZoneId: config.hostedZoneId, zoneName: config.domain })
      : undefined;
    this.certificate = new acm.Certificate(this, "Cert", {
      domainName: config.domain,
      subjectAlternativeNames: [appHost(config)],
      validation: zone ? acm.CertificateValidation.fromDns(zone) : acm.CertificateValidation.fromDns(),
    });

    const managed = (name: string, priority: number, overrides: string[] = []): wafv2.CfnWebACL.RuleProperty => ({
      name,
      priority,
      overrideAction: { none: {} },
      statement: {
        managedRuleGroupStatement: {
          vendorName: "AWS",
          name,
          // Large uploads and rich HTML bodies (newsletters, the site IDE,
          // the CMS) are legitimate here: count these, don't block.
          ...(overrides.length ? { ruleActionOverrides: overrides.map((r) => ({ name: r, actionToUse: { count: {} } })) } : {}),
        },
      },
      visibilityConfig: { sampledRequestsEnabled: true, cloudWatchMetricsEnabled: true, metricName: name },
    });

    const acl = new wafv2.CfnWebACL(this, "WebAcl", {
      name: "shapesos-edge",
      scope: "CLOUDFRONT",
      defaultAction: { allow: {} },
      visibilityConfig: { sampledRequestsEnabled: true, cloudWatchMetricsEnabled: true, metricName: "shapesos-edge" },
      rules: [
        managed("AWSManagedRulesAmazonIpReputationList", 10),
        managed("AWSManagedRulesCommonRuleSet", 20, ["SizeRestrictions_BODY", "CrossSiteScripting_BODY"]),
        managed("AWSManagedRulesKnownBadInputsRuleSet", 30),
        {
          name: "auth-rate-limit",
          priority: 40,
          action: { block: {} },
          statement: {
            rateBasedStatement: {
              limit: AUTH_RATE_LIMIT_PER_5_MIN,
              evaluationWindowSec: 300,
              aggregateKeyType: "IP",
              scopeDownStatement: {
                byteMatchStatement: {
                  fieldToMatch: { uriPath: {} },
                  positionalConstraint: "STARTS_WITH",
                  searchString: "/api/auth/",
                  textTransformations: [{ priority: 0, type: "LOWERCASE" }],
                },
              },
            },
          },
          visibilityConfig: { sampledRequestsEnabled: true, cloudWatchMetricsEnabled: true, metricName: "auth-rate-limit" },
        },
      ],
    });
    this.webAclArn = acl.attrArn;
  }
}
