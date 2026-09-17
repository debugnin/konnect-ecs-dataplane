# Kong Multi-Service Architecture - Deployment Guide

This guide explains how to deploy multiple Kong services with path-based routing using the refactored architecture.

> ⚠️ **Important**: All deployments require the `ENVIRONMENT` variable (`dev`, `qa`, `uat`, `prd`, or any custom name). It selects which `config/{environment}.json` file is loaded and is used as a naming/identifier convention throughout the stacks. Service names (`service{N}Name`) are used as system identifiers for service-specific resources. See [NAMING_CONVENTIONS.md](NAMING_CONVENTIONS.md) for details.

## Architecture Overview

The new architecture supports:

- **One Infrastructure Stack**: Shared VPC, ALB, and WAF
- **Multiple Service Stacks**: Each with its own ECS cluster, Kong containers, and target group
- **Path-Based Routing**: Routes traffic to services based on URL paths (e.g., `/customers`, `/bookings`)

## Before You Deploy: Control Plane + DP Secret

This guide assumes a Konnect control plane and its DP client certificate secret already exist. If not:

1. **Provision a Konnect control plane** using [konnect-terraform-example](https://github.com/debugnin/konnect-terraform-example):

    ```bash
    git clone https://github.com/debugnin/konnect-terraform-example
    cd konnect-terraform-example
    export KONNECT_TOKEN="kpat_your-token-here"
    terraform init && terraform apply
    ```

2. **Generate the DP client cert + AWS secret** using [`scripts/create-konnect-secret.sh`](scripts/create-konnect-secret.sh) in this repo:

    ```bash
    export KONNECT_TOKEN="kpat_your-token-here"
    ./scripts/create-konnect-secret.sh --control-plane-name "Sample Control Plane"
    ```

    This resolves the control plane's cluster/telemetry endpoints, generates a self-signed mTLS client cert, registers it with Konnect, and writes it all to AWS Secrets Manager — printing the resulting ARN. Use that ARN as `service{N}SecretArn` in your config file below. Full options in [scripts/README.md](scripts/README.md).

## Configuration Method: Config Files (Recommended)

Deployments are driven by a JSON file at `config/{environment}.json`, selected via the `ENVIRONMENT` variable. This is the **recommended and primary way to configure deployments** — it keeps all settings for an environment in one version-controllable (though git-ignored) place, avoids long `export` chains, and is easy to diff between environments.

Configuration is resolved with the following precedence (highest to lowest):

1. `config/{environment}.json` — environment-specific configuration file
2. `cdk.context.json` — CDK context values
3. Environment variables — legacy/fallback method, still supported (see [below](#alternative-environment-variables))

Config file keys are the camelCase equivalent of the environment variables referenced later in this guide (e.g. `SERVICE1_NAME` → `service1Name`, `WAF_ALLOWED_CIDRS` → `wafAllowedCidrs`). Actual config files (`config/*.json`) are git-ignored since they contain secret ARNs and domain names; only `config/*.json.example` is tracked in version control. See [config/README.md](config/README.md) for the full file-loading/priority behavior.

## Deployment Example

### 1. Create your environment config file

```bash
cp config/dev.json.example config/dev.json
```

Edit `config/dev.json` to configure infrastructure and one or more services:

```json
{
    "environment": "dev",
    "defaultKongImage": "kong/kong-gateway:3.15",

    "vpcMaxAzs": "2",
    "vpcNatGateways": "1",

    "service1Name": "customers",
    "service1Path": "/customers",
    "service1SecretArn": "arn:aws:secretsmanager:us-east-1:123456789012:secret:kong-customers-cert-xxx",
    "service1Cpu": "1024",
    "service1Memory": "2048",
    "service1Replicas": "3",

    "service2Name": "bookings",
    "service2Path": "/bookings",
    "service2SecretArn": "arn:aws:secretsmanager:us-east-1:123456789012:secret:kong-bookings-cert-yyy",
    "service2Cpu": "512",
    "service2Memory": "1024",
    "service2Replicas": "2"
}
```

### 2. Deploy all stacks

```bash
npm run build

# ENVIRONMENT selects config/dev.json
ENVIRONMENT=dev npm run cdk -- deploy --all
```

**Note**: The infrastructure stack (VPC, ALB, WAF) is always created first, and service stacks depend on it. Both are deployed together with `--all`.

### 3. Traffic Routing

After deployment:

- `https://your-domain.com/customers/*` → Routes to Customers service
- `https://your-domain.com/bookings/*` → Routes to Bookings service
- Other paths → 404 Not Found

## Configuration Reference

### Required Settings (Naming Conventions)

| Config Key                  | Description                                                | Valid Values                           | Required |
| ---------------------------- | ------------------------------------------------------------ | --------------------------------------- | -------- |
| `environment` (or `ENVIRONMENT` env var) | Deployment environment                          | dev, qa, uat, prd (or custom)           | **Yes**  |
| `service{N}Name`             | Service name (used as system identifier for that service)   | Any string (e.g., customers, bookings)  | **Yes**  |

> `ENVIRONMENT` must always be passed as an actual environment variable (it determines *which* config file to load), even though every other setting can live inside that config file.

### Infrastructure Configuration

| Config Key           | Description                       | Default |
| --------------------- | ---------------------------------- | ------- |
| `vpcMaxAzs`           | Number of availability zones       | `2`     |
| `vpcNatGateways`      | Number of NAT gateways             | `1`     |
| `albDomain`           | Custom domain for ALB              | -       |
| `albHostedZoneId`     | Route 53 Hosted Zone ID for ALB    | -       |
| `albHostedZoneName`   | Route 53 Hosted Zone Name for ALB  | -       |
| `wafEnabled`          | Enable WAF protection              | `true`  |

**Note**: The infrastructure stack is shared across all services and does not use a serviceName.

### Service Configuration (per service)

| Config Key            | Description                              | Required  |
| ----------------------- | ---------------------------------------- | --------- |
| `service{N}Name`       | Service name (e.g., customers, bookings) | Yes       |
| `service{N}Path`       | URL path prefix (e.g., /customers)       | Yes       |
| `service{N}SecretArn`  | Konnect certificate secret ARN           | Yes       |
| `service{N}Cpu`        | CPU units (256, 512, 1024, etc.)         | No (512)  |
| `service{N}Memory`     | Memory in MiB                            | No (1024) |
| `service{N}Replicas`   | Number of containers                     | No (2)    |

Where `{N}` is the service number (1, 2, 3, etc.).

**Note**: IAM roles are created automatically by the stack. Each service gets dedicated ECS task execution and task roles with appropriate permissions.

## Adding a New Service

To add a new service after initial deployment, add its keys to `config/{environment}.json`:

```json
{
    "service3Name": "payments",
    "service3Path": "/payments",
    "service3SecretArn": "arn:aws:secretsmanager:us-east-1:123456789012:secret:kong-payments-cert-zzz"
}
```

Then deploy only the new service stack:

```bash
ENVIRONMENT=dev npm run cdk -- deploy kong-service-stack-payments-dev
```

(Or `npm run cdk -- deploy --all` to reconcile everything, including the new service.)

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
    - Now requires `serviceName` (not optional)
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

## Alternative: Environment Variables

Environment variables are still supported as a **lowest-precedence fallback** (useful for quick local testing or CI systems that inject secrets as env vars), but a [config file](#configuration-method-config-files-recommended) is the recommended approach for anything beyond a one-off test. Env vars are the same settings as the config file keys, upper-snake-cased:

```bash
export ENVIRONMENT=dev
export VPC_MAX_AZS=2
export VPC_NAT_GATEWAYS=1

export SERVICE1_NAME="customers"
export SERVICE1_PATH="/customers"
export SERVICE1_SECRET_ARN="arn:aws:secretsmanager:us-east-1:123456789012:secret:kong-customers-cert-xxx"
export SERVICE1_CPU=1024
export SERVICE1_MEMORY=2048
export SERVICE1_REPLICAS=3

export SERVICE2_NAME="bookings"
export SERVICE2_PATH="/bookings"
export SERVICE2_SECRET_ARN="arn:aws:secretsmanager:us-east-1:123456789012:secret:kong-bookings-cert-yyy"
export SERVICE2_CPU=512
export SERVICE2_MEMORY=1024
export SERVICE2_REPLICAS=2

npm run build
npm run cdk -- deploy --all
```

If both a config file and matching environment variables are present, **the config file value wins**.

## Troubleshooting

### Service not receiving traffic

- Check listener rule priority (lower number = higher priority)
- Verify path prefix matches your requests
- Check target group health checks

### Path conflicts

- More specific paths get higher priority automatically
- Example: `/api/v1/users` (priority 800) beats `/api` (priority 900)

### Adding services fails

- Ensure `service{N}Name`, `service{N}Path`, and `service{N}SecretArn` are all set in `config/{environment}.json`
- Check that path prefix doesn't conflict with existing services

### Config file not loading

- Confirm `ENVIRONMENT` matches the filename: `ENVIRONMENT=dev` loads `config/dev.json`
- If you see `⚠ No config file found at config/{environment}.json, using CDK context and environment variables`, the file either doesn't exist or has a typo in its name — copy it from `config/dev.json.example`
