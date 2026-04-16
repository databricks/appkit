use pyo3::prelude::*;
use std::env;

fn non_empty_env(key: &str) -> Option<String> {
    env::var(key).ok().filter(|v| !v.is_empty())
}

/// Application configuration parsed from environment variables.
/// Mirrors the TypeScript ServiceContext / execution-context environment expectations.
#[derive(Clone, Debug)]
#[pyclass(frozen, module = "appkit")]
pub struct AppConfig {
    #[pyo3(get)]
    pub databricks_host: String,
    #[pyo3(get)]
    pub client_id: Option<String>,
    #[pyo3(get)]
    pub client_secret: Option<String>,
    #[pyo3(get)]
    pub warehouse_id: Option<String>,
    #[pyo3(get)]
    pub app_port: u16,
    #[pyo3(get)]
    pub host: String,
    #[pyo3(get)]
    pub otel_endpoint: Option<String>,
}

#[pymethods]
impl AppConfig {
    #[new]
    #[pyo3(signature = (
        databricks_host,
        *,
        client_id = None,
        client_secret = None,
        warehouse_id = None,
        app_port = 8000,
        host = "0.0.0.0".to_string(),
        otel_endpoint = None,
    ))]
    pub fn new(
        databricks_host: String,
        client_id: Option<String>,
        client_secret: Option<String>,
        warehouse_id: Option<String>,
        app_port: u16,
        host: String,
        otel_endpoint: Option<String>,
    ) -> Self {
        Self {
            databricks_host,
            client_id,
            client_secret,
            warehouse_id,
            app_port,
            host,
            otel_endpoint,
        }
    }

    /// Parse configuration from environment variables.
    #[staticmethod]
    pub fn from_env() -> PyResult<Self> {
        let mut databricks_host = non_empty_env("DATABRICKS_HOST").ok_or_else(|| {
            pyo3::exceptions::PyValueError::new_err(
                "DATABRICKS_HOST environment variable is required",
            )
        })?;
        // Databricks Apps sets DATABRICKS_HOST without a scheme; normalise.
        if !databricks_host.starts_with("https://") && !databricks_host.starts_with("http://") {
            databricks_host = format!("https://{databricks_host}");
        }

        let app_port = non_empty_env("DATABRICKS_APP_PORT")
            .or_else(|| non_empty_env("PORT"))
            .and_then(|v| v.parse().ok())
            .unwrap_or(8000);

        let host = non_empty_env("FLASK_RUN_HOST").unwrap_or_else(|| "0.0.0.0".to_string());

        Ok(Self {
            databricks_host,
            client_id: non_empty_env("DATABRICKS_CLIENT_ID"),
            client_secret: non_empty_env("DATABRICKS_CLIENT_SECRET"),
            warehouse_id: non_empty_env("DATABRICKS_WAREHOUSE_ID"),
            app_port,
            host,
            otel_endpoint: non_empty_env("OTEL_EXPORTER_OTLP_ENDPOINT"),
        })
    }

    fn __repr__(&self) -> String {
        format!(
            "AppConfig(databricks_host={:?}, warehouse_id={:?}, app_port={})",
            self.databricks_host, self.warehouse_id, self.app_port
        )
    }

    fn __eq__(&self, other: &Self) -> bool {
        self.databricks_host == other.databricks_host
            && self.client_id == other.client_id
            && self.client_secret == other.client_secret
            && self.warehouse_id == other.warehouse_id
            && self.app_port == other.app_port
            && self.host == other.host
            && self.otel_endpoint == other.otel_endpoint
    }

    fn __hash__(&self) -> u64 {
        use std::hash::{Hash, Hasher};
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        self.databricks_host.hash(&mut hasher);
        self.app_port.hash(&mut hasher);
        self.host.hash(&mut hasher);
        hasher.finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;

    #[test]
    fn test_app_config_new() {
        let config = AppConfig::new(
            "https://example.databricks.com".into(),
            Some("client-id".into()),
            Some("client-secret".into()),
            Some("warehouse-123".into()),
            8080,
            "0.0.0.0".into(),
            None,
        );
        assert_eq!(config.databricks_host, "https://example.databricks.com");
        assert_eq!(config.client_id.as_deref(), Some("client-id"));
        assert_eq!(config.warehouse_id.as_deref(), Some("warehouse-123"));
        assert_eq!(config.app_port, 8080);
        assert!(config.otel_endpoint.is_none());
    }

    #[test]
    #[serial]
    fn test_app_config_from_env() {
        // Snapshot original values so we can restore them afterward.
        let orig_host = env::var("DATABRICKS_HOST").ok();
        let orig_client_id = env::var("DATABRICKS_CLIENT_ID").ok();
        let orig_app_port = env::var("DATABRICKS_APP_PORT").ok();

        // Helper to restore or remove an env var.
        fn restore_env(key: &str, original: Option<String>) {
            match original {
                Some(val) => env::set_var(key, val),
                None => env::remove_var(key),
            }
        }

        // Clear to test missing-var error path.
        env::remove_var("DATABRICKS_HOST");
        let result = AppConfig::from_env();
        assert!(result.is_err());

        env::set_var("DATABRICKS_HOST", "https://test.databricks.com");
        env::set_var("DATABRICKS_CLIENT_ID", "cid");
        env::set_var("DATABRICKS_APP_PORT", "9090");
        let config = AppConfig::from_env().unwrap();
        assert_eq!(config.databricks_host, "https://test.databricks.com");
        assert_eq!(config.client_id.as_deref(), Some("cid"));
        assert_eq!(config.app_port, 9090);

        // Restore original env state.
        restore_env("DATABRICKS_HOST", orig_host);
        restore_env("DATABRICKS_CLIENT_ID", orig_client_id);
        restore_env("DATABRICKS_APP_PORT", orig_app_port);
    }
}
