//! OpenTelemetry integration — TelemetryManager (singleton) and per-plugin
//! TelemetryProvider.
//!
//! Mirrors the TypeScript `TelemetryManager` / `TelemetryProvider` pattern:
//! - Global singleton initializes OTLP exporters when an endpoint is configured
//! - Per-plugin providers scope tracers/meters by plugin name
//! - When no endpoint is configured, the global API returns noop implementations

use opentelemetry::KeyValue;
use opentelemetry_otlp::WithExportConfig;
use opentelemetry_sdk::trace::TracerProvider;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use crate::config::AppConfig;

// ---------------------------------------------------------------------------
// Configuration types
// ---------------------------------------------------------------------------

/// Global telemetry configuration.
#[derive(Clone, Debug, Default)]
pub struct TelemetryConfig {
    /// OTLP exporter endpoint. If `None`, telemetry is disabled (noop).
    pub endpoint: Option<String>,
    /// Service name for resource attributes.
    pub service_name: Option<String>,
}

impl TelemetryConfig {
    pub fn from_app_config(config: &AppConfig) -> Self {
        Self {
            endpoint: config.otel_endpoint.clone(),
            service_name: None,
        }
    }
}

/// Per-plugin telemetry options — controls which signals are active.
#[derive(Clone, Debug)]
pub struct TelemetryOptions {
    pub traces: bool,
    pub metrics: bool,
    pub logs: bool,
}

impl Default for TelemetryOptions {
    fn default() -> Self {
        Self {
            traces: true,
            metrics: true,
            logs: true,
        }
    }
}

// ---------------------------------------------------------------------------
// TelemetryManager — singleton
// ---------------------------------------------------------------------------

const DEFAULT_SERVICE_NAME: &str = "databricks-app";

/// Global telemetry manager. Initializes the OpenTelemetry SDK when an OTLP
/// endpoint is configured; otherwise all providers return noop implementations.
pub struct TelemetryManager {
    active: bool,
}

static INSTANCE: OnceLock<Arc<TelemetryManager>> = OnceLock::new();

static INTERNED_NAMES: OnceLock<Mutex<HashMap<String, &'static str>>> = OnceLock::new();

/// Intern a plugin name so it can be used as `&'static str` without leaking
/// memory on every call. Each unique name is leaked exactly once.
fn intern_name(name: &str) -> &'static str {
    let map = INTERNED_NAMES.get_or_init(|| Mutex::new(HashMap::new()));
    let mut guard = map.lock().unwrap();
    if let Some(&existing) = guard.get(name) {
        existing
    } else {
        let leaked: &'static str = Box::leak(name.to_string().into_boxed_str());
        guard.insert(name.to_string(), leaked);
        leaked
    }
}

impl TelemetryManager {
    /// Initialize the global singleton. Idempotent — subsequent calls return
    /// the existing instance.
    pub fn initialize(config: &TelemetryConfig) -> Arc<TelemetryManager> {
        INSTANCE
            .get_or_init(|| {
                if let Some(ref endpoint) = config.endpoint {
                    Self::init_with_endpoint(endpoint, config.service_name.as_deref());
                    Arc::new(TelemetryManager { active: true })
                } else {
                    Arc::new(TelemetryManager { active: false })
                }
            })
            .clone()
    }

    /// Get the singleton instance. Returns `None` if not yet initialized.
    pub fn get_instance() -> Option<Arc<TelemetryManager>> {
        INSTANCE.get().cloned()
    }

    /// Create a per-plugin scoped `TelemetryProvider`.
    pub fn get_provider(
        plugin_name: &str,
        options: Option<TelemetryOptions>,
    ) -> TelemetryProvider {
        TelemetryProvider {
            plugin_name: plugin_name.to_string(),
            plugin_name_static: intern_name(plugin_name),
            options: options.unwrap_or_default(),
        }
    }

    /// Whether the OTLP exporter was successfully initialized.
    pub fn is_active(&self) -> bool {
        self.active
    }

    fn init_with_endpoint(endpoint: &str, service_name: Option<&str>) {
        let service = service_name.unwrap_or(DEFAULT_SERVICE_NAME);
        let resource = opentelemetry_sdk::Resource::new(vec![KeyValue::new(
            "service.name",
            service.to_string(),
        )]);

        // Trace exporter via OTLP/gRPC
        if let Ok(exporter) = opentelemetry_otlp::SpanExporter::builder()
            .with_tonic()
            .with_endpoint(endpoint)
            .build()
        {
            let tracer_provider = TracerProvider::builder()
                .with_resource(resource)
                .with_batch_exporter(exporter, opentelemetry_sdk::runtime::Tokio)
                .build();

            // Register as the global tracer provider so that
            // `opentelemetry::global::tracer(name)` returns real tracers.
            opentelemetry::global::set_tracer_provider(tracer_provider);
        }
    }
}

// ---------------------------------------------------------------------------
// TelemetryProvider — per-plugin scoped
// ---------------------------------------------------------------------------

/// Per-plugin telemetry provider. When the global manager is not active or a
/// particular signal is disabled, the OpenTelemetry global API transparently
/// returns noop implementations at zero cost.
pub struct TelemetryProvider {
    plugin_name: String,
    /// Leaked static str for APIs requiring `&'static str`.
    plugin_name_static: &'static str,
    options: TelemetryOptions,
}

impl TelemetryProvider {
    /// Create a provider with all signals disabled (for testing).
    pub fn new_disabled(plugin_name: &str) -> Self {
        Self {
            plugin_name: plugin_name.to_string(),
            plugin_name_static: intern_name(plugin_name),
            options: TelemetryOptions {
                traces: false,
                metrics: false,
                logs: false,
            },
        }
    }

    pub fn plugin_name(&self) -> &str {
        &self.plugin_name
    }

    pub fn traces_enabled(&self) -> bool {
        self.options.traces
    }

    pub fn metrics_enabled(&self) -> bool {
        self.options.metrics
    }

    /// Get a tracer scoped to this plugin. Returns a noop tracer when the
    /// global provider is not configured.
    pub fn tracer(&self) -> opentelemetry::global::BoxedTracer {
        opentelemetry::global::tracer(self.plugin_name_static)
    }

    /// Get a meter scoped to this plugin.
    pub fn meter(&self) -> opentelemetry::metrics::Meter {
        opentelemetry::global::meter(self.plugin_name_static)
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_telemetry_config_default() {
        let config = TelemetryConfig::default();
        assert!(config.endpoint.is_none());
        assert!(config.service_name.is_none());
    }

    #[test]
    fn test_telemetry_config_from_app_config() {
        let app = AppConfig::new(
            "https://host.databricks.com".into(),
            None,
            None,
            None,
            8000,
            "0.0.0.0".into(),
            Some("http://otel:4317".into()),
        );
        let tc = TelemetryConfig::from_app_config(&app);
        assert_eq!(tc.endpoint.as_deref(), Some("http://otel:4317"));
    }

    #[test]
    fn test_telemetry_options_default() {
        let opts = TelemetryOptions::default();
        assert!(opts.traces);
        assert!(opts.metrics);
        assert!(opts.logs);
    }

    #[test]
    fn test_provider_traces_enabled() {
        let provider = TelemetryManager::get_provider("test-plugin", None);
        assert!(provider.traces_enabled());
        assert_eq!(provider.plugin_name(), "test-plugin");

        let disabled = TelemetryManager::get_provider(
            "quiet",
            Some(TelemetryOptions {
                traces: false,
                metrics: false,
                logs: false,
            }),
        );
        assert!(!disabled.traces_enabled());
    }
}
