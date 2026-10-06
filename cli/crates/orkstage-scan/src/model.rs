//! ScanReport v1, as specified in `docs/specs/integration-api.md`. Field names and enum
//! spellings here are part of the wire contract with the platform.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// Kind of source an item was detected in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SourceKind {
    Terraform,
    Cloudformation,
    Sam,
    Cdk,
    Serverless,
    Pulumi,
    Kubernetes,
    Helm,
    Compose,
    Dockerfile,
    Package,
    Bicep,
    Arm,
}

impl SourceKind {
    pub const ALL: [SourceKind; 13] = [
        SourceKind::Terraform,
        SourceKind::Cloudformation,
        SourceKind::Sam,
        SourceKind::Cdk,
        SourceKind::Serverless,
        SourceKind::Pulumi,
        SourceKind::Kubernetes,
        SourceKind::Helm,
        SourceKind::Compose,
        SourceKind::Dockerfile,
        SourceKind::Package,
        SourceKind::Bicep,
        SourceKind::Arm,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            SourceKind::Terraform => "terraform",
            SourceKind::Cloudformation => "cloudformation",
            SourceKind::Sam => "sam",
            SourceKind::Cdk => "cdk",
            SourceKind::Serverless => "serverless",
            SourceKind::Pulumi => "pulumi",
            SourceKind::Kubernetes => "kubernetes",
            SourceKind::Helm => "helm",
            SourceKind::Compose => "compose",
            SourceKind::Dockerfile => "dockerfile",
            SourceKind::Package => "package",
            SourceKind::Bicep => "bicep",
            SourceKind::Arm => "arm",
        }
    }

    /// Evidence strength used when merging: provider IaC beats orchestration manifests, which
    /// beat local-development files, which beat library hints.
    pub(crate) fn priority(self) -> u8 {
        match self {
            SourceKind::Terraform
            | SourceKind::Cloudformation
            | SourceKind::Sam
            | SourceKind::Cdk
            | SourceKind::Bicep
            | SourceKind::Arm
            | SourceKind::Pulumi
            | SourceKind::Serverless => 4,
            SourceKind::Kubernetes | SourceKind::Helm => 3,
            SourceKind::Compose => 2,
            SourceKind::Dockerfile => 1,
            SourceKind::Package => 0,
        }
    }
}

/// OrkStage logical resource types (template `spec.resources[].type`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub enum ResourceType {
    #[serde(rename = "network")]
    Network,
    #[serde(rename = "compute.container-service")]
    ContainerService,
    #[serde(rename = "container-registry")]
    ContainerRegistry,
    #[serde(rename = "database.postgresql")]
    Postgres,
    #[serde(rename = "cache.redis")]
    Redis,
    #[serde(rename = "queue")]
    Queue,
    #[serde(rename = "object-storage")]
    ObjectStorage,
    #[serde(rename = "ingress")]
    Ingress,
    #[serde(rename = "dns")]
    Dns,
}

impl ResourceType {
    pub fn as_str(self) -> &'static str {
        match self {
            ResourceType::Network => "network",
            ResourceType::ContainerService => "compute.container-service",
            ResourceType::ContainerRegistry => "container-registry",
            ResourceType::Postgres => "database.postgresql",
            ResourceType::Redis => "cache.redis",
            ResourceType::Queue => "queue",
            ResourceType::ObjectStorage => "object-storage",
            ResourceType::Ingress => "ingress",
            ResourceType::Dns => "dns",
        }
    }

    /// Template id used when a project has exactly one resource of this type.
    pub(crate) fn default_id(self) -> &'static str {
        match self {
            ResourceType::Network => "network",
            ResourceType::ContainerService => "app",
            ResourceType::ContainerRegistry => "registry",
            ResourceType::Postgres => "database",
            ResourceType::Redis => "cache",
            ResourceType::Queue => "messaging",
            ResourceType::ObjectStorage => "storage",
            ResourceType::Ingress => "ingress",
            ResourceType::Dns => "dns",
        }
    }

    /// Order used in the generated template (dependencies first, like the built-ins).
    pub(crate) fn order(self) -> u8 {
        match self {
            ResourceType::Network => 0,
            ResourceType::ContainerRegistry => 1,
            ResourceType::ContainerService => 2,
            ResourceType::Postgres => 3,
            ResourceType::Redis => 4,
            ResourceType::Queue => 5,
            ResourceType::ObjectStorage => 6,
            ResourceType::Ingress => 7,
            ResourceType::Dns => 8,
        }
    }

    /// Types the platform places inside the slot's network.
    pub(crate) fn is_networked(self) -> bool {
        matches!(
            self,
            ResourceType::ContainerService | ResourceType::Postgres | ResourceType::Redis | ResourceType::Ingress
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Aws,
    Azure,
    Gcp,
    Oci,
}

impl Provider {
    pub fn as_str(self) -> &'static str {
        match self {
            Provider::Aws => "aws",
            Provider::Azure => "azure",
            Provider::Gcp => "gcp",
            Provider::Oci => "oci",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Confidence {
    Low,
    Medium,
    High,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct SourceRef {
    pub kind: SourceKind,
    pub file: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub line: Option<u32>,
    pub address: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DetectedResource {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: ResourceType,
    pub provider: Option<Provider>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub implementation: Option<String>,
    pub properties: Map<String, Value>,
    pub sources: Vec<SourceRef>,
    pub confidence: Confidence,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Unmapped {
    pub source: SourceRef,
    #[serde(rename = "type")]
    pub kind: String,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Connection {
    pub from: String,
    pub to: String,
    pub protocol: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub port: Option<u16>,
    pub evidence: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DetectorCount {
    pub kind: SourceKind,
    pub files: u32,
}

/// The engine output (ScanReport version 1).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ScanReport {
    pub version: u8,
    pub generator: String,
    pub detectors: Vec<DetectorCount>,
    pub resources: Vec<DetectedResource>,
    pub unmapped: Vec<Unmapped>,
    pub connections: Vec<Connection>,
    pub template: String,
    pub warnings: Vec<String>,
}

/// One input file. Paths use `/` separators and are relative to the project root.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InputFile {
    pub path: String,
    pub content: String,
}

impl InputFile {
    pub fn new(path: impl Into<String>, content: impl Into<String>) -> Self {
        InputFile { path: path.into().replace('\\', "/"), content: content.into() }
    }
}

/// Engine options. Every field is optional; `Default` gives sensible values.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ScanOptions {
    /// `metadata.name` of the generated template (`^[a-z][a-z0-9-]{1,62}$`). Default `imported-app`.
    pub template_name: Option<String>,
    /// `metadata.displayName`. Default: derived from the name.
    pub display_name: Option<String>,
    /// `metadata.version`. Default `0.1.0`.
    pub template_version: Option<String>,
    /// Files larger than this are skipped with a warning. Default 1 MiB.
    pub max_file_bytes: Option<usize>,
}
