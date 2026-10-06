//! Merges detector evidence into a coherent set of resources: dedupe across sources (IaC
//! wins over Compose/Kubernetes, which win over Dockerfiles and package hints), attach hints,
//! infer the missing network/ingress/DNS, assign template ids and placement slots, and
//! resolve connections without introducing dependency cycles.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{Map, Value, json};

use crate::evidence::{Candidate, Endpoint, Findings};
use crate::model::{Confidence, Connection, DetectedResource, Provider, ResourceType as RT, SourceKind};
use crate::util::{self, norm_name, sanitize_id};

/// A resource ready for the template.
#[derive(Debug, Clone)]
pub(crate) struct Final {
    pub id: String,
    pub c: Candidate,
    pub placement: String,
    pub build_dirs: Vec<String>,
    pub inferred: bool,
    /// Ingress: (service id, path prefix). DNS: target ingress id.
    pub routes: Vec<(String, String)>,
    pub dns_target: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct Placement {
    pub name: String,
    pub description: String,
    pub providers: Vec<Provider>,
}

#[derive(Debug, Clone)]
pub(crate) struct Conn {
    pub from: String,
    pub to: String,
    pub protocol: String,
    pub port: Option<u16>,
    pub mode: &'static str,
    pub evidence: String,
}

/// (from id, to id, protocol hint, port hint, evidence) before deduplication.
type RawLink = (String, String, Option<String>, Option<u16>, String);

pub(crate) struct Merged {
    pub resources: Vec<Final>,
    pub placements: Vec<Placement>,
    pub connections: Vec<Conn>,
    pub warnings: Vec<String>,
}

impl Merged {
    pub fn detected(&self) -> Vec<DetectedResource> {
        self.resources
            .iter()
            .map(|f| {
                let mut props: Map<String, Value> =
                    f.c.props
                        .iter()
                        .filter(|(k, _)| !k.starts_with('_'))
                        .map(|(k, v)| (k.clone(), v.clone()))
                        .collect();
                if f.placement != "primary" {
                    props.insert("placement".into(), f.placement.clone().into());
                }
                if f.c.kind == RT::Ingress {
                    props.insert(
                        "routes".into(),
                        Value::Array(f.routes.iter().map(|(s, p)| json!({ "service": s, "pathPrefix": p })).collect()),
                    );
                }
                if let Some(t) = &f.dns_target {
                    props.insert("target".into(), t.clone().into());
                }
                if f.inferred {
                    props.insert("inferred".into(), true.into());
                }
                let mut sources = f.c.sources.clone();
                sources.sort();
                sources.dedup();
                DetectedResource {
                    id: f.id.clone(),
                    kind: f.c.kind,
                    provider: f.c.provider,
                    implementation: f.c.implementation.clone(),
                    properties: props,
                    sources,
                    confidence: f.c.confidence,
                }
            })
            .collect()
    }

    pub fn report_connections(&self) -> Vec<Connection> {
        self.connections
            .iter()
            .map(|c| Connection {
                from: c.from.clone(),
                to: c.to.clone(),
                protocol: c.protocol.clone(),
                port: c.port,
                evidence: c.evidence.clone(),
            })
            .collect()
    }
}

struct Group {
    c: Candidate,
    build_dirs: Vec<String>,
    inferred: bool,
}

/// Folds `other` into `base`; the stronger evidence keeps its values.
fn absorb(base: &mut Candidate, mut other: Candidate) {
    if other.priority() > base.priority() {
        std::mem::swap(base, &mut other);
    }
    for (k, v) in other.props {
        base.props.entry(k).or_insert(v);
    }
    base.sources.extend(other.sources);
    base.aliases.push(other.key);
    base.aliases.extend(other.aliases);
    if base.provider.is_none() {
        base.provider = other.provider;
    }
    if base.implementation.is_none() && base.provider == other.provider {
        base.implementation = other.implementation;
    }
    base.confidence = base.confidence.max(other.confidence);
    if base.build_dir.is_none() {
        base.build_dir = other.build_dir;
    }
    base.routes.extend(other.routes);
    if base.dns_target.is_none() {
        base.dns_target = other.dns_target;
    }
}

fn most_common(providers: impl Iterator<Item = Provider>) -> Option<Provider> {
    let mut counts: BTreeMap<Provider, usize> = BTreeMap::new();
    for p in providers {
        *counts.entry(p).or_default() += 1;
    }
    // Highest count; ties broken by the enum order (aws first), deterministic.
    counts.iter().max_by(|a, b| a.1.cmp(b.1).then(b.0.cmp(a.0))).map(|(p, _)| *p)
}

pub(crate) fn merge(findings: Findings) -> Merged {
    let Findings { candidates, links, docker, packages, .. } = findings;
    let mut warnings = Vec::new();

    // 1. Same type + same normalised name → one resource.
    let mut sorted = candidates;
    sorted.sort_by(|a, b| b.priority().cmp(&a.priority()).then(a.key.cmp(&b.key)));
    let mut by_name: std::collections::HashMap<(RT, String), usize> = std::collections::HashMap::new();
    let mut groups: Vec<Group> = Vec::new();
    for c in sorted {
        let n = norm_name(&c.name);
        // Indexed by (type, name): candidates arrive strongest first, so the group base never changes.
        let pos = match c.kind {
            RT::Network | RT::Dns => {
                groups.iter().position(|g| g.c.kind == c.kind && (g.c.provider == c.provider || c.provider.is_none()))
            }
            _ => by_name.get(&(c.kind, n.clone())).copied(),
        };
        match pos {
            Some(i) => absorb(&mut groups[i].c, c),
            None => {
                by_name.insert((c.kind, n), groups.len());
                groups.push(Group { build_dirs: c.build_dir.iter().cloned().collect(), c, inferred: false });
            }
        }
    }

    // 2. Provider-neutral evidence of a backing service folds into the IaC resource.
    for kind in [RT::Postgres, RT::Redis, RT::Queue, RT::ObjectStorage, RT::Dns, RT::Network] {
        let has_iac = groups.iter().any(|g| g.c.kind == kind && g.c.provider.is_some());
        if !has_iac {
            continue;
        }
        let mut i = 0;
        while i < groups.len() {
            if groups[i].c.kind == kind && groups[i].c.provider.is_none() {
                let g = groups.remove(i);
                let n = norm_name(&g.c.name);
                let target = groups
                    .iter()
                    .position(|t| t.c.kind == kind && t.c.provider.is_some() && norm_name(&t.c.name) == n)
                    .or_else(|| groups.iter().position(|t| t.c.kind == kind && t.c.provider.is_some()));
                if let Some(t) = target {
                    let dirs = g.build_dirs;
                    absorb(&mut groups[t].c, g.c);
                    groups[t].build_dirs.extend(dirs);
                }
            } else {
                i += 1;
            }
        }
    }

    // 3. Dockerfile hints → the service built from that directory.
    for hint in docker {
        let dir_norm = norm_name(util::dir_name(&hint.dir));
        let services: Vec<usize> = (0..groups.len()).filter(|i| groups[*i].c.kind == RT::ContainerService).collect();
        let target = services
            .iter()
            .copied()
            .find(|i| groups[*i].build_dirs.iter().any(|d| d == &hint.dir))
            .or_else(|| {
                services.iter().copied().find(|i| !dir_norm.is_empty() && norm_name(&groups[*i].c.name) == dir_norm)
            })
            .or_else(|| (hint.dir.is_empty() && services.len() == 1).then(|| services[0]));
        let idx = match target {
            Some(i) => i,
            None if services.is_empty()
                || !hint.dir.is_empty()
                    && services.iter().all(|i| {
                        groups[*i].c.provider.is_none()
                            && groups[*i].build_dirs.is_empty()
                            && groups[*i].c.sources.iter().all(|s| s.kind == SourceKind::Dockerfile)
                    }) =>
            {
                let name = if hint.dir.is_empty() { "app".to_string() } else { util::dir_name(&hint.dir).to_string() };
                let c = Candidate::new(
                    RT::ContainerService,
                    None,
                    name,
                    hint.source.clone(),
                    Confidence::Low,
                    format!("docker:{}", hint.dir),
                );
                groups.push(Group { c, build_dirs: vec![hint.dir.clone()], inferred: false });
                groups.len() - 1
            }
            None => {
                warnings.push(format!(
                    "{}: Dockerfile not matched to a detected service; add it to Compose (build.context) or name its directory after the service",
                    hint.source.file
                ));
                continue;
            }
        };
        let g = &mut groups[idx];
        if !g.c.sources.contains(&hint.source) {
            g.c.sources.push(hint.source.clone());
        }
        if !g.build_dirs.contains(&hint.dir) {
            g.build_dirs.push(hint.dir.clone());
        }
        if let Some(p) = hint.port {
            g.c.props.entry("port".to_string()).or_insert(json!(p));
        }
        if let Some(h) = &hint.healthcheck_path {
            g.c.props.entry("healthCheckPath".to_string()).or_insert(json!(h));
        }
        if let Some(b) = &hint.base_image {
            g.c.props.entry("baseImage".to_string()).or_insert(json!(b));
        }
    }

    // 4. Package hints: required services. Attach to an existing resource or create one.
    let mut hint_links: Vec<(String, String, &'static str, Option<u16>, String)> = Vec::new();
    let mut by_kind: BTreeMap<RT, Vec<crate::evidence::PackageHint>> = BTreeMap::new();
    for h in packages {
        by_kind.entry(h.kind).or_default().push(h);
    }
    for (kind, hints) in by_kind {
        let idx = match groups.iter().position(|g| g.c.kind == kind) {
            Some(i) => i,
            None => {
                let first = &hints[0];
                let conf = hints.iter().map(|h| h.confidence).max().unwrap_or(Confidence::Low);
                let mut c = Candidate::new(
                    kind,
                    None,
                    kind.default_id(),
                    first.source.clone(),
                    conf,
                    format!("pkg:{}", kind.as_str()),
                );
                c.set("_protocol", first.protocol);
                c.set_opt("_port", first.port);
                groups.push(Group { c, build_dirs: Vec::new(), inferred: false });
                groups.len() - 1
            }
        };
        for h in &hints {
            if !groups[idx].c.sources.contains(&h.source) {
                groups[idx].c.sources.push(h.source.clone());
            }
            hint_links.push((
                h.dir.clone(),
                groups[idx].c.key.clone(),
                h.protocol,
                h.port,
                format!("{} depends on {}", h.source.file, h.library),
            ));
        }
    }

    // 5. Inference.
    let compute_provider =
        most_common(groups.iter().filter(|g| g.c.kind == RT::ContainerService).filter_map(|g| g.c.provider))
            .or_else(|| most_common(groups.iter().filter_map(|g| g.c.provider)));
    let has_networked = groups.iter().any(|g| g.c.kind.is_networked());
    if has_networked && !groups.iter().any(|g| g.c.kind == RT::Network) {
        let azs = if groups.iter().any(|g| {
            g.c.props.get("highAvailability").and_then(Value::as_str) == Some("zone-redundant")
                || g.c.props.get("replicas").and_then(Value::as_i64).unwrap_or(1) > 1
        }) {
            2
        } else {
            1
        };
        let mut c = inferred_candidate(RT::Network, compute_provider, "network", &groups);
        c.set("availabilityZones", azs);
        c.set("natGateway", false);
        warnings.push("network inferred: no network was declared but services and data stores need one".into());
        groups.push(Group { c, build_dirs: Vec::new(), inferred: true });
    }

    // Public services on a cloud provider need an ingress.
    let routed: BTreeSet<String> = groups
        .iter()
        .filter(|g| g.c.kind == RT::Ingress)
        .flat_map(|g| g.c.routes.iter().map(|r| r.0.clone()))
        .collect();
    let unrouted_public: Vec<String> = groups
        .iter()
        .filter(|g| g.c.kind == RT::ContainerService && g.c.props.get("public") == Some(&Value::Bool(true)))
        .filter(|g| g.c.provider.or(compute_provider).is_some())
        .filter(|g| !routed.iter().any(|r| g.c.matches_key(r)))
        .map(|g| g.c.key.clone())
        .collect();
    if !unrouted_public.is_empty() {
        let routes: Vec<(String, String)> = unrouted_public.iter().map(|k| (k.clone(), "/".to_string())).collect();
        if let Some(ing) = groups.iter_mut().find(|g| g.c.kind == RT::Ingress) {
            if ing.c.routes.is_empty() {
                ing.c.routes = routes;
            }
        } else {
            let mut c = inferred_candidate(RT::Ingress, compute_provider, "ingress", &groups);
            c.set("tls", true);
            c.routes = routes;
            warnings.push("ingress inferred: public HTTP services exist but no load balancer was declared".into());
            groups.push(Group { c, build_dirs: Vec::new(), inferred: true });
        }
    }
    // Ingress without resolvable routes: route to public (or any) services with a port.
    let fallback: Vec<String> = {
        let with_port = |g: &&Group| g.c.kind == RT::ContainerService && g.c.props.contains_key("port");
        let public: Vec<String> = groups
            .iter()
            .filter(with_port)
            .filter(|g| g.c.props.get("public") == Some(&Value::Bool(true)))
            .map(|g| g.c.key.clone())
            .collect();
        if public.is_empty() { groups.iter().filter(with_port).map(|g| g.c.key.clone()).collect() } else { public }
    };
    let mut i = 0;
    while i < groups.len() {
        if groups[i].c.kind == RT::Ingress && groups[i].c.routes.is_empty() {
            if fallback.is_empty() {
                warnings.push(format!(
                    "ingress \"{}\" dropped: no container service with a port to route to",
                    groups[i].c.name
                ));
                groups.remove(i);
                continue;
            }
            groups[i].c.routes = fallback.iter().map(|k| (k.clone(), "/".to_string())).collect();
            warnings.push(format!(
                "ingress \"{}\": routes could not be resolved from the source; routed to {} service(s) with a port",
                groups[i].c.name,
                fallback.len()
            ));
        }
        i += 1;
    }
    let first_ingress = groups.iter().find(|g| g.c.kind == RT::Ingress).map(|g| g.c.key.clone());
    let cloud_ingress = groups.iter().any(|g| g.c.kind == RT::Ingress && g.c.provider.or(compute_provider).is_some());
    if cloud_ingress && !groups.iter().any(|g| g.c.kind == RT::Dns) {
        let mut c = inferred_candidate(RT::Dns, compute_provider, "dns", &groups);
        c.set("customDomain", "disabled");
        c.dns_target = first_ingress.clone();
        warnings.push("dns inferred: an ingress exists; a platform subdomain points to it".into());
        groups.push(Group { c, build_dirs: Vec::new(), inferred: true });
    }
    let mut i = 0;
    while i < groups.len() {
        if groups[i].c.kind == RT::Dns {
            let valid = groups[i]
                .c
                .dns_target
                .as_ref()
                .is_some_and(|t| groups.iter().any(|g| g.c.kind == RT::Ingress && g.c.matches_key(t)));
            if !valid {
                match &first_ingress {
                    Some(k) => groups[i].c.dns_target = Some(k.clone()),
                    None => {
                        warnings.push("dns dropped: no ingress to point to".into());
                        groups.remove(i);
                        continue;
                    }
                }
            }
        }
        i += 1;
    }

    // 6. Ids.
    groups.sort_by(|a, b| {
        a.c.kind
            .order()
            .cmp(&b.c.kind.order())
            .then(b.c.priority().cmp(&a.c.priority()))
            .then(norm_name(&a.c.name).cmp(&norm_name(&b.c.name)))
            .then(a.c.key.cmp(&b.c.key))
    });
    let mut per_kind: BTreeMap<RT, usize> = BTreeMap::new();
    for g in &groups {
        *per_kind.entry(g.c.kind).or_default() += 1;
    }
    let mut used: BTreeSet<String> = BTreeSet::new();
    let mut ids: Vec<String> = Vec::new();
    for g in &groups {
        let single = per_kind[&g.c.kind] == 1;
        let base = if single && g.c.kind != RT::ContainerService {
            g.c.kind.default_id().to_string()
        } else {
            sanitize_id(&g.c.name).unwrap_or_else(|| g.c.kind.default_id().to_string())
        };
        let mut id = base.clone();
        let mut n = 2;
        while used.contains(&id) {
            let suffix = format!("-{n}");
            id = format!("{}{suffix}", &base[..base.len().min(40 - suffix.len())]);
            n += 1;
        }
        used.insert(id.clone());
        ids.push(id);
    }
    let id_of = |key: &str| -> Option<String> {
        groups.iter().zip(&ids).find(|(g, _)| g.c.matches_key(key)).map(|(_, id)| id.clone())
    };

    // 7. Placements.
    let mut slots: Vec<Placement> = vec![Placement {
        name: "primary".into(),
        description: match compute_provider {
            Some(p) => format!("Application runtime and everything detected on {}.", p.as_str()),
            None => "Everything detected; no cloud provider was evident, bind any target.".into(),
        },
        providers: compute_provider.into_iter().collect(),
    }];
    let mut placement_of: Vec<String> = Vec::new();
    for g in &groups {
        let slot = match g.c.provider {
            None => "primary".to_string(),
            Some(p) if Some(p) == compute_provider => "primary".to_string(),
            Some(p) => {
                let role = match g.c.kind {
                    RT::Postgres | RT::Redis => "data",
                    RT::ObjectStorage => "storage",
                    RT::Queue => "messaging",
                    RT::ContainerService | RT::ContainerRegistry => "compute",
                    RT::Network | RT::Ingress | RT::Dns => "edge",
                };
                let existing = slots
                    .iter()
                    .find(|s| s.providers == vec![p] && (s.name == role || s.name.starts_with(&format!("{role}-"))));
                match existing {
                    Some(s) => s.name.clone(),
                    None => {
                        let name = if slots.iter().any(|s| s.name == role) {
                            format!("{role}-{}", p.as_str())
                        } else {
                            role.to_string()
                        };
                        slots.push(Placement {
                            name: name.clone(),
                            description: format!("{} resources detected on {}.", capitalize(role), p.as_str()),
                            providers: vec![p],
                        });
                        name
                    }
                }
            }
        };
        placement_of.push(slot);
    }

    // 8. Finals with resolved routes and DNS targets.
    let mut finals: Vec<Final> = Vec::new();
    for ((g, id), placement) in groups.iter().zip(&ids).zip(&placement_of) {
        let mut routes: Vec<(String, String)> =
            g.c.routes.iter().filter_map(|(k, p)| id_of(k).map(|i| (i, p.clone()))).collect();
        routes.sort();
        routes.dedup_by(|a, b| a.0 == b.0);
        finals.push(Final {
            id: id.clone(),
            c: g.c.clone(),
            placement: placement.clone(),
            build_dirs: g.build_dirs.clone(),
            inferred: g.inferred,
            routes,
            dns_target: g.c.dns_target.as_deref().and_then(id_of),
        });
    }
    // Routed services need a port; ingress keeps only container-service routes.
    let service_ids: BTreeSet<String> =
        finals.iter().filter(|f| f.c.kind == RT::ContainerService).map(|f| f.id.clone()).collect();
    let mut needs_port = BTreeSet::new();
    for f in finals.iter_mut().filter(|f| f.c.kind == RT::Ingress) {
        f.routes.retain(|(s, _)| service_ids.contains(s));
        needs_port.extend(f.routes.iter().map(|r| r.0.clone()));
    }
    for f in finals.iter_mut().filter(|f| needs_port.contains(&f.id)) {
        if !f.c.props.contains_key("port") {
            f.c.set("port", 8080);
            warnings.push(format!("{}: routed by an ingress but no port was found; assumed 8080", f.id));
        }
    }

    // 9. Connections.
    let resolve = |e: &Endpoint| -> Vec<String> {
        match e {
            Endpoint::Key(k) => id_of(k).into_iter().collect(),
        }
    };
    let mut raw: Vec<RawLink> = Vec::new();
    for l in &links {
        for from in resolve(&l.from) {
            for to in resolve(&l.to) {
                raw.push((from.clone(), to, l.protocol.clone(), l.port, l.evidence.clone()));
            }
        }
    }
    for (dir, key, proto, port, evidence) in hint_links {
        for from in services_in_dir(&finals, &dir) {
            if let Some(to) = id_of(&key) {
                raw.push((from, to, Some(proto.to_string()), port, evidence.clone()));
            }
        }
    }
    let connections = connections(&finals, raw, &mut warnings);

    Merged { resources: finals, placements: slots, connections, warnings }
}

fn capitalize(s: &str) -> String {
    let mut c = s.chars();
    c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
}

fn inferred_candidate(kind: RT, provider: Option<Provider>, name: &str, groups: &[Group]) -> Candidate {
    // Inferred resources cite the evidence of the resources that justify them.
    let source = groups
        .iter()
        .find(|g| g.c.kind == RT::ContainerService)
        .or_else(|| groups.first())
        .and_then(|g| g.c.sources.first().cloned())
        .map(|mut s| {
            s.address = format!("inferred from {}", s.address);
            s
        });
    let mut c = Candidate::new(
        kind,
        provider,
        name,
        source.unwrap_or(crate::evidence::src(SourceKind::Package, "", None, "inferred")),
        Confidence::Low,
        format!("inferred:{name}"),
    );
    c.sources.clear();
    c.implementation = match (kind, provider) {
        (RT::Network, Some(Provider::Aws)) => Some("vpc".into()),
        (RT::Network, Some(Provider::Azure)) => Some("vnet".into()),
        (RT::Network, Some(Provider::Oci)) => Some("vcn".into()),
        (RT::Ingress, Some(Provider::Aws)) => Some("alb".into()),
        (RT::Ingress, Some(Provider::Azure)) => Some("application-gateway".into()),
        (RT::Dns, Some(Provider::Aws)) => Some("route53".into()),
        (RT::Dns, Some(Provider::Azure)) => Some("azure-dns".into()),
        _ => None,
    };
    c
}

fn services_in_dir(finals: &[Final], dir: &str) -> Vec<String> {
    let services: Vec<&Final> = finals.iter().filter(|f| f.c.kind == RT::ContainerService).collect();
    let by_build: Vec<String> =
        services.iter().filter(|f| f.build_dirs.iter().any(|d| d == dir)).map(|f| f.id.clone()).collect();
    if !by_build.is_empty() {
        return by_build;
    }
    let name = norm_name(util::dir_name(dir));
    if !name.is_empty()
        && let Some(f) = services.iter().find(|f| norm_name(&f.c.name) == name || f.id == name)
    {
        return vec![f.id.clone()];
    }
    if services.len() == 1
        && (dir.is_empty() || services[0].c.dir.starts_with(dir) || dir.starts_with(&services[0].c.dir))
    {
        return vec![services[0].id.clone()];
    }
    Vec::new()
}

/// Protocol/port for a connection to `to`.
fn endpoint_of(to: &Final, proto: Option<String>, port: Option<u16>) -> Option<(String, Option<u16>)> {
    let own_proto = to.c.props.get("_protocol").and_then(Value::as_str).map(str::to_string);
    let own_port = to.c.props.get("_port").and_then(Value::as_u64).map(|p| p as u16);
    let (protocol, port): (String, Option<u16>) = match to.c.kind {
        RT::Postgres => ("postgres".into(), Some(5432)),
        RT::Redis => ("redis".into(), Some(6379)),
        RT::Queue => match to.c.implementation.as_deref() {
            Some("sqs" | "service-bus") => ("https".into(), None),
            _ => (own_proto.or(proto).unwrap_or_else(|| "https".into()), own_port.or(port)),
        },
        RT::ObjectStorage => ("https".into(), None),
        RT::ContainerService => ("http".into(), to.c.props.get("port").and_then(Value::as_u64).map(|p| p as u16)),
        RT::Network | RT::ContainerRegistry | RT::Ingress | RT::Dns => return None,
    };
    let port = if protocol == "https" { None } else { port };
    let protocol = match protocol.as_str() {
        "tcp" | "http" | "https" | "postgres" | "redis" | "amqp" => protocol,
        _ => "tcp".to_string(),
    };
    Some((protocol, port))
}

fn connections(finals: &[Final], raw: Vec<RawLink>, warnings: &mut Vec<String>) -> Vec<Conn> {
    let by_id: BTreeMap<&str, &Final> = finals.iter().map(|f| (f.id.as_str(), f)).collect();
    // Implicit dependency edges, as the platform's graph builds them.
    let mut graph: BTreeMap<String, BTreeSet<String>> =
        finals.iter().map(|f| (f.id.clone(), BTreeSet::new())).collect();
    for f in finals {
        if f.c.kind.is_networked() {
            for n in finals.iter().filter(|n| n.c.kind == RT::Network && n.placement == f.placement) {
                graph.get_mut(&f.id).map(|s| s.insert(n.id.clone()));
            }
        }
        if f.c.kind == RT::ContainerService {
            for r in finals.iter().filter(|r| r.c.kind == RT::ContainerRegistry) {
                graph.get_mut(&f.id).map(|s| s.insert(r.id.clone()));
            }
        }
        if f.c.kind == RT::Ingress {
            for (s, _) in &f.routes {
                graph.get_mut(s).map(|set| set.insert(f.id.clone()));
            }
        }
        if let Some(t) = &f.dns_target {
            graph.get_mut(&f.id).map(|s| s.insert(t.clone()));
        }
    }
    let reachable = |graph: &BTreeMap<String, BTreeSet<String>>, from: &str, to: &str| -> bool {
        let mut stack = vec![from.to_string()];
        let mut seen = BTreeSet::new();
        while let Some(n) = stack.pop() {
            if n == to {
                return true;
            }
            if seen.insert(n.clone()) {
                stack.extend(graph.get(&n).into_iter().flatten().cloned());
            }
        }
        false
    };

    let mut sorted = raw;
    sorted.sort();
    let mut out: Vec<Conn> = Vec::new();
    for (from, to, proto, port, evidence) in sorted {
        if from == to {
            continue;
        }
        let (Some(f), Some(t)) = (by_id.get(from.as_str()), by_id.get(to.as_str())) else { continue };
        if !matches!(f.c.kind, RT::ContainerService) {
            continue;
        }
        if out.iter().any(|c| c.from == from && c.to == to) {
            continue;
        }
        let Some((protocol, port)) = endpoint_of(t, proto, port) else { continue };
        if reachable(&graph, &to, &from) {
            warnings.push(format!("connection {from} → {to} skipped: it would create a dependency cycle"));
            continue;
        }
        graph.entry(from.clone()).or_default().insert(to.clone());
        let mode = if f.placement != t.placement {
            if protocol == "https" { "secure" } else { "private-preferred" }
        } else {
            match protocol.as_str() {
                "postgres" | "redis" | "amqp" | "tcp" => "private-required",
                "https" => "secure",
                _ => "private-preferred",
            }
        };
        out.push(Conn { from, to, protocol, port, mode, evidence });
    }
    out.sort_by(|a, b| a.from.cmp(&b.from).then(a.to.cmp(&b.to)));
    out
}
