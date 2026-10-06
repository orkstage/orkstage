//! `.ork/config.toml` (project, committed) and the user config (per machine), plus the
//! resolved settings with precedence flags > env > project > user.

use std::collections::BTreeMap;
use std::io::IsTerminal;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::cli::{Global, OutputFormat};
use crate::error::{CliError, Result};

pub const ORK_DIR: &str = ".ork";

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct ProjectConfig {
    pub api_url: Option<String>,
    pub tenant: Option<String>,
    pub template: TemplateSection,
    pub instance: InstanceSection,
    pub placements: BTreeMap<String, Binding>,
    pub scan: ScanSection,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct TemplateSection {
    pub name: Option<String>,
    pub file: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct InstanceSection {
    pub slug: Option<String>,
    pub environment: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Binding {
    /// Cloud target name (or id) registered on the platform.
    pub target: String,
    pub region: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct ScanSection {
    /// Globs (gitignore syntax) to scan; empty means everything.
    pub include: Vec<String>,
    /// Globs to skip, in addition to .gitignore and the built-in skips.
    pub exclude: Vec<String>,
    pub max_file_bytes: Option<usize>,
}

/// Per-user settings, never in the project: `<config dir>/config.toml`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct UserConfig {
    pub api_url: Option<String>,
    pub console_url: Option<String>,
    pub tenant: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Project {
    pub root: PathBuf,
    pub config: ProjectConfig,
}

impl Project {
    pub fn ork_dir(&self) -> PathBuf {
        self.root.join(ORK_DIR)
    }

    pub fn template_path(&self) -> PathBuf {
        match &self.config.template.file {
            Some(f) => self.root.join(f),
            None => self.ork_dir().join("template.yaml"),
        }
    }
}

/// Directory for user config and the credentials fallback. `ORK_CONFIG_DIR` overrides it.
pub fn user_config_dir() -> Result<PathBuf> {
    if let Some(dir) = std::env::var_os("ORK_CONFIG_DIR") {
        return Ok(PathBuf::from(dir));
    }
    directories::ProjectDirs::from("dev", "OrkStage", "ork").map(|d| d.config_dir().to_path_buf()).ok_or_else(|| {
        CliError::failed("cannot determine the user configuration directory", Some("set ORK_CONFIG_DIR".into()))
    })
}

pub fn load_user_config() -> Result<UserConfig> {
    let path = user_config_dir()?.join("config.toml");
    match std::fs::read_to_string(&path) {
        Ok(s) => toml::from_str(&s).map_err(|e| CliError::failed(format!("{}: {e}", path.display()), None)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(UserConfig::default()),
        Err(e) => Err(CliError::io(format!("reading {}", path.display()), e)),
    }
}

pub fn save_user_config(cfg: &UserConfig) -> Result<()> {
    let dir = user_config_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| CliError::io(format!("creating {}", dir.display()), e))?;
    let text = toml::to_string_pretty(cfg).map_err(|e| CliError::failed(e.to_string(), None))?;
    let path = dir.join("config.toml");
    std::fs::write(&path, text).map_err(|e| CliError::io(format!("writing {}", path.display()), e))
}

/// Finds the nearest `.ork/config.toml` from `start` upwards.
pub fn find_project(start: &Path) -> Result<Option<Project>> {
    let mut dir = Some(start);
    while let Some(d) = dir {
        let cfg = d.join(ORK_DIR).join("config.toml");
        if cfg.is_file() {
            let text =
                std::fs::read_to_string(&cfg).map_err(|e| CliError::io(format!("reading {}", cfg.display()), e))?;
            let config: ProjectConfig = toml::from_str(&text).map_err(|e| {
                CliError::usage(
                    format!("{} is not valid: {e}", cfg.display()),
                    Some("fix the file or re-run `ork init --force`".into()),
                )
            })?;
            return Ok(Some(Project { root: d.to_path_buf(), config }));
        }
        dir = d.parent();
    }
    Ok(None)
}

/// Everything a command needs, resolved once.
pub struct Ctx {
    pub cwd: PathBuf,
    pub api_url: Option<String>,
    pub token_override: Option<String>,
    pub output: OutputFormat,
    pub color: bool,
    pub interactive: bool,
    pub project: Option<Project>,
    pub user: UserConfig,
}

pub fn normalize_url(url: &str) -> String {
    let u = url.trim().trim_end_matches('/');
    let u = u.strip_suffix("/api/v1").unwrap_or(u);
    u.to_string()
}

impl Ctx {
    pub fn new(g: &Global) -> Result<Ctx> {
        let cwd = match &g.chdir {
            Some(d) => d.clone(),
            None => std::env::current_dir().map_err(|e| CliError::io("reading the current directory", e))?,
        };
        let project = find_project(&cwd)?;
        let user = load_user_config()?;
        let api_url = g
            .api_url
            .clone()
            .or_else(|| project.as_ref().and_then(|p| p.config.api_url.clone()))
            .or_else(|| user.api_url.clone())
            .map(|u| normalize_url(&u));
        let color = !g.no_color && std::env::var_os("NO_COLOR").is_none() && std::io::stdout().is_terminal();
        let interactive =
            std::io::stdin().is_terminal() && std::io::stderr().is_terminal() && std::env::var_os("CI").is_none();
        Ok(Ctx {
            cwd,
            api_url,
            token_override: g.token.clone().filter(|t| !t.trim().is_empty()),
            output: g.output,
            color,
            interactive,
            project,
            user,
        })
    }

    pub fn json(&self) -> bool {
        self.output == OutputFormat::Json
    }

    pub fn require_api_url(&self) -> Result<String> {
        self.api_url.clone().ok_or_else(|| {
            CliError::usage(
                "no OrkStage API URL configured",
                Some("pass --api-url, set ORK_API_URL, add api_url to .ork/config.toml, or run `ork login --api-url URL`".into()),
            )
        })
    }

    pub fn tenant(&self) -> Option<String> {
        self.project.as_ref().and_then(|p| p.config.tenant.clone()).or_else(|| self.user.tenant.clone())
    }

    /// Web console URL: explicit config, else derived from the API URL (local :4000 → :3000).
    pub fn console_url(&self) -> Option<String> {
        if let Ok(u) = std::env::var("ORK_CONSOLE_URL") {
            return Some(normalize_url(&u));
        }
        if let Some(u) = &self.user.console_url {
            return Some(normalize_url(u));
        }
        let api = self.api_url.as_ref()?;
        let mut url = url::Url::parse(api).ok()?;
        if url.port() == Some(4000) {
            url.set_port(Some(3000)).ok()?;
        } else if let Some(host) = url.host_str().and_then(|h| h.strip_prefix("api.")).map(str::to_string) {
            url.set_host(Some(&host)).ok()?;
        }
        Some(normalize_url(url.as_str()))
    }

    /// Root used for scans and `.ork/`: the project root, else the working directory.
    pub fn root(&self) -> &Path {
        self.project.as_ref().map(|p| p.root.as_path()).unwrap_or(&self.cwd)
    }

    pub fn require_project(&self) -> Result<&Project> {
        self.project.as_ref().ok_or_else(|| {
            CliError::usage(
                "no .ork/ project found here or in a parent directory",
                Some("run `ork init` in the project root".into()),
            )
        })
    }
}

/// Renders `.ork/config.toml` with comments (hand-written so it stays readable).
pub fn render_project_config(c: &ProjectConfig) -> String {
    let q = |s: &str| toml::Value::String(s.to_string()).to_string();
    let mut out = String::new();
    out.push_str("# OrkStage project configuration (commit this file). Secrets never go here:\n");
    out.push_str("# API keys live in your OS keychain via `ork login`, or in ORK_TOKEN on CI.\n");
    match &c.api_url {
        Some(u) => out.push_str(&format!("api_url = {}\n", q(u))),
        None => out.push_str("# api_url = \"https://orkstage.example.com\"\n"),
    }
    match &c.tenant {
        Some(t) => out.push_str(&format!("tenant = {}\n", q(t))),
        None => out.push_str("# tenant = \"acme\"            # tenant slug or id\n"),
    }
    out.push_str("\n[template]\n");
    if let Some(n) = &c.template.name {
        out.push_str(&format!("name = {}\n", q(n)));
    }
    out.push_str("# file = \".ork/template.yaml\"\n");
    out.push_str("\n[instance]\n");
    if let Some(s) = &c.instance.slug {
        out.push_str(&format!("slug = {}\n", q(s)));
    }
    if let Some(e) = &c.instance.environment {
        out.push_str(&format!("environment = {}\n", q(e)));
    }
    out.push_str(
        "\n# Placement slot → cloud target (name or id) and region, one line per slot of the template.\n[placements]\n",
    );
    for (slot, b) in &c.placements {
        out.push_str(&format!("{slot} = {{ target = {}, region = {} }}\n", q(&b.target), q(&b.region)));
    }
    out.push_str("\n[scan]\n");
    let list = |v: &[String]| v.iter().map(|s| q(s)).collect::<Vec<_>>().join(", ");
    out.push_str(&format!("include = [{}]\n", list(&c.scan.include)));
    out.push_str(&format!("exclude = [{}]\n", list(&c.scan.exclude)));
    if let Some(m) = c.scan.max_file_bytes {
        out.push_str(&format!("max_file_bytes = {m}\n"));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rendered_config_round_trips() {
        let mut c = ProjectConfig {
            api_url: Some("http://localhost:4000".into()),
            tenant: Some("acme".into()),
            ..Default::default()
        };
        c.template.name = Some("shop".into());
        c.instance.slug = Some("shop-staging".into());
        c.instance.environment = Some("staging".into());
        c.placements.insert("primary".into(), Binding { target: "aws-dev".into(), region: "us-east-1".into() });
        c.scan.exclude = vec!["examples/**".into()];
        let parsed: ProjectConfig = toml::from_str(&render_project_config(&c)).unwrap();
        assert_eq!(parsed, c);
        assert_eq!(normalize_url("http://x:4000/api/v1/"), "http://x:4000");
    }
}
