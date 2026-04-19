# Kong Multi-Service Architecture - Deployment Guide

This guide explains how to deploy multiple Kong services with path-based routing using the refactored architecture.

> ⚠️ **Important**: All deployments require the `ENVIRONMENT` variable. Service names (from `SERVICE{N}_NAME`) are used as system identifiers for service-specific resources. See [NAMING_CONVENTIONS.md](NAMING_CONVENTIONS.md) for details.

## Architecture Overview

The new architecture supports:

- **One Infrastructure Stack**: Shared VPC, ALB, and WAF
- **Multiple Service Stacks**: Each with its own ECS cluster, Kong containers, and target group
- **Path-Based Routing**: Routes traffic to services based on URL paths (e.g., `/customers`, `/bookings`)

## Deployment Example

### 1. Deploy Infrastructure + Two Services

```bash
# REQUIRED: Set environment for naming conventions
export ENVIRONMENT=dev      # Environment: dev, qa, uat, or prd

# Set infrastructure configuration (VPC settings)
export VPC_MAX_AZS=2
export VPC_NAT_GATEWAYS=1

# Configure Service 1: Customers (service name becomes the system identifier)
export SERVICE1_NAME="customers"
export SERVICE1_PATH="/customers"
export SERVICE1_SECRET_ARN="arn:aws:secretsmanager:us-east-1:123456789012:secret:kong-customers-cert-xxx"
export SERVICE1_CPU=1024
export SERVICE1_MEMORY=2048
export SERVICE1_REPLICAS=3

# Configure Service 2: Bookings
export SERVICE2_NAME="bookings"
export SERVICE2_PATH="/bookings"
export SERVICE2_SECRET_ARN="arn:aws:secretsmanager:us-east-1:123456789012:secret:kong-bookings-cert-yyy"
export SERVICE2_CPU=512
export SERVICE2_MEMORY=1024
export SERVICE2_REPLICAS=2

# Deploy all stacks
npm run build
npx cdk deploy --all
```

### 2. Traffic Routing

After deployment:

- `https://your-domain.com/customers/*` → Routes to Customers service
- `https://your-domain.com/bookings/*` → Routes to Bookings service
- Other paths → 404 Not Found

## Environment Variables

### Required Variables (Naming Conventions)

| Variable          | Description                                               | Valid Values                           | Required |
| ----------------- | --------------------------------------------------------- | -------------------------------------- | -------- |
| `ENVIRONMENT`     | Deployment environment                                    | dev, qa, uat, prd                      | **Yes**  |
| `SERVICE{N}_NAME` | Service name (used as system identifier for that service) | Any string (e.g., customers, bookings) | **Yes**  |

### Infrastructure Configuration

| Variable               | Description                       | Default |
| ---------------------- | --------------------------------- | ------- |
| `VPC_MAX_AZS`          | Number of availability zones      | `2`     |
| `VPC_NAT_GATEWAYS`     | Number of NAT gateways            | `1`     |
| `ALB_DOMAIN`           | Custom domain for ALB             | -       |
| `ALB_HOSTED_ZONE_ID`   | Route 53 Hosted Zone ID for ALB   | -       |
| `ALB_HOSTED_ZONE_NAME` | Route 53 Hosted Zone Name for ALB | -       |
| `WAF_ENABLED`          | Enable WAF protection             | `true`  |

**Note**: The infrastructure stack is shared across all services and does not use an appName.

### Service Configuration (per service)

| Variable                | Description                              | Required  |
| ----------------------- | ---------------------------------------- | --------- |
| `SERVICE{N}_NAME`       | Service name (e.g., customers, bookings) | Yes       |
| `SERVICE{N}_PATH`       | URL path prefix (e.g., /customers)       | Yes       |
| `SERVICE{N}_SECRET_ARN` | Konnect certificate secret ARN           | Yes       |
| `SERVICE{N}_CPU`        | CPU units (256, 512, 1024, etc.)         | No (512)  |
| `SERVICE{N}_MEMORY`     | Memory in MiB                            | No (1024) |
| `SERVICE{N}_REPLICAS`   | Number of containers                     | No (2)    |

Where `{N}` is the service number (1, 2, 3, etc.).

**Note**: IAM roles are created automatically by the stack. Each service gets dedicated ECS task execution and task roles with appropriate permissions.

## Adding a New Service

To add a new service after initial deployment:

```bash
# Configure the new service
export SERVICE3_NAME="payments"
export SERVICE3_PATH="/payments"
export SERVICE3_SECRET_ARN="arn:aws:secretsmanager:us-east-1:123456789012:secret:kong-payments-cert-zzz"

# Deploy only the new service stack
npx cdk deploy KongKonnectStack-Service-payments
```

## Stack Outputs

### Infrastructure Stack

- `VpcId`: VPC ID for reference
- `AlbDnsName`: Load balancer DNS name
- `HttpListenerArn`: HTTP listener ARN (port 80)
- `HttpsListenerArn`: HTTPS listener ARN (port 443)
- `AlbSecurityGroupId`: Security group for ALB

### Service Stacks (per service)

- `ClusterName`: ECS cluster name
- `ServiceName`: ECS service name
- `TargetGroupArn`: Target group ARN
- `PathPrefix`: Path prefix for routing

## Key Changes from Previous Architecture

1. **Service Stack (formerly ECS Stack)**
    - Now requires `appName` (not optional)
    - Requires `pathPrefix` for routing
    - Creates its own target group
    - Adds listener rules for path-based routing

2. **Infrastructure Stack**
    - No longer creates target groups
    - Listeners default to 404 responses
    - Exposes listener ARNs for service stacks

3. **Multiple Services**
    - Each service gets its own stack
    - Independent scaling and configuration
    - Shared infrastructure (VPC, ALB, WAF)

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────┐
│              Infrastructure Stack                        │
│  ┌─────────┐  ┌─────┐  ┌─────┐                        │
│  │   VPC   │  │ ALB │  │ WAF │                        │
│  └─────────┘  └─────┘  └─────┘                        │
└─────────────────────────────────────────────────────────┘
                         │
        ┌────────────────┼────────────────┐
        │                │                │
┌────────▼───────┐ ┌──────▼─────┐ ┌──────▼───────┐
│Svc: Customers  │ │Svc:Bookings│ │Service: Pay  │
│Path:/customers/│ │Path:/book/*│ │Path: /pay/*  │
│┌──────────────┐│ │┌──────────┐│ │┌────────────┐│
││ECS + Kong DP ││ ││ECS + Kong││ ││ECS + Kong  ││
││Target Group  ││ ││Target Grp││ ││Target Group││
│└──────────────┘│ │└──────────┘│ │└────────────┘│
└────────────────┘ └────────────┘ └──────────────┘
```

## Troubleshooting

### Service not receiving traffic

- Check listener rule priority (lower number = higher priority)
- Verify path prefix matches your requests
- Check target group health checks

### Path conflicts

- More specific paths get higher priority automatically
- Example: `/api/v1/users` (priority 800) beats `/api` (priority 900)

### Adding services fails

- Ensure SERVICE{N}\_NAME, SERVICE{N}\_PATH, and SERVICE{N}\_SECRET_ARN are all set
- Check that path prefix doesn't conflict with existing services
