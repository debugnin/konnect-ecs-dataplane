"""Generate a PS project assessment report PDF."""

from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import cm
from reportlab.lib import colors
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
    HRFlowable, KeepTogether
)
from reportlab.lib.enums import TA_LEFT, TA_CENTER
from datetime import date

OUTPUT   = "konnect-ecs-dataplane-report.pdf"
REPO_URL = "https://github.com/KongHQ-CX/konnect-ecs-dataplane"

def gh(path=""):
    """Return a GitHub URL for a file or directory path."""
    if not path:
        return REPO_URL
    sep = "tree" if path.endswith("/") else "blob"
    clean = path.rstrip("/")
    return f"{REPO_URL}/{sep}/main/{clean}"

# ── Colours ──────────────────────────────────────────────────────────────────
KONG_BLUE   = colors.HexColor("#003459")
KONG_GREEN  = colors.HexColor("#07C160")
LIGHT_GREY  = colors.HexColor("#F5F5F5")
MID_GREY    = colors.HexColor("#CCCCCC")
DARK_GREY   = colors.HexColor("#555555")
WHITE       = colors.white

# ── Document ─────────────────────────────────────────────────────────────────
doc = SimpleDocTemplate(
    OUTPUT,
    pagesize=A4,
    leftMargin=2.2*cm, rightMargin=2.2*cm,
    topMargin=2.2*cm,  bottomMargin=2.2*cm,
)
W = A4[0] - 4.4*cm   # usable width

# ── Styles ────────────────────────────────────────────────────────────────────
base = getSampleStyleSheet()

def style(name, parent="Normal", **kw):
    s = ParagraphStyle(name, parent=base[parent], **kw)
    return s

S_TITLE    = style("Title2",   "Title",
                   fontSize=22, textColor=KONG_BLUE, spaceAfter=4,
                   fontName="Helvetica-Bold")
S_SUB      = style("Sub",      fontSize=11, textColor=DARK_GREY,
                   spaceAfter=14)
S_H1       = style("H1",       "Heading1",
                   fontSize=13, textColor=KONG_BLUE,
                   spaceBefore=18, spaceAfter=6, fontName="Helvetica-Bold")
S_H2       = style("H2",       "Heading2",
                   fontSize=11, textColor=KONG_BLUE,
                   spaceBefore=12, spaceAfter=4, fontName="Helvetica-Bold")
S_BODY     = style("Body",     fontSize=9.5, leading=14, spaceAfter=6)
S_BULLET   = style("Bullet",   fontSize=9.5, leading=14,
                   leftIndent=14, spaceAfter=3,
                   bulletIndent=4, bulletText="•")
S_CODE     = style("Code",     fontName="Courier", fontSize=8.5,
                   leading=13, backColor=LIGHT_GREY,
                   leftIndent=8, rightIndent=8, spaceAfter=6)
S_CAPTION  = style("Caption",  fontSize=8, textColor=DARK_GREY,
                   alignment=TA_CENTER)
S_LINK     = style("Link",     fontSize=9.5, leading=14,
                   textColor=colors.HexColor("#0563C1"), spaceAfter=3)
S_CELL_LNK = style("CellLink", fontSize=8.5, leading=13,
                   textColor=colors.HexColor("#0563C1"))

def h1(text): return Paragraph(text, S_H1)
def h2(text): return Paragraph(text, S_H2)
def body(text): return Paragraph(text, S_BODY)
def bullet(text): return Paragraph(text, S_BULLET)
def code(text): return Paragraph(text, S_CODE)
def link(label, url): return Paragraph(f'<a href="{url}" color="#0563C1">{label}</a> — <font color="#777777">{url}</font>', S_LINK)
def cell_link(label, url): return Paragraph(f'<a href="{url}" color="#0563C1"><u>{label}</u></a>', S_CELL_LNK)
def spacer(h=0.3): return Spacer(1, h*cm)
def rule(): return HRFlowable(width="100%", thickness=0.5, color=MID_GREY, spaceAfter=6)

def section_table(rows):
    """Two-column table: asset name | description."""
    col_w = [W * 0.35, W * 0.65]
    data = [["Asset / File", "Purpose"]] + rows
    t = Table(data, colWidths=col_w)
    t.setStyle(TableStyle([
        ("BACKGROUND",   (0,0), (-1,0), KONG_BLUE),
        ("TEXTCOLOR",    (0,0), (-1,0), WHITE),
        ("FONTNAME",     (0,0), (-1,0), "Helvetica-Bold"),
        ("FONTSIZE",     (0,0), (-1,0), 9),
        ("ROWBACKGROUNDS", (0,1), (-1,-1), [WHITE, LIGHT_GREY]),
        ("FONTSIZE",     (0,1), (-1,-1), 8.5),
        ("VALIGN",       (0,0), (-1,-1), "TOP"),
        ("TOPPADDING",   (0,0), (-1,-1), 5),
        ("BOTTOMPADDING",(0,0), (-1,-1), 5),
        ("LEFTPADDING",  (0,0), (-1,-1), 7),
        ("GRID",         (0,0), (-1,-1), 0.3, MID_GREY),
    ]))
    return t


def feature_table(rows):
    """Three-column table: feature | status | notes."""
    col_w = [W * 0.30, W * 0.15, W * 0.55]
    data = [["Feature", "Status", "Notes"]] + rows
    t = Table(data, colWidths=col_w)
    t.setStyle(TableStyle([
        ("BACKGROUND",     (0,0), (-1,0), KONG_BLUE),
        ("TEXTCOLOR",      (0,0), (-1,0), WHITE),
        ("FONTNAME",       (0,0), (-1,0), "Helvetica-Bold"),
        ("FONTSIZE",       (0,0), (-1,0), 9),
        ("ROWBACKGROUNDS", (0,1), (-1,-1), [WHITE, LIGHT_GREY]),
        ("FONTSIZE",       (0,1), (-1,-1), 8.5),
        ("VALIGN",         (0,0), (-1,-1), "TOP"),
        ("TOPPADDING",     (0,0), (-1,-1), 5),
        ("BOTTOMPADDING",  (0,0), (-1,-1), 5),
        ("LEFTPADDING",    (0,0), (-1,-1), 7),
        ("GRID",           (0,0), (-1,-1), 0.3, MID_GREY),
    ]))
    return t


# ── Story ─────────────────────────────────────────────────────────────────────
story = []

# ── Cover block ───────────────────────────────────────────────────────────────
story += [
    spacer(1.2),
    Paragraph("Kong Konnect ECS Dataplane", S_TITLE),
    Paragraph("Professional Services Asset — Project Assessment Report", S_SUB),
    HRFlowable(width="100%", thickness=2, color=KONG_GREEN, spaceAfter=10),
    Paragraph(
        f"Prepared by: Frank Cao &nbsp;&nbsp;|&nbsp;&nbsp; "
        f"Date: {date.today().strftime('%B %d, %Y')}",
        style("Meta", fontSize=9, textColor=DARK_GREY)
    ),
    spacer(0.4),
    Paragraph(
        f'Repository: <a href="{REPO_URL}" color="#0563C1"><u>{REPO_URL}</u></a>',
        style("RepoLink", fontSize=10, textColor=DARK_GREY)
    ),
    spacer(1.4),
]

# ── 1. Executive Summary ──────────────────────────────────────────────────────
story += [
    h1("1. Executive Summary"),
    rule(),
    body(
        "This asset is a <b>production-ready AWS CDK (TypeScript) library</b> that automates "
        "the deployment of Kong Gateway data planes on AWS ECS Fargate, connecting to "
        "<b>Kong Konnect</b> as the managed control plane. It is designed as a reusable "
        "Professional Services accelerator that customers can adopt with minimal customisation."
    ),
    body(
        "The project covers the full operational surface: shared networking (VPC, ALB, WAF), "
        "per-service Kong ECS clusters with mTLS to Konnect, control-plane outage resilience "
        "via S3, multi-region Route 53 failover, per-service Redis (ElastiCache), centralised "
        "log streaming, and a config-file-driven deployment model."
    ),
    spacer(),
]

# ── 2. Repository Structure ────────────────────────────────────────────────────
story += [
    h1("2. Repository Structure"),
    rule(),
    body("The repository is a single-package CDK application with the following top-level layout:"),
    spacer(0.2),
    section_table([
        [cell_link("bin/kong-ecs-cdk.ts",              gh("bin/kong-ecs-cdk.ts")),
         "CDK app entry point — reads config, instantiates all stacks"],
        [cell_link("lib/kong-infrastructure-stack.ts", gh("lib/kong-infrastructure-stack.ts")),
         "Shared infra stack: VPC, ALB, WAF, ACM certificate, Route 53"],
        [cell_link("lib/kong-service-stack.ts",        gh("lib/kong-service-stack.ts")),
         "Per-service stack: ECS cluster, Kong DP tasks, ALB listener rule, IAM"],
        [cell_link("lib/constructs/",                  gh("lib/constructs/")),
         "Seven fine-grained CDK constructs (vpc, alb, waf, certificate, dp-resilience, redis, logging)"],
        [cell_link("config/{env}.json",                gh("config/")),
         "Environment-specific config file (highest config precedence)"],
        [cell_link("test/",                            gh("test/")),
         "Jest test suite (currently scaffolded; tests to be expanded)"],
    ]),
    spacer(),
]

# ── 3. Documentation Assets ────────────────────────────────────────────────────
story += [
    h1("3. Documentation Assets"),
    rule(),
    body(
        "The repository ships eight Markdown documents. Each addresses a distinct operational "
        "concern and is suitable for handing directly to a customer's platform team."
    ),
    spacer(0.2),
    section_table([
        [cell_link("README.md",               gh("README.md")),
         "Project overview, quick-start, full env-var reference, secret format"],
        [cell_link("DEPLOYMENT_GUIDE.md",     gh("DEPLOYMENT_GUIDE.md")),
         "Step-by-step multi-service deployment, stack outputs, troubleshooting"],
        [cell_link("NAMING_CONVENTIONS.md",   gh("NAMING_CONVENTIONS.md")),
         "Resource naming patterns for shared vs service-specific AWS resources"],
        [cell_link("MULTI_REGION_SETUP.md",   gh("MULTI_REGION_SETUP.md")),
         "Primary / secondary region deployment with Route 53 failover"],
        [cell_link("DP_RESILIENCE_SETUP.md",  gh("DP_RESILIENCE_SETUP.md")),
         "S3-backed config backup; CP-outage recovery procedure"],
        [cell_link("REDIS_SETUP.md",          gh("REDIS_SETUP.md")),
         "ElastiCache (Redis) configuration for rate limiting and caching"],
        [cell_link("WAF_CONFIGURATION.md",    gh("WAF_CONFIGURATION.md")),
         "WAF rule set, CIDR allowlist setup, rate-limit tuning"],
        [cell_link("LOGGING_SETUP.md",        gh("LOGGING_SETUP.md")),
         "CloudWatch log streaming to a central account via subscription filters"],
        [cell_link("architecture-diagram.md", gh("architecture-diagram.md")),
         "Textual architecture diagram supplement to the PNG"],
    ]),
    spacer(),
]

# ── 4. Infrastructure Capabilities ────────────────────────────────────────────
story += [
    h1("4. Infrastructure Capabilities"),
    rule(),
    feature_table([
        ["Multi-service / path routing",    "Included", "Up to 100 services share one ALB; path-priority auto-calculated"],
        ["mTLS to Konnect CP",              "Included", "Certs stored in Secrets Manager; injected as ECS secrets at runtime"],
        ["WAF (OWASP + rate limit)",        "Included", "AWS Managed Rules + custom CIDR allowlist; default-block if no CIDRs set"],
        ["DP resilience (S3 fallback)",     "Opt-in",   "Backup ECS node exports config; regular nodes import on CP outage"],
        ["Multi-region failover",           "Opt-in",   "Route 53 health-check failover; set REGIONAL_SUFFIX=secondary"],
        ["Redis / ElastiCache",             "Opt-in",   "Per-service; encryption at rest + in transit; multi-AZ toggle"],
        ["VPC endpoints",                   "Default on","S3, Secrets Manager, ECR, CloudWatch — no internet traversal"],
        ["Konnect PrivateLink",             "Opt-in",   "VPC endpoint for CP-DP traffic; geo-specific service names"],
        ["Central log streaming",           "Opt-in",   "CloudWatch subscription filters to cross-account Kinesis destination"],
        ["ARM64 Fargate tasks",             "Included", "All ECS tasks use ARM64 / Linux for cost efficiency"],
        ["Image via CfnParameter",          "Included", "Container image updatable via CloudFormation without CDK re-run"],
        ["Force secret refresh",            "Opt-in",   "FORCE_REFRESH_TOKEN triggers task restart to pick up new secrets"],
    ]),
    spacer(),
]

# ── 5. Configuration Model ─────────────────────────────────────────────────────
story += [
    h1("5. Configuration Model"),
    rule(),
    body(
        "Configuration is resolved with a three-level precedence chain, making the asset "
        "suitable for both local development and CI/CD pipelines:"
    ),
    bullet("<b>1. config/{environment}.json</b> — checked into the repo; highest priority"),
    bullet("<b>2. cdk.context.json / --context flags</b> — CDK-native context"),
    bullet("<b>3. Environment variables</b> — convenient for pipeline injection"),
    spacer(0.3),
    body("<b>Required at minimum:</b>"),
    code("ENVIRONMENT=dev|qa|uat|prd\nSERVICE1_NAME=customers\nSERVICE1_PATH=/customers\nSERVICE1_SECRET_ARN=arn:aws:secretsmanager:..."),
    body(
        "Additional services are added by incrementing the index "
        "(SERVICE2_*, SERVICE3_*, … up to SERVICE100_*)."
    ),
    spacer(),
]

# ── Footer rule ────────────────────────────────────────────────────────────────
story += [
    HRFlowable(width="100%", thickness=1, color=KONG_BLUE),
    Paragraph(
        "Kong Professional Services — Confidential &nbsp;|&nbsp; "
        "konnect-ecs-dataplane asset &nbsp;|&nbsp; "
        f"{date.today().strftime('%Y-%m-%d')}",
        style("Footer", fontSize=8, textColor=DARK_GREY, alignment=TA_CENTER)
    ),
]

# ── Build ──────────────────────────────────────────────────────────────────────
doc.build(story)
print(f"Report written to {OUTPUT}")
