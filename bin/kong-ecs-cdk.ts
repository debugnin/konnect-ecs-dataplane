#!/usr/bin/env node

import * as cdk from 'aws-cdk-lib';
import { KongServiceStack } from '../lib/kong-service-stack';
import { KongInfrastructureStack } from '../lib/kong-infrastructure-stack';
import * as fs from 'fs';
import * as path from 'path';

const app = new cdk.App();

// Get environment for naming conventions
// Environment examples: dev, qa, uat, prd
const environment = app.node.tryGetContext('environment') || process.env.ENVIRONMENT;
if (!environment) {
    throw new Error('ENVIRONMENT is required (examples: dev, qa, uat, prd)');
}

// Load environment-specific configuration file
let config: Record<string, any> = {};
const configPath = path.join(__dirname, '..', 'config', `${environment}.json`);
if (fs.existsSync(configPath)) {
    const configFile = fs.readFileSync(configPath, 'utf8');
    config = JSON.parse(configFile);
    console.log(`✓ Loaded configuration from config/${environment}.json`);
} else {
    console.log(
        `⚠ No config file found at config/${environment}.json, using CDK context and environment variables`
    );
}

/**
 * Get configuration value with precedence:
 * 1. config/{environment}.json
 * 2. cdk.context.json (app.node.tryGetContext)
 * 3. Environment variables
 */
function getConfig(key: string, envVar?: string): any {
    return (
        config[key] ??
        app.node.tryGetContext(key) ??
        (envVar ? process.env[envVar] : undefined)
    );
}

// Service configuration - can specify multiple services
// Note: serviceName is used as the system identifier in resource naming
interface ServiceConfig {
    serviceName: string;
    pathPrefix: string;
    secretArn: string;
    cpu?: number;
    memory?: number;
    replicas?: number;
    logLevel?: string;
    imageUri?: string;
}

// Default Kong image applied to all services unless overridden by SERVICE{N}_IMAGE_URI
const defaultKongImage = getConfig('defaultKongImage', 'KONG_DEFAULT_IMAGE');

// Parse services from environment or context
// Format: SERVICE1_NAME=customers,SERVICE1_PATH=/customers,SERVICE1_SECRET_ARN=arn:...,SERVICE2_NAME=...
const services: ServiceConfig[] = [];
for (let serviceIndex = 1; serviceIndex <= 100; serviceIndex++) {
    const serviceName = getConfig(
        `service${serviceIndex}Name`,
        `SERVICE${serviceIndex}_NAME`
    );
    const pathPrefix = getConfig(
        `service${serviceIndex}Path`,
        `SERVICE${serviceIndex}_PATH`
    );
    const secretArn = getConfig(
        `service${serviceIndex}SecretArn`,
        `SERVICE${serviceIndex}_SECRET_ARN`
    );

    if (!serviceName || !pathPrefix || !secretArn) {
        continue;
    }

    services.push({
        serviceName: serviceName,
        pathPrefix,
        secretArn,
        cpu: Number(
            getConfig(`service${serviceIndex}Cpu`, `SERVICE${serviceIndex}_CPU`) || 512
        ),
        memory: Number(
            getConfig(`service${serviceIndex}Memory`, `SERVICE${serviceIndex}_MEMORY`) ||
                1024
        ),
        replicas: Number(
            getConfig(
                `service${serviceIndex}Replicas`,
                `SERVICE${serviceIndex}_REPLICAS`
            ) || 2
        ),
        logLevel:
            getConfig(
                `service${serviceIndex}LogLevel`,
                `SERVICE${serviceIndex}_LOG_LEVEL`
            ) || undefined,
        imageUri: (() => {
            const uri =
                getConfig(
                    `service${serviceIndex}ImageUri`,
                    `SERVICE${serviceIndex}_IMAGE_URI`
                ) || defaultKongImage;
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
// Service stacks use the serviceName as the system identifier
const regionalSuffix = getConfig('regionalSuffix', 'REGIONAL_SUFFIX') || '';
const infraStackName = regionalSuffix
    ? `kong-infra-stack-${environment}-${regionalSuffix}`
    : `kong-infra-stack-${environment}`;

const env = {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
};

const qualifier = getConfig('qualifier', 'CDK_QUALIFIER');
const synthesizer = qualifier
    ? new cdk.DefaultStackSynthesizer({ qualifier })
    : undefined;

const albDomain = getConfig('albDomain', 'ALB_DOMAIN');

// Deploy infrastructure stack (VPC, ALB, WAF)
// Note: IAM roles are now managed centrally in the kong-iam project.
// Provide role ARNs via environment variables or CDK context.
const infraStack = new KongInfrastructureStack(app, infraStackName, {
    env,
    ...(synthesizer && { synthesizer }),
    environment,
    vpc: {
        vpcCidr: getConfig('vpcCidr', 'VPC_CIDR'),
        maxAzs: Number(getConfig('vpcMaxAzs', 'VPC_MAX_AZS') || 2),
        natGateways: Number(getConfig('vpcNatGateways', 'VPC_NAT_GATEWAYS') || 1),
        enableFlowLogs:
            (getConfig('vpcEnableFlowLogs', 'VPC_ENABLE_FLOW_LOGS') || 'true') === 'true',
        enableVpcEndpoints:
            (getConfig('vpcEnableEndpoints', 'VPC_ENABLE_ENDPOINTS') || 'true') ===
            'true',
        transitGatewayId: getConfig('transitGatewayId', 'TRANSIT_GATEWAY_ID'),
        transitGatewayRoutes: (
            getConfig('transitGatewayRoutes', 'TRANSIT_GATEWAY_ROUTES') || ''
        )
            .split(',')
            .map((cidr: string) => cidr.trim())
            .filter((cidr: string) => cidr.length > 0),
        konnectPrivateLinkEnabled:
            (getConfig('konnectPrivateLinkEnabled', 'KONNECT_PRIVATELINK_ENABLED') || 'false') === 'true',
        konnectGeo: getConfig('konnectGeo', 'KONNECT_GEO'),
    },
    certificate: albDomain
        ? {
              domainName: albDomain,
              subjectAlternativeNames: (
                  getConfig(
                      'albSubjectAlternativeNames',
                      'ALB_SUBJECT_ALTERNATIVE_NAMES'
                  ) || ''
              )
                  .split(',')
                  .map((name: string) => name.trim())
                  .filter((name: string) => name.length > 0),
              hostedZoneId: getConfig('albHostedZoneId', 'ALB_HOSTED_ZONE_ID'),
              hostedZoneName: getConfig('albHostedZoneName', 'ALB_HOSTED_ZONE_NAME'),
          }
        : undefined,
    waf: {
        enabled: (getConfig('wafEnabled', 'WAF_ENABLED') || 'true') === 'true',
        rateLimitPerMinute: Number(getConfig('wafRateLimit', 'WAF_RATE_LIMIT') || 2000),
        allowedCidrs: (getConfig('wafAllowedCidrs', 'WAF_ALLOWED_CIDRS') || '')
            .split(',')
            .map((cidr: string) => cidr.trim())
            .filter((cidr: string) => cidr.length > 0),
        enableCidrRestriction:
            (getConfig('wafEnableCidrRestriction', 'WAF_ENABLE_CIDR_RESTRICTION') ||
                'true') === 'true',
    },
    alb: {
        mtlsTrustStoreArn: getConfig('mtlsTrustStoreArn', 'MTLS_TRUST_STORE_ARN'),
        enableAccessLogs:
            (getConfig('albEnableAccessLogs', 'ALB_ENABLE_ACCESS_LOGS') || 'true') ===
            'true',
    },
    logging: {
        enabled: (getConfig('loggingEnabled', 'LOGGING_ENABLED') || 'true') === 'true',
        centralDestinationArn: getConfig(
            'loggingCentralDestinationArn',
            'LOGGING_CENTRAL_DESTINATION_ARN'
        ),
        logGroupNames: (
            getConfig('loggingLogGroupNames', 'LOGGING_LOG_GROUP_NAMES') || ''
        )
            .split(',')
            .map((name: string) => name.trim())
            .filter((name: string) => name.length > 0),
        filterPattern: getConfig('loggingFilterPattern', 'LOGGING_FILTER_PATTERN'),
    },
});

// Deploy service stacks (depends on infrastructure stack)
const serviceStacks: KongServiceStack[] = [];

services.forEach((service, index) => {
    const serviceStackName = regionalSuffix
        ? `kong-service-stack-${service.serviceName}-${environment}-${regionalSuffix}`
        : `kong-service-stack-${service.serviceName}-${environment}`;

    if (!infraStack.albConstruct.httpsListener) {
        throw new Error(
            'HTTPS listener (port 443) is required - certificate must be provided'
        );
    }

    const mtlsListenerArn = infraStack.albConstruct.httpsListener.listenerArn;

    const serviceStack = new KongServiceStack(app, serviceStackName, {
        env,
        ...(synthesizer && { synthesizer }),
        system: service.serviceName,
        environment,
        serviceName: service.serviceName,
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
                (getConfig('loggingEnabled', 'LOGGING_ENABLED') || 'true') === 'true',
            centralDestinationArn: getConfig(
                'loggingCentralDestinationArn',
                'LOGGING_CENTRAL_DESTINATION_ARN'
            ),
            filterPattern: getConfig('loggingFilterPattern', 'LOGGING_FILTER_PATTERN'),
        },
        dpResilience: {
            enabled:
                (getConfig('dpResilienceEnabled', 'DP_RESILIENCE_ENABLED') || 'true') ===
                'true',
        },
        redis: {
            enabled:
                (getConfig(
                    `service${index + 1}RedisEnabled`,
                    `SERVICE${index + 1}_REDIS_ENABLED`
                ) || 'false') === 'true',
            nodeType:
                getConfig(
                    `service${index + 1}RedisNodeType`,
                    `SERVICE${index + 1}_REDIS_NODE_TYPE`
                ) || 'cache.t4g.micro',
            numCacheNodes: Number(
                getConfig(
                    `service${index + 1}RedisNumCacheNodes`,
                    `SERVICE${index + 1}_REDIS_NUM_CACHE_NODES`
                ) || 1
            ),
            engineVersion:
                getConfig(
                    `service${index + 1}RedisEngineVersion`,
                    `SERVICE${index + 1}_REDIS_ENGINE_VERSION`
                ) || '7.0',
            parameterGroupFamily:
                getConfig(
                    `service${index + 1}RedisParameterGroupFamily`,
                    `SERVICE${index + 1}_REDIS_PARAMETER_GROUP_FAMILY`
                ) || 'redis7',
            encryptionAtRest:
                (getConfig(
                    `service${index + 1}RedisEncryptionAtRest`,
                    `SERVICE${index + 1}_REDIS_ENCRYPTION_AT_REST`
                ) || 'true') === 'true',
            encryptionInTransit:
                (getConfig(
                    `service${index + 1}RedisEncryptionInTransit`,
                    `SERVICE${index + 1}_REDIS_ENCRYPTION_IN_TRANSIT`
                ) || 'true') === 'true',
            multiAz:
                (getConfig(
                    `service${index + 1}RedisMultiAz`,
                    `SERVICE${index + 1}_REDIS_MULTI_AZ`
                ) || 'false') === 'true',
            authToken: getConfig(
                `service${index + 1}RedisAuthToken`,
                `SERVICE${index + 1}_REDIS_AUTH_TOKEN`
            ),
            snapshotRetentionDays: Number(
                getConfig(
                    `service${index + 1}RedisSnapshotRetentionDays`,
                    `SERVICE${index + 1}_REDIS_SNAPSHOT_RETENTION_DAYS`
                ) || 5
            ),
            snapshotWindow:
                getConfig(
                    `service${index + 1}RedisSnapshotWindow`,
                    `SERVICE${index + 1}_REDIS_SNAPSHOT_WINDOW`
                ) || '03:00-05:00',
            maintenanceWindow:
                getConfig(
                    `service${index + 1}RedisMaintenanceWindow`,
                    `SERVICE${index + 1}_REDIS_MAINTENANCE_WINDOW`
                ) || 'sun:05:00-sun:07:00',
        },
    });

    // Service stack depends on infrastructure stack
    serviceStack.addDependency(infraStack);
    serviceStacks.push(serviceStack);
});
