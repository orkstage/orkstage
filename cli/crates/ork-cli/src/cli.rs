//! Command-line definition (clap derive).

use std::path::PathBuf;

use clap::{Args, Parser, Subcommand, ValueEnum};

#[derive(Debug, Parser)]
#[command(
    name = "ork",
    version,
    about = "OrkStage command line: scan a project into a template, push it, deploy and operate instances.",
    long_about = None,
    propagate_version = true,
    after_help = "Settings precedence: flags > environment (ORK_*) > .ork/config.toml > user config.\nExit codes: 0 ok, 1 failure, 2 usage, 3 authentication, 4 not found."
)]
pub struct Cli {
    #[command(flatten)]
    pub global: Global,
    #[command(subcommand)]
    pub command: Command,
}

#[derive(Debug, Clone, Args)]
pub struct Global {
    /// OrkStage API base URL, e.g. https://orkstage.example.com (without /api/v1).
    #[arg(long, global = true, env = "ORK_API_URL", value_name = "URL")]
    pub api_url: Option<String>,

    /// API key (ork_live_… / ork_test_…). Prefer ORK_TOKEN or `ork login` over this flag.
    #[arg(long, global = true, env = "ORK_TOKEN", hide_env_values = true, value_name = "TOKEN")]
    pub token: Option<String>,

    /// Output format.
    #[arg(long, short = 'o', global = true, value_enum, env = "ORK_OUTPUT", default_value_t = OutputFormat::Table)]
    pub output: OutputFormat,

    /// Disable colors (also honoured: NO_COLOR).
    #[arg(long, global = true)]
    pub no_color: bool,

    /// More logs (-v info, -vv debug, -vvv trace). Logs go to stderr.
    #[arg(long, short = 'v', global = true, action = clap::ArgAction::Count)]
    pub verbose: u8,

    /// Run as if started in this directory.
    #[arg(long = "chdir", short = 'C', global = true, value_name = "DIR")]
    pub chdir: Option<PathBuf>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum OutputFormat {
    Table,
    Json,
}

#[derive(Debug, Subcommand)]
pub enum Command {
    /// Store an API key for an OrkStage API (per API URL, outside the project).
    Login(LoginArgs),
    /// Forget the stored API key for the API URL.
    Logout,
    /// Show who the current credentials belong to.
    Whoami,
    /// Create .ork/ in the project root from a scan.
    Init(InitArgs),
    /// Detect infrastructure and services in a project and print the ScanReport.
    Scan(ScanArgs),
    /// Validate, push and diff the project template.
    #[command(subcommand)]
    Template(TemplateCommand),
    /// Scan locally and create an import (draft template) on the platform.
    Import(ImportArgs),
    /// List and inspect instances.
    #[command(subcommand)]
    Instances(InstancesCommand),
    /// Deploy an instance.
    Deploy(DeployArgs),
    /// Show an instance, its resources and the last deployment.
    Status(InstanceSelector),
    /// Show recent logs of an instance resource.
    Logs(LogsArgs),
    /// Destroy an instance (asks for the slug as confirmation).
    Destroy(DestroyArgs),
    /// Print shell completions.
    Completions {
        #[arg(value_enum)]
        shell: clap_complete::Shell,
    },
}

#[derive(Debug, Args)]
pub struct LoginArgs {
    // The key itself comes from the global `--token` / ORK_TOKEN, stdin or a prompt.
    /// Read the API key from stdin (CI-friendly).
    #[arg(long)]
    pub with_token: bool,
    /// Store the key without calling /me first.
    #[arg(long)]
    pub no_verify: bool,
}

#[derive(Debug, Args)]
pub struct InitArgs {
    /// Template name (default: the directory name).
    #[arg(long)]
    pub name: Option<String>,
    /// Tenant slug or id the project deploys to.
    #[arg(long)]
    pub tenant: Option<String>,
    /// Instance environment.
    #[arg(long, value_parser = ["production", "staging", "development", "sandbox"])]
    pub environment: Option<String>,
    /// Accept defaults, never prompt.
    #[arg(long, short = 'y')]
    pub yes: bool,
    /// Overwrite an existing .ork/ configuration.
    #[arg(long)]
    pub force: bool,
    /// Project directory (default: current directory).
    pub path: Option<PathBuf>,
}

#[derive(Debug, Args)]
pub struct ScanArgs {
    /// Directory to scan (default: the project root or the current directory).
    pub path: Option<PathBuf>,
    /// Report format (defaults to --output).
    #[arg(long, value_enum)]
    pub format: Option<OutputFormat>,
    /// Update .ork/inventory.json and .ork/template.yaml.
    #[arg(long)]
    pub write: bool,
    /// Skip files larger than this many bytes.
    #[arg(long, value_name = "BYTES")]
    pub max_file_bytes: Option<usize>,
}

#[derive(Debug, Subcommand)]
pub enum TemplateCommand {
    /// Validate the template with the platform (POST /templates/validate).
    Validate(TemplateFileArgs),
    /// Create the template or add a new version (patch version bumped automatically).
    Push(TemplateFileArgs),
    /// Show the difference between the local template and the latest server version.
    Diff(TemplateDiffArgs),
}

#[derive(Debug, Args)]
pub struct TemplateFileArgs {
    /// Template file (default: .ork/template.yaml).
    #[arg(long, short = 'f')]
    pub file: Option<PathBuf>,
    /// Also check against a plan's entitlements.
    #[arg(long, value_parser = ["FREE", "SANDBOX", "STARTER", "GROWTH", "SCALE"])]
    pub plan: Option<String>,
}

#[derive(Debug, Args)]
pub struct TemplateDiffArgs {
    #[arg(long, short = 'f')]
    pub file: Option<PathBuf>,
    /// Exit with 1 when the templates differ.
    #[arg(long)]
    pub exit_code: bool,
}

#[derive(Debug, Args)]
pub struct ImportArgs {
    /// Directory to scan (default: the project root or the current directory).
    pub path: Option<PathBuf>,
    /// Tenant slug or id (default: .ork/config.toml).
    #[arg(long)]
    pub tenant: Option<String>,
}

#[derive(Debug, Subcommand)]
pub enum InstancesCommand {
    /// List instances you can see.
    List {
        /// Only this tenant (slug or id).
        #[arg(long)]
        tenant: Option<String>,
    },
}

#[derive(Debug, Args)]
pub struct InstanceSelector {
    /// Instance slug (default: .ork/config.toml [instance].slug).
    #[arg(long, short = 'i')]
    pub instance: Option<String>,
}

#[derive(Debug, Args)]
pub struct DeployArgs {
    #[command(flatten)]
    pub selector: InstanceSelector,
    /// Stream deployment events until it finishes; exit non-zero on failure.
    #[arg(long, short = 'w')]
    pub wait: bool,
    /// Give up waiting after this many seconds.
    #[arg(long, default_value_t = 3600)]
    pub timeout: u64,
}

#[derive(Debug, Args)]
pub struct LogsArgs {
    /// Template resource id, e.g. `api`.
    pub resource: String,
    #[command(flatten)]
    pub selector: InstanceSelector,
    /// Number of lines.
    #[arg(long, short = 'n', default_value_t = 50)]
    pub limit: u32,
}

#[derive(Debug, Args)]
pub struct DestroyArgs {
    /// Instance slug.
    #[arg(long, short = 'i')]
    pub instance: String,
    /// Repeat the slug to confirm.
    #[arg(long)]
    pub confirm: String,
    /// Wait for the destroy to finish.
    #[arg(long, short = 'w')]
    pub wait: bool,
    #[arg(long, default_value_t = 3600)]
    pub timeout: u64,
}
