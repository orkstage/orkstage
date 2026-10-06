mod auth;
mod operate;
mod project;
mod template;

use std::path::{Path, PathBuf};

use clap::CommandFactory;
use orkstage_scan::{ScanOptions, ScanReport, scan_files};

use crate::api::ApiClient;
use crate::cli::{Cli, Command, TemplateCommand};
use crate::config::Ctx;
use crate::credentials;
use crate::error::{CliError, Result};
use crate::walk::{self, Walked};

pub async fn run(cli: Cli, ctx: Ctx) -> Result<()> {
    match cli.command {
        Command::Login(args) => auth::login(&ctx, args).await,
        Command::Logout => auth::logout(&ctx),
        Command::Whoami => auth::whoami(&ctx).await,
        Command::Init(args) => project::init(&ctx, args).await,
        Command::Scan(args) => project::scan(&ctx, args),
        Command::Template(TemplateCommand::Validate(a)) => template::validate(&ctx, a).await,
        Command::Template(TemplateCommand::Push(a)) => template::push(&ctx, a).await,
        Command::Template(TemplateCommand::Diff(a)) => template::diff(&ctx, a).await,
        Command::Import(args) => operate::import(&ctx, args).await,
        Command::Instances(cmd) => operate::instances(&ctx, cmd).await,
        Command::Deploy(args) => operate::deploy(&ctx, args).await,
        Command::Status(sel) => operate::status(&ctx, sel).await,
        Command::Logs(args) => operate::logs(&ctx, args).await,
        Command::Destroy(args) => operate::destroy(&ctx, args).await,
        Command::Completions { shell } => {
            clap_complete::generate(shell, &mut Cli::command(), "ork", &mut std::io::stdout());
            Ok(())
        }
    }
}

/// API client with the token from --token/ORK_TOKEN, else the credential store.
pub fn client(ctx: &Ctx) -> Result<ApiClient> {
    let api_url = ctx.require_api_url()?;
    let token = match &ctx.token_override {
        Some(t) => t.clone(),
        None => credentials::load(&api_url)?.ok_or(CliError::NotLoggedIn { api_url: api_url.clone() })?,
    };
    ApiClient::new(&api_url, &token)
}

pub fn resolve_path(ctx: &Ctx, path: Option<&Path>) -> PathBuf {
    match path {
        Some(p) if p.is_absolute() => p.to_path_buf(),
        Some(p) => ctx.cwd.join(p),
        None => ctx.root().to_path_buf(),
    }
}

/// Walks `root` and runs the engine. The template is named after the project.
pub fn scan_project(
    ctx: &Ctx,
    root: &Path,
    max_bytes: Option<usize>,
    template_name: Option<String>,
) -> Result<(ScanReport, Walked)> {
    let scan_cfg = ctx.project.as_ref().map(|p| p.config.scan.clone()).unwrap_or_default();
    let max = max_bytes.or(scan_cfg.max_file_bytes).unwrap_or(orkstage_scan::DEFAULT_MAX_FILE_BYTES);
    let mut walked = walk::collect(root, &scan_cfg.include, &scan_cfg.exclude, max)?;
    let name = template_name
        .or_else(|| ctx.project.as_ref().and_then(|p| p.config.template.name.clone()))
        .or_else(|| default_name(root));
    let opts = ScanOptions { template_name: name, max_file_bytes: Some(max), ..Default::default() };
    let started = std::time::Instant::now();
    let mut report = scan_files(&walked.files, &opts);
    walked.scan_ms = started.elapsed().as_millis();
    for f in &walked.skipped_large {
        report.warnings.push(format!("{f}: skipped, larger than {max} bytes"));
    }
    Ok((report, walked))
}

pub fn default_name(root: &Path) -> Option<String> {
    let base = root.canonicalize().ok()?.file_name()?.to_string_lossy().to_string();
    let mut out = String::new();
    for c in base.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    let out = out.trim_matches('-').trim_start_matches(|c: char| c.is_ascii_digit()).to_string();
    (out.len() >= 2).then_some(out)
}
