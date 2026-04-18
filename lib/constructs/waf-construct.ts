import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import * as s3 from 'aws-cdk-lib/aws-s3';

export interface WafConstructProps {
    scope: 'REGIONAL';
    environment: string; // Environment: dev, qa, uat, prd
    component: string; // Component: alb, etc.
    enableLogging?: boolean;
    rateLimitPerMinute?: number;
    enableAWSManagedRules?: boolean;
    allowedCidrs?: string[]; // List of CIDR blocks to allow access from
    enableCidrRestriction?: boolean; // If true, only allow traffic from allowedCidrs
}

export class WafConstruct extends Construct {
    public readonly webAcl: wafv2.CfnWebACL;
    public readonly logBucket?: s3.Bucket;
    public readonly ipSet?: wafv2.CfnIPSet;
    private readonly environmentName: string;
    private readonly component: string;

    constructor(scope: Construct, id: string, props: WafConstructProps) {
        super(scope, id);

        this.environmentName = props.environment;
        this.component = props.component;

        const {
            scope: wafScope,
            enableLogging = true,
            rateLimitPerMinute = 2000,
            enableAWSManagedRules = true,
            allowedCidrs = [],
            enableCidrRestriction = false,
        } = props;

        const rules: wafv2.CfnWebACL.RuleProperty[] = [];
        let priority = 1;

        // IP Set for allowed CIDRs (if CIDR restriction is enabled)
        if (enableCidrRestriction && allowedCidrs.length > 0) {
            this.ipSet = new wafv2.CfnIPSet(this, 'AllowedCidrsIPSet', {
                scope: wafScope,
                ipAddressVersion: 'IPV4',
                addresses: allowedCidrs,
                name: `kong-${this.component}-allowed-cidrs-${this.environmentName}`,
                description: `Allowed CIDR blocks for Kong ${this.component} in ${this.environmentName}`,
            });

            const allowStatement: wafv2.CfnWebACL.StatementProperty = {
                ipSetReferenceStatement: {
                    arn: this.ipSet.attrArn,
                },
            };

            rules.push({
                name: 'AllowOnlyFromAllowedCidrs',
                priority: priority++,
                action: { allow: {} },
                statement: allowStatement,
                visibilityConfig: {
                    sampledRequestsEnabled: true,
                    cloudWatchMetricsEnabled: true,
                    metricName: 'AllowedCidrsRuleMetric',
                },
            });
        }

        // AWS Managed Rules
        if (enableAWSManagedRules) {
            // Core Rule Set
            rules.push({
                name: 'AWSManagedRulesCommonRuleSet',
                priority: priority++,
                overrideAction: { none: {} },
                statement: {
                    managedRuleGroupStatement: {
                        vendorName: 'AWS',
                        name: 'AWSManagedRulesCommonRuleSet',
                    },
                },
                visibilityConfig: {
                    sampledRequestsEnabled: true,
                    cloudWatchMetricsEnabled: true,
                    metricName: 'CommonRuleSetMetric',
                },
            });

            // Known Bad Inputs
            rules.push({
                name: 'AWSManagedRulesKnownBadInputsRuleSet',
                priority: priority++,
                overrideAction: { none: {} },
                statement: {
                    managedRuleGroupStatement: {
                        vendorName: 'AWS',
                        name: 'AWSManagedRulesKnownBadInputsRuleSet',
                    },
                },
                visibilityConfig: {
                    sampledRequestsEnabled: true,
                    cloudWatchMetricsEnabled: true,
                    metricName: 'KnownBadInputsRuleSetMetric',
                },
            });

            // IP Reputation
            rules.push({
                name: 'AWSManagedRulesAmazonIpReputationList',
                priority: priority++,
                overrideAction: { none: {} },
                statement: {
                    managedRuleGroupStatement: {
                        vendorName: 'AWS',
                        name: 'AWSManagedRulesAmazonIpReputationList',
                    },
                },
                visibilityConfig: {
                    sampledRequestsEnabled: true,
                    cloudWatchMetricsEnabled: true,
                    metricName: 'IpReputationListMetric',
                },
            });
        }

        // Rate Limiting
        rules.push({
            name: 'RateLimitRule',
            priority: priority++,
            action: {
                block: {
                    customResponse: {
                        responseCode: 429,
                        customResponseBodyKey: 'RateLimitResponse',
                    },
                },
            },
            statement: {
                rateBasedStatement: {
                    limit: rateLimitPerMinute,
                    aggregateKeyType: 'IP',
                },
            },
            visibilityConfig: {
                sampledRequestsEnabled: true,
                cloudWatchMetricsEnabled: true,
                metricName: 'RateLimitRuleMetric',
            },
        });

        // Create Web ACL
        // Default action: Block if CIDR restriction is enabled, Allow otherwise
        const defaultAction =
            enableCidrRestriction && allowedCidrs.length > 0
                ? {
                      block: {
                          customResponse: {
                              responseCode: 403,
                              customResponseBodyKey: 'BlockedIPResponse',
                          },
                      },
                  }
                : { allow: {} };

        this.webAcl = new wafv2.CfnWebACL(this, 'WebAcl', {
            scope: wafScope,
            defaultAction,
            rules,
            customResponseBodies: {
                BlockedIPResponse: {
                    contentType: 'APPLICATION_JSON',
                    content: JSON.stringify({
                        error: 'Forbidden',
                        message:
                            'Access denied. Your IP address is not authorized to access this resource.',
                        statusCode: 403,
                    }),
                },
                RateLimitResponse: {
                    contentType: 'APPLICATION_JSON',
                    content: JSON.stringify({
                        error: 'Too Many Requests',
                        message: 'Rate limit exceeded. Please try again later.',
                        statusCode: 429,
                    }),
                },
            },
            visibilityConfig: {
                sampledRequestsEnabled: true,
                cloudWatchMetricsEnabled: true,
                metricName: `kong-${this.component}-waf-metric-${this.environmentName}`,
            },
            name: `kong-${this.component}-waf-${this.environmentName}`,
            description: `WAF for Kong ${this.component} in ${this.environmentName}`,
        });

        // WAF Logging
        if (enableLogging) {
            this.logBucket = new s3.Bucket(this, 'WafLogBucket', {
                bucketName: `aws-waf-logs-kong-${this.component}-${this.environmentName}-${cdk.Aws.ACCOUNT_ID}`,
                removalPolicy: cdk.RemovalPolicy.DESTROY,
                autoDeleteObjects: false,
                encryption: s3.BucketEncryption.S3_MANAGED,
                blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
                lifecycleRules: [
                    {
                        expiration: cdk.Duration.days(30),
                    },
                ],
            });

            new wafv2.CfnLoggingConfiguration(this, 'WafLogging', {
                resourceArn: this.webAcl.attrArn,
                logDestinationConfigs: [`arn:aws:s3:::${this.logBucket.bucketName}`],
            });
        }

        // Outputs
        new cdk.CfnOutput(this, 'WebAclArn', {
            value: this.webAcl.attrArn,
            description: 'WAF Web ACL ARN',
        });

        new cdk.CfnOutput(this, 'WebAclId', {
            value: this.webAcl.attrId,
            description: 'WAF Web ACL ID',
        });

        if (this.ipSet) {
            new cdk.CfnOutput(this, 'IPSetArn', {
                value: this.ipSet.attrArn,
                description: 'WAF IP Set ARN for allowed CIDRs',
            });
        }
    }
}
