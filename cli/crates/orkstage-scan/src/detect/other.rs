//! Pulumi, Serverless Framework, Bicep and ARM: detected and partially mapped by type name.

use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Value, json};

use super::cloudformation::{self, CfnDoc};
use crate::evidence::{Candidate, Findings, src};
use crate::model::{Confidence, Provider, ResourceType as RT, SourceKind, SourceRef};
use crate::sizing;
use crate::util::{self, get, path, str_of};
use crate::yaml::YamlDoc;

/// Provider type token (Pulumi `aws:rds/instance:Instance`, Azure `Microsoft.Cache/redis`)
/// → logical type, provider, implementation. `None` type with a reason = known but unmapped.
fn classify_type(t: &str) -> Option<(Result<RT, &'static str>, Provider, Option<&'static str>)> {
    let l = t.to_ascii_lowercase();
    let (provider, rest) = if let Some(r) = l.strip_prefix("microsoft.") {
        (Provider::Azure, format!("microsoft.{r}"))
    } else if l.starts_with("aws") {
        (Provider::Aws, l.clone())
    } else if l.starts_with("azure") {
        (Provider::Azure, l.clone())
    } else if l.starts_with("gcp") || l.starts_with("google") {
        (Provider::Gcp, l.clone())
    } else if l.starts_with("oci") {
        (Provider::Oci, l.clone())
    } else {
        return None;
    };
    let r = rest.as_str();
    let has = |s: &str| r.contains(s);
    use Provider::*;
    let mapped: (Result<RT, &'static str>, Option<&'static str>) = match provider {
        Aws if has("rds") && (has("instance") || has("cluster")) && !has("clusterinstance") && !has("subnetgroup") => {
            (Ok(RT::Postgres), Some("rds-postgres"))
        }
        Aws if has("elasticache") && (has("replicationgroup") || has(":cluster") || has("/cluster")) => {
            (Ok(RT::Redis), Some("elasticache-valkey"))
        }
        Aws if has("sqs") && has("queue") && !has("policy") => (Ok(RT::Queue), Some("sqs")),
        Aws if has("s3")
            && has("bucket")
            && !has("bucketpolicy")
            && !has("bucketversioning")
            && !has("publicaccess") =>
        {
            (Ok(RT::ObjectStorage), Some("s3"))
        }
        Aws if has("ecr") && has("repository") && !has("policy") => (Ok(RT::ContainerRegistry), Some("ecr")),
        Aws if (has("ecs") && has("service")) || has("fargateservice") => {
            (Ok(RT::ContainerService), Some("ecs-fargate"))
        }
        Aws if (has(":lb") || has("/lb") || has("loadbalancer") || has("applicationloadbalancer"))
            && !has("listener")
            && !has("targetgroup") =>
        {
            (Ok(RT::Ingress), Some("alb"))
        }
        Aws if has("ec2") && has("vpc") && !has("endpoint") || has("awsx:ec2:vpc") => (Ok(RT::Network), Some("vpc")),
        Aws if has("route53") && (has("record") || has("zone")) => (Ok(RT::Dns), Some("route53")),
        Aws if has("lambda") => (Err("functions are not supported yet"), None),
        Azure
            if has("dbforpostgresql")
                && (has("flexibleservers") || has("servers"))
                && !has("databases")
                && !has("firewall")
                && !has("configurations") =>
        {
            (Ok(RT::Postgres), Some("flexible-server"))
        }
        Azure if (has("microsoft.cache/redis") || has("cache:redis") || has("cache/redis")) && !has("firewall") => {
            (Ok(RT::Redis), Some("azure-cache-redis"))
        }
        Azure if has("storageaccount") && !has("container") => (Ok(RT::ObjectStorage), Some("blob-storage")),
        Azure if has("containerapp") && !has("environment") && !has("managedenvironment") => {
            (Ok(RT::ContainerService), Some("container-apps"))
        }
        Azure
            if has("containerregistry") && has("registr") && !has("/")
                || has("microsoft.containerregistry/registries") =>
        {
            (Ok(RT::ContainerRegistry), Some("acr"))
        }
        Azure if has("virtualnetworks") && !has("subnets") => (Ok(RT::Network), Some("vnet")),
        Azure if has("servicebus") && has("queues") => (Ok(RT::Queue), Some("service-bus")),
        Azure if has("applicationgateways") => (Ok(RT::Ingress), Some("application-gateway")),
        Azure if has("dnszones") && !has("privatednszones") => (Ok(RT::Dns), Some("azure-dns")),
        Azure if has("microsoft.web/sites") || has("web:webapp") || has("functionapp") => {
            (Err("App Service and function apps are not supported yet"), None)
        }
        Gcp if has("sql") && has("databaseinstance") => (Ok(RT::Postgres), None),
        Gcp if has("storage") && has("bucket") && !has("iam") => (Ok(RT::ObjectStorage), None),
        Gcp if has("cloudrun") && has("service") && !has("iam") => (Ok(RT::ContainerService), None),
        Gcp if has("redis") && has("instance") => (Ok(RT::Redis), None),
        Oci if has("psql") => (Ok(RT::Postgres), Some("oci-postgresql")),
        Oci if has("objectstorage") && has("bucket") => (Ok(RT::ObjectStorage), Some("object-storage")),
        _ => (Err("no OrkStage mapping for this resource type"), None),
    };
    Some((mapped.0, provider, mapped.1))
}

fn emit(out: &mut Findings, t: &str, name: &str, source: SourceRef, key: String, props: Option<&Value>) {
    match classify_type(t) {
        Some((Ok(rt), provider, implementation)) => {
            let mut c = Candidate::new(rt, Some(provider), name, source, Confidence::Medium, key);
            c.implementation = implementation.map(str::to_string);
            if let Some(p) = props {
                // A few well-known properties, whatever their casing.
                let pick = |k: &str| crate::util::get_ci(p, k);
                if rt == RT::Postgres {
                    c.set_opt(
                        "version",
                        str_of(pick("engineVersion").or_else(|| pick("version"))).and_then(sizing::pg_major),
                    );
                    c.set_opt("size", str_of(pick("instanceClass")).and_then(sizing::aws_class_size));
                    c.set_opt("storageGiB", crate::util::int_of(pick("allocatedStorage")).map(|g| g.clamp(1, 16384)));
                    if crate::util::bool_of(pick("multiAz")) == Some(true) {
                        c.set("highAvailability", "zone-redundant");
                    }
                    if let Some(sku) = str_of(path(p, &["sku", "name"]).or_else(|| pick("skuName"))) {
                        c.set_opt("size", sizing::azure_sku_size(sku));
                    }
                }
                if rt == RT::Queue && crate::util::bool_of(pick("fifoQueue")) == Some(true) {
                    c.set("fifo", true);
                }
            }
            out.candidates.push(c);
        }
        Some((Err(reason), _, _)) => out.unmapped(source, t, reason),
        None => {}
    }
}

// ── Pulumi ───────────────────────────────────────────────────────────────────

static PULUMI_NEW: LazyLock<Regex> = LazyLock::new(|| {
    // TypeScript `new aws.rds.Instance("db"`, Python `aws.rds.Instance("db"`, Go `rds.NewInstance(ctx, "db"`
    Regex::new(r#"(?:new\s+)?\b((?:aws|awsx|azure_native|azure-native|azure|gcp|oci)(?:\.[A-Za-z0-9_]+)+)\(\s*(?:ctx\s*,\s*)?["']([^"']+)["']"#).unwrap()
});

pub(crate) fn pulumi(project: &crate::InputFile, docs: &[YamlDoc], all: &[&crate::InputFile], out: &mut Findings) {
    out.count(SourceKind::Pulumi, &project.path);
    let mut found = 0;
    // Pulumi YAML programs declare resources inline.
    if let Some(resources) = docs.first().and_then(|d| get(&d.value, "resources")).and_then(Value::as_object) {
        for (name, r) in resources {
            let Some(t) = str_of(get(r, "type")) else { continue };
            let line = docs[0].line(&["resources", name]);
            let source = src(SourceKind::Pulumi, &project.path, line, name.clone());
            emit(out, t, name, source, format!("pulumi:{}:{name}", project.path), get(r, "properties"));
            found += 1;
        }
    }
    // Code programs next to Pulumi.yaml.
    let dir = util::dir_of(&project.path);
    for f in all.iter().filter(|f| {
        util::dir_of(&f.path).starts_with(dir)
            && [".ts", ".js", ".py", ".go", ".cs"].iter().any(|e| f.path.ends_with(e))
    }) {
        out.count(SourceKind::Pulumi, &f.path);
        for cap in PULUMI_NEW.captures_iter(&f.content) {
            let ctor = cap[1].replace("azure_native", "azure-native");
            let name = cap[2].to_string();
            let line = util::line_of(&f.content, &cap[0]);
            let source = src(SourceKind::Pulumi, &f.path, line, format!("{ctor}({name})"));
            emit(out, &ctor, &name, source, format!("pulumi:{}:{name}", f.path), None);
            found += 1;
        }
    }
    if found == 0 {
        out.warn(format!(
            "{}: Pulumi project detected but no resources could be read; mapping is partial",
            project.path
        ));
    }
}

// ── Serverless Framework ─────────────────────────────────────────────────────

pub(crate) fn serverless(file: &str, doc: &YamlDoc, out: &mut Findings) {
    out.count(SourceKind::Serverless, file);
    if let Some(functions) = get(&doc.value, "functions").and_then(Value::as_object) {
        for name in functions.keys() {
            let source = src(SourceKind::Serverless, file, doc.line(&["functions", name]), format!("functions.{name}"));
            out.unmapped(source, "function", "functions are not supported yet");
        }
    }
    let provider = str_of(path(&doc.value, &["provider", "name"])).unwrap_or("aws");
    if provider != "aws" {
        out.warn(format!("{file}: Serverless provider \"{provider}\" is detected but not mapped"));
        return;
    }
    if let Some(resources) = path(&doc.value, &["resources", "Resources"]) {
        let lines =
            doc.lines.iter().filter_map(|(k, v)| k.strip_prefix("resources/").map(|k| (k.to_string(), *v))).collect();
        let value = json!({ "Resources": resources });
        cloudformation::detect(CfnDoc { file, kind: SourceKind::Serverless, value, lines }, out);
        // detect() counted the file once more under the same kind; counts are per file, so no double count.
    }
}

// ── Bicep / ARM ──────────────────────────────────────────────────────────────

static BICEP_RES: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?m)^\s*resource\s+([A-Za-z0-9_]+)\s+'([^'@]+)@[^']*'\s*(existing\s*)?="#).unwrap());
static BICEP_NAME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"^\s*name:\s*'([^'$]+)'"#).unwrap());

pub(crate) fn bicep(file: &str, content: &str, out: &mut Findings) {
    out.count(SourceKind::Bicep, file);
    for cap in BICEP_RES.captures_iter(content) {
        if cap.get(3).is_some() {
            continue; // `existing` references are not created here
        }
        let symbol = &cap[1];
        let t = &cap[2];
        if is_child(t) {
            continue; // child resources (databases, firewall rules, ...) are supporting
        }
        let start = cap.get(0).map(|m| m.end()).unwrap_or(0);
        let name = content[start..]
            .lines()
            .take(6)
            .find_map(|l| BICEP_NAME.captures(l).map(|c| c[1].to_string()))
            .unwrap_or_else(|| symbol.to_string());
        let line = util::line_of(content, &cap[0]);
        let source = src(SourceKind::Bicep, file, line, format!("{symbol} ({t})"));
        if is_azure_supporting(t) {
            continue;
        }
        emit(out, t, &name, source, format!("bicep:{file}:{symbol}"), None);
    }
}

pub(crate) fn is_arm(v: &Value) -> bool {
    str_of(get(v, "$schema")).is_some_and(|s| s.contains("deploymentTemplate.json"))
}

pub(crate) fn arm(file: &str, v: &Value, out: &mut Findings) {
    out.count(SourceKind::Arm, file);
    for r in get(v, "resources").and_then(Value::as_array).into_iter().flatten() {
        let Some(t) = str_of(get(r, "type")) else { continue };
        if is_child(t) || is_azure_supporting(t) {
            continue;
        }
        let raw = str_of(get(r, "name")).unwrap_or("");
        let name = if raw.starts_with('[') {
            // `[concat(parameters('ns'), '/orders')]` → `orders`
            static LIT: LazyLock<Regex> =
                LazyLock::new(|| Regex::new(r"'/?([A-Za-z0-9][A-Za-z0-9_-]*)'\)*\]$").unwrap());
            LIT.captures(raw).map(|c| c[1].to_string()).unwrap_or_else(|| t.rsplit('/').next().unwrap_or(t).to_string())
        } else if raw.is_empty() {
            t.rsplit('/').next().unwrap_or(t).to_string()
        } else {
            raw.to_string()
        };
        let source = src(SourceKind::Arm, file, None, name.clone());
        let mut props = get(r, "properties").cloned().unwrap_or(Value::Null);
        if let (Value::Object(m), Some(sku)) = (&mut props, get(r, "sku")) {
            m.insert("sku".into(), sku.clone());
        }
        emit(out, t, &name, source, format!("arm:{file}:{name}"), Some(&props));
    }
}

/// Child resource types (`.../flexibleServers/databases`), except Service Bus queues.
fn is_child(t: &str) -> bool {
    t.matches('/').count() > 1 && !t.to_ascii_lowercase().ends_with("namespaces/queues")
}

fn is_azure_supporting(t: &str) -> bool {
    let l = t.to_ascii_lowercase();
    [
        "microsoft.network/networksecuritygroups",
        "microsoft.network/publicipaddresses",
        "microsoft.network/privateendpoints",
        "microsoft.network/privatednszones",
        "microsoft.managedidentity/",
        "microsoft.authorization/",
        "microsoft.operationalinsights/",
        "microsoft.insights/",
        "microsoft.keyvault/",
        "microsoft.app/managedenvironments",
        "microsoft.servicebus/namespaces",
        "microsoft.resources/",
    ]
    .iter()
    .any(|p| l.starts_with(p) && !(p.ends_with("namespaces") && l.contains("/queues")))
}
