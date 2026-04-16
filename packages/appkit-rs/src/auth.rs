use pyo3::prelude::*;
use reqwest::Client;
use serde::Deserialize;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

use crate::config::AppConfig;

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    #[allow(dead_code)]
    token_type: String,
    expires_in: u64,
}

struct CachedToken {
    token: String,
    expires_at: Instant,
}

/// OAuth M2M token provider using client credentials flow.
/// Acquires tokens via POST to `{DATABRICKS_HOST}/oidc/v1/token` and caches
/// them with a 30-second safety buffer before expiry.
pub struct M2MTokenProvider {
    host: String,
    client_id: String,
    client_secret: String,
    http_client: Client,
    cached: Mutex<Option<CachedToken>>,
}

impl M2MTokenProvider {
    pub fn new(host: String, client_id: String, client_secret: String) -> Self {
        Self {
            host: host.trim_end_matches('/').to_string(),
            client_id,
            client_secret,
            http_client: Client::new(),
            cached: Mutex::new(None),
        }
    }

    /// Get a valid token, refreshing if expired or not yet acquired.
    pub async fn get_token(&self) -> Result<String, String> {
        let mut guard = self.cached.lock().await;

        if let Some(ref cached) = *guard {
            if Instant::now() < cached.expires_at {
                return Ok(cached.token.clone());
            }
        }

        let token_url = format!("{}/oidc/v1/token", self.host);
        let resp = self
            .http_client
            .post(&token_url)
            .form(&[
                ("grant_type", "client_credentials"),
                ("client_id", self.client_id.as_str()),
                ("client_secret", self.client_secret.as_str()),
                ("scope", "all-apis"),
            ])
            .send()
            .await
            .map_err(|e| format!("Token request failed: {e}"))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("Token request returned {status}: {body}"));
        }

        let token_resp: TokenResponse = resp
            .json()
            .await
            .map_err(|e| format!("Failed to parse token response: {e}"))?;

        let expires_at =
            Instant::now() + Duration::from_secs(token_resp.expires_in.saturating_sub(30));
        let token = token_resp.access_token.clone();

        *guard = Some(CachedToken {
            token: token_resp.access_token,
            expires_at,
        });

        Ok(token)
    }
}

/// Service-level authentication context (service principal).
/// Analogous to TypeScript's ServiceContextState — holds M2M credentials
/// and provides token acquisition for service-principal API calls.
#[pyclass(frozen, module = "appkit")]
pub struct ServiceContext {
    pub token_provider: Arc<M2MTokenProvider>,
    #[pyo3(get)]
    pub config: AppConfig,
}

#[pymethods]
impl ServiceContext {
    #[new]
    #[pyo3(signature = (config))]
    pub fn new(config: AppConfig) -> PyResult<Self> {
        let client_id = config.client_id.clone().ok_or_else(|| {
            pyo3::exceptions::PyValueError::new_err(
                "DATABRICKS_CLIENT_ID is required for ServiceContext",
            )
        })?;
        let client_secret = config.client_secret.clone().ok_or_else(|| {
            pyo3::exceptions::PyValueError::new_err(
                "DATABRICKS_CLIENT_SECRET is required for ServiceContext",
            )
        })?;

        let provider =
            M2MTokenProvider::new(config.databricks_host.clone(), client_id, client_secret);

        Ok(Self {
            token_provider: Arc::new(provider),
            config,
        })
    }

    /// Acquire a valid service-principal access token (async).
    fn get_token<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyAny>> {
        let provider = self.token_provider.clone();
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            provider
                .get_token()
                .await
                .map_err(pyo3::exceptions::PyRuntimeError::new_err)
        })
    }

    fn __repr__(&self) -> String {
        format!("ServiceContext(host={:?})", self.config.databricks_host)
    }
}

/// Per-request user context for OBO (On-Behalf-Of) flows.
/// Analogous to TypeScript's UserContext — carries a forwarded user token,
/// identity headers, and inherited execution-scoped IDs (workspace, warehouse)
/// so connectors and route handlers can select service-principal vs per-user auth.
#[derive(Clone)]
#[pyclass(frozen, module = "appkit")]
pub struct UserContext {
    #[pyo3(get)]
    pub token: String,
    #[pyo3(get)]
    pub user_id: String,
    #[pyo3(get)]
    pub user_name: Option<String>,
    /// Inherited from ServiceContext — the workspace ID for this execution.
    #[pyo3(get)]
    pub workspace_id: String,
    /// Inherited from ServiceContext — optional warehouse ID (only present when
    /// a plugin requires the SQL_WAREHOUSE resource).
    #[pyo3(get)]
    pub warehouse_id: Option<String>,
}

#[pymethods]
impl UserContext {
    #[new]
    #[pyo3(signature = (token, user_id, *, user_name = None, workspace_id, warehouse_id = None))]
    pub fn new(
        token: String,
        user_id: String,
        user_name: Option<String>,
        workspace_id: String,
        warehouse_id: Option<String>,
    ) -> Self {
        Self {
            token,
            user_id,
            user_name,
            workspace_id,
            warehouse_id,
        }
    }

    /// Discriminator property — always `True` for UserContext.
    /// Mirrors TypeScript's `isUserContext: true` field.
    #[getter]
    fn is_user_context(&self) -> bool {
        true
    }

    fn __repr__(&self) -> String {
        format!(
            "UserContext(user_id={:?}, user_name={:?}, workspace_id={:?})",
            self.user_id, self.user_name, self.workspace_id
        )
    }

    fn __eq__(&self, other: &Self) -> bool {
        self.token == other.token
            && self.user_id == other.user_id
            && self.user_name == other.user_name
            && self.workspace_id == other.workspace_id
            && self.warehouse_id == other.warehouse_id
    }

    fn __hash__(&self) -> u64 {
        use std::hash::{Hash, Hasher};
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        self.user_id.hash(&mut hasher);
        self.workspace_id.hash(&mut hasher);
        hasher.finish()
    }
}

/// Discriminated execution context — either a service principal or a per-request user.
/// Mirrors TypeScript's `ExecutionContext = ServiceContextState | UserContext`.
pub enum ExecutionContext {
    Service(Arc<M2MTokenProvider>),
    User(UserContext),
}

impl ExecutionContext {
    /// Get the bearer token for the current context.
    pub async fn get_token(&self) -> Result<String, String> {
        match self {
            Self::Service(provider) => provider.get_token().await,
            Self::User(ctx) => Ok(ctx.token.clone()),
        }
    }

    pub fn user_id(&self) -> Option<&str> {
        match self {
            Self::Service(_) => None,
            Self::User(ctx) => Some(&ctx.user_id),
        }
    }

    pub fn is_user_context(&self) -> bool {
        matches!(self, Self::User(_))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_user_context() {
        let ctx = UserContext::new(
            "tok123".into(),
            "user-1".into(),
            Some("Alice".into()),
            "ws-123".into(),
            Some("wh-456".into()),
        );
        assert_eq!(ctx.token, "tok123");
        assert_eq!(ctx.user_id, "user-1");
        assert_eq!(ctx.user_name.as_deref(), Some("Alice"));
        assert_eq!(ctx.workspace_id, "ws-123");
        assert_eq!(ctx.warehouse_id.as_deref(), Some("wh-456"));
    }

    #[test]
    fn test_user_context_without_warehouse() {
        let ctx = UserContext::new(
            "tok".into(),
            "u1".into(),
            None,
            "ws-1".into(),
            None,
        );
        assert!(ctx.warehouse_id.is_none());
        assert_eq!(ctx.workspace_id, "ws-1");
    }

    #[test]
    fn test_execution_context_user() {
        let user = UserContext::new("tok".into(), "u1".into(), None, "ws-1".into(), None);
        let exec = ExecutionContext::User(user);
        assert!(exec.is_user_context());
        assert_eq!(exec.user_id(), Some("u1"));
    }

    #[tokio::test]
    async fn test_execution_context_user_token() {
        let user = UserContext::new("my-token".into(), "u1".into(), None, "ws-1".into(), None);
        let exec = ExecutionContext::User(user);
        let token = exec.get_token().await.unwrap();
        assert_eq!(token, "my-token");
    }
}
