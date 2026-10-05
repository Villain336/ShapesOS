// GitHub Actions → AWS without long-lived keys (OIDC). Emitted as the
// standalone CloudFormation template infra/aws/bootstrap/bootstrap.yaml
// (`npm run bootstrap-template`), which the owner deploys once from
// CloudShell before `cdk bootstrap`; docs/deploy/AWS.md has the commands.
// Not part of the main CDK app.
//
// Trust (https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws):
//   provider  https://token.actions.githubusercontent.com, audience sts.amazonaws.com
//   sub       repo:<owner>/<repo>:environment:<environment> — only jobs of THIS
//             repository running in the protected `production` environment
//             (owner approval) can assume either role.
// Roles:
//   shapesos-github-deploy  assumes the CDK bootstrap roles (cdk deploy),
//                           pushes the shapesos-* ECR images, runs/updates the
//                           ECS services and the migrate task.
//   shapesos-github-plan    read-only + the CDK lookup role (cdk diff).
// An account can hold one provider per URL: pass ExistingOidcProviderArn when
// the account already has GitHub's provider.

import { CfnCondition, CfnParameter, DefaultStackSynthesizer, Fn, Stack, type StackProps } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import type { Construct } from "constructs";

export interface GithubOidcStackProps extends StackProps {
  githubRepo: string;
  githubEnvironment: string;
}

export const GITHUB_OIDC_URL = "https://token.actions.githubusercontent.com";
export const GITHUB_OIDC_HOST = "token.actions.githubusercontent.com";

export class GithubOidcStack extends Stack {
  constructor(scope: Construct, id: string, props: GithubOidcStackProps) {
    super(scope, id, {
      ...props,
      // A plain template: no bootstrap version check (it runs before cdk bootstrap).
      synthesizer: new DefaultStackSynthesizer({ generateBootstrapVersionRule: false }),
      analyticsReporting: false,
      description: `ShapesOS: GitHub Actions OIDC roles for ${props.githubRepo} (${props.githubEnvironment})`,
    });

    const existing = new CfnParameter(this, "ExistingOidcProviderArn", {
      type: "String",
      default: "",
      description: "ARN of an existing token.actions.githubusercontent.com provider in this account; empty = create one",
    });
    const create = new CfnCondition(this, "CreateProvider", { expression: Fn.conditionEquals(existing.valueAsString, "") });
    const provider = new iam.CfnOIDCProvider(this, "GithubProvider", {
      url: GITHUB_OIDC_URL,
      clientIdList: ["sts.amazonaws.com"],
    });
    provider.cfnOptions.condition = create;
    const providerArn = Fn.conditionIf(create.logicalId, provider.attrArn, existing.valueAsString).toString();

    const principal = new iam.WebIdentityPrincipal(providerArn, {
      StringEquals: {
        [`${GITHUB_OIDC_HOST}:aud`]: "sts.amazonaws.com",
        [`${GITHUB_OIDC_HOST}:sub`]: `repo:${props.githubRepo}:environment:${props.githubEnvironment}`,
      },
    });

    const deploy = new iam.Role(this, "DeployRole", {
      roleName: "shapesos-github-deploy",
      assumedBy: principal,
      description: "GitHub Actions (production environment): cdk deploy, image push, ECS releases",
    });
    const acct = this.account;
    const region = "*";
    deploy.addToPolicy(
      new iam.PolicyStatement({
        sid: "CdkBootstrapRoles",
        actions: ["sts:AssumeRole", "sts:TagSession"],
        resources: [`arn:${this.partition}:iam::${acct}:role/cdk-hnb659fds-*`],
      }),
    );
    deploy.addToPolicy(new iam.PolicyStatement({ sid: "EcrLogin", actions: ["ecr:GetAuthorizationToken"], resources: ["*"] }));
    deploy.addToPolicy(
      new iam.PolicyStatement({
        sid: "EcrPush",
        actions: [
          "ecr:BatchCheckLayerAvailability",
          "ecr:BatchGetImage",
          "ecr:CompleteLayerUpload",
          "ecr:DescribeImages",
          "ecr:GetDownloadUrlForLayer",
          "ecr:InitiateLayerUpload",
          "ecr:PutImage",
          "ecr:UploadLayerPart",
        ],
        resources: [`arn:${this.partition}:ecr:${region}:${acct}:repository/shapesos-*`],
      }),
    );
    deploy.addToPolicy(
      new iam.PolicyStatement({
        sid: "EcsRelease",
        actions: ["ecs:RunTask", "ecs:DescribeTasks", "ecs:DescribeServices", "ecs:UpdateService", "ecs:DescribeTaskDefinition", "ecs:RegisterTaskDefinition", "ecs:ListTasks"],
        resources: ["*"],
        conditions: { StringEqualsIfExists: { "ecs:cluster": `arn:${this.partition}:ecs:${region}:${acct}:cluster/shapesos` } },
      }),
    );
    deploy.addToPolicy(
      new iam.PolicyStatement({
        sid: "PassShapesTaskRoles",
        actions: ["iam:PassRole"],
        resources: [`arn:${this.partition}:iam::${acct}:role/ShapesOS-App-*`],
        conditions: { StringEquals: { "iam:PassedToService": "ecs-tasks.amazonaws.com" } },
      }),
    );
    deploy.addToPolicy(
      new iam.PolicyStatement({
        sid: "ReadReleaseLogs",
        actions: ["logs:GetLogEvents", "logs:FilterLogEvents", "cloudformation:DescribeStacks"],
        resources: [`arn:${this.partition}:logs:${region}:${acct}:log-group:/shapesos/*`, `arn:${this.partition}:cloudformation:${region}:${acct}:stack/ShapesOS-*/*`],
      }),
    );

    const plan = new iam.Role(this, "PlanRole", {
      roleName: "shapesos-github-plan",
      assumedBy: principal,
      description: "GitHub Actions (production environment): read-only, cdk diff",
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("ReadOnlyAccess")],
    });
    plan.addToPolicy(
      new iam.PolicyStatement({
        sid: "CdkLookupRole",
        actions: ["sts:AssumeRole"],
        resources: [`arn:${this.partition}:iam::${acct}:role/cdk-hnb659fds-lookup-role-*`],
      }),
    );

    this.exportValue(deploy.roleArn, { name: "ShapesOS-GithubDeployRoleArn" });
    this.exportValue(plan.roleArn, { name: "ShapesOS-GithubPlanRoleArn" });
  }
}
