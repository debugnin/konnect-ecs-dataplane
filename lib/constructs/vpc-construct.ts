import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';

export interface VpcConstructProps {
    environment: string; // Environment: dev, qa, uat, prd
    vpcCidr?: string;
    maxAzs?: number;
    natGateways?: number;
    enableFlowLogs?: boolean;
    enableVpcEndpoints?: boolean;
    transitGatewayId?: string;
    transitGatewayRoutes?: string[]; // CIDR blocks to route through TGW
}

export class VpcConstruct extends Construct {
    public readonly vpc: ec2.Vpc;
    public readonly flowLogGroup?: logs.LogGroup;
    public readonly transitGatewayAttachment?: ec2.CfnTransitGatewayAttachment;
    private readonly environmentName: string;

    constructor(scope: Construct, id: string, props: VpcConstructProps) {
        super(scope, id);

        this.environmentName = props.environment;

        const {
            vpcCidr = '10.0.0.0/16',
            maxAzs = 2,
            natGateways = 1,
            enableFlowLogs = true,
            enableVpcEndpoints = true,
            transitGatewayId,
            transitGatewayRoutes = [],
        } = props;

        // Create VPC
        this.vpc = new ec2.Vpc(this, 'KongVpc', {
            ipAddresses: ec2.IpAddresses.cidr(vpcCidr),
            maxAzs,
            natGateways,
            subnetConfiguration: [
                {
                    cidrMask: 24,
                    name: 'Public',
                    subnetType: ec2.SubnetType.PUBLIC,
                },
                {
                    cidrMask: 24,
                    name: 'Private',
                    subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
                },
            ],
        });

        // VPC Flow Logs (using CloudWatch Logs)
        if (enableFlowLogs) {
            // Create a CloudWatch Log Group to store the flow logs
            this.flowLogGroup = new logs.LogGroup(this, 'VpcFlowLogGroup', {
                logGroupName: `/aws/vpc/kong-vpc-flowlogs-${this.environmentName}`,
                retention: logs.RetentionDays.ONE_MONTH,
                removalPolicy: cdk.RemovalPolicy.DESTROY,
            });

            // Create or import IAM role for VPC Flow Logs
            // Create new role for VPC Flow Logs
            const newFlowLogRole = new iam.Role(this, 'VpcFlowLogRole', {
                roleName: `kong-vpc-flowlog-role-${this.environmentName}`,
                assumedBy: new iam.ServicePrincipal('vpc-flow-logs.amazonaws.com'),
                description: `IAM role for VPC Flow Logs (${this.environmentName})`,
            });

            // Grant permissions to write to CloudWatch Logs
            newFlowLogRole.addToPolicy(
                new iam.PolicyStatement({
                    effect: iam.Effect.ALLOW,
                    actions: [
                        'logs:CreateLogGroup',
                        'logs:CreateLogStream',
                        'logs:PutLogEvents',
                        'logs:DescribeLogGroups',
                        'logs:DescribeLogStreams',
                    ],
                    resources: [this.flowLogGroup.logGroupArn],
                })
            );

            // Enable VPC Flow Logs with IAM role
            new ec2.CfnFlowLog(this, 'VpcFlowLog', {
                resourceId: this.vpc.vpcId,
                resourceType: 'VPC',
                trafficType: 'ALL', // Options: ACCEPT, REJECT, ALL
                logDestinationType: 'cloud-watch-logs',
                logGroupName: this.flowLogGroup.logGroupName,
                deliverLogsPermissionArn: newFlowLogRole.roleArn,
            });
        }

        // VPC Endpoints
        if (enableVpcEndpoints) {
            // S3 Gateway Endpoint
            this.vpc.addGatewayEndpoint('S3Endpoint', {
                service: ec2.GatewayVpcEndpointAwsService.S3,
                subnets: [
                    {
                        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
                    },
                ],
            });

            // ECR API Endpoint
            this.vpc.addInterfaceEndpoint('EcrApiEndpoint', {
                service: ec2.InterfaceVpcEndpointAwsService.ECR,
                subnets: {
                    subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
                },
            });

            // ECR Docker Endpoint
            this.vpc.addInterfaceEndpoint('EcrDockerEndpoint', {
                service: ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER,
                subnets: {
                    subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
                },
            });

            // CloudWatch Logs Endpoint
            this.vpc.addInterfaceEndpoint('CloudWatchLogsEndpoint', {
                service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
                subnets: {
                    subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
                },
            });

            // Secrets Manager Endpoint
            this.vpc.addInterfaceEndpoint('SecretsManagerEndpoint', {
                service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
                subnets: {
                    subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
                },
            });
        }

        // Tags
        cdk.Tags.of(this.vpc).add('Name', `kong-vpc-${this.environmentName}`);

        // Transit Gateway Attachment
        if (transitGatewayId) {
            // Get private subnets for TGW attachment
            const privateSubnets = this.vpc.selectSubnets({
                subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
            });

            this.transitGatewayAttachment = new ec2.CfnTransitGatewayAttachment(
                this,
                'TransitGatewayAttachment',
                {
                    transitGatewayId,
                    vpcId: this.vpc.vpcId,
                    subnetIds: privateSubnets.subnetIds,
                    tags: [
                        {
                            key: 'Name',
                            value: `kong-vpc-tgw-attachment-${this.environmentName}`,
                        },
                    ],
                }
            );

            // Add routes to Transit Gateway if specified
            if (transitGatewayRoutes.length > 0) {
                const privateRouteTables = this.vpc.privateSubnets.map(
                    (subnet) => subnet.routeTable.routeTableId
                );

                // Add routes to each private subnet route table
                privateRouteTables.forEach((routeTableId, index) => {
                    transitGatewayRoutes.forEach((cidr, cidrIndex) => {
                        new ec2.CfnRoute(this, `TgwRoute-${index}-${cidrIndex}`, {
                            routeTableId,
                            destinationCidrBlock: cidr,
                            transitGatewayId,
                        }).addDependency(this.transitGatewayAttachment!);
                    });
                });
            }

            // Output Transit Gateway Attachment ID
            new cdk.CfnOutput(this, 'TransitGatewayAttachmentId', {
                value: this.transitGatewayAttachment.ref,
                description: 'Transit Gateway Attachment ID',
            });
        }
    }
}
