//! Fixture projects per detector, with snapshot tests (`insta`) of the full ScanReport and
//! targeted assertions for the behaviour the platform relies on.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use orkstage_scan::{Confidence, InputFile, Provider, ResourceType, ScanOptions, ScanReport, SourceKind, scan_files};

fn fixture_dir(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name)
}

fn read_tree(root: &Path, dir: &Path, out: &mut Vec<InputFile>) {
    let mut entries: Vec<_> = std::fs::read_dir(dir).unwrap().map(|e| e.unwrap().path()).collect();
    entries.sort();
    for p in entries {
        if p.is_dir() {
            read_tree(root, &p, out);
        } else {
            let rel = p.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
            // Normalise line endings so snapshots match on every OS checkout.
            let content = std::fs::read_to_string(&p).unwrap().replace("\r\n", "\n");
            out.push(InputFile::new(rel, content));
        }
    }
}

fn scan(name: &str) -> ScanReport {
    let root = fixture_dir(name);
    let mut files = Vec::new();
    read_tree(&root, &root, &mut files);
    let template_name = name.replace('/', "-");
    scan_files(&files, &ScanOptions { template_name: Some(template_name), ..Default::default() })
}

fn ids(r: &ScanReport) -> BTreeSet<&str> {
    r.resources.iter().map(|x| x.id.as_str()).collect()
}

fn conn(r: &ScanReport, from: &str, to: &str) -> bool {
    r.connections.iter().any(|c| c.from == from && c.to == to)
}

fn res<'a>(r: &'a ScanReport, id: &str) -> &'a orkstage_scan::DetectedResource {
    r.resources.iter().find(|x| x.id == id).unwrap_or_else(|| panic!("no resource {id} in {:?}", ids(r)))
}

fn no_template_issues(r: &ScanReport) {
    let issues: Vec<_> = r.warnings.iter().filter(|w| w.starts_with("template:")).collect();
    assert!(issues.is_empty(), "template issues: {issues:?}\n{}", r.template);
}

/// Report snapshot (template elided) plus the template as a readable YAML snapshot.
macro_rules! snapshot {
    ($name:expr, $report:expr) => {{
        let mut report: ScanReport = $report.clone();
        let template = std::mem::replace(&mut report.template, "<see the __template snapshot>".into());
        let name = $name.replace('/', "__");
        insta::with_settings!({ snapshot_path => "snapshots", prepend_module_to_snapshot => false, omit_expression => true }, {
            insta::assert_yaml_snapshot!(name.clone(), report);
            insta::assert_snapshot!(format!("{name}__template"), template);
        });
    }};
}

const STARTER_IDS: [&str; 9] =
    ["network", "registry", "api", "worker", "database", "cache", "messaging", "ingress", "dns"];

fn assert_starter_standard(r: &ScanReport) {
    assert_eq!(ids(r), STARTER_IDS.into_iter().collect(), "{}", r.template);
    let api = res(r, "api");
    assert_eq!(api.implementation.as_deref(), Some("ecs-fargate"));
    assert_eq!(api.properties["cpu"], 0.5);
    assert_eq!(api.properties["memoryMiB"], 1024);
    assert_eq!(api.properties["port"], 8080);
    assert_eq!(api.properties["public"], true);
    assert_eq!(api.properties["healthCheckPath"], "/health");
    let db = res(r, "database");
    assert_eq!(db.provider, Some(Provider::Aws));
    assert_eq!(db.properties["size"], "small");
    assert_eq!(db.properties["storageGiB"], 20);
    assert_eq!(db.properties["backup"]["retentionDays"], 7);
    assert_eq!(res(r, "cache").properties["size"], "micro");
    assert_eq!(res(r, "messaging").properties["deadLetter"], true);
    assert_eq!(res(r, "network").properties["availabilityZones"], 2);
    assert_eq!(res(r, "ingress").properties["routes"][0]["service"], "api");
    assert_eq!(res(r, "dns").properties["target"], "ingress");
    assert_eq!(res(r, "dns").properties["customDomain"], "optional");
    for (from, to) in
        [("api", "database"), ("worker", "database"), ("api", "cache"), ("api", "messaging"), ("worker", "messaging")]
    {
        assert!(conn(r, from, to), "missing connection {from} -> {to}: {:?}", r.connections);
    }
    assert_eq!(r.connections.len(), 5);
    assert!(r.unmapped.iter().any(|u| u.reason.contains("not supported yet") || u.reason.contains("not expanded")));
    no_template_issues(r);
    assert!(r.template.contains("image: catalog://api"));
}

#[test]
fn terraform_starter_standard() {
    let r = scan("terraform/starter-standard");
    assert_starter_standard(&r);
    assert_eq!(r.detectors[0].kind, SourceKind::Terraform);
    assert!(r.unmapped.iter().any(|u| u.kind == "terraform_module"));
    snapshot!("terraform/starter-standard", &r);
}

#[test]
fn cloudformation_starter_standard() {
    let r = scan("cloudformation/starter-standard");
    assert_starter_standard(&r);
    assert!(
        r.unmapped.iter().any(|u| u.kind == "AWS::Lambda::Function" && u.reason == "functions are not supported yet")
    );
    // Lines point at the logical id.
    assert!(res(&r, "database").sources[0].line.is_some());
    snapshot!("cloudformation/starter-standard", &r);
}

#[test]
fn terraform_local_modules_are_expanded() {
    let r = scan("terraform/modules");
    let api = res(&r, "api");
    assert_eq!(api.properties["replicas"], 3);
    assert_eq!(api.properties["cpu"], 1.0);
    assert_eq!(api.properties["port"], 3000);
    assert_eq!(api.properties["sourceImage"], "ghcr.io/acme/orders-api:2.1.0");
    assert_eq!(res(&r, "worker").properties["replicas"], 2);
    let db = res(&r, "database");
    assert_eq!(db.properties["size"], "large");
    assert_eq!(db.properties["highAvailability"], "zone-redundant");
    assert_eq!(res(&r, "network").properties["availabilityZones"], 3);
    assert_eq!(res(&r, "network").properties["natGateway"], true);
    assert!(conn(&r, "api", "database"), "{:?}", r.connections);
    assert!(conn(&r, "worker", "database"));
    no_template_issues(&r);
    snapshot!("terraform/modules", &r);
}

#[test]
fn terraform_azure_and_gcp() {
    let r = scan("terraform/azure-gcp");
    let pg: Vec<_> = r.resources.iter().filter(|x| x.kind == ResourceType::Postgres).collect();
    assert_eq!(pg.len(), 2);
    let azure = pg.iter().find(|x| x.provider == Some(Provider::Azure)).unwrap();
    assert_eq!(azure.implementation.as_deref(), Some("flexible-server"));
    assert_eq!(azure.properties["storageGiB"], 64);
    assert_eq!(azure.properties["highAvailability"], "zone-redundant");
    assert!(pg.iter().any(|x| x.provider == Some(Provider::Gcp) && x.properties["version"] == "15"));
    assert!(r.unmapped.iter().any(|u| u.kind == "azurerm_mysql_flexible_server"));
    assert!(r.unmapped.iter().any(|u| u.kind == "google_cloudfunctions2_function"));
    snapshot!("terraform/azure-gcp", &r);
}

#[test]
fn sam_and_cdk() {
    let r = scan("cloudformation/sam");
    assert_eq!(r.detectors[0].kind, SourceKind::Sam);
    assert_eq!(res(&r, "messaging").properties["fifo"], true);
    let storage = res(&r, "storage");
    assert_eq!(storage.properties["versioning"], true);
    assert_eq!(storage.properties["retentionDays"], 90);
    assert!(r.unmapped.iter().any(|u| u.kind == "AWS::Serverless::Function"));
    snapshot!("cloudformation/sam", &r);

    let r = scan("cloudformation/cdk");
    assert_eq!(r.detectors[0].kind, SourceKind::Cdk);
    let db = res(&r, "database");
    assert_eq!(db.properties["highAvailability"], "zone-redundant");
    assert_eq!(db.properties["size"], "large");
    assert!(r.unmapped.is_empty(), "{:?}", r.unmapped);
    snapshot!("cloudformation/cdk", &r);
}

#[test]
fn kubernetes_manifests() {
    let r = scan("kubernetes/manifests");
    let api = res(&r, "api");
    assert_eq!(api.properties["cpu"], 0.5);
    assert_eq!(api.properties["memoryMiB"], 1024);
    assert_eq!(api.properties["healthCheckPath"], "/ready");
    assert_eq!(api.properties["public"], true);
    assert_eq!(api.properties["autoscaling"]["maxReplicas"], 10);
    assert_eq!(res(&r, "database").properties["storageGiB"], 50);
    assert_eq!(res(&r, "database").properties["version"], "16");
    assert!(conn(&r, "api", "database"));
    assert!(conn(&r, "api", "cache"));
    assert!(ids(&r).contains("ingress") && ids(&r).contains("dns"));
    assert!(r.unmapped.iter().any(|u| u.kind == "CronJob"));
    no_template_issues(&r);
    snapshot!("kubernetes/manifests", &r);
}

#[test]
fn helm_chart_best_effort() {
    let r = scan("kubernetes/helm");
    assert_eq!(r.detectors.iter().find(|d| d.kind == SourceKind::Helm).map(|d| d.files), Some(4));
    assert!(ids(&r).contains("database") && ids(&r).contains("cache"));
    assert!(r.warnings.iter().any(|w| w.contains("broken.yaml")));
    let svc = r.resources.iter().find(|x| x.kind == ResourceType::ContainerService).unwrap();
    assert_eq!(svc.properties["port"], 3000);
    assert_eq!(svc.properties["public"], true);
    snapshot!("kubernetes/helm", &r);
}

#[test]
fn compose_app() {
    let r = scan("compose/app");
    assert_eq!(
        ids(&r),
        ["network", "api", "worker", "database", "cache", "messaging", "storage"].into_iter().collect()
    );
    let db = res(&r, "database");
    assert_eq!(db.provider, None);
    assert_eq!(db.properties["version"], "17");
    // compose + package evidence for the same database
    assert!(db.sources.iter().any(|s| s.kind == SourceKind::Compose));
    assert!(db.sources.iter().any(|s| s.kind == SourceKind::Package));
    let api = res(&r, "api");
    assert_eq!(api.properties["healthCheckPath"], "/health");
    assert_eq!(api.properties["replicas"], 2);
    assert!(api.sources.iter().any(|s| s.kind == SourceKind::Dockerfile));
    for (f, t) in
        [("api", "database"), ("api", "cache"), ("api", "messaging"), ("worker", "database"), ("worker", "storage")]
    {
        assert!(conn(&r, f, t), "missing {f}->{t}: {:?}", r.connections);
    }
    assert_eq!(r.connections.iter().find(|c| c.to == "messaging").unwrap().protocol, "amqp");
    assert!(r.unmapped.iter().any(|u| u.source.address == "services.mailpit"));
    assert!(r.unmapped.iter().any(|u| u.source.address == "services.legacy-db"));
    no_template_issues(&r);
    snapshot!("compose/app", &r);
}

#[test]
fn packages_polyglot() {
    let r = scan("packages/polyglot");
    let kinds: BTreeSet<ResourceType> = r.resources.iter().map(|x| x.kind).collect();
    for k in [ResourceType::Postgres, ResourceType::Redis, ResourceType::Queue, ResourceType::ObjectStorage] {
        assert!(kinds.contains(&k), "{k:?} missing");
    }
    assert!(r.resources.iter().all(|x| x.provider.is_none()));
    assert!(r.resources.iter().all(|x| x.confidence <= Confidence::Medium));
    let db = res(&r, "database");
    // pg drivers from node(prisma), python, poetry, go, java, ruby, php, rust
    assert!(db.sources.len() >= 7, "{:?}", db.sources);
    assert_eq!(r.detectors[0].files, 9);
    snapshot!("packages/polyglot", &r);
}

#[test]
fn iac_wins_over_compose_and_packages() {
    let r = scan("mixed/tf-compose-packages");
    let dbs: Vec<_> = r.resources.iter().filter(|x| x.kind == ResourceType::Postgres).collect();
    assert_eq!(dbs.len(), 1);
    let db = dbs[0];
    assert_eq!(db.provider, Some(Provider::Aws));
    assert_eq!(db.properties["size"], "medium");
    let kinds: BTreeSet<SourceKind> = db.sources.iter().map(|s| s.kind).collect();
    assert_eq!(kinds, [SourceKind::Terraform, SourceKind::Compose, SourceKind::Package].into_iter().collect());
    let app = res(&r, "app");
    assert_eq!(app.implementation.as_deref(), Some("ecs-ec2"));
    assert_eq!(app.properties["replicas"], 2);
    assert_eq!(app.properties["port"], 3000);
    assert!(conn(&r, "app", "database"));
    // Public service on AWS → inferred network, ingress and DNS.
    assert!(ids(&r).is_superset(&["network", "ingress", "dns"].into_iter().collect()));
    no_template_issues(&r);
    snapshot!("mixed/tf-compose-packages", &r);
}

#[test]
fn multicloud_placements() {
    let r = scan("mixed/multicloud");
    assert!(r.template.contains("- name: primary"));
    assert!(r.template.contains("- name: data"));
    assert!(r.template.contains("- name: storage"));
    assert_eq!(res(&r, "database").properties["placement"], "data");
    assert_eq!(res(&r, "storage").properties["placement"], "storage");
    assert!(conn(&r, "api", "database"));
    assert_eq!(r.connections.iter().find(|c| c.to == "database").unwrap().protocol, "postgres");
    no_template_issues(&r);
    snapshot!("mixed/multicloud", &r);
}

#[test]
fn other_iac_is_detected() {
    let r = scan("mixed/other-iac");
    let kinds: BTreeSet<SourceKind> = r.detectors.iter().map(|d| d.kind).collect();
    for k in [SourceKind::Pulumi, SourceKind::Serverless, SourceKind::Bicep, SourceKind::Arm] {
        assert!(kinds.contains(&k), "{k:?} not detected: {:?}", r.detectors);
    }
    assert!(r.unmapped.iter().any(|u| u.source.kind == SourceKind::Serverless && u.reason.contains("functions")));
    assert!(r.unmapped.iter().any(|u| u.source.kind == SourceKind::Pulumi && u.reason.contains("functions")));
    assert!(r.unmapped.iter().any(|u| u.source.kind == SourceKind::Bicep));
    snapshot!("mixed/other-iac", &r);
}

#[test]
fn garbage_input_never_panics() {
    let files = vec![
        InputFile::new("main.tf", "resource \"aws_db_instance\" {{{{"),
        InputFile::new("template.yaml", "AWSTemplateFormatVersion: [unclosed"),
        InputFile::new("docker-compose.yml", "services: 42"),
        InputFile::new("package.json", "{not json"),
        InputFile::new("k8s.yaml", "apiVersion: v1\nkind: Service\n"),
        InputFile::new("Dockerfile", ""),
    ];
    let r = scan_files(&files, &ScanOptions::default());
    assert!(!r.warnings.is_empty());
    let empty = scan_files(&[], &ScanOptions::default());
    assert!(empty.resources.is_empty());
}

#[test]
fn reports_are_deterministic() {
    let a = serde_json::to_string(&scan("compose/app")).unwrap();
    let b = serde_json::to_string(&scan("compose/app")).unwrap();
    assert_eq!(a, b);
}
