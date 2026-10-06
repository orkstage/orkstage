//! Thin client for the OrkStage REST API (`/api/v1`), authenticated with an API key.
//! Errors keep the platform's `{ error: { code, message, correlationId } }`.

use std::time::Duration;

use reqwest::{Method, StatusCode};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tracing::debug;

use crate::error::{CliError, Result};

pub struct ApiClient {
    http: reqwest::Client,
    pub api_url: String,
    token: String,
}

#[derive(Debug, Deserialize)]
struct ErrorBody {
    error: ErrorDetail,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ErrorDetail {
    #[serde(default)]
    code: String,
    #[serde(default)]
    message: String,
    #[serde(default)]
    correlation_id: Option<String>,
    #[serde(default)]
    details: Option<Value>,
}

impl ApiClient {
    pub fn new(api_url: &str, token: &str) -> Result<Self> {
        let http = reqwest::Client::builder()
            .user_agent(concat!("ork/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(120))
            .build()
            .map_err(|e| CliError::failed(format!("cannot build the HTTP client: {e}"), None))?;
        Ok(ApiClient { http, api_url: api_url.to_string(), token: token.trim().to_string() })
    }

    fn url(&self, path: &str) -> String {
        format!("{}/api/v1{}", self.api_url, path)
    }

    pub async fn request<T: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        query: &[(&str, String)],
        body: Option<&Value>,
    ) -> Result<T> {
        let url = self.url(path);
        debug!("{method} {url}");
        let mut req =
            self.http.request(method.clone(), &url).bearer_auth(&self.token).header("accept", "application/json");
        if !query.is_empty() {
            req = req.query(query);
        }
        if let Some(b) = body {
            req = req.json(b);
        }
        let resp =
            req.send().await.map_err(|e| CliError::Network { url: self.api_url.clone(), detail: e.to_string() })?;
        let status = resp.status();
        let header_correlation =
            resp.headers().get("x-correlation-id").and_then(|v| v.to_str().ok()).map(str::to_string);
        let bytes =
            resp.bytes().await.map_err(|e| CliError::Network { url: self.api_url.clone(), detail: e.to_string() })?;
        if status.is_success() {
            let slice: &[u8] = if bytes.is_empty() { b"null" } else { &bytes };
            return serde_json::from_slice(slice).map_err(|e| {
                CliError::failed(
                    format!("unexpected response from {method} {path}: {e}"),
                    Some("the CLI and the platform versions may not match".into()),
                )
            });
        }
        let parsed: Option<ErrorBody> = serde_json::from_slice(&bytes).ok();
        let (code, message, correlation_id, details) = match parsed {
            Some(b) => (b.error.code, b.error.message, b.error.correlation_id.or(header_correlation), b.error.details),
            None => (
                status.canonical_reason().unwrap_or("HTTP_ERROR").to_ascii_uppercase().replace(' ', "_"),
                String::from_utf8_lossy(&bytes).chars().take(300).collect(),
                header_correlation,
                None,
            ),
        };
        Err(api_error(status, &method, path, code, message, correlation_id, details))
    }

    pub async fn get<T: DeserializeOwned>(&self, path: &str, query: &[(&str, String)]) -> Result<T> {
        self.request(Method::GET, path, query, None).await
    }

    pub async fn post<T: DeserializeOwned>(&self, path: &str, body: &Value) -> Result<T> {
        self.request(Method::POST, path, &[], Some(body)).await
    }
}

fn api_error(
    status: StatusCode,
    method: &Method,
    path: &str,
    code: String,
    message: String,
    correlation_id: Option<String>,
    details: Option<Value>,
) -> CliError {
    let mut help: Vec<String> = Vec::new();
    match status.as_u16() {
        401 => {
            help.push("the API key is missing, expired or revoked: run `ork login` again or update ORK_TOKEN".into())
        }
        403 => help.push("the API key's role or scopes do not allow this; create a key with the needed scope".into()),
        404 if message.is_empty()
            || message.starts_with("Cannot ")
            || message.to_ascii_lowercase().contains("route") =>
        {
            help.push(format!("{method} /api/v1{path} is not available on this platform version"))
        }
        404 => {}
        409 => help.push("another operation is in progress; retry when it finishes".into()),
        _ => {}
    }
    if let Some(issues) = details.as_ref().and_then(|d| d.get("issues")).and_then(Value::as_array) {
        for i in issues.iter().take(10) {
            let msg = i.get("message").and_then(Value::as_str).unwrap_or("");
            let p = i.get("path").and_then(Value::as_str).unwrap_or("");
            help.push(if p.is_empty() { msg.to_string() } else { format!("{p}: {msg}") });
        }
    }
    if let Some(c) = &correlation_id {
        help.push(format!("correlation id: {c}"));
    }
    let message = if message.is_empty() {
        format!("{method} {path} failed with HTTP {}", status.as_u16())
    } else {
        format!("{message} ({method} {path}, HTTP {})", status.as_u16())
    };
    CliError::Api {
        status: status.as_u16(),
        code,
        message,
        correlation_id,
        help: (!help.is_empty()).then(|| help.join("\n")),
    }
}

// ── DTOs (subset of packages/contracts; unknown fields ignored) ──────────────

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Page<T> {
    pub items: Vec<T>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TemplateVersion {
    pub id: String,
    pub version: String,
    pub status: String,
    pub source: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Template {
    pub id: String,
    pub name: String,
    pub display_name: String,
    pub visibility: String,
    pub latest_published: Option<TemplateVersion>,
    pub versions: Option<Vec<TemplateVersion>>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct InstanceTemplate {
    pub name: String,
    pub version: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Instance {
    pub id: String,
    pub tenant_id: String,
    pub tenant_name: String,
    pub name: String,
    pub slug: String,
    pub environment: String,
    pub status: String,
    pub health: String,
    pub simulated: bool,
    pub template: InstanceTemplate,
    pub resources: Option<Vec<Value>>,
    pub last_deployment: Option<Deployment>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Deployment {
    pub id: String,
    pub kind: String,
    pub status: String,
    pub correlation_id: String,
    pub queued_at: String,
    pub finished_at: Option<String>,
    pub error_class: Option<String>,
    pub error_message: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DeploymentEvent {
    pub id: String,
    pub at: String,
    pub level: String,
    pub step_key: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Tenant {
    pub id: String,
    pub name: String,
    pub slug: String,
}

pub fn is_terminal_status(status: &str) -> bool {
    matches!(status, "SUCCEEDED" | "FAILED" | "PARTIALLY_FAILED" | "CANCELLED")
}

impl ApiClient {
    pub async fn tenants(&self) -> Result<Vec<Tenant>> {
        self.get("/tenants", &[]).await
    }

    /// Accepts a tenant slug, name or id.
    pub async fn resolve_tenant(&self, wanted: &str) -> Result<Tenant> {
        let tenants = self.tenants().await?;
        tenants
            .into_iter()
            .find(|t| t.id == wanted || t.slug == wanted || t.name.eq_ignore_ascii_case(wanted))
            .ok_or_else(|| {
                CliError::not_found(
                    format!("tenant \"{wanted}\" not found or not visible to this API key"),
                    Some("check `tenant` in .ork/config.toml or pass --tenant".into()),
                )
            })
    }

    pub async fn instances(&self, tenant_id: Option<&str>) -> Result<Vec<Instance>> {
        let mut out = Vec::new();
        let mut cursor: Option<String> = None;
        loop {
            let mut q = vec![("limit", "100".to_string())];
            if let Some(t) = tenant_id {
                q.push(("tenantId", t.to_string()));
            }
            if let Some(c) = &cursor {
                q.push(("cursor", c.clone()));
            }
            let page: Page<Instance> = self.get("/instances", &q).await?;
            out.extend(page.items);
            match page.next_cursor {
                Some(c) if out.len() < 10_000 => cursor = Some(c),
                _ => break,
            }
        }
        Ok(out)
    }

    pub async fn instance_by_slug(&self, slug: &str) -> Result<Instance> {
        let all = self.instances(None).await?;
        let found = all.into_iter().find(|i| i.slug == slug).ok_or_else(|| {
            CliError::not_found(
                format!("instance \"{slug}\" not found"),
                Some("list instances with `ork instances list`".into()),
            )
        })?;
        self.get(&format!("/instances/{}", found.id), &[]).await
    }

    pub async fn template_by_name(&self, name: &str) -> Result<Option<Template>> {
        let all: Vec<Template> = self.get("/templates", &[]).await?;
        match all.into_iter().find(|t| t.name == name) {
            Some(t) => Ok(Some(self.get(&format!("/templates/{}", t.id), &[]).await?)),
            None => Ok(None),
        }
    }
}
