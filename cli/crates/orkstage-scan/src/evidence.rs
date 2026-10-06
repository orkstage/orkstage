//! Internal evidence produced by detectors, before merging into `DetectedResource`s.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{Map, Value};

use crate::model::{Confidence, Provider, ResourceType, SourceKind, SourceRef, Unmapped};

/// One piece of evidence for a logical resource.
#[derive(Debug, Clone)]
pub(crate) struct Candidate {
    pub kind: ResourceType,
    pub provider: Option<Provider>,
    pub implementation: Option<String>,
    /// Human name hint, turned into the template id later.
    pub name: String,
    /// Template fields (`replicas`, `cpu`, `size`, ...) plus a few evidence-only fields.
    pub props: Map<String, Value>,
    pub sources: Vec<SourceRef>,
    pub confidence: Confidence,
    /// Unique key, used by links/routes (`tf:<scope>:aws_db_instance.main`).
    pub key: String,
    /// Other keys that designate this candidate (folded resources, target groups, ...).
    pub aliases: Vec<String>,
    /// Directory of the defining file.
    pub dir: String,
    /// Directory the image is built from (Compose `build.context`), when known.
    pub build_dir: Option<String>,
    /// Ingress only: routed service keys with their path prefix.
    pub routes: Vec<(String, String)>,
    /// DNS only: key of the ingress it points to.
    pub dns_target: Option<String>,
}

impl Candidate {
    pub fn new(
        kind: ResourceType,
        provider: Option<Provider>,
        name: impl Into<String>,
        source: SourceRef,
        confidence: Confidence,
        key: impl Into<String>,
    ) -> Self {
        let dir = crate::util::dir_of(&source.file).to_string();
        Candidate {
            kind,
            provider,
            implementation: None,
            name: name.into(),
            props: Map::new(),
            sources: vec![source],
            confidence,
            key: key.into(),
            aliases: Vec::new(),
            dir,
            build_dir: None,
            routes: Vec::new(),
            dns_target: None,
        }
    }

    pub fn implementation(mut self, id: &str) -> Self {
        self.implementation = Some(id.to_string());
        self
    }

    pub fn set(&mut self, key: &str, value: impl Into<Value>) {
        self.props.insert(key.to_string(), value.into());
    }

    pub fn set_opt<T: Into<Value>>(&mut self, key: &str, value: Option<T>) {
        if let Some(v) = value {
            self.set(key, v);
        }
    }

    pub fn priority(&self) -> u8 {
        self.sources.iter().map(|s| s.kind.priority()).max().unwrap_or(0)
    }

    pub fn matches_key(&self, key: &str) -> bool {
        self.key == key || self.aliases.iter().any(|a| a == key)
    }
}

/// Either end of a connection, resolved to a template id after merging.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Endpoint {
    /// A candidate key or alias.
    Key(String),
}

#[derive(Debug, Clone)]
pub(crate) struct Link {
    pub from: Endpoint,
    pub to: Endpoint,
    pub protocol: Option<String>,
    pub port: Option<u16>,
    pub evidence: String,
}

/// A Dockerfile in a directory: hints for the service built there.
#[derive(Debug, Clone)]
pub(crate) struct DockerHint {
    pub dir: String,
    pub port: Option<u16>,
    pub base_image: Option<String>,
    pub healthcheck_path: Option<String>,
    pub source: SourceRef,
}

/// A client library that implies a required backing service.
#[derive(Debug, Clone)]
pub(crate) struct PackageHint {
    pub dir: String,
    pub kind: ResourceType,
    pub library: String,
    pub confidence: Confidence,
    pub protocol: &'static str,
    pub port: Option<u16>,
    pub source: SourceRef,
}

#[derive(Debug, Default)]
pub(crate) struct Findings {
    pub candidates: Vec<Candidate>,
    pub links: Vec<Link>,
    pub unmapped: Vec<Unmapped>,
    pub warnings: Vec<String>,
    pub docker: Vec<DockerHint>,
    pub packages: Vec<PackageHint>,
    pub files: BTreeMap<SourceKind, BTreeSet<String>>,
}

impl Findings {
    pub fn count(&mut self, kind: SourceKind, file: &str) {
        self.files.entry(kind).or_default().insert(file.to_string());
    }

    pub fn unmapped(&mut self, source: SourceRef, kind: impl Into<String>, reason: impl Into<String>) {
        self.unmapped.push(Unmapped { source, kind: kind.into(), reason: reason.into() });
    }

    pub fn warn(&mut self, msg: impl Into<String>) {
        self.warnings.push(msg.into());
    }

    pub fn link(
        &mut self,
        from: Endpoint,
        to: Endpoint,
        protocol: Option<&str>,
        port: Option<u16>,
        evidence: impl Into<String>,
    ) {
        self.links.push(Link { from, to, protocol: protocol.map(str::to_string), port, evidence: evidence.into() });
    }
}

pub(crate) fn src(kind: SourceKind, file: &str, line: Option<u32>, address: impl Into<String>) -> SourceRef {
    SourceRef { kind, file: file.to_string(), line, address: address.into() }
}
