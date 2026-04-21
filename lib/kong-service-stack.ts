import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { LoggingConstruct } from './constructs/logging-construct';
import { DataPlaneResilienceConstruct } from './constructs/dp-resilience-construct';
import { RedisConstruct } from './constructs/redis-construct';

export interface KongServiceStackProps extends cdk.StackProps {
    // System and environment for naming conventions
    system: string; // Business system identifier (e.g., customers, bookings)
    environment: string; // Environment: dev, qa, uat, prd

    konnectControlPlaneSecretArn: string;
    serviceName: string; // Required - used for resource naming and path routing
    pathPrefix: string; // URL path prefix for routing (e.g., '/customers', '/bookings')

    // Required infrastructure inputs (from KongInfrastructureStack)
    vpc: ec2.IVpc;
    mtlsListenerArn: string; // HTTPS listener on port 443 (mTLS)
    albSecurityGroupId: string;

    dataPlane?: {
        cpu?: number;
        memoryMiB?: number;
        replicas?: number;
        imageUri?: string; // Full image URI override — becomes the CfnParameter default
    };

    // Logging Configuration (Central Account)
    logging?: {
        enabled?: boolean;
        centralDestinationArn?: string;
        filterPattern?: string;
    };

    kongLogLevel?: string; // Kong log level (default: notice)
    // Set to any new value (e.g. a timestamp) to force ECS tasks to restart and re-read secrets
    forceRefreshToken?: string;

    // Data Plane Resilience Configuration (S3 Config Backup)
    dpResilience?: {
        enabled?: boolean;
    };

    // Redis Configuration (ElastiCache) - Per Service
    redis?: {
        enabled?: boolean;
        nodeType?: string;
        numCacheNodes?: number;
        engineVersion?: string;
        parameterGroupFamily?: string;
        encryptionAtRest?: boolean;
        encryptionInTransit?: boolean;
        multiAz?: boolean;
        authToken?: string;
        snapshotRetentionDays?: number;
        snapshotWindow?: string;
        maintenanceWindow?: string;
    };
}

export class KongServiceStack extends cdk.Stack {
    public readonly targetGroup: elbv2.ApplicationTargetGroup;
    public readonly ecsCluster: ecs.Cluster;
    public readonly ecsService: ecs.FargateService;
    public readonly backupService?: ecs.FargateService;
    public readonly loggingConstruct?: LoggingConstruct;
    public readonly dpResilienceConstruct?: DataPlaneResilienceConstruct;
    public readonly redisConstruct?: RedisConstruct;
    public dpLogGroup!: logs.LogGroup;
    public backupLogGroup?: logs.LogGroup;

    private readonly systemName: string;
    private readonly environmentName: string;
    private readonly serviceName: string;
    private readonly pathPrefix: string;
    private readonly dpCpu: number;
    private readonly dpMemoryMiB: number;
    private readonly dpReplicas: number;
    private readonly kongLogLevel: string;
    private readonly containerImageParam: cdk.CfnParameter;
    private readonly konnectControlPlaneSecretArn: string;
    private ecsTaskExecutionRole?: iam.IRole;
    private ecsTaskRole?: iam.IRole;
    private readonly vpc: ec2.IVpc;
    private readonly mtlsListenerArn: string;
    private readonly albSecurityGroupId: string;
    private readonly forceRefreshToken?: string;
    private readonly dpResilienceConfig?: {
        enabled?: boolean;
        bucketName?: string;
        configPrefix?: string;
        kmsKeyArn?: string;
    };
    constructor(scope: Construct, id: string, props: KongServiceStackProps) {
        super(scope, id, props);

        this.systemName = props.system;
        this.environmentName = props.environment;
        this.serviceName = props.serviceName;
        // Ensure pathPrefix starts with /
        this.pathPrefix = props.pathPrefix.startsWith('/')
            ? props.pathPrefix
            : `/${props.pathPrefix}`;
        this.dpCpu = props.dataPlane?.cpu ?? 512;
        this.dpMemoryMiB = props.dataPlane?.memoryMiB ?? 1024;
        this.dpReplicas = props.dataPlane?.replicas ?? 2;
        this.kongLogLevel = props.kongLogLevel ?? 'notice';

        // CloudFormation parameter — allows image override via `aws cloudformation update-stack`
        // without re-running CDK. Defaults to the standard Kong gateway image.
        this.containerImageParam = new cdk.CfnParameter(this, 'ContainerImage', {
            type: 'String',
            description:
                'Kong data plane container image URI (e.g. 123456789.dkr.ecr.ap-southeast-2.amazonaws.com/kong-gateway:tag)',
            default: props.dataPlane?.imageUri,
        });
        this.konnectControlPlaneSecretArn = props.konnectControlPlaneSecretArn;
        this.vpc = props.vpc;
        this.mtlsListenerArn = props.mtlsListenerArn;
        this.albSecurityGroupId = props.albSecurityGroupId;
        this.dpResilienceConfig = props.dpResilience;
        this.forceRefreshToken = props.forceRefreshToken;

        // Create or import IAM roles
        this.setupIamRoles(props);

        // Import VPC from infrastructure stack
        const vpc = this.vpc;

        // Create ECS Cluster
        this.ecsCluster = new ecs.Cluster(this, 'KongCluster', {
            vpc,
            clusterName: `kong-ecscluster-${this.serviceName}-${this.environmentName}`,
        });

        // Reference external Konnect secret
        const konnectSecret = secretsmanager.Secret.fromSecretCompleteArn(
            this,
            'KonnectSecret',
            this.konnectControlPlaneSecretArn
        );

        // Create Target Group for this service
        this.targetGroup = new elbv2.ApplicationTargetGroup(this, 'TargetGroup', {
            vpc,
            port: 8443,
            protocol: elbv2.ApplicationProtocol.HTTPS,
            targetGroupName: `kong-tg-${this.serviceName}-${this.environmentName}`,
            healthCheck: {
                enabled: true,
                protocol: elbv2.Protocol.HTTP,
                port: '8100',
                path: '/status/ready',
                healthyThresholdCount: 2,
                unhealthyThresholdCount: 3,
                timeout: cdk.Duration.seconds(5),
                interval: cdk.Duration.seconds(30),
            },
        });

        // Create Data Plane Resilience S3 Bucket (if enabled)
        if (props.dpResilience?.enabled) {
            this.dpResilienceConstruct = new DataPlaneResilienceConstruct(
                this,
                'DpResilienceConstruct',
                {
                    environment: this.environmentName,
                    component: this.serviceName,
                }
            );

            // Grant S3 read/write permissions to both execution and task roles
            this.dpResilienceConstruct.bucket.grantReadWrite(this.ecsTaskExecutionRole!);
            this.dpResilienceConstruct.bucket.grantReadWrite(this.ecsTaskRole!);

            // Create Backup Node (1 replica, exports config, no traffic)
            this.backupService = this.createBackupNode(this.ecsCluster, konnectSecret);
        }

        // Create optional Redis cluster for this service (ElastiCache)
        if (props.redis?.enabled) {
            // Get ECS service security group to allow Redis access
            const ecsSecurityGroup = new ec2.SecurityGroup(this, 'EcsSecurityGroup', {
                vpc,
                description: `Security group for Kong ECS service ${this.serviceName} (${this.environmentName})`,
                securityGroupName: `kong-ecs-sg-${this.serviceName}-${this.environmentName}`,
            });

            this.redisConstruct = new RedisConstruct(this, 'RedisConstruct', {
                vpc,
                environment: this.environmentName,
                serviceName: this.serviceName, // Pass serviceName for per-service naming
                nodeType: props.redis.nodeType,
                numCacheNodes: props.redis.numCacheNodes,
                engineVersion: props.redis.engineVersion,
                parameterGroupFamily: props.redis.parameterGroupFamily,
                encryptionAtRest: props.redis.encryptionAtRest,
                encryptionInTransit: props.redis.encryptionInTransit,
                multiAz: props.redis.multiAz,
                authToken: props.redis.authToken,
                snapshotRetentionDays: props.redis.snapshotRetentionDays,
                snapshotWindow: props.redis.snapshotWindow,
                maintenanceWindow: props.redis.maintenanceWindow,
                allowedSecurityGroups: [ecsSecurityGroup],
            });
        }

        // Create Regular Data Plane (handles traffic, imports config if CP down)
        this.ecsService = this.createDataPlane(this.ecsCluster, konnectSecret);

        // Register only regular data plane with target group (backup node doesn't handle traffic)
        this.targetGroup.addTarget(this.ecsService);

        // Create Log Streaming to Central Account (via Subscription Filters)
        if (props.logging?.enabled && props.logging.centralDestinationArn) {
            const logGroups = [this.dpLogGroup.logGroupName];
            if (this.backupLogGroup) {
                logGroups.push(this.backupLogGroup.logGroupName);
            }
            this.loggingConstruct = new LoggingConstruct(this, 'LoggingConstruct', {
                environment: this.environmentName,
                centralDestinationArn: props.logging.centralDestinationArn,
                logGroupNames: logGroups,
                filterPattern: props.logging.filterPattern,
            });
        }

        const albSecurityGroup = ec2.SecurityGroup.fromSecurityGroupId(
            this,
            'AlbSecurityGroup',
            this.albSecurityGroupId
        );

        // Import mTLS listener (port 443) and add path-based routing rule
        const mtlsListener = elbv2.ApplicationListener.fromApplicationListenerAttributes(
            this,
            'MtlsListener',
            {
                listenerArn: this.mtlsListenerArn,
                securityGroup: albSecurityGroup,
            }
        );

        // Add listener rule for mTLS listener (port 443)
        new elbv2.ApplicationListenerRule(this, 'MtlsPathRoutingRule', {
            listener: mtlsListener,
            priority: this.calculatePriority(this.pathPrefix),
            conditions: [
                elbv2.ListenerCondition.pathPatterns([
                    `${this.pathPrefix}`,
                    `${this.pathPrefix}/*`,
                ]),
            ],
            action: elbv2.ListenerAction.forward([this.targetGroup]),
        });

        // Allow ALB to reach ECS tasks
        this.ecsService.connections.allowFrom(
            albSecurityGroup,
            ec2.Port.tcp(8443),
            'Allow ALB to reach Kong proxy port'
        );
        this.ecsService.connections.allowFrom(
            albSecurityGroup,
            ec2.Port.tcp(8100),
            'Allow ALB to reach Kong status port'
        );

        // Outputs
        new cdk.CfnOutput(this, 'ClusterName', {
            value: this.ecsCluster.clusterName,
            description: 'ECS Cluster Name',
        });

        new cdk.CfnOutput(this, 'ServiceName', {
            value: this.ecsService.serviceName,
            description: 'ECS Service Name',
        });

        new cdk.CfnOutput(this, 'TargetGroupArn', {
            value: this.targetGroup.targetGroupArn,
            description: 'Target Group ARN',
        });

        new cdk.CfnOutput(this, 'PathPrefix', {
            value: this.pathPrefix,
            description: 'Path prefix for routing',
        });

        // Backup node outputs (if DP resilience is enabled)
        if (this.backupService) {
            new cdk.CfnOutput(this, 'BackupServiceName', {
                value: this.backupService.serviceName,
                description: 'Backup Node ECS Service Name',
            });

            new cdk.CfnOutput(this, 'BackupServiceArn', {
                value: this.backupService.serviceArn,
                description: 'Backup Node ECS Service ARN',
            });

            new cdk.CfnOutput(this, 'BackupLogGroupName', {
                value: this.backupLogGroup!.logGroupName,
                description: 'Backup Node CloudWatch Log Group Name',
            });

            new cdk.CfnOutput(this, 'S3BucketName', {
                value: this.dpResilienceConstruct!.bucket.bucketName,
                description: 'S3 Bucket for Kong configuration backup',
            });

            new cdk.CfnOutput(this, 'S3StorageUrl', {
                value: this.dpResilienceConstruct!.getStorageUrl(),
                description: 'Kong Cluster Fallback Config Storage URL',
            });

        }
    }

    /**
     * Setup IAM roles - always create new roles for the service
     */
    private setupIamRoles(props: KongServiceStackProps): void {
        // Task Execution Role (for pulling images, accessing secrets)
        const executionRole = new iam.Role(this, 'DpExecutionRole', {
            roleName: `kong-task-execution-role-${this.serviceName}-${this.environmentName}`,
            assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
            description: `ECS Task Execution Role for Kong ${this.serviceName} data plane`,
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName(
                    'service-role/AmazonECSTaskExecutionRolePolicy'
                ),
            ],
        });

        // Grant access to Konnect secret
        const konnectSecret = secretsmanager.Secret.fromSecretCompleteArn(
            this,
            'KonnectSecretForRole',
            this.konnectControlPlaneSecretArn
        );
        konnectSecret.grantRead(executionRole);

        // Add KMS permissions for decrypting Secrets Manager secrets
        executionRole.addToPolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ['kms:Decrypt', 'kms:DescribeKey'],
                resources: ['*'],
                conditions: {
                    StringEquals: {
                        'kms:ViaService': `secretsmanager.${cdk.Stack.of(this).region}.amazonaws.com`,
                    },
                },
            })
        );

        this.ecsTaskExecutionRole = executionRole;

        // Task Role (for runtime permissions: S3, logs, Lambda invocations)
        const taskRole = new iam.Role(this, 'DpTaskRole', {
            roleName: `kong-task-role-${this.serviceName}-${this.environmentName}`,
            assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
            description: `ECS Task Role for Kong ${this.serviceName} data plane runtime`,
        });

        // Add CloudWatch Logs permissions
        taskRole.addToPolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: [
                    'logs:CreateLogGroup',
                    'logs:CreateLogStream',
                    'logs:PutLogEvents',
                ],
                resources: ['*'],
            })
        );

        // Add Lambda invocation permissions (commonly needed for Kong AWS Lambda plugin)
        taskRole.addToPolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ['lambda:InvokeFunction'],
                resources: ['*'], // Can be restricted to specific Lambda functions if needed
            })
        );

        // Add STS AssumeRole permission (for assumeRole-based Lambda plugin)
        taskRole.addToPolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ['sts:AssumeRole'],
                resources: ['*'], // Can be restricted to specific roles if needed
            })
        );

        this.ecsTaskRole = taskRole;
    }

    private calculatePriority(pathPrefix: string): number {
        // Remove leading/trailing slashes and count segments
        const segments = pathPrefix
            .replace(/^\/|\/$/, '')
            .split('/')
            .filter((s) => s.length > 0);
        const depth = segments.length;

        // Base priority starts at 1000, subtract by depth * 100
        // This gives more specific paths lower priority numbers (higher actual priority)
        // Example: /api/v1/users -> priority 800, /api -> priority 900
        const basePriority = 1000;
        const priority = Math.max(1, basePriority - depth * 100);

        // Add some randomness based on path hash to avoid collisions
        const hash = pathPrefix
            .split('')
            .reduce((acc, char) => acc + char.charCodeAt(0), 0);
        return priority + (hash % 50);
    }

    private createDataPlane(
        cluster: ecs.Cluster,
        konnectSecret: secretsmanager.ISecret
    ): ecs.FargateService {
        // Use the IAM roles set up in constructor (either created or imported)
        const executionRole = this.ecsTaskExecutionRole!;
        const taskRole = this.ecsTaskRole!;

        // Task definition
        const dpTaskDefinition = new ecs.FargateTaskDefinition(this, 'DpTaskDefinition', {
            memoryLimitMiB: this.dpMemoryMiB,
            cpu: this.dpCpu,
            executionRole,
            taskRole,
            runtimePlatform: {
                cpuArchitecture: ecs.CpuArchitecture.ARM64,
                operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
            },
        });

        // Log group
        this.dpLogGroup = new logs.LogGroup(this, 'DpLogGroup', {
            logGroupName: `/aws/ecs/kong-dp-logs-${this.serviceName}-${this.environmentName}`,
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        dpTaskDefinition.addContainer('kong-dp', {
            image: ecs.ContainerImage.fromRegistry(
                this.containerImageParam.valueAsString
            ),
            environment: {
                KONG_ROLE: 'data_plane',
                KONG_DATABASE: 'off',
                KONG_PROXY_LISTEN: '0.0.0.0:8443 http2 ssl reuseport backlog=16384',
                KONG_STATUS_LISTEN: '0.0.0.0:8100',
                KONG_CLUSTER_MTLS: 'pki',
                KONG_CLUSTER_DP_LABELS: 'type:docker-kubernetesOS',
                KONG_LUA_SSL_TRUSTED_CERTIFICATE: 'system',
                KONG_KONNECT_MODE: 'on',
                KONG_VITALS: 'off',
                KONG_NGINX_WORKER_PROCESSES: '1',
                KONG_UPSTREAM_KEEPALIVE_MAX_REQUESTS: '100000',
                KONG_NGINX_HTTP_KEEPALIVE_REQUESTS: '100000',
                KONG_PROXY_ACCESS_LOG: 'off',
                KONG_DNS_STALE_TTL: '3600',
                KONG_ROUTER_FLAVOR: 'expressions',
                KONG_LOG_LEVEL: this.kongLogLevel,
                KONG_TRACING_INSTRUMENTATIONS: 'all',
                KONG_TRACING_SAMPLING_RATE: '1.0',
                KONG_PROXY_ERROR_LOG: '/dev/stderr',
                // AWS configuration for S3 access (DP resilience)
                ...(this.dpResilienceConstruct && {
                    AWS_REGION: cdk.Stack.of(this).region,
                    AWS_DEFAULT_REGION: cdk.Stack.of(this).region,
                }),
                // Kong DP resilience configuration
                ...(this.dpResilienceConstruct && {
                    KONG_CLUSTER_FALLBACK_CONFIG_STORAGE:
                        this.dpResilienceConstruct.getStorageUrl(),
                    // Regular nodes import config if CP is down
                    KONG_CLUSTER_FALLBACK_CONFIG_IMPORT: 'on',
                }),
                // Changing this value forces a new task definition revision so ECS restarts
                // tasks and re-reads the latest secret values from Secrets Manager
                ...(this.forceRefreshToken && {
                    FORCE_REFRESH: this.forceRefreshToken,
                }),
            },
            secrets: {
                KONG_CLUSTER_CERT: ecs.Secret.fromSecretsManager(
                    konnectSecret,
                    'certificate'
                ),
                KONG_CLUSTER_CERT_KEY: ecs.Secret.fromSecretsManager(
                    konnectSecret,
                    'private_key'
                ),
                KONG_CLUSTER_CONTROL_PLANE: ecs.Secret.fromSecretsManager(
                    konnectSecret,
                    'control_plane_group_endpoint'
                ),
                KONG_CLUSTER_SERVER_NAME: ecs.Secret.fromSecretsManager(
                    konnectSecret,
                    'cluster_server_name'
                ),
                KONG_CLUSTER_TELEMETRY_ENDPOINT: ecs.Secret.fromSecretsManager(
                    konnectSecret,
                    'telemetry_endpoint'
                ),
                KONG_CLUSTER_TELEMETRY_SERVER_NAME: ecs.Secret.fromSecretsManager(
                    konnectSecret,
                    'telemetry_server_name'
                ),
                // Use cluster certificate for proxy SSL
                KONG_SSL_CERT: ecs.Secret.fromSecretsManager(
                    konnectSecret,
                    'certificate'
                ),
                KONG_SSL_CERT_KEY: ecs.Secret.fromSecretsManager(
                    konnectSecret,
                    'private_key'
                ),
            },
            portMappings: [
                { containerPort: 8443, protocol: ecs.Protocol.TCP }, // Proxy (HTTPS)
                { containerPort: 8100, protocol: ecs.Protocol.TCP }, // Status API
            ],
            healthCheck: {
                command: ['CMD-SHELL', 'kong health'],
                interval: cdk.Duration.seconds(30),
                timeout: cdk.Duration.seconds(5),
                retries: 3,
                startPeriod: cdk.Duration.seconds(60),
            },
            logging: ecs.LogDrivers.awsLogs({
                streamPrefix: 'kong-dp',
                logGroup: this.dpLogGroup,
            }),
        });

        // ECS Service
        const dpService = new ecs.FargateService(this, 'DpService', {
            cluster,
            serviceName: `kong-ecsservice-${this.serviceName}-${this.environmentName}`,
            taskDefinition: dpTaskDefinition,
            desiredCount: this.dpReplicas,
            assignPublicIp: false,
            vpcSubnets: {
                subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
            },
            minHealthyPercent: 100,
            maxHealthyPercent: 200,
        });

        return dpService;
    }

    /**
     * Create Backup Node - Exports configuration to S3
     * This node should NOT handle traffic (not registered with ALB)
     * Only one backup node is needed per environment
     */
    private createBackupNode(
        cluster: ecs.Cluster,
        konnectSecret: secretsmanager.ISecret
    ): ecs.FargateService {
        // Use the IAM roles set up in constructor (either created or imported)
        const executionRole = this.ecsTaskExecutionRole!;
        const taskRole = this.ecsTaskRole!;

        // Task definition
        const backupTaskDefinition = new ecs.FargateTaskDefinition(
            this,
            'BackupTaskDefinition',
            {
                memoryLimitMiB: this.dpMemoryMiB,
                cpu: this.dpCpu,
                executionRole,
                taskRole,
                runtimePlatform: {
                    cpuArchitecture: ecs.CpuArchitecture.ARM64,
                    operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
                },
            }
        );

        // Log group for backup node
        this.backupLogGroup = new logs.LogGroup(this, 'BackupLogGroup', {
            logGroupName: `/aws/ecs/kong-backup-logs-${this.serviceName}-${this.environmentName}`,
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        backupTaskDefinition.addContainer('kong-backup', {
            image: ecs.ContainerImage.fromRegistry(
                this.containerImageParam.valueAsString
            ),
            environment: {
                KONG_ROLE: 'data_plane',
                KONG_DATABASE: 'off',
                KONG_PROXY_LISTEN: '0.0.0.0:8443 ssl',
                KONG_STATUS_LISTEN: '0.0.0.0:8100',
                KONG_CLUSTER_MTLS: 'pki',
                KONG_CLUSTER_DP_LABELS: 'type:backup-node',
                KONG_LUA_SSL_TRUSTED_CERTIFICATE: 'system',
                KONG_KONNECT_MODE: 'on',
                KONG_VITALS: 'off',
                KONG_NGINX_WORKER_PROCESSES: '1',
                KONG_UPSTREAM_KEEPALIVE_MAX_REQUESTS: '100000',
                KONG_NGINX_HTTP_KEEPALIVE_REQUESTS: '100000',
                KONG_PROXY_ACCESS_LOG: 'off',
                KONG_DNS_STALE_TTL: '3600',
                KONG_ROUTER_FLAVOR: 'expressions',
                KONG_LOG_LEVEL: this.kongLogLevel,
                KONG_TRACING_INSTRUMENTATIONS: 'all',
                KONG_TRACING_SAMPLING_RATE: '1.0',
                KONG_PROXY_ERROR_LOG: '/dev/stderr',
                // AWS configuration for S3 access
                AWS_REGION: cdk.Stack.of(this).region,
                AWS_DEFAULT_REGION: cdk.Stack.of(this).region,
                // Kong DP resilience - backup node exports config
                KONG_CLUSTER_FALLBACK_CONFIG_STORAGE:
                    this.dpResilienceConstruct!.getStorageUrl(),
                KONG_CLUSTER_FALLBACK_CONFIG_EXPORT: 'on',
                ...(this.forceRefreshToken && {
                    FORCE_REFRESH: this.forceRefreshToken,
                }),
            },
            secrets: {
                KONG_CLUSTER_CERT: ecs.Secret.fromSecretsManager(
                    konnectSecret,
                    'certificate'
                ),
                KONG_CLUSTER_CERT_KEY: ecs.Secret.fromSecretsManager(
                    konnectSecret,
                    'private_key'
                ),
                KONG_CLUSTER_CONTROL_PLANE: ecs.Secret.fromSecretsManager(
                    konnectSecret,
                    'control_plane_group_endpoint'
                ),
                KONG_CLUSTER_SERVER_NAME: ecs.Secret.fromSecretsManager(
                    konnectSecret,
                    'cluster_server_name'
                ),
                KONG_CLUSTER_TELEMETRY_ENDPOINT: ecs.Secret.fromSecretsManager(
                    konnectSecret,
                    'telemetry_endpoint'
                ),
                KONG_CLUSTER_TELEMETRY_SERVER_NAME: ecs.Secret.fromSecretsManager(
                    konnectSecret,
                    'telemetry_server_name'
                ),
                // Use cluster certificate for proxy SSL
                KONG_SSL_CERT: ecs.Secret.fromSecretsManager(
                    konnectSecret,
                    'certificate'
                ),
                KONG_SSL_CERT_KEY: ecs.Secret.fromSecretsManager(
                    konnectSecret,
                    'private_key'
                ),
            },
            portMappings: [
                { containerPort: 8443, protocol: ecs.Protocol.TCP }, // Proxy (HTTPS, not used)
                { containerPort: 8100, protocol: ecs.Protocol.TCP }, // Status API
            ],
            healthCheck: {
                command: ['CMD-SHELL', 'kong health'],
                interval: cdk.Duration.seconds(30),
                timeout: cdk.Duration.seconds(5),
                retries: 3,
                startPeriod: cdk.Duration.seconds(60),
            },
            logging: ecs.LogDrivers.awsLogs({
                streamPrefix: 'kong-backup',
                logGroup: this.backupLogGroup,
            }),
        });

        // ECS Service - 1 replica (hardcoded), not registered with ALB
        const backupService = new ecs.FargateService(this, 'BackupService', {
            cluster,
            serviceName: `kong-backup-ecsservice-${this.serviceName}-${this.environmentName}`,
            taskDefinition: backupTaskDefinition,
            desiredCount: 1, // Only 1 backup node needed
            assignPublicIp: false,
            vpcSubnets: {
                subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
            },
            minHealthyPercent: 0,
            maxHealthyPercent: 100,
        });

        return backupService;
    }
}
