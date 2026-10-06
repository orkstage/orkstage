//! Docker Compose files: backing services by image, application services by build/ports,
//! connections from `depends_on` and from environment values that mention other services.

use std::collections::BTreeMap;

use serde_json::Value;

use super::images::{self, ImageKind};
use super::kubernetes::hosts_in;
use crate::evidence::{Candidate, Endpoint, Findings, src};
use crate::model::{Confidence, ResourceType as RT, SourceKind};
use crate::sizing;
use crate::util::{self, get, int_of, path, str_of};
use crate::yaml::YamlDoc;

pub(crate) fn detect(file: &str, doc: &YamlDoc, out: &mut Findings) {
    out.count(SourceKind::Compose, file);
    let Some(services) = get(&doc.value, "services").and_then(Value::as_object) else { return };
    let dir = util::dir_of(file);
    let key = |name: &str| format!("compose:{file}:{name}");
    let mut mapped: BTreeMap<&str, bool> = BTreeMap::new();

    for (name, svc) in services {
        let line = doc.line(&["services", name]);
        let source = src(SourceKind::Compose, file, line, format!("services.{name}"));
        let image = str_of(get(svc, "image")).unwrap_or("");
        let build_dir = match get(svc, "build") {
            Some(Value::String(ctx)) => Some(util::join(dir, ctx)),
            Some(b @ Value::Object(_)) => Some(util::join(dir, str_of(get(b, "context")).unwrap_or("."))),
            _ => None,
        };
        let env = environment(svc);
        // LocalStack/MiniStack: the emulated services are configured with SERVICES.
        let kind = if build_dir.is_some() { ImageKind::App } else { images::classify(image) };
        match kind {
            ImageKind::Backing { kind: rt, protocol, port } => {
                let mut c = Candidate::new(rt, None, name.clone(), source, Confidence::Medium, key(name));
                c.set("_protocol", protocol);
                c.set("_port", port);
                if rt == RT::Postgres {
                    c.set_opt("version", images::pg_version(image));
                }
                out.candidates.push(c);
                mapped.insert(name, true);
            }
            ImageKind::AwsEmulator => {
                let services = env.iter().find(|(k, _)| k == "SERVICES").map(|(_, v)| v.to_ascii_lowercase());
                match services {
                    Some(list) => {
                        for (svc_name, rt) in [("s3", RT::ObjectStorage), ("sqs", RT::Queue)] {
                            if list.split(',').any(|s| s.trim() == svc_name) {
                                let c = Candidate::new(
                                    rt,
                                    None,
                                    format!("{name}-{svc_name}"),
                                    source.clone(),
                                    Confidence::Low,
                                    format!("{}#{svc_name}", key(name)),
                                )
                                .implementation(svc_name);
                                out.candidates.push(c);
                            }
                        }
                        mapped.insert(name, true);
                    }
                    None => out.unmapped(
                        source,
                        "compose-service",
                        format!(
                            "{image}: AWS emulator without SERVICES; the AWS services the app uses cannot be inferred"
                        ),
                    ),
                }
            }
            ImageKind::DevTool => out.unmapped(
                source,
                "compose-service",
                format!("{image}: local development tool, not part of the environment"),
            ),
            ImageKind::Unsupported(reason) => out.unmapped(source, "compose-service", format!("{image}: {reason}")),
            ImageKind::App => {
                if str_of(get(svc, "restart")) == Some("no") && published_port(svc).is_none() {
                    out.unmapped(
                        source,
                        "compose-service",
                        "one-off job (restart: \"no\"); jobs are not supported yet",
                    );
                    continue;
                }
                let mut c =
                    Candidate::new(RT::ContainerService, None, name.clone(), source, Confidence::Medium, key(name));
                if !image.is_empty() {
                    c.set("sourceImage", image);
                }
                c.build_dir = build_dir;
                if let Some(port) = published_port(svc) {
                    c.set("port", port);
                    c.set("public", true);
                } else if let Some(port) =
                    get(svc, "expose").and_then(Value::as_array).and_then(|a| a.first()).and_then(|p| int_of(Some(p)))
                {
                    c.set("port", port.clamp(1, 65535));
                }
                if let Some(port) = env.iter().find(|(k, _)| k == "PORT").and_then(|(_, v)| v.parse::<i64>().ok())
                    && !c.props.contains_key("port")
                {
                    c.set("port", port.clamp(1, 65535));
                }
                c.set_opt("replicas", int_of(path(svc, &["deploy", "replicas"])).map(|r| r.clamp(0, 100)));
                let limits = path(svc, &["deploy", "resources", "limits"]);
                c.set_opt(
                    "cpu",
                    limits
                        .and_then(|l| get(l, "cpus"))
                        .and_then(|v| crate::util::num_of(Some(v)))
                        .map(sizing::clamp_cpu),
                );
                c.set_opt(
                    "memoryMiB",
                    limits
                        .and_then(|l| str_of(get(l, "memory")))
                        .and_then(sizing::memory_mib)
                        .map(sizing::clamp_memory),
                );
                c.set_opt("healthCheckPath", healthcheck_path(get(svc, "healthcheck")));
                out.candidates.push(c);
                mapped.insert(name, true);
            }
        }
    }

    // depends_on and environment references.
    for (name, svc) in services {
        if !mapped.contains_key(name.as_str()) {
            continue;
        }
        let deps: Vec<String> = match get(svc, "depends_on") {
            Some(Value::Array(a)) => a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect(),
            Some(Value::Object(m)) => m.keys().cloned().collect(),
            _ => Vec::new(),
        };
        for d in deps {
            if mapped.contains_key(d.as_str()) {
                out.link(
                    Endpoint::Key(key(name)),
                    Endpoint::Key(key(&d)),
                    None,
                    None,
                    format!("{file}: {name} depends_on {d}"),
                );
            }
        }
        for (var, value) in environment(svc) {
            for host in hosts_in(&value) {
                if host != *name && mapped.contains_key(host.as_str()) {
                    out.link(
                        Endpoint::Key(key(name)),
                        Endpoint::Key(key(&host)),
                        None,
                        None,
                        format!("{file}: {name} env {var} mentions {host}"),
                    );
                }
            }
        }
    }
}

fn environment(svc: &Value) -> Vec<(String, String)> {
    match get(svc, "environment") {
        Some(Value::Object(m)) => m
            .iter()
            .map(|(k, v)| {
                let s = match v {
                    Value::String(s) => s.clone(),
                    Value::Null => String::new(),
                    other => other.to_string(),
                };
                (k.clone(), s)
            })
            .collect(),
        Some(Value::Array(a)) => a
            .iter()
            .filter_map(Value::as_str)
            .map(|e| {
                let (k, v) = e.split_once('=').unwrap_or((e, ""));
                (k.to_string(), v.to_string())
            })
            .collect(),
        _ => Vec::new(),
    }
}

/// Container port of the first published mapping (`"8080:3000"` → 3000).
fn published_port(svc: &Value) -> Option<i64> {
    let first = get(svc, "ports")?.as_array()?.first()?;
    let port = match first {
        Value::Number(n) => n.as_i64(),
        Value::String(s) => {
            let s = s.split('/').next().unwrap_or(s);
            s.rsplit(':').next().and_then(|p| p.split('-').next()).and_then(|p| p.parse().ok())
        }
        Value::Object(_) => int_of(get(first, "target")),
        _ => None,
    }?;
    Some(port.clamp(1, 65535))
}

/// `curl -f http://localhost:8080/health` → `/health`.
pub(crate) fn healthcheck_path(hc: Option<&Value>) -> Option<String> {
    let text = match get(hc?, "test")? {
        Value::Array(a) => a.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(" "),
        Value::String(s) => s.clone(),
        _ => return None,
    };
    http_path(&text)
}

pub(crate) fn http_path(text: &str) -> Option<String> {
    let idx = text.find("http://").or_else(|| text.find("https://"))?;
    let rest = &text[idx..];
    let after_scheme = &rest[rest.find("//")? + 2..];
    let slash = after_scheme.find('/')?;
    let p: String = after_scheme[slash..]
        .chars()
        .take_while(|c| !c.is_whitespace() && *c != '"' && *c != '\'' && *c != '|')
        .collect();
    (p.len() > 1).then_some(p)
}
