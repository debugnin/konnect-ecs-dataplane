# Multi-Region Deployment Setup

This guide explains how to deploy Kong Data Plane to multiple AWS regions (Sydney and Melbourne) with independent ALBs and Route53 failover for high availability and disaster recovery.

## Architecture Overview

The multi-region setup consists of:

1. **Primary Region (Sydney - ap-southeast-2)**: VPC, ALB, WAF, and Kong services
2. **Secondary Region (Melbourne - ap-southeast-4)**: VPC, ALB, WAF, and Kong services
3. **Route53**: Automated failover routing between regional ALBs using health checks

## Regional ALB Design

Each region has its own independent ALB with **automated Route53 failover**:

```
┌──────────────────────────────────────────────────┐
│     Route53 (api.example.com)                    │
│  ┌──────────────────────┬──────────────────────┐ │
│  │   PRIMARY            │   SECONDARY          │ │
│  │   (Health Check ✅)  │   (Standby)          │ │
│  └────────┬─────────────┴──────────┬───────────┘ │
└───────────┼────────────────────────┼─────────────┘
            │                        │
            │ (Health check fails)   │
            │ ────────Failover─────> │
            │                        │
    ┌───────▼──────────┐    ┌────────▼────────┐
    │   ALB Sydney     │    │  ALB Melbourne  │
    │   Kong DP        │    │   Kong DP       │
    └──────────────────┘    └─────────────────┘
```

**Benefits:**

- ✅ **Fully automated failover** - No manual Route53 configuration needed
- ✅ Complete regional independence
- ✅ Simple per-region management
- ✅ Clear separation of concerns
- ✅ 1-2 minute automatic failover time

**Trade-offs:**

- Failover takes 1-2 minutes (health check detection + DNS TTL)

## Deployment Flow

The Bitbucket pipeline deploys with **automated Route53 failover** in the following order:

```
1. Primary Region (Sydney) → Infrastructure (VPC, ALB, WAF + Route53 FAILOVER PRIMARY + Health Check) + Services
2. Secondary Region (Melbourne) → Infrastructure (VPC, ALB, WAF + Route53 FAILOVER SECONDARY) + Services
3. ✅ Automatic Failover: Route53 monitors primary health and fails over to secondary automatically
```

**Automated Features:**

- ✅ Primary region creates ALB with Route53 FAILOVER PRIMARY record + health check
- ✅ Secondary region creates ALB with Route53 FAILOVER SECONDARY record
- ✅ Route53 automatically fails over to secondary when primary health check fails (1-2 min detection)
- ✅ Both records point to the same domain (`api.example.com`) with different `SetIdentifier` values
- ✅ No manual Route53 configuration required after deployment

## Environment Variables

### Required for Multi-Region

| Variable               | Description                                 | Example                            |
| ---------------------- | ------------------------------------------- | ---------------------------------- |
| `AWS_DEFAULT_REGION`   | Primary region (Sydney)                     | `ap-southeast-2`                   |
| `AWS_SECONDARY_REGION` | Secondary region (Melbourne)                | `ap-southeast-4`                   |
| `REGIONAL_SUFFIX`      | Stack name suffix for secondary region only | `secondary` (auto-set by pipeline) |

### Existing Required Variables

All existing environment variables from the single-region setup are still required:

- `ALB_DOMAIN`
- `ALB_HOSTED_ZONE_ID`
- `ALB_HOSTED_ZONE_NAME`
- `SERVICE1_NAME`, `SERVICE1_PATH`, `SERVICE1_SECRET_ARN`
- etc.

## Stack Naming Convention

### Primary Region (Sydney)

- `kong-infra-stack` (ap-southeast-2)
- `kong-{appName}-service-stack` (ap-southeast-2)

### Secondary Region (Melbourne)

- `kong-infra-stack-secondary` (ap-southeast-4)
- `kong-{appName}-service-stack-secondary` (ap-southeast-4)

**Note**: Primary region uses default naming (no suffix). Secondary region includes `-secondary` suffix for clear differentiation.

## Automated Route53 Failover

**No manual configuration required!** The CDK deployment automatically creates:

### Primary Region (Sydney)

- Route53 A Record with:
    - `SetIdentifier`: "Primary"
    - `Failover`: PRIMARY
    - `HealthCheck`: HTTPS check to `api.example.com/health` every 30 seconds
    - ALB alias target

### Secondary Region (Melbourne)

- Route53 A Record with:
    - `SetIdentifier`: "Secondary"
    - `Failover`: SECONDARY
    - ALB alias target
    - Activated automatically when primary health check fails

### How Failover Works

1. **Normal Operation**: Route53 directs all traffic to Sydney (PRIMARY)
2. **Primary Failure Detected**: Route53 health check fails 3 consecutive times (90 seconds)
3. **Automatic Switchover**: Route53 routes traffic to Melbourne (SECONDARY)
4. **Recovery**: When Sydney health checks pass again, traffic routes back to PRIMARY

**Total Failover Time**: ~1-2 minutes (health check detection + DNS TTL propagation)

## Manual Route53 Routing Options (Optional Advanced Configuration)

If you prefer different routing policies instead of automated failover, you can modify the deployment or manually configure Route53 after deployment. Here are alternative patterns:

**Note:** ALB hosted zone IDs vary by region. Replace `Z1234567890ABC` with your Route53 hosted zone ID, and replace the ALB DNS names with the actual values from the deployment.

### Option 1: Failover Routing (✅ Already Automated - Default)

The automated deployment creates this configuration. This example is shown for reference:

```bash
# Create primary record (Sydney)
aws route53 change-resource-record-sets \
  --hosted-zone-id Z1234567890ABC \
  --change-batch '{
    "Changes": [{
      "Action": "CREATE",
      "ResourceRecordSet": {
        "Name": "api.example.com",
        "Type": "A",
        "SetIdentifier": "Sydney-Primary",
        "Failover": "PRIMARY",
        "AliasTarget": {
          "HostedZoneId": "<alb-hosted-zone-id>",
          "DNSName": "kong-alb-prd-1234567890.ap-southeast-2.elb.amazonaws.com",
          "EvaluateTargetHealth": true
        },
        "HealthCheckId": "abcd1234-5678-90ab-cdef-EXAMPLE11111"
      }
    }]
  }'

# Create secondary record (Melbourne)
aws route53 change-resource-record-sets \
  --hosted-zone-id Z1234567890ABC \
  --change-batch '{
    "Changes": [{
      "Action": "CREATE",
      "ResourceRecordSet": {
        "Name": "api.example.com",
        "Type": "A",
        "SetIdentifier": "Melbourne-Secondary",
        "Failover": "SECONDARY",
        "AliasTarget": {
          "HostedZoneId": "<alb-hosted-zone-id>",
          "DNSName": "kong-alb-prd-0987654321.ap-southeast-4.elb.amazonaws.com",
          "EvaluateTargetHealth": true
        }
      }
    }]
  }'
```

### Option 2: Weighted Routing (Manual - For Load Distribution)

**To implement this**: First delete the automated failover records, then configure weighted routing to distribute traffic:

```bash
# Sydney - 70% weight
aws route53 change-resource-record-sets \
  --hosted-zone-id Z1234567890ABC \
  --change-batch '{
    "Changes": [{
      "Action": "CREATE",
      "ResourceRecordSet": {
        "Name": "api.example.com",
        "Type": "A",
        "SetIdentifier": "Sydney",
        "Weight": 70,
        "AliasTarget": {
          "HostedZoneId": "<alb-hosted-zone-id>",
          "DNSName": "kong-alb-prd-1234567890.ap-southeast-2.elb.amazonaws.com",
          "EvaluateTargetHealth": true
        }
      }
    }]
  }'

# Melbourne - 30% weight
aws route53 change-resource-record-sets \
  --hosted-zone-id Z1234567890ABC \
  --change-batch '{
    "Changes": [{
      "Action": "CREATE",
      "ResourceRecordSet": {
        "Name": "api.example.com",
        "Type": "A",
        "SetIdentifier": "Melbourne",
        "Weight": 30,
        "AliasTarget": {
          "HostedZoneId": "<alb-hosted-zone-id>",
          "DNSName": "kong-alb-prd-0987654321.ap-southeast-4.elb.amazonaws.com",
          "EvaluateTargetHealth": true
        }
      }
    }]
  }'
```

### Option 3: Latency-Based Routing (Manual - For Best Performance)

**To implement this**: First delete the automated failover records, then configure latency-based routing:

```bash
# Sydney record
aws route53 change-resource-record-sets \
  --hosted-zone-id Z1234567890ABC \
  --change-batch '{
    "Changes": [{
      "Action": "CREATE",
      "ResourceRecordSet": {
        "Name": "api.example.com",
        "Type": "A",
        "SetIdentifier": "Sydney",
        "Region": "ap-southeast-2",
        "AliasTarget": {
          "HostedZoneId": "<alb-hosted-zone-id>",
          "DNSName": "kong-alb-prd-1234567890.ap-southeast-2.elb.amazonaws.com",
          "EvaluateTargetHealth": true
        }
      }
    }]
  }'

# Melbourne record
aws route53 change-resource-record-sets \
  --hosted-zone-id Z1234567890ABC \
  --change-batch '{
    "Changes": [{
      "Action": "CREATE",
      "ResourceRecordSet": {
        "Name": "api.example.com",
        "Type": "A",
        "SetIdentifier": "Melbourne",
        "Region": "ap-southeast-4",
        "AliasTarget": {
          "HostedZoneId": "<alb-hosted-zone-id>",
          "DNSName": "kong-alb-prd-0987654321.ap-southeast-4.elb.amazonaws.com",
          "EvaluateTargetHealth": true
        }
      }
    }]
  }'
```

## Health Check Configuration (✅ Already Automated)

The deployment automatically creates a Route53 health check for the primary region with these settings:

- **Type**: HTTPS
- **Domain**: api.example.com (your custom domain)
- **Port**: 443
- **Path**: `/health`
- **Interval**: 30 seconds
- **Failure Threshold**: 3 consecutive failures (90 seconds total)

This health check is automatically attached to the PRIMARY Route53 record. When it fails, Route53 routes traffic to the SECONDARY record.

### Manual Health Check Creation (Advanced - Not Needed)

If you need additional health checks for custom routing policies:

```bash
aws route53 create-health-check \
  --caller-reference "kong-sydney-$(date +%s)" \
  --health-check-config '{
    "Type": "HTTPS",
    "ResourcePath": "/health",
    "FullyQualifiedDomainName": "api.example.com",
    "Port": 443,
    "RequestInterval": 30,
    "FailureThreshold": 3
  }'
```

## Verifying ALB Deployments

After deployment, verify both ALBs were created:

```bash
# Primary Region (Sydney)
aws cloudformation describe-stacks \
  --region ap-southeast-2 \
  --stack-name kong-infra-stack \
  --query "Stacks[0].Outputs[?OutputKey=='AlbDnsName'].OutputValue" \
  --output text

# Secondary Region (Melbourne)
aws cloudformation describe-stacks \
  --region ap-southeast-4 \
  --stack-name kong-infra-stack-secondary \
  --query "Stacks[0].Outputs[?OutputKey=='AlbDnsName'].OutputValue" \
  --output text
```

## Deployment Commands

### Deploy to Both Regions

```bash
# Using Bitbucket pipeline (automatically deploys to both regions)
git push origin main

# Or manually trigger custom pipeline
# Bitbucket UI: Pipelines > Run Pipeline > Custom: deploy
```

### Deploy to Single Region Only

```bash
# Primary region only (Sydney) - no suffix
export CDK_DEFAULT_REGION=ap-southeast-2
npx cdk deploy --all --require-approval never

# Secondary region only (Melbourne) - with suffix
export CDK_DEFAULT_REGION=ap-southeast-4
npx cdk deploy --all --require-approval never --context regionalSuffix=secondary
```

## Disaster Recovery Scenarios

### Primary Region Failure (Automated ✅)

With the **automated failover routing** (default):

1. Route53 health check detects primary region failure (3 consecutive failures = 90 seconds)
2. Traffic automatically routes to Melbourne (SECONDARY) within 1-2 minutes
3. **No manual intervention required**

With **custom weighted/latency routing** (if manually configured):

1. Update Route53 to set Sydney weight to 0 or remove Sydney record
2. All traffic routes to Melbourne
3. Requires manual DNS update

### Restoring Primary Region (Automated ✅)

With the **automated failover routing** (default):

1. Fix issues in Sydney region
2. Health checks pass automatically (3 consecutive successes)
3. Route53 automatically fails back to PRIMARY
4. **No manual intervention required**

With **custom routing** (if manually configured):

1. Fix issues in Sydney region
2. Restore weights/latency routing or re-enable Sydney record
3. Requires manual DNS update

## Cost Considerations

- **Duplicate Resources**: Running full infrastructure in both regions
- **CloudWatch Logs**: Logs from both regions
- **Route53 Health Checks**: $0.50/month per health check

## Testing Multi-Region Setup

```bash
# Test primary region
curl -v https://api.example.com/health

# Test secondary region directly (using ALB DNS name)
curl -H "Host: api.example.com" https://[melbourne-alb-dns]/health

# Test Route53 routing
dig api.example.com
curl https://api.example.com/health
```

## Monitoring and Alerts

Monitor both regions:

1. **CloudWatch Dashboards**: Create dashboards for each region
2. **CloudWatch Alarms**: Set up alarms for:
    - ECS task health
    - ALB target health
    - Route53 health check status
3. **X-Ray**: Trace requests across regions
4. **New Relic**: Unified view of both regions (if metrics streaming enabled)

## Rollback Strategy

If secondary region deployment fails:

```bash
# Destroy secondary region stacks
export CDK_DEFAULT_REGION=ap-southeast-4
npx cdk destroy --all --context regionalSuffix=secondary

# Primary region continues unaffected
```

## Data Consistency

Kong Konnect (SaaS control plane) ensures configuration consistency across both data planes:

- Control plane configuration is shared
- Data planes sync independently from Konnect
- No cross-region data synchronization needed
- Each region is fully autonomous

## Best Practices

1. **Test failover regularly** - Verify health checks and failover behavior
2. **Monitor both regions** - Set up CloudWatch dashboards and alarms
3. **Use the same configuration** - Keep environment variables consistent
4. **Plan for capacity** - Ensure secondary region can handle full load
5. **Document runbooks** - Create procedures for failover scenarios
6. **Regular DR drills** - Test disaster recovery procedures quarterly
