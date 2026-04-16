//! Serving plugin — Rust `Plugin` trait implementation.
//!
//! Declares the `serving_endpoint` resource requirement. HTTP routes live in
//! `appkit/plugins/serving.py`.

use std::collections::HashMap;

use crate::plugin::{Plugin, PluginManifest, PluginPhase, ResourceRequirement};

#[derive(Clone, Debug, Default)]
pub struct ServingEndpointConfig {
    /// Environment variable name that resolves to the endpoint name.
    pub env: String,
    pub served_model: Option<String>,
}

/// Serving plugin configuration — alias → endpoint config. When `endpoints`
/// is empty, the plugin operates in "simple mode" and exposes a single
/// `invoke` / `stream` route under the alias "default".
#[derive(Clone, Debug, Default)]
pub struct ServingPluginConfig {
    pub endpoints: HashMap<String, ServingEndpointConfig>,
    pub timeout_ms: Option<u64>,
}

impl ServingPluginConfig {
    pub fn is_named_mode(&self) -> bool {
        !self.endpoints.is_empty()
    }
}

pub struct ServingPluginCore {
    manifest: PluginManifest,
    #[allow(dead_code)]
    config: ServingPluginConfig,
}

impl ServingPluginCore {
    pub const NAME: &'static str = "serving";

    pub fn new(config: ServingPluginConfig) -> Self {
        Self {
            manifest: PluginManifest {
                name: Self::NAME.into(),
                display_name: Some("Model Serving Plugin".into()),
                description: Some("Invoke and stream from Databricks serving endpoints".into()),
                required_resources: vec![ResourceRequirement {
                    resource_type: "serving_endpoint".into(),
                    required: true,
                }],
                optional_resources: vec![],
            },
            config,
        }
    }
}

impl Plugin for ServingPluginCore {
    fn name(&self) -> &str {
        &self.manifest.name
    }

    fn phase(&self) -> PluginPhase {
        PluginPhase::Normal
    }

    fn manifest(&self) -> &PluginManifest {
        &self.manifest
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_simple_mode_is_default() {
        let core = ServingPluginCore::new(ServingPluginConfig::default());
        assert!(!core.config.is_named_mode());
    }

    #[test]
    fn test_named_mode_when_endpoints_present() {
        let mut endpoints = HashMap::new();
        endpoints.insert(
            "chat".into(),
            ServingEndpointConfig {
                env: "CHAT_ENDPOINT".into(),
                served_model: None,
            },
        );
        let config = ServingPluginConfig {
            endpoints,
            timeout_ms: None,
        };
        assert!(config.is_named_mode());
    }

    #[test]
    fn test_manifest_declares_serving_endpoint() {
        let core = ServingPluginCore::new(ServingPluginConfig::default());
        assert_eq!(
            core.manifest().required_resources[0].resource_type,
            "serving_endpoint"
        );
    }
}
