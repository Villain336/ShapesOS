// Network: a VPC across 2 Availability Zones.
//   public    tasks (with public IPs; security groups admit only the load
//             balancer) — no NAT gateway, so no ≈$33/mo + data charges
//   isolated  RDS and the internal load balancer (no route to the internet)
// With -c natGateway=true: one NAT gateway, and tasks move to private
// subnets that egress through it — a single fixed outbound IP for customer
// firewall allow-lists (SFTP, WordPress). Plan: "No NAT at launch".

import { Stack, type StackProps } from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import type { Construct } from "constructs";
import type { ShapesConfig } from "./config.ts";

export interface NetworkStackProps extends StackProps {
  config: ShapesConfig;
}

export class NetworkStack extends Stack {
  readonly vpc: ec2.Vpc;
  /** Where the ECS tasks run. */
  readonly taskSubnets: ec2.SubnetSelection;
  /** Whether tasks need a public IP (no NAT). */
  readonly assignPublicIp: boolean;

  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props);
    const { config } = props;
    const subnetConfiguration: ec2.SubnetConfiguration[] = [
      { name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 22 },
      { name: "isolated", subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 22 },
    ];
    if (config.natGateway) {
      subnetConfiguration.push({ name: "private", subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 22 });
    }
    this.vpc = new ec2.Vpc(this, "Vpc", {
      ipAddresses: ec2.IpAddresses.cidr("10.40.0.0/16"),
      // Explicit zones when given (no lookup); otherwise the first two of the region.
      ...(config.availabilityZones ? { availabilityZones: config.availabilityZones } : { maxAzs: 2 }),
      natGateways: config.natGateway ? 1 : 0,
      subnetConfiguration,
      // S3 traffic stays on the AWS network (and needs no NAT).
      gatewayEndpoints: { S3: { service: ec2.GatewayVpcEndpointAwsService.S3 } },
    });
    this.assignPublicIp = !config.natGateway;
    this.taskSubnets = { subnetType: config.natGateway ? ec2.SubnetType.PRIVATE_WITH_EGRESS : ec2.SubnetType.PUBLIC };
  }
}
