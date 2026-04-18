# Kong Konnect Data Plane on AWS ECS

Deploy Kong Gateway data plane on AWS ECS Fargate, connecting to Kong Konnect as the managed control plane.

> ⚠️ **Important**: Shared infrastructure uses the `kong-` prefix, while service-specific resources use the service name (from `SERVICE{N}_NAME`) as the system identifier. You must specify `ENVIRONMENT` (dev, qa, uat, prd) when deploying. See [NAMING_CONVENTIONS.md](NAMING_CONVENTIONS.md) for details.

## Features

- ✅ **Multi-Region Support**: Deploy to Sydney (primary) and Melbourne (secondary) with Route53 failover
- ✅ **High Availability**: ECS Fargate with multiple availability zones
- ✅ **Security**: WAF, mTLS, and custom headers
- ✅ **Monitoring**: CloudWatch logs, metrics streaming to New Relic
- ✅ **DP Resilience**: S3-backed configuration for control plane outages
- ✅ **Multi-Service**: Support for multiple Kong services with path-based routing

> 📖 For multi-region deployment, see [MULTI_REGION_SETUP.md](MULTI_REGION_SETUP.md)
>
> 🔒 For WAF and CIDR restriction configuration, see [WAF_CONFIGURATION.md](WAF_CONFIGURATION.md)

## Architecture

```mermaid
graph TB
    subgraph "Kong Konnect SaaS"
        CP[Control Plane<br/><your-cp-id>.region.cp0.konghq.com:443]
        TP[Telemetry Plane<br/><your-cp-id>.region.tp0.konghq.com:443]
    end

    subgraph "AWS Cloud"
        subgraph "Infrastructure Stack"
            subgraph "VPC"
                subgraph "Public Subnets"
                    ALB[Application Load Balancer<br/>Data Plane]
                    NAT[NAT Gateway]
                end

                subgraph "Private Subnets"
                    TG[Target Group<br/>Port: 8000]
                end
            end

            WAF[WAF<br/>Rate Limiting & Rules]
        end

        subgraph "ECS Stack"
            subgraph "ECS Cluster"
                DP1[Kong DP Container<br/>Proxy: 8000<br/>Status: 8100]
                DP2[Kong DP Container<br/>Proxy: 8000<br/>Status: 8100]
            end
        end

        subgraph "AWS Secrets Manager"
            SEC[Client Certificate Secret<br/>- certificate<br/>- private_key<br/>- control_plane_group_endpoint<br/>- telemetry_endpoint]
        end

        subgraph "CloudWatch Logs"
            LOG[Data Plane Logs<br/>/ecs/kong-data-plane]
        end
    end

    subgraph "Internet"
        USER[API Clients]
    end

    %% External connections
    USER --> WAF
    WAF --> ALB

    %% Load balancer connections
    ALB --> TG
    TG --> DP1
    TG --> DP2

    %% Konnect connections
    DP1 -.->|mTLS| CP
    DP2 -.->|mTLS| CP
    DP1 -.->|Telemetry| TP
    DP2 -.->|Telemetry| TP

    %% Secrets connections
    DP1 -.-> SEC
    DP2 -.-> SEC

    %% Logging connections
    DP1 -.-> LOG
    DP2 -.-> LOG

    %% Styling
    classDef aws fill:#ff9900,stroke:#232f3e,stroke-width:2px,color:#fff
    classDef kong fill:#003459,stroke:#00d4aa,stroke-width:2px,color:#fff
    classDef konnect fill:#00d4aa,stroke:#003459,stroke-width:2px,color:#000
    classDef secrets fill:#dd344c,stroke:#232f3e,stroke-width:2px,color:#fff
    classDef external fill:#232f3e,stroke:#00d4aa,stroke-width:2px,color:#fff

    class ALB,NAT,TG,WAF aws
    class DP1,DP2 kong
    class CP,TP konnect
    class SEC secrets
    class USER external
```

### Components

- **Control Plane**: Kong Konnect (SaaS)
- **Data Plane**: Kong Gateway containers on ECS Fargate
- **Infrastructure Stack**: VPC, ALB, WAF (created first)
- **ECS Stack**: ECS Cluster, Services, and Tasks (depends on infrastructure)
- **Load Balancer**: Application Load Balancer for traffic routing
- **Security**: AWS Secrets Manager for client certificates
- **Networking**: VPC with public/private subnets

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

2. **Deploy the stacks**:

    ```bash
    npm install
    npm run build

    # Both stacks are deployed together (infrastructure first, then ECS)
    KONNECT_CONTROL_PLANE_SECRET_ARN="arn:aws:secretsmanager:region:account:secret:name" \
    npx cdk deploy --all
    ```

**Note**: The infrastructure stack (VPC, ALB, WAF) is always created first, and the ECS stack depends on it. Both stacks are deployed together.

## Configuration

### Environment Variables

| Variable                      | Description                                | Required |
| ----------------------------- | ------------------------------------------ | -------- |
| `SERVICE{N}_NAME`             | Service name (e.g., customers, bookings)   | Yes      |
| `SERVICE{N}_PATH`             | URL path prefix (e.g., /customers)         | Yes      |
| `SERVICE{N}_SECRET_ARN`       | Konnect certificate secret ARN             | Yes      |
| `ECS_TASK_EXECUTION_ROLE_ARN` | Pre-existing ECS Task Execution Role ARN   | Yes      |
| `ECS_TASK_ROLE_ARN`           | Pre-existing ECS Task Role ARN             | Yes      |
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
**Note**: Use `SERVICE{N}_*` variables where `{N}` is the service number (1, 2, 3, etc.). IAM role creation is not supported - you must provide pre-existing ECS Task Execution and Task Role ARNs (shared across all services).

**\*\*REGIONAL_SUFFIX**: Automatically set by the pipeline to `secondary` for Melbourne deployment. Primary region (Sydney) uses default stack names without suffix. For manual deployments to secondary region, set `REGIONAL_SUFFIX=secondary`.

### Example Deployments

```bash
# Basic deployment (both stacks)
SERVICE1_NAME="customers" \
SERVICE1_PATH="/customers" \
SERVICE1_SECRET_ARN="arn:aws:secretsmanager:us-east-1:123456789012:secret:kong-cert-AbCdEf" \
SERVICE1_TASK_ROLE_ARN="arn:aws:iam::123456789012:role/ecsTaskExecutionRole" \
ALB_DOMAIN="api.example.com" \
ALB_HOSTED_ZONE_ID="Z1234567890ABC" \
ALB_HOSTED_ZONE_NAME="example.com" \
npx cdk deploy --all

# Custom configuration with multiple services
SERVICE1_NAME="customers" \
SERVICE1_PATH="/customers" \
SERVICE1_SECRET_ARN="arn:aws:secretsmanager:us-east-1:123456789012:secret:kong-customers-cert" \
SERVICE1_TASK_ROLE_ARN="arn:aws:iam::123456789012:role/ecsTaskExecutionRole" \
SERVICE1_CPU=1024 \
SERVICE1_MEMORY=2048 \
SERVICE1_REPLICAS=3 \
SERVICE2_NAME="bookings" \
SERVICE2_PATH="/bookings" \
SERVICE2_SECRET_ARN="arn:aws:secretsmanager:us-east-1:123456789012:secret:kong-bookings-cert" \
SERVICE2_TASK_ROLE_ARN="arn:aws:iam::123456789012:role/ecsTaskExecutionRole" \
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

- **CloudWatch Logs**: `/ecs/kong-data-plane` (or `/ecs/kong-data-plane-{appName}`)
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
