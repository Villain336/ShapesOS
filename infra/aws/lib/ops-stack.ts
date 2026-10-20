// Ops: one SNS topic for alarms and the budget, CloudWatch alarms on what
// pages a human (5xx, CPU, database CPU/storage/connections), and a monthly
// AWS Budget (actual > 80 %, forecast > 100 %). Subscribe with
// -c alarmEmail=you@example.com (AWS emails a confirmation link first).

import { Duration, Stack, type StackProps } from "aws-cdk-lib";
import * as budgets from "aws-cdk-lib/aws-budgets";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as actions from "aws-cdk-lib/aws-cloudwatch-actions";
import type * as ecs from "aws-cdk-lib/aws-ecs";
import { HttpCodeElb, HttpCodeTarget, type IApplicationLoadBalancer } from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as iam from "aws-cdk-lib/aws-iam";
import type * as rds from "aws-cdk-lib/aws-rds";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subs from "aws-cdk-lib/aws-sns-subscriptions";
import type { Construct } from "constructs";
import type { ShapesConfig } from "./config.ts";

export interface OpsStackProps extends StackProps {
  config: ShapesConfig;
  alb: IApplicationLoadBalancer;
  web: ecs.FargateService;
  worker: ecs.FargateService;
  db: rds.DatabaseInstance;
}

export class OpsStack extends Stack {
  readonly topic: sns.Topic;
  readonly alarms: cloudwatch.Alarm[] = [];

  constructor(scope: Construct, id: string, props: OpsStackProps) {
    super(scope, id, props);
    const { config } = props;
    this.topic = new sns.Topic(this, "Alerts", { displayName: "ShapesOS alerts", enforceSSL: true });
    if (config.alarmEmail) this.topic.addSubscription(new subs.EmailSubscription(config.alarmEmail));
    // AWS Budgets publishes to the topic.
    this.topic.addToResourcePolicy(
      new iam.PolicyStatement({
        actions: ["sns:Publish"],
        principals: [new iam.ServicePrincipal("budgets.amazonaws.com")],
        resources: [this.topic.topicArn],
        conditions: { StringEquals: { "aws:SourceAccount": this.account } },
      }),
    );

    const alarm = (id: string, metric: cloudwatch.IMetric, threshold: number, description: string, evaluationPeriods = 3) => {
      const a = new cloudwatch.Alarm(this, id, {
        metric,
        threshold,
        evaluationPeriods,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: description,
      });
      a.addAlarmAction(new actions.SnsAction(this.topic));
      a.addOkAction(new actions.SnsAction(this.topic));
      this.alarms.push(a);
      return a;
    };
    const fiveMin = Duration.minutes(5);

    const alb = props.alb;
    alarm("Web5xx", alb.metrics.httpCodeTarget(HttpCodeTarget.TARGET_5XX_COUNT, { period: fiveMin, statistic: "Sum" }), 25, "ShapesOS web: 25+ 5xx responses in 5 min, 3 periods in a row");
    alarm("Alb5xx", alb.metrics.httpCodeElb(HttpCodeElb.ELB_5XX_COUNT, { period: fiveMin, statistic: "Sum" }), 25, "Load balancer 5xx (no healthy task, timeouts)");
    alarm("WebCpu", props.web.metricCpuUtilization({ period: fiveMin }), 85, "ShapesOS web CPU ≥ 85% (autoscaling is at its max?)");
    alarm("WorkerCpu", props.worker.metricCpuUtilization({ period: fiveMin }), 90, "ShapesOS worker CPU ≥ 90%: add a worker task");
    alarm("DbCpu", props.db.metricCPUUtilization({ period: fiveMin }), 80, "Postgres CPU ≥ 80%");
    alarm("DbConnections", props.db.metricDatabaseConnections({ period: fiveMin }), 600, "Postgres connections ≥ 600");
    const storage = new cloudwatch.Alarm(this, "DbStorage", {
      metric: props.db.metricFreeStorageSpace({ period: fiveMin }),
      threshold: 5 * 1024 ** 3,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: "Postgres free storage < 5 GiB (storage autoscaling raises the cap to 500 GB)",
    });
    storage.addAlarmAction(new actions.SnsAction(this.topic));
    this.alarms.push(storage);

    new budgets.CfnBudget(this, "Budget", {
      budget: {
        budgetName: "shapesos-monthly",
        budgetType: "COST",
        timeUnit: "MONTHLY",
        budgetLimit: { amount: config.monthlyBudgetUsd, unit: "USD" },
      },
      notificationsWithSubscribers: [
        {
          notification: { notificationType: "ACTUAL", comparisonOperator: "GREATER_THAN", threshold: 80, thresholdType: "PERCENTAGE" },
          subscribers: [{ subscriptionType: "SNS", address: this.topic.topicArn }],
        },
        {
          notification: { notificationType: "FORECASTED", comparisonOperator: "GREATER_THAN", threshold: 100, thresholdType: "PERCENTAGE" },
          subscribers: [{ subscriptionType: "SNS", address: this.topic.topicArn }],
        },
      ],
    });
  }
}
