use pyo3::prelude::*;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::env;

// ---------------------------------------------------------------------------
// Internal serde types for Databricks Lakebase API
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct GenerateCredentialRequest {
    instance_names: Vec<String>,
    request_id: String,
}

#[derive(Deserialize, Debug)]
struct GenerateCredentialResponse {
    token: Option<String>,
    expiration_time: Option<String>,
}

// ---------------------------------------------------------------------------
// Python-facing response types (frozen / immutable)
// ---------------------------------------------------------------------------

/// Generated database credential for Lakebase access.
#[pyclass(frozen, module = "appkit")]
#[derive(Clone)]
pub struct DatabaseCredential {
    /// OAuth token for database authentication.
    #[pyo3(get)]
    pub token: String,
    /// ISO 8601 expiration time.
    #[pyo3(get)]
    pub expiration_time: String,
}

#[pymethods]
impl DatabaseCredential {
    fn __repr__(&self) -> String {
        format!(
            "DatabaseCredential(expiration_time={:?})",
            self.expiration_time
        )
    }

    fn __eq__(&self, other: &Self) -> bool {
        self.token == other.token && self.expiration_time == other.expiration_time
    }

    fn __hash__(&self) -> u64 {
        use std::hash::{Hash, Hasher};
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        self.token.hash(&mut hasher);
        self.expiration_time.hash(&mut hasher);
        hasher.finish()
    }
}

/// PostgreSQL connection configuration for Lakebase.
#[pyclass(frozen, module = "appkit")]
#[derive(Clone)]
pub struct LakebasePgConfig {
    #[pyo3(get)]
    pub host: String,
    #[pyo3(get)]
    pub database: String,
    #[pyo3(get)]
    pub port: u16,
    #[pyo3(get)]
    pub ssl_mode: String,
    #[pyo3(get)]
    pub app_name: Option<String>,
}

#[pymethods]
impl LakebasePgConfig {
    /// Build a Lakebase PG config from environment variables.
    ///
    /// Reads: `PGHOST`, `PGDATABASE`, `PGPORT`, `PGSSLMODE`, `PGAPPNAME`,
    /// and `LAKEBASE_ENDPOINT` (alternative to PGHOST).
    #[new]
    #[pyo3(signature = (*, host = None, database = None, port = None, ssl_mode = None, app_name = None))]
    fn new(
        host: Option<String>,
        database: Option<String>,
        port: Option<u16>,
        ssl_mode: Option<String>,
        app_name: Option<String>,
    ) -> PyResult<Self> {
        let resolved_host = host
            .or_else(|| non_empty_env("PGHOST"))
            .or_else(|| non_empty_env("LAKEBASE_ENDPOINT"))
            .ok_or_else(|| {
                pyo3::exceptions::PyValueError::new_err(
                    "Lakebase host is required. Set PGHOST or LAKEBASE_ENDPOINT, or pass host=.",
                )
            })?;

        let resolved_db = database
            .or_else(|| non_empty_env("PGDATABASE"))
            .ok_or_else(|| {
                pyo3::exceptions::PyValueError::new_err(
                    "Lakebase database is required. Set PGDATABASE or pass database=.",
                )
            })?;

        let resolved_port = port.unwrap_or_else(|| {
            non_empty_env("PGPORT")
                .and_then(|v| v.parse().ok())
                .unwrap_or(5432)
        });

        let resolved_ssl = ssl_mode
            .or_else(|| non_empty_env("PGSSLMODE"))
            .unwrap_or_else(|| "require".into());

        let resolved_app = app_name.or_else(|| non_empty_env("PGAPPNAME"));

        Ok(Self {
            host: resolved_host,
            database: resolved_db,
            port: resolved_port,
            ssl_mode: resolved_ssl,
            app_name: resolved_app,
        })
    }

    /// Build from environment variables only.
    #[staticmethod]
    fn from_env() -> PyResult<Self> {
        Self::new(None, None, None, None, None)
    }

    fn __repr__(&self) -> String {
        format!(
            "LakebasePgConfig(host={:?}, database={:?}, port={})",
            self.host, self.database, self.port
        )
    }

    fn __eq__(&self, other: &Self) -> bool {
        self.host == other.host
            && self.database == other.database
            && self.port == other.port
            && self.ssl_mode == other.ssl_mode
    }

    fn __hash__(&self) -> u64 {
        use std::hash::{Hash, Hasher};
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        self.host.hash(&mut hasher);
        self.database.hash(&mut hasher);
        self.port.hash(&mut hasher);
        hasher.finish()
    }
}

fn non_empty_env(key: &str) -> Option<String> {
    env::var(key).ok().filter(|v| !v.is_empty())
}

// ---------------------------------------------------------------------------
// LakebaseConnector
// ---------------------------------------------------------------------------

/// Databricks Lakebase connector.
///
/// Provides credential generation for database access via the REST API
/// at `/api/2.0/database/credentials`, and pool-config retrieval from
/// environment variables.
#[pyclass(module = "appkit")]
pub struct LakebaseConnector {
    host: String,
    http: Client,
}

#[pymethods]
impl LakebaseConnector {
    #[new]
    #[pyo3(signature = (host))]
    fn new(host: String) -> Self {
        Self {
            host: host.trim_end_matches('/').to_string(),
            http: Client::new(),
        }
    }

    /// Generate a database credential for the given Lakebase instance(s).
    ///
    /// Calls POST `/api/2.0/database/credentials` with the service-principal
    /// token. Returns a `DatabaseCredential` containing the temporary
    /// password token and its expiration time.
    #[pyo3(signature = (token, instance_names, *, request_id = None))]
    fn generate_credential<'py>(
        &self,
        py: Python<'py>,
        token: String,
        instance_names: Vec<String>,
        request_id: Option<String>,
    ) -> PyResult<Bound<'py, PyAny>> {
        let http = self.http.clone();
        let host = self.host.clone();

        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let rid = request_id.unwrap_or_else(|| {
                // Simple UUID v4-like random ID
                use rand::Rng;
                let mut rng = rand::thread_rng();
                let bytes: [u8; 16] = rng.gen();
                format!(
                    "{:08x}-{:04x}-4{:03x}-{:04x}-{:012x}",
                    u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]),
                    u16::from_be_bytes([bytes[4], bytes[5]]),
                    u16::from_be_bytes([bytes[6], bytes[7]]) & 0x0FFF,
                    (u16::from_be_bytes([bytes[8], bytes[9]]) & 0x3FFF) | 0x8000,
                    u64::from_be_bytes([
                        0, 0, bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]
                    ]),
                )
            });

            let url = format!("{}/api/2.0/database/credentials", host);
            let body = GenerateCredentialRequest {
                instance_names,
                request_id: rid,
            };

            let resp = http
                .post(&url)
                .bearer_auth(&token)
                .json(&body)
                .send()
                .await
                .map_err(|e| {
                    pyo3::exceptions::PyRuntimeError::new_err(format!(
                        "Credential generation request failed: {e}"
                    ))
                })?;

            if !resp.status().is_success() {
                let status = resp.status();
                let text = resp.text().await.unwrap_or_default();
                return Err(pyo3::exceptions::PyRuntimeError::new_err(format!(
                    "Credential generation failed ({status}): {text}"
                )));
            }

            let data: GenerateCredentialResponse = resp.json().await.map_err(|e| {
                pyo3::exceptions::PyRuntimeError::new_err(format!(
                    "Failed to parse credential response: {e}"
                ))
            })?;

            let token_val = data.token.filter(|t| !t.is_empty()).ok_or_else(|| {
                pyo3::exceptions::PyRuntimeError::new_err(
                    "Credential response missing token",
                )
            })?;

            let expiration = data
                .expiration_time
                .filter(|t| !t.is_empty())
                .ok_or_else(|| {
                    pyo3::exceptions::PyRuntimeError::new_err(
                        "Credential response missing expiration_time",
                    )
                })?;

            Ok(DatabaseCredential {
                token: token_val,
                expiration_time: expiration,
            })
        })
    }

    fn __repr__(&self) -> String {
        format!("LakebaseConnector(host={:?})", self.host)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_pg_config_explicit() {
        let config = LakebasePgConfig::new(
            Some("host.example.com".into()),
            Some("mydb".into()),
            Some(5433),
            Some("prefer".into()),
            Some("myapp".into()),
        )
        .unwrap();

        assert_eq!(config.host, "host.example.com");
        assert_eq!(config.database, "mydb");
        assert_eq!(config.port, 5433);
        assert_eq!(config.ssl_mode, "prefer");
        assert_eq!(config.app_name.as_deref(), Some("myapp"));
    }

    #[test]
    fn test_pg_config_defaults() {
        // Set required env vars
        env::set_var("PGHOST", "env-host.example.com");
        env::set_var("PGDATABASE", "envdb");
        env::remove_var("PGPORT");
        env::remove_var("PGSSLMODE");
        env::remove_var("PGAPPNAME");
        env::remove_var("LAKEBASE_ENDPOINT");

        let config = LakebasePgConfig::from_env().unwrap();
        assert_eq!(config.host, "env-host.example.com");
        assert_eq!(config.database, "envdb");
        assert_eq!(config.port, 5432);
        assert_eq!(config.ssl_mode, "require");
        assert!(config.app_name.is_none());

        // Cleanup
        env::remove_var("PGHOST");
        env::remove_var("PGDATABASE");
    }

    #[test]
    fn test_pg_config_missing_host() {
        env::remove_var("PGHOST");
        env::remove_var("LAKEBASE_ENDPOINT");
        env::set_var("PGDATABASE", "db");

        let result = LakebasePgConfig::new(None, None, None, None, None);
        assert!(result.is_err());

        env::remove_var("PGDATABASE");
    }

    #[test]
    fn test_pg_config_lakebase_endpoint_fallback() {
        env::remove_var("PGHOST");
        env::set_var("LAKEBASE_ENDPOINT", "lakebase.example.com");
        env::set_var("PGDATABASE", "db");

        let config = LakebasePgConfig::from_env().unwrap();
        assert_eq!(config.host, "lakebase.example.com");

        env::remove_var("LAKEBASE_ENDPOINT");
        env::remove_var("PGDATABASE");
    }
}
