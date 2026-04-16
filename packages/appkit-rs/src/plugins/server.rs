//! Server plugin — Rust `Plugin` trait implementation.
//!
//! Promotes the existing axum-backed server into a first-class plugin with a
//! real manifest. Unlike other plugin cores here, the server plugin hosts
//! routes for every other registered plugin rather than owning routes of its
//! own, so `required_resources` is empty.
//!
//! Actual route hosting, SSE streaming, and graceful shutdown live in the
//! top-level `crate::server` module — this struct is the plugin-registry face
//! of that infrastructure. Python code registers a `ServerPlugin` via
//! `appkit/plugins/server.py`; the Rust side is the source of truth for the
//! plugin name (`"server"`), manifest, and phase (Core — it must be ready
//! before Normal plugins inject routes).

use crate::plugin::{Plugin, PluginManifest, PluginPhase};
use crate::server::PyServerConfig;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/// Server plugin configuration — mirrors the TS `IServerConfig` knobs that
/// actually alter Rust-side server behavior. For route-hosting-only fields we
/// reuse `PyServerConfig` to avoid duplicating the existing binding.
#[derive(Clone, Debug)]
pub struct ServerPluginConfig {
    pub host: String,
    pub port: u16,
    pub auto_start: bool,
    pub static_path: Option<String>,
}

impl Default for ServerPluginConfig {
    fn default() -> Self {
        Self {
            host: "0.0.0.0".into(),
            port: 8000,
            auto_start: true,
            static_path: None,
        }
    }
}

impl From<PyServerConfig> for ServerPluginConfig {
    fn from(value: PyServerConfig) -> Self {
        Self {
            host: value.host,
            port: value.port,
            auto_start: value.auto_start,
            static_path: value.static_path,
        }
    }
}

impl From<&PyServerConfig> for ServerPluginConfig {
    fn from(value: &PyServerConfig) -> Self {
        Self {
            host: value.host.clone(),
            port: value.port,
            auto_start: value.auto_start,
            static_path: value.static_path.clone(),
        }
    }
}

// ---------------------------------------------------------------------------
// ServerPluginCore — Plugin trait impl.
// ---------------------------------------------------------------------------

pub struct ServerPluginCore {
    manifest: PluginManifest,
    config: ServerPluginConfig,
}

impl ServerPluginCore {
    pub const NAME: &'static str = "server";

    pub fn new(config: ServerPluginConfig) -> Self {
        Self {
            manifest: PluginManifest {
                name: Self::NAME.into(),
                display_name: Some("Server Plugin".into()),
                description: Some(
                    "HTTP server with axum route hosting, SSE streaming, and graceful shutdown"
                        .into(),
                ),
                required_resources: vec![],
                optional_resources: vec![],
            },
            config,
        }
    }

    pub fn config(&self) -> &ServerPluginConfig {
        &self.config
    }

    /// Convert the plugin config into the `PyServerConfig` consumed by
    /// `PyAppKit::start_server`. This keeps the Rust/Python bindings in sync
    /// without duplicating the server-config field set.
    pub fn to_py_config(&self) -> PyServerConfig {
        PyServerConfig {
            host: self.config.host.clone(),
            port: self.config.port,
            auto_start: self.config.auto_start,
            static_path: self.config.static_path.clone(),
        }
    }
}

impl Plugin for ServerPluginCore {
    fn name(&self) -> &str {
        &self.manifest.name
    }

    /// The server plugin initializes in the Core phase — it must be ready
    /// before Normal-phase plugins inject their routes.
    fn phase(&self) -> PluginPhase {
        PluginPhase::Core
    }

    fn manifest(&self) -> &PluginManifest {
        &self.manifest
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_manifest_has_no_required_resources() {
        let core = ServerPluginCore::new(ServerPluginConfig::default());
        assert_eq!(core.name(), "server");
        assert!(core.manifest().required_resources.is_empty());
        assert!(core.manifest().optional_resources.is_empty());
    }

    #[test]
    fn test_server_plugin_runs_in_core_phase() {
        let core = ServerPluginCore::new(ServerPluginConfig::default());
        assert_eq!(core.phase(), PluginPhase::Core);
    }

    #[test]
    fn test_default_config_matches_ts_defaults() {
        let cfg = ServerPluginConfig::default();
        assert_eq!(cfg.host, "0.0.0.0");
        assert_eq!(cfg.port, 8000);
        assert!(cfg.auto_start);
        assert!(cfg.static_path.is_none());
    }

    #[test]
    fn test_to_py_config_roundtrip() {
        let cfg = ServerPluginConfig {
            host: "127.0.0.1".into(),
            port: 9090,
            auto_start: false,
            static_path: Some("dist".into()),
        };
        let core = ServerPluginCore::new(cfg.clone());
        let py_cfg = core.to_py_config();
        assert_eq!(py_cfg.host, cfg.host);
        assert_eq!(py_cfg.port, cfg.port);
        assert_eq!(py_cfg.auto_start, cfg.auto_start);
        assert_eq!(py_cfg.static_path, cfg.static_path);
    }

    #[test]
    fn test_from_py_server_config() {
        let py_cfg = PyServerConfig {
            host: "example.com".into(),
            port: 3000,
            auto_start: true,
            static_path: Some("public".into()),
        };
        let plugin_cfg: ServerPluginConfig = (&py_cfg).into();
        assert_eq!(plugin_cfg.host, "example.com");
        assert_eq!(plugin_cfg.port, 3000);
        assert_eq!(plugin_cfg.static_path.as_deref(), Some("public"));
    }
}
