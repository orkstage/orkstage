//! File classification and detector dispatch.

mod cloudformation;
mod compose;
mod dockerfile;
mod hcl_eval;
mod images;
mod kubernetes;
mod other;
mod packages;
mod terraform;

use std::collections::BTreeSet;

use crate::InputFile;
use crate::evidence::Findings;
use crate::model::SourceKind;
use crate::util;
use crate::yaml;

pub(crate) const PACKAGE_MANIFESTS: &[&str] = &[
    "package.json",
    "requirements.txt",
    "requirements.in",
    "requirements-prod.txt",
    "pyproject.toml",
    "go.mod",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "gemfile",
    "composer.json",
    "cargo.toml",
];

/// Would any detector look at a file with this path? Used by callers to pre-filter walks.
pub fn is_candidate_path(path: &str) -> bool {
    let name = util::file_name(path).to_ascii_lowercase();
    let ext = name.rsplit_once('.').map(|(_, e)| e).unwrap_or("");
    matches!(ext, "tf" | "yaml" | "yml" | "bicep" | "template" | "prisma" | "tpl")
        || name.ends_with(".tf.json")
        || name.ends_with(".json")
            && (name.contains("template")
                || name.contains("azuredeploy")
                || name == "package.json"
                || name == "composer.json"
                || path.contains("cdk.out/")
                || path.contains("cloudformation")
                || path.contains("cfn")
                || path.contains("arm"))
        || is_dockerfile(&name)
        || PACKAGE_MANIFESTS.contains(&name.as_str())
        || is_pulumi_program(&name)
}

fn is_pulumi_program(name: &str) -> bool {
    matches!(name, "index.ts" | "index.js" | "__main__.py" | "main.go" | "program.cs")
}

fn is_dockerfile(name: &str) -> bool {
    name == "dockerfile" || name == "containerfile" || name.starts_with("dockerfile.") || name.ends_with(".dockerfile")
}

fn is_compose(name: &str) -> bool {
    (name.starts_with("docker-compose") || name.starts_with("compose"))
        && (name.ends_with(".yml") || name.ends_with(".yaml"))
}

pub(crate) fn run(files: &[&InputFile], out: &mut Findings) {
    let chart_dirs: BTreeSet<&str> =
        files.iter().filter(|f| util::file_name(&f.path) == "Chart.yaml").map(|f| util::dir_of(&f.path)).collect();
    let pulumi_dirs: BTreeSet<&str> = files
        .iter()
        .filter(|f| matches!(util::file_name(&f.path), "Pulumi.yaml" | "Pulumi.yml"))
        .map(|f| util::dir_of(&f.path))
        .collect();
    let in_chart = |path: &str| {
        chart_dirs
            .iter()
            .any(|d| path.starts_with(&format!("{d}/templates/")) || d.is_empty() && path.starts_with("templates/"))
    };
    let prisma_pg = packages::prisma_uses_postgres(files);

    let mut terraform: Vec<&InputFile> = Vec::new();
    let mut k8s: Vec<kubernetes::K8sFile<'_>> = Vec::new();

    for f in files {
        let path = f.path.as_str();
        let name = util::file_name(path).to_ascii_lowercase();
        if name.ends_with(".tf") || name.ends_with(".tf.json") {
            terraform.push(f);
        } else if name == "chart.yaml" {
            match yaml::load_all(&f.content) {
                Ok(docs) => kubernetes::chart(path, &docs, out),
                Err(e) => out.warn(format!("{path}: invalid Chart.yaml: {e}")),
            }
        } else if in_chart(path) {
            if !(name.ends_with(".yaml") || name.ends_with(".yml")) {
                continue; // _helpers.tpl, NOTES.txt
            }
            let content =
                if f.content.contains("{{") { kubernetes::helm_sanitize(&f.content) } else { f.content.clone() };
            match yaml::load_all(&content) {
                Ok(docs) => k8s.push(kubernetes::K8sFile { file: path, kind: SourceKind::Helm, docs }),
                Err(_) => {
                    out.count(SourceKind::Helm, path);
                    out.warn(format!(
                        "{path}: Helm template could not be parsed after removing template actions; skipped"
                    ));
                }
            }
        } else if is_compose(&name) {
            match yaml::load_all(&f.content) {
                Ok(docs) if docs.first().is_some_and(|d| d.value.get("services").is_some()) => {
                    compose::detect(path, &docs[0], out)
                }
                Ok(_) => {}
                Err(e) => out.warn(format!("{path}: invalid Compose YAML: {e}")),
            }
        } else if is_dockerfile(&name) {
            dockerfile::detect(path, &f.content, out);
        } else if PACKAGE_MANIFESTS.contains(&name.as_str()) {
            packages::detect(path, &f.content, prisma_pg, out);
        } else if name == "pulumi.yaml" || name == "pulumi.yml" {
            let docs = yaml::load_all(&f.content).unwrap_or_default();
            other::pulumi(f, &docs, files, out);
        } else if name == "serverless.yml" || name == "serverless.yaml" {
            match yaml::load_all(&f.content) {
                Ok(docs) if !docs.is_empty() => other::serverless(path, &docs[0], out),
                Ok(_) => {}
                Err(e) => out.warn(format!("{path}: invalid serverless.yml: {e}")),
            }
        } else if name.ends_with(".bicep") {
            other::bicep(path, &f.content, out);
        } else if name.ends_with(".json") || name.ends_with(".template") && f.content.trim_start().starts_with('{') {
            if !(f.content.contains("AWSTemplateFormatVersion")
                || f.content.contains("\"Resources\"")
                || f.content.contains("deploymentTemplate.json"))
            {
                continue;
            }
            let Ok(v) = serde_json::from_str::<serde_json::Value>(&f.content) else {
                out.warn(format!("{path}: looks like an IaC template but is not valid JSON"));
                continue;
            };
            if other::is_arm(&v) {
                other::arm(path, &v, out);
            } else if cloudformation::is_cfn(&v) {
                let kind = if path.contains("cdk.out/") {
                    SourceKind::Cdk
                } else if cloudformation::is_sam(&v) {
                    SourceKind::Sam
                } else {
                    SourceKind::Cloudformation
                };
                cloudformation::detect(
                    cloudformation::CfnDoc { file: path, kind, value: v, lines: Default::default() },
                    out,
                );
            }
        } else if name.ends_with(".yaml") || name.ends_with(".yml") || name.ends_with(".template") {
            let c = &f.content;
            let maybe_cfn = c.contains("AWSTemplateFormatVersion") || c.contains("Resources:");
            let maybe_k8s = c.contains("apiVersion") && c.contains("kind");
            if !maybe_cfn && !maybe_k8s {
                continue;
            }
            if pulumi_dirs.contains(util::dir_of(path)) && name.starts_with("pulumi.") {
                continue; // stack configuration
            }
            let docs = match yaml::load_all(c) {
                Ok(d) => d,
                Err(e) => {
                    if c.contains("{{") {
                        out.warn(format!("{path}: templated YAML outside a Helm chart could not be parsed; skipped"));
                    } else if maybe_cfn || c.contains("kind:") {
                        out.warn(format!("{path}: invalid YAML: {e}"));
                    }
                    continue;
                }
            };
            if let Some(first) = docs.first()
                && maybe_cfn
                && cloudformation::is_cfn(&first.value)
            {
                let kind =
                    if cloudformation::is_sam(&first.value) { SourceKind::Sam } else { SourceKind::Cloudformation };
                let lines = first.lines.iter().map(|(k, v)| (k.clone(), *v)).collect();
                cloudformation::detect(
                    cloudformation::CfnDoc { file: path, kind, value: first.value.clone(), lines },
                    out,
                );
                continue;
            }
            let is_k8s = docs.iter().any(|d| {
                d.value.get("apiVersion").and_then(|v| v.as_str()).is_some()
                    && d.value.get("kind").and_then(|v| v.as_str()).is_some()
            });
            if is_k8s {
                let docs = docs
                    .into_iter()
                    .filter(|d| d.value.get("kind").is_some() && d.value.get("apiVersion").is_some())
                    .collect();
                k8s.push(kubernetes::K8sFile { file: path, kind: SourceKind::Kubernetes, docs });
            }
        }
    }
    if !terraform.is_empty() {
        terraform::detect(&terraform, out);
    }
    if !k8s.is_empty() {
        kubernetes::detect(k8s, out);
    }
}
