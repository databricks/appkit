//! Vector Search connector — thin HTTP wrapper around the Databricks
//! Vector Search REST API. Mirrors the request/response shape expected by
//! the TypeScript `VectorSearchConnector`.
//!
//! Exposed operations:
//! - `query` → POST `/api/2.0/vector-search/indexes/:index/query`
//! - `query_next_page` → POST `/api/2.0/vector-search/indexes/:index/query-next-page`
//!
//! Auth: bearer token is passed per call (service-principal or OBO), matching
//! the pattern used by `SqlWarehouseConnector` and `FilesConnector`.
//!
//! The Python-facing class wraps a handful of strongly-typed accessors but
//! returns raw JSON strings for response data so the Python layer can reuse
//! its existing response-shaping logic without re-serialising across the PyO3
//! boundary on every row.

use pyo3::prelude::*;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map as JsonMap, Value as JsonValue};

// ---------------------------------------------------------------------------
// Request / response types (Rust-internal)
// ---------------------------------------------------------------------------

/// Single filter value — a scalar or a list of scalars.
#[derive(Clone, Debug, PartialEq)]
pub enum FilterValue {
    String(String),
    Number(f64),
    Boolean(bool),
    Array(Vec<FilterValue>),
}

impl FilterValue {
    fn to_json(&self) -> JsonValue {
        match self {
            Self::String(s) => JsonValue::String(s.clone()),
            Self::Number(n) => serde_json::Number::from_f64(*n)
                .map(JsonValue::Number)
                .unwrap_or(JsonValue::Null),
            Self::Boolean(b) => JsonValue::Bool(*b),
            Self::Array(v) => JsonValue::Array(v.iter().map(FilterValue::to_json).collect()),
        }
    }
}

/// Parameters for a query request.
#[derive(Clone, Debug)]
pub struct VsQueryParams {
    pub index_name: String,
    pub query_text: Option<String>,
    pub query_vector: Option<Vec<f64>>,
    pub columns: Vec<String>,
    pub num_results: u32,
    pub query_type: VsQueryType,
    pub filters: Option<Vec<(String, FilterValue)>>,
    pub reranker_columns: Option<Vec<String>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VsQueryType {
    Ann,
    Hybrid,
    FullText,
}

impl VsQueryType {
    pub fn as_wire(&self) -> &'static str {
        match self {
            Self::Ann => "ANN",
            Self::Hybrid => "HYBRID",
            Self::FullText => "FULL_TEXT",
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Ann => "ann",
            Self::Hybrid => "hybrid",
            Self::FullText => "full_text",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s.to_ascii_lowercase().as_str() {
            "ann" => Some(Self::Ann),
            "hybrid" => Some(Self::Hybrid),
            "full_text" => Some(Self::FullText),
            _ => None,
        }
    }
}

#[derive(Clone, Debug)]
pub struct VsNextPageParams {
    pub index_name: String,
    pub endpoint_name: String,
    pub page_token: String,
}

// ---------------------------------------------------------------------------
// Body building — separated from HTTP for testability
// ---------------------------------------------------------------------------

/// Build the JSON body for a `query` request. This is the core
/// request-builder behavior called out in the checklist — keep it pure so
/// tests can verify the wire shape without a live HTTP server.
pub fn build_query_body(p: &VsQueryParams) -> JsonValue {
    let mut body = JsonMap::new();
    body.insert(
        "columns".into(),
        JsonValue::Array(
            p.columns
                .iter()
                .map(|c| JsonValue::String(c.clone()))
                .collect(),
        ),
    );
    body.insert("num_results".into(), JsonValue::Number(p.num_results.into()));
    body.insert(
        "query_type".into(),
        JsonValue::String(p.query_type.as_wire().to_string()),
    );
    body.insert("debug_level".into(), JsonValue::Number(1.into()));

    if let Some(ref q) = p.query_text {
        body.insert("query_text".into(), JsonValue::String(q.clone()));
    }
    if let Some(ref v) = p.query_vector {
        let arr: Vec<JsonValue> = v
            .iter()
            .map(|n| {
                serde_json::Number::from_f64(*n)
                    .map(JsonValue::Number)
                    .unwrap_or(JsonValue::Null)
            })
            .collect();
        body.insert("query_vector".into(), JsonValue::Array(arr));
    }
    if let Some(ref filters) = p.filters {
        if !filters.is_empty() {
            let mut map = JsonMap::new();
            for (k, v) in filters {
                map.insert(k.clone(), v.to_json());
            }
            body.insert("filters".into(), JsonValue::Object(map));
        }
    }
    if let Some(ref cols) = p.reranker_columns {
        body.insert(
            "reranker".into(),
            json!({
                "model": "databricks_reranker",
                "parameters": { "columns_to_rerank": cols }
            }),
        );
    }

    JsonValue::Object(body)
}

/// Build the JSON body for a `query-next-page` request.
pub fn build_next_page_body(p: &VsNextPageParams) -> JsonValue {
    json!({
        "endpoint_name": p.endpoint_name,
        "page_token": p.page_token,
    })
}

// ---------------------------------------------------------------------------
// HTTP connector
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS: u64 = 30_000;

/// Databricks Vector Search REST connector. HTTP-level only — the plugin
/// layer handles embedding-fn resolution, reranker resolution, and response
/// shaping into `SearchResponse`.
#[pyclass(module = "appkit")]
pub struct VectorSearchConnector {
    host: String,
    timeout_ms: u64,
    http: Client,
}

impl VectorSearchConnector {
    async fn post_json(
        &self,
        token: &str,
        path: &str,
        body: &JsonValue,
    ) -> Result<String, String> {
        let url = format!("{}{}", self.host, path);
        let resp = self
            .http
            .post(&url)
            .bearer_auth(token)
            .timeout(std::time::Duration::from_millis(self.timeout_ms))
            .json(body)
            .send()
            .await
            .map_err(|e| format!("Vector search request failed: {e}"))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("Vector search error ({status}): {text}"));
        }

        resp.text()
            .await
            .map_err(|e| format!("Failed to read response body: {e}"))
    }

    /// Low-level query — returns the raw JSON body string from the VS API.
    pub async fn query_internal(
        &self,
        token: &str,
        params: &VsQueryParams,
    ) -> Result<String, String> {
        let path = format!(
            "/api/2.0/vector-search/indexes/{}/query",
            params.index_name
        );
        let body = build_query_body(params);
        self.post_json(token, &path, &body).await
    }

    /// Low-level next-page query.
    pub async fn query_next_page_internal(
        &self,
        token: &str,
        params: &VsNextPageParams,
    ) -> Result<String, String> {
        let path = format!(
            "/api/2.0/vector-search/indexes/{}/query-next-page",
            params.index_name
        );
        let body = build_next_page_body(params);
        self.post_json(token, &path, &body).await
    }
}

// ---------------------------------------------------------------------------
// Python-facing request structs
// ---------------------------------------------------------------------------

/// Mirrors the TS `SearchRequest` input — parsed from a plain dict on the
/// Python side and passed here to keep request validation + body construction
/// in Rust.
#[pyclass(frozen, name = "VsSearchRequest", module = "appkit")]
#[derive(Clone)]
pub struct PyVsSearchRequest {
    #[pyo3(get)]
    pub query_text: Option<String>,
    #[pyo3(get)]
    pub query_vector: Option<Vec<f64>>,
    #[pyo3(get)]
    pub columns: Option<Vec<String>>,
    #[pyo3(get)]
    pub num_results: Option<u32>,
    #[pyo3(get)]
    pub query_type: Option<String>,
    /// Filters as JSON string (parsed/serialized by Python side).
    #[pyo3(get)]
    pub filters_json: Option<String>,
    #[pyo3(get)]
    pub reranker_columns: Option<Vec<String>>,
}

#[pymethods]
impl PyVsSearchRequest {
    #[new]
    #[pyo3(signature = (*, query_text = None, query_vector = None, columns = None, num_results = None, query_type = None, filters_json = None, reranker_columns = None))]
    #[allow(clippy::too_many_arguments)]
    fn new(
        query_text: Option<String>,
        query_vector: Option<Vec<f64>>,
        columns: Option<Vec<String>>,
        num_results: Option<u32>,
        query_type: Option<String>,
        filters_json: Option<String>,
        reranker_columns: Option<Vec<String>>,
    ) -> Self {
        Self {
            query_text,
            query_vector,
            columns,
            num_results,
            query_type,
            filters_json,
            reranker_columns,
        }
    }

    fn __repr__(&self) -> String {
        format!(
            "VsSearchRequest(query_type={:?}, num_results={:?})",
            self.query_type, self.num_results
        )
    }
}

#[pymethods]
impl VectorSearchConnector {
    #[new]
    #[pyo3(signature = (host, *, timeout_ms = None))]
    fn new(host: String, timeout_ms: Option<u64>) -> Self {
        Self {
            host: host.trim_end_matches('/').to_string(),
            timeout_ms: timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS),
            http: Client::new(),
        }
    }

    /// Execute a query. Returns the raw JSON body of the API response as a
    /// string (matches `SqlWarehouseConnector.execute_statement` convention of
    /// returning deserialized-once results).
    #[pyo3(signature = (
        token,
        index_name,
        *,
        columns,
        num_results = 20,
        query_type = "hybrid".to_string(),
        query_text = None,
        query_vector = None,
        filters_json = None,
        reranker_columns = None,
    ))]
    #[allow(clippy::too_many_arguments)]
    fn query<'py>(
        &self,
        py: Python<'py>,
        token: String,
        index_name: String,
        columns: Vec<String>,
        num_results: u32,
        query_type: String,
        query_text: Option<String>,
        query_vector: Option<Vec<f64>>,
        filters_json: Option<String>,
        reranker_columns: Option<Vec<String>>,
    ) -> PyResult<Bound<'py, PyAny>> {
        let qt = VsQueryType::parse(&query_type).ok_or_else(|| {
            pyo3::exceptions::PyValueError::new_err(format!(
                "Invalid query_type: {query_type}. Expected ann | hybrid | full_text"
            ))
        })?;

        let filters = match filters_json {
            Some(s) if !s.is_empty() => Some(parse_filters_json(&s).map_err(|e| {
                pyo3::exceptions::PyValueError::new_err(format!(
                    "Invalid filters_json: {e}"
                ))
            })?),
            _ => None,
        };

        let params = VsQueryParams {
            index_name,
            query_text,
            query_vector,
            columns,
            num_results,
            query_type: qt,
            filters,
            reranker_columns,
        };

        let host = self.host.clone();
        let http = self.http.clone();
        let timeout_ms = self.timeout_ms;

        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let connector = Self { host, timeout_ms, http };
            connector
                .query_internal(&token, &params)
                .await
                .map_err(pyo3::exceptions::PyRuntimeError::new_err)
        })
    }

    /// Fetch the next page of results for a paginated query.
    #[pyo3(signature = (token, index_name, endpoint_name, page_token))]
    fn query_next_page<'py>(
        &self,
        py: Python<'py>,
        token: String,
        index_name: String,
        endpoint_name: String,
        page_token: String,
    ) -> PyResult<Bound<'py, PyAny>> {
        let host = self.host.clone();
        let http = self.http.clone();
        let timeout_ms = self.timeout_ms;

        let params = VsNextPageParams { index_name, endpoint_name, page_token };

        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let connector = Self { host, timeout_ms, http };
            connector
                .query_next_page_internal(&token, &params)
                .await
                .map_err(pyo3::exceptions::PyRuntimeError::new_err)
        })
    }

    fn __repr__(&self) -> String {
        format!(
            "VectorSearchConnector(host={:?}, timeout_ms={})",
            self.host, self.timeout_ms
        )
    }
}

// Parse `filters_json` — a JSON object of scalar or array values.
fn parse_filters_json(s: &str) -> Result<Vec<(String, FilterValue)>, String> {
    let raw: JsonValue =
        serde_json::from_str(s).map_err(|e| format!("not valid JSON: {e}"))?;
    let JsonValue::Object(map) = raw else {
        return Err("expected a JSON object".into());
    };
    let mut out = Vec::with_capacity(map.len());
    for (k, v) in map {
        out.push((k, json_to_filter_value(v)?));
    }
    Ok(out)
}

fn json_to_filter_value(v: JsonValue) -> Result<FilterValue, String> {
    match v {
        JsonValue::String(s) => Ok(FilterValue::String(s)),
        JsonValue::Number(n) => n
            .as_f64()
            .ok_or_else(|| "non-finite number".to_string())
            .map(FilterValue::Number),
        JsonValue::Bool(b) => Ok(FilterValue::Boolean(b)),
        JsonValue::Array(arr) => {
            let mut items = Vec::with_capacity(arr.len());
            for item in arr {
                items.push(json_to_filter_value(item)?);
            }
            Ok(FilterValue::Array(items))
        }
        JsonValue::Null => Err("null filter values are not supported".into()),
        JsonValue::Object(_) => Err("nested object filters are not supported".into()),
    }
}

// ---------------------------------------------------------------------------
// Response shaping — ported from the TS `_parseResponse`
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct RawResponse {
    manifest: Option<RawManifest>,
    result: Option<RawResult>,
    next_page_token: Option<String>,
    debug_info: Option<RawDebugInfo>,
}

#[derive(Deserialize)]
struct RawManifest {
    #[serde(default)]
    columns: Vec<RawColumn>,
}

#[derive(Deserialize)]
struct RawColumn {
    name: String,
}

#[derive(Deserialize)]
struct RawResult {
    #[serde(default)]
    row_count: u64,
    #[serde(default)]
    data_array: Vec<Vec<JsonValue>>,
}

#[derive(Deserialize)]
struct RawDebugInfo {
    #[serde(default)]
    response_time: Option<u64>,
    #[serde(default)]
    latency_ms: Option<u64>,
}

/// Ported from `VectorSearchPlugin._parseResponse` — shape raw VS output
/// into `{ results: [{ score, data }], totalCount, queryTimeMs, queryType,
/// nextPageToken }`. Keeping this on the Rust side lets Python consumers
/// render hits directly without re-implementing the row-to-object transform.
#[derive(Serialize)]
pub struct SearchResponse {
    pub results: Vec<SearchHit>,
    #[serde(rename = "totalCount")]
    pub total_count: u64,
    #[serde(rename = "queryTimeMs")]
    pub query_time_ms: u64,
    #[serde(rename = "queryType")]
    pub query_type: String,
    #[serde(rename = "nextPageToken")]
    pub next_page_token: Option<String>,
}

#[derive(Serialize)]
pub struct SearchHit {
    pub score: f64,
    pub data: JsonMap<String, JsonValue>,
}

pub fn parse_vs_response(raw_body: &str, query_type: VsQueryType) -> Result<SearchResponse, String> {
    let raw: RawResponse =
        serde_json::from_str(raw_body).map_err(|e| format!("Invalid VS response: {e}"))?;
    let manifest = raw.manifest.unwrap_or(RawManifest { columns: vec![] });
    let result = raw.result.unwrap_or(RawResult {
        row_count: 0,
        data_array: vec![],
    });

    let col_names: Vec<String> = manifest.columns.iter().map(|c| c.name.clone()).collect();
    let score_idx = col_names.iter().position(|n| n == "score");

    let mut hits = Vec::with_capacity(result.data_array.len());
    for row in &result.data_array {
        let mut data = JsonMap::new();
        for (i, name) in col_names.iter().enumerate() {
            if name == "score" {
                continue;
            }
            let value = row.get(i).cloned().unwrap_or(JsonValue::Null);
            data.insert(name.clone(), value);
        }
        let score = score_idx
            .and_then(|idx| row.get(idx))
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0);
        hits.push(SearchHit { score, data });
    }

    let query_time_ms = raw
        .debug_info
        .as_ref()
        .and_then(|d| d.response_time.or(d.latency_ms))
        .unwrap_or(0);

    Ok(SearchResponse {
        results: hits,
        total_count: result.row_count,
        query_time_ms,
        query_type: query_type.as_str().to_string(),
        next_page_token: raw.next_page_token,
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_query_body_minimal() {
        let body = build_query_body(&VsQueryParams {
            index_name: "cat.sch.idx".into(),
            query_text: Some("hello".into()),
            query_vector: None,
            columns: vec!["id".into(), "title".into()],
            num_results: 10,
            query_type: VsQueryType::Hybrid,
            filters: None,
            reranker_columns: None,
        });
        assert_eq!(body["query_text"], JsonValue::String("hello".into()));
        assert_eq!(body["num_results"], JsonValue::Number(10.into()));
        assert_eq!(body["query_type"], JsonValue::String("HYBRID".into()));
        assert_eq!(body["debug_level"], JsonValue::Number(1.into()));
        assert_eq!(
            body["columns"],
            JsonValue::Array(vec![
                JsonValue::String("id".into()),
                JsonValue::String("title".into())
            ])
        );
        // No query_vector, filters, or reranker when not provided.
        assert!(body.get("query_vector").is_none());
        assert!(body.get("filters").is_none());
        assert!(body.get("reranker").is_none());
    }

    #[test]
    fn test_build_query_body_with_reranker_and_filters() {
        let body = build_query_body(&VsQueryParams {
            index_name: "x".into(),
            query_text: None,
            query_vector: Some(vec![0.1, 0.2, 0.3]),
            columns: vec!["id".into()],
            num_results: 5,
            query_type: VsQueryType::Ann,
            filters: Some(vec![
                ("region".into(), FilterValue::String("us-west".into())),
                (
                    "tags".into(),
                    FilterValue::Array(vec![
                        FilterValue::String("a".into()),
                        FilterValue::String("b".into()),
                    ]),
                ),
            ]),
            reranker_columns: Some(vec!["title".into(), "body".into()]),
        });
        assert_eq!(body["query_type"], JsonValue::String("ANN".into()));
        let vec_arr = body["query_vector"].as_array().unwrap();
        assert_eq!(vec_arr.len(), 3);
        assert_eq!(body["filters"]["region"], JsonValue::String("us-west".into()));
        assert_eq!(
            body["filters"]["tags"],
            JsonValue::Array(vec![
                JsonValue::String("a".into()),
                JsonValue::String("b".into())
            ])
        );
        assert_eq!(
            body["reranker"]["model"],
            JsonValue::String("databricks_reranker".into())
        );
        assert_eq!(
            body["reranker"]["parameters"]["columns_to_rerank"],
            JsonValue::Array(vec![
                JsonValue::String("title".into()),
                JsonValue::String("body".into())
            ])
        );
    }

    #[test]
    fn test_build_next_page_body() {
        let body = build_next_page_body(&VsNextPageParams {
            index_name: "x".into(),
            endpoint_name: "ep".into(),
            page_token: "tok".into(),
        });
        assert_eq!(body["endpoint_name"], JsonValue::String("ep".into()));
        assert_eq!(body["page_token"], JsonValue::String("tok".into()));
    }

    #[test]
    fn test_query_type_parse_and_roundtrip() {
        assert_eq!(VsQueryType::parse("ann"), Some(VsQueryType::Ann));
        assert_eq!(VsQueryType::parse("Hybrid"), Some(VsQueryType::Hybrid));
        assert_eq!(VsQueryType::parse("FULL_TEXT"), Some(VsQueryType::FullText));
        assert_eq!(VsQueryType::parse("bogus"), None);

        assert_eq!(VsQueryType::Ann.as_wire(), "ANN");
        assert_eq!(VsQueryType::Hybrid.as_str(), "hybrid");
    }

    #[test]
    fn test_parse_filters_json() {
        let f = parse_filters_json(r#"{"a":"x","b":1,"c":true,"d":["p","q"]}"#).unwrap();
        let map: std::collections::HashMap<String, FilterValue> = f.into_iter().collect();
        assert_eq!(map["a"], FilterValue::String("x".into()));
        assert_eq!(map["b"], FilterValue::Number(1.0));
        assert_eq!(map["c"], FilterValue::Boolean(true));
        match &map["d"] {
            FilterValue::Array(items) => assert_eq!(items.len(), 2),
            _ => panic!("expected array"),
        }
    }

    #[test]
    fn test_parse_filters_rejects_null_and_nested() {
        assert!(parse_filters_json(r#"{"a":null}"#).is_err());
        assert!(parse_filters_json(r#"{"a":{"nested":"x"}}"#).is_err());
        assert!(parse_filters_json(r#"[1,2]"#).is_err()); // non-object
    }

    #[test]
    fn test_parse_vs_response_shapes_hits() {
        let raw = r#"{
            "manifest": {"columns": [{"name":"id"},{"name":"title"},{"name":"score"}]},
            "result": {"row_count": 2, "data_array": [["1","hello",0.9],["2","world",0.8]]},
            "next_page_token": "tok",
            "debug_info": {"response_time": 42}
        }"#;
        let resp = parse_vs_response(raw, VsQueryType::Hybrid).unwrap();
        assert_eq!(resp.total_count, 2);
        assert_eq!(resp.query_type, "hybrid");
        assert_eq!(resp.query_time_ms, 42);
        assert_eq!(resp.next_page_token.as_deref(), Some("tok"));
        assert_eq!(resp.results.len(), 2);
        assert_eq!(resp.results[0].score, 0.9);
        assert_eq!(resp.results[0].data["id"], JsonValue::String("1".into()));
        assert_eq!(
            resp.results[0].data["title"],
            JsonValue::String("hello".into())
        );
        assert!(resp.results[0].data.get("score").is_none());
    }

    #[test]
    fn test_parse_vs_response_missing_fields() {
        let raw = r#"{}"#;
        let resp = parse_vs_response(raw, VsQueryType::Ann).unwrap();
        assert_eq!(resp.total_count, 0);
        assert!(resp.results.is_empty());
        assert_eq!(resp.query_time_ms, 0);
    }
}
