# CloudWatch Logs Forwarding to Central Account

This guide explains how to set up cross-account log forwarding from Kong Data Plane stacks to a central logging account using CloudWatch Logs subscription filters.

**Key Feature:** Infrastructure logs (VPC, Metrics) are **automatically collected and forwarded** - no manual log group configuration needed!

## Architecture

```
Source Account (Data Plane Stack)
  ├─ Infrastructure Stack
  │    ├─ VPC Flow Logs (auto-collected)
  │    ├─ Metrics Firehose HTTP Logs (auto-collected)
  │    └─ Metrics Firehose S3 Logs (auto-collected)
  │
  ├─ Service Stacks (specify via LOGGING_LOG_GROUP_NAMES)
  │    └─ /ecs/kong-data-plane-* (ECS Task Logs)
  │
  └─ Subscription Filters (auto-created)
       ↓
Central Account (e.g., 123456789012)
  ├─ CloudWatch Logs Destination
  ├─ Kinesis Firehose Delivery Stream
  └─ Final Destinations (S3, OpenSearch, New Relic, etc.)
```

## Prerequisites in Central Account

### 1. Create IAM Role for CloudWatch Logs to Firehose

**Trust Policy:**

```json
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Principal": {
                "Service": "logs.amazonaws.com"
            },
            "Action": "sts:AssumeRole",
            "Condition": {
                "StringLike": {
                    "aws:SourceArn": "arn:aws:logs:*:*:*"
                }
            }
        }
    ]
}
```

**Permissions Policy:**

```json
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Action": ["firehose:PutRecord", "firehose:PutRecordBatch"],
            "Resource": "arn:aws:firehose:ap-southeast-2:123456789012:deliverystream/central-logs-stream"
        }
    ]
}
```

**Create Role:**

```bash
aws iam create-role \
  --role-name CWLtoFirehoseRole \
  --assume-role-policy-document file://trust-policy.json \
  --region ap-southeast-2

aws iam put-role-policy \
  --role-name CWLtoFirehoseRole \
  --policy-name CWLtoFirehosePolicy \
  --policy-document file://permissions-policy.json \
  --region ap-southeast-2
```

### 2. Create Kinesis Firehose Delivery Stream

Create a Firehose delivery stream in the central account (if not already exists):

```bash
aws firehose create-delivery-stream \
  --delivery-stream-name central-logs-stream \
  --delivery-stream-type DirectPut \
  --s3-destination-configuration \
    RoleARN=arn:aws:iam::123456789012:role/FirehoseToS3Role,\
    BucketARN=arn:aws:s3:::central-logs-bucket,\
    Prefix=logs/,\
    CompressionFormat=GZIP \
  --region ap-southeast-2
```

### 3. Create CloudWatch Logs Destination

```bash
aws logs put-destination \
  --destination-name CentralLogDestination \
  --target-arn arn:aws:firehose:ap-southeast-2:123456789012:deliverystream/central-logs-stream \
  --role-arn arn:aws:iam::123456789012:role/CWLtoFirehoseRole \
  --region ap-southeast-2
```

**Note the Destination ARN returned** - you'll need this for the source account configuration.

### 4. Set Destination Policy (Allow Source Accounts)

```bash
aws logs put-destination-policy \
  --destination-name CentralLogDestination \
  --access-policy '{
    "Version": "2012-10-17",
    "Statement": [
      {
        "Effect": "Allow",
        "Principal": {
          "AWS": [
            "123456789012",
            "234567890123"
          ]
        },
        "Action": [
          "logs:PutSubscriptionFilter"
        ],
        "Resource": "arn:aws:logs:ap-southeast-2:123456789012:destination:CentralLogDestination"
      }
    ]
  }' \
  --region ap-southeast-2
```

Replace the account IDs with your actual source account IDs.

## Configuration in Source Account (CDK Stack)

### Environment Variables

Add these to your deployment pipeline or `.env` file:

```bash
# Enable logging to central account
LOGGING_ENABLED=true

# Central account destination ARN (from step 3 above)
LOGGING_CENTRAL_DESTINATION_ARN=arn:aws:logs:ap-southeast-2:123456789012:destination:CentralLogDestination

# Additional log groups to forward (comma-separated, optional)
# Infrastructure logs (VPC, Metrics) are automatically collected
# Only specify service logs here: /ecs/kong-data-plane-customers,/ecs/kong-data-plane-other-service
LOGGING_LOG_GROUP_NAMES=/ecs/kong-data-plane-customers

# Optional: Filter pattern (default: "" = all logs)
LOGGING_FILTER_PATTERN=""

# Note: IAM role for subscription filters is created automatically by the stack
```

### Automatically Collected Log Groups

The infrastructure stack **automatically collects and forwards** these log groups (no configuration needed):

| Log Group                                     | Description                 | Source Construct  |
| --------------------------------------------- | --------------------------- | ----------------- |
| (Auto-generated VPC flow log name)            | VPC network flow logs       | VPC Construct     |
| `/aws/kinesisfirehose/kong-metrics-http`      | Firehose HTTP delivery logs | Metrics Construct |
| `/aws/kinesisfirehose/kong-metrics-s3-backup` | Firehose S3 backup logs     | Metrics Construct |

### Additional Log Groups

For **service-specific logs** (in separate service stacks), specify them via `LOGGING_LOG_GROUP_NAMES`:

| Log Group Pattern                      | Description                          |
| -------------------------------------- | ------------------------------------ |
| `/ecs/kong-data-plane-${SERVICE_NAME}` | ECS task application logs            |
| `/aws/lambda/*`                        | Lambda function logs (if applicable) |

**Note:** You must specify explicit log group names (wildcards not supported in CDK construct).

## Deployment

### Deploy Infrastructure Stack

```bash
# Deploy with logging enabled (infrastructure logs auto-collected)
cdk deploy KongKonnectStack-Infrastructure \
  --context loggingEnabled=true \
  --context loggingCentralDestinationArn='arn:aws:logs:ap-southeast-2:123456789012:destination:CentralLogDestination'

# To also forward service logs, add them explicitly
cdk deploy KongKonnectStack-Infrastructure \
  --context loggingEnabled=true \
  --context loggingCentralDestinationArn='arn:aws:logs:ap-southeast-2:123456789012:destination:CentralLogDestination' \
  --context loggingLogGroupNames='/ecs/kong-data-plane-customers,/ecs/kong-data-plane-other-service'
```

Or set environment variables in your pipeline:

```yaml
# bitbucket-pipelines.yml
# Infrastructure logs (VPC, Metrics) are automatically collected
- export LOGGING_ENABLED=true
- export LOGGING_CENTRAL_DESTINATION_ARN='arn:aws:logs:ap-southeast-2:123456789012:destination:CentralLogDestination'

# Optional: Add service logs
- export LOGGING_LOG_GROUP_NAMES='/ecs/kong-data-plane-customers'

- npm run cdk deploy KongKonnectStack-Infrastructure -- --require-approval never
```

## Verification

### Check Subscription Filters in Source Account

```bash
# List subscription filters for a log group
aws logs describe-subscription-filters \
  --log-group-name /aws/vpc/flowlogs \
  --region ap-southeast-2
```

### Check Logs in Central Account

```bash
# Check Firehose delivery stream status
aws firehose describe-delivery-stream \
  --delivery-stream-name central-logs-stream \
  --region ap-southeast-2

# Check S3 bucket for delivered logs
aws s3 ls s3://central-logs-bucket/logs/ --recursive
```

### CloudWatch Logs Insights Query (Central Account)

Query aggregated logs across all source accounts in the central account's CloudWatch Logs Insights (if using CloudWatch destination instead of Firehose).

## Troubleshooting

### Subscription Filter Creation Fails

**Error:** `User: ... is not authorized to perform: logs:PutSubscriptionFilter`

**Solution:** Ensure the destination policy in the central account allows your source account ID.

### No Logs Appearing in Central Account

1. **Check subscription filter status:**

    ```bash
    aws logs describe-subscription-filters \
      --log-group-name /aws/vpc/flowlogs
    ```

2. **Check Firehose metrics:**

    ```bash
    aws cloudwatch get-metric-statistics \
      --namespace AWS/Firehose \
      --metric-name IncomingRecords \
      --dimensions Name=DeliveryStreamName,Value=central-logs-stream \
      --start-time 2026-02-25T00:00:00Z \
      --end-time 2026-02-25T23:59:59Z \
      --period 3600 \
      --statistics Sum
    ```

3. **Check IAM role trust policy** in central account allows `logs.amazonaws.com`.

4. **Verify log group exists** before creating subscription filter.

### Cost Considerations

- **Data Transfer:** Cross-account log forwarding incurs data transfer costs.
- **CloudWatch Logs Ingestion:** Charged per GB ingested in both source and destination accounts.
- **Firehose:** Charged per GB transmitted.
- **S3 Storage:** Charged for stored logs.

**Recommendation:** Use filter patterns to reduce unnecessary log volume.

Example filter pattern for errors only:

```bash
LOGGING_FILTER_PATTERN="[ERROR]"
```

## IAM Policy for Manual Setup (Alternative)

If you prefer to create the subscription role manually instead of letting CDK create it:

**Trust Policy:**

```json
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Principal": {
                "Service": "logs.amazonaws.com"
            },
            "Action": "sts:AssumeRole"
        }
    ]
}
```

**Permissions Policy:**

```json
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Action": ["logs:PutLogEvents"],
            "Resource": "arn:aws:logs:ap-southeast-2:123456789012:destination:CentralLogDestination"
        }
    ]
}
```

**Note**: The stack automatically creates an IAM role with these permissions. No manual role creation is required.

## References

- [CloudWatch Logs Cross-Account Subscription](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/CrossAccountSubscriptions.html)
- [Kinesis Firehose Documentation](https://docs.aws.amazon.com/firehose/latest/dev/what-is-this-service.html)
- [CloudWatch Logs Subscription Filters](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/SubscriptionFilters.html)
