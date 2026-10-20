// Builds every ShapesOS stack into a CDK app (bin/app.ts and the tests).

import { App, Tags } from "aws-cdk-lib";
import { AppStack } from "./app-stack.ts";
import { readConfig, type ShapesConfig } from "./config.ts";
import { DataStack } from "./data-stack.ts";
import { EdgeGlobalStack } from "./edge-global-stack.ts";
import { EdgeStack } from "./edge-stack.ts";
import { NetworkStack } from "./network-stack.ts";
import { OpsStack } from "./ops-stack.ts";

export interface ShapesStacks {
  config: ShapesConfig;
  network: NetworkStack;
  data: DataStack;
  app: AppStack;
  edgeGlobal: EdgeGlobalStack;
  edge: EdgeStack;
  ops: OpsStack;
}

export function buildApp(app: App): ShapesStacks {
  const config = readConfig((k) => app.node.tryGetContext(k));
  const env = { account: config.account, region: config.region };
  const crossRegion = config.region !== "us-east-1";

  const network = new NetworkStack(app, "ShapesOS-Network", { env, config });
  const data = new DataStack(app, "ShapesOS-Data", { env, config, vpc: network.vpc });
  const appStack = new AppStack(app, "ShapesOS-App", {
    env,
    config,
    vpc: network.vpc,
    taskSubnets: network.taskSubnets,
    assignPublicIp: network.assignPublicIp,
    db: data.db,
    dbSecurityGroup: data.dbSecurityGroup,
    ownerSecret: data.ownerSecret,
    appPasswordSecret: data.appPasswordSecret,
  });
  const edgeGlobal = new EdgeGlobalStack(app, "ShapesOS-EdgeGlobal", {
    env: { account: config.account, region: "us-east-1" },
    crossRegionReferences: crossRegion,
    config,
  });
  const edge = new EdgeStack(app, "ShapesOS-Edge", {
    env,
    crossRegionReferences: crossRegion,
    config,
    alb: appStack.alb,
    certificate: edgeGlobal.certificate,
    webAclArn: edgeGlobal.webAclArn,
  });
  const ops = new OpsStack(app, "ShapesOS-Ops", {
    env,
    config,
    alb: appStack.alb,
    web: appStack.web.service,
    worker: appStack.worker,
    db: data.db,
  });
  Tags.of(app).add("project", "shapesos");
  return { config, network, data, app: appStack, edgeGlobal, edge, ops };
}
