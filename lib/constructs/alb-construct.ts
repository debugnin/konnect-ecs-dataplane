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
        } = props;

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

        // Create Route 53 alias record for the ALB
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

            new route53.ARecord(this, 'AlbAliasRecord', {
                zone: hostedZone,
                recordName,
                target: route53.RecordTarget.fromAlias(
                    new route53targets.LoadBalancerTarget(this.loadBalancer)
                ),
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
