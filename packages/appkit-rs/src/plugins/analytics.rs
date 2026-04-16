//! Analytics plugin — Rust `Plugin` trait implementation with the core
//! query-processing behaviors that the TypeScript analytics plugin relies on.
//!
//! The Rust side owns:
//! - Plugin manifest (`sql_warehouse` required resource)
//! - Query parameter extraction + validation
//! - SQL parameter list construction from user-supplied typed values
//! - Query file discovery from `config/queries/` (`.sql` vs `.obo.sql`)
//! - Stable query hashing for cache-key disambiguation
//! - Cache-key parts helper matching TS `["analytics:query", query_key, ...]`
//!
//! HTTP route wiring lives on the Python subclass in
//! `appkit/plugins/analytics.py`. This module is the source of truth for
//! parsing, validation, and cache-key behavior so the Python layer stays
//! thin and Rust/Python cannot drift on these rules.

use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};

use crate::plugin::{Plugin, PluginManifest, PluginPhase, ResourceRequirement};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Default)]
pub struct AnalyticsPluginConfig {
    /// Query execution timeout in milliseconds (matches TS `IAnalyticsConfig.timeout`).
    pub timeout_ms: Option<u64>,
    /// Override directory for query file loading. Defaults to `config/queries`.
    pub queries_dir: Option<PathBuf>,
}

// ---------------------------------------------------------------------------
// QueryProcessor — TS `QueryProcessor` parity
// ---------------------------------------------------------------------------

/// Typed SQL parameter matching the TS `sql.*` helpers — the TS code tags
/// values with `__sql_type` (STRING / BIGINT / DATE / TIMESTAMP / BOOLEAN).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SqlType {
    String,
    Number,
    Date,
    Timestamp,
    Boolean,
}

impl SqlType {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::String => "STRING",
            Self::Number => "BIGINT",
            Self::Date => "DATE",
            Self::Timestamp => "TIMESTAMP",
            Self::Boolean => "BOOLEAN",
        }
    }
}

/// Typed value passed to `QueryProcessor::convert_to_sql_parameters`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SqlValue {
    pub value: String,
    pub sql_type: SqlType,
}

impl SqlValue {
    pub fn string<S: Into<String>>(v: S) -> Self {
        Self { value: v.into(), sql_type: SqlType::String }
    }

    pub fn number<N: ToString>(v: N) -> Self {
        Self { value: v.to_string(), sql_type: SqlType::Number }
    }

    pub fn date<S: Into<String>>(v: S) -> Self {
        Self { value: v.into(), sql_type: SqlType::Date }
    }

    pub fn timestamp<S: Into<String>>(v: S) -> Self {
        Self { value: v.into(), sql_type: SqlType::Timestamp }
    }

    pub fn boolean(v: bool) -> Self {
        Self { value: v.to_string(), sql_type: SqlType::Boolean }
    }
}

/// Outgoing SQL statement parameter sent to the SQL Statement Execution API.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StatementParameter {
    pub name: String,
    pub value: String,
    pub type_name: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ValidationError {
    pub field: String,
    pub message: String,
}

impl std::fmt::Display for ValidationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Invalid value for '{}': {}", self.field, self.message)
    }
}

impl std::error::Error for ValidationError {}

/// QueryProcessor — mirrors `packages/appkit/src/plugins/analytics/query.ts`.
#[derive(Default, Clone, Debug)]
pub struct QueryProcessor;

impl QueryProcessor {
    pub fn new() -> Self {
        Self
    }

    /// Extract all `:param_name` placeholders from a query (`/:([a-zA-Z_]\w*)/g`).
    /// Returns a set-like ordered, deduplicated list in first-seen order.
    ///
    /// Skips colons that appear inside SQL string literals (`'...'`),
    /// quoted identifiers (`"..."`), line comments (`-- ...`), block comments
    /// (`/* ... */`, nestable), and dollar-quoted strings (`$tag$...$tag$`).
    /// Also skips `::TYPE` cast operators.
    pub fn extract_param_names(&self, query: &str) -> Vec<String> {
        let bytes = query.as_bytes();
        let mut out: Vec<String> = Vec::new();
        let mut seen = std::collections::HashSet::new();
        let mut i = 0;
        while i < bytes.len() {
            let b = bytes[i];

            // Line comment: -- ... until end of line.
            if b == b'-' && i + 1 < bytes.len() && bytes[i + 1] == b'-' {
                i += 2;
                while i < bytes.len() && bytes[i] != b'\n' {
                    i += 1;
                }
                continue;
            }

            // Block comment: /* ... */ — PostgreSQL allows nesting.
            if b == b'/' && i + 1 < bytes.len() && bytes[i + 1] == b'*' {
                i += 2;
                let mut depth: u32 = 1;
                while i < bytes.len() && depth > 0 {
                    if i + 1 < bytes.len() && bytes[i] == b'/' && bytes[i + 1] == b'*' {
                        depth += 1;
                        i += 2;
                    } else if i + 1 < bytes.len() && bytes[i] == b'*' && bytes[i + 1] == b'/' {
                        depth -= 1;
                        i += 2;
                    } else {
                        i += 1;
                    }
                }
                continue;
            }

            // Single-quoted string literal: '...'. Doubled '' is an escape.
            if b == b'\'' {
                i += 1;
                while i < bytes.len() {
                    if bytes[i] == b'\'' {
                        if i + 1 < bytes.len() && bytes[i + 1] == b'\'' {
                            i += 2;
                        } else {
                            i += 1;
                            break;
                        }
                    } else {
                        i += 1;
                    }
                }
                continue;
            }

            // Double-quoted identifier: "...". Doubled "" is an escape.
            if b == b'"' {
                i += 1;
                while i < bytes.len() {
                    if bytes[i] == b'"' {
                        if i + 1 < bytes.len() && bytes[i + 1] == b'"' {
                            i += 2;
                        } else {
                            i += 1;
                            break;
                        }
                    } else {
                        i += 1;
                    }
                }
                continue;
            }

            // Dollar-quoted string: $tag$...$tag$ (tag may be empty: $$...$$).
            if b == b'$' {
                let mut tag_end = i + 1;
                while tag_end < bytes.len() && is_ident_continue(bytes[tag_end]) {
                    tag_end += 1;
                }
                if tag_end < bytes.len() && bytes[tag_end] == b'$' {
                    // The delimiter is `bytes[i..=tag_end]` — both `$` included.
                    let delim_len = tag_end - i + 1;
                    let mut j = tag_end + 1;
                    let mut closed = false;
                    while j + delim_len <= bytes.len() {
                        if bytes[j..j + delim_len] == bytes[i..i + delim_len] {
                            j += delim_len;
                            closed = true;
                            break;
                        }
                        j += 1;
                    }
                    i = if closed { j } else { bytes.len() };
                    continue;
                }
                // Not a dollar-quote opener — fall through.
            }

            if b == b':' {
                // Skip `::TYPE` casts — the PostgreSQL cast operator consumes
                // two colons and the identifier that follows, so neither colon
                // starts a named parameter.
                if i + 1 < bytes.len() && bytes[i + 1] == b':' {
                    i += 2;
                    while i < bytes.len() && is_ident_continue(bytes[i]) {
                        i += 1;
                    }
                    continue;
                }
                if i + 1 < bytes.len() && is_ident_start(bytes[i + 1]) {
                    let start = i + 1;
                    let mut end = start;
                    while end < bytes.len() && is_ident_continue(bytes[end]) {
                        end += 1;
                    }
                    let name = std::str::from_utf8(&bytes[start..end])
                        .unwrap_or("")
                        .to_string();
                    if !name.is_empty() && seen.insert(name.clone()) {
                        out.push(name);
                    }
                    i = end;
                    continue;
                }
            }
            i += 1;
        }
        out
    }

    /// Stable hash of the query text — used for cache-key disambiguation.
    ///
    /// TS uses MD5; we use SHA-256 hex here because `sha2` is already a
    /// workspace dependency and there is no shared cache namespace between
    /// TS and Rust. The contract is "stable per query string", which both
    /// satisfy.
    pub fn hash_query(&self, query: &str) -> String {
        let digest = Sha256::digest(query.as_bytes());
        digest.iter().map(|b| format!("{b:02x}")).collect()
    }

    /// Validate + transform user-supplied parameters into the wire format
    /// consumed by the SQL Statement Execution API.
    ///
    /// Rules (mirroring TS):
    /// - Every key in `parameters` MUST appear as a `:name` placeholder
    ///   in `query`. Extraneous keys → `ValidationError`.
    /// - `None`/missing values are dropped (not sent).
    pub fn convert_to_sql_parameters(
        &self,
        query: &str,
        parameters: &BTreeMap<String, Option<SqlValue>>,
    ) -> Result<Vec<StatementParameter>, ValidationError> {
        let query_params: std::collections::HashSet<String> =
            self.extract_param_names(query).into_iter().collect();

        for key in parameters.keys() {
            if !query_params.contains(key) {
                let valid = {
                    let mut v: Vec<&str> = query_params.iter().map(|s| s.as_str()).collect();
                    v.sort();
                    if v.is_empty() { "none".to_string() } else { v.join(", ") }
                };
                return Err(ValidationError {
                    field: key.clone(),
                    message: format!(
                        "expected a parameter defined in the query (valid: {valid})",
                    ),
                });
            }
        }

        let mut out = Vec::new();
        for (name, value) in parameters.iter() {
            if let Some(v) = value {
                out.push(StatementParameter {
                    name: name.clone(),
                    value: v.value.clone(),
                    type_name: v.sql_type.as_str().to_string(),
                });
            }
        }
        Ok(out)
    }

    /// Compute the TS-parity cache-key parts:
    /// `["analytics:query", query_key, JSON.stringify(parameters),
    ///   JSON.stringify(format), hashed_query, executor_key]`.
    pub fn cache_key_parts(
        &self,
        query_key: &str,
        parameters_json: &str,
        format: &str,
        hashed_query: &str,
        executor_key: &str,
    ) -> Vec<String> {
        vec![
            "analytics:query".to_string(),
            query_key.to_string(),
            parameters_json.to_string(),
            serde_json::to_string(format).unwrap_or_else(|_| format!("\"{format}\"")),
            hashed_query.to_string(),
            executor_key.to_string(),
        ]
    }
}

fn is_ident_start(b: u8) -> bool {
    b.is_ascii_alphabetic() || b == b'_'
}

fn is_ident_continue(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

// ---------------------------------------------------------------------------
// Query file loading — `config/queries/*.sql` vs `*.obo.sql`
// ---------------------------------------------------------------------------

/// A query loaded from disk.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LoadedQuery {
    pub query_key: String,
    pub query: String,
    /// True when the source file was `<query_key>.obo.sql` (executes
    /// on-behalf-of the user). False for service-principal-scoped files.
    pub is_as_user: bool,
}

/// Load a query by key from a queries directory. Prefers `.obo.sql` (user
/// context) over `.sql` (service principal) when both exist — matches the TS
/// precedence where OBO queries are picked up first by `app.getAppQuery()`.
pub fn load_query(queries_dir: &Path, query_key: &str) -> Option<LoadedQuery> {
    if !is_valid_query_key(query_key) {
        return None;
    }
    let obo = queries_dir.join(format!("{query_key}.obo.sql"));
    let sp = queries_dir.join(format!("{query_key}.sql"));
    if let Ok(text) = fs::read_to_string(&obo) {
        return Some(LoadedQuery {
            query_key: query_key.to_string(),
            query: text,
            is_as_user: true,
        });
    }
    if let Ok(text) = fs::read_to_string(&sp) {
        return Some(LoadedQuery {
            query_key: query_key.to_string(),
            query: text,
            is_as_user: false,
        });
    }
    None
}

/// Allow only safe query keys — alphanumeric, underscore, dash. Prevents
/// path traversal like `../secrets`.
pub fn is_valid_query_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 128
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

// ---------------------------------------------------------------------------
// AnalyticsPluginCore — Plugin trait impl
// ---------------------------------------------------------------------------

pub struct AnalyticsPluginCore {
    manifest: PluginManifest,
    #[allow(dead_code)]
    config: AnalyticsPluginConfig,
    processor: QueryProcessor,
}

impl AnalyticsPluginCore {
    pub const NAME: &'static str = "analytics";

    pub fn new(config: AnalyticsPluginConfig) -> Self {
        Self {
            manifest: PluginManifest {
                name: Self::NAME.into(),
                display_name: Some("Analytics Plugin".into()),
                description: Some(
                    "SQL query execution against Databricks SQL Warehouses".into(),
                ),
                required_resources: vec![ResourceRequirement {
                    resource_type: "sql_warehouse".into(),
                    required: true,
                }],
                optional_resources: vec![],
            },
            config,
            processor: QueryProcessor::new(),
        }
    }

    pub fn processor(&self) -> &QueryProcessor {
        &self.processor
    }

    pub fn queries_dir(&self) -> PathBuf {
        self.config
            .queries_dir
            .clone()
            .unwrap_or_else(|| PathBuf::from("config").join("queries"))
    }

    pub fn exports_map(&self) -> HashMap<String, String> {
        let mut out = HashMap::new();
        out.insert("query".into(), "analytics.query".into());
        out
    }
}

impl Plugin for AnalyticsPluginCore {
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
    use std::io::Write;

    #[test]
    fn test_extract_param_names_basic() {
        let qp = QueryProcessor::new();
        let params = qp.extract_param_names(
            "SELECT * FROM t WHERE id = :user_id AND region = :region",
        );
        assert_eq!(params, vec!["user_id".to_string(), "region".to_string()]);
    }

    #[test]
    fn test_extract_param_names_dedup_preserves_first_order() {
        let qp = QueryProcessor::new();
        let params = qp.extract_param_names(
            "SELECT :a, :b, :a FROM t WHERE x = :c OR y = :b",
        );
        assert_eq!(params, vec!["a".to_string(), "b".to_string(), "c".to_string()]);
    }

    #[test]
    fn test_extract_param_names_ignores_non_params() {
        let qp = QueryProcessor::new();
        // `::TYPE` casts, standalone colons, and digits-first are all rejected.
        let params = qp.extract_param_names(
            "SELECT x::BIGINT, :user, :: FROM t WHERE n = :1bad OR m = :_ok",
        );
        assert!(params.contains(&"user".to_string()));
        assert!(params.contains(&"_ok".to_string()));
        assert!(!params.contains(&"BIGINT".to_string()));
        assert!(!params.contains(&"1bad".to_string()));
    }

    #[test]
    fn test_extract_param_names_skips_string_literals() {
        let qp = QueryProcessor::new();
        // Colons inside single-quoted literals must not be treated as params.
        let params = qp.extract_param_names(
            "SELECT ':not_a_param', 'foo''s :also_skipped' FROM t WHERE id = :real_id",
        );
        assert_eq!(params, vec!["real_id".to_string()]);
    }

    #[test]
    fn test_extract_param_names_skips_quoted_identifiers() {
        let qp = QueryProcessor::new();
        let params = qp.extract_param_names(
            "SELECT \"col:not_param\", \"esc\"\":also_skipped\" FROM t WHERE id = :real",
        );
        assert_eq!(params, vec!["real".to_string()]);
    }

    #[test]
    fn test_extract_param_names_skips_line_comments() {
        let qp = QueryProcessor::new();
        let params = qp.extract_param_names(
            "SELECT 1 -- :fake_param\nFROM t WHERE id = :real_id",
        );
        assert_eq!(params, vec!["real_id".to_string()]);
    }

    #[test]
    fn test_extract_param_names_skips_block_comments() {
        let qp = QueryProcessor::new();
        let params = qp.extract_param_names(
            "SELECT /* :fake1 /* nested :fake2 */ :fake3 */ :real FROM t",
        );
        assert_eq!(params, vec!["real".to_string()]);
    }

    #[test]
    fn test_extract_param_names_skips_dollar_quoted_strings() {
        let qp = QueryProcessor::new();
        let params = qp.extract_param_names(
            "SELECT $$:not_a_param$$, $tag$:also_not$tag$, :real FROM t",
        );
        assert_eq!(params, vec!["real".to_string()]);
    }

    #[test]
    fn test_convert_parameters_rejects_extra_when_colon_is_in_literal() {
        let qp = QueryProcessor::new();
        // A raw colon inside a literal must not make `fake` look "defined" —
        // the only real param is `id`, so `fake` must be rejected.
        let mut params = BTreeMap::new();
        params.insert("fake".to_string(), Some(SqlValue::string("x")));
        let err = qp
            .convert_to_sql_parameters(
                "SELECT ':fake' FROM t WHERE id = :id",
                &params,
            )
            .unwrap_err();
        assert_eq!(err.field, "fake");
        assert!(err.message.contains("valid: id"));
    }

    #[test]
    fn test_hash_query_is_stable_and_differs() {
        let qp = QueryProcessor::new();
        let h1 = qp.hash_query("SELECT 1");
        let h2 = qp.hash_query("SELECT 1");
        let h3 = qp.hash_query("SELECT 2");
        assert_eq!(h1, h2);
        assert_ne!(h1, h3);
        assert_eq!(h1.len(), 64);
    }

    #[test]
    fn test_convert_parameters_success() {
        let qp = QueryProcessor::new();
        let mut params = BTreeMap::new();
        params.insert("id".to_string(), Some(SqlValue::number(42)));
        params.insert("name".to_string(), Some(SqlValue::string("alice")));
        let out = qp
            .convert_to_sql_parameters(
                "SELECT * FROM t WHERE id = :id AND name = :name",
                &params,
            )
            .unwrap();
        assert_eq!(out.len(), 2);
        let by_name: HashMap<&str, &StatementParameter> =
            out.iter().map(|p| (p.name.as_str(), p)).collect();
        assert_eq!(by_name["id"].value, "42");
        assert_eq!(by_name["id"].type_name, "BIGINT");
        assert_eq!(by_name["name"].value, "alice");
        assert_eq!(by_name["name"].type_name, "STRING");
    }

    #[test]
    fn test_convert_parameters_none_dropped() {
        let qp = QueryProcessor::new();
        let mut params = BTreeMap::new();
        params.insert("id".to_string(), None);
        let out = qp
            .convert_to_sql_parameters("SELECT * FROM t WHERE id = :id", &params)
            .unwrap();
        assert!(out.is_empty());
    }

    #[test]
    fn test_convert_parameters_rejects_extra_keys() {
        let qp = QueryProcessor::new();
        let mut params = BTreeMap::new();
        params.insert("missing".to_string(), Some(SqlValue::string("x")));
        let err = qp
            .convert_to_sql_parameters("SELECT * FROM t WHERE id = :id", &params)
            .unwrap_err();
        assert_eq!(err.field, "missing");
        assert!(err.message.contains("valid: id"));
    }

    #[test]
    fn test_cache_key_parts_shape() {
        let qp = QueryProcessor::new();
        let parts = qp.cache_key_parts(
            "trips_by_zone",
            "{\"zone\":1}",
            "JSON",
            "deadbeef",
            "user-42",
        );
        assert_eq!(parts[0], "analytics:query");
        assert_eq!(parts[1], "trips_by_zone");
        assert_eq!(parts[2], "{\"zone\":1}");
        assert_eq!(parts[3], "\"JSON\"");
        assert_eq!(parts[4], "deadbeef");
        assert_eq!(parts[5], "user-42");
    }

    #[test]
    fn test_manifest_declares_sql_warehouse() {
        let core = AnalyticsPluginCore::new(AnalyticsPluginConfig::default());
        assert_eq!(core.name(), "analytics");
        assert_eq!(core.manifest().required_resources.len(), 1);
        assert_eq!(
            core.manifest().required_resources[0].resource_type,
            "sql_warehouse"
        );
        assert_eq!(core.phase(), PluginPhase::Normal);
    }

    #[test]
    fn test_is_valid_query_key() {
        assert!(is_valid_query_key("trips_by_zone"));
        assert!(is_valid_query_key("abc-123_xyz"));
        assert!(!is_valid_query_key(""));
        assert!(!is_valid_query_key("../secrets"));
        assert!(!is_valid_query_key("with space"));
        assert!(!is_valid_query_key("weird$name"));
    }

    #[test]
    fn test_load_query_prefers_obo() {
        let tmp = tempdir_in_target();
        let q_dir = tmp.join("queries");
        fs::create_dir_all(&q_dir).unwrap();
        let mut sp = fs::File::create(q_dir.join("foo.sql")).unwrap();
        sp.write_all(b"SELECT 1 AS service").unwrap();
        let mut obo = fs::File::create(q_dir.join("foo.obo.sql")).unwrap();
        obo.write_all(b"SELECT 1 AS user").unwrap();

        let q = load_query(&q_dir, "foo").expect("load");
        assert!(q.is_as_user);
        assert!(q.query.contains("user"));
    }

    #[test]
    fn test_load_query_falls_back_to_sp() {
        let tmp = tempdir_in_target();
        let q_dir = tmp.join("queries_sp_only");
        fs::create_dir_all(&q_dir).unwrap();
        let mut sp = fs::File::create(q_dir.join("bar.sql")).unwrap();
        sp.write_all(b"SELECT 'sp'").unwrap();

        let q = load_query(&q_dir, "bar").expect("load");
        assert!(!q.is_as_user);
        assert!(q.query.contains("sp"));
    }

    #[test]
    fn test_load_query_rejects_bad_key() {
        let tmp = tempdir_in_target();
        assert!(load_query(&tmp, "../etc/passwd").is_none());
    }

    /// Create a unique temp dir under the current target/ so tests don't pollute
    /// the repo and clean up isn't needed between runs.
    fn tempdir_in_target() -> PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let base = std::env::temp_dir().join("appkit-rs-analytics-tests");
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let pid = std::process::id();
        let dir = base.join(format!("{pid}-{n}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }
}
