//! Errors with stable exit codes: 0 ok, 1 failure, 2 usage, 3 auth, 4 not found.

use miette::Diagnostic;
use serde_json::json;
use thiserror::Error;

pub const EXIT_FAILURE: u8 = 1;
pub const EXIT_USAGE: u8 = 2;
pub const EXIT_AUTH: u8 = 3;
pub const EXIT_NOT_FOUND: u8 = 4;

#[derive(Debug, Error, Diagnostic)]
pub enum CliError {
    #[error("{message}")]
    #[diagnostic(code(ork::usage))]
    Usage {
        message: String,
        #[help]
        help: Option<String>,
    },

    #[error("not logged in to {api_url}")]
    #[diagnostic(
        code(ork::auth),
        help("run `ork login --api-url {api_url}` or set ORK_TOKEN to an API key (ork_live_…)")
    )]
    NotLoggedIn { api_url: String },

    #[error("{message}")]
    #[diagnostic(code(ork::api))]
    Api {
        status: u16,
        code: String,
        message: String,
        correlation_id: Option<String>,
        #[help]
        help: Option<String>,
    },

    #[error("could not reach the OrkStage API at {url}")]
    #[diagnostic(code(ork::network), help("check --api-url / ORK_API_URL and your network: {detail}"))]
    Network { url: String, detail: String },

    #[error("{message}")]
    #[diagnostic(code(ork::not_found))]
    NotFound {
        message: String,
        #[help]
        help: Option<String>,
    },

    #[error("{message}")]
    #[diagnostic(code(ork::failed))]
    Failed {
        message: String,
        #[help]
        help: Option<String>,
    },

    #[error("{context}: {source}")]
    #[diagnostic(code(ork::io))]
    Io {
        context: String,
        #[source]
        source: std::io::Error,
    },
}

pub type Result<T, E = CliError> = std::result::Result<T, E>;

impl CliError {
    pub fn usage(message: impl Into<String>, help: impl Into<Option<String>>) -> Self {
        CliError::Usage { message: message.into(), help: help.into() }
    }

    pub fn failed(message: impl Into<String>, help: impl Into<Option<String>>) -> Self {
        CliError::Failed { message: message.into(), help: help.into() }
    }

    pub fn not_found(message: impl Into<String>, help: impl Into<Option<String>>) -> Self {
        CliError::NotFound { message: message.into(), help: help.into() }
    }

    pub fn io(context: impl Into<String>, source: std::io::Error) -> Self {
        CliError::Io { context: context.into(), source }
    }

    pub fn exit_code(&self) -> u8 {
        match self {
            CliError::Usage { .. } => EXIT_USAGE,
            CliError::NotLoggedIn { .. } => EXIT_AUTH,
            CliError::Api { status: 401 | 403, .. } => EXIT_AUTH,
            CliError::Api { status: 404, .. } | CliError::NotFound { .. } => EXIT_NOT_FOUND,
            _ => EXIT_FAILURE,
        }
    }

    fn code(&self) -> String {
        match self {
            CliError::Usage { .. } => "USAGE".into(),
            CliError::NotLoggedIn { .. } => "NOT_LOGGED_IN".into(),
            CliError::Api { code, .. } => code.clone(),
            CliError::Network { .. } => "NETWORK".into(),
            CliError::NotFound { .. } => "NOT_FOUND".into(),
            CliError::Failed { .. } => "FAILED".into(),
            CliError::Io { .. } => "IO".into(),
        }
    }

    /// Machine-readable form for `--output json` (printed on stderr).
    pub fn to_json(&self) -> serde_json::Value {
        let help = match self {
            CliError::Usage { help, .. }
            | CliError::Api { help, .. }
            | CliError::NotFound { help, .. }
            | CliError::Failed { help, .. } => help.clone(),
            other => other.help().map(|h| h.to_string()),
        };
        let correlation = match self {
            CliError::Api { correlation_id, .. } => correlation_id.clone(),
            _ => None,
        };
        let status = match self {
            CliError::Api { status, .. } => Some(*status),
            _ => None,
        };
        json!({
            "error": {
                "code": self.code(),
                "message": self.to_string(),
                "status": status,
                "correlationId": correlation,
                "help": help,
                "exitCode": self.exit_code(),
            }
        })
    }
}
