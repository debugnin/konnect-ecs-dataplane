# Naming Convention Implementation - Change Summary

## Overview

This document summarizes all changes made to implement naming conventions across the Kong Data Plane CDK project.

## Latest Update (March 16, 2026): WAF CIDR Restriction

### Feature Addition: Configurable CIDR-Based Access Control

Added support for restricting access to the Kong Data Plane using AWS WAF IP sets. This allows administrators to define an allowlist of IP address ranges (CIDRs) that can access the infrastructure.

### Changes Made

#### Code Changes:

- ✅ **WAF Construct** (`lib/constructs/waf-construct.ts`):
    - Added `allowedCidrs` parameter to accept list of CIDR blocks
    - Added `enableCidrRestriction` parameter to enable/disable IP allowlist
    - Created IP Set resource when CIDR restriction is enabled
    - Added WAF rule with highest priority to allow traffic from IP Set
    - Changed default action to "Block" when CIDR restriction is enabled
    - Exported IP Set ARN in CloudFormation outputs

- ✅ **Infrastructure Stack** (`lib/kong-infrastructure-stack.ts`):
    - Updated `KongInfrastructureStackProps` interface to include WAF CIDR parameters
    - Passed CIDR configuration to ALB WAF construct

- ✅ **CDK App** (`bin/kong-ecs-cdk.ts`):
    - Added environment variable parsing for `WAF_ALLOWED_CIDRS` (comma-separated)
    - Added environment variable parsing for `WAF_ENABLE_CIDR_RESTRICTION` (boolean)
    - Passed configuration to Infrastructure stack

- ✅ **Bitbucket Pipeline** (`bitbucket-pipelines.yml`):
    - Added inline comments explaining how to configure CIDR restriction
    - Documented environment variable usage

#### Documentation:

- ✅ **README.md**:
    - Added `WAF_ALLOWED_CIDRS` and `WAF_ENABLE_CIDR_RESTRICTION` to environment variables table
    - Added "WAF CIDR Restriction" section in Security with examples
    - Added link to detailed WAF configuration guide

- ✅ **WAF_CONFIGURATION.md** (NEW):
    - Comprehensive guide to WAF configuration
    - Detailed CIDR restriction setup instructions
    - Configuration examples for different use cases
    - Verification and testing procedures
    - Troubleshooting section
    - Cost considerations
    - Best practices

### New Environment Variables

| Variable                      | Description                           | Default | Example                          |
| ----------------------------- | ------------------------------------- | ------- | -------------------------------- |
| `WAF_ALLOWED_CIDRS`           | Comma-separated list of allowed CIDRs | (empty) | `203.0.113.0/24,198.51.100.0/24` |
| `WAF_ENABLE_CIDR_RESTRICTION` | Enable CIDR-based access control      | `true`  | `true`, `false`                  |

### How It Works

When enabled (`WAF_ENABLE_CIDR_RESTRICTION=true`):

1. AWS WAF creates an IP Set containing the allowed CIDR blocks
2. A WAF rule is added with highest priority to ALLOW traffic from the IP Set
3. The WAF's default action changes to BLOCK (instead of ALLOW)
4. Traffic from non-allowlisted IPs receives 403 Forbidden
5. AWS Managed Rules and rate limiting still apply to allowed traffic

### Example Configuration

**Bitbucket Deployment Variables:**

```
WAF_ENABLE_CIDR_RESTRICTION = true
WAF_ALLOWED_CIDRS = 203.0.113.0/24,198.51.100.0/24,192.0.2.0/24
```

**Local Deployment:**

```bash
WAF_ENABLE_CIDR_RESTRICTION=true \
WAF_ALLOWED_CIDRS="10.0.0.0/8,172.16.0.0/12,192.168.0.0/16" \
npx cdk deploy --all
```

### Deployment Scope

This feature applies to:

- ✅ **ALB WAF** (Regional) - Protects Application Load Balancer
- ✅ **All Environments** (dev, qa, uat, prd)
- ✅ **Multi-Region Deployments** (Both primary and secondary regions)

---

## Previous Update (March 2026): Shared vs Service-Specific Naming

### Key Change

The SYSTEM parameter has been **removed from shared infrastructure**. The naming strategy now distinguishes between:

1. **Shared Infrastructure** (`kong-*`): Resources shared across all services (VPC, ALB, WAF, Metrics, Logging)
2. **Service-Specific Resources** (`<appName>-*`): Resources unique to each service (ECS clusters, services, target groups)

### Rationale

The shared infrastructure serves multiple applications/services. Using a service-specific system name (e.g., `customers-vpc-dev`) would incorrectly imply ownership by a single service. The `kong-` prefix clearly indicates these are shared Kong platform resources.

### Changes Made

#### Removed SYSTEM Parameter From:

- ✅ **VPC Construct**: Now uses `kong-vpc-${env}` instead of `${system}-vpc-${env}`
- ✅ **ALB Construct**: Now uses `kong-alb-${env}` instead of `${system}-kong-alb-${env}`
- ✅ **WAF Construct**: Now uses `kong-${component}-waf-${env}` instead of `${system}-${component}-waf-${env}`
- ✅ **Metrics Construct**: Firehose and logs now use `kong-metrics-*-${env}` pattern
- ✅ **Logging Construct**: IAM role now `kong-logstreaming-role-${env}`
- ✅ **Infrastructure Stack**: No longer requires or passes system parameter to constructs
- ✅ **Main CDK App**: Doesn't pass system to infrastructure stacks

#### Service-Specific Resources Still Use appName:

- ✅ **Service Stack**: Uses `SERVICE{N}_NAME` as system identifier
- ✅ **ECS Resources**: `${appName}-kong-ecscluster-${env}`, `${appName}-kong-ecsservice-${env}`
- ✅ **Target Groups**: `${appName}-kong-tg-${env}`
- ✅ **CloudWatch Logs**: `/aws/ecs/${appName}-kong-dp-logs-${env}`

### Updated Stack Names

| Stack Type           | Old Name                         | New Name                       |
| -------------------- | -------------------------------- | ------------------------------ |
| Infrastructure Stack | `${system}-kong-infra-stack`     | `kong-infra-stack`             |
| Service Stack        | `${system}-${serviceName}-stack` | `${serviceName}-service-stack` |

### Example Resource Names

**Before (with SYSTEM=customers):**

- VPC: `customers-vpc-dev`
- ALB: `customers-kong-alb-dev`
- ECS Cluster: `customers-api-ecscluster-dev`

**After:**

- VPC: `kong-vpc-dev` (shared)
- ALB: `kong-alb-dev` (shared)
- ECS Cluster: `customers-kong-ecscluster-dev` (service-specific, where "customers" is SERVICE1_NAME)

## Changes Made

### 1. Main CDK Application ([bin/kong-ecs-cdk.ts](bin/kong-ecs-cdk.ts))

- ✅ Added `SYSTEM` and `ENVIRONMENT` required parameters with validation
- ✅ Valid systems: customers, lpa, envd
- ✅ Valid environments: dev, qa, uat, prd
- ✅ Updated stack naming convention:
    - Global: `<system>-kong-global-stack`
    - Infrastructure: `<system>-kong-infra-stack[-regionalSuffix]`
    - Service: `<system>-<serviceName>-stack[-regionalSuffix]`
- ✅ Pass system and environment to all stacks

### 3. Infrastructure Stack ([lib/kong-infrastructure-stack.ts](lib/kong-infrastructure-stack.ts))

- ✅ Added system and environment to props interface
- ✅ Pass naming parameters to all constructs:
    - VPC
    - WAF (ALB)
    - ALB
    - Metrics
    - Logging
- ✅ Renamed internal properties to avoid conflict with base Stack class

### 4. Service Stack ([lib/kong-service-stack.ts](lib/kong-service-stack.ts))

- ✅ Added system and environment to props interface
- ✅ Updated resource names:
    - ECS Cluster: `<system>-<appName>-ecscluster-<env>`
    - ECS Service: `<system>-<appName>-ecsservice-<env>`
    - Backup Service: `<system>-<appName>-backup-ecsservice-<env>`
    - Target Group: `<system>-<appName>-tg-<env>`
    - Data Plane Logs: `/aws/ecs/<system>-<appName>-dp-logs-<env>`
    - Backup Logs: `/aws/ecs/<system>-<appName>-backup-logs-<env>`
- ✅ Pass naming parameters to constructs

### 5. VPC Construct ([lib/constructs/vpc-construct.ts](lib/constructs/vpc-construct.ts))

- ✅ Added system and environment to props interface
- ✅ Updated resource names:
    - VPC Tag: `<system>-vpc-<env>`
    - Flow Logs: `/aws/vpc/<system>-vpc-flowlogs-<env>`
    - TGW Attachment: `<system>-vpc-tgw-attachment-<env>`

### 6. ALB Construct ([lib/constructs/alb-construct.ts](lib/constructs/alb-construct.ts))

- ✅ Added system and environment to props interface
- ✅ Updated ALB name: `<system>-kong-alb-<env>`

### 7. WAF Construct ([lib/constructs/waf-construct.ts](lib/constructs/waf-construct.ts))

- ✅ Added system, environment, and component to props interface
- ✅ Updated resource names:
    - WAF WebACL: `<system>-<component>-waf-<env>`
    - Metric: `<system>-<component>-waf-metric-<env>`

### 9. Metrics Construct ([lib/constructs/metrics-construct.ts](lib/constructs/metrics-construct.ts))

- ✅ Added system and environment to props interface
- ✅ Updated resource names:
    - HTTP Logs: `/aws/kinesisfirehose/<system>-metrics-http-logs-<env>`
    - S3 Logs: `/aws/kinesisfirehose/<system>-metrics-s3backup-logs-<env>`
    - Firehose: `<system>-metrics-firehose-<env>`

### 10. Logging Construct ([lib/constructs/logging-construct.ts](lib/constructs/logging-construct.ts))

- ✅ Added system and environment to props interface
- ✅ Updated IAM role name: `<system>-logstreaming-role-<env>`

### 11. DP Resilience Construct ([lib/constructs/dp-resilience-construct.ts](lib/constructs/dp-resilience-construct.ts))

- ✅ Added system, environment, and component to props interface
- ✅ S3 bucket naming delegated to caller (must follow `<system>-<component>-s3-<env>` pattern)

## Documentation Created

### 1. NAMING_CONVENTIONS.md

Comprehensive guide covering:

- Overview of naming pattern
- Required environment variables
- Example usage
- Resource naming examples
- Multi-service deployment
- Multi-region deployment
- Migration strategy
- Validation

### 2. README.md Updates

- Added notice about naming convention requirements
- Link to NAMING_CONVENTIONS.md

### 3. DEPLOYMENT_GUIDE.md Updates

- Removed SYSTEM from required variables table
- Updated examples to remove SYSTEM references
- Clarified that SERVICE{N}\_NAME is used as system identifier
- Added link to NAMING_CONVENTIONS.md

## Breaking Changes

⚠️ **Important**: These changes introduce breaking changes requiring redeployment:

### Required Actions

1. **Update Environment Variables**:
    - Remove `SYSTEM` variable (no longer used for shared infrastructure)
    - Ensure `ENVIRONMENT` is set
    - Ensure `SERVICE{N}_NAME` variables are set (these become system identifiers for services)
2. **Stack Names Changed**: CloudFormation stack names follow new pattern (shared resources use `kong-` prefix)
3. **Resource Names Changed**: Shared infrastructure resources renamed with `kong-` prefix

### Migration Path

Since CloudFormation cannot rename most resources in place:

1. **Option A: Blue-Green Deployment** (Recommended)
    - Deploy new stacks with proper naming
    - Update DNS/routing to point to new resources
    - Verify functionality
    - Delete old stacks

2. **Option B: Complete Rebuild**
    - Document current configuration
    - Destroy old stacks
    - Deploy new stacks with proper naming

## Validation

All changes have been validated:

- ✅ TypeScript compilation successful (no errors)
- ✅ Property naming conflicts resolved (systemName/environmentName vs Stack.environment)
- ✅ All constructs updated to use new naming pattern (shared vs service-specific)
- ✅ Input validation added for ENVIRONMENT
- ✅ Shared infrastructure correctly uses `kong-` prefix
- ✅ Service-specific resources correctly use `SERVICE{N}_NAME` as system identifier

## Testing Checklist

Before deploying to production, verify:

- [ ] ENVIRONMENT environment variable set correctly
- [ ] All SERVICE{N}\_NAME, SERVICE{N}\_PATH, SERVICE{N}\_SECRET_ARN variables set
- [ ] CloudFormation synthesizes successfully: `npx cdk synth`
- [ ] Review generated resource names in synthesized templates:
    - [ ] Shared resources use `kong-*` prefix
    - [ ] Service resources use service name as prefix
- [ ] Deploy to development environment first
- [ ] Verify resource names match expected pattern
- [ ] Test functionality end-to-end
- [ ] Document any exceptions or deviations

## Compliance Checklist

✅ All naming convention items implemented:

- [x] Standard patterns: `kong-<component>-<resourcetype>-<env>` (shared) and `<appName>-<component>-<resourcetype>-<env>` (service-specific)
- [x] Environment abbreviations: dev, qa, uat, prd
- [x] Lowercase letters, numbers, and hyphens
- [x] VPC resources follow pattern (shared: `kong-vpc-${env}`)
- [x] ALB resources follow pattern (shared: `kong-alb-${env}`)
- [x] ECS resources follow pattern (service-specific: `${appName}-kong-ecscluster-${env}`)
- [x] CloudWatch Logs follow pattern (both shared and service-specific)
- [x] IAM roles follow pattern (shared: `kong-logstreaming-role-${env}`)
- [x] CloudFormation stacks follow pattern (shared: `kong-*-stack`, service: `${appName}-service-stack`)
- [x] S3 buckets follow pattern (when specified, service-specific)
- [x] WAF resources follow pattern (shared: `kong-${component}-waf-${env}`)
- [x] Kinesis Firehose follows pattern (shared: `kong-metrics-firehose-${env}`)

## Files Modified

### Core CDK Files

- [bin/kong-ecs-cdk.ts](bin/kong-ecs-cdk.ts)
- [lib/kong-infrastructure-stack.ts](lib/kong-infrastructure-stack.ts)
- [lib/kong-service-stack.ts](lib/kong-service-stack.ts)

### Construct Files

- [lib/constructs/vpc-construct.ts](lib/constructs/vpc-construct.ts)
- [lib/constructs/alb-construct.ts](lib/constructs/alb-construct.ts)
- [lib/constructs/waf-construct.ts](lib/constructs/waf-construct.ts)
- [lib/constructs/metrics-construct.ts](lib/constructs/metrics-construct.ts)
- [lib/constructs/logging-construct.ts](lib/constructs/logging-construct.ts)
- [lib/constructs/dp-resilience-construct.ts](lib/constructs/dp-resilience-construct.ts)

### Documentation Files

- [NAMING_CONVENTIONS.md](NAMING_CONVENTIONS.md) (NEW)
- [CHANGE_SUMMARY.md](CHANGE_SUMMARY.md) (THIS FILE)
- [README.md](README.md) (UPDATED)
- [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md) (UPDATED)

## Example Deployment

```bash
# Set naming convention parameter (only ENVIRONMENT needed)
export ENVIRONMENT=dev

# Set infrastructure parameters
export ALB_DOMAIN=kong-dev.example.com
export ALB_HOSTED_ZONE_ID=Z1234567890ABC
export ALB_HOSTED_ZONE_NAME=example.com

# Set service parameters (SERVICE{N}_NAME becomes the system identifier for that service)
export SERVICE1_NAME=customers
export SERVICE1_PATH=/customers
export SERVICE1_SECRET_ARN=arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:...

# Note: IAM roles are created automatically by the stacks

# Deploy
npx cdk deploy --all

# Expected stack names:
# - kong-infra-stack (shared)
# - customers-service-stack (service-specific)
#
# Expected resource names:
# Shared: kong-vpc-dev, kong-alb-dev, kong-metrics-firehose-dev
# Service: customers-kong-ecscluster-dev, customers-kong-ecsservice-dev
```

## Next Steps

1. Review this change summary
2. Update any CI/CD pipelines to:
    - Remove SYSTEM environment variable (no longer needed)
    - Ensure ENVIRONMENT variable is set
    - Ensure SERVICE{N}\_NAME variables are set (these become system identifiers)
3. Update any infrastructure-as-code automation
4. Schedule deployment to development environment
5. Test thoroughly in development
6. Plan production deployment with appropriate downtime window
7. Update team documentation and runbooks

## Support

For questions or issues:

- Review [NAMING_CONVENTIONS.md](NAMING_CONVENTIONS.md)
- Check examples in [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md)
- Contact platform team for assistance
