//! Kubernetes manifests and Helm charts (best effort for templated files).

use std::collections::{BTreeMap, BTreeSet};
use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Map, Value};

use super::images::{self, ImageKind};
use crate::evidence::{Candidate, Endpoint, Findings, src};
use crate::model::{Confidence, ResourceType as RT, SourceKind};
use crate::sizing;
use crate::util::{get, int_of, path, str_of};
use crate::yaml::YamlDoc;

pub(crate) struct K8sFile<'a> {
    pub file: &'a str,
    pub kind: SourceKind,
    pub docs: Vec<YamlDoc>,
}

const WORKLOADS: &[&str] = &["Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "Pod", "DeploymentConfig"];

struct Workload {
    key: String,
    name: String,
    labels: Map<String, Value>,
    backing: bool,
    env_values: Vec<(String, String)>,
}

struct Svc {
    name: String,
    selector: Map<String, Value>,
    kind: String,
    port: Option<i64>,
    file: String,
    line: Option<u32>,
    source_kind: SourceKind,
}

pub(crate) fn detect(files: Vec<K8sFile<'_>>, out: &mut Findings) {
    let mut workloads: Vec<Workload> = Vec::new();
    let mut services: Vec<Svc> = Vec::new();
    let mut ingresses: Vec<(SourceKind, String, Option<u32>, Value)> = Vec::new();

    for f in &files {
        out.count(f.kind, f.file);
        for doc in &f.docs {
            let v = &doc.value;
            let Some(kind) = str_of(get(v, "kind")) else { continue };
            let name = str_of(path(v, &["metadata", "name"])).unwrap_or("unnamed").to_string();
            let line = doc.line(&["kind"]).or_else(|| doc.line(&["metadata"]));
            let address = format!("{kind}/{name}");
            let source = src(f.kind, f.file, line, address.clone());
            match kind {
                k if WORKLOADS.contains(&k) || k == "Job" || k == "CronJob" => {
                    let pod = match k {
                        "Pod" => Some(v),
                        "CronJob" => path(v, &["spec", "jobTemplate", "spec", "template"]),
                        _ => path(v, &["spec", "template"]),
                    };
                    let Some(pod) = pod else { continue };
                    let containers: Vec<&Value> = path(pod, &["spec", "containers"])
                        .and_then(Value::as_array)
                        .map(|a| a.iter().collect())
                        .unwrap_or_default();
                    let Some(main) =
                        containers.iter().find(|c| get(c, "ports").is_some()).or_else(|| containers.first()).copied()
                    else {
                        continue;
                    };
                    let image = str_of(get(main, "image")).unwrap_or("");
                    if k == "Job" || k == "CronJob" {
                        out.unmapped(source, k, "batch jobs are not supported yet");
                        continue;
                    }
                    let labels = path(pod, &["metadata", "labels"])
                        .or_else(|| path(v, &["spec", "selector", "matchLabels"]))
                        .and_then(Value::as_object)
                        .cloned()
                        .unwrap_or_default();
                    // Templated names (Helm `{{ include "x.fullname" . }}`) fall back to the app label.
                    let name = if name.contains("helm-value") {
                        ["app", "app.kubernetes.io/name", "name"]
                            .iter()
                            .find_map(|k| labels.get(*k).and_then(Value::as_str).filter(|v| !v.contains("helm-value")))
                            .map(str::to_string)
                            .unwrap_or_else(|| "app".to_string())
                    } else {
                        name
                    };
                    let address = format!("{kind}/{name}");
                    let source = src(f.kind, f.file, line, address.clone());
                    let key = format!("k8s:{address}");
                    let env_values = env_values(main);
                    let replicas = int_of(path(v, &["spec", "replicas"]));
                    let mut backing = false;
                    match images::classify(image) {
                        ImageKind::Backing { kind: rt, protocol, port } => {
                            backing = true;
                            let mut c = Candidate::new(rt, None, name.clone(), source, Confidence::Medium, key.clone());
                            c.set("_protocol", protocol);
                            c.set("_port", port);
                            if rt == RT::Postgres {
                                c.set_opt("version", images::pg_version(image));
                                let storage = path(v, &["spec", "volumeClaimTemplates"])
                                    .and_then(Value::as_array)
                                    .and_then(|a| a.first())
                                    .and_then(|t| str_of(path(t, &["spec", "resources", "requests", "storage"])))
                                    .and_then(sizing::memory_mib)
                                    .map(|mib| ((mib / 1024.0).ceil() as i64).clamp(1, 16384));
                                c.set_opt("storageGiB", storage);
                            }
                            if rt == RT::Redis {
                                c.set_opt("replicas", replicas.map(|r| (r - 1).clamp(0, 5)));
                            }
                            out.candidates.push(c);
                        }
                        ImageKind::DevTool => {
                            out.unmapped(
                                source,
                                k,
                                format!("{image}: local development tool, not part of the environment"),
                            );
                            continue;
                        }
                        ImageKind::Unsupported(reason) => {
                            out.unmapped(source, k, format!("{image}: {reason}"));
                            continue;
                        }
                        ImageKind::AwsEmulator => {
                            out.unmapped(source, k, "AWS emulator; map the emulated services explicitly");
                            continue;
                        }
                        ImageKind::App => {
                            let mut c = Candidate::new(
                                RT::ContainerService,
                                None,
                                name.clone(),
                                source,
                                Confidence::Medium,
                                key.clone(),
                            );
                            if !image.is_empty() && !image.contains("{{") && image != "helm-value" {
                                c.set("sourceImage", image);
                            }
                            c.set_opt("replicas", replicas.map(|r| r.clamp(0, 100)));
                            let res = get(main, "resources");
                            let cpu = res
                                .and_then(|r| {
                                    str_or_num(path(r, &["limits", "cpu"]))
                                        .or_else(|| str_or_num(path(r, &["requests", "cpu"])))
                                })
                                .and_then(|q| sizing::k8s_cpu(&q));
                            c.set_opt("cpu", cpu.map(sizing::clamp_cpu));
                            let mem = res
                                .and_then(|r| {
                                    str_or_num(path(r, &["limits", "memory"]))
                                        .or_else(|| str_or_num(path(r, &["requests", "memory"])))
                                })
                                .and_then(|q| sizing::memory_mib(&q));
                            c.set_opt("memoryMiB", mem.map(sizing::clamp_memory));
                            let port = get(main, "ports")
                                .and_then(Value::as_array)
                                .and_then(|a| a.first())
                                .and_then(|p| int_of(get(p, "containerPort")));
                            c.set_opt("port", port.map(|p| p.clamp(1, 65535)));
                            let health = ["readinessProbe", "livenessProbe", "startupProbe"]
                                .iter()
                                .find_map(|p| str_of(path(main, &[p, "httpGet", "path"])))
                                .filter(|p| p.starts_with('/'));
                            c.set_opt("healthCheckPath", health);
                            if let Some(hpa) = files.iter().flat_map(|f| f.docs.iter()).map(|d| &d.value).find(|d| {
                                str_of(get(d, "kind")) == Some("HorizontalPodAutoscaler")
                                    && str_of(path(d, &["spec", "scaleTargetRef", "name"])) == Some(name.as_str())
                            }) {
                                let min = int_of(path(hpa, &["spec", "minReplicas"])).unwrap_or(1);
                                let max = int_of(path(hpa, &["spec", "maxReplicas"])).unwrap_or(min.max(1));
                                let target = int_of(path(hpa, &["spec", "targetCPUUtilizationPercentage"]))
                                    .or_else(|| {
                                        path(hpa, &["spec", "metrics"]).and_then(Value::as_array).and_then(|m| {
                                            m.iter().find_map(|x| {
                                                int_of(path(x, &["resource", "target", "averageUtilization"]))
                                            })
                                        })
                                    })
                                    .unwrap_or(70);
                                c.set(
                                    "autoscaling",
                                    serde_json::json!({"minReplicas": min.max(0), "maxReplicas": max.max(1), "targetCpuPercent": target.clamp(10, 95)}),
                                );
                            }
                            out.candidates.push(c);
                        }
                    }
                    workloads.push(Workload { key, name, labels, backing, env_values });
                }
                "Service" => services.push(Svc {
                    name,
                    selector: path(v, &["spec", "selector"]).and_then(Value::as_object).cloned().unwrap_or_default(),
                    kind: str_of(path(v, &["spec", "type"])).unwrap_or("ClusterIP").to_string(),
                    port: path(v, &["spec", "ports"])
                        .and_then(Value::as_array)
                        .and_then(|a| a.first())
                        .and_then(|p| int_of(get(p, "port"))),
                    file: f.file.to_string(),
                    line,
                    source_kind: f.kind,
                }),
                "Ingress" | "HTTPRoute" | "Route" => ingresses.push((f.kind, f.file.to_string(), line, v.clone())),
                "ConfigMap"
                | "Secret"
                | "ServiceAccount"
                | "Role"
                | "RoleBinding"
                | "ClusterRole"
                | "ClusterRoleBinding"
                | "Namespace"
                | "PersistentVolumeClaim"
                | "PersistentVolume"
                | "HorizontalPodAutoscaler"
                | "PodDisruptionBudget"
                | "NetworkPolicy"
                | "ServiceMonitor"
                | "Certificate"
                | "Issuer"
                | "ClusterIssuer"
                | "Kustomization"
                | "LimitRange"
                | "ResourceQuota"
                | "StorageClass"
                | "PriorityClass" => {}
                other => out.unmapped(source, other, "no OrkStage mapping for this Kubernetes kind"),
            }
        }
    }

    let selected = |svc: &Svc| -> Vec<&Workload> {
        if svc.selector.is_empty() {
            return workloads.iter().filter(|w| w.name == svc.name).collect();
        }
        workloads.iter().filter(|w| svc.selector.iter().all(|(k, v)| w.labels.get(k) == Some(v))).collect()
    };

    // Service names designate their workloads (aliases), for links and routes.
    let mut aliases: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for s in &services {
        for w in selected(s) {
            aliases.entry(w.key.clone()).or_default().push(format!("k8s-svc:{}", s.name));
        }
    }
    for c in out.candidates.iter_mut() {
        if let Some(a) = aliases.get(&c.key) {
            c.aliases.extend(a.iter().cloned());
        }
    }

    let mut public: BTreeSet<String> = BTreeSet::new();
    for s in services.iter().filter(|s| s.kind == "LoadBalancer") {
        let targets: Vec<&Workload> = selected(s).into_iter().filter(|w| !w.backing).collect();
        if targets.is_empty() {
            continue;
        }
        let source = src(s.source_kind, &s.file, s.line, format!("Service/{}", s.name));
        let mut c = Candidate::new(
            RT::Ingress,
            None,
            s.name.clone(),
            source,
            Confidence::Medium,
            format!("k8s:Service/{}", s.name),
        );
        c.set("tls", s.port == Some(443));
        c.routes = targets.iter().map(|w| (w.key.clone(), "/".to_string())).collect();
        public.extend(targets.iter().map(|w| w.key.clone()));
        out.candidates.push(c);
    }
    for (kind, file, line, v) in &ingresses {
        let name = str_of(path(v, &["metadata", "name"])).unwrap_or("ingress").to_string();
        let source = src(*kind, file, *line, format!("Ingress/{name}"));
        let key = format!("k8s:Ingress/{name}");
        let mut routes = Vec::new();
        let mut hosts = Vec::new();
        for rule in path(v, &["spec", "rules"]).and_then(Value::as_array).into_iter().flatten() {
            if let Some(h) = str_of(get(rule, "host")) {
                hosts.push(h.to_string());
            }
            for p in path(rule, &["http", "paths"]).and_then(Value::as_array).into_iter().flatten() {
                let backend = str_of(path(p, &["backend", "service", "name"]))
                    .or_else(|| str_of(path(p, &["backend", "serviceName"])));
                let prefix =
                    str_of(get(p, "path")).map(|x| x.trim_end_matches('*').trim_end_matches('/')).unwrap_or("");
                let prefix = if prefix.starts_with('/') { prefix.to_string() } else { "/".to_string() };
                if let Some(svc) = backend.and_then(|b| services.iter().find(|s| s.name == b)) {
                    for w in selected(svc).into_iter().filter(|w| !w.backing) {
                        routes.push((w.key.clone(), prefix.clone()));
                    }
                }
            }
        }
        if let Some(b) = path(v, &["spec", "defaultBackend", "service", "name"]).and_then(Value::as_str)
            && let Some(svc) = services.iter().find(|s| s.name == b)
        {
            for w in selected(svc).into_iter().filter(|w| !w.backing) {
                routes.push((w.key.clone(), "/".into()));
            }
        }
        routes.sort();
        routes.dedup_by(|a, b| a.0 == b.0);
        public.extend(routes.iter().map(|r| r.0.clone()));
        let mut c = Candidate::new(RT::Ingress, None, name.clone(), source.clone(), Confidence::Medium, key.clone());
        c.set("tls", path(v, &["spec", "tls"]).and_then(Value::as_array).is_some_and(|a| !a.is_empty()));
        c.routes = routes;
        out.candidates.push(c);
        if !hosts.is_empty() {
            let mut d = Candidate::new(RT::Dns, None, "dns", source, Confidence::Medium, format!("{key}#dns"));
            d.set("customDomain", "optional");
            d.dns_target = Some(key);
            out.candidates.push(d);
        }
    }
    for c in out.candidates.iter_mut() {
        if public.contains(&c.key) {
            c.set("public", true);
        }
    }

    // Links: env values that mention another Service or workload by host name.
    let names: BTreeMap<String, String> = services
        .iter()
        .map(|s| (s.name.clone(), format!("k8s-svc:{}", s.name)))
        .chain(workloads.iter().map(|w| (w.name.clone(), w.key.clone())))
        .collect();
    for w in &workloads {
        for (var, value) in &w.env_values {
            for host in hosts_in(value) {
                if host == w.name {
                    continue;
                }
                if let Some(target) = names.get(&host) {
                    out.link(
                        Endpoint::Key(w.key.clone()),
                        Endpoint::Key(target.clone()),
                        None,
                        None,
                        format!("{} env {var} mentions {host}", w.name),
                    );
                }
            }
        }
    }
}

fn str_or_num(v: Option<&Value>) -> Option<String> {
    match v? {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

fn env_values(container: &Value) -> Vec<(String, String)> {
    get(container, "env")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|e| Some((str_of(get(e, "name"))?.to_string(), str_or_num(get(e, "value"))?)))
        .collect()
}

static HOST: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?:^|[/@=,\s])([a-z0-9][a-z0-9-]*)(?:[.:/,]|$)").unwrap());

/// Host-like tokens: `postgres://u:p@db:5432/x` → `db`; `redis` → `redis`; `http://api.ns.svc` → `api`.
pub(crate) fn hosts_in(value: &str) -> Vec<String> {
    let lower = value.to_ascii_lowercase();
    let mut out: Vec<String> = HOST.captures_iter(&lower).map(|c| c[1].to_string()).collect();
    out.sort();
    out.dedup();
    out
}

/// Makes a Helm template parseable: drops directive-only lines and replaces inline actions.
pub(crate) fn helm_sanitize(content: &str) -> String {
    static ACTION: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\{\{-?.*?-?\}\}").unwrap());
    content
        .lines()
        .filter(|l| {
            let t = l.trim();
            !(t.starts_with("{{") && t.ends_with("}}") && ACTION.find_iter(t).count() == 1)
        })
        .map(|l| ACTION.replace_all(l, "helm-value").into_owned())
        .collect::<Vec<_>>()
        .join("\n")
}

/// `Chart.yaml` dependencies such as `postgresql` or `redis` (Bitnami) are backing services.
pub(crate) fn chart(file: &str, docs: &[YamlDoc], out: &mut Findings) {
    out.count(SourceKind::Helm, file);
    let Some(doc) = docs.first() else { return };
    for dep in get(&doc.value, "dependencies").and_then(Value::as_array).into_iter().flatten() {
        let Some(name) = str_of(get(dep, "name")) else { continue };
        if let ImageKind::Backing { kind, .. } = images::classify(name) {
            let alias = str_of(get(dep, "alias")).unwrap_or(name);
            let source = src(SourceKind::Helm, file, doc.line(&["dependencies"]), format!("dependency/{name}"));
            out.candidates.push(Candidate::new(
                kind,
                None,
                alias,
                source,
                Confidence::Medium,
                format!("helm:{file}:{name}"),
            ));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hosts() {
        assert!(hosts_in("postgres://u:p@db:5432/app").contains(&"db".to_string()));
        assert!(hosts_in("redis://cache:6379").contains(&"cache".to_string()));
        assert!(hosts_in("http://api.prod.svc.cluster.local").contains(&"api".to_string()));
    }

    #[test]
    fn sanitize() {
        let s = helm_sanitize("{{- if .Values.x }}\nreplicas: {{ .Values.replicas }}\n{{- end }}\n");
        assert_eq!(s, "replicas: helm-value");
    }
}
