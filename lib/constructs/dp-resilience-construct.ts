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
 *   DP_RESILIENCE_BUCKET_NAME=kong-dp-config-backup (optional, auto-generated)
 *   DP_RESILIENCE_CONFIG_PREFIX=kong-config (optional, default: kong-config)
 *   DP_RESILIENCE_KMS_KEY_ARN=arn:aws:kms:... (optional)
 */
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';

export interface DataPlaneResilienceConstructProps {
    /**
     * Business system identifier (e.g., customers, bookings)
     */
    system: string;

    /**
     * Environment: dev, qa, uat, prd
     */
    environment: string;

    /**
     * Component name (e.g., the service name like "customers", "bookings", etc.)
     */
    component: string;

    /**
     * S3 bucket name for Kong configuration backups.
     * If not provided, CDK will auto-generate a unique name.
     */
    bucketName?: string;

    /**
     * KMS key ARN for encryption at rest.
     * If not provided, uses S3-managed encryption (SSE-S3).
     */
    kmsKeyArn?: string;

    /**
     * Prefix for config objects in S3.
     * Kong will create version-specific files: {prefix}/{version}/config.json
     * Default: 'kong-config'
     */
    configPrefix?: string;
}

export class DataPlaneResilienceConstruct extends Construct {
    public readonly bucket: s3.Bucket;
    public readonly kmsKey?: kms.IKey;
    public readonly configPrefix: string;
    private readonly systemName: string;
    private readonly environmentName: string;
    private readonly component: string;

    constructor(scope: Construct, id: string, props: DataPlaneResilienceConstructProps) {
        super(scope, id);

        this.systemName = props.system;
        this.environmentName = props.environment;
        this.component = props.component;

        const { bucketName, kmsKeyArn, configPrefix = 'kong-config' } = props;

        this.configPrefix = configPrefix;

        // Import KMS key if provided
        if (kmsKeyArn) {
            this.kmsKey = kms.Key.fromKeyArn(this, 'KmsKey', kmsKeyArn);
        }

        // Create S3 bucket for Kong configuration backups
        this.bucket = new s3.Bucket(this, 'DpConfigBucket', {
            bucketName,
            encryption: this.kmsKey
                ? s3.BucketEncryption.KMS
                : s3.BucketEncryption.S3_MANAGED,
            encryptionKey: this.kmsKey,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            versioned: true, // Enable versioning for config history
            removalPolicy: cdk.RemovalPolicy.RETAIN, // Prevent accidental deletion
            lifecycleRules: [
                {
                    id: 'CleanupElectionFiles',
                    enabled: true,
                    // Kong creates election files at {prefix}/{version}/election/*
                    // These can be deleted after a few days if not updated
                    prefix: `${configPrefix}/`,
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
