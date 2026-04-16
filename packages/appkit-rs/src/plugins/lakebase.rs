//! Lakebase plugin — Rust `Plugin` trait implementation.
//!
//! Declares the `postgres` resource requirement. Lakebase exposes a
//! programmatic pool API rather than HTTP routes, so the Python subclass in
//! `appkit/plugins/lakebase.py` publishes connection helpers via exports()
//! and keeps `inject_routes()` empty.

use crate::plugin::{Plugin, PluginManifest, PluginPhase, ResourceRequirement};

#[derive(Clone, Debug, Default)]
pub struct LakebasePluginConfig {
    pub database: Option<String>,
    pub host: Option<String>,
    pub ssl_mode: Option<String>,
}

pub struct LakebasePluginCore {
    manifest: PluginManifest,
    #[allow(dead_code)]
    config: LakebasePluginConfig,
}

impl LakebasePluginCore {
    pub const NAME: &'static str = "lakebase";

    pub fn new(config: LakebasePluginConfig) -> Self {
        Self {
            manifest: PluginManifest {
                name: Self::NAME.into(),
                display_name: Some("Lakebase".into()),
                description: Some("Databricks Lakebase PostgreSQL integration".into()),
                required_resources: vec![ResourceRequirement {
                    resource_type: "postgres".into(),
                    required: true,
                }],
                optional_resources: vec![],
            },
            config,
        }
    }
}

impl Plugin for LakebasePluginCore {
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
    fn test_manifest_declares_postgres() {
        let core = LakebasePluginCore::new(LakebasePluginConfig::default());
        assert_eq!(core.name(), "lakebase");
        assert_eq!(
            core.manifest().required_resources[0].resource_type,
            "postgres"
        );
    }
}
