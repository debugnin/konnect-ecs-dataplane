# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

AWS CDK (TypeScript) project that deploys Kong Gateway data planes on ECS Fargate, connecting to Kong Konnect as the managed control plane.

## Commands

```bash
npm run build        # Compile TypeScript
npm run watch        # Watch and compile
npm run test         # Run Jest tests
npx cdk synth        # Generate CloudFormation templates
npx cdk diff         # Show pending changes
npx cdk deploy --all # Deploy all stacks
```

Single test:
```bash
npx jest --testPathPattern="kong-ecs"
```

Deploy requires `ENVIRONMENT` and at least one service:
```bash
ENVIRONMENT=dev npx cdk synth
ENVIRONMENT=dev SERVICE1_NAME=customers SERVICE1_PATH=/customers SERVICE1_SECRET_ARN=arn:... npx cdk deploy --all
```

## Architecture

Two stack types deployed in dependency order:

**`KongInfrastructureStack`** (one per environment) — shared infra in `lib/kong-infrastructure-stack.ts`:
- Composes constructs from `lib/constructs/`: `VpcConstruct`, `CertificateConstruct`, `WafConstruct`, `AlbConstruct`, `LoggingConstruct`
- Outputs listener ARNs and security group IDs consumed by service stacks

**`KongServiceStack`** (one per service) — ECS + Kong in `lib/kong-service-stack.ts`:
- Creates ECS Fargate cluster, task definition, and service for each configured service
- Adds ALB listener rules for path-based routing (e.g. `/customers/*`)
- Optionally creates: `DataPlaneResilienceConstruct` (S3 config backup + backup ECS node), `RedisConstruct` (ElastiCache)
- IAM roles are created per service stack (not shared/imported)

The entry point `bin/kong-ecs-cdk.ts` reads config and instantiates all stacks. It supports up to 100 services via `SERVICE{N}_*` env vars.

## Configuration Precedence

1. `config/{environment}.json` (highest) — see `config/dev.json` for example
2. `cdk.context.json`
3. Environment variables (lowest)

The `ENVIRONMENT` context/env var is required and drives both naming and config file selection. Stack names follow `kong-infra-stack-{env}` and `kong-service-stack-{service}-{env}` patterns.

## Key Design Decisions

- **Container image as CloudFormation parameter**: The Kong image URI is a `CfnParameter`, allowing `aws cloudformation update-stack` to update images without re-running CDK.
- **`forceRefreshToken`**: Set `FORCE_REFRESH_TOKEN` to any new value (e.g. a timestamp) to force ECS task restarts and re-read latest secrets from Secrets Manager.
- **Backup node**: When `DP_RESILIENCE_ENABLED=true`, a second ECS service is created that exports Kong config to S3 but does not receive traffic. Regular nodes import from S3 on CP outage.
- **WAF CIDR restriction**: Enabled by default; if `WAF_ALLOWED_CIDRS` is empty and restriction is on, all traffic is blocked. Set `WAF_ENABLE_CIDR_RESTRICTION=false` to allow all.
- **Konnect PrivateLink**: Enable with `KONNECT_PRIVATELINK_ENABLED=true` and `KONNECT_GEO=US|EU|AU|SG|IN|ME|GLOBAL` to create a VPC endpoint for CP-DP traffic.

## Secret Format

Secrets Manager secret must contain these JSON keys: `certificate`, `private_key`, `control_plane_group_endpoint`, `cluster_server_name`, `telemetry_endpoint`, `telemetry_server_name`.
