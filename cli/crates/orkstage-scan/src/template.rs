//! Renders the platform/v1 EnvironmentTemplate and validates it structurally (the same rules
//! as `packages/templates` stages 1–2: ids, ranges, references, dependency cycles).

use std::collections::{BTreeMap, BTreeSet};
use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Map, Value, json};

use crate::merge::{Final, Merged};
use crate::model::{ResourceType as RT, SourceKind};

pub(crate) struct Rendered {
    pub yaml: String,
    pub document: Value,
    pub issues: Vec<String>,
}

pub(crate) struct Meta<'a> {
    pub name: &'a str,
    pub display_name: &'a str,
    pub version: &'a str,
    pub kinds: &'a [(SourceKind, u32)],
}

fn num_prop(f: &Final, k: &str) -> Option<f64> {
    f.c.props.get(k).and_then(Value::as_f64)
}

fn int_prop(f: &Final, k: &str) -> Option<i64> {
    f.c.props.get(k).and_then(|v| v.as_i64().or_else(|| v.as_f64().map(|x| x.round() as i64)))
}

fn bool_prop(f: &Final, k: &str) -> Option<bool> {
    f.c.props.get(k).and_then(Value::as_bool)
}

fn str_prop<'a>(f: &'a Final, k: &str) -> Option<&'a str> {
    f.c.props.get(k).and_then(Value::as_str)
}

fn resource_doc(f: &Final) -> Value {
    let mut m = Map::new();
    m.insert("id".into(), f.id.clone().into());
    m.insert("type".into(), f.c.kind.as_str().into());
    if f.placement != "primary" {
        m.insert("placement".into(), f.placement.clone().into());
    }
    if let Some(i) = &f.c.implementation {
        m.insert("implementation".into(), i.clone().into());
    }
    let mut put = |k: &str, v: Value| {
        m.insert(k.to_string(), v);
    };
    match f.c.kind {
        RT::Network => {
            put("availabilityZones", json!(int_prop(f, "availabilityZones").unwrap_or(1).clamp(1, 3)));
            if bool_prop(f, "natGateway") == Some(true) {
                put("natGateway", json!(true));
            }
        }
        RT::ContainerService => {
            put("image", json!(format!("catalog://{}", f.id)));
            put("replicas", json!(int_prop(f, "replicas").unwrap_or(1).clamp(0, 100)));
            put("cpu", json!(num_prop(f, "cpu").map(crate::sizing::clamp_cpu).unwrap_or(0.25)));
            put("memoryMiB", json!(int_prop(f, "memoryMiB").unwrap_or(512).clamp(128, 122_880)));
            let port = int_prop(f, "port").map(|p| p.clamp(1, 65535));
            if let Some(p) = port {
                put("port", json!(p));
            }
            let public = bool_prop(f, "public").unwrap_or(false) && port.is_some();
            if public {
                put("public", json!(true));
            }
            if let Some(h) = str_prop(f, "healthCheckPath").filter(|h| h.starts_with('/')) {
                put("healthCheckPath", json!(h));
            }
            if let Some(a) = f.c.props.get("autoscaling").and_then(Value::as_object) {
                let min = a.get("minReplicas").and_then(Value::as_i64).unwrap_or(1).max(0);
                let max = a.get("maxReplicas").and_then(Value::as_i64).unwrap_or(min.max(1)).max(min).max(1);
                let cpu = a.get("targetCpuPercent").and_then(Value::as_i64).unwrap_or(70).clamp(10, 95);
                put("autoscaling", json!({ "minReplicas": min, "maxReplicas": max, "targetCpuPercent": cpu }));
            }
            // Workers (no port, not public) are not critical, like the built-in templates.
            if port.is_none() {
                put("critical", json!(false));
            }
        }
        RT::ContainerRegistry => {
            put("scanOnPush", json!(bool_prop(f, "scanOnPush").unwrap_or(true)));
            put("immutableTags", json!(bool_prop(f, "immutableTags").unwrap_or(true)));
        }
        RT::Postgres => {
            put("version", json!(str_prop(f, "version").unwrap_or("17")));
            put("size", json!(str_prop(f, "size").unwrap_or("small")));
            put("storageGiB", json!(int_prop(f, "storageGiB").unwrap_or(20).clamp(1, 16384)));
            let ha = str_prop(f, "highAvailability").unwrap_or("none");
            if ha != "none" {
                put("highAvailability", json!(ha));
            }
            if bool_prop(f, "publicAccess") == Some(true) {
                put("publicAccess", json!(true));
            }
            let backup = f.c.props.get("backup");
            let enabled = backup.and_then(|b| b.get("enabled")).and_then(Value::as_bool).unwrap_or(true);
            let days = backup.and_then(|b| b.get("retentionDays")).and_then(Value::as_i64).unwrap_or(7).clamp(0, 35);
            put("backup", json!({ "enabled": enabled, "retentionDays": days }));
        }
        RT::Redis => {
            put("size", json!(crate::sizing::cache_size(str_prop(f, "size").unwrap_or("micro"))));
            let replicas = int_prop(f, "replicas").unwrap_or(0).clamp(0, 5);
            if replicas > 0 {
                put("replicas", json!(replicas));
            }
        }
        RT::Queue => {
            if bool_prop(f, "fifo") == Some(true) {
                put("fifo", json!(true));
            }
            put("deadLetter", json!(bool_prop(f, "deadLetter").unwrap_or(true)));
        }
        RT::ObjectStorage => {
            put("tier", json!(str_prop(f, "tier").unwrap_or("standard")));
            put("versioning", json!(bool_prop(f, "versioning").unwrap_or(false)));
            if bool_prop(f, "publicAccess") == Some(true) {
                put("publicAccess", json!(true));
            }
            if let Some(d) = int_prop(f, "retentionDays") {
                put("retentionDays", json!(d.max(0)));
            }
        }
        RT::Ingress => {
            put(
                "routes",
                Value::Array(
                    f.routes
                        .iter()
                        .map(
                            |(s, p)| {
                                if p == "/" {
                                    json!({ "service": s })
                                } else {
                                    json!({ "service": s, "pathPrefix": p })
                                }
                            },
                        )
                        .collect(),
                ),
            );
            put("tls", json!(bool_prop(f, "tls").unwrap_or(true)));
        }
        RT::Dns => {
            put("target", json!(f.dns_target.clone().unwrap_or_default()));
            put("customDomain", json!(str_prop(f, "customDomain").unwrap_or("disabled")));
        }
    }
    Value::Object(m)
}

fn comment_for(f: &Final) -> String {
    if f.inferred {
        return "inferred (no declaration found); review".to_string();
    }
    let mut parts: Vec<String> =
        f.c.sources
            .iter()
            .take(3)
            .map(|s| match s.line {
                Some(l) => format!("{} {} ({}:{l})", s.kind.as_str(), s.address, s.file),
                None => format!("{} {} ({})", s.kind.as_str(), s.address, s.file),
            })
            .collect();
    if f.c.sources.len() > 3 {
        parts.push(format!("+{} more", f.c.sources.len() - 3));
    }
    let mut c = format!("from {}", parts.join("; "));
    if let Some(img) = f.c.props.get("sourceImage").and_then(Value::as_str) {
        c.push_str(&format!(" | image {img}: publish it to the catalog as {}", f.id));
    }
    c
}

pub(crate) fn render(m: &Merged, meta: &Meta<'_>) -> Rendered {
    let docs: Vec<Value> = m.resources.iter().map(resource_doc).collect();
    let multi_cloud = m.placements.iter().filter(|p| !p.providers.is_empty()).count() > 1;
    let (profile, plans) = choose_plan(&docs, multi_cloud);
    let sources: Vec<String> = meta.kinds.iter().map(|(k, n)| format!("{} ({n})", k.as_str())).collect();
    let description = if sources.is_empty() {
        "Imported by orkstage-scan.".to_string()
    } else {
        format!("Imported by orkstage-scan from {}.", sources.join(", "))
    };

    let placements: Vec<Value> = m
        .placements
        .iter()
        .filter(|p| p.name == "primary" || m.resources.iter().any(|r| r.placement == p.name))
        .map(|p| {
            let mut o = Map::new();
            o.insert("name".into(), p.name.clone().into());
            o.insert("description".into(), p.description.clone().into());
            if !p.providers.is_empty() {
                o.insert("providers".into(), Value::Array(p.providers.iter().map(|x| x.as_str().into()).collect()));
            }
            Value::Object(o)
        })
        .collect();

    let mut variables = Vec::new();
    if let Some(api) = m.resources.iter().find(|f| {
        f.c.kind == RT::ContainerService
            && bool_prop(f, "public") == Some(true)
            && f.c.props.get("autoscaling").is_none()
    }) {
        let replicas = int_prop(api, "replicas").unwrap_or(1).clamp(1, 100);
        variables.push(json!({
            "name": var_name(&api.id, "Replicas"),
            "type": "number",
            "default": replicas,
            "min": 1,
            "max": (replicas * 2).clamp(2, 100),
            "target": format!("{}.replicas", api.id),
        }));
    }
    if let Some(db) = m.resources.iter().find(|f| f.c.kind == RT::Postgres) {
        let size = str_prop(db, "size").unwrap_or("small");
        variables.push(json!({
            "name": var_name(&db.id, "Size"),
            "type": "string",
            "default": size,
            "allowed": ["micro", "small", "medium", "large", "xlarge"],
            "target": format!("{}.size", db.id),
        }));
    }

    let resources = docs;
    let connectivity: Vec<Value> = m
        .connections
        .iter()
        .map(|c| {
            let mut o = Map::new();
            o.insert("from".into(), c.from.clone().into());
            o.insert("to".into(), c.to.clone().into());
            o.insert("protocol".into(), c.protocol.clone().into());
            if let Some(p) = c.port {
                o.insert("port".into(), p.into());
            }
            o.insert("mode".into(), c.mode.into());
            Value::Object(o)
        })
        .collect();

    let mut spec = Map::new();
    spec.insert("plans".into(), plans);
    spec.insert("placements".into(), Value::Array(placements));
    if !variables.is_empty() {
        spec.insert("variables".into(), Value::Array(variables));
    }
    spec.insert("resources".into(), Value::Array(resources));
    if !connectivity.is_empty() {
        spec.insert("connectivity".into(), Value::Array(connectivity));
    }
    spec.insert(
        "observability".into(),
        json!({ "logs": true, "metrics": true, "traces": false, "uptime": true, "alerts": true }),
    );
    let document = json!({
        "apiVersion": "platform/v1",
        "kind": "EnvironmentTemplate",
        "metadata": {
            "name": meta.name,
            "version": meta.version,
            "displayName": meta.display_name,
            "description": description,
            "profile": profile,
        },
        "spec": Value::Object(spec),
    });

    let comments: Vec<String> = m.resources.iter().map(comment_for).collect();
    let mut yaml = String::new();
    yaml.push_str(&format!("# Generated by {}. Review before publishing:\n", crate::GENERATOR));
    yaml.push_str(
        "# images are catalog references named after each service; sizes not found in the sources use defaults.\n",
    );
    let mut e = Emitter { out: &mut yaml, comments: &comments };
    e.map(document.as_object().expect("object"), 0, "");
    let issues = validate(&document);
    Rendered { yaml, document, issues }
}

/// Default plan limits, mirroring `DEFAULT_ENTITLEMENTS` in `packages/domain/src/plans.ts`.
struct PlanLimits {
    code: &'static str,
    services: f64,
    cpu: f64,
    memory_mib: f64,
    database_gib: f64,
    replicas: f64,
    backup_days: f64,
    autoscaling: bool,
    multi_cloud: bool,
}

const PLANS: [PlanLimits; 3] = [
    PlanLimits {
        code: "STARTER",
        services: 8.0,
        cpu: 4.0,
        memory_mib: 8192.0,
        database_gib: 50.0,
        replicas: 2.0,
        backup_days: 7.0,
        autoscaling: false,
        multi_cloud: false,
    },
    PlanLimits {
        code: "GROWTH",
        services: 20.0,
        cpu: 16.0,
        memory_mib: 32768.0,
        database_gib: 250.0,
        replicas: 6.0,
        backup_days: 14.0,
        autoscaling: true,
        multi_cloud: true,
    },
    PlanLimits {
        code: "SCALE",
        services: 100.0,
        cpu: 256.0,
        memory_mib: 524_288.0,
        database_gib: 4000.0,
        replicas: 50.0,
        backup_days: 35.0,
        autoscaling: true,
        multi_cloud: true,
    },
];

/// The smallest plan whose default entitlements fit the template, plus the next one up.
fn choose_plan(resources: &[Value], multi_cloud: bool) -> (&'static str, Value) {
    let (mut services, mut cpu, mut mem, mut db, mut replicas, mut backup) = (0.0, 0.0, 0.0, 0.0, 0.0_f64, 0.0_f64);
    let mut autoscaling = false;
    for r in resources {
        match r["type"].as_str() {
            Some("compute.container-service") => {
                let n = r["autoscaling"]["maxReplicas"].as_f64().or(r["replicas"].as_f64()).unwrap_or(1.0);
                autoscaling |= r.get("autoscaling").is_some();
                services += 1.0;
                cpu += r["cpu"].as_f64().unwrap_or(0.25) * n;
                mem += r["memoryMiB"].as_f64().unwrap_or(512.0) * n;
                replicas = replicas.max(n);
            }
            Some("database.postgresql") => {
                db += r["storageGiB"].as_f64().unwrap_or(20.0);
                if r["backup"]["enabled"].as_bool().unwrap_or(true) {
                    backup = backup.max(r["backup"]["retentionDays"].as_f64().unwrap_or(7.0));
                }
            }
            _ => {}
        }
    }
    let fits = |p: &PlanLimits| {
        services <= p.services
            && cpu <= p.cpu
            && mem <= p.memory_mib
            && db <= p.database_gib
            && replicas <= p.replicas
            && backup <= p.backup_days
            && (!autoscaling || p.autoscaling)
            && (!multi_cloud || p.multi_cloud)
    };
    let idx = PLANS.iter().position(fits).unwrap_or(PLANS.len() - 1);
    let profile = match PLANS[idx].code {
        "STARTER" => "starter",
        "GROWTH" => "growth",
        _ => "scale",
    };
    let plans: Vec<&str> = PLANS[idx..].iter().take(2).map(|p| p.code).collect();
    (profile, json!(plans))
}

fn var_name(id: &str, suffix: &str) -> String {
    // `orders-api` → `ordersApiReplicas` (≤ 40 chars).
    let mut out = String::new();
    let mut upper = false;
    for ch in id.chars() {
        if ch == '-' {
            upper = true;
        } else if upper {
            out.push(ch.to_ascii_uppercase());
            upper = false;
        } else {
            out.push(ch);
        }
    }
    let max = 40 - suffix.len();
    out.truncate(max);
    out + suffix
}

// ── YAML emitter ─────────────────────────────────────────────────────────────

struct Emitter<'a> {
    out: &'a mut String,
    comments: &'a [String],
}

impl Emitter<'_> {
    fn pad(&mut self, indent: usize) {
        for _ in 0..indent {
            self.out.push(' ');
        }
    }

    fn map(&mut self, m: &Map<String, Value>, indent: usize, parent: &str) {
        let mut first = true;
        for (k, v) in m {
            // The first key of a list item continues the "- " line.
            if !(first && parent == "-") {
                self.pad(indent);
            }
            first = false;
            self.out.push_str(&scalar_str(k, false));
            self.out.push(':');
            self.value(v, indent, k);
        }
    }

    fn value(&mut self, v: &Value, indent: usize, key: &str) {
        match v {
            Value::Object(m) if m.is_empty() => self.out.push_str(" {}\n"),
            Value::Object(m) if key == "observability" || key == "backup" || key == "autoscaling" => {
                self.out.push(' ');
                self.flow(v);
                self.out.push('\n');
                let _ = m;
            }
            Value::Object(m) => {
                self.out.push('\n');
                self.map(m, indent + 2, key);
            }
            Value::Array(a) if a.is_empty() => self.out.push_str(" []\n"),
            Value::Array(a) if a.iter().all(|x| !x.is_object() && !x.is_array()) => {
                self.out.push(' ');
                self.flow(v);
                self.out.push('\n');
            }
            Value::Array(a) => {
                self.out.push('\n');
                for (i, item) in a.iter().enumerate() {
                    if key == "resources"
                        && let Some(c) = self.comments.get(i)
                    {
                        self.pad(indent + 2);
                        self.out.push_str("# ");
                        self.out.push_str(&c.replace('\n', " "));
                        self.out.push('\n');
                    }
                    self.pad(indent + 2);
                    self.out.push_str("- ");
                    match item {
                        Value::Object(m) if key == "connectivity" || key == "routes" => {
                            self.flow(&Value::Object(m.clone()));
                            self.out.push('\n');
                        }
                        Value::Object(m) => self.map(m, indent + 4, "-"),
                        other => {
                            self.flow(other);
                            self.out.push('\n');
                        }
                    }
                }
            }
            other => {
                self.out.push(' ');
                self.out.push_str(&scalar(other, false));
                self.out.push('\n');
            }
        }
    }

    fn flow(&mut self, v: &Value) {
        match v {
            Value::Object(m) => {
                self.out.push_str("{ ");
                for (i, (k, x)) in m.iter().enumerate() {
                    if i > 0 {
                        self.out.push_str(", ");
                    }
                    self.out.push_str(&scalar_str(k, true));
                    self.out.push_str(": ");
                    self.flow(x);
                }
                self.out.push_str(" }");
            }
            Value::Array(a) => {
                self.out.push('[');
                for (i, x) in a.iter().enumerate() {
                    if i > 0 {
                        self.out.push_str(", ");
                    }
                    self.flow(x);
                }
                self.out.push(']');
            }
            other => self.out.push_str(&scalar(other, true)),
        }
    }
}

fn scalar(v: &Value, flow: bool) -> String {
    match v {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        Value::String(s) => scalar_str(s, flow),
        other => other.to_string(),
    }
}

static PLAIN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_/.][A-Za-z0-9_/. :()+=-]*$").unwrap());

/// Plain scalar when unambiguous, else a JSON string (a valid YAML double-quoted scalar).
fn scalar_str(s: &str, flow: bool) -> String {
    let lower = s.to_ascii_lowercase();
    let reserved =
        matches!(lower.as_str(), "true" | "false" | "null" | "yes" | "no" | "on" | "off" | "y" | "n" | "~" | "")
            || s.parse::<f64>().is_ok()
            || lower.starts_with("0x")
            || lower.starts_with("0o")
            || lower.starts_with(".inf")
            || lower.starts_with(".nan")
            || lower.starts_with("-.inf");
    let ambiguous =
        s.contains(": ") || s.contains(" #") || s.ends_with(':') || s.ends_with(' ') || (flow && s.contains(','));
    if !reserved && !ambiguous && PLAIN.is_match(s) {
        s.to_string()
    } else {
        serde_json::to_string(s).unwrap_or_default()
    }
}

// ── structural validation ────────────────────────────────────────────────────

static ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-z][a-zA-Z0-9-]{0,39}$").unwrap());
static NAME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-z][a-z0-9-]{1,62}$").unwrap());
static SEMVER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\d+\.\d+\.\d+$").unwrap());
static TARGET: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-z][a-zA-Z0-9-]*\.[a-zA-Z][a-zA-Z0-9]*$").unwrap());

/// Stages 1–2 of the platform validator, on the generated document. Returns error messages.
pub(crate) fn validate(doc: &Value) -> Vec<String> {
    let mut issues = Vec::new();
    let mut err = |m: String| issues.push(m);
    let meta = &doc["metadata"];
    if !meta["name"].as_str().is_some_and(|n| NAME.is_match(n)) {
        err(format!("metadata.name {:?} must match ^[a-z][a-z0-9-]{{1,62}}$", meta["name"]));
    }
    if !meta["version"].as_str().is_some_and(|v| SEMVER.is_match(v)) {
        err("metadata.version must be a semantic version like 1.2.0".into());
    }
    if !meta["displayName"].as_str().is_some_and(|d| !d.is_empty()) {
        err("metadata.displayName is required".into());
    }
    let spec = &doc["spec"];
    let slots: BTreeSet<&str> =
        spec["placements"].as_array().into_iter().flatten().filter_map(|p| p["name"].as_str()).collect();
    if slots.is_empty() {
        err("spec.placements must not be empty".into());
    }
    let resources = spec["resources"].as_array().cloned().unwrap_or_default();
    if resources.is_empty() {
        err("spec.resources must not be empty (nothing deployable was detected)".into());
    }
    let mut by_id: BTreeMap<String, &Value> = BTreeMap::new();
    for r in &resources {
        let id = r["id"].as_str().unwrap_or("");
        if !ID.is_match(id) {
            err(format!("resource id {id:?} is invalid"));
        }
        if by_id.insert(id.to_string(), r).is_some() {
            err(format!("resource id {id:?} is used more than once"));
        }
        let placement = r["placement"].as_str().unwrap_or("primary");
        if !slots.contains(placement) {
            err(format!("resource {id:?} uses unknown placement {placement:?}"));
        }
    }
    for r in &resources {
        let id = r["id"].as_str().unwrap_or("");
        match r["type"].as_str() {
            Some("ingress") => {
                let routes = r["routes"].as_array().cloned().unwrap_or_default();
                if routes.is_empty() {
                    err(format!("ingress {id:?} needs at least one route"));
                }
                for route in routes {
                    let s = route["service"].as_str().unwrap_or("");
                    match by_id.get(s) {
                        Some(t) if t["type"] == "compute.container-service" => {
                            if t["port"].is_null() {
                                err(format!("service {s:?} is routed by {id:?} but declares no port"));
                            }
                        }
                        _ => err(format!("ingress {id:?} routes to {s:?}, which is not a container service")),
                    }
                }
            }
            Some("dns") => {
                let t = r["target"].as_str().unwrap_or("");
                if by_id.get(t).map(|x| x["type"].as_str()) != Some(Some("ingress")) {
                    err(format!("dns {id:?} must target an ingress"));
                }
            }
            Some("compute.container-service") => {
                let cpu = r["cpu"].as_f64().unwrap_or(0.25);
                if !(cpu > 0.0 && cpu <= 16.0) {
                    err(format!("{id}: cpu must be in (0, 16]"));
                }
                let mem = r["memoryMiB"].as_i64().unwrap_or(512);
                if !(128..=122_880).contains(&mem) {
                    err(format!("{id}: memoryMiB must be in [128, 122880]"));
                }
            }
            _ => {}
        }
    }
    for c in spec["connectivity"].as_array().into_iter().flatten() {
        let (f, t) = (c["from"].as_str().unwrap_or(""), c["to"].as_str().unwrap_or(""));
        if !by_id.contains_key(f) || !by_id.contains_key(t) {
            err(format!("connectivity {f} → {t} references an unknown resource"));
        }
    }
    for v in spec["variables"].as_array().into_iter().flatten() {
        let target = v["target"].as_str().unwrap_or("");
        if !TARGET.is_match(target) {
            err(format!("variable target {target:?} is invalid"));
        }
        let rid = target.split('.').next().unwrap_or("");
        if !by_id.contains_key(rid) {
            err(format!("variable {:?} targets unknown resource {rid:?}", v["name"]));
        }
        if !v["name"].as_str().is_some_and(|n| ID.is_match(n)) {
            err(format!("variable name {:?} is invalid", v["name"]));
        }
    }
    if issues.is_empty()
        && let Some(cycle) =
            find_cycle(&resources, spec["connectivity"].as_array().map(|a| a.as_slice()).unwrap_or(&[]))
    {
        issues.push(format!("dependency cycle: {}", cycle.join(" → ")));
    }
    issues
}

/// Dependency graph as built by the platform (`packages/templates/src/graph.ts`).
fn find_cycle(resources: &[Value], connectivity: &[Value]) -> Option<Vec<String>> {
    let mut g: BTreeMap<String, BTreeSet<String>> =
        resources.iter().filter_map(|r| r["id"].as_str()).map(|id| (id.to_string(), BTreeSet::new())).collect();
    let add = |g: &mut BTreeMap<String, BTreeSet<String>>, from: &str, to: &str| {
        if from != to
            && g.contains_key(to)
            && let Some(s) = g.get_mut(from)
        {
            s.insert(to.to_string());
        }
    };
    for c in connectivity {
        add(&mut g, c["from"].as_str().unwrap_or(""), c["to"].as_str().unwrap_or(""));
    }
    let placement = |r: &Value| r["placement"].as_str().unwrap_or("primary").to_string();
    for r in resources {
        let id = r["id"].as_str().unwrap_or("");
        let t = r["type"].as_str().unwrap_or("");
        if matches!(t, "compute.container-service" | "database.postgresql" | "cache.redis" | "ingress") {
            for n in resources.iter().filter(|n| n["type"] == "network" && placement(n) == placement(r)) {
                add(&mut g, id, n["id"].as_str().unwrap_or(""));
            }
        }
        if t == "compute.container-service" {
            for reg in resources.iter().filter(|n| n["type"] == "container-registry") {
                add(&mut g, id, reg["id"].as_str().unwrap_or(""));
            }
        }
        if t == "ingress" {
            for route in r["routes"].as_array().into_iter().flatten() {
                add(&mut g, route["service"].as_str().unwrap_or(""), id);
            }
        }
        if t == "dns" {
            add(&mut g, id, r["target"].as_str().unwrap_or(""));
        }
    }
    // Kahn's algorithm; leftovers are on a cycle.
    let mut remaining = g.clone();
    loop {
        let ready: Vec<String> = remaining.iter().filter(|(_, d)| d.is_empty()).map(|(k, _)| k.clone()).collect();
        if ready.is_empty() {
            break;
        }
        for r in &ready {
            remaining.remove(r);
        }
        for deps in remaining.values_mut() {
            for r in &ready {
                deps.remove(r);
            }
        }
    }
    (!remaining.is_empty()).then(|| remaining.keys().cloned().collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scalars() {
        assert_eq!(scalar_str("catalog://api", false), "catalog://api");
        assert_eq!(scalar_str("17", false), "\"17\"");
        assert_eq!(scalar_str("yes", false), "\"yes\"");
        assert_eq!(scalar_str("a: b", false), "\"a: b\"");
        assert_eq!(scalar_str("/health", false), "/health");
        assert_eq!(scalar_str("1.0.0", false), "1.0.0");
        assert_eq!(var_name("orders-api", "Replicas"), "ordersApiReplicas");
    }

    #[test]
    fn emitted_yaml_round_trips() {
        let doc = json!({
            "a": { "b": [ { "id": "x", "n": 1, "f": 0.5, "s": "17", "t": true, "l": ["A", "B"] } ] },
            "connectivity": [ { "from": "a", "to": "b", "port": 1 } ],
            "observability": { "logs": true },
            "desc": "Imported by x from terraform (1), compose (2).",
        });
        let mut out = String::new();
        Emitter { out: &mut out, comments: &[] }.map(doc.as_object().unwrap(), 0, "");
        let parsed = crate::yaml::load_all(&out).unwrap();
        assert_eq!(parsed[0].value, doc, "\n{out}");
    }
}
