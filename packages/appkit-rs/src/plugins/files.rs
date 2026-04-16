//! Files plugin — Rust `Plugin` trait implementation. Wraps `FilesConnector`
//! with per-volume alias configuration and declares the `volume` resource
//! requirement.
//!
//! HTTP routes and OBO token extraction are owned by the Python subclass in
//! `appkit/plugins/files.py`. This struct supplies the plugin name, phase,
//! and manifest used by future Rust callers and the (upcoming) appkit CLI.

use std::collections::HashMap;

use crate::plugin::{Plugin, PluginManifest, PluginPhase, ResourceRequirement};

/// Per-volume configuration — alias → fully-qualified volume path.
/// Example: `{"files": "/Volumes/catalog/schema/volume"}`.
#[derive(Clone, Debug, Default)]
pub struct FilesPluginConfig {
    pub volumes: HashMap<String, String>,
    pub max_upload_size_bytes: Option<u64>,
    pub timeout_ms: Option<u64>,
}

/// Rust wrapper around `FilesConnector` exposing the `Plugin` trait.
pub struct FilesPluginCore {
    manifest: PluginManifest,
    #[allow(dead_code)]
    config: FilesPluginConfig,
}

impl FilesPluginCore {
    pub const NAME: &'static str = "files";

    pub fn new(config: FilesPluginConfig) -> Self {
        Self {
            manifest: PluginManifest {
                name: Self::NAME.into(),
                display_name: Some("Files Plugin".into()),
                description: Some("Unity Catalog Volumes file operations".into()),
                required_resources: vec![ResourceRequirement {
                    resource_type: "volume".into(),
                    required: true,
                }],
                optional_resources: vec![],
            },
            config,
        }
    }
}

impl Plugin for FilesPluginCore {
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
    fn test_manifest_declares_volume_resource() {
        let core = FilesPluginCore::new(FilesPluginConfig::default());
        assert_eq!(core.name(), "files");
        assert_eq!(core.manifest().required_resources.len(), 1);
        assert_eq!(core.manifest().required_resources[0].resource_type, "volume");
    }

    #[test]
    fn test_phase_is_normal() {
        let core = FilesPluginCore::new(FilesPluginConfig::default());
        assert_eq!(core.phase(), PluginPhase::Normal);
    }

    #[test]
    fn test_config_round_trip() {
        let mut volumes = HashMap::new();
        volumes.insert("files".to_string(), "/Volumes/a/b/c".to_string());
        let config = FilesPluginConfig {
            volumes: volumes.clone(),
            max_upload_size_bytes: Some(5_000_000_000),
            timeout_ms: Some(30_000),
        };
        let core = FilesPluginCore::new(config.clone());
        assert_eq!(core.config.volumes, volumes);
        assert_eq!(core.config.max_upload_size_bytes, Some(5_000_000_000));
    }
}
