import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';

// PrivateLink service names sourced from https://developer.konghq.com/gateway/aws-private-link/
// Keyed by AWS region, then Konnect geo (US | EU | AU | SG | IN | ME | GLOBAL)
const KONNECT_PRIVATELINK_SERVICES: Record<
    string,
    Record<string, { serviceName: string; dnsName: string }>
> = {
    'us-east-1': {
        US: { serviceName: 'com.amazonaws.vpce.us-east-1.vpce-svc-0a701662e3ebe10b8', dnsName: 'us.svc.konghq.com' },
        EU: { serviceName: 'com.amazonaws.vpce.us-east-1.vpce-svc-074b83bf704d87ba7', dnsName: 'eu.svc.konghq.com' },
        AU: { serviceName: 'com.amazonaws.vpce.us-east-1.vpce-svc-03eda50387fcc5e06', dnsName: 'ap.svc.konghq.com' },
        SG: { serviceName: 'com.amazonaws.vpce.us-east-1.vpce-svc-0925688dce5416901', dnsName: 'sg.svc.konghq.com' },
        IN: { serviceName: 'com.amazonaws.vpce.us-east-1.vpce-svc-0785a7867f5cbed8b', dnsName: 'in.svc.konghq.com' },
        ME: { serviceName: 'com.amazonaws.vpce.us-east-1.vpce-svc-09e6e8ec26383e748', dnsName: 'me.svc.konghq.com' },
        GLOBAL: { serviceName: 'com.amazonaws.vpce.us-east-1.vpce-svc-032c06bdabfc6005c', dnsName: 'global.svc.konghq.com' },
    },
    'us-east-2': {
        US: { serviceName: 'com.amazonaws.vpce.us-east-2.vpce-svc-096fe7ba54ebc32db', dnsName: 'us.svc.konghq.com' },
        EU: { serviceName: 'com.amazonaws.vpce.us-east-2.vpce-svc-0cb28c923823735ac', dnsName: 'eu.svc.konghq.com' },
        AU: { serviceName: 'com.amazonaws.vpce.us-east-2.vpce-svc-03da89378358921bc', dnsName: 'ap.svc.konghq.com' },
        SG: { serviceName: 'com.amazonaws.vpce.us-east-2.vpce-svc-05e1f7aec7fe36e70', dnsName: 'sg.svc.konghq.com' },
        IN: { serviceName: 'com.amazonaws.vpce.us-east-2.vpce-svc-0b439785c0b06bb97', dnsName: 'in.svc.konghq.com' },
        ME: { serviceName: 'com.amazonaws.vpce.us-east-2.vpce-svc-0f1c86fb6399d4fe5', dnsName: 'me.svc.konghq.com' },
        GLOBAL: { serviceName: 'com.amazonaws.vpce.us-east-2.vpce-svc-0b6f58f5e17620d89', dnsName: 'global.svc.konghq.com' },
    },
    'us-west-2': {
        US: { serviceName: 'com.amazonaws.vpce.us-west-2.vpce-svc-0d2994122fea007ca', dnsName: 'us.svc.konghq.com' },
        EU: { serviceName: 'com.amazonaws.vpce.us-west-2.vpce-svc-0e03b7c33104a4a4f', dnsName: 'eu.svc.konghq.com' },
        AU: { serviceName: 'com.amazonaws.vpce.us-west-2.vpce-svc-078156c9cc9048988', dnsName: 'ap.svc.konghq.com' },
        SG: { serviceName: 'com.amazonaws.vpce.us-west-2.vpce-svc-03d71f4a064877f2e', dnsName: 'sg.svc.konghq.com' },
        IN: { serviceName: 'com.amazonaws.vpce.us-west-2.vpce-svc-0865c535fc28a3060', dnsName: 'in.svc.konghq.com' },
        ME: { serviceName: 'com.amazonaws.vpce.us-west-2.vpce-svc-0fce4d5504650e9a3', dnsName: 'me.svc.konghq.com' },
        GLOBAL: { serviceName: 'com.amazonaws.vpce.us-west-2.vpce-svc-053325dfb74719cb9', dnsName: 'global.svc.konghq.com' },
    },
    'eu-central-1': {
        US: { serviceName: 'com.amazonaws.vpce.eu-central-1.vpce-svc-01d3dd232e277feeb', dnsName: 'us.svc.konghq.com' },
        EU: { serviceName: 'com.amazonaws.vpce.eu-central-1.vpce-svc-05e6822fbce58e1a0', dnsName: 'eu.svc.konghq.com' },
        AU: { serviceName: 'com.amazonaws.vpce.eu-central-1.vpce-svc-0c3f0574080bdd859', dnsName: 'ap.svc.konghq.com' },
        SG: { serviceName: 'com.amazonaws.vpce.eu-central-1.vpce-svc-0c43e67226a4aa910', dnsName: 'sg.svc.konghq.com' },
        IN: { serviceName: 'com.amazonaws.vpce.eu-central-1.vpce-svc-0a5c165336502e526', dnsName: 'in.svc.konghq.com' },
        ME: { serviceName: 'com.amazonaws.vpce.eu-central-1.vpce-svc-0e6497e6df9928a80', dnsName: 'me.svc.konghq.com' },
        GLOBAL: { serviceName: 'com.amazonaws.vpce.eu-central-1.vpce-svc-050c17c4f2970705f', dnsName: 'global.svc.konghq.com' },
    },
    'eu-west-1': {
        US: { serviceName: 'com.amazonaws.vpce.eu-west-1.vpce-svc-01070d7c2137e0ee1', dnsName: 'us.svc.konghq.com' },
        EU: { serviceName: 'com.amazonaws.vpce.eu-west-1.vpce-svc-037bd988d9a9d4e3a', dnsName: 'eu.svc.konghq.com' },
        AU: { serviceName: 'com.amazonaws.vpce.eu-west-1.vpce-svc-08edf59f8bc1d2262', dnsName: 'ap.svc.konghq.com' },
        SG: { serviceName: 'com.amazonaws.vpce.eu-west-1.vpce-svc-02451d65748600af6', dnsName: 'sg.svc.konghq.com' },
        IN: { serviceName: 'com.amazonaws.vpce.eu-west-1.vpce-svc-029c2f6bedf7c346f', dnsName: 'in.svc.konghq.com' },
        ME: { serviceName: 'com.amazonaws.vpce.eu-west-1.vpce-svc-0978fbaf50bfc67d9', dnsName: 'me.svc.konghq.com' },
        GLOBAL: { serviceName: 'com.amazonaws.vpce.eu-west-1.vpce-svc-0852df4643d76b28e', dnsName: 'global.svc.konghq.com' },
    },
    'eu-west-2': {
        US: { serviceName: 'com.amazonaws.vpce.eu-west-2.vpce-svc-0c23345bb2ef7b298', dnsName: 'us.svc.konghq.com' },
        EU: { serviceName: 'com.amazonaws.vpce.eu-west-2.vpce-svc-0b2d5879e15254e35', dnsName: 'eu.svc.konghq.com' },
        AU: { serviceName: 'com.amazonaws.vpce.eu-west-2.vpce-svc-0500cb14757738225', dnsName: 'ap.svc.konghq.com' },
        SG: { serviceName: 'com.amazonaws.vpce.eu-west-2.vpce-svc-0646cf4c72df9e4fc', dnsName: 'sg.svc.konghq.com' },
        IN: { serviceName: 'com.amazonaws.vpce.eu-west-2.vpce-svc-08e51a56a0ee549c6', dnsName: 'in.svc.konghq.com' },
        ME: { serviceName: 'com.amazonaws.vpce.eu-west-2.vpce-svc-0ab99eeae8121c7d8', dnsName: 'me.svc.konghq.com' },
        GLOBAL: { serviceName: 'com.amazonaws.vpce.eu-west-2.vpce-svc-06dfcb0204806e836', dnsName: 'global.svc.konghq.com' },
    },
    'ap-east-1': {
        US: { serviceName: 'com.amazonaws.vpce.ap-east-1.vpce-svc-02c00c62584350b46', dnsName: 'us.svc.konghq.com' },
        EU: { serviceName: 'com.amazonaws.vpce.ap-east-1.vpce-svc-0ca74e27b8d0a5c3c', dnsName: 'eu.svc.konghq.com' },
        AU: { serviceName: 'com.amazonaws.vpce.ap-east-1.vpce-svc-0c7b67a477740b8cb', dnsName: 'ap.svc.konghq.com' },
        SG: { serviceName: 'com.amazonaws.vpce.ap-east-1.vpce-svc-0b4d34906c77a8e29', dnsName: 'sg.svc.konghq.com' },
        IN: { serviceName: 'com.amazonaws.vpce.ap-east-1.vpce-svc-0731d524d482bfb04', dnsName: 'in.svc.konghq.com' },
        ME: { serviceName: 'com.amazonaws.vpce.ap-east-1.vpce-svc-09ca173aa8de2dd02', dnsName: 'me.svc.konghq.com' },
        GLOBAL: { serviceName: 'com.amazonaws.vpce.ap-east-1.vpce-svc-09dcb6580ddeff0ae', dnsName: 'global.svc.konghq.com' },
    },
    'ap-southeast-1': {
        US: { serviceName: 'com.amazonaws.vpce.ap-southeast-1.vpce-svc-0eeaa22ed2d6268eb', dnsName: 'us.svc.konghq.com' },
        EU: { serviceName: 'com.amazonaws.vpce.ap-southeast-1.vpce-svc-0a04604ecaed18457', dnsName: 'eu.svc.konghq.com' },
        AU: { serviceName: 'com.amazonaws.vpce.ap-southeast-1.vpce-svc-08f76d27d29b02a09', dnsName: 'ap.svc.konghq.com' },
        SG: { serviceName: 'com.amazonaws.vpce.ap-southeast-1.vpce-svc-06ec4681cc9fde9c9', dnsName: 'sg.svc.konghq.com' },
        IN: { serviceName: 'com.amazonaws.vpce.ap-southeast-1.vpce-svc-0c6699c89ac27323c', dnsName: 'in.svc.konghq.com' },
        ME: { serviceName: 'com.amazonaws.vpce.ap-southeast-1.vpce-svc-00689717c9085d08a', dnsName: 'me.svc.konghq.com' },
        GLOBAL: { serviceName: 'com.amazonaws.vpce.ap-southeast-1.vpce-svc-0b1da0ec96942fdb0', dnsName: 'global.svc.konghq.com' },
    },
    'ap-southeast-2': {
        US: { serviceName: 'com.amazonaws.vpce.ap-southeast-2.vpce-svc-0600dd84f39e7b12a', dnsName: 'us.svc.konghq.com' },
        EU: { serviceName: 'com.amazonaws.vpce.ap-southeast-2.vpce-svc-02a339e8dc8ec72c6', dnsName: 'eu.svc.konghq.com' },
        AU: { serviceName: 'com.amazonaws.vpce.ap-southeast-2.vpce-svc-055ba6ff5a3f551c9', dnsName: 'ap.svc.konghq.com' },
        SG: { serviceName: 'com.amazonaws.vpce.ap-southeast-2.vpce-svc-0619b7120e5eb737b', dnsName: 'sg.svc.konghq.com' },
        IN: { serviceName: 'com.amazonaws.vpce.ap-southeast-2.vpce-svc-050ea149424be6d3c', dnsName: 'in.svc.konghq.com' },
        ME: { serviceName: 'com.amazonaws.vpce.ap-southeast-2.vpce-svc-008f231c7501e72c2', dnsName: 'me.svc.konghq.com' },
        GLOBAL: { serviceName: 'com.amazonaws.vpce.ap-southeast-2.vpce-svc-0dddc28f5f8b68cbc', dnsName: 'global.svc.konghq.com' },
    },
    'ap-northeast-1': {
        US: { serviceName: 'com.amazonaws.vpce.ap-northeast-1.vpce-svc-087f56ff74f855a49', dnsName: 'us.svc.konghq.com' },
        EU: { serviceName: 'com.amazonaws.vpce.ap-northeast-1.vpce-svc-01c086f3cb2a8e3b1', dnsName: 'eu.svc.konghq.com' },
        AU: { serviceName: 'com.amazonaws.vpce.ap-northeast-1.vpce-svc-05a555912c88c3403', dnsName: 'ap.svc.konghq.com' },
        SG: { serviceName: 'com.amazonaws.vpce.ap-northeast-1.vpce-svc-08b4f9a82fe4dd518', dnsName: 'sg.svc.konghq.com' },
        IN: { serviceName: 'com.amazonaws.vpce.ap-northeast-1.vpce-svc-0f1fed745c08bb4c2', dnsName: 'in.svc.konghq.com' },
        ME: { serviceName: 'com.amazonaws.vpce.ap-northeast-1.vpce-svc-012f363a353acc0af', dnsName: 'me.svc.konghq.com' },
        GLOBAL: { serviceName: 'com.amazonaws.vpce.ap-northeast-1.vpce-svc-0a5ef5e9cd65b180a', dnsName: 'global.svc.konghq.com' },
    },
    'ap-northeast-2': {
        US: { serviceName: 'com.amazonaws.vpce.ap-northeast-2.vpce-svc-09a955c0f6ecfa69c', dnsName: 'us.svc.konghq.com' },
        EU: { serviceName: 'com.amazonaws.vpce.ap-northeast-2.vpce-svc-0bf31467f8fdb96c9', dnsName: 'eu.svc.konghq.com' },
        AU: { serviceName: 'com.amazonaws.vpce.ap-northeast-2.vpce-svc-0910a66a8164a201f', dnsName: 'ap.svc.konghq.com' },
        SG: { serviceName: 'com.amazonaws.vpce.ap-northeast-2.vpce-svc-0000b04df0b4358dd', dnsName: 'sg.svc.konghq.com' },
        IN: { serviceName: 'com.amazonaws.vpce.ap-northeast-2.vpce-svc-01e0aaa8f7b5535f6', dnsName: 'in.svc.konghq.com' },
        ME: { serviceName: 'com.amazonaws.vpce.ap-northeast-2.vpce-svc-03f1d6f3611a15fac', dnsName: 'me.svc.konghq.com' },
        GLOBAL: { serviceName: 'com.amazonaws.vpce.ap-northeast-2.vpce-svc-0145e14a63e9f470c', dnsName: 'global.svc.konghq.com' },
    },
    'ap-northeast-3': {
        US: { serviceName: 'com.amazonaws.vpce.ap-northeast-3.vpce-svc-07eed5d5d58364be2', dnsName: 'us.svc.konghq.com' },
        EU: { serviceName: 'com.amazonaws.vpce.ap-northeast-3.vpce-svc-016e2797bf4af4129', dnsName: 'eu.svc.konghq.com' },
        AU: { serviceName: 'com.amazonaws.vpce.ap-northeast-3.vpce-svc-0774c82210d1e3a54', dnsName: 'ap.svc.konghq.com' },
        SG: { serviceName: 'com.amazonaws.vpce.ap-northeast-3.vpce-svc-0c107ea8a747b0572', dnsName: 'sg.svc.konghq.com' },
        IN: { serviceName: 'com.amazonaws.vpce.ap-northeast-3.vpce-svc-0e7bbd9cd5c64cab4', dnsName: 'in.svc.konghq.com' },
        ME: { serviceName: 'com.amazonaws.vpce.ap-northeast-3.vpce-svc-0dea199a0496ca206', dnsName: 'me.svc.konghq.com' },
        GLOBAL: { serviceName: 'com.amazonaws.vpce.ap-northeast-3.vpce-svc-07a3a4d6927b28ca8', dnsName: 'global.svc.konghq.com' },
    },
};

export interface VpcConstructProps {
    environment: string; // Environment: dev, qa, uat, prd
    vpcCidr?: string;
    maxAzs?: number;
    natGateways?: number;
    enableFlowLogs?: boolean;
    enableVpcEndpoints?: boolean;
    transitGatewayId?: string;
    transitGatewayRoutes?: string[]; // CIDR blocks to route through TGW
    // Konnect PrivateLink for CP-DP communication (avoids public internet)
    konnectPrivateLinkEnabled?: boolean;
    konnectGeo?: string; // US | EU | AU | SG | IN | ME | GLOBAL
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
            konnectPrivateLinkEnabled = false,
            konnectGeo,
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

        // Konnect PrivateLink endpoint for CP-DP communication
        if (konnectPrivateLinkEnabled && konnectGeo) {
            const stack = cdk.Stack.of(this);
            if (cdk.Token.isUnresolved(stack.region)) {
                throw new Error(
                    'AWS region must be resolved at synth time to create the Konnect PrivateLink endpoint. Set CDK_DEFAULT_REGION.'
                );
            }
            const geoKey = konnectGeo.toUpperCase();
            const serviceInfo = KONNECT_PRIVATELINK_SERVICES[stack.region]?.[geoKey];
            if (!serviceInfo) {
                throw new Error(
                    `Konnect PrivateLink is not available for region "${stack.region}" and geo "${konnectGeo}". ` +
                        `Supported regions: ${Object.keys(KONNECT_PRIVATELINK_SERVICES).join(', ')}. ` +
                        `Supported geos: US, EU, AU, SG, IN, ME, GLOBAL.`
                );
            }

            const privateLinkSg = new ec2.SecurityGroup(this, 'KonnectPrivateLinkSg', {
                vpc: this.vpc,
                description: 'Security group for Konnect PrivateLink VPC endpoint',
                securityGroupName: `kong-konnect-privatelink-sg-${this.environmentName}`,
            });
            privateLinkSg.addIngressRule(
                ec2.Peer.ipv4(this.vpc.vpcCidrBlock),
                ec2.Port.tcp(443),
                'Allow HTTPS from VPC CIDR for Konnect CP-DP communication'
            );

            new ec2.InterfaceVpcEndpoint(this, 'KonnectPrivateLinkEndpoint', {
                vpc: this.vpc,
                service: new ec2.InterfaceVpcEndpointService(serviceInfo.serviceName, 443),
                subnets: {
                    subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
                },
                privateDnsEnabled: true,
                securityGroups: [privateLinkSg],
            });

            new cdk.CfnOutput(this, 'KonnectPrivateLinkDnsName', {
                value: serviceInfo.dnsName,
                description: `Konnect PrivateLink DNS name for geo ${geoKey} — use this in kong.conf cluster_control_plane / cluster_telemetry_endpoint`,
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
