//! Genie plugin — Rust `Plugin` trait implementation.
//!
//! Declares the `genie_space` resource requirement. HTTP routes live in
//! `appkit/plugins/genie.py`.

use std::collections::HashMap;

use crate::plugin::{Plugin, PluginManifest, PluginPhase, ResourceRequirement};

/// Genie plugin configuration — alias → space_id map.
#[derive(Clone, Debug, Default)]
pub struct GeniePluginConfig {
    pub spaces: HashMap<String, String>,
    pub timeout_ms: Option<u64>,
}

pub struct GeniePluginCore {
    manifest: PluginManifest,
    #[allow(dead_code)]
    config: GeniePluginConfig,
}

impl GeniePluginCore {
    pub const NAME: &'static str = "genie";

    pub fn new(config: GeniePluginConfig) -> Self {
        Self {
            manifest: PluginManifest {
                name: Self::NAME.into(),
                display_name: Some("Genie Plugin".into()),
                description: Some("Databricks Genie conversational analytics".into()),
                required_resources: vec![ResourceRequirement {
                    resource_type: "genie_space".into(),
                    required: true,
                }],
                optional_resources: vec![],
            },
            config,
        }
    }
}

impl Plugin for GeniePluginCore {
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
    fn test_manifest_declares_genie_space() {
        let core = GeniePluginCore::new(GeniePluginConfig::default());
        assert_eq!(core.name(), "genie");
        assert_eq!(
            core.manifest().required_resources[0].resource_type,
            "genie_space"
        );
    }
}
