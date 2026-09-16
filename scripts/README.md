# `create-konnect-secret.sh`

Automates the "create a Konnect DP client cert + populate AWS Secrets Manager"
step described in the main [README](../README.md#quick-start) and
[DEPLOYMENT_GUIDE.md](../DEPLOYMENT_GUIDE.md), so you don't have to hand-craft
the secret JSON or manually pull cluster/telemetry endpoints from Konnect.

## What it does

1. Resolves your Konnect **control plane ID** (by name or ID) via the Konnect API
2. Reads the control plane's **cluster** and **telemetry** endpoints
3. Generates a self-signed **EC client certificate/key** with `openssl`
   (or reuses a cert/key you already have)
4. Registers the certificate with the control plane as a **pinned client cert**
   (idempotent — skips if an identical cert is already registered)
5. Writes a single JSON secret to **AWS Secrets Manager** in the exact shape
   the CDK stack expects (`certificate`, `private_key`,
   `control_plane_group_endpoint`, `cluster_server_name`,
   `telemetry_endpoint`, `telemetry_server_name`)

The **secret name is derived automatically** from the control plane name
(lowercased, slugified, wrapped as `kong-<slug>-cert`), so in the common case
the only argument you need to pass is `--control-plane-name`.

## Prerequisites

- `bash`, `curl`, `jq`, `openssl`
- AWS CLI v2, configured with credentials that can create/update secrets
  (`secretsmanager:CreateSecret`, `DescribeSecret`, `PutSecretValue`, and
  optionally `kms:*` if using a custom KMS key)
- A Konnect **Personal Access Token** (`kpat_...`) exported as `KONNECT_TOKEN`
- An existing Konnect **control plane** (e.g. created via
  [`konnect-terraform-example`](../../konnect-terraform-example))

## Usage

Minimal (everything else is derived/defaulted):

```bash
export KONNECT_TOKEN="kpat_your-token-here"

./create-konnect-secret.sh --control-plane-name "Sample Control Plane"
# -> creates/updates secret "kong-sample-control-plane-cert" in ap-southeast-2 (au Konnect region)
```

Override region, Konnect region, or the derived secret name if needed:

```bash
./create-konnect-secret.sh \
  --control-plane-name "Sample Control Plane" \
  --secret-name "kong-customers-cert" \
  --konnect-region au \
  --region ap-southeast-2
```

Preview without making any changes:

```bash
./create-konnect-secret.sh --control-plane-name "Sample Control Plane" --dry-run
```

Bring your own cert/key instead of generating one:

```bash
./create-konnect-secret.sh \
  --control-plane-name "Sample Control Plane" \
  --cert ./ca.crt --key ./ca.key
```

Using a control plane ID instead of a name (secret name becomes required,
since there's no name to derive it from):

```bash
./create-konnect-secret.sh \
  --control-plane-id "1234-abcd-..." \
  --secret-name "kong-bookings-cert"
```

Full flag reference: `./create-konnect-secret.sh --help`

## Output

Prints the created/updated secret's ARN, ready to plug into
`config/{environment}.json` as `service{N}SecretArn` (or
`SERVICE{N}_SECRET_ARN` if using env vars):

```json
{
  "service1SecretArn": "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:kong-customers-cert-AbCdEf"
}
```

## Notes

- The script is **idempotent**: re-running it with the same cert will detect
  the certificate is already registered with Konnect and just refresh the
  AWS secret (e.g. if endpoints changed).
- Konnect region (`--konnect-region`) must match where the control plane
  actually lives (`au`, `us`, `eu`, `in`, `me`) — get this wrong and the
  control-plane lookup will fail with a 404/empty result.
- `control_plane_auth_type` on the control plane must be `pinned_client_certs`
  for the certificate registration step to take effect (this is the default
  in `konnect-terraform-example`).
