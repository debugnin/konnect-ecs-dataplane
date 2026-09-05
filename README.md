# Kong Konnect Data Plane on AWS ECS

Deploy Kong Gateway data plane on AWS ECS Fargate, connecting to Kong Konnect as the managed control plane.

## Architecture

![Kong Konnect ECS Architecture](kong-konnect-ecs-architecture.png)

## Features

### 🌍 Multi-Service Architecture

- **One shared infrastructure stack**: VPC, ALB, and WAF shared across all services
- **Multiple service stacks**: Each service gets its own ECS cluster with dedicated Kong containers
- **Path-based routing**: Route traffic to different services based on URL paths (e.g., `/customers` → customers service, `/bookings` → bookings service)
- **Independent scaling**: Each service can have different CPU, memory, and replica configurations
- **Service isolation**: Separate ECS clusters and target groups for each service
- **Per-service Redis**: Optional Redis cluster per service for rate limiting, caching, and session storage

### 🌐 Multi-Region High Availability

- **Primary & secondary regions**: Deploy to any two AWS regions for geographic redundancy
- **Automated Route53 failover**: Primary region creates health checks, secondary region acts as standby
- See [MULTI_REGION_SETUP.md](MULTI_REGION_SETUP.md) for details

### 🔒 Security

- **WAF protection**: Rate limiting, AWS Managed Rules, and custom IP restrictions
- **CIDR allowlists**: Restrict access to specific IP ranges (enabled by default)
- **mTLS authentication**: Mutual TLS with Kong Konnect Control Plane
- **Secrets management**: Client certificates securely stored in AWS Secrets Manager
- **Private networking**: Data plane containers run in private subnets
- **VPC endpoints**: Secure access to AWS services without internet gateway
- **IAM least privilege**: Separate task execution and task roles with minimal permissions
- See [WAF_CONFIGURATION.md](WAF_CONFIGURATION.md) for WAF setup

### 🛡️ Data Plane Resilience

- **S3 configuration backup**: Control plane config automatically exported to S3
- **CP outage recovery**: New DP nodes can start during control plane outages by reading from S3
- **Dedicated backup nodes**: Separate backup node exports config (not serving traffic)
- See [DP_RESILIENCE_SETUP.md](DP_RESILIENCE_SETUP.md) for configuration

### 🏗️ Infrastructure Components

- **VPC**: Configurable CIDR, multi-AZ, public/private subnets
- **VPC Flow Logs**: Traffic logging to CloudWatch for security auditing
- **VPC Endpoints**: Secure access to S3, Secrets Manager, ECR, CloudWatch
- **Transit Gateway**: Optional integration for hybrid cloud connectivity
- **NAT Gateways**: Configurable number for private subnet internet access
- **Application Load Balancer**: Regional ALB with HTTPS/mTLS listeners
- **ACM Certificates**: Automatic certificate validation via Route53
- **Route53 DNS**: Automated failover records with health checks

### 📊 Monitoring & Logging

- **CloudWatch Logs**: Separate log groups per service (`/ecs/kong-{service}-dataplane`)
- **VPC Flow Logs**: Network traffic analysis and security monitoring
- **Log streaming**: Optional subscription filters to central logging account
- **Health checks**: ALB health checks on Kong status endpoint (port 8100)
- **ECS Container Insights**: Task and container-level metrics
- **Configurable log levels**: Per-service Kong log level configuration

### 🔧 Deployment & Operations

- **CloudFormation parameters**: Update container images without CDK redeployment
- **Cross-account deployments**: Support for plugin deployment from separate accounts
- **Environment-based naming**: Resources tagged with environment (dev, qa, uat, prd)
- **Regional suffixes**: Clear stack naming for multi-region deployments
- **CDK Stack Synthesizer**: Custom qualifier for bootstrap isolation
- See [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md) for deployment workflows

### 📝 Documentation

- [NAMING_CONVENTIONS.md](NAMING_CONVENTIONS.md): Resource naming patterns and conventions
- [MULTI_REGION_SETUP.md](MULTI_REGION_SETUP.md): Multi-region deployment guide
- [WAF_CONFIGURATION.md](WAF_CONFIGURATION.md): WAF and CIDR restriction setup
- [DP_RESILIENCE_SETUP.md](DP_RESILIENCE_SETUP.md): Data plane resilience configuration
- [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md): Service deployment and management
- [LOGGING_SETUP.md](LOGGING_SETUP.md): CloudWatch log streaming configuration
- [REDIS_SETUP.md](REDIS_SETUP.md): Redis (ElastiCache) configuration for rate limiting and caching

### Components

This CDK project deploys two types of stacks:

#### Infrastructure Stack (Shared)

- **VPC**: Multi-AZ VPC with public/private subnets, configurable CIDR
- **VPC Flow Logs**: CloudWatch logging for network traffic analysis
- **VPC Endpoints**: Secure access to S3, Secrets Manager, ECR, CloudWatch
- **NAT Gateways**: Configurable number for private subnet internet access
- **Transit Gateway**: Optional integration for hybrid cloud connectivity
- **Application Load Balancer**: Regional ALB with HTTPS (443) and mTLS listeners
- **ACM Certificate**: Automatic SSL/TLS certificate with Route53 validation
- **Route53 Records**: Automated failover records with health checks (multi-region)
- **WAF**: Web Application Firewall with rate limiting, AWS Managed Rules, CIDR restrictions

#### Service Stacks (Per Service)

- **ECS Cluster**: Dedicated cluster for each service (e.g., `kong-customers-ecscluster-dev`)
- **ECS Service**: Fargate service with configurable CPU, memory, and replicas
- **Kong Data Plane Containers**: Main DP nodes serving traffic (registered with ALB)
- **Kong Backup Container**: Optional backup node for DP resilience (exports config to S3)
- **Target Group**: Path-based routing to service (e.g., `/customers/*`)
- **CloudWatch Log Groups**: Separate log groups per service
- **S3 Bucket**: Optional bucket for DP resilience configuration backup
- **Secrets Manager**: Client certificates for mTLS with Kong Konnect
- **Redis (ElastiCache)**: Optional per-service Redis cluster for rate limiting, caching, and session storage (disabled by default)

#### External Components

- **Kong Konnect Control Plane**: Managed SaaS control plane (configuration, routing, plugins)
- **Kong Konnect Telemetry Plane**: Managed SaaS telemetry collection for metrics and traces

## Prerequisites

- AWS CLI configured
- Node.js and npm installed
- Kong Konnect account with client certificate
- Client certificate stored in AWS Secrets Manager

## Quick Start

1. **Store client certificate in Secrets Manager**:

    ```bash
    aws secretsmanager create-secret \
      --name "kong-konnect-client-cert" \
      --secret-string '{
        "certificate": "-----BEGIN CERTIFICATE-----\n...",
        "private_key": "-----BEGIN EC PRIVATE KEY-----\n...",
        "control_plane_group_endpoint": "your-cp.konghq.com:443",
        "cluster_server_name": "your-cp.konghq.com",
        "telemetry_endpoint": "your-tp.konghq.com:443",
        "telemetry_server_name": "your-tp.konghq.com"
      }'
    ```

2. **Create your environment configuration file**:

    ```bash
    cp config/dev.json.example config/dev.json
    # Edit config/dev.json with your service, VPC, and secret ARN values
    ```

3. **Deploy the stacks**:

    ```bash
    npm install
    npm run build

    # Both stacks are deployed together (infrastructure first, then ECS)
    ENVIRONMENT=dev npx cdk deploy --all
    ```

**Note**: The infrastructure stack (VPC, ALB, WAF) is always created first, and the ECS stack depends on it. Both stacks are deployed together.

## Configuration

### Configuration Files (Recommended)

Deployments are configured via `config/{environment}.json`, keyed by the `ENVIRONMENT` variable (e.g. `ENVIRONMENT=dev` loads `config/dev.json`). Configuration is resolved with the following precedence (highest to lowest):

1. `config/{environment}.json` — environment-specific configuration file
2. `cdk.context.json` — CDK context values
3. Environment variables — see the table below for the mapping

Config file keys are the camelCase equivalent of the environment variables in the table below (e.g. `SERVICE1_NAME` → `service1Name`, `WAF_ALLOWED_CIDRS` → `wafAllowedCidrs`). Actual config files (`config/*.json`) are git-ignored since they contain secret ARNs and domain names; only `config/*.json.example` is tracked. See [config/README.md](config/README.md) for full details.

Example `config/dev.json`:

```json
{
    "environment": "dev",
    "defaultKongImage": "kong/kong-gateway:3.9",

    "service1Name": "customers",
    "service1Path": "/customers",
    "service1SecretArn": "arn:aws:secretsmanager:us-east-1:123456789012:secret:kong-customers-cert",
    "service1Cpu": "512",
    "service1Memory": "1024",
    "service1Replicas": "2",

    "vpcMaxAzs": "2",
    "albDomain": "api.example.com",
    "albHostedZoneId": "Z1234567890ABC",
    "albHostedZoneName": "example.com",

    "wafEnabled": "true",
    "wafAllowedCidrs": "203.0.113.0/24,198.51.100.0/24"
}
```

Deploy with:

```bash
ENVIRONMENT=dev npx cdk deploy --all
```

### Environment Variables

| Variable                      | Description                                | Required |
| ----------------------------- | ------------------------------------------ | -------- |
| `SERVICE{N}_NAME`             | Service name (e.g., customers, bookings)   | Yes      |
| `SERVICE{N}_PATH`             | URL path prefix (e.g., /customers)         | Yes      |
| `SERVICE{N}_SECRET_ARN`       | Konnect certificate secret ARN             | Yes      |
| `SERVICE{N}_CPU`              | Data plane CPU units (default: 512)        | No       |
| `SERVICE{N}_MEMORY`           | Data plane memory MiB (default: 1024)      | No       |
| `SERVICE{N}_REPLICAS`         | Number of data plane tasks (default: 2)    | No       |
| `AWS_DEFAULT_REGION`          | Primary region (default: ap-southeast-2)   | No       |
| `AWS_SECONDARY_REGION`        | Secondary region (default: ap-southeast-4) | No       |
| `REGIONAL_SUFFIX`             | Stack name suffix for secondary region     | No\*\*   |
| `VPC_MAX_AZS`                 | Number of availability zones (default: 2)  | No       |
| `WAF_ENABLED`                 | Enable WAF protection (default: true)      | No       |
| `WAF_ALLOWED_CIDRS`           | Comma-separated allowed CIDRs              | No       |
| `WAF_ENABLE_CIDR_RESTRICTION` | Enable CIDR allowlist (default: true)      | No       |
| `WAF_RATE_LIMIT`              | WAF rate limit per minute (default: 2000)  | No       |
| `ALB_DOMAIN`                  | Custom domain for ALB                      | No       |
| `ALB_HOSTED_ZONE_ID`          | Route 53 Hosted Zone ID for ALB            | No       |
| `ALB_HOSTED_ZONE_NAME`        | Route 53 Hosted Zone Name for ALB          | No       |

**Note**: Use `SERVICE{N}_*` variables where `{N}` is the service number (1, 2, 3, etc.). IAM role creation is not supported - you must provide pre-existing ECS Task Execution and Task Role ARNs (shared across all services). These variables are the lowest-precedence configuration source — prefer a [configuration file](#configuration-files-recommended) for anything beyond quick local testing.

**\*\*REGIONAL_SUFFIX**: Automatically set by the pipeline to `secondary` for Melbourne deployment. Primary region (Sydney) uses default stack names without suffix. For manual deployments to secondary region, set `REGIONAL_SUFFIX=secondary`.

### Example Deployments

**Using a config file (recommended)**:

```bash
# config/dev.json contains service1Name, service1Path, service1SecretArn, albDomain, etc.
ENVIRONMENT=dev npx cdk deploy --all
```

**Using environment variables only**:

```bash
# Basic deployment (both stacks)
ENVIRONMENT=dev \
SERVICE1_NAME="customers" \
SERVICE1_PATH="/customers" \
SERVICE1_SECRET_ARN="arn:aws:secretsmanager:us-east-1:123456789012:secret:kong-cert-AbCdEf" \
ALB_DOMAIN="api.example.com" \
ALB_HOSTED_ZONE_ID="Z1234567890ABC" \
ALB_HOSTED_ZONE_NAME="example.com" \
npx cdk deploy --all

# Custom configuration with multiple services
ENVIRONMENT=dev \
SERVICE1_NAME="customers" \
SERVICE1_PATH="/customers" \
SERVICE1_SECRET_ARN="arn:aws:secretsmanager:us-east-1:123456789012:secret:kong-customers-cert" \
SERVICE1_CPU=1024 \
SERVICE1_MEMORY=2048 \
SERVICE1_REPLICAS=3 \
SERVICE2_NAME="bookings" \
SERVICE2_PATH="/bookings" \
SERVICE2_SECRET_ARN="arn:aws:secretsmanager:us-east-1:123456789012:secret:kong-bookings-cert" \
ALB_DOMAIN="api.example.com" \
ALB_HOSTED_ZONE_ID="Z1234567890ABC" \
ALB_HOSTED_ZONE_NAME="example.com" \
npx cdk deploy

```

## Secret Format

The AWS Secrets Manager secret must contain:

```json
{
    "certificate": "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----\n",
    "private_key": "-----BEGIN EC PRIVATE KEY-----\n...\n-----END EC PRIVATE KEY-----\n",
    "control_plane_group_endpoint": "<your-cp-id>.region.cp0.konghq.com:443",
    "cluster_server_name": "<your-cp-id>.region.cp0.konghq.com",
    "telemetry_endpoint": "<your-cp-id>.region.tp0.konghq.com:443",
    "telemetry_server_name": "<your-cp-id>.region.tp0.konghq.com"
}
```

## Outputs

After deployment, the stack outputs:

- **DataPlaneUrl**: Load balancer URL for API traffic
- **ClusterName**: ECS cluster name

## Monitoring

- **CloudWatch Logs**: `/ecs/kong-data-plane` (or `/ecs/kong-data-plane-{serviceName}`)
- **Health Check**: `http://{load-balancer}/status` (port 8100)
- **Kong Manager**: Available in Kong Konnect console

## Commands

```bash
# Build TypeScript
npm run build

# Watch for changes
npm run watch

# Run tests
npm run test

# Deploy stack
npx cdk deploy

# View differences
npx cdk diff

# Generate CloudFormation
npx cdk synth

# Destroy stack
npx cdk destroy
```

## Troubleshooting

**Secret not found**: Verify the ARN and ensure the secret exists in the same region.

**Container startup issues**: Check CloudWatch logs for Kong configuration errors.

**Connection to Konnect**: Verify client certificate validity and network connectivity.

## Security

- Data plane runs in private subnets
- mTLS authentication with Konnect
- IAM roles with least privilege
- Client certificates stored in Secrets Manager
- Configurable IP allowlists for load balancer

### WAF CIDR Restriction

By default, the WAF is configured to restrict access to specific IP address ranges. You can configure which CIDRs are allowed using AWS WAF IP sets.

> 📖 For detailed WAF configuration instructions, see [WAF_CONFIGURATION.md](WAF_CONFIGURATION.md)

**To configure allowed CIDRs:**

1. Provide a comma-separated list of CIDR blocks in `WAF_ALLOWED_CIDRS`
2. (Optional) Set `WAF_ENABLE_CIDR_RESTRICTION=false` to disable restriction and allow all traffic

**Example:**

```bash
# Via Bitbucket Deployment Variables
WAF_ALLOWED_CIDRS="203.0.113.0/24,198.51.100.0/24,192.0.2.0/24"

# To disable CIDR restriction entirely (allow all IPs):
WAF_ENABLE_CIDR_RESTRICTION=false

# Via local deployment
WAF_ALLOWED_CIDRS="10.0.0.0/8,172.16.0.0/12,192.168.0.0/16" \
SERVICE1_NAME="customers" \
SERVICE1_PATH="/customers" \
SERVICE1_SECRET_ARN="arn:..." \
npx cdk deploy --all
```

**How it works:**

- CIDR restriction is **enabled by default** for security
- When enabled, WAF creates an IP Set with your allowed CIDRs
- A WAF rule is added to allow traffic only from IPs in the IP Set
- The default action becomes "Block" (instead of "Allow")
- Traffic from non-allowlisted IPs receives a 403 Forbidden response
- Rate limiting and AWS Managed Rules still apply to allowed traffic
- Set `WAF_ENABLE_CIDR_RESTRICTION=false` to disable and allow all traffic

**Important notes:**

- CIDRs must be in valid IPv4 CIDR notation (e.g., `203.0.113.0/24`)
- Multiple CIDRs are separated by commas with no spaces
- **WARNING**: CIDR restriction is enabled by default - if no CIDRs are provided, all traffic will be blocked
- To allow all traffic, set `WAF_ENABLE_CIDR_RESTRICTION=false`
- Changes to the CIDR list require redeployment
