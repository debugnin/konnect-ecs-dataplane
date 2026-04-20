/**
 * RedisConstruct - AWS ElastiCache for Redis (Per Service)
 *
 * This construct creates an AWS ElastiCache for Redis cluster for use with a specific
 * Kong Gateway service as a shared cache, rate limiting store, or session storage.
 *
 * **Important**: Redis is deployed per-service, not as shared infrastructure.
 * Each service (e.g., customers, bookings) can have its own independent Redis cluster.
 *
 * Features:
 *   - Optional encryption in-transit and at-rest
 *   - Multi-AZ deployment with automatic failover (if enabled)
 *   - Configurable node type and cluster size
 *   - VPC subnet group in private subnets
 *   - Security group for Kong data plane access
 *   - Optional auth token for authentication
 *   - Per-service naming (kong-{serviceName}-redis-{environment})
 *
 * Environment Variables (Per Service):
 *   SERVICE{N}_REDIS_ENABLED=true
 *   SERVICE{N}_REDIS_NODE_TYPE=cache.t4g.micro
 *   SERVICE{N}_REDIS_NUM_CACHE_NODES=1  (or 2+ for Multi-AZ)
 *   SERVICE{N}_REDIS_ENGINE_VERSION=7.0
 *   SERVICE{N}_REDIS_PARAMETER_GROUP_FAMILY=redis7
 *   SERVICE{N}_REDIS_ENCRYPTION_AT_REST=true
 *   SERVICE{N}_REDIS_ENCRYPTION_IN_TRANSIT=true
 *   SERVICE{N}_REDIS_MULTI_AZ=false
 *   SERVICE{N}_REDIS_AUTH_TOKEN=your-secure-token  (optional, for in-transit encryption)
 *   SERVICE{N}_REDIS_SNAPSHOT_RETENTION_DAYS=5
 *   SERVICE{N}_REDIS_SNAPSHOT_WINDOW=03:00-05:00  (UTC)
 *   SERVICE{N}_REDIS_MAINTENANCE_WINDOW=sun:05:00-sun:07:00  (UTC)
 *
 * Example Usage:
 *   const redisConstruct = new RedisConstruct(this, 'RedisConstruct', {
 *     vpc: vpcConstruct.vpc,
 *     environment: 'dev',
 *     serviceName: 'customers',  // Service-specific Redis cluster
 *     nodeType: 'cache.t4g.micro',
 *     numCacheNodes: 1,
 *     engineVersion: '7.0',
 *     encryptionAtRest: true,
 *     encryptionInTransit: true,
 *   });
 */
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';

export interface RedisConstructProps {
    /**
     * VPC to deploy Redis cluster in
     */
    vpc: ec2.IVpc;

    /**
     * Environment: dev, qa, uat, prd
     */
    environment: string;

    /**
     * Service/app name for naming (e.g., customers, bookings)
     * Used to create unique Redis cluster per service
     */
    serviceName?: string;

    /**
     * Redis node type (instance class)
     * Examples: cache.t4g.micro, cache.t4g.small, cache.r7g.large
     * Default: cache.t4g.micro
     */
    nodeType?: string;

    /**
     * Number of cache nodes in the cluster
     * 1 = Single node (no replication)
     * 2+ = Primary + replicas (multi-AZ if enabled)
     * Default: 1
     */
    numCacheNodes?: number;

    /**
     * Redis engine version
     * Examples: 7.0, 7.1, 6.2
     * Default: 7.0
     */
    engineVersion?: string;

    /**
     * Parameter group family
     * Must match engine version (e.g., redis7 for 7.x, redis6.x for 6.x)
     * Default: redis7
     */
    parameterGroupFamily?: string;

    /**
     * Enable encryption at rest
     * Default: true
     */
    encryptionAtRest?: boolean;

    /**
     * Enable encryption in transit (TLS)
     * Requires auth token if enabled
     * Default: true
     */
    encryptionInTransit?: boolean;

    /**
     * Enable Multi-AZ with automatic failover
     * Requires numCacheNodes >= 2
     * Default: false
     */
    multiAz?: boolean;

    /**
     * Auth token for Redis authentication (when encryption in transit is enabled)
     * Must be at least 16 characters
     * If not provided and encryption in transit is enabled, one will be generated
     */
    authToken?: string;

    /**
     * Number of days to retain automatic snapshots
     * 0 = disabled
     * Default: 5
     */
    snapshotRetentionDays?: number;

    /**
     * Daily time range for automatic snapshots (UTC)
     * Format: hh24:mi-hh24:mi
     * Default: 03:00-05:00
     */
    snapshotWindow?: string;

    /**
     * Weekly time range for maintenance (UTC)
     * Format: ddd:hh24:mi-ddd:hh24:mi
     * Default: sun:05:00-sun:07:00
     */
    maintenanceWindow?: string;

    /**
     * Security groups to allow access from (e.g., Kong data plane SG)
     * If not provided, a new security group will be created
     */
    allowedSecurityGroups?: ec2.ISecurityGroup[];

    /**
     * Additional CIDR blocks to allow access from
     */
    allowedCidrs?: string[];
}

export class RedisConstruct extends Construct {
    public readonly cluster: elasticache.CfnReplicationGroup;
    public readonly securityGroup: ec2.SecurityGroup;
    public readonly subnetGroup: elasticache.CfnSubnetGroup;
    public readonly primaryEndpoint: string;
    public readonly readerEndpoint?: string;
    public readonly port: number = 6379;

    private readonly environmentName: string;

    constructor(scope: Construct, id: string, props: RedisConstructProps) {
        super(scope, id);

        this.environmentName = props.environment;
        const serviceName = props.serviceName || 'shared';

        const {
            vpc,
            nodeType = 'cache.t4g.micro',
            numCacheNodes = 1,
            engineVersion = '7.0',
            parameterGroupFamily = 'redis7',
            encryptionAtRest = true,
            encryptionInTransit = true,
            multiAz = false,
            authToken,
            snapshotRetentionDays = 5,
            snapshotWindow = '03:00-05:00',
            maintenanceWindow = 'sun:05:00-sun:07:00',
            allowedSecurityGroups = [],
            allowedCidrs = [],
        } = props;

        // Validate Multi-AZ configuration
        if (multiAz && numCacheNodes < 2) {
            throw new Error(
                'Multi-AZ requires at least 2 cache nodes (primary + 1 replica)'
            );
        }

        // Create subnet group in private subnets
        this.subnetGroup = new elasticache.CfnSubnetGroup(this, 'RedisSubnetGroup', {
            description: `Redis subnet group for Kong ${serviceName} (${this.environmentName})`,
            subnetIds: vpc.privateSubnets.map((subnet) => subnet.subnetId),
            cacheSubnetGroupName: `kong-${serviceName}-redis-subnet-group-${this.environmentName}`,
        });

        // Create security group for Redis
        this.securityGroup = new ec2.SecurityGroup(this, 'RedisSecurityGroup', {
            vpc,
            description: `Security group for Kong ${serviceName} Redis cluster (${this.environmentName})`,
            securityGroupName: `kong-${serviceName}-redis-sg-${this.environmentName}`,
            allowAllOutbound: false, // Redis doesn't need outbound traffic
        });

        // Allow inbound Redis traffic from specified security groups
        allowedSecurityGroups.forEach((sg, index) => {
            this.securityGroup.addIngressRule(
                sg,
                ec2.Port.tcp(this.port),
                `Allow Redis from Kong data plane ${index + 1}`
            );
        });

        // Allow inbound Redis traffic from specified CIDR blocks
        allowedCidrs.forEach((cidr, index) => {
            this.securityGroup.addIngressRule(
                ec2.Peer.ipv4(cidr),
                ec2.Port.tcp(this.port),
                `Allow Redis from CIDR ${index + 1}: ${cidr}`
            );
        });


        // Create parameter group for Redis configuration
        const parameterGroup = new elasticache.CfnParameterGroup(
            this,
            'RedisParameterGroup',
            {
                description: `Redis parameter group for Kong ${serviceName} (${this.environmentName})`,
                cacheParameterGroupFamily: parameterGroupFamily,
                properties: {
                    // Enable cluster mode compatible for future scaling
                    'cluster-enabled': 'no',
                    // Set max memory policy to evict least recently used keys
                    'maxmemory-policy': 'allkeys-lru',
                },
            }
        );

        // Create Redis Replication Group (supports both single-node and multi-node)
        this.cluster = new elasticache.CfnReplicationGroup(this, 'RedisCluster', {
            replicationGroupId: `kong-${serviceName}-redis-${this.environmentName}`,
            replicationGroupDescription: `Kong ${serviceName} Redis cluster (${this.environmentName})`,
            engine: 'redis',
            engineVersion,
            cacheNodeType: nodeType,
            cacheParameterGroupName: parameterGroup.ref,
            cacheSubnetGroupName: this.subnetGroup.cacheSubnetGroupName!,
            securityGroupIds: [this.securityGroup.securityGroupId],
            // Replication configuration
            numCacheClusters: numCacheNodes, // 1 = no replication, 2+ = primary + replicas
            automaticFailoverEnabled: multiAz && numCacheNodes >= 2,
            multiAzEnabled: multiAz && numCacheNodes >= 2,
            // Encryption
            atRestEncryptionEnabled: encryptionAtRest,
            transitEncryptionEnabled: encryptionInTransit,
            authToken: authToken,
            // Backup configuration
            snapshotRetentionLimit: snapshotRetentionDays,
            snapshotWindow: snapshotRetentionDays > 0 ? snapshotWindow : undefined,
            preferredMaintenanceWindow: maintenanceWindow,
            // Cluster settings
            autoMinorVersionUpgrade: true,
            // Tags
            tags: [
                {
                    key: 'Name',
                    value: `kong-${serviceName}-redis-${this.environmentName}`,
                },
                {
                    key: 'Service',
                    value: serviceName,
                },
                {
                    key: 'Environment',
                    value: this.environmentName,
                },
                {
                    key: 'ManagedBy',
                    value: 'CDK',
                },
            ],
        });

        // Add dependencies
        this.cluster.addDependency(this.subnetGroup);

        // CloudFormation outputs for connection details
        this.primaryEndpoint = cdk.Fn.getAtt(
            this.cluster.logicalId,
            'PrimaryEndPoint.Address'
        ).toString();

        if (numCacheNodes > 1) {
            this.readerEndpoint = cdk.Fn.getAtt(
                this.cluster.logicalId,
                'ReaderEndPoint.Address'
            ).toString();
        }

        // Output connection information
        new cdk.CfnOutput(this, 'RedisPrimaryEndpoint', {
            description: `Redis primary endpoint address for ${serviceName}`,
            value: this.primaryEndpoint,
            exportName: `kong-${serviceName}-redis-primary-endpoint-${this.environmentName}`,
        });

        new cdk.CfnOutput(this, 'RedisPort', {
            description: 'Redis port',
            value: this.port.toString(),
            exportName: `kong-${serviceName}-redis-port-${this.environmentName}`,
        });

        if (this.readerEndpoint) {
            new cdk.CfnOutput(this, 'RedisReaderEndpoint', {
                description: `Redis reader endpoint address for ${serviceName}`,
                value: this.readerEndpoint,
                exportName: `kong-${serviceName}-redis-reader-endpoint-${this.environmentName}`,
            });
        }

    }
}
