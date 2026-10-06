//! Platform operations: import, instances, deploy (with event streaming), status, logs, destroy.

use std::time::{Duration, Instant};

use indicatif::{ProgressBar, ProgressStyle};
use serde_json::{Value, json};

use super::{client, resolve_path, scan_project};
use crate::api::{ApiClient, Deployment, DeploymentEvent, Instance, is_terminal_status};
use crate::cli::{DeployArgs, DestroyArgs, ImportArgs, InstanceSelector, InstancesCommand, LogsArgs};
use crate::config::Ctx;
use crate::error::{CliError, Result};
use crate::output::{self, heading};

pub async fn import(ctx: &Ctx, args: ImportArgs) -> Result<()> {
    let root = resolve_path(ctx, args.path.as_deref());
    let (report, walked) = scan_project(ctx, &root, None, None)?;
    output::note(
        ctx,
        &format!(
            "Scanned {} files: {} resources, {} unmapped.",
            walked.files.len(),
            report.resources.len(),
            report.unmapped.len()
        ),
    );
    let api = client(ctx)?;
    let mut body = json!({ "report": report });
    if let Some(t) = args.tenant.or_else(|| ctx.tenant()) {
        body["tenantId"] = json!(api.resolve_tenant(&t).await?.id);
    }
    let created: Value = api.post("/imports", &body).await?;
    let id = created.get("id").and_then(Value::as_str).unwrap_or("").to_string();
    let console = ctx.console_url().map(|c| format!("{c}/templates/import?importId={id}"));
    if ctx.json() {
        output::print_json(&json!({ "import": created, "consoleUrl": console }));
        return Ok(());
    }
    let valid = created.pointer("/validation/valid").and_then(Value::as_bool).unwrap_or(false);
    let issues = created.pointer("/validation/issues").and_then(Value::as_array).map(Vec::len).unwrap_or(0);
    crate::outln!("{} {id}", heading(ctx, "Import:"));
    crate::outln!(
        "{} {}",
        heading(ctx, "Template:"),
        if valid { "valid".to_string() } else { format!("needs review ({issues} issue(s))") }
    );
    if let Some(url) = console {
        crate::outln!("{} {url}", heading(ctx, "Console:"));
    }
    Ok(())
}

pub async fn instances(ctx: &Ctx, cmd: InstancesCommand) -> Result<()> {
    let InstancesCommand::List { tenant } = cmd;
    let api = client(ctx)?;
    let tenant_id = match tenant {
        Some(t) => Some(api.resolve_tenant(&t).await?.id),
        None => None,
    };
    let list = api.instances(tenant_id.as_deref()).await?;
    if ctx.json() {
        output::print_json(&list);
        return Ok(());
    }
    if list.is_empty() {
        eprintln!("No instances.");
        return Ok(());
    }
    let mut t = output::table(ctx, &["SLUG", "NAME", "TENANT", "ENV", "STATUS", "HEALTH", "TEMPLATE"]);
    for i in &list {
        t.add_row(vec![
            comfy_table::Cell::new(&i.slug),
            comfy_table::Cell::new(&i.name),
            comfy_table::Cell::new(&i.tenant_name),
            comfy_table::Cell::new(&i.environment),
            output::status_cell(ctx, &i.status),
            output::status_cell(ctx, &i.health),
            comfy_table::Cell::new(format!(
                "{}@{}{}",
                i.template.name,
                i.template.version,
                if i.simulated { " (simulated)" } else { "" }
            )),
        ]);
    }
    crate::outln!("{t}");
    Ok(())
}

fn selected_slug(ctx: &Ctx, sel: &InstanceSelector) -> Result<String> {
    sel.instance.clone().or_else(|| ctx.project.as_ref().and_then(|p| p.config.instance.slug.clone())).ok_or_else(
        || {
            CliError::usage(
                "no instance selected",
                Some("pass --instance SLUG or set [instance].slug in .ork/config.toml".into()),
            )
        },
    )
}

pub async fn deploy(ctx: &Ctx, args: DeployArgs) -> Result<()> {
    let slug = selected_slug(ctx, &args.selector)?;
    let api = client(ctx)?;
    let instance = api.instance_by_slug(&slug).await?;
    let d: Deployment = api.post(&format!("/instances/{}/deploy", instance.id), &json!({})).await?;
    output::note(ctx, &format!("Deployment {} queued for {slug} (correlation id {}).", d.id, d.correlation_id));
    if !args.wait {
        if ctx.json() {
            output::print_json(&d);
        }
        return Ok(());
    }
    let finished = follow(ctx, &api, &d.id, Duration::from_secs(args.timeout)).await?;
    finish(ctx, finished)
}

/// Polls events and status until the deployment reaches a terminal status.
async fn follow(ctx: &Ctx, api: &ApiClient, id: &str, timeout: Duration) -> Result<Deployment> {
    let start = Instant::now();
    let mut after: Option<String> = None;
    let spinner = (!ctx.json() && ctx.interactive).then(|| {
        let pb = ProgressBar::new_spinner();
        pb.set_style(
            ProgressStyle::with_template("{spinner} {elapsed} {msg}")
                .unwrap_or_else(|_| ProgressStyle::default_spinner()),
        );
        pb.enable_steady_tick(Duration::from_millis(120));
        pb
    });
    let mut announced_approval = false;
    loop {
        let mut q = Vec::new();
        if let Some(a) = &after {
            q.push(("after", a.clone()));
        }
        let events: Vec<DeploymentEvent> = api.get(&format!("/deployments/{id}/events"), &q).await?;
        for e in &events {
            let line = format!(
                "{} {:5} {}{}",
                e.at.get(11..19).unwrap_or(&e.at),
                e.level.to_uppercase(),
                e.step_key.as_ref().map(|s| format!("[{s}] ")).unwrap_or_default(),
                e.message
            );
            if ctx.json() {
                // NDJSON progress on stderr keeps stdout a single JSON document.
                eprintln!("{}", serde_json::to_string(e).unwrap_or_default());
            } else if let Some(pb) = &spinner {
                pb.println(line);
            } else {
                eprintln!("{line}");
            }
        }
        if let Some(last) = events.last() {
            after = Some(last.id.clone());
        }
        let d: Deployment = api.get(&format!("/deployments/{id}"), &[]).await?;
        if let Some(pb) = &spinner {
            pb.set_message(d.status.clone());
        }
        if d.status == "AWAITING_APPROVAL" && !announced_approval {
            announced_approval = true;
            output::note(ctx, "Waiting for approval in the console…");
        }
        if is_terminal_status(&d.status) {
            if let Some(pb) = spinner {
                pb.finish_and_clear();
            }
            return Ok(d);
        }
        if start.elapsed() > timeout {
            if let Some(pb) = spinner {
                pb.finish_and_clear();
            }
            return Err(CliError::failed(
                format!("timed out after {}s waiting for deployment {id} (status {})", timeout.as_secs(), d.status),
                Some("the deployment keeps running; follow it in the console".into()),
            ));
        }
        tokio::time::sleep(Duration::from_millis(1500)).await;
    }
}

fn finish(ctx: &Ctx, d: Deployment) -> Result<()> {
    if ctx.json() {
        output::print_json(&d);
    }
    if d.status == "SUCCEEDED" {
        output::note(ctx, &format!("Deployment {} succeeded.", d.id));
        Ok(())
    } else {
        Err(CliError::failed(
            format!("deployment {} finished with status {}", d.id, d.status),
            d.error_message.clone().map(|m| {
                format!("{}: {m}\ncorrelation id: {}", d.error_class.clone().unwrap_or_default(), d.correlation_id)
            }),
        ))
    }
}

pub async fn status(ctx: &Ctx, sel: InstanceSelector) -> Result<()> {
    let slug = selected_slug(ctx, &sel)?;
    let api = client(ctx)?;
    let i: Value = {
        let inst: Instance = api.instance_by_slug(&slug).await?;
        api.get(&format!("/instances/{}", inst.id), &[]).await?
    };
    if ctx.json() {
        output::print_json(&i);
        return Ok(());
    }
    let f = |p: &str| i.pointer(p).and_then(Value::as_str).unwrap_or("-").to_string();
    crate::outln!("{} {} ({})", heading(ctx, "Instance:"), f("/name"), f("/slug"));
    crate::outln!("{} {}   {} {}", heading(ctx, "Status:"), f("/status"), heading(ctx, "Health:"), f("/health"));
    crate::outln!(
        "{} {}@{}   {} {}",
        heading(ctx, "Template:"),
        f("/template/name"),
        f("/template/version"),
        heading(ctx, "Tenant:"),
        f("/tenantName")
    );
    if let Some(d) = i.get("lastDeployment").filter(|d| !d.is_null()) {
        let g = |k: &str| d.get(k).and_then(Value::as_str).unwrap_or("-").to_string();
        crate::outln!(
            "{} {} {} {} ({})",
            heading(ctx, "Last deployment:"),
            g("kind"),
            g("status"),
            g("queuedAt"),
            g("id")
        );
    }
    let resources = i.get("resources").and_then(Value::as_array).cloned().unwrap_or_default();
    if !resources.is_empty() {
        let mut t =
            output::table(ctx, &["RESOURCE", "TYPE", "SLOT", "PROVIDER", "REGION", "STATUS", "HEALTH", "DRIFT"]);
        for r in &resources {
            let g = |k: &str| r.get(k).and_then(Value::as_str).unwrap_or("-").to_string();
            t.add_row(vec![
                comfy_table::Cell::new(g("resourceId")),
                comfy_table::Cell::new(g("type")),
                comfy_table::Cell::new(g("slot")),
                comfy_table::Cell::new(format!("{} {}", g("provider"), g("capability"))),
                comfy_table::Cell::new(g("region")),
                output::status_cell(ctx, &g("status")),
                output::status_cell(ctx, &g("health")),
                comfy_table::Cell::new(g("drift")),
            ]);
        }
        crate::outln!("{t}");
    }
    Ok(())
}

pub async fn logs(ctx: &Ctx, args: LogsArgs) -> Result<()> {
    let slug = selected_slug(ctx, &args.selector)?;
    let api = client(ctx)?;
    let inst = api.instance_by_slug(&slug).await?;
    let out: Value = api
        .get(
            &format!("/instances/{}/logs", inst.id),
            &[("resourceId", args.resource.clone()), ("limit", args.limit.to_string())],
        )
        .await?;
    if ctx.json() {
        output::print_json(&out);
        return Ok(());
    }
    if let Some(n) = out.get("note").and_then(Value::as_str) {
        eprintln!("{n}");
    }
    for l in out.get("lines").and_then(Value::as_array).into_iter().flatten() {
        let g = |k: &str| l.get(k).and_then(Value::as_str).unwrap_or("").to_string();
        crate::outln!("{} {:5} {}", g("timestamp"), g("level").to_uppercase(), g("message"));
    }
    Ok(())
}

pub async fn destroy(ctx: &Ctx, args: DestroyArgs) -> Result<()> {
    if args.confirm != args.instance {
        return Err(CliError::usage(
            format!("--confirm must repeat the instance slug exactly (got {:?})", args.confirm),
            None,
        ));
    }
    let api = client(ctx)?;
    let inst = api.instance_by_slug(&args.instance).await?;
    let d: Deployment =
        api.post(&format!("/instances/{}/destroy", inst.id), &json!({ "confirm": args.confirm })).await?;
    output::note(ctx, &format!("Destroy {} queued for {}.", d.id, args.instance));
    if !args.wait {
        if ctx.json() {
            output::print_json(&d);
        }
        return Ok(());
    }
    let finished = follow(ctx, &api, &d.id, Duration::from_secs(args.timeout)).await?;
    finish(ctx, finished)
}
