#!/usr/bin/env -S npx tsx
// ShapesOS on AWS — the CDK app (`npx cdk synth|diff|deploy`). Settings: cdk.json
// context, override with -c key=value. Guide: docs/deploy/AWS.md.
import { App } from "aws-cdk-lib";
import { buildApp } from "../lib/build-app.ts";

const app = new App();
buildApp(app);
app.synth();
