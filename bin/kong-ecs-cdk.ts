#!/usr/bin/env node

import * as cdk from 'aws-cdk-lib';
import { KongServiceStack } from '../lib/kong-service-stack';
import { KongInfrastructureStack } from '../lib/kong-infrastructure-stack';

const app = new cdk.App();

// Get environment for naming conventions
// Environment examples: dev, qa, uat, prd
const environment = app.node.tryGetContext('environment') || process.env.ENVIRONMENT;
if (!environment) {
    throw new Error('ENVIRONMENT is required (examples: dev, qa, uat, prd)');
}

// Service configuration - can specify multiple services
// Note: appName is used as the system identifier in resource naming
interface ServiceConfig {
    appName: string;
    pathPrefix: string;
    secretArn: string;
    cpu?: number;
    memory?: number;
    replicas?: number;
    logLevel?: string;
    imageUri?: string;
}

// Default Kong image applied to all services unless overridden by SERVICE{N}_IMAGE_URI
const defaultKongImage =
    app.node.tryGetContext('defaultKongImage') || process.env.KONG_DEFAULT_IMAGE;

// Parse services from environment or context
// Format: SERVICE1_NAME=customers,SERVICE1_PATH=/customers,SERVICE1_SECRET_ARN=arn:...,SERVICE2_NAME=...
const services: ServiceConfig[] = [];
for (let serviceIndex = 1; serviceIndex <= 100; serviceIndex++) {
    const serviceName =
        app.node.tryGetContext(`service${serviceIndex}Name`) ||
        process.env[`SERVICE${serviceIndex}_NAME`];
    const pathPrefix =
        app.node.tryGetContext(`service${serviceIndex}Path`) ||
        process.env[`SERVICE${serviceIndex}_PATH`];
    const secretArn =
        app.node.tryGetContext(`service${serviceIndex}SecretArn`) ||
        process.env[`SERVICE${serviceIndex}_SECRET_ARN`];

    if (!serviceName || !pathPrefix || !secretArn) {
        continue;
    }

    services.push({
        appName: serviceName,
        pathPrefix,
        secretArn,
        cpu: Number(
            app.node.tryGetContext(`service${serviceIndex}Cpu`) ||
                process.env[`SERVICE${serviceIndex}_CPU`] ||
                512
        ),
        memory: Number(
            app.node.tryGetContext(`service${serviceIndex}Memory`) ||
                process.env[`SERVICE${serviceIndex}_MEMORY`] ||
                1024
        ),
        replicas: Number(
            app.node.tryGetContext(`service${serviceIndex}Replicas`) ||
                process.env[`SERVICE${serviceIndex}_REPLICAS`] ||
                2
        ),
        logLevel:
            app.node.tryGetContext(`service${serviceIndex}LogLevel`) ||
            process.env[`SERVICE${serviceIndex}_LOG_LEVEL`] ||
            undefined,
        imageUri: (() => {
            const uri =
                app.node.tryGetContext(`service${serviceIndex}ImageUri`) ||
                process.env[`SERVICE${serviceIndex}_IMAGE_URI`] ||
                defaultKongImage;
            if (!uri) {
                throw new Error(
                    `Container image is required for service ${serviceIndex}. ` +
                        `Set KONG_DEFAULT_IMAGE or SERVICE${serviceIndex}_IMAGE_URI.`
                );
            }
            return uri;
        })(),
    });
}

if (services.length === 0) {
    throw new Error(
        'At least one service must be configured. Set SERVICE1_NAME, SERVICE1_PATH, and SERVICE1_SECRET_ARN'
    );
}

// Parameterise stack names following naming convention
// Infrastructure is shared, so use "kong" as the system name
// Service stacks use the appName as the system identifier
const regionalSuffix =
    app.node.tryGetContext('regionalSuffix') || process.env.REGIONAL_SUFFIX || '';
const infraStackName = regionalSuffix
    ? `kong-infra-stack-${environment}-${regionalSuffix}`
    : `kong-infra-stack-${environment}`;

const env = {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
};

const qualifier = app.node.tryGetContext('qualifier') || process.env.CDK_QUALIFIER;
const synthesizer = qualifier
    ? new cdk.DefaultStackSynthesizer({ qualifier })
    : undefined;

const albDomain = app.node.tryGetContext('albDomain') || process.env.ALB_DOMAIN;

// Deploy infrastructure stack (VPC, ALB, WAF)
// Note: IAM roles are now managed centrally in the kong-iam project.
// Provide role ARNs via environment variables or CDK context.
const infraStack = new KongInfrastructureStack(app, infraStackName, {
    env,
    ...(synthesizer && { synthesizer }),
    environment,
    vpc: {
        vpcCidr: app.node.tryGetContext('vpcCidr') || process.env.VPC_CIDR,
        maxAzs: Number(
            app.node.tryGetContext('vpcMaxAzs') || process.env.VPC_MAX_AZS || 2
        ),
        natGateways: Number(
            app.node.tryGetContext('vpcNatGateways') || process.env.VPC_NAT_GATEWAYS || 1
        ),
        enableFlowLogs:
            (app.node.tryGetContext('vpcEnableFlowLogs') ||
                process.env.VPC_ENABLE_FLOW_LOGS ||
                'true') === 'true',
        enableVpcEndpoints:
            (app.node.tryGetContext('vpcEnableEndpoints') ||
                process.env.VPC_ENABLE_ENDPOINTS ||
                'true') === 'true',
        transitGatewayId:
            app.node.tryGetContext('transitGatewayId') || process.env.TRANSIT_GATEWAY_ID,
        transitGatewayRoutes: (
            app.node.tryGetContext('transitGatewayRoutes') ||
            process.env.TRANSIT_GATEWAY_ROUTES ||
            ''
        )
            .split(',')
            .map((cidr: string) => cidr.trim())
            .filter((cidr: string) => cidr.length > 0),
    },
    certificate: albDomain
        ? {
              domainName: albDomain,
              subjectAlternativeNames: (
                  app.node.tryGetContext('albSubjectAlternativeNames') ||
                  process.env.ALB_SUBJECT_ALTERNATIVE_NAMES ||
                  ''
              )
                  .split(',')
                  .map((name: string) => name.trim())
                  .filter((name: string) => name.length > 0),
              hostedZoneId:
                  app.node.tryGetContext('albHostedZoneId') ||
                  process.env.ALB_HOSTED_ZONE_ID,
              hostedZoneName:
                  app.node.tryGetContext('albHostedZoneName') ||
                  process.env.ALB_HOSTED_ZONE_NAME,
          }
        : undefined,
    waf: {
        enabled:
            (app.node.tryGetContext('wafEnabled') ||
                process.env.WAF_ENABLED ||
                'true') === 'true',
        rateLimitPerMinute: Number(
            app.node.tryGetContext('wafRateLimit') || process.env.WAF_RATE_LIMIT || 2000
        ),
        allowedCidrs: (
            app.node.tryGetContext('wafAllowedCidrs') ||
            process.env.WAF_ALLOWED_CIDRS ||
            ''
        )
            .split(',')
            .map((cidr: string) => cidr.trim())
            .filter((cidr: string) => cidr.length > 0),
        enableCidrRestriction:
            (app.node.tryGetContext('wafEnableCidrRestriction') ||
                process.env.WAF_ENABLE_CIDR_RESTRICTION ||
                'true') === 'true',
    },
    alb: {
        mtlsTrustStoreArn:
            app.node.tryGetContext('mtlsTrustStoreArn') ||
            process.env.MTLS_TRUST_STORE_ARN,
        enableAccessLogs:
            (app.node.tryGetContext('albEnableAccessLogs') ||
                process.env.ALB_ENABLE_ACCESS_LOGS ||
                'true') === 'true',
    },
    logging: {
        enabled:
            (app.node.tryGetContext('loggingEnabled') ||
                process.env.LOGGING_ENABLED ||
                'true') === 'true',
        centralDestinationArn:
            app.node.tryGetContext('loggingCentralDestinationArn') ||
            process.env.LOGGING_CENTRAL_DESTINATION_ARN,
        logGroupNames: (
            app.node.tryGetContext('loggingLogGroupNames') ||
            process.env.LOGGING_LOG_GROUP_NAMES ||
            ''
        )
            .split(',')
            .map((name: string) => name.trim())
            .filter((name: string) => name.length > 0),
        filterPattern:
            app.node.tryGetContext('loggingFilterPattern') ||
            process.env.LOGGING_FILTER_PATTERN,
    },
});

// Deploy service stacks (depends on infrastructure stack)
const serviceStacks: KongServiceStack[] = [];

services.forEach((service, index) => {
    const serviceStackName = regionalSuffix
        ? `kong-${service.appName}-service-stack-${environment}-${regionalSuffix}`
        : `kong-${service.appName}-service-stack-${environment}`;

    if (!infraStack.albConstruct.httpsListener) {
        throw new Error(
            'HTTPS listener (port 443) is required - certificate must be provided'
        );
    }

    const mtlsListenerArn = infraStack.albConstruct.httpsListener.listenerArn;

    const serviceStack = new KongServiceStack(app, serviceStackName, {
        env,
        ...(synthesizer && { synthesizer }),
        system: service.appName,
        environment,
        appName: service.appName,
        pathPrefix: service.pathPrefix,
        konnectControlPlaneSecretArn: service.secretArn,
        vpc: infraStack.vpcConstruct.vpc,
        mtlsListenerArn,
        albSecurityGroupId: infraStack.albConstruct.securityGroup.securityGroupId,
        kongLogLevel: service.logLevel || 'notice',
        dataPlane: {
            cpu: service.cpu,
            memoryMiB: service.memory,
            replicas: service.replicas,
            imageUri: service.imageUri,
        },
        logging: {
            enabled:
                (app.node.tryGetContext('loggingEnabled') ||
                    process.env.LOGGING_ENABLED ||
                    'true') === 'true',
            centralDestinationArn:
                app.node.tryGetContext('loggingCentralDestinationArn') ||
                process.env.LOGGING_CENTRAL_DESTINATION_ARN,
            filterPattern:
                app.node.tryGetContext('loggingFilterPattern') ||
                process.env.LOGGING_FILTER_PATTERN,
        },
        dpResilience: {
            enabled:
                (app.node.tryGetContext('dpResilienceEnabled') ||
                    process.env.DP_RESILIENCE_ENABLED ||
                    'true') === 'true',
        },
        redis: {
            enabled:
                (app.node.tryGetContext(`service${index + 1}RedisEnabled`) ||
                    process.env[`SERVICE${index + 1}_REDIS_ENABLED`] ||
                    'false') === 'true',
            nodeType:
                app.node.tryGetContext(`service${index + 1}RedisNodeType`) ||
                process.env[`SERVICE${index + 1}_REDIS_NODE_TYPE`] ||
                'cache.t4g.micro',
            numCacheNodes: Number(
                app.node.tryGetContext(`service${index + 1}RedisNumCacheNodes`) ||
                    process.env[`SERVICE${index + 1}_REDIS_NUM_CACHE_NODES`] ||
                    1
            ),
            engineVersion:
                app.node.tryGetContext(`service${index + 1}RedisEngineVersion`) ||
                process.env[`SERVICE${index + 1}_REDIS_ENGINE_VERSION`] ||
                '7.0',
            parameterGroupFamily:
                app.node.tryGetContext(`service${index + 1}RedisParameterGroupFamily`) ||
                process.env[`SERVICE${index + 1}_REDIS_PARAMETER_GROUP_FAMILY`] ||
                'redis7',
            encryptionAtRest:
                (app.node.tryGetContext(`service${index + 1}RedisEncryptionAtRest`) ||
                    process.env[`SERVICE${index + 1}_REDIS_ENCRYPTION_AT_REST`] ||
                    'true') === 'true',
            encryptionInTransit:
                (app.node.tryGetContext(`service${index + 1}RedisEncryptionInTransit`) ||
                    process.env[`SERVICE${index + 1}_REDIS_ENCRYPTION_IN_TRANSIT`] ||
                    'true') === 'true',
            multiAz:
                (app.node.tryGetContext(`service${index + 1}RedisMultiAz`) ||
                    process.env[`SERVICE${index + 1}_REDIS_MULTI_AZ`] ||
                    'false') === 'true',
            authToken:
                app.node.tryGetContext(`service${index + 1}RedisAuthToken`) ||
                process.env[`SERVICE${index + 1}_REDIS_AUTH_TOKEN`],
            snapshotRetentionDays: Number(
                app.node.tryGetContext(`service${index + 1}RedisSnapshotRetentionDays`) ||
                    process.env[`SERVICE${index + 1}_REDIS_SNAPSHOT_RETENTION_DAYS`] ||
                    5
            ),
            snapshotWindow:
                app.node.tryGetContext(`service${index + 1}RedisSnapshotWindow`) ||
                process.env[`SERVICE${index + 1}_REDIS_SNAPSHOT_WINDOW`] ||
                '03:00-05:00',
            maintenanceWindow:
                app.node.tryGetContext(`service${index + 1}RedisMaintenanceWindow`) ||
                process.env[`SERVICE${index + 1}_REDIS_MAINTENANCE_WINDOW`] ||
                'sun:05:00-sun:07:00',
        },
    });

    // Service stack depends on infrastructure stack
    serviceStack.addDependency(infraStack);
    serviceStacks.push(serviceStack);
});
