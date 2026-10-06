//! `ork`: the OrkStage command line.

mod api;
mod cli;
mod commands;
mod config;
mod credentials;
mod error;
mod output;
mod walk;

use std::process::ExitCode;

use clap::Parser;
use tracing_subscriber::EnvFilter;

use crate::cli::Cli;
use crate::config::Ctx;
use crate::error::{CliError, EXIT_USAGE};

fn main() -> ExitCode {
    let cli = match Cli::try_parse() {
        Ok(c) => c,
        Err(e) => {
            let code = if e.use_stderr() { EXIT_USAGE } else { 0 };
            let _ = e.print();
            return ExitCode::from(code);
        }
    };
    init_tracing(cli.global.verbose);
    let json = cli.global.output == cli::OutputFormat::Json;
    let no_color = cli.global.no_color || std::env::var_os("NO_COLOR").is_some();

    let result = Ctx::new(&cli.global).and_then(|ctx| {
        // rustls needs a process-wide crypto provider; ring keeps cross-compiling simple.
        let _ = rustls::crypto::ring::default_provider().install_default();
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .map_err(|e| CliError::failed(format!("cannot start the async runtime: {e}"), None))?;
        rt.block_on(commands::run(cli, ctx))
    });

    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            report(&err, json, no_color);
            ExitCode::from(err.exit_code())
        }
    }
}

fn report(err: &CliError, json: bool, no_color: bool) {
    if json {
        eprintln!("{}", serde_json::to_string_pretty(&err.to_json()).unwrap_or_default());
        return;
    }
    let theme = if no_color || !std::io::IsTerminal::is_terminal(&std::io::stderr()) {
        miette::GraphicalTheme::unicode_nocolor()
    } else {
        miette::GraphicalTheme::unicode()
    };
    let handler = miette::GraphicalReportHandler::new_themed(theme);
    let mut out = String::new();
    if handler.render_report(&mut out, err).is_ok() {
        eprint!("{out}");
    } else {
        eprintln!("error: {err}");
    }
}

fn init_tracing(verbose: u8) {
    let default = match verbose {
        0 => "warn",
        1 => "info",
        2 => "debug",
        _ => "trace",
    };
    let filter = EnvFilter::try_from_env("ORK_LOG").unwrap_or_else(|_| EnvFilter::new(default));
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(std::io::stderr)
        .with_target(false)
        .without_time()
        .try_init();
}
