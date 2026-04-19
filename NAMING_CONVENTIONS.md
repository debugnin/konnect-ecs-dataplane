# Naming Conventions Implementation

This document explains the naming conventions implemented in this CDK project.

## Overview

Cloud resources follow a dual naming pattern:

### Shared Infrastructure Resources

Shared infrastructure (VPC, ALB, WAF, Metrics, Logging) uses the pattern:

```
kong-<component>-<resourcetype>-<env>
```

### Service-Specific Resources

Service-specific resources (ECS clusters, services, target groups) use the pattern:

```
<serviceName>-<component>-<resourcetype>-<env>
```

Where:

- **serviceName**: Service/application name from SERVICE{N}\_NAME (e.g., customers, bookings)
- **component**: Logical component or service name
- **resourcetype**: Cloud-native resource type (ec2, lambda, s3, rds, vpc, sqs, sns, etc.)
- **env**: Environment (dev, qa, uat, prd)

## Required Environment Variables

One required environment variable must be set:

### ENVIRONMENT

Deployment environment. Valid values:

- `dev` - Development
- `qa` - Quality assurance / testing
- `uat` - User acceptance testing
- `prd` - Production

## Example Usage

### Basic Deployment

```bash
export ENVIRONMENT=dev

# Configure service (serviceName becomes the system identifier)
export SERVICE1_NAME="customers"
export SERVICE1_PATH="/customers"
export SERVICE1_SECRET_ARN="arn:aws:secretsmanager:..."

# Deploy
npx cdk deploy --all
```

### Multi-Environment Deployment

```bash
# Development
export ENVIRONMENT=dev
export SERVICE1_NAME="customers"
export SERVICE1_PATH="/customers"
export SERVICE1_SECRET_ARN="..."
npx cdk deploy --all

# Production
export ENVIRONMENT=prd
export SERVICE1_NAME="customers"
export SERVICE1_PATH="/customers"
export SERVICE1_SECRET_ARN="..."
npx cdk deploy --all
```

## Resource Naming Examples

Based on the configuration `ENVIRONMENT=dev` and `SERVICE1_NAME=customers`:

### CloudFormation Stacks

- Infrastructure Stack: `kong-infra-stack` (shared)
- Service Stack: `customers-service-stack` (service-specific)

### Shared Infrastructure Resources

#### VPC Resources

- VPC Tag: `kong-vpc-dev`
- VPC Flow Logs: `/aws/vpc/kong-vpc-flowlogs-dev`
- Transit Gateway Attachment: `kong-vpc-tgw-attachment-dev`

#### Load Balancer

- ALB Name: `kong-alb-dev`

#### WAF

- ALB WAF: `kong-alb-waf-dev`

#### Kinesis Firehose

- Metrics Stream: `kong-metrics-firehose-dev`

#### CloudWatch Logs (Shared)

- Metrics HTTP Logs: `/aws/kinesisfirehose/kong-metrics-http-logs-dev`
- Metrics S3 Logs: `/aws/kinesisfirehose/kong-metrics-s3backup-logs-dev`

#### IAM Roles (Shared)

- Log Streaming Role: `kong-logstreaming-role-dev`

### Service-Specific Resources

#### ECS Resources

- Cluster: `customers-kong-ecscluster-dev`
- Service: `customers-kong-ecsservice-dev`
- Backup Service: `customers-api-backup-ecsservice-dev`
- Target Group: `customers-api-tg-dev`

### CloudWatch Logs

- Data Plane Logs: `/aws/ecs/customers-api-dp-logs-dev`
- Backup Logs: `/aws/ecs/customers-api-backup-logs-dev`
- Metrics HTTP Logs: `/aws/kinesisfirehose/customers-metrics-http-logs-dev`
- Metrics S3 Logs: `/aws/kinesisfirehose/customers-metrics-s3backup-logs-dev`

### Kinesis Firehose

- Metrics Stream: `customers-metrics-firehose-dev`

### IAM Roles

- Log Streaming Role: `customers-logstreaming-role-dev`

## Multi-Service Deployment

When deploying multiple services, each service uses SERVICE{N}\_NAME as its system identifier:

```bash
export ENVIRONMENT=prd

# Service 1: Customers
export SERVICE1_NAME="customers"
export SERVICE1_PATH="/customers"
export SERVICE1_SECRET_ARN="..."

# Service 2: Bookings
export SERVICE2_NAME="bookings"
export SERVICE2_PATH="/bookings"
export SERVICE2_SECRET_ARN="..."

npx cdk deploy --all
```

This creates:

**Shared Infrastructure** (one set for all services):

- Stacks: `kong-infra-stack`
- VPC: `kong-vpc-prd`
- ALB: `kong-alb-prd`
- WAF: `kong-alb-waf-prd`

**Service-Specific Resources** (per service):

- Stacks: `customers-service-stack` and `bookings-service-stack`
- ECS Clusters: `customers-kong-ecscluster-prd` and `bookings-kong-ecscluster-prd`
- Target Groups: `customers-kong-tg-prd` and `bookings-kong-tg-prd`

## Multi-Region Deployment

For multi-region deployments with failover:

```bash
# Primary region (Sydney)
export ENVIRONMENT=prd
export SERVICE1_NAME="customers"
export SERVICE1_PATH="/customers"
export SERVICE1_SECRET_ARN="..."
export REGIONAL_SUFFIX=""
npx cdk deploy --all

# Secondary region (Melbourne)
export ENVIRONMENT=prd
export SERVICE1_NAME="customers"
export SERVICE1_PATH="/customers"
export SERVICE1_SECRET_ARN="..."
export REGIONAL_SUFFIX="secondary"
npx cdk deploy --all
```

Stack names:

- Primary: `kong-infra-stack`, `customers-service-stack`
- Secondary: `kong-infra-stack-secondary`, `customers-service-stack-secondary`

## S3 Bucket Naming

S3 bucket names follow the service-specific pattern and must be globally unique. If using DP Resilience:

```bash
export DP_RESILIENCE_BUCKET_NAME="customers-kong-dpconfig-s3-dev"
```

Note: If bucket name not provided, CDK will auto-generate a unique name.

## Key Architectural Decisions

### Why Separate Shared vs Service-Specific Naming?

The infrastructure (VPC, ALB, WAF, Metrics, Logging) is **shared across all services**. Using a service-specific name like `customers-vpc-dev` would incorrectly imply the VPC belongs only to the Customers service, when in reality it serves Customers, Bookings, and any other services deployed.

**Shared Infrastructure** (`kong-*`):

- One VPC serves all services
- One ALB routes to multiple target groups
- One metrics/logging infrastructure for all services

**Service-Specific Resources** (`<serviceName>-*`):

- Each service has its own ECS cluster
- Each service has its own target group
- Each service has its own CloudWatch log groups

## Migration from Old Naming

If migrating from the previous naming scheme:

1. **Stack Names**: Old stacks need to be recreated with new names
2. **Resource Names**: Most resources will be renamed
3. **Environment Variables**: `SYSTEM` variable no longer required for shared infrastructure
4. **No In-Place Updates**: CloudFormation cannot rename most resources, so a blue-green deployment approach is recommended

### Migration Strategy

1. Deploy new stacks with proper naming in parallel
2. Update DNS/routing to point to new resources
3. Verify functionality
4. Delete old stacks

## Environment Variable Summary

| Variable                | Purpose                                      | Required | Valid Values                                        |
| ----------------------- | -------------------------------------------- | -------- | --------------------------------------------------- |
| `ENVIRONMENT`           | Deployment environment                       | Yes      | dev, qa, uat, prd                                   |
| `SERVICE{N}_NAME`       | Service/app name (becomes system identifier) | Yes      | Any alphanumeric string (e.g., customers, bookings) |
| `SERVICE{N}_PATH`       | URL path for routing                         | Yes      | Any valid path (e.g., /customers, /bookings)        |
| `SERVICE{N}_SECRET_ARN` | Konnect certificate ARN                      | Yes      | Valid AWS Secrets Manager ARN                       |

## Validation

The CDK app validates SYSTEM and ENVIRONMENT values at deployment time:

- System must be one of: customers, bookings (or any valid service name)
- Environment must be one of: dev, qa, uat, prd

If invalid values are provided, deployment will fail with a clear error message.

## Context Usage

Alternatively, you can use CDK context instead of environment variables:

```bash
npx cdk deploy --all \
  --context system=customers \
  --context environment=dev \
  --context service1Name=api \
  --context service1Path=/api \
  --context service1SecretArn=...
```

## Compliance

This naming convention implementation ensures:

- ✅ Predictable resource names
- ✅ Consistent patterns across environments
- ✅ Clear environment and system identification
- ✅ Automation-friendly naming
- ✅ Consistent, predictable resource identification

## Support

For questions or issues with naming conventions, please contact the platform team.
