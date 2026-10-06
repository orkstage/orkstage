//! API keys per API URL: the OS keychain (Keychain, Credential Manager, Secret Service), or
//! a 0600 `credentials.toml` in the user config directory when no keychain is reachable
//! (containers, headless CI). `ORK_CREDENTIALS_STORE=file` forces the file.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tracing::debug;

use crate::config::user_config_dir;
use crate::error::{CliError, Result};

const SERVICE: &str = "dev.orkstage.ork";

#[derive(Debug, Default, Serialize, Deserialize)]
struct CredentialsFile {
    #[serde(default)]
    tokens: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Store {
    Keyring,
    File,
}

impl Store {
    pub fn describe(self) -> &'static str {
        match self {
            Store::Keyring => "the OS keychain",
            Store::File => "the user credentials file (0600)",
        }
    }
}

fn file_forced() -> bool {
    std::env::var("ORK_CREDENTIALS_STORE").is_ok_and(|v| v.eq_ignore_ascii_case("file"))
}

fn file_path() -> Result<PathBuf> {
    Ok(user_config_dir()?.join("credentials.toml"))
}

fn read_file() -> Result<CredentialsFile> {
    let path = file_path()?;
    match std::fs::read_to_string(&path) {
        Ok(s) => toml::from_str(&s).map_err(|e| CliError::failed(format!("{} is corrupt: {e}", path.display()), None)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(CredentialsFile::default()),
        Err(e) => Err(CliError::io(format!("reading {}", path.display()), e)),
    }
}

fn write_file(c: &CredentialsFile) -> Result<()> {
    let path = file_path()?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| CliError::io(format!("creating {}", dir.display()), e))?;
    }
    let text = toml::to_string(c).map_err(|e| CliError::failed(e.to_string(), None))?;
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts.open(&path).map_err(|e| CliError::io(format!("writing {}", path.display()), e))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    std::io::Write::write_all(&mut f, text.as_bytes())
        .map_err(|e| CliError::io(format!("writing {}", path.display()), e))
}

fn keyring_entry(api_url: &str) -> Option<keyring::Entry> {
    if file_forced() {
        return None;
    }
    match keyring::Entry::new(SERVICE, api_url) {
        Ok(e) => Some(e),
        Err(e) => {
            debug!("keychain unavailable: {e}");
            None
        }
    }
}

pub fn save(api_url: &str, token: &str) -> Result<Store> {
    if let Some(entry) = keyring_entry(api_url) {
        match entry.set_password(token) {
            Ok(()) => {
                // Do not leave an older copy in the file.
                let _ = remove_from_file(api_url);
                return Ok(Store::Keyring);
            }
            Err(e) => debug!("keychain write failed, falling back to file: {e}"),
        }
    }
    let mut c = read_file()?;
    c.tokens.insert(api_url.to_string(), token.to_string());
    write_file(&c)?;
    Ok(Store::File)
}

pub fn load(api_url: &str) -> Result<Option<String>> {
    if let Some(entry) = keyring_entry(api_url) {
        match entry.get_password() {
            Ok(t) => return Ok(Some(t)),
            Err(e) => debug!("no keychain entry: {e}"),
        }
    }
    Ok(read_file()?.tokens.get(api_url).cloned())
}

fn remove_from_file(api_url: &str) -> Result<bool> {
    let mut c = read_file()?;
    let removed = c.tokens.remove(api_url).is_some();
    if removed {
        write_file(&c)?;
    }
    Ok(removed)
}

/// Returns whether anything was removed.
pub fn delete(api_url: &str) -> Result<bool> {
    let mut removed = false;
    if let Some(entry) = keyring_entry(api_url) {
        removed |= entry.delete_credential().is_ok();
    }
    removed |= remove_from_file(api_url)?;
    Ok(removed)
}
