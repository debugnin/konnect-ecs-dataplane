# Configuration Files

This directory contains environment-specific configuration files for the Kong Konnect ECS Data Plane CDK deployment.

## Usage

1. Copy the example file for your environment:

    ```bash
    cp config/dev.json.example config/dev.json
    ```

2. Edit `config/dev.json` with your actual values:
    - AWS account IDs
    - Secret ARNs
    - Domain names
    - VPC CIDRs
    - etc.

3. Deploy using the configuration:
    ```bash
    npm run cdk deploy -- -c environment=dev --all
    ```
    or
    ```bash
    export ENVIRONMENT=dev
    npm run cdk deploy --all
    ```

## Configuration Priority

Configuration values are loaded with the following precedence (highest to lowest):

1. **config/{environment}.json** - Environment-specific configuration file
2. **cdk.context.json** - CDK context values (via `app.node.tryGetContext()`)
3. **Environment variables** - System environment variables

## File Structure

- `dev.json.example` - Example configuration for development environment
- `dev.json` - Your actual dev configuration (git-ignored)
- `qa.json` - QA environment configuration (git-ignored)
- `uat.json` - UAT environment configuration (git-ignored)
- `prd.json` - Production environment configuration (git-ignored)

## Security

**Important**: Actual configuration files (`*.json`) are git-ignored. Only example files (`*.json.example`) are tracked in version control. This ensures sensitive information like ARNs, account IDs, and domain names are not committed to the repository.

## Creating New Environment Configurations

To create a configuration for a new environment:

1. Copy the example file:

    ```bash
    cp config/dev.json.example config/newenv.json
    ```

2. Update the `environment` field and other values in `config/newenv.json`

3. Deploy:
    ```bash
    npm run cdk deploy -- -c environment=newenv --all
    ```
