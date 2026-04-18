import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53targets from 'aws-cdk-lib/aws-route53-targets';

export interface AlbConstructProps {
    vpc: ec2.IVpc;
    environment: string; // Environment: dev, qa, uat, prd
    customDomain?: string;
    hostedZoneId?: string;
    hostedZoneName?: string;
    certificateArn?: string;
    mtlsTrustStoreArn?: string;
    webAclArn?: string;
    enableAccessLogs?: boolean;
    regionalSuffix?: string; // Empty for primary region, 'secondary' for secondary (used for automated failover)
}

export class AlbConstruct extends Construct {
    public readonly loadBalancer: elbv2.ApplicationLoadBalancer;
    public readonly securityGroup: ec2.SecurityGroup;
    public readonly accessLogBucket?: s3.Bucket;
    public httpsListener: elbv2.ApplicationListener;
    private readonly environmentName: string;

    constructor(scope: Construct, id: string, props: AlbConstructProps) {
        super(scope, id);

        this.environmentName = props.environment;

        const {
            vpc,
            customDomain,
            hostedZoneId,
            hostedZoneName,
            certificateArn,
            mtlsTrustStoreArn,
            webAclArn,
            enableAccessLogs = true,
            regionalSuffix = '',
        } = props;

        // Determine if this is primary (no suffix) or secondary (has suffix)
        const isPrimary = !regionalSuffix;

        // Security Group - Allow traffic from anywhere (WAF handles IP filtering)
        this.securityGroup = new ec2.SecurityGroup(this, 'AlbSecurityGroup', {
            vpc,
            description: 'Security group for Kong Data Plane ALB',
            allowAllOutbound: true,
        });

        // HTTPS port 443 (with mTLS)
        this.securityGroup.addIngressRule(
            ec2.Peer.anyIpv4(),
            ec2.Port.tcp(443),
            'Allow HTTPS with mTLS from anywhere (filtered by WAF)'
        );

        // Access Logs S3 Bucket
        if (enableAccessLogs) {
            this.accessLogBucket = new s3.Bucket(this, 'AccessLogBucket', {
                encryption: s3.BucketEncryption.S3_MANAGED,
                blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
                removalPolicy: cdk.RemovalPolicy.RETAIN,
                lifecycleRules: [
                    {
                        expiration: cdk.Duration.days(30),
                    },
                ],
            });
        }

        // Application Load Balancer
        this.loadBalancer = new elbv2.ApplicationLoadBalancer(this, 'LoadBalancer', {
            vpc,
            internetFacing: true,
            securityGroup: this.securityGroup,
            loadBalancerName: `kong-alb-${this.environmentName}`,
        });

        // Enable access logs
        if (this.accessLogBucket) {
            this.loadBalancer.logAccessLogs(this.accessLogBucket);
        }

        // Associate WAF if provided
        if (webAclArn) {
            new wafv2.CfnWebACLAssociation(this, 'WebAclAssociation', {
                resourceArn: this.loadBalancer.loadBalancerArn,
                webAclArn,
            });
        }

        // Create HTTPS Listeners (without default target groups - will be added by service stacks)
        this.createHttpsListeners(certificateArn!, mtlsTrustStoreArn);

        // Create Route 53 health check for primary region ALB (for automated failover)
        let healthCheckId: string | undefined;
        if (isPrimary && customDomain && (hostedZoneId || hostedZoneName)) {
            const healthCheck = new route53.CfnHealthCheck(this, 'AlbHealthCheck', {
                healthCheckConfig: {
                    type: 'HTTPS',
                    fullyQualifiedDomainName: customDomain,
                    port: 443,
                    resourcePath: '/health',
                    requestInterval: 30,
                    failureThreshold: 3,
                },
                healthCheckTags: [
                    {
                        key: 'Name',
                        value: `${customDomain}-alb-primary-health-check`,
                    },
                ],
            });
            healthCheckId = healthCheck.attrHealthCheckId;
        }

        // Create Route 53 DNS record with automated failover routing for ALB
        // Primary region uses FAILOVER PRIMARY with health check
        // Secondary region uses FAILOVER SECONDARY (activated when primary fails)
        if (customDomain && (hostedZoneId || hostedZoneName)) {
            const hostedZone = hostedZoneId
                ? route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
                      hostedZoneId,
                      zoneName: hostedZoneName || customDomain,
                  })
                : route53.HostedZone.fromLookup(this, 'HostedZone', {
                      domainName: hostedZoneName || customDomain,
                  });

            // Determine if this is an apex domain or subdomain
            const zoneName = hostedZoneName || customDomain;
            const isApexDomain = customDomain === zoneName;
            const recordName = isApexDomain ? zoneName : customDomain;

            // Use CfnRecordSet (L1) for failover routing support
            new route53.CfnRecordSet(this, 'AlbAliasRecord', {
                hostedZoneId: hostedZone.hostedZoneId,
                name: recordName,
                type: 'A',
                setIdentifier: isPrimary ? 'ALB-Primary' : 'ALB-Secondary',
                failover: isPrimary ? 'PRIMARY' : 'SECONDARY',
                healthCheckId: healthCheckId,
                aliasTarget: {
                    hostedZoneId: this.loadBalancer.loadBalancerCanonicalHostedZoneId,
                    dnsName: this.loadBalancer.loadBalancerDnsName,
                    evaluateTargetHealth: false, // Use Route53 health check instead
                },
            });
        }

        // Outputs
        new cdk.CfnOutput(this, 'LoadBalancerDnsName', {
            value: this.loadBalancer.loadBalancerDnsName,
            description: 'ALB DNS Name',
        });

        new cdk.CfnOutput(this, 'LoadBalancerArn', {
            value: this.loadBalancer.loadBalancerArn,
            description: 'ALB ARN',
        });

        // Output health check ID for primary region
        if (healthCheckId) {
            new cdk.CfnOutput(this, 'AlbHealthCheckId', {
                value: healthCheckId,
                description: 'Route53 Health Check ID for ALB (Primary Region)',
            });
        }

        new cdk.CfnOutput(this, 'AlbFailoverType', {
            value: isPrimary ? 'PRIMARY' : 'SECONDARY',
            description: 'Route53 Failover Type for ALB',
        });
    }

    private createHttpsListeners(certificateArn: string, mtlsTrustStoreArn?: string) {
        const defaultAction = elbv2.ListenerAction.fixedResponse(404, {
            contentType: 'text/plain',
            messageBody: 'Not Found - No matching path rule',
        });

        // Port 443: HTTPS Listener with mTLS for direct client access
        this.httpsListener = this.loadBalancer.addListener('HttpsMtlsListener', {
            port: 443,
            protocol: elbv2.ApplicationProtocol.HTTPS,
            certificates: [elbv2.ListenerCertificate.fromArn(certificateArn)],
            defaultAction,
        });

        // Add mTLS configuration if trust store is provided
        if (mtlsTrustStoreArn) {
            const cfnListener = this.httpsListener.node.defaultChild as elbv2.CfnListener;
            cfnListener.mutualAuthentication = {
                mode: 'verify',
                trustStoreArn: mtlsTrustStoreArn,
            };
        }
    }
}
