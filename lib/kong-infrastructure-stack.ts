import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { VpcConstruct } from './constructs/vpc-construct';
import { CertificateConstruct } from './constructs/certificate-construct';
import { WafConstruct } from './constructs/waf-construct';
import { AlbConstruct } from './constructs/alb-construct';
import { LoggingConstruct } from './constructs/logging-construct';

export interface KongInfrastructureStackProps extends cdk.StackProps {
    // Environment for naming conventions
    environment: string; // Environment: dev, qa, uat, prd

    // VPC Configuration
    vpc?: {
        vpcCidr?: string;
        maxAzs?: number;
        natGateways?: number;
        enableFlowLogs?: boolean;
        flowLogRoleArn?: string;
        enableVpcEndpoints?: boolean;
        transitGatewayId?: string;
        transitGatewayRoutes?: string[];
    };

    // Certificate Configuration
    certificate?: {
        domainName: string;
        subjectAlternativeNames?: string[];
        hostedZoneId?: string;
        hostedZoneName?: string;
    };

    // WAF Configuration
    waf?: {
        enabled?: boolean;
        rateLimitPerMinute?: number;
        enableAWSManagedRules?: boolean;
        allowedCidrs?: string[];
        enableCidrRestriction?: boolean;
    };

    // ALB Configuration
    alb?: {
        mtlsTrustStoreArn?: string;
        enableAccessLogs?: boolean;
    };

    // Logging Configuration (Central Account)
    logging?: {
        enabled?: boolean;
        centralDestinationArn?: string;
        logGroupNames?: string[];
        filterPattern?: string;
        subscriptionRoleArn?: string;
    };
}

export class KongInfrastructureStack extends cdk.Stack {
    public readonly vpcConstruct: VpcConstruct;
    public readonly certificateConstruct?: CertificateConstruct;
    public readonly wafConstruct?: WafConstruct;
    public readonly albConstruct: AlbConstruct;
    public readonly loggingConstruct?: LoggingConstruct;
    private readonly environmentName: string;

    constructor(scope: Construct, id: string, props: KongInfrastructureStackProps) {
        super(scope, id, props);

        this.environmentName = props.environment;

        // Get regional suffix for multi-region deployments
        const regionalSuffix = this.node.tryGetContext('regionalSuffix') || '';

        // Create VPC with Flow Logs (CloudWatch Logs) and VPC Endpoints
        this.vpcConstruct = new VpcConstruct(this, 'VpcConstruct', {
            environment: this.environmentName,
            vpcCidr: props.vpc?.vpcCidr,
            maxAzs: props.vpc?.maxAzs,
            natGateways: props.vpc?.natGateways,
            enableFlowLogs: props.vpc?.enableFlowLogs,
            flowLogRoleArn: props.vpc?.flowLogRoleArn,
            enableVpcEndpoints: props.vpc?.enableVpcEndpoints,
            transitGatewayId: props.vpc?.transitGatewayId,
            transitGatewayRoutes: props.vpc?.transitGatewayRoutes,
        });

        // Create Certificate for ALB if domain is provided (regional)
        if (props.certificate?.domainName) {
            this.certificateConstruct = new CertificateConstruct(
                this,
                'CertificateConstruct',
                {
                    domainName: props.certificate.domainName,
                    subjectAlternativeNames: props.certificate.subjectAlternativeNames,
                    hostedZoneId: props.certificate.hostedZoneId,
                    hostedZoneName: props.certificate.hostedZoneName,
                }
            );
        }

        // Create WAF for ALB
        // checkForwardedIp is enabled so that the CIDR allow rule matches both:
        // - Direct mTLS clients (port 443): matched by source IP
        // - CloudFront-forwarded requests (port 8443): matched by the viewer IP in X-Forwarded-For
        //   (CloudFront's edge node IP is the TCP source, not the original client IP)
        let albWafConstruct: WafConstruct | undefined;
        if (props.waf?.enabled !== false) {
            albWafConstruct = new WafConstruct(this, 'AlbWafConstruct', {
                scope: 'REGIONAL',
                environment: this.environmentName,
                component: 'alb',
                rateLimitPerMinute: props.waf?.rateLimitPerMinute,
                enableAWSManagedRules: props.waf?.enableAWSManagedRules,
                allowedCidrs: props.waf?.allowedCidrs,
                enableCidrRestriction: props.waf?.enableCidrRestriction,
            });
        }

        // Create ALB with automated Route53 failover
        // Primary region (no suffix): Creates ALB with FAILOVER PRIMARY + health check
        // Secondary region (with suffix): Creates ALB with FAILOVER SECONDARY
        this.albConstruct = new AlbConstruct(this, 'AlbConstruct', {
            vpc: this.vpcConstruct.vpc,
            environment: this.environmentName,
            customDomain: props.certificate?.domainName,
            hostedZoneId: props.certificate?.hostedZoneId,
            hostedZoneName: props.certificate?.hostedZoneName,
            certificateArn: this.certificateConstruct?.certificate.certificateArn,
            mtlsTrustStoreArn: props.alb?.mtlsTrustStoreArn,
            webAclArn: albWafConstruct?.webAcl.attrArn,
            enableAccessLogs: props.alb?.enableAccessLogs,
            regionalSuffix: regionalSuffix,
        });

        // Create Log Streaming to Central Account (via Subscription Filters)
        if (props.logging?.enabled && props.logging.centralDestinationArn) {
            // Automatically collect all log group names from the infrastructure stack
            const autoCollectedLogGroups: string[] = [];

            // VPC Flow Logs
            if (this.vpcConstruct.flowLogGroup) {
                autoCollectedLogGroups.push(this.vpcConstruct.flowLogGroup.logGroupName);
            }

            // Combine auto-collected with user-specified log groups (e.g., service logs)
            const allLogGroups = [
                ...autoCollectedLogGroups,
                ...(props.logging.logGroupNames || []),
            ];

            // Remove duplicates
            const uniqueLogGroups = Array.from(new Set(allLogGroups));

            if (uniqueLogGroups.length > 0) {
                this.loggingConstruct = new LoggingConstruct(this, 'LoggingConstruct', {
                    environment: this.environmentName,
                    centralDestinationArn: props.logging.centralDestinationArn,
                    logGroupNames: uniqueLogGroups,
                    filterPattern: props.logging.filterPattern,
                    subscriptionRoleArn: props.logging.subscriptionRoleArn,
                });
            }
        }
        // Stack Outputs
        new cdk.CfnOutput(this, 'VpcId', {
            value: this.vpcConstruct.vpc.vpcId,
            description: 'VPC ID',
            exportName: 'KongInfrastructure-VpcId',
        });

        new cdk.CfnOutput(this, 'AlbArn', {
            value: this.albConstruct.loadBalancer.loadBalancerArn,
            description: 'Application Load Balancer ARN',
            exportName: 'KongInfrastructure-AlbArn',
        });

        new cdk.CfnOutput(this, 'AlbDnsName', {
            value: this.albConstruct.loadBalancer.loadBalancerDnsName,
            description: 'Application Load Balancer DNS Name',
            exportName: 'KongInfrastructure-AlbDnsName',
        });

        // Export listener ARNs for service stacks to add rules
        if (this.albConstruct.httpsListener) {
            new cdk.CfnOutput(this, 'HttpsListenerArn', {
                value: this.albConstruct.httpsListener.listenerArn,
                description:
                    'HTTPS Listener ARN (port 443) - Direct client traffic with mTLS',
                exportName: 'KongInfrastructure-HttpsListenerArn',
            });
        }

        // Export subscription role ARN if logging construct created one
        if (this.loggingConstruct?.subscriptionRole) {
            new cdk.CfnOutput(this, 'LoggingSubscriptionRoleArn', {
                value: this.loggingConstruct.subscriptionRole.roleArn,
                description: 'IAM Role ARN for CloudWatch Logs subscription filters',
                exportName: `KongInfrastructure-LoggingSubscriptionRoleArn-${this.environmentName}`,
            });
        }

        if (this.certificateConstruct) {
            new cdk.CfnOutput(this, 'CertificateArn', {
                value: this.certificateConstruct.certificate.certificateArn,
                description: 'ACM Certificate ARN',
                exportName: 'KongInfrastructure-CertificateArn',
            });
        }
    }
}
