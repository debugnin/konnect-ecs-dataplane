/**
 * DataPlaneResilienceConstruct - S3 Storage for Kong Data Plane Configuration Backup
 *
 * This construct implements Kong Gateway's Data Plane resilience feature by creating
 * an S3 bucket for storing configuration backups. This allows new Data Plane nodes to
 * start during Control Plane outages.
 *
 * Architecture:
 *   - Backup Node (one or more): Writes config to S3 when CP sends updates
 *   - Regular Data Planes: Read from S3 if CP is unreachable during startup
 *
 * Kong Configuration:
 *   Backup Node:
 *     - KONG_CLUSTER_FALLBACK_CONFIG_EXPORT=on
 *     - KONG_CLUSTER_FALLBACK_CONFIG_STORAGE=s3://bucket/prefix
 *
 *   Regular Data Plane:
 *     - KONG_CLUSTER_FALLBACK_CONFIG_IMPORT=on
 *     - KONG_CLUSTER_FALLBACK_CONFIG_STORAGE=s3://bucket/prefix
 *
 * IAM Permissions:
 *   The provided ecsTaskExecutionRoleArn must have S3 read/write permissions attached:
 *   - s3:GetObject, s3:PutObject, s3:DeleteObject, s3:ListBucket
 *
 * Reference: https://developer.konghq.com/gateway/cp-outage/
 *
 * Environment Variables:
 *   DP_RESILIENCE_ENABLED=true
 *
 * Note: Bucket name is auto-generated, config prefix is fixed at 'kong-config',
 * and encryption uses S3-managed keys (SSE-S3).
 */
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';

export interface DataPlaneResilienceConstructProps {
    /**
     * Environment: dev, qa, uat, prd
     */
    environment: string;

    /**
     * Component name (e.g., the service name like "customers", "bookings", etc.)
     */
    component: string;
}

export class DataPlaneResilienceConstruct extends Construct {
    public readonly bucket: s3.Bucket;
    public readonly configPrefix: string = 'kong-config';
    private readonly environmentName: string;
    private readonly component: string;

    constructor(scope: Construct, id: string, props: DataPlaneResilienceConstructProps) {
        super(scope, id);

        this.environmentName = props.environment;
        this.component = props.component;

        // Create S3 bucket for Kong configuration backups
        this.bucket = new s3.Bucket(this, 'DpConfigBucket', {
            bucketName: `kong-dpconfig-s3-${this.component}-${this.environmentName}`,
            encryption: s3.BucketEncryption.S3_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            versioned: true, // Enable versioning for config history
            removalPolicy: cdk.RemovalPolicy.RETAIN, // Prevent accidental deletion
            lifecycleRules: [
                {
                    id: 'CleanupElectionFiles',
                    enabled: true,
                    // Kong creates election files at {prefix}/{version}/election/*
                    // These can be deleted after a few days if not updated
                    prefix: `${this.configPrefix}/`,
                    expiration: cdk.Duration.days(7),
                    noncurrentVersionExpiration: cdk.Duration.days(7),
                },
                {
                    id: 'AbortIncompleteMultipartUpload',
                    enabled: true,
                    abortIncompleteMultipartUploadAfter: cdk.Duration.days(1),
                },
            ],
        });

        // Enforce HTTPS-only access
        this.bucket.addToResourcePolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.DENY,
                principals: [new iam.AnyPrincipal()],
                actions: ['s3:*'],
                resources: [this.bucket.bucketArn, `${this.bucket.bucketArn}/*`],
                conditions: {
                    Bool: {
                        'aws:SecureTransport': 'false',
                    },
                },
            })
        );

        // Outputs
        new cdk.CfnOutput(this, 'BucketName', {
            value: this.bucket.bucketName,
            description: 'S3 Bucket for Kong DP configuration backups',
        });

        new cdk.CfnOutput(this, 'BucketArn', {
            value: this.bucket.bucketArn,
            description: 'S3 Bucket ARN',
        });

        new cdk.CfnOutput(this, 'ConfigStorage', {
            value: `s3://${this.bucket.bucketName}/${this.configPrefix}`,
            description:
                'KONG_CLUSTER_FALLBACK_CONFIG_STORAGE value for data plane nodes',
        });
    }

    /**
     * Get the storage URL to use in KONG_CLUSTER_FALLBACK_CONFIG_STORAGE
     */
    public getStorageUrl(): string {
        return `s3://${this.bucket.bucketName}/${this.configPrefix}`;
    }
}
