# Redis Setup Guide (AWS ElastiCache)

This guide explains how to configure AWS ElastiCache for Redis as an optional component for Kong Gateway data plane deployments.

## Overview

Redis (via AWS ElastiCache) can be used by Kong Gateway for:

- **Rate Limiting**: Distributed rate limiting across multiple data plane nodes
- **Session Storage**: Store session data for plugins like OpenID Connect
- **Caching**: Response caching and data store for custom plugins
- **Shared State**: Any plugin requiring shared state across data planes

**Important**: Redis is deployed **per-service**, not shared infrastructure. Each service (e.g., customers, bookings) can have its own independent Redis cluster with different configurations.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│         Service Stack (Per Service)                  │
│   ┌──────────────────────────────────────────┐      │
│   │    VPC (Private Subnets)                 │      │
│   │  ┌──────────────────────────────────┐    │      │
│   │  │  ElastiCache Redis Cluster       │    │      │
│   │  │  - Per service instance          │    │      │
│   │  │  - Primary node (write/read)     │    │      │
│   │  │  - Replica nodes (read-only)     │    │      │
│   │  │  - Multi-AZ automatic failover   │    │      │
│   │  └────────┬─────────────────────────┘    │      │
│   │           │ Port 6379 (TLS)               │      │
│   │           │                               │      │
│   │  ┌────────▼─────────────────────────┐    │      │
│   │  │  Security Group                  │    │      │
│   │  │  - Allow from Kong DP SG         │    │      │
│   │  └──────────────────────────────────┘    │      │
│   │                                           │      │
│   │  ┌──────────────────────────────────┐    │      │
│   │  │  Kong Data Plane Containers      │    │      │
│   │  │  - Connect to service Redis      │    │      │
│   │  │  - Use auth token from Secrets   │    │      │
│   │  │  - Read/write via TLS            │    │      │
│   │  └──────────────────────────────────┘    │      │
│   └──────────────────────────────────────────┘      │
└─────────────────────────────────────────────────────┘
```

## Configuration

### Enable Redis

Redis is **disabled by default** for each service. To enable it for a specific service, set:

```bash
export SERVICE1_REDIS_ENABLED=true
```

**Note**: Each service has independent Redis configuration. Service 1 uses `SERVICE1_REDIS_*`, Service 2 uses `SERVICE2_REDIS_*`, etc.

### Basic Configuration

```bash
# Enable Redis for Service 1 (customers)
export SERVICE1_REDIS_ENABLED=true

# Node type (instance class)
export SERVICE1_REDIS_NODE_TYPE=cache.t4g.micro  # Default

# Number of nodes (1 = single node, 2+ = primary + replicas)
export SERVICE1_REDIS_NUM_CACHE_NODES=1  # Default

# Redis version
export SERVICE1_REDIS_ENGINE_VERSION=7.0  # Default
export SERVICE1_REDIS_PARAMETER_GROUP_FAMILY=redis7  # Must match engine version

# Deploy infrastructure and services
npx cdk deploy --all
```

### Production Configuration (Multi-AZ with Replication)

For production deployments, enable Multi-AZ with automatic failover:

```bash
export SERVICE1_REDIS_ENABLED=true
export SERVICE1_REDIS_NODE_TYPE=cache.r7g.large  # Production-grade instance
export SERVICE1_REDIS_NUM_CACHE_NODES=2  # Primary + 1 replica
export SERVICE1_REDIS_MULTI_AZ=true  # Enable automatic failover
export SERVICE1_REDIS_ENCRYPTION_AT_REST=true  # Default
export SERVICE1_REDIS_ENCRYPTION_IN_TRANSIT=true  # Default
export SERVICE1_REDIS_SNAPSHOT_RETENTION_DAYS=7  # Daily backups for 7 days

npx cdk deploy --all
```

### Multiple Services with Different Redis Configurations

Each service can have independent Redis configuration:

```bash
# Service 1 (customers) - Production Redis with Multi-AZ
export SERVICE1_REDIS_ENABLED=true
export SERVICE1_REDIS_NODE_TYPE=cache.r7g.large
export SERVICE1_REDIS_NUM_CACHE_NODES=2
export SERVICE1_REDIS_MULTI_AZ=true

# Service 2 (bookings) - Development Redis (single node)
export SERVICE2_REDIS_ENABLED=true
export SERVICE2_REDIS_NODE_TYPE=cache.t4g.micro
export SERVICE2_REDIS_NUM_CACHE_NODES=1
export SERVICE2_REDIS_MULTI_AZ=false

# Service 3 (payments) - No Redis
export SERVICE3_REDIS_ENABLED=false

npx cdk deploy --all
```

## Environment Variables

### Required Variables (Per Service)

| Variable                   | Description                   | Default |
| -------------------------- | ----------------------------- | ------- |
| `SERVICE{N}_REDIS_ENABLED` | Enable Redis for this service | `false` |

**Note**: Replace `{N}` with the service number (1, 2, 3, etc.)

### Optional Variables (Per Service)

| Variable                                   | Description                   | Default               |
| ------------------------------------------ | ----------------------------- | --------------------- |
| `SERVICE{N}_REDIS_NODE_TYPE`               | ElastiCache node type         | `cache.t4g.micro`     |
| `SERVICE{N}_REDIS_NUM_CACHE_NODES`         | Number of cache nodes         | `1`                   |
| `SERVICE{N}_REDIS_ENGINE_VERSION`          | Redis engine version          | `7.0`                 |
| `SERVICE{N}_REDIS_PARAMETER_GROUP_FAMILY`  | Parameter group family        | `redis7`              |
| `SERVICE{N}_REDIS_ENCRYPTION_AT_REST`      | Enable encryption at rest     | `true`                |
| `SERVICE{N}_REDIS_ENCRYPTION_IN_TRANSIT`   | Enable TLS encryption         | `true`                |
| `SERVICE{N}_REDIS_MULTI_AZ`                | Enable Multi-AZ failover      | `false`               |
| `SERVICE{N}_REDIS_AUTH_TOKEN`              | Authentication token          | Auto-generated        |
| `SERVICE{N}_REDIS_SNAPSHOT_RETENTION_DAYS` | Days to retain snapshots      | `5`                   |
| `SERVICE{N}_REDIS_SNAPSHOT_WINDOW`         | Snapshot time window (UTC)    | `03:00-05:00`         |
| `SERVICE{N}_REDIS_MAINTENANCE_WINDOW`      | Maintenance time window (UTC) | `sun:05:00-sun:07:00` |

## Instance Types

### Development/Testing

- `cache.t4g.micro` - 2 vCPU, 0.5 GB RAM (default, cost-effective)
- `cache.t4g.small` - 2 vCPU, 1.37 GB RAM
- `cache.t4g.medium` - 2 vCPU, 3.09 GB RAM

### Production

- `cache.r7g.large` - 2 vCPU, 13.07 GB RAM
- `cache.r7g.xlarge` - 4 vCPU, 26.32 GB RAM
- `cache.r7g.2xlarge` - 8 vCPU, 52.88 GB RAM
- `cache.r7g.4xlarge` - 16 vCPU, 106.04 GB RAM

**Recommendation**: Use `r7g` (memory-optimized) instances for production workloads.

## Multi-AZ Configuration

For high availability, enable Multi-AZ with automatic failover:

```bash
export SERVICE1_REDIS_MULTI_AZ=true
export SERVICE1_REDIS_NUM_CACHE_NODES=2  # Minimum for Multi-AZ
```

**How it works:**

- **Primary node**: Handles all write operations and reads
- **Replica nodes**: Asynchronously replicate data from primary
- **Automatic failover**: If primary fails, a replica is promoted to primary
- **Multiple AZs**: Nodes are distributed across availability zones
- **Failover time**: Typically 1-3 minutes

**Requirements:**

- `REDIS_NUM_CACHE_NODES` must be 2 or more
- `REDIS_MULTI_AZ` must be `true`

## Security

### Encryption at Rest

Enabled by default. Uses AWS-managed encryption keys.

```bash
export SERVICE1_REDIS_ENCRYPTION_AT_REST=true  # Default
```

### Encryption in Transit (TLS)

Enabled by default. Requires authentication token.

```bash
export SERVICE1_REDIS_ENCRYPTION_IN_TRANSIT=true  # Default
```

### Authentication Token

When encryption in transit is enabled, an auth token is required:

**Option 1: Auto-generated (Recommended)**

If you don't provide `SERVICE{N}_REDIS_AUTH_TOKEN`, a secure token is automatically generated and stored in AWS Secrets Manager:

- Secret Name: `kong-{serviceName}-redis-auth-token-{environment}`
- Secret ARN: Exported as CloudFormation output

**Option 2: Provide your own**

```bash
export SERVICE1_REDIS_AUTH_TOKEN=your-highly-secure-32-character-token
```

**Requirements:**

- Minimum 16 characters
- No special characters recommended
- Keep it secure (use Secrets Manager)

### Network Security

Redis is deployed in private subnets and isolated by security groups:

- Only accessible from within the VPC
- Security group allows inbound traffic on port 6379 only from authorized sources
- No direct internet access

## Connecting Kong to Redis

After deploying Redis, configure Kong to use it:

### 1. Get Connection Details

After deployment, CDK outputs the connection information:

```bash
# Primary endpoint (read/write)
RedisPrimaryEndpoint = kong-redis-dev-xxx.region.cache.amazonaws.com

# Reader endpoint (read-only, if multiple nodes)
RedisReaderEndpoint = kong-redis-dev-xxx-ro.region.cache.amazonaws.com

# Port
RedisPort = 6379

# Auth token secret ARN (if auto-generated)
RedisAuthTokenSecretArn = arn:aws:secretsmanager:region:account:secret:kong-redis-auth-token-dev-xxx
```

### 2. Configure Kong Rate Limiting Plugin

Example Kong configuration using Redis for rate limiting:

```yaml
plugins:
    - name: rate-limiting
      config:
          minute: 100
          policy: redis
          redis_host: kong-redis-dev-xxx.region.cache.amazonaws.com
          redis_port: 6379
          redis_password: <auth-token-from-secrets-manager>
          redis_ssl: true
          redis_ssl_verify: true
          redis_database: 0
```

### 3. Access Auth Token

If auto-generated, retrieve the auth token from Secrets Manager:

```bash
aws secretsmanager get-secret-value \
  --secret-id kong-redis-auth-token-dev \
  --query SecretString \
  --output text
```

## Backup and Recovery

### Automatic Snapshots

Redis automatically creates daily snapshots:

```bash
export SERVICE1_REDIS_SNAPSHOT_RETENTION_DAYS=7  # Keep 7 days of backups
export SERVICE1_REDIS_SNAPSHOT_WINDOW=03:00-05:00  # UTC time window
```

**Set to 0 to disable automatic snapshots:**

```bash
export SERVICE1_REDIS_SNAPSHOT_RETENTION_DAYS=0
```

### Manual Snapshots

Create manual snapshot via AWS Console or CLI:

```bash
aws elasticache create-snapshot \
  --replication-group-id kong-redis-dev \
  --snapshot-name kong-redis-manual-$(date +%Y%m%d)
```

### Restore from Snapshot

To restore from a snapshot, update the CDK stack with the snapshot name.

## Monitoring

### CloudWatch Metrics

ElastiCache automatically publishes metrics to CloudWatch:

- `CPUUtilization` - CPU usage percentage
- `NetworkBytesIn/Out` - Network traffic
- `CurrConnections` - Number of client connections
- `Evictions` - Number of evicted keys
- `CacheHits/Misses` - Cache hit/miss ratio
- `ReplicationLag` - Replication lag (if replicas exist)

### Recommended Alarms

Create CloudWatch alarms for:

- High CPU utilization (> 75%)
- High memory usage (> 80%)
- Evictions (> 0)
- Replication lag (> 30 seconds)

## Maintenance

### Maintenance Window

ElastiCache performs automatic maintenance during the configured window:

```bash
export SERVICE1_REDIS_MAINTENANCE_WINDOW=sun:05:00-sun:07:00  # Sunday 5-7 AM UTC
```

**During maintenance:**

- Minor version upgrades
- Security patches
- Instance replacements (if needed)

**Impact:**

- Single-node: Brief downtime during maintenance
- Multi-AZ: Minimal impact with automatic failover

## Cost Optimization

### Development/Testing

```bash
export SERVICE1_REDIS_NODE_TYPE=cache.t4g.micro  # ~$12/month
export SERVICE1_REDIS_NUM_CACHE_NODES=1
export SERVICE1_REDIS_MULTI_AZ=false
export SERVICE1_REDIS_SNAPSHOT_RETENTION_DAYS=1
```

### Production

```bash
export SERVICE1_REDIS_NODE_TYPE=cache.r7g.large  # ~$146/month per node
export SERVICE1_REDIS_NUM_CACHE_NODES=2  # Primary + 1 replica
export SERVICE1_REDIS_MULTI_AZ=true
export SERVICE1_REDIS_SNAPSHOT_RETENTION_DAYS=7
```

**Cost varies by:**

- Instance type
- Number of nodes
- Snapshot storage
- Data transfer

## Troubleshooting

### Connection Timeouts

**Symptom**: Kong cannot connect to Redis

**Solutions:**

1. Verify security group allows Kong data plane SG
2. Check Redis is in the same VPC
3. Verify endpoint address is correct
4. Ensure auth token is correct (if encryption in transit enabled)

### Authentication Errors

**Symptom**: `NOAUTH Authentication required`

**Solutions:**

1. Enable encryption in transit: `REDIS_ENCRYPTION_IN_TRANSIT=true`
2. Provide auth token in Kong configuration
3. Retrieve auto-generated token from Secrets Manager

### High Memory Usage

**Symptom**: Redis evicting keys or running out of memory

**Solutions:**

1. Increase node type: `cache.t4g.medium` → `cache.r7g.large`
2. Add read replicas to distribute read load
3. Configure maxmemory policy in parameter group
4. Monitor eviction metrics in CloudWatch

### Multi-AZ Not Working

**Symptom**: Multi-AZ failover not configured

**Solutions:**

1. Ensure `REDIS_NUM_CACHE_NODES >= 2`
2. Set `REDIS_MULTI_AZ=true`
3. Redeploy stack: `npx cdk deploy --all`

## Cleanup

To disable Redis for a service and remove the cluster:

```bash
export SERVICE1_REDIS_ENABLED=false
npx cdk deploy --all
```

**Warning**: This will delete the Redis cluster for that service and all cached data. Final snapshot will be created automatically.

## Best Practices

1. **Enable Multi-AZ for production** - Provides automatic failover
2. **Use encryption in transit** - Protects data in flight
3. **Enable automatic backups** - Set retention to 7+ days for production
4. **Monitor metrics** - Create CloudWatch alarms for critical metrics
5. **Use appropriate instance types** - r7g instances for production, t4g for dev/test
6. **Secure auth tokens** - Store in Secrets Manager, never in code
7. **Configure maintenance windows** - Choose low-traffic periods
8. **Test failover** - Regularly test Multi-AZ failover in non-production environments

## References

- [Kong Rate Limiting Plugin](https://docs.konghq.com/hub/kong-inc/rate-limiting/)
- [Kong Redis Configuration](https://docs.konghq.com/gateway/latest/reference/configuration/#redis-settings)
- [AWS ElastiCache for Redis](https://docs.aws.amazon.com/AmazonElastiCache/latest/red-ug/WhatIs.html)
- [ElastiCache Node Types](https://aws.amazon.com/elasticache/pricing/)
