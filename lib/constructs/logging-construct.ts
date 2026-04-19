/**
 * LoggingConstruct - Forward CloudWatch Logs to Central Account via Subscription Filters
 *
 * This construct creates CloudWatch Logs subscription filters to forward logs from the
 * source account to a central account's Kinesis Firehose delivery stream.
 *
 * Architecture:
 *   Source Account (this stack):
 *     CloudWatch Log Groups
 *       ↓ (Subscription Filter)
 *   Central Account (e.g., 911167909672):
 *     CloudWatch Logs Destination
 *       ↓
 *     Kinesis Firehose
 *       ↓
 *     S3 / OpenSearch / New Relic / etc.
 *
 * Prerequisites in Central Account:
 *   1. Create Kinesis Firehose delivery stream
 *   2. Create IAM role for Firehose (trust: logs.amazonaws.com from source accounts)
 *   3. Create CloudWatch Logs Destination:
 *        aws logs put-destination \
 *          --destination-name "CentralLogDestination" \
 *          --target-arn "arn:aws:firehose:REGION:CENTRAL_ACCOUNT:deliverystream/NAME" \
 *          --role-arn "arn:aws:iam::CENTRAL_ACCOUNT:role/CWLtoFirehoseRole"
 *   4. Add destination policy to allow source accounts:
 *        aws logs put-destination-policy \
 *          --destination-name "CentralLogDestination" \
 *          --access-policy '{"Statement":[{"Effect":"Allow","Principal":{"AWS":"SOURCE_ACCOUNT_ID"},"Action":"logs:PutSubscriptionFilter","Resource":"*"}]}'
 *
 * Environment Variables:
 *   LOGGING_ENABLED=true
 *   LOGGING_CENTRAL_DESTINATION_ARN=arn:aws:logs:REGION:ACCOUNT:destination:NAME
 *   LOGGING_LOG_GROUP_NAMES=/aws/vpc/flowlogs,/ecs/kong-data-plane-*
 *   LOGGING_FILTER_PATTERN=""  (optional)
 *
 * Note: IAM role for subscription filters is created automatically by the construct.
 *
 * Example Usage:
 *   new LoggingConstruct(this, 'LoggingConstruct', {
 *     centralDestinationArn: 'arn:aws:logs:ap-southeast-2:911167909672:destination:CentralLogDestination',
 *     logGroupNames: [
 *       '/aws/vpc/flowlogs',
 *       '/ecs/kong-data-plane-customers',
 *       '/aws/kinesisfirehose/kong-metrics-http'
 *     ],
 *     filterPattern: '',  // Forward all logs
 *   });
 */
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';

export interface LoggingConstructProps {
    /**
     * Environment: dev, qa, uat, prd
     */
    environment: string;

    /**
     * ARN of the CloudWatch Logs destination in the central account.
     * Format: arn:aws:logs:region:account-id:destination:destination-name
     */
    centralDestinationArn: string;

    /**
     * Log groups to subscribe and forward to central account.
     * Can use wildcards in log group names for pattern matching.
     */
    logGroupNames: string[];

    /**
     * Optional filter pattern to apply to log events.
     * Default: "" (all log events)
     * Examples: "[ERROR]", "[level = ERROR]", etc.
     */
    filterPattern?: string;
}

export class LoggingConstruct extends Construct {
    public readonly subscriptionFilters: logs.CfnSubscriptionFilter[];
    public readonly subscriptionRole: iam.Role;
    private readonly environmentName: string;

    constructor(scope: Construct, id: string, props: LoggingConstructProps) {
        super(scope, id);

        this.environmentName = props.environment;

        const { centralDestinationArn, logGroupNames, filterPattern = '' } = props;

        // Create IAM role for subscription filter
        this.subscriptionRole = new iam.Role(this, 'SubscriptionRole', {
            roleName: `kong-logstreaming-role-${this.environmentName}`,
            assumedBy: new iam.ServicePrincipal('logs.amazonaws.com'),
            description:
                'IAM role for CloudWatch Logs subscription filter to forward logs to central account',
        });

        // Grant permissions to put records to central account's destination
        this.subscriptionRole.addToPolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ['logs:PutLogEvents'],
                resources: [centralDestinationArn],
            })
        );

        // Create subscription filters for each log group
        this.subscriptionFilters = logGroupNames.map((logGroupName, index) => {
            const subscriptionFilter = new logs.CfnSubscriptionFilter(
                this,
                `SubscriptionFilter-${index}`,
                {
                    logGroupName: logGroupName,
                    filterPattern: filterPattern,
                    destinationArn: centralDestinationArn,
                    roleArn: this.subscriptionRole.roleArn,
                }
            );

            return subscriptionFilter;
        });

        // Outputs
        new cdk.CfnOutput(this, 'SubscriptionRoleArn', {
            value: this.subscriptionRole.roleArn,
            description: 'IAM Role ARN for log subscription filters',
        });

        new cdk.CfnOutput(this, 'CentralDestinationArn', {
            value: centralDestinationArn,
            description: 'Central account CloudWatch Logs destination ARN',
        });

        new cdk.CfnOutput(this, 'SubscriptionFilterCount', {
            value: this.subscriptionFilters.length.toString(),
            description: 'Number of subscription filters created',
        });
    }
}
