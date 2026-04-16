use futures::StreamExt;
use pyo3::prelude::*;
use reqwest::Client;

use crate::interceptor::{ExecutionError, StreamItem};
use crate::plugin::PyStreamIterator;

// ---------------------------------------------------------------------------
// Python-facing response types (frozen / immutable)
// ---------------------------------------------------------------------------

/// Response from a serving endpoint invocation.
#[pyclass(frozen, module = "appkit")]
#[derive(Clone)]
pub struct ServingResponse {
    /// Response body as JSON string.
    #[pyo3(get)]
    pub data: String,
    /// HTTP status code from the endpoint.
    #[pyo3(get)]
    pub status_code: u16,
}

#[pymethods]
impl ServingResponse {
    fn __repr__(&self) -> String {
        format!(
            "ServingResponse(status_code={}, data_len={})",
            self.status_code,
            self.data.len()
        )
    }

    fn __bool__(&self) -> bool {
        self.status_code >= 200 && self.status_code < 300
    }

    fn __eq__(&self, other: &Self) -> bool {
        self.data == other.data && self.status_code == other.status_code
    }

    fn __hash__(&self) -> u64 {
        use std::hash::{Hash, Hasher};
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        self.data.hash(&mut hasher);
        self.status_code.hash(&mut hasher);
        hasher.finish()
    }
}

// ---------------------------------------------------------------------------
// SSE parser
// ---------------------------------------------------------------------------

/// Incremental SSE event parser. Buffers partial chunks and emits complete
/// `data:` payloads when a blank-line event boundary is encountered.
struct SseParser {
    buffer: String,
    data_lines: Vec<String>,
}

impl SseParser {
    fn new() -> Self {
        Self {
            buffer: String::new(),
            data_lines: Vec::new(),
        }
    }

    /// Feed a chunk of bytes and return any complete event data payloads.
    fn feed(&mut self, chunk: &[u8]) -> Vec<String> {
        self.buffer.push_str(&String::from_utf8_lossy(chunk));
        let mut events = Vec::new();

        while let Some(pos) = self.buffer.find('\n') {
            let line = self.buffer[..pos].trim_end_matches('\r').to_string();
            self.buffer = self.buffer[pos + 1..].to_string();

            if line.is_empty() {
                // Empty line = event boundary.
                if !self.data_lines.is_empty() {
                    events.push(self.data_lines.join("\n"));
                    self.data_lines.clear();
                }
            } else if let Some(data) = line.strip_prefix("data: ") {
                self.data_lines.push(data.to_string());
            } else if let Some(data) = line.strip_prefix("data:") {
                self.data_lines.push(data.to_string());
            }
            // Ignore other SSE fields (event:, id:, retry:, comments).
        }

        events
    }
}

// ---------------------------------------------------------------------------
// ServingConnector
// ---------------------------------------------------------------------------

/// Databricks Serving Endpoints connector.
///
/// Provides invocation and SSE streaming against model serving endpoints
/// via the REST API at `/serving-endpoints/{name}/invocations`.
#[pyclass(module = "appkit")]
pub struct ServingConnector {
    host: String,
    http: Client,
}

#[pymethods]
impl ServingConnector {
    #[new]
    #[pyo3(signature = (host))]
    fn new(host: String) -> Self {
        Self {
            host: host.trim_end_matches('/').to_string(),
            http: Client::new(),
        }
    }

    /// Invoke a serving endpoint (non-streaming).
    ///
    /// Strips any `stream` key from the body to prevent conflict with the
    /// connector's control of streaming mode (mirrors TS behavior).
    /// `body` is a JSON string of the request payload.
    #[pyo3(signature = (token, endpoint_name, body))]
    fn invoke<'py>(
        &self,
        py: Python<'py>,
        token: String,
        endpoint_name: String,
        body: String,
    ) -> PyResult<Bound<'py, PyAny>> {
        let http = self.http.clone();
        let host = self.host.clone();

        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            // Parse, strip `stream` key, re-serialize
            let mut payload: serde_json::Value = serde_json::from_str(&body).map_err(|e| {
                pyo3::exceptions::PyValueError::new_err(format!("Invalid JSON body: {e}"))
            })?;
            if let Some(obj) = payload.as_object_mut() {
                obj.remove("stream");
            }

            let url = format!(
                "{}/serving-endpoints/{}/invocations",
                host,
                urlencoding::encode(&endpoint_name),
            );

            let resp = http
                .post(&url)
                .bearer_auth(&token)
                .header("Content-Type", "application/json")
                .body(serde_json::to_vec(&payload).unwrap_or_default())
                .send()
                .await
                .map_err(|e| pyo3::exceptions::PyRuntimeError::new_err(e.to_string()))?;

            let status_code = resp.status().as_u16();
            let text = resp
                .text()
                .await
                .map_err(|e| pyo3::exceptions::PyRuntimeError::new_err(e.to_string()))?;

            if status_code >= 400 {
                return Err(pyo3::exceptions::PyRuntimeError::new_err(format!(
                    "Serving endpoint invocation failed ({status_code}): {text}"
                )));
            }

            Ok(ServingResponse {
                data: text,
                status_code,
            })
        })
    }

    /// Stream from a serving endpoint (SSE).
    ///
    /// Returns a `StreamIterator` that yields parsed SSE data payloads as
    /// they arrive. Each item is the `data:` field content (typically JSON).
    ///
    /// Sets `stream: true` in the request body and `Accept: text/event-stream`.
    /// The stream ends when the server sends `data: [DONE]` or closes the
    /// connection.
    #[pyo3(signature = (token, endpoint_name, body))]
    fn stream<'py>(
        &self,
        py: Python<'py>,
        token: String,
        endpoint_name: String,
        body: String,
    ) -> PyResult<Bound<'py, PyAny>> {
        let http = self.http.clone();
        let host = self.host.clone();

        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            // Parse, strip existing `stream`, set `stream: true`
            let mut payload: serde_json::Value = serde_json::from_str(&body).map_err(|e| {
                pyo3::exceptions::PyValueError::new_err(format!("Invalid JSON body: {e}"))
            })?;
            if let Some(obj) = payload.as_object_mut() {
                obj.remove("stream");
                obj.insert("stream".to_string(), serde_json::Value::Bool(true));
            }

            let url = format!(
                "{}/serving-endpoints/{}/invocations",
                host,
                urlencoding::encode(&endpoint_name),
            );

            let resp = http
                .post(&url)
                .bearer_auth(&token)
                .header("Content-Type", "application/json")
                .header("Accept", "text/event-stream")
                .body(serde_json::to_vec(&payload).unwrap_or_default())
                .send()
                .await
                .map_err(|e| pyo3::exceptions::PyRuntimeError::new_err(e.to_string()))?;

            if !resp.status().is_success() {
                let status = resp.status();
                let body = resp.text().await.unwrap_or_default();
                return Err(pyo3::exceptions::PyRuntimeError::new_err(format!(
                    "SSE stream request failed ({status}): {body}"
                )));
            }

            let (tx, rx) = tokio::sync::mpsc::channel::<StreamItem>(32);

            // Spawn task to incrementally parse SSE events from the byte stream.
            let byte_stream = resp.bytes_stream();
            tokio::spawn(async move {
                let mut parser = SseParser::new();
                tokio::pin!(byte_stream);

                while let Some(chunk_result) = byte_stream.next().await {
                    match chunk_result {
                        Ok(bytes) => {
                            for event_data in parser.feed(&bytes) {
                                if event_data == "[DONE]" {
                                    return;
                                }
                                if tx.send(Ok(event_data)).await.is_err() {
                                    return; // Receiver dropped.
                                }
                            }
                        }
                        Err(e) => {
                            let _ = tx
                                .send(Err(ExecutionError {
                                    status: 500,
                                    message: e.to_string(),
                                }))
                                .await;
                            return;
                        }
                    }
                }
            });

            Ok(PyStreamIterator::new(rx))
        })
    }

    fn __repr__(&self) -> String {
        format!("ServingConnector(host={:?})", self.host)
    }
}

#[cfg(test)]
mod tests {
    use super::SseParser;

    #[test]
    fn test_strip_stream_from_body() {
        let body = r#"{"inputs": "hello", "stream": false}"#;
        let mut payload: serde_json::Value = serde_json::from_str(body).unwrap();
        if let Some(obj) = payload.as_object_mut() {
            obj.remove("stream");
        }
        assert!(!payload.as_object().unwrap().contains_key("stream"));
        assert_eq!(payload["inputs"], "hello");
    }

    #[test]
    fn test_set_stream_true() {
        let body = r#"{"inputs": "hello"}"#;
        let mut payload: serde_json::Value = serde_json::from_str(body).unwrap();
        if let Some(obj) = payload.as_object_mut() {
            obj.remove("stream");
            obj.insert("stream".to_string(), serde_json::Value::Bool(true));
        }
        assert_eq!(payload["stream"], true);
    }

    // -- SSE parser --

    #[test]
    fn test_sse_parser_single_event() {
        let mut parser = SseParser::new();
        let events = parser.feed(b"data: {\"key\":\"val\"}\n\n");
        assert_eq!(events, vec!["{\"key\":\"val\"}"]);
    }

    #[test]
    fn test_sse_parser_multi_chunk() {
        let mut parser = SseParser::new();
        let events1 = parser.feed(b"data: hel");
        assert!(events1.is_empty());
        let events2 = parser.feed(b"lo\n\n");
        assert_eq!(events2, vec!["hello"]);
    }

    #[test]
    fn test_sse_parser_multiple_events() {
        let mut parser = SseParser::new();
        let events = parser.feed(b"data: first\n\ndata: second\n\n");
        assert_eq!(events, vec!["first", "second"]);
    }

    #[test]
    fn test_sse_parser_done_sentinel() {
        let mut parser = SseParser::new();
        let events = parser.feed(b"data: [DONE]\n\n");
        assert_eq!(events, vec!["[DONE]"]);
    }

    #[test]
    fn test_sse_parser_ignores_non_data_lines() {
        let mut parser = SseParser::new();
        let events = parser.feed(b"event: message\nid: 1\ndata: payload\n\n");
        assert_eq!(events, vec!["payload"]);
    }

    #[test]
    fn test_sse_parser_crlf() {
        let mut parser = SseParser::new();
        let events = parser.feed(b"data: hello\r\n\r\n");
        assert_eq!(events, vec!["hello"]);
    }
}
