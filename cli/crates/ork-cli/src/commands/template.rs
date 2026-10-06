//! `ork template validate | push | diff`.

use std::path::PathBuf;
use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Value, json};

use super::client;
use crate::api::{Template, TemplateVersion};
use crate::cli::{TemplateDiffArgs, TemplateFileArgs};
use crate::config::Ctx;
use crate::error::{CliError, Result};
use crate::output::{self, heading};

fn template_path(ctx: &Ctx, file: Option<&PathBuf>) -> Result<PathBuf> {
    match file {
        Some(f) if f.is_absolute() => Ok(f.clone()),
        Some(f) => Ok(ctx.cwd.join(f)),
        None => Ok(ctx.require_project()?.template_path()),
    }
}

fn read(path: &PathBuf) -> Result<String> {
    std::fs::read_to_string(path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            CliError::not_found(
                format!("{} not found", path.display()),
                Some("run `ork scan --write` or pass --file".into()),
            )
        } else {
            CliError::io(format!("reading {}", path.display()), e)
        }
    })
}

static META_FIELD: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"^  (name|version):\s*["']?([^"'#\s]+)["']?\s*(#.*)?$"#).unwrap());

/// `metadata.name` / `metadata.version` from the block-style YAML the CLI and builder write.
pub fn metadata(source: &str) -> (Option<String>, Option<String>) {
    let (mut name, mut version) = (None, None);
    let mut in_meta = false;
    for line in source.lines() {
        if !line.starts_with(' ') && !line.starts_with('#') && !line.trim().is_empty() {
            in_meta = line.trim_end() == "metadata:";
            continue;
        }
        if in_meta && let Some(c) = META_FIELD.captures(line) {
            match &c[1] {
                "name" => name = Some(c[2].to_string()),
                _ => version = Some(c[2].to_string()),
            }
        }
    }
    (name, version)
}

pub fn set_version(source: &str, version: &str) -> String {
    let mut in_meta = false;
    let mut done = false;
    let mut out: Vec<String> = Vec::new();
    for line in source.lines() {
        if !line.starts_with(' ') && !line.starts_with('#') && !line.trim().is_empty() {
            in_meta = line.trim_end() == "metadata:";
        } else if in_meta
            && !done
            && line.trim_start().starts_with("version:")
            && line.starts_with("  ")
            && !line.starts_with("   ")
        {
            out.push(format!("  version: {version}"));
            done = true;
            continue;
        }
        out.push(line.to_string());
    }
    let mut s = out.join("\n");
    if source.ends_with('\n') {
        s.push('\n');
    }
    s
}

fn semver(v: &str) -> (u64, u64, u64) {
    let mut it = v.split('.').map(|p| p.parse::<u64>().unwrap_or(0));
    (it.next().unwrap_or(0), it.next().unwrap_or(0), it.next().unwrap_or(0))
}

fn latest(t: &Template) -> Option<&TemplateVersion> {
    t.versions.as_ref()?.iter().max_by_key(|v| semver(&v.version))
}

fn require_name(source: &str) -> Result<(String, String)> {
    match metadata(source) {
        (Some(n), Some(v)) => Ok((n, v)),
        _ => Err(CliError::usage(
            "the template has no metadata.name / metadata.version",
            Some("regenerate it with `ork scan --write`".into()),
        )),
    }
}

pub async fn validate(ctx: &Ctx, args: TemplateFileArgs) -> Result<()> {
    let path = template_path(ctx, args.file.as_ref())?;
    let source = read(&path)?;
    let api = client(ctx)?;
    let mut body = json!({ "source": source });
    if let Some(p) = &args.plan {
        body["planCode"] = json!(p);
    }
    let report: Value = api.post("/templates/validate", &body).await?;
    let valid = report.get("valid").and_then(Value::as_bool).unwrap_or(false);
    let issues = report.get("issues").and_then(Value::as_array).cloned().unwrap_or_default();
    if ctx.json() {
        output::print_json(&report);
    } else {
        crate::outln!("{} {}", heading(ctx, "Template:"), path.display());
        if issues.is_empty() {
            crate::outln!("Valid: no issues.");
        } else {
            let mut t = output::table(ctx, &["SEVERITY", "STAGE", "CODE", "PATH", "MESSAGE"]);
            for i in &issues {
                let f = |k: &str| i.get(k).and_then(Value::as_str).unwrap_or("").to_string();
                t.add_row(vec![
                    output::status_cell(ctx, &f("severity")),
                    comfy_table::Cell::new(f("stage")),
                    comfy_table::Cell::new(f("code")),
                    comfy_table::Cell::new(f("path")),
                    comfy_table::Cell::new(f("message")),
                ]);
            }
            crate::outln!("{t}");
            crate::outln!("{}", if valid { "Valid (warnings only)." } else { "Invalid." });
        }
    }
    if valid {
        Ok(())
    } else {
        let errors = issues.iter().filter(|i| i.get("severity").and_then(Value::as_str) == Some("error")).count();
        Err(CliError::failed(
            format!("the template is invalid ({errors} error(s))"),
            Some(format!("fix {} and validate again", path.display())),
        ))
    }
}

pub async fn push(ctx: &Ctx, args: TemplateFileArgs) -> Result<()> {
    let path = template_path(ctx, args.file.as_ref())?;
    let mut source = read(&path)?;
    let (name, local_version) = require_name(&source)?;
    let api = client(ctx)?;
    let result: Value = match api.template_by_name(&name).await? {
        None => {
            let created: Value = api.post("/templates", &json!({ "source": source })).await?;
            json!({ "action": "created", "template": name, "version": local_version, "templateId": created.get("id") })
        }
        Some(t) => {
            if t.visibility == "SYSTEM" {
                return Err(CliError::usage(
                    format!("\"{name}\" is a system template and cannot get new versions"),
                    Some("rename metadata.name (and [template].name in .ork/config.toml)".into()),
                ));
            }
            let server = latest(&t).map(|v| v.version.clone());
            if latest(&t).is_some_and(|v| v.source == source) {
                // Same content as the latest version: nothing to push, and no version churn.
                let r = json!({ "action": "up-to-date", "template": name, "templateId": t.id, "version": server });
                if ctx.json() {
                    output::print_json(&r);
                } else {
                    eprintln!("{name}@{} is already up to date.", server.unwrap_or_default());
                }
                return Ok(());
            }
            let mut version = local_version.clone();
            if let Some(sv) = &server
                && semver(&version) <= semver(sv)
            {
                let (a, b, c) = semver(sv);
                version = format!("{a}.{b}.{}", c + 1);
                source = set_version(&source, &version);
                std::fs::write(&path, &source).map_err(|e| CliError::io(format!("writing {}", path.display()), e))?;
            }
            let v: Value = api.post(&format!("/templates/{}/versions", t.id), &json!({ "source": source })).await?;
            json!({
                "action": "version-added",
                "template": name,
                "templateId": t.id,
                "version": version,
                "previousVersion": server,
                "versionId": v.get("id"),
                "status": v.get("status"),
            })
        }
    };
    if ctx.json() {
        output::print_json(&result);
    } else {
        let action = result["action"].as_str().unwrap_or("");
        let version = result["version"].as_str().unwrap_or("");
        if action == "created" {
            eprintln!("Created template {name} {version} (DRAFT). Publish it in the console when reviewed.");
        } else {
            eprintln!(
                "Pushed {name} {version} (DRAFT){}.",
                result["previousVersion"].as_str().map(|p| format!(", previous {p}")).unwrap_or_default()
            );
        }
    }
    Ok(())
}

pub async fn diff(ctx: &Ctx, args: TemplateDiffArgs) -> Result<()> {
    let path = template_path(ctx, args.file.as_ref())?;
    let local = read(&path)?;
    let (name, local_version) = require_name(&local)?;
    let api = client(ctx)?;
    let t = api.template_by_name(&name).await?.ok_or_else(|| {
        CliError::not_found(
            format!("template \"{name}\" does not exist on the server"),
            Some("create it with `ork template push`".into()),
        )
    })?;
    let server = latest(&t).ok_or_else(|| CliError::not_found(format!("template \"{name}\" has no versions"), None))?;
    let text = similar::TextDiff::from_lines(&server.source, &local)
        .unified_diff()
        .context_radius(3)
        .header(&format!("server {name}@{}", server.version), &format!("local {}", path.display()))
        .to_string();
    let identical = text.is_empty();
    if ctx.json() {
        output::print_json(&json!({
            "template": name,
            "serverVersion": server.version,
            "localVersion": local_version,
            "identical": identical,
            "diff": text,
        }));
    } else if identical {
        eprintln!("No differences between local {} and server {name}@{}.", path.display(), server.version);
    } else {
        for line in text.lines() {
            let colored = if !ctx.color {
                line.to_string()
            } else if line.starts_with('+') && !line.starts_with("+++") {
                format!("\x1b[32m{line}\x1b[0m")
            } else if line.starts_with('-') && !line.starts_with("---") {
                format!("\x1b[31m{line}\x1b[0m")
            } else if line.starts_with("@@") {
                format!("\x1b[36m{line}\x1b[0m")
            } else {
                line.to_string()
            };
            crate::outln!("{colored}");
        }
    }
    if args.exit_code && !identical {
        return Err(CliError::failed("the local template differs from the server", None));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metadata_and_bump() {
        let src = "# c\napiVersion: platform/v1\nmetadata:\n  name: shop\n  version: 0.1.0\n  displayName: Shop\nspec:\n  resources:\n    - id: x\n      version: \"17\"\n";
        assert_eq!(metadata(src), (Some("shop".into()), Some("0.1.0".into())));
        let bumped = set_version(src, "0.1.1");
        assert_eq!(metadata(&bumped).1.as_deref(), Some("0.1.1"));
        assert!(bumped.contains("version: \"17\""));
        assert!(semver("1.10.0") > semver("1.9.9"));
    }
}
