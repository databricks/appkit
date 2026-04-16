//! Vector Search plugin — Rust `Plugin` trait implementation.
//!
//! Declares the `vector_search_index` resource requirement. The HTTP routes
//! (`/api/vector-search/query`, `/api/vector-search/query-next-page`) live on
//! the Python subclass in `appkit/plugins/vector_search.py`; the Rust side
//! owns the manifest, per-index config, and request-shape helpers used by
//! `VectorSearchConnector`.
//!
//! The request/response builders live in
//! `crate::connectors::vector_search`. This module is deliberately thin: it
//! exists so Python apps can declare a `VectorSearchPluginCore` with the right
//! manifest and resource requirement, mirroring the TS `VectorSearchPlugin`.

use std::collections::HashMap;

use crate::connectors::vector_search::VsQueryType;
use crate::plugin::{Plugin, PluginManifest, PluginPhase, ResourceRequirement};

// ---------------------------------------------------------------------------
// Per-index configuration — alias → index settings.
// ---------------------------------------------------------------------------

/// Per-index configuration matching the TS `VectorSearchPluginConfig.indexes`
/// shape.
#[derive(Clone, Debug)]
pub struct VectorSearchIndexConfig {
    /// Three-level UC name: `catalog.schema.index_name`.
    pub index_name: String,
    /// Endpoint name — required for pagination.
    pub endpoint_name: Option<String>,
    /// Columns to return in results.
    pub columns: Vec<String>,
    /// Default query type — ann / hybrid / full_text.
    pub query_type: VsQueryType,
    /// Default max number of results.
    pub num_results: u32,
    /// Reranker columns (enables the `databricks_reranker` when non-empty).
    pub reranker_columns: Option<Vec<String>>,
}

impl Default for VectorSearchIndexConfig {
    fn default() -> Self {
        Self {
            index_name: String::new(),
            endpoint_name: None,
            columns: Vec::new(),
            query_type: VsQueryType::Hybrid,
            num_results: 20,
            reranker_columns: None,
        }
    }
}

/// Vector Search plugin configuration — alias → index config plus a default
/// timeout.
#[derive(Clone, Debug, Default)]
pub struct VectorSearchPluginConfig {
    pub indexes: HashMap<String, VectorSearchIndexConfig>,
    /// Per-query timeout in milliseconds.
    pub timeout_ms: Option<u64>,
}

impl VectorSearchPluginConfig {
    /// Return the configured aliases in stable (sorted) order. Used by the
    /// Python layer to advertise known indexes via `client_config`.
    pub fn aliases(&self) -> Vec<String> {
        let mut keys: Vec<String> = self.indexes.keys().cloned().collect();
        keys.sort();
        keys
    }
}

// ---------------------------------------------------------------------------
// VectorSearchPluginCore — Plugin trait impl.
// ---------------------------------------------------------------------------

pub struct VectorSearchPluginCore {
    manifest: PluginManifest,
    #[allow(dead_code)]
    config: VectorSearchPluginConfig,
}

impl VectorSearchPluginCore {
    pub const NAME: &'static str = "vector-search";

    pub fn new(config: VectorSearchPluginConfig) -> Self {
        Self {
            manifest: PluginManifest {
                name: Self::NAME.into(),
                display_name: Some("Vector Search Plugin".into()),
                description: Some(
                    "Query Databricks Vector Search indexes with hybrid search, reranking, and pagination"
                        .into(),
                ),
                required_resources: vec![ResourceRequirement {
                    resource_type: "vector_search_index".into(),
                    required: true,
                }],
                optional_resources: vec![],
            },
            config,
        }
    }

    pub fn config(&self) -> &VectorSearchPluginConfig {
        &self.config
    }
}

impl Plugin for VectorSearchPluginCore {
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_manifest_declares_vector_search_index() {
        let core = VectorSearchPluginCore::new(VectorSearchPluginConfig::default());
        assert_eq!(core.name(), "vector-search");
        assert_eq!(core.manifest().required_resources.len(), 1);
        assert_eq!(
            core.manifest().required_resources[0].resource_type,
            "vector_search_index"
        );
        assert_eq!(core.phase(), PluginPhase::Normal);
    }

    #[test]
    fn test_default_index_config_matches_ts_defaults() {
        let cfg = VectorSearchIndexConfig::default();
        assert_eq!(cfg.query_type, VsQueryType::Hybrid);
        assert_eq!(cfg.num_results, 20);
        assert!(cfg.columns.is_empty());
        assert!(cfg.endpoint_name.is_none());
        assert!(cfg.reranker_columns.is_none());
    }

    #[test]
    fn test_aliases_are_sorted_and_stable() {
        let mut indexes = HashMap::new();
        indexes.insert(
            "docs".into(),
            VectorSearchIndexConfig {
                index_name: "cat.sch.docs".into(),
                columns: vec!["id".into()],
                ..Default::default()
            },
        );
        indexes.insert(
            "articles".into(),
            VectorSearchIndexConfig {
                index_name: "cat.sch.articles".into(),
                columns: vec!["id".into()],
                ..Default::default()
            },
        );
        let config = VectorSearchPluginConfig {
            indexes,
            timeout_ms: Some(10_000),
        };
        assert_eq!(
            config.aliases(),
            vec!["articles".to_string(), "docs".to_string()]
        );
    }
}
