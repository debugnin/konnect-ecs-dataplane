# Kong Data Plane Resilience Setup Guide

This guide explains how to configure Kong Gateway Data Plane (DP) resilience for Control Plane (CP) outage management.

## Overview

Kong Gateway's Data Plane resilience feature allows new DP nodes to start and configure themselves during Control Plane outages by loading configuration from S3 storage.

**Reference**: https://developer.konghq.com/gateway/cp-outage/

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Konnect Control Plane                     │
│                  (SaaS - Kong Konnect)                       │
└────────────────────────┬────────────────────────────────────┘
                         │
                         │ Configuration Updates
                         ↓
          ┌──────────────────────────────┐
          │   Backup Data Plane Node     │
          │  (EXPORT config to S3)       │
          │  - Read/Write S3 access      │
          │  - Leader election           │
          └──────────────┬───────────────┘
                         │
                         │ Writes config.json
                         ↓
          ┌─────────────────────────────────┐
          │   S3 Bucket (DP Resilience)     │
          │   kong-config/{version}/        │
          │   ├── config.json               │
          │   └── election/                 │
          └──────────────┬──────────────────┘
                         │
                         │ Reads config.json (if CP down)
                         ↓
          ┌──────────────────────────────┐
          │ Regular Data Plane Nodes     │
          │ (IMPORT config from S3)      │
          │ - Read-only S3 access        │
          │ - No backup responsibility   │
          └──────────────────────────────┘
```

## How It Works

### Normal Operation

1. **Backup Node** connects to Control Plane and receives configuration updates
2. Backup node writes configuration to S3 at `s3://bucket/kong-config/{version}/config.json`
3. **Regular DP nodes** connect directly to Control Plane (no S3 access needed)

### During CP Outage

1. **New DP node** attempts to connect to Control Plane
2. Connection fails → DP checks S3 for fallback configuration
3. DP loads `config.json` from S3, configures itself, and starts proxying
4. DP continues trying to reconnect to Control Plane

### Important Notes

- S3 is **only accessed during DP startup** when CP is unreachable
- Once running, DP nodes cache configuration and don't read from S3
- Only **one backup node is required** (leader election handles multiple backup nodes)
- **Backup nodes should not proxy traffic** (increased security risk, P99 latency)

## Configuration

### Environment Variables

#### Enable DP Resilience

```bash
# Enable the feature (required)
DP_RESILIENCE_ENABLED=true

# Optional: Custom bucket name (auto-generated if not provided)
DP_RESILIENCE_BUCKET_NAME=kong-dp-config-backup

# Optional: S3 prefix for config files (default: kong-config)
# Kong creates: {prefix}/{version}/config.json
DP_RESILIENCE_CONFIG_PREFIX=kong-config

# Optional: KMS key for S3 encryption
DP_RESILIENCE_KMS_KEY_ARN=arn:aws:kms:ap-southeast-2:ACCOUNT:key/KEY_ID
```

**Note**: When DP resilience is enabled, each service stack creates:

- **1 Backup Node**: Exports config to S3 (not registered with ALB)
- **N Regular Nodes**: Import config from S3 if CP down (registered with ALB)

### Deployment Examples

#### Deploy Service with DP Resilience

```bash
# Deploy a service with DP resilience enabled
# This creates:
#  - 1 backup node (exports config to S3, no traffic)
#  - 3 regular nodes (import config from S3 if CP down, handle traffic)

SERVICE1_NAME="customers" \
SERVICE1_PATH="/customers" \
SERVICE1_SECRET_ARN="arn:aws:secretsmanager:ap-southeast-2:ACCOUNT:secret:kong-customers-cert" \
SERVICE1_TASK_ROLE_ARN="arn:aws:iam::ACCOUNT:role/ecsTaskExecutionRole" \
SERVICE1_REPLICAS=3 \
DP_RESILIENCE_ENABLED=true \
npx cdk deploy KongKonnectStack-Service-customers
```

#### Deploy Multiple Services with Resilience

```bash
# Infrastructure stack
npx cdk deploy KongKonnectStack-Infrastructure

# Service 1: Customers API (3 regular nodes + 1 backup)
SERVICE1_NAME="customers" \
SERVICE1_PATH="/customers" \
SERVICE1_SECRET_ARN="arn:aws:secretsmanager:...:kong-customers-cert" \
SERVICE1_TASK_ROLE_ARN="arn:aws:iam::ACCOUNT:role/ecsTaskExecutionRole" \
SERVICE1_REPLICAS=3 \
DP_RESILIENCE_ENABLED=true \
npx cdk deploy KongKonnectStack-Service-customers

# Service 2: Bookings API (2 regular nodes + 1 backup)
SERVICE2_NAME="bookings" \
SERVICE2_PATH="/bookings" \
SERVICE2_SECRET_ARN="arn:aws:secretsmanager:...:kong-bookings-cert" \
SERVICE2_TASK_ROLE_ARN="arn:aws:iam::ACCOUNT:role/ecsTaskExecutionRole" \
SERVICE2_REPLICAS=2 \
DP_RESILIENCE_ENABLED=true \
npx cdk deploy KongKonnectStack-Service-bookings
```

#### Deploy Service WITHOUT DP Resilience

```bash
# Regular deployment without S3 backup (CP must be available for new nodes)
SERVICE1_NAME="legacy" \
SERVICE1_PATH="/legacy" \
SERVICE1_SECRET_ARN="arn:aws:secretsmanager:...:kong-legacy-cert" \
SERVICE1_TASK_ROLE_ARN="arn:aws:iam::ACCOUNT:role/ecsTaskExecutionRole" \
SERVICE1_REPLICAS=2 \
DP_RESILIENCE_ENABLED=false \
npx cdk deploy KongKonnectStack-Service-legacy
```

## Generated Resources

### S3 Bucket

- **Bucket Name**: Auto-generated or custom via `DP_RESILIENCE_BUCKET_NAME`
- **Encryption**: S3-managed (SSE-S3) or KMS (if `DP_RESILIENCE_KMS_KEY_ARN` provided)
- **Versioning**: Enabled for config history
- **Lifecycle Rules**:
    - Election files deleted after 7 days
    - Multipart uploads aborted after 1 day

### S3 Object Structure

```
s3://bucket-name/
└── kong-config/              # configPrefix
    └── 3.13.0.0/             # Kong version
        ├── config.json       # Configuration backup
        └── election/         # Leader election files
            └── node-*.json   # Backup node registration
```

### IAM Permissions

**IMPORTANT**: The `ecsTaskExecutionRoleArn` provided to the CDK stack must have S3 permissions attached. Since both backup and regular nodes use the same role, the role requires **read/write** permissions:

#### Required IAM Policy for ecsTaskExecutionRoleArn

This policy must be attached to your pre-existing `ecsTaskExecutionRoleArn` **before** deploying the stack:

```json
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Action": [
                "s3:GetObject",
                "s3:PutObject",
                "s3:DeleteObject",
                "s3:ListBucket"
            ],
            "Resource": [
                "arn:aws:s3:::your-bucket-name",
                "arn:aws:s3:::your-bucket-name/*"
            ]
        }
    ]
}
```

**Note**:

- Replace `your-bucket-name` with your actual bucket name (or use wildcard `*` for flexibility)
- Both backup and regular nodes use the same IAM role
- The CDK deployment will output the required permissions after stack creation

## Kong Environment Variables

The CDK stack automatically configures these Kong environment variables:

### Backup Node

```bash
# S3 storage location
KONG_CLUSTER_FALLBACK_CONFIG_STORAGE=s3://bucket-name/kong-config

# Enable config export
KONG_CLUSTER_FALLBACK_CONFIG_EXPORT=on

# AWS credentials (via IAM role)
AWS_REGION=ap-southeast-2
AWS_DEFAULT_REGION=ap-southeast-2
```

### Regular DP Node

```bash
# S3 storage location
KONG_CLUSTER_FALLBACK_CONFIG_STORAGE=s3://bucket-name/kong-config

# Enable config import (only if CP is down)
KONG_CLUSTER_FALLBACK_CONFIG_IMPORT=on

# AWS credentials (via IAM role)
AWS_REGION=ap-southeast-2
AWS_DEFAULT_REGION=ap-southeast-2
```

## Best Practices

### 1. Dedicated Backup Node

- **Deploy exactly ONE backup node** per environment
- Set `SERVICE_REPLICAS=1` for backup node
- **Do NOT route customer traffic** to backup node
- Use separate service stack for backup node

### 2. Backup Node Placement

- Route backup node traffic through a separate path (e.g., `/backup`)
- Configure ALB listener rules to exclude backup node from production traffic
- Consider using a separate target group with no listeners

**Note**: The CDK stack automatically handles this - backup nodes are **NOT** registered with the ALB target group.

### 3. Multiple Backup Nodes Per Environment

Each service stack creates **1 backup node** when DP resilience is enabled. If you deploy multiple services with resilience enabled, you'll have multiple backup nodes:

- Kong automatically runs **leader election** between all backup nodes
- Only one node writes to S3 at a time
- Leader election files: `s3://bucket/kong-config/{version}/election/`
- This is **safe and recommended** for redundancy

### 4. Security

- Use **KMS encryption** for S3 bucket in production (set `DP_RESILIENCE_KMS_KEY_ARN`)
- Enable **S3 bucket versioning** (enabled by default in this CDK)
- Apply **least privilege IAM policies**: Ensure `ecsTaskExecutionRoleArn` has S3 read/write permissions
- Enable **CloudTrail logging** for S3 bucket access

### 5. Monitoring

Monitor these metrics:

- **S3 PUT requests** from backup node (should be consistent)
- **S3 GET requests** from regular nodes (should be zero during normal operation, spikes during CP outage)
- **ECS task startup time** (longer if loading from S3)
- **Kong cluster connection status**
- **Backup service health**: Check CloudWatch logs at `/ecs/kong-backup-{appName}`

## Troubleshooting

### Backup Node Not Writing to S3

**Symptoms**: No `config.json` file in S3 bucket

**Solutions**:

1. Check IAM permissions: `ecsTaskExecutionRoleArn` needs `s3:PutObject`, `s3:DeleteObject`
2. Verify environment variable in backup node: `KONG_CLUSTER_FALLBACK_CONFIG_EXPORT=on`
3. Check Kong logs in CloudWatch: `/ecs/kong-backup-{appName}`
4. Ensure backup node can connect to Konnect Control Plane

### Regular DP Node Not Starting During CP Outage

**Symptoms**: New DP containers fail to start when CP is down

**Solutions**:

1. Check IAM permissions: `ecsTaskExecutionRoleArn` needs `s3:GetObject`, `s3:ListBucket`
2. Verify environment variable: `KONG_CLUSTER_FALLBACK_CONFIG_IMPORT=on`
3. Check S3 bucket: Confirm `config.json` exists at correct path
4. Verify S3 bucket accessibility from ECS tasks (VPC endpoints, NAT gateway)
5. Check CloudWatch logs: `/ecs/kong-data-plane-{appName}`

### Configuration Not Importing Despite S3 File

**Symptoms**: DP reads config but fails to start

**Possible Causes**:

1. **Version mismatch**: `config.json` created by Kong 3.12, but DP is running 3.13
    - Solution: Ensure all DP nodes run the same Kong version
2. **Plugin compatibility**: Config contains plugins not available in DP
    - Solution: Ensure all required plugins are installed
3. **Corrupted config**: S3 file is incomplete or invalid JSON
    - Solution: Check S3 object integrity, enable versioning

### Multiple Backup Nodes Writing Simultaneously

**Symptoms**: S3 PUT rate is 2x-3x expected, election files growing

**Solutions**:

1. Check leader election: Only one backup node should write at a time
2. Verify network connectivity: Ensure backup nodes can communicate
3. Check Kong version: Leader election requires Kong >= 3.6.0.0

## Cost Considerations

### S3 Storage Costs

- **Config file size**: ~100KB - 10MB (depends on number of routes/services)
- **Election files**: ~1KB each, automatically cleaned up after 7 days
- **Monthly cost**: < $0.50 for most deployments

### Data Transfer Costs

- **PUT requests** (backup node): ~1 request per config change (minimal)
- **GET requests** (import nodes): Only during CP outage (minimal)
- **Data transfer**: S3 → ECS is free within same region

### Recommendations

- Enable **S3 Intelligent-Tiering** for long-term config storage
- Configure **lifecycle policy** to delete old versions after 90 days
- Monitor S3 request metrics to detect anomalies

## Version Compatibility

| Kong Gateway Version | DP Resilience Support | Leader Election | Notes                                                |
| -------------------- | --------------------- | --------------- | ---------------------------------------------------- |
| 3.6.0.0+             | ✅ Full support       | ✅ Yes          | Backup node can be provisioned with fallback config  |
| 3.5.x and earlier    | ⚠️ Limited            | ❌ No           | Backup node cannot be provisioned with backup config |
| 3.4.0.0+             | ✅ Basic support      | ❌ Manual       | Feature available, no automatic leader election      |

**Minimum Version**: Kong Gateway 3.4.0.0

## FAQs

### Q: Should the Control Plane also export to S3?

**A**: No. Only Data Plane backup nodes should export. If both CP and DP export, DP writes first, then CP overwrites.

### Q: Does DP always read from S3, even when CP is online?

**A**: No. DP only reads from S3 during **startup** if CP is unreachable. Once running, DP uses cached config and connects to CP.

### Q: What if the backup node fails?

**A**: If you have multiple backup nodes, leader election selects a new leader. If only one backup node, no new configs are written to S3 until it recovers (existing DP nodes continue running with cached configs).

### Q: Can I use this with Kong Gateway on-premises CP?

**A**: Yes, but you need to configure the CP/DP nodes to export/import. With Konnect (SaaS CP), only DP nodes need configuration.

### Q: What are the minimum S3 IAM policy requirements for DP resilience?

**A**: See **IAM Permissions** section above.

## Related Documentation

- [Kong Gateway CP/DP Communication](https://developer.konghq.com/gateway/cp-dp-communication/)
- [Konnect Data Plane Nodes](https://developer.konghq.com/gateway/data-plane-reference/)
- [Kong Configuration Management](https://developer.konghq.com/gateway/manage-kong-conf/)

## Support

For issues or questions:

- [Kong Community Forum](https://discuss.konghq.com/)
- [Kong Support Portal](https://support.konghq.com/) (Enterprise customers)
- [GitHub Issues](https://github.com/Kong/developer.konghq.com/issues/)
