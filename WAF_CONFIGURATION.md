# WAF Configuration Guide

This guide explains how to configure AWS WAF for the Kong Data Plane infrastructure, including CIDR-based access control.

## Overview

The Kong Data Plane deployment includes a WAF Web ACL:

- **ALB WAF** (Regional): Protects the Application Load Balancer

The WAF is configured through environment variables.

## Features

### AWS Managed Rule Groups

By default, the following AWS Managed Rule Groups are enabled:

- **AWSManagedRulesCommonRuleSet**: Protection against common web exploits
- **AWSManagedRulesKnownBadInputsRuleSet**: Protection against known bad inputs
- **AWSManagedRulesAmazonIpReputationList**: Blocks requests from known malicious IPs

### Rate Limiting

Rate limiting is enabled by default with a configurable threshold:

- **Default**: 2000 requests per minute per IP
- **Configurable via**: `WAF_RATE_LIMIT` environment variable

### CIDR-Based Access Control

You can restrict access to only allow traffic from specific IP address ranges (CIDRs).

## Configuration

### Environment Variables

| Variable                      | Description                                 | Default | Example                          |
| ----------------------------- | ------------------------------------------- | ------- | -------------------------------- |
| `WAF_ENABLED`                 | Enable/disable WAF                          | `true`  | `true`, `false`                  |
| `WAF_RATE_LIMIT`              | Rate limit (requests per minute per IP)     | `2000`  | `1000`, `5000`                   |
| `WAF_ALLOWED_CIDRS`           | Comma-separated list of allowed CIDR blocks | (empty) | `203.0.113.0/24,198.51.100.0/24` |
| `WAF_ENABLE_CIDR_RESTRICTION` | Enable CIDR-based access control            | `false` | `true`, `false`                  |

## CIDR Restriction Setup

### How It Works

CIDR restriction is **enabled by default** for security. When enabled:

1. An IP Set is created in AWS WAF containing all allowed CIDR blocks
2. A WAF rule is added with **highest priority** to allow traffic from the IP Set
3. The WAF's default action is changed from "Allow" to "Block"
4. Traffic from non-allowlisted IPs receives a **403 Forbidden** response
5. AWS Managed Rules and rate limiting still apply to allowed traffic

### Configuration Steps

#### Option 1: Bitbucket Deployment Variables

For deployments through Bitbucket Pipelines, configure environment variables in your repository or deployment settings:

1. Navigate to **Repository Settings** → **Deployments** → **Your Environment** (e.g., DEV_NEW, production)
2. Add deployment variables:

    ```
    WAF_ALLOWED_CIDRS = 203.0.113.0/24,198.51.100.0/24,192.0.2.0/24
    ```

3. **(Optional)** To disable CIDR restriction entirely:
    ```
    WAF_ENABLE_CIDR_RESTRICTION = false
    ```

```bash
WAF_ALLOWED_CIDRS="10.0.0.0/8,172.16.0.0/12,192.168.0.0/16" \
SERVICE1_NAME="customers" \
SERVICE1_PATH="/customers" \
SERVICE1_SECRET_ARN="arn:aws:secretsmanager:..." \
npx cdk deploy --all
```

#### Option 3: CDK Context

```bash
npx cdk deploy --all \
  --context wafAllowedCidrs="203.0.113.0/24,198.51.100.0/24"
```

To disable CIDR restriction:

```bash
npx cdk deploy --all \
  --context wafEnableCidrRestriction=false
```

### CIDR Format Requirements

- **Valid IPv4 CIDR notation**: `a.b.c.d/n` where `n` is between 0-32
- **Multiple CIDRs**: Separated by commas with **no spaces**
- **Examples**:
    - Single CIDR: `203.0.113.0/24`
    - Multiple CIDRs: `203.0.113.0/24,198.51.100.0/24,192.0.2.0/24`
    - RFC 1918 private ranges: `10.0.0.0/8,172.16.0.0/12,192.168.0.0/16`

### Example Use Cases

#### 1. Corporate Network Access Only

Restrict access to your corporate IP ranges:

```bash
WAF_ALLOWED_CIDRS="203.0.113.0/24,198.51.100.0/24"
```

#### 2. Partner Integration

Allow access from your organization and partner networks:

```bash
WAF_ALLOWED_CIDRS="203.0.113.0/24,198.51.100.0/24,192.0.2.0/24,192.0.2.128/25"
```

#### 3. Development Environment

Allow access from VPN and office networks:

```bash
WAF_ALLOWED_CIDRS="10.0.0.0/8,172.16.0.0/12"
```

## Verifying Configuration

### Check WAF Configuration

After deployment, verify the WAF configuration:

```bash
# For ALB WAF (regional, e.g., ap-southeast-2)
aws wafv2 list-web-acls --scope REGIONAL --region ap-southeast-2
```

### Test Access

Test from an allowed IP:

```bash
curl -v https://api.example.com/health
# Expected: 200 OK
```

Test from a non-allowed IP (if CIDR restriction is enabled):

```bash
curl -v https://api.example.com/health
# Expected: 403 Forbidden
```

### View WAF Metrics

Monitor WAF activity in CloudWatch:

```bash
# View allowed requests
aws cloudwatch get-metric-statistics \
  --namespace AWS/WAFV2 \
  --metric-name AllowedRequests \
  --dimensions Name=Rule,Value=AllowOnlyFromAllowedCidrs \
  --start-time 2026-03-16T00:00:00Z \
  --end-time 2026-03-16T23:59:59Z \
  --period 3600 \
  --statistics Sum

# View blocked requests
aws cloudwatch get-metric-statistics \
  --namespace AWS/WAFV2 \
  --metric-name BlockedRequests \
  --dimensions Name=WebACL,Value=kong-alb-waf-dev \
  --start-time 2026-03-16T00:00:00Z \
  --end-time 2026-03-16T23:59:59Z \
  --period 3600 \
  --statistics Sum
```

## Updating CIDR Lists

To update the allowed CIDR list:

1. Update the `WAF_ALLOWED_CIDRS` environment variable
2. Redeploy the stack:
    ```bash
    npx cdk deploy kong-infra-stack-${ENVIRONMENT}
    ```

The IP Set in WAF will be updated with the new CIDRs.

## Disabling CIDR Restriction

To disable CIDR restriction and allow all traffic (subject to other WAF rules):

1. Set `WAF_ENABLE_CIDR_RESTRICTION=false`
2. Redeploy the stack

The WAF will revert to the default "Allow" action with managed rules still active.

## Troubleshooting

### Issue: All traffic is blocked

**Possible causes:**

- `WAF_ENABLE_CIDR_RESTRICTION=true` but `WAF_ALLOWED_CIDRS` is empty or invalid
- CIDR format is incorrect

**Solution:**

- Verify CIDR format (e.g., `203.0.113.0/24`)
- Ensure no spaces in the comma-separated list
- Check CloudWatch Logs for WAF sampled requests

### Issue: Legitimate traffic is blocked

**Possible causes:**

- The client IP is not in the allowed CIDR list
- A proxy is changing the source IP

**Solution:**

- Check the actual source IP in WAF sampled requests
- Ensure the CIDR list includes all expected client IPs
- Consider using a broader CIDR range if needed

### Issue: WAF IP Set not found

**Possible causes:**

- Stack deployment failed
- Wrong region selected

**Solution:**

- Check CloudFormation stack status
- Verify you're checking the correct region (the region where the ALB WAF was deployed)

## Architecture Notes

### Multi-Region Deployments

For multi-region deployments, a separate **ALB WAF** is deployed per region (e.g., ap-southeast-2, ap-southeast-4). Both use the same CIDR configuration from environment variables.

### WAF Rule Priority

WAF rules are evaluated in priority order:

1. **Priority 1**: CIDR allowlist (if enabled) - ALLOW action
2. **Priority 2+**: AWS Managed Rules - Block/Count actions
3. **Priority N**: Rate limiting - BLOCK action
4. **Default Action**:
    - BLOCK (if CIDR restriction enabled)
    - ALLOW (if CIDR restriction disabled)

## Cost Considerations

- WAF Web ACL: ~$5/month per Web ACL
- WAF Rules: $1/month per rule
- IP Sets: No additional charge
- WAF Requests: $0.60 per million requests

Enabling CIDR restriction adds:

- 1 additional WAF rule per Web ACL
- 1 IP Set per Web ACL
- Estimated cost: ~$2-3/month per environment

## Best Practices

1. **Start broad, then narrow**: Begin with broader CIDR ranges and narrow as needed
2. **Test before production**: Verify CIDR restrictions in dev/qa before applying to production
3. **Document IP ranges**: Maintain documentation of what each CIDR represents
4. **Monitor metrics**: Regularly check CloudWatch metrics for blocked requests
5. **Plan for changes**: Have a process to quickly update CIDRs when IPs change
6. **Use VPN**: Consider using a VPN with static IPs for easier management
7. **Combine with other security**: CIDR restriction complements but doesn't replace other security measures (mTLS, API keys, etc.)

## Related Documentation

- [AWS WAF Documentation](https://docs.aws.amazon.com/waf/)
- [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md) - General deployment guide
- [MULTI_REGION_SETUP.md](MULTI_REGION_SETUP.md) - Multi-region deployment
- [README.md](README.md) - Project overview
