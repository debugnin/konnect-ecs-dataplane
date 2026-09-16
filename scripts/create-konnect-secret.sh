#!/usr/bin/env bash
#
# create-konnect-secret.sh
#
# Generates a self-signed mTLS client certificate for a Kong data plane,
# registers it with a Kong Konnect control plane (pinned client certs),
# resolves the control plane's cluster/telemetry endpoints via the Konnect
# API, and stores everything as a single JSON secret in AWS Secrets Manager
# in the exact shape expected by the konnect-ecs-dataplane CDK stack:
#
#   {
#     "certificate": "...",
#     "private_key": "...",
#     "control_plane_group_endpoint": "<id>.<region>.cp0.konghq.com:443",
#     "cluster_server_name": "<id>.<region>.cp0.konghq.com",
#     "telemetry_endpoint": "<id>.<region>.tp0.konghq.com:443",
#     "telemetry_server_name": "<id>.<region>.tp0.konghq.com"
#   }
#
# The AWS Secrets Manager secret name is derived automatically from the
# control plane name (e.g. "Sample Control Plane" -> "kong-sample-control-plane-cert"),
# so in the common case the only input you need is --control-plane-name.
#
# Requirements: bash, curl, jq, openssl, aws CLI (v2 recommended)
#
# Usage:
#   export KONNECT_TOKEN="kpat_xxx"
#   ./create-konnect-secret.sh --control-plane-name "Sample Control Plane"
#
# Run with --help for the full option list.

set -euo pipefail

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------
SCRIPT_NAME="$(basename "$0")"
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

CONTROL_PLANE_NAME=""
CONTROL_PLANE_ID=""
SECRET_NAME=""                       # auto-derived from control plane name if not set
SECRET_NAME_PREFIX="kong-"
SECRET_NAME_SUFFIX="-cert"
AWS_REGION="${AWS_DEFAULT_REGION:-ap-southeast-2}"
KONNECT_REGION="au"                  # au | us | eu | in | me
CERT_CN=""                           # defaults to <secret-name>.dataplane.local
CERT_DAYS=1825                       # ~5 years, self-signed cert lifetime
CERT_PATH=""                         # bring-your-own cert (skip openssl gen)
KEY_PATH=""                          # bring-your-own key (skip openssl gen)
DRY_RUN=false
FORCE=false
KMS_KEY_ID=""

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
log()  { printf '\033[1;34m[%s]\033[0m %s\n' "$SCRIPT_NAME" "$*" >&2; }
warn() { printf '\033[1;33m[%s] WARNING:\033[0m %s\n' "$SCRIPT_NAME" "$*" >&2; }
die()  { printf '\033[1;31m[%s] ERROR:\033[0m %s\n' "$SCRIPT_NAME" "$*" >&2; exit 1; }

usage() {
    cat <<EOF
Usage: $SCRIPT_NAME [OPTIONS]

Creates (or reuses) a Konnect DP client certificate, resolves the control
plane's cluster/telemetry endpoints, and stores everything as a JSON secret
in AWS Secrets Manager for consumption by konnect-ecs-dataplane.

Required (one of):
  --control-plane-name NAME   Name of the existing Konnect control plane
                               (also used to derive the secret name, e.g.
                               "Sample Control Plane" -> "kong-sample-control-plane-cert")
  --control-plane-id ID       ID of the existing Konnect control plane
                               (skips the name lookup call; --secret-name
                               becomes required if used without --control-plane-name)

Optional:
  --secret-name NAME          Explicit AWS Secrets Manager secret name.
                               Defaults to a slug derived from --control-plane-name
                               (e.g. kong-sample-control-plane-cert).
  --region REGION             AWS region for Secrets Manager (default: \$AWS_DEFAULT_REGION or ap-southeast-2)
  --konnect-region REGION     Konnect region: au | us | eu | in | me (default: au)
  --konnect-server-url URL    Explicit Konnect API base URL (overrides --konnect-region)
  --cn COMMON_NAME            Certificate Common Name (default: <secret-name>.dataplane.local)
  --days N                    Self-signed cert validity in days (default: 1825)
  --cert PATH                 Use an existing certificate file instead of generating one
  --key PATH                  Use an existing private key file instead of generating one
  --kms-key-id ID             KMS key ID/ARN/alias to encrypt the secret (optional)
  --force                     Overwrite the secret if it already exists (default: update in place)
  --dry-run                   Print what would happen, make no changes
  -h, --help                  Show this help

Environment:
  KONNECT_TOKEN                Konnect Personal Access Token (required, kpat_...)
  AWS_PROFILE / AWS_* creds    Standard AWS CLI credential resolution

Examples:
  # Only required input: the control plane name. Secret name is auto-derived.
  export KONNECT_TOKEN="kpat_xxx"
  $SCRIPT_NAME --control-plane-name "Sample Control Plane"

  # Override the derived secret name
  $SCRIPT_NAME --control-plane-name "Sample Control Plane" \\
               --secret-name "kong-customers-cert" \\
               --konnect-region au --region ap-southeast-2

  # Use an existing cert/key pair, and a known control plane ID
  $SCRIPT_NAME --control-plane-id "1234-abcd" \\
               --secret-name "kong-bookings-cert" \\
               --cert ./ca.crt --key ./ca.key
EOF
}

require_bin() {
    command -v "$1" >/dev/null 2>&1 || die "Required tool '$1' not found in PATH."
}

# Turn a control plane name into a valid, human-readable AWS Secrets Manager
# name: lowercase, non-alphanumerics -> '-', collapse/trim dashes.
slugify() {
    printf '%s' "$1" \
        | tr '[:upper:]' '[:lower:]' \
        | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//'
}

# ---------------------------------------------------------------------------
# Parse args
# ---------------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
    case "$1" in
        --control-plane-name) CONTROL_PLANE_NAME="$2"; shift 2 ;;
        --control-plane-id)   CONTROL_PLANE_ID="$2"; shift 2 ;;
        --secret-name)        SECRET_NAME="$2"; shift 2 ;;
        --region)             AWS_REGION="$2"; shift 2 ;;
        --konnect-region)     KONNECT_REGION="$2"; shift 2 ;;
        --konnect-server-url) KONNECT_SERVER_URL_OVERRIDE="$2"; shift 2 ;;
        --cn)                 CERT_CN="$2"; shift 2 ;;
        --days)               CERT_DAYS="$2"; shift 2 ;;
        --cert)                CERT_PATH="$2"; shift 2 ;;
        --key)                 KEY_PATH="$2"; shift 2 ;;
        --kms-key-id)          KMS_KEY_ID="$2"; shift 2 ;;
        --force)              FORCE=true; shift ;;
        --dry-run)             DRY_RUN=true; shift ;;
        -h|--help)             usage; exit 0 ;;
        *) die "Unknown argument: $1 (see --help)" ;;
    esac
done

# ---------------------------------------------------------------------------
# Validate environment & inputs
# ---------------------------------------------------------------------------
require_bin curl
require_bin jq
require_bin openssl
require_bin aws

[[ -n "${KONNECT_TOKEN:-}" ]] || die "KONNECT_TOKEN env var is not set. export KONNECT_TOKEN='kpat_...'"
[[ -n "$CONTROL_PLANE_NAME" || -n "$CONTROL_PLANE_ID" ]] || die "Provide --control-plane-name (or --control-plane-id)"
[[ -z "$CERT_PATH" || -n "$KEY_PATH" ]] || die "--cert was provided without --key (need both)"
[[ -z "$KEY_PATH" || -n "$CERT_PATH" ]] || die "--key was provided without --cert (need both)"

# Derive the secret name from the control plane name unless explicitly set.
# --secret-name is only mandatory when neither a name nor an explicit
# override is available (i.e. --control-plane-id used on its own).
if [[ -z "$SECRET_NAME" ]]; then
    if [[ -n "$CONTROL_PLANE_NAME" ]]; then
        SECRET_NAME="${SECRET_NAME_PREFIX}$(slugify "$CONTROL_PLANE_NAME")${SECRET_NAME_SUFFIX}"
        log "No --secret-name provided; derived '$SECRET_NAME' from control plane name."
    else
        die "--secret-name is required when using --control-plane-id without --control-plane-name"
    fi
fi

if [[ -z "$CERT_CN" ]]; then
    CERT_CN="${SECRET_NAME}.dataplane.local"
fi

case "$KONNECT_REGION" in
    au|us|eu|in|me) : ;;
    *) die "Invalid --konnect-region '$KONNECT_REGION' (expected au|us|eu|in|me)" ;;
esac

KONNECT_SERVER_URL="${KONNECT_SERVER_URL_OVERRIDE:-https://${KONNECT_REGION}.api.konghq.com}"

log "Konnect API base URL: $KONNECT_SERVER_URL"
log "AWS region: $AWS_REGION"
log "Secret name: $SECRET_NAME"
$DRY_RUN && warn "Running in --dry-run mode. No changes will be made."

# ---------------------------------------------------------------------------
# 1. Resolve the Konnect control plane ID (if only the name was given)
# ---------------------------------------------------------------------------
konnect_api() {
    # konnect_api METHOD PATH [BODY_FILE]
    local method="$1" path="$2" body_file="${3:-}"
    local args=(-sS -X "$method"
        -H "Authorization: Bearer ${KONNECT_TOKEN}"
        -H "Content-Type: application/json"
        -H "Accept: application/json"
        "${KONNECT_SERVER_URL}${path}")
    if [[ -n "$body_file" ]]; then
        args+=(--data-binary "@${body_file}")
    fi
    curl "${args[@]}"
}

if [[ -z "$CONTROL_PLANE_ID" ]]; then
    log "Looking up control plane by name: '$CONTROL_PLANE_NAME'"
    CP_LOOKUP_RESPONSE="$(konnect_api GET "/v2/control-planes?filter%5Bname%5D%5Beq%5D=$(jq -rn --arg n "$CONTROL_PLANE_NAME" '$n|@uri')")"

    CP_COUNT="$(echo "$CP_LOOKUP_RESPONSE" | jq '.data | length' 2>/dev/null || echo 0)"
    if [[ "$CP_COUNT" -eq 0 ]]; then
        die "No control plane found with name '$CONTROL_PLANE_NAME'. Response: $CP_LOOKUP_RESPONSE"
    elif [[ "$CP_COUNT" -gt 1 ]]; then
        die "Multiple control planes match name '$CONTROL_PLANE_NAME'. Use --control-plane-id instead."
    fi

    CONTROL_PLANE_ID="$(echo "$CP_LOOKUP_RESPONSE" | jq -r '.data[0].id')"
    log "Resolved control plane ID: $CONTROL_PLANE_ID"
else
    log "Using provided control plane ID: $CONTROL_PLANE_ID"
fi

# ---------------------------------------------------------------------------
# 2. Fetch control plane details (cluster + telemetry endpoints)
# ---------------------------------------------------------------------------
log "Fetching control plane endpoint configuration..."
CP_DETAILS="$(konnect_api GET "/v2/control-planes/${CONTROL_PLANE_ID}")"

CLUSTER_ENDPOINT="$(echo "$CP_DETAILS" | jq -r '.config.control_plane_endpoint // empty' | sed -E 's#^https?://##')"
TELEMETRY_ENDPOINT_HOST="$(echo "$CP_DETAILS" | jq -r '.config.telemetry_endpoint // empty' | sed -E 's#^https?://##')"

if [[ -z "$CLUSTER_ENDPOINT" || -z "$TELEMETRY_ENDPOINT_HOST" ]]; then
    die "Could not resolve cluster/telemetry endpoints from control plane response:
$CP_DETAILS"
fi

CONTROL_PLANE_GROUP_ENDPOINT="${CLUSTER_ENDPOINT}:443"
CLUSTER_SERVER_NAME="${CLUSTER_ENDPOINT}"
TELEMETRY_ENDPOINT="${TELEMETRY_ENDPOINT_HOST}:443"
TELEMETRY_SERVER_NAME="${TELEMETRY_ENDPOINT_HOST}"

log "control_plane_group_endpoint = $CONTROL_PLANE_GROUP_ENDPOINT"
log "cluster_server_name          = $CLUSTER_SERVER_NAME"
log "telemetry_endpoint           = $TELEMETRY_ENDPOINT"
log "telemetry_server_name        = $TELEMETRY_SERVER_NAME"

# ---------------------------------------------------------------------------
# 3. Generate (or reuse) the mTLS client certificate/key with openssl
# ---------------------------------------------------------------------------
if [[ -n "$CERT_PATH" && -n "$KEY_PATH" ]]; then
    log "Using provided certificate: $CERT_PATH"
    log "Using provided private key: $KEY_PATH"
    [[ -f "$CERT_PATH" ]] || die "Certificate file not found: $CERT_PATH"
    [[ -f "$KEY_PATH" ]]  || die "Key file not found: $KEY_PATH"
    cp "$CERT_PATH" "$WORKDIR/client.crt"
    cp "$KEY_PATH" "$WORKDIR/client.key"
else
    log "Generating self-signed EC client certificate (CN=$CERT_CN, ${CERT_DAYS}d validity)..."
    openssl ecparam -name prime256v1 -genkey -noout -out "$WORKDIR/client.key"
    openssl req -new -x509 \
        -key "$WORKDIR/client.key" \
        -out "$WORKDIR/client.crt" \
        -days "$CERT_DAYS" \
        -subj "/CN=${CERT_CN}"
    log "Certificate generated:"
    openssl x509 -in "$WORKDIR/client.crt" -noout -subject -dates | sed 's/^/    /' >&2
fi

CERT_CONTENT="$(cat "$WORKDIR/client.crt")"
KEY_CONTENT="$(cat "$WORKDIR/client.key")"

# ---------------------------------------------------------------------------
# 4. Register the client certificate with the Konnect control plane
#    (pinned_client_certs auth) — idempotent: skip if identical cert exists
# ---------------------------------------------------------------------------
log "Checking existing DP client certificates on control plane..."
EXISTING_CERTS="$(konnect_api GET "/v2/control-planes/${CONTROL_PLANE_ID}/dp-client-certificates")"
CERT_FINGERPRINT="$(openssl x509 -in "$WORKDIR/client.crt" -noout -fingerprint -sha256 | cut -d= -f2)"

# The Konnect API is inconsistent about wrapping single resources in an
# "item" envelope (POST /dp-client-certificates returns {"item": {...}})
# vs. returning collection entries directly under "data". Handle both shapes.
ALREADY_REGISTERED=false
if echo "$EXISTING_CERTS" | jq -e '.data' >/dev/null 2>&1; then
    while IFS= read -r existing_cert; do
        [[ -z "$existing_cert" ]] && continue
        printf '%s' "$existing_cert" > "$WORKDIR/existing.crt"
        existing_fp="$(openssl x509 -in "$WORKDIR/existing.crt" -noout -fingerprint -sha256 2>/dev/null | cut -d= -f2 || true)"
        if [[ "$existing_fp" == "$CERT_FINGERPRINT" ]]; then
            ALREADY_REGISTERED=true
            break
        fi
    done < <(echo "$EXISTING_CERTS" | jq -r '.data[] | (.item.cert // .cert)')
fi

if $ALREADY_REGISTERED; then
    log "Certificate already registered with control plane. Skipping upload."
elif $DRY_RUN; then
    warn "[dry-run] Would POST new client certificate to /v2/control-planes/${CONTROL_PLANE_ID}/dp-client-certificates"
else
    log "Registering new client certificate with control plane..."
    jq -n --arg cert "$CERT_CONTENT" '{cert: $cert}' > "$WORKDIR/cert-payload.json"
    REGISTER_RESPONSE="$(konnect_api POST "/v2/control-planes/${CONTROL_PLANE_ID}/dp-client-certificates" "$WORKDIR/cert-payload.json")"
    REGISTERED_CERT_ID="$(echo "$REGISTER_RESPONSE" | jq -r '(.item.id // .id) // empty')"
    if [[ -n "$REGISTERED_CERT_ID" ]]; then
        log "Certificate registered. ID: $REGISTERED_CERT_ID"
    else
        die "Failed to register client certificate with Konnect:
$REGISTER_RESPONSE"
    fi
fi

# ---------------------------------------------------------------------------
# 5. Build the Secrets Manager JSON payload
# ---------------------------------------------------------------------------
SECRET_JSON="$WORKDIR/secret.json"
jq -n \
    --arg certificate "$CERT_CONTENT" \
    --arg private_key "$KEY_CONTENT" \
    --arg cp_endpoint "$CONTROL_PLANE_GROUP_ENDPOINT" \
    --arg cluster_server_name "$CLUSTER_SERVER_NAME" \
    --arg telemetry_endpoint "$TELEMETRY_ENDPOINT" \
    --arg telemetry_server_name "$TELEMETRY_SERVER_NAME" \
    '{
        certificate: $certificate,
        private_key: $private_key,
        control_plane_group_endpoint: $cp_endpoint,
        cluster_server_name: $cluster_server_name,
        telemetry_endpoint: $telemetry_endpoint,
        telemetry_server_name: $telemetry_server_name
    }' > "$SECRET_JSON"

log "Secret payload prepared (values redacted below):"
jq '.certificate = "<redacted>" | .private_key = "<redacted>"' "$SECRET_JSON" | sed 's/^/    /' >&2

# ---------------------------------------------------------------------------
# 6. Create or update the secret in AWS Secrets Manager
# ---------------------------------------------------------------------------
AWS_ARGS=(--region "$AWS_REGION")

SECRET_EXISTS=false
if aws secretsmanager describe-secret --secret-id "$SECRET_NAME" "${AWS_ARGS[@]}" >/dev/null 2>&1; then
    SECRET_EXISTS=true
fi

if $DRY_RUN; then
    if $SECRET_EXISTS; then
        warn "[dry-run] Would run: aws secretsmanager put-secret-value --secret-id $SECRET_NAME --secret-string file://<redacted> --region $AWS_REGION"
    else
        warn "[dry-run] Would run: aws secretsmanager create-secret --name $SECRET_NAME --secret-string file://<redacted> --region $AWS_REGION"
    fi
    log "Dry run complete. No AWS or Konnect resources were modified beyond read-only lookups."
    exit 0
fi

CREATE_ARGS=("${AWS_ARGS[@]}")
if [[ -n "$KMS_KEY_ID" ]]; then
    CREATE_ARGS+=(--kms-key-id "$KMS_KEY_ID")
fi

if $SECRET_EXISTS; then
    if ! $FORCE; then
        log "Secret '$SECRET_NAME' already exists. Updating its value (use --force to be explicit, this is the default behavior)."
    fi
    log "Updating existing secret: $SECRET_NAME"
    SECRET_ARN="$(aws secretsmanager put-secret-value \
        --secret-id "$SECRET_NAME" \
        --secret-string "file://${SECRET_JSON}" \
        "${AWS_ARGS[@]}" \
        --query 'ARN' --output text)"
else
    log "Creating new secret: $SECRET_NAME"
    SECRET_ARN="$(aws secretsmanager create-secret \
        --name "$SECRET_NAME" \
        --description "Kong Konnect DP client certificate + control plane endpoints for ${SECRET_NAME}" \
        --secret-string "file://${SECRET_JSON}" \
        "${CREATE_ARGS[@]}" \
        --query 'ARN' --output text)"
fi

log "Done. Secret ARN:"
echo "$SECRET_ARN"

log "Use this ARN as SERVICE{N}_SECRET_ARN / secretArn in your konnect-ecs-dataplane config."
