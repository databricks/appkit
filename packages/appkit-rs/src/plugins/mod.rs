//! Shipped plugin wrappers — Rust `Plugin` trait implementations for the core
//! connectors. Each module here provides:
//!
//! - A per-plugin config struct
//! - A Rust `Plugin` trait implementation with a proper `PluginManifest`
//!   (name, required/optional resources)
//! - A Python-facing subclass of `appkit.Plugin` lives in
//!   `appkit/plugins/*.py`, which is where route injection and OBO-aware
//!   handler logic lives. The Rust side is the source of truth for manifest
//!   + resource declarations so a future `appkit plugin sync` CLI can read
//!   them directly without parsing Python.
//!
//! Keeping the Rust trait implementations slim avoids duplicating the
//! connector's HTTP logic and prevents Rust/Python drift: both sides agree on
//! manifests and plugin names, while route injection is owned by a single
//! Python class per plugin.

pub mod analytics;
pub mod files;
pub mod genie;
pub mod lakebase;
pub mod server;
pub mod serving;
pub mod vector_search;
