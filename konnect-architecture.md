# Kong Konnect Hybrid Architecture

```mermaid
graph TB
    subgraph "Kong Konnect SaaS"
        CP[Control Plane<br/><your-cp-id>.region.cp0.konghq.com:443]
        TP[Telemetry Plane<br/><your-cp-id>.region.tp0.konghq.com:443]
    end
    
    subgraph "AWS Cloud"
        subgraph "VPC"
            subgraph "Public Subnets"
                ALB[Application Load Balancer<br/>Data Plane]
                NAT[NAT Gateway]
            end
            
            subgraph "Private Subnets"
                subgraph "ECS Cluster"
                    DP1[Kong DP Container<br/>Proxy: 8000<br/>Status: 8100]
                    DP2[Kong DP Container<br/>Proxy: 8000<br/>Status: 8100]
                end
            end
        end
        
        subgraph "AWS Secrets Manager"
            SEC[Client Certificate Secret<br/>- certificate<br/>- private_key<br/>- control_plane_group_endpoint<br/>- telemetry_endpoint]
        end
        
        subgraph "CloudWatch Logs"
            LOG[Data Plane Logs<br/>/ecs/kong-data-plane]
        end
    end
    
    subgraph "Internet"
        USER[API Clients]
    end
    
    %% External connections
    USER --> ALB
    
    %% Load balancer connections
    ALB --> DP1
    ALB --> DP2
    
    %% Konnect connections
    DP1 -.->|mTLS| CP
    DP2 -.->|mTLS| CP
    DP1 -.->|Telemetry| TP
    DP2 -.->|Telemetry| TP
    
    %% Secrets connections
    DP1 -.-> SEC
    DP2 -.-> SEC
    
    %% Logging connections
    DP1 -.-> LOG
    DP2 -.-> LOG
    
    %% Styling
    classDef aws fill:#ff9900,stroke:#232f3e,stroke-width:2px,color:#fff
    classDef kong fill:#003459,stroke:#00d4aa,stroke-width:2px,color:#fff
    classDef konnect fill:#00d4aa,stroke:#003459,stroke-width:2px,color:#000
    classDef secrets fill:#dd344c,stroke:#232f3e,stroke-width:2px,color:#fff
    classDef external fill:#232f3e,stroke:#00d4aa,stroke-width:2px,color:#fff
    
    class ALB,NAT aws
    class DP1,DP2 kong
    class CP,TP konnect
    class SEC secrets
    class USER external
```

## Architecture Components

### Kong Konnect (SaaS)
- **Control Plane**: Manages configuration and policies
- **Telemetry Plane**: Collects metrics and analytics

### AWS Infrastructure
- **ECS Fargate**: Runs Kong data plane containers
- **Application Load Balancer**: Routes traffic to data plane
- **VPC**: Network isolation with public/private subnets
- **Secrets Manager**: Stores client certificates securely
- **CloudWatch Logs**: Centralized logging

### Security
- **mTLS**: Secure communication between data plane and Konnect
- **Client Certificates**: PKI-based authentication
- **Private Subnets**: Data plane isolated from internet
- **IAM Roles**: Least privilege access to secrets

### Data Flow
1. API clients send requests to ALB
2. ALB routes to Kong data plane containers
3. Data plane connects to Konnect control plane via mTLS
4. Telemetry data sent to Konnect telemetry plane
5. Logs streamed to CloudWatch