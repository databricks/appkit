use pyo3::prelude::*;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;

// ---------------------------------------------------------------------------
// Defaults matching TS executeStatementDefaults
// ---------------------------------------------------------------------------

const DEFAULT_WAIT_TIMEOUT: &str = "30s";
const DEFAULT_DISPOSITION: &str = "INLINE";
const DEFAULT_FORMAT: &str = "JSON_ARRAY";
const DEFAULT_ON_WAIT_TIMEOUT: &str = "CONTINUE";
const DEFAULT_POLL_TIMEOUT_MS: u64 = 60_000;
const INITIAL_POLL_DELAY_MS: u64 = 1_000;
const MAX_POLL_DELAY_MS: u64 = 5_000;

// ---------------------------------------------------------------------------
// Internal serde types for Databricks SQL Statement Execution API
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct ExecuteStatementBody {
    statement: String,
    warehouse_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    parameters: Option<Vec<StatementParam>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    catalog: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    schema: Option<String>,
    wait_timeout: String,
    disposition: String,
    format: String,
    on_wait_timeout: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    byte_limit: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    row_limit: Option<u64>,
}

#[derive(Serialize, Deserialize, Clone)]
struct StatementParam {
    name: String,
    value: String,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    type_name: Option<String>,
}

#[derive(Deserialize, Debug)]
struct StatementApiResponse {
    statement_id: Option<String>,
    status: Option<StatementStatus>,
    manifest: Option<StatementManifest>,
    result: Option<StatementResult>,
}

#[derive(Deserialize, Debug)]
struct StatementStatus {
    state: Option<String>,
    error: Option<StatementError>,
}

#[derive(Deserialize, Debug)]
struct StatementError {
    message: Option<String>,
}

#[derive(Deserialize, Debug, Clone)]
struct StatementManifest {
    #[allow(dead_code)]
    format: Option<String>,
    schema: Option<ManifestSchema>,
}

#[derive(Deserialize, Debug, Clone)]
struct ManifestSchema {
    columns: Option<Vec<ColumnInfo>>,
}

#[derive(Deserialize, Debug, Clone)]
struct ColumnInfo {
    name: Option<String>,
    type_name: Option<String>,
}

#[derive(Deserialize, Debug)]
struct StatementResult {
    data_array: Option<Vec<Vec<Option<String>>>>,
}

// ---------------------------------------------------------------------------
// Python-facing response types (frozen / immutable)
// ---------------------------------------------------------------------------

/// Column schema information.
#[pyclass(frozen, module = "appkit")]
#[derive(Clone)]
pub struct SqlColumn {
    #[pyo3(get)]
    pub name: String,
    #[pyo3(get)]
    pub type_name: String,
}

#[pymethods]
impl SqlColumn {
    fn __repr__(&self) -> String {
        format!("SqlColumn(name={:?}, type_name={:?})", self.name, self.type_name)
    }

    fn __eq__(&self, other: &Self) -> bool {
        self.name == other.name && self.type_name == other.type_name
    }

    fn __hash__(&self) -> u64 {
        use std::hash::{Hash, Hasher};
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        self.name.hash(&mut hasher);
        self.type_name.hash(&mut hasher);
        hasher.finish()
    }
}

/// Result of a SQL statement execution.
#[pyclass(frozen, module = "appkit")]
#[derive(Clone)]
pub struct SqlStatementResult {
    #[pyo3(get)]
    pub statement_id: String,
    #[pyo3(get)]
    pub status: String,
    /// Column schema.
    #[pyo3(get)]
    pub columns: Vec<SqlColumn>,
    /// Result rows as JSON string (array of objects). Empty string if no data.
    #[pyo3(get)]
    pub data: String,
    /// Number of result rows.
    #[pyo3(get)]
    pub row_count: usize,
}

#[pymethods]
impl SqlStatementResult {
    fn __repr__(&self) -> String {
        format!(
            "SqlStatementResult(statement_id={:?}, status={:?}, row_count={})",
            self.statement_id, self.status, self.row_count
        )
    }

    fn __len__(&self) -> usize {
        self.row_count
    }

    fn __bool__(&self) -> bool {
        self.row_count > 0
    }
}

// ---------------------------------------------------------------------------
// Data transformation — mirrors TS _transformDataArray
// ---------------------------------------------------------------------------

fn transform_data_array(
    columns: &[ColumnInfo],
    data_array: &[Vec<Option<String>>],
) -> (Vec<serde_json::Map<String, JsonValue>>, usize) {
    let mut rows = Vec::with_capacity(data_array.len());

    for row in data_array {
        let mut obj = serde_json::Map::new();
        for (i, cell) in row.iter().enumerate() {
            let col = columns.get(i);
            let col_name = col
                .and_then(|c| c.name.as_deref())
                .unwrap_or(&format!("column_{i}"))
                .to_string();
            let col_type = col.and_then(|c| c.type_name.as_deref()).unwrap_or("");

            let value = match cell {
                None => JsonValue::Null,
                Some(v) => {
                    // Attempt to parse JSON for STRING columns (matches TS behavior)
                    if col_type == "STRING"
                        && !v.is_empty()
                        && (v.starts_with('{') || v.starts_with('['))
                    {
                        serde_json::from_str(v).unwrap_or_else(|_| JsonValue::String(v.clone()))
                    } else {
                        JsonValue::String(v.clone())
                    }
                }
            };
            obj.insert(col_name, value);
        }
        rows.push(obj);
    }

    let count = rows.len();
    (rows, count)
}

// ---------------------------------------------------------------------------
// SqlWarehouseConnector
// ---------------------------------------------------------------------------

/// Databricks SQL Warehouse connector.
///
/// Executes SQL statements against a Databricks SQL Warehouse via the
/// REST API at `/api/2.0/sql/statements`. Supports parameterized queries,
/// automatic polling for async results, and JSON_ARRAY result transformation.
#[pyclass(module = "appkit")]
pub struct SqlWarehouseConnector {
    host: String,
    timeout_ms: u64,
    http: Client,
}

impl SqlWarehouseConnector {
    /// Internal: execute and poll for statement result.
    async fn execute_internal(
        host: &str,
        http: &Client,
        token: &str,
        body: &ExecuteStatementBody,
        timeout_ms: u64,
    ) -> Result<SqlStatementResult, String> {
        // 1. Submit statement
        let url = format!("{}/api/2.0/sql/statements", host);
        let resp = http
            .post(&url)
            .bearer_auth(token)
            .json(body)
            .send()
            .await
            .map_err(|e| format!("Statement execution request failed: {e}"))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("Execute statement failed ({status}): {text}"));
        }

        let api_resp: StatementApiResponse = resp
            .json()
            .await
            .map_err(|e| format!("Failed to parse statement response: {e}"))?;

        let statement_id = api_resp
            .statement_id
            .clone()
            .unwrap_or_default();
        let state = api_resp
            .status
            .as_ref()
            .and_then(|s| s.state.as_deref())
            .unwrap_or("UNKNOWN");

        match state {
            "SUCCEEDED" => Self::build_result(&api_resp),
            "PENDING" | "RUNNING" => {
                Self::poll_for_result(host, http, token, &statement_id, timeout_ms).await
            }
            "FAILED" => {
                let msg = api_resp
                    .status
                    .as_ref()
                    .and_then(|s| s.error.as_ref())
                    .and_then(|e| e.message.as_deref())
                    .unwrap_or("Statement failed");
                Err(format!("Statement failed: {msg}"))
            }
            "CANCELED" => Err("Statement was canceled.".into()),
            "CLOSED" => Err("Statement results have been closed.".into()),
            other => Err(format!("Unknown statement state: {other}")),
        }
    }

    /// Internal: poll GET /api/2.0/sql/statements/{id} until terminal state.
    async fn poll_for_result(
        host: &str,
        http: &Client,
        token: &str,
        statement_id: &str,
        timeout_ms: u64,
    ) -> Result<SqlStatementResult, String> {
        let start = std::time::Instant::now();
        let mut delay = INITIAL_POLL_DELAY_MS;

        loop {
            let elapsed = start.elapsed().as_millis() as u64;
            if elapsed > timeout_ms {
                return Err(format!(
                    "Polling timeout exceeded after {timeout_ms}ms (elapsed: {elapsed}ms)"
                ));
            }

            tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
            delay = (delay * 2).min(MAX_POLL_DELAY_MS);

            let url = format!("{}/api/2.0/sql/statements/{}", host, statement_id);
            let resp = http
                .get(&url)
                .bearer_auth(token)
                .send()
                .await
                .map_err(|e| format!("Poll request failed: {e}"))?;

            if !resp.status().is_success() {
                let status = resp.status();
                let body = resp.text().await.unwrap_or_default();
                return Err(format!("Poll failed ({status}): {body}"));
            }

            let api_resp: StatementApiResponse = resp
                .json()
                .await
                .map_err(|e| format!("Failed to parse poll response: {e}"))?;

            let state = api_resp
                .status
                .as_ref()
                .and_then(|s| s.state.as_deref())
                .unwrap_or("UNKNOWN");

            match state {
                "SUCCEEDED" => return Self::build_result(&api_resp),
                "PENDING" | "RUNNING" => continue,
                "FAILED" => {
                    let msg = api_resp
                        .status
                        .as_ref()
                        .and_then(|s| s.error.as_ref())
                        .and_then(|e| e.message.as_deref())
                        .unwrap_or("Statement failed");
                    return Err(format!("Statement failed: {msg}"));
                }
                "CANCELED" => return Err("Statement was canceled.".into()),
                "CLOSED" => return Err("Statement results have been closed.".into()),
                other => return Err(format!("Unknown statement state: {other}")),
            }
        }
    }

    /// Build a SqlStatementResult from a SUCCEEDED API response.
    fn build_result(api_resp: &StatementApiResponse) -> Result<SqlStatementResult, String> {
        let statement_id = api_resp.statement_id.clone().unwrap_or_default();
        let columns_raw = api_resp
            .manifest
            .as_ref()
            .and_then(|m| m.schema.as_ref())
            .and_then(|s| s.columns.as_ref());

        let columns: Vec<SqlColumn> = columns_raw
            .map(|cols| {
                cols.iter()
                    .map(|c| SqlColumn {
                        name: c.name.clone().unwrap_or_default(),
                        type_name: c.type_name.clone().unwrap_or_default(),
                    })
                    .collect()
            })
            .unwrap_or_default();

        let data_array = api_resp
            .result
            .as_ref()
            .and_then(|r| r.data_array.as_ref());

        let (data_json, row_count) = match (columns_raw, data_array) {
            (Some(cols), Some(arr)) => {
                let (rows, count) = transform_data_array(cols, arr);
                let json =
                    serde_json::to_string(&rows).unwrap_or_else(|_| "[]".to_string());
                (json, count)
            }
            _ => ("[]".to_string(), 0),
        };

        Ok(SqlStatementResult {
            statement_id,
            status: "SUCCEEDED".to_string(),
            columns,
            data: data_json,
            row_count,
        })
    }
}

#[pymethods]
impl SqlWarehouseConnector {
    #[new]
    #[pyo3(signature = (host, *, timeout_ms = None))]
    fn new(host: String, timeout_ms: Option<u64>) -> Self {
        Self {
            host: host.trim_end_matches('/').to_string(),
            timeout_ms: timeout_ms.unwrap_or(DEFAULT_POLL_TIMEOUT_MS),
            http: Client::new(),
        }
    }

    /// Execute a SQL statement against a warehouse.
    ///
    /// Polls automatically if the statement is PENDING/RUNNING. Returns
    /// a `SqlStatementResult` with transformed JSON_ARRAY data (array of
    /// column-named objects) matching the TypeScript SDK behavior.
    #[pyo3(signature = (
        token,
        statement,
        warehouse_id,
        *,
        parameters = None,
        catalog = None,
        schema = None,
        wait_timeout = None,
        disposition = None,
        format = None,
        on_wait_timeout = None,
        byte_limit = None,
        row_limit = None,
        timeout_ms = None,
    ))]
    #[allow(clippy::too_many_arguments)]
    fn execute_statement<'py>(
        &self,
        py: Python<'py>,
        token: String,
        statement: String,
        warehouse_id: String,
        parameters: Option<Vec<(String, String)>>,
        catalog: Option<String>,
        schema: Option<String>,
        wait_timeout: Option<String>,
        disposition: Option<String>,
        format: Option<String>,
        on_wait_timeout: Option<String>,
        byte_limit: Option<u64>,
        row_limit: Option<u64>,
        timeout_ms: Option<u64>,
    ) -> PyResult<Bound<'py, PyAny>> {
        let host = self.host.clone();
        let http = self.http.clone();
        let poll_timeout = timeout_ms.unwrap_or(self.timeout_ms);

        let params = parameters.map(|ps| {
            ps.into_iter()
                .map(|(name, value)| StatementParam {
                    name,
                    value,
                    type_name: None,
                })
                .collect()
        });

        let body = ExecuteStatementBody {
            statement,
            warehouse_id,
            parameters: params,
            catalog,
            schema,
            wait_timeout: wait_timeout.unwrap_or_else(|| DEFAULT_WAIT_TIMEOUT.into()),
            disposition: disposition.unwrap_or_else(|| DEFAULT_DISPOSITION.into()),
            format: format.unwrap_or_else(|| DEFAULT_FORMAT.into()),
            on_wait_timeout: on_wait_timeout.unwrap_or_else(|| DEFAULT_ON_WAIT_TIMEOUT.into()),
            byte_limit,
            row_limit,
        };

        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            Self::execute_internal(&host, &http, &token, &body, poll_timeout)
                .await
                .map_err(pyo3::exceptions::PyRuntimeError::new_err)
        })
    }

    fn __repr__(&self) -> String {
        format!(
            "SqlWarehouseConnector(host={:?}, timeout_ms={})",
            self.host, self.timeout_ms
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_transform_data_array_basic() {
        let columns = vec![
            ColumnInfo {
                name: Some("id".into()),
                type_name: Some("INT".into()),
            },
            ColumnInfo {
                name: Some("name".into()),
                type_name: Some("STRING".into()),
            },
        ];
        let data = vec![
            vec![Some("1".into()), Some("Alice".into())],
            vec![Some("2".into()), Some("Bob".into())],
        ];

        let (rows, count) = transform_data_array(&columns, &data);
        assert_eq!(count, 2);
        assert_eq!(rows[0]["id"], JsonValue::String("1".into()));
        assert_eq!(rows[0]["name"], JsonValue::String("Alice".into()));
        assert_eq!(rows[1]["id"], JsonValue::String("2".into()));
    }

    #[test]
    fn test_transform_null_values() {
        let columns = vec![ColumnInfo {
            name: Some("val".into()),
            type_name: Some("STRING".into()),
        }];
        let data = vec![vec![None]];

        let (rows, count) = transform_data_array(&columns, &data);
        assert_eq!(count, 1);
        assert_eq!(rows[0]["val"], JsonValue::Null);
    }

    #[test]
    fn test_transform_json_string_parsing() {
        let columns = vec![ColumnInfo {
            name: Some("meta".into()),
            type_name: Some("STRING".into()),
        }];
        let data = vec![
            vec![Some(r#"{"key":"value"}"#.into())],
            vec![Some("plain text".into())],
            vec![Some(r#"[1,2,3]"#.into())],
        ];

        let (rows, _) = transform_data_array(&columns, &data);
        // JSON object should be parsed
        assert!(rows[0]["meta"].is_object());
        // Plain string stays as string
        assert_eq!(rows[1]["meta"], JsonValue::String("plain text".into()));
        // JSON array should be parsed
        assert!(rows[2]["meta"].is_array());
    }

    #[test]
    fn test_transform_non_string_type_no_json_parse() {
        let columns = vec![ColumnInfo {
            name: Some("data".into()),
            type_name: Some("INT".into()),
        }];
        let data = vec![vec![Some("{123}".into())]];

        let (rows, _) = transform_data_array(&columns, &data);
        // INT column should NOT attempt JSON parse even if value looks like JSON
        assert_eq!(rows[0]["data"], JsonValue::String("{123}".into()));
    }

    #[test]
    fn test_build_result_empty() {
        let resp = StatementApiResponse {
            statement_id: Some("stmt-1".into()),
            status: Some(StatementStatus {
                state: Some("SUCCEEDED".into()),
                error: None,
            }),
            manifest: None,
            result: None,
        };
        let result = SqlWarehouseConnector::build_result(&resp).unwrap();
        assert_eq!(result.statement_id, "stmt-1");
        assert_eq!(result.status, "SUCCEEDED");
        assert_eq!(result.row_count, 0);
        assert_eq!(result.data, "[]");
    }
}
