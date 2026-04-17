//! Axum HTTP server with Python route injection, SSE streaming, static file
//! serving, and graceful shutdown.
//!
//! Ports `packages/appkit/src/plugins/server/index.ts`.

use std::collections::HashMap;
use std::convert::Infallible;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use axum::body::Bytes;
use axum::http::{header, HeaderMap, Method, StatusCode, Uri};
use axum::response::sse::{Event as AxumSseEvent, KeepAlive, Sse};
use axum::response::{IntoResponse, Json, Response};
use axum::routing::{delete, get, patch, post, put};
use axum::Router;
use futures::StreamExt;
use pyo3::prelude::*;
use serde_json::Value as JsonValue;
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;

use tower_http::cors::CorsLayer;

use pyo3_async_runtimes::TaskLocals;

use crate::stream::{SseEvent, StreamConfig, StreamManager};

// ---------------------------------------------------------------------------
// Clonable PyObject wrapper (acquires GIL for Clone)
// ---------------------------------------------------------------------------

/// Wrapper around `PyObject` that implements `Clone` by briefly acquiring the
/// GIL. This is needed because axum requires handler closures to be `Clone`.
///
/// # GIL acquisition on clone
///
/// Every `Clone::clone` call acquires the GIL via `Python::with_gil`. Under the
/// current GIL-based CPython runtime this is safe but adds contention when many
/// handler clones happen concurrently (e.g. during router initialization). If
/// PyO3 moves to a free-threaded build (`--disable-gil` / PEP 703), this
/// implementation must be revisited because `clone_ref` semantics may change.
#[derive(Debug)]
struct GilPyObject(PyObject);

impl Clone for GilPyObject {
    fn clone(&self) -> Self {
        Python::with_gil(|py| Self(self.0.clone_ref(py)))
    }
}

impl GilPyObject {
    fn new(obj: PyObject) -> Self {
        Self(obj)
    }

    fn into_inner(self) -> PyObject {
        self.0
    }
}

// ---------------------------------------------------------------------------
// Route types (crate-internal)
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
pub enum HttpMethod {
    Get,
    Post,
    Put,
    Delete,
    Patch,
}

impl HttpMethod {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Get => "GET",
            Self::Post => "POST",
            Self::Put => "PUT",
            Self::Delete => "DELETE",
            Self::Patch => "PATCH",
        }
    }
}

pub struct RouteDefinition {
    pub method: HttpMethod,
    pub path: String,
    pub handler: PyObject,
    pub is_stream: bool,
}

// ---------------------------------------------------------------------------
// PyRouter — collects route registrations from Python plugins
// ---------------------------------------------------------------------------

/// Router passed to `Plugin.inject_routes()` for route registration.
///
/// ```python
/// def inject_routes(self, router):
///     router.get("/items", self.get_items)
///     router.post("/items", self.create_item)
///     router.get("/stream", self.handle_stream, stream=True)
/// ```
#[pyclass(name = "Router", module = "appkit")]
pub struct PyRouter {
    routes: std::sync::Mutex<Vec<RouteDefinition>>,
    #[pyo3(get)]
    plugin_name: String,
}

impl PyRouter {
    pub fn new(plugin_name: &str) -> Self {
        Self {
            routes: std::sync::Mutex::new(Vec::new()),
            plugin_name: plugin_name.to_string(),
        }
    }

    /// Take the collected routes out of the router (consumes them).
    pub fn take_routes(&self) -> Vec<RouteDefinition> {
        std::mem::take(&mut *self.routes.lock().unwrap())
    }
}

#[pymethods]
impl PyRouter {
    #[pyo3(signature = (path, handler, *, stream = false))]
    fn get(&self, path: String, handler: PyObject, stream: bool) {
        self.routes.lock().unwrap().push(RouteDefinition {
            method: HttpMethod::Get,
            path,
            handler,
            is_stream: stream,
        });
    }

    #[pyo3(signature = (path, handler, *, stream = false))]
    fn post(&self, path: String, handler: PyObject, stream: bool) {
        self.routes.lock().unwrap().push(RouteDefinition {
            method: HttpMethod::Post,
            path,
            handler,
            is_stream: stream,
        });
    }

    #[pyo3(signature = (path, handler, *, stream = false))]
    fn put(&self, path: String, handler: PyObject, stream: bool) {
        self.routes.lock().unwrap().push(RouteDefinition {
            method: HttpMethod::Put,
            path,
            handler,
            is_stream: stream,
        });
    }

    #[pyo3(signature = (path, handler, *, stream = false))]
    fn delete(&self, path: String, handler: PyObject, stream: bool) {
        self.routes.lock().unwrap().push(RouteDefinition {
            method: HttpMethod::Delete,
            path,
            handler,
            is_stream: stream,
        });
    }

    #[pyo3(signature = (path, handler, *, stream = false))]
    fn patch(&self, path: String, handler: PyObject, stream: bool) {
        self.routes.lock().unwrap().push(RouteDefinition {
            method: HttpMethod::Patch,
            path,
            handler,
            is_stream: stream,
        });
    }

    fn __repr__(&self) -> String {
        let count = self.routes.lock().unwrap().len();
        format!("Router(plugin={:?}, routes={})", self.plugin_name, count)
    }
}

// ---------------------------------------------------------------------------
// PyRequest — immutable request object passed to Python handlers
// ---------------------------------------------------------------------------

/// HTTP request data forwarded to Python route handlers.
///
/// ```python
/// async def handle(self, request):
///     print(request.method, request.path)
///     body = json.loads(request.body) if request.body else {}
///     return json.dumps({"ok": True})
/// ```
#[pyclass(frozen, name = "Request", module = "appkit")]
#[derive(Clone)]
pub struct PyRequest {
    #[pyo3(get)]
    pub method: String,
    #[pyo3(get)]
    pub path: String,
    #[pyo3(get)]
    pub headers: HashMap<String, String>,
    #[pyo3(get)]
    pub query: String,
    #[pyo3(get)]
    pub body: String,
}

#[pymethods]
impl PyRequest {
    /// Parse the request body as JSON and return Python-native data
    /// (dict, list, str, int, float, bool, or None).
    ///
    /// Raises `ValueError` if the body is not valid JSON.
    fn json(&self, py: Python<'_>) -> PyResult<PyObject> {
        let json_mod = py.import("json")?;
        match json_mod.call_method1("loads", (self.body.as_str(),)) {
            Ok(result) => Ok(result.unbind()),
            Err(e) => {
                let msg = e.to_string();
                Err(pyo3::exceptions::PyValueError::new_err(msg))
            }
        }
    }

    fn __repr__(&self) -> String {
        format!("Request({} {})", self.method, self.path)
    }
}

// ---------------------------------------------------------------------------
// PyServerConfig
// ---------------------------------------------------------------------------

/// Server configuration.
///
/// ```python
/// config = ServerConfig(host="0.0.0.0", port=8000, static_path="dist")
/// ```
#[pyclass(frozen, name = "ServerConfig", module = "appkit")]
#[derive(Clone)]
pub struct PyServerConfig {
    #[pyo3(get)]
    pub host: String,
    #[pyo3(get)]
    pub port: u16,
    #[pyo3(get)]
    pub auto_start: bool,
    #[pyo3(get)]
    pub static_path: Option<String>,
}

#[pymethods]
impl PyServerConfig {
    #[new]
    #[pyo3(signature = (*, host = "0.0.0.0".to_string(), port = 8000, auto_start = true, static_path = None))]
    fn new(host: String, port: u16, auto_start: bool, static_path: Option<String>) -> Self {
        Self {
            host,
            port,
            auto_start,
            static_path,
        }
    }

    fn __repr__(&self) -> String {
        format!("ServerConfig(host={:?}, port={})", self.host, self.port)
    }

    fn __eq__(&self, other: &Self) -> bool {
        self.host == other.host
            && self.port == other.port
            && self.auto_start == other.auto_start
            && self.static_path == other.static_path
    }

    fn __hash__(&self) -> u64 {
        use std::hash::{Hash, Hasher};
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        self.host.hash(&mut hasher);
        self.port.hash(&mut hasher);
        self.auto_start.hash(&mut hasher);
        hasher.finish()
    }
}

// ---------------------------------------------------------------------------
// Endpoint info (returned by /api/__config)
// ---------------------------------------------------------------------------

#[derive(Clone, serde::Serialize)]
struct EndpointInfo {
    method: String,
    path: String,
    plugin: String,
}

// ---------------------------------------------------------------------------
// Python handler invocation helpers
// ---------------------------------------------------------------------------

/// Call a Python async handler with a `PyRequest`, returning the JSON string.
///
/// `task_locals` carries the Python asyncio event loop reference so that
/// `into_future` can bridge the coroutine even though we're on a bare
/// tokio task (no running Python event loop).
async fn call_python_handler(
    handler: PyObject,
    request: PyRequest,
    task_locals: &TaskLocals,
) -> Result<String, (StatusCode, String)> {
    let future = Python::with_gil(|py| {
        let req_obj = Py::new(py, request)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

        let coroutine = handler
            .call1(py, (req_obj,))
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

        pyo3_async_runtimes::into_future_with_locals(
            &task_locals.clone_ref(py),
            coroutine.into_bound(py),
        )
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))
    })?;

    let result = future
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Python::with_gil(|py| {
        result.extract::<String>(py).map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("Handler must return a JSON string: {e}"),
            )
        })
    })
}

/// Spawn a task that drives a Python async generator, forwarding items to `tx`.
fn spawn_python_generator(py_gen: PyObject, tx: mpsc::Sender<(Option<String>, String)>) {
    tokio::spawn(async move {
        loop {
            // Step 1: acquire GIL, call __anext__, get a future, release GIL.
            let future_result: Result<Option<_>, String> = Python::with_gil(|py| {
                match py_gen.call_method0(py, "__anext__") {
                    Ok(coroutine) => pyo3_async_runtimes::tokio::into_future(
                        coroutine.into_bound(py),
                    )
                    .map(Some)
                    .map_err(|e| e.to_string()),
                    Err(e) => {
                        if e.is_instance_of::<pyo3::exceptions::PyStopAsyncIteration>(py) {
                            Ok(None)
                        } else {
                            Err(e.to_string())
                        }
                    }
                }
            });

            match future_result {
                Ok(None) => break, // Generator exhausted.
                Err(e) => {
                    let _ = tx.send((Some("error".to_string()), e)).await;
                    break;
                }
                Ok(Some(future)) => {
                    match future.await {
                        Ok(value) => {
                            let data = Python::with_gil(|py| {
                                value
                                    .extract::<String>(py)
                                    .unwrap_or_else(|_| "null".to_string())
                            });
                            if tx.send((None, data)).await.is_err() {
                                break; // Receiver dropped.
                            }
                        }
                        Err(e) => {
                            let is_stop = Python::with_gil(|py| {
                                e.is_instance_of::<pyo3::exceptions::PyStopAsyncIteration>(py)
                            });
                            if is_stop {
                                break;
                            }
                            let _ = tx.send((Some("error".to_string()), e.to_string())).await;
                            break;
                        }
                    }
                }
            }
        }
    });
}

// ---------------------------------------------------------------------------
// Request data extraction
// ---------------------------------------------------------------------------

fn extract_request_data(method: &Method, uri: &Uri, headers: &HeaderMap, body: &[u8]) -> PyRequest {
    let header_map: HashMap<String, String> = headers
        .iter()
        .filter_map(|(k, v)| v.to_str().ok().map(|val| (k.as_str().to_string(), val.to_string())))
        .collect();

    PyRequest {
        method: method.to_string(),
        path: uri.path().to_string(),
        headers: header_map,
        query: uri.query().unwrap_or("").to_string(),
        body: String::from_utf8_lossy(body).to_string(),
    }
}

/// Parse a query string into key-value pairs.
fn parse_query(query: &str) -> HashMap<String, String> {
    query
        .split('&')
        .filter(|s| !s.is_empty())
        .filter_map(|pair| {
            let mut parts = pair.splitn(2, '=');
            let key = parts.next()?;
            let value = parts.next().unwrap_or("");
            Some((key.to_string(), value.to_string()))
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Router construction
// ---------------------------------------------------------------------------

/// Build the full axum `Router` from plugin routes, health check, client config,
/// and optional static file serving.
pub fn build_router(
    plugin_routes: Vec<(String, Vec<RouteDefinition>)>,
    plugin_configs: HashMap<String, JsonValue>,
    stream_manager: Arc<StreamManager>,
    static_path: Option<PathBuf>,
    task_locals: TaskLocals,
) -> Router {
    let task_locals = Arc::new(task_locals);
    let mut app = Router::new();

    // GET /health
    app = app.route(
        "/health",
        get(|| async { Json(serde_json::json!({"status": "ok"})) }),
    );

    // GET /api/__config — aggregated endpoint map + plugin client configs.
    let endpoint_info = collect_endpoint_info(&plugin_routes);
    let config_payload = Arc::new(serde_json::json!({
        "plugins": plugin_configs,
        "endpoints": endpoint_info,
    }));
    let config_payload_clone = config_payload.clone();
    app = app.route(
        "/api/__config",
        get(move || {
            let payload = config_payload_clone.clone();
            async move { Json((*payload).clone()) }
        }),
    );

    // Plugin routes — each mounted under /api/{plugin_name}.
    for (plugin_name, routes) in plugin_routes {
        let mut plugin_router = Router::new();

        for route in routes {
            if route.is_stream {
                plugin_router =
                    mount_stream_route(plugin_router, route, stream_manager.clone(), task_locals.clone());
            } else {
                plugin_router = mount_handler_route(plugin_router, route, task_locals.clone());
            }
        }

        app = app.nest(&format!("/api/{plugin_name}"), plugin_router);
    }

    // Static file serving (fallback).
    if let Some(ref static_dir) = static_path {
        let serve = tower_http::services::ServeDir::new(static_dir)
            .append_index_html_on_directories(true);
        app = app.fallback_service(serve);
    }

    // CORS — permissive dev-friendly configuration.
    app.layer(CorsLayer::permissive())
}

/// Pick a response Content-Type by peeking at the handler's output.
///
/// Handlers return strings. JSON is the default — but handlers that render
/// HTML (e.g. server-rendered pages) would otherwise be served as
/// `application/json` and not render in browsers. A leading `<` after
/// optional whitespace unambiguously signals markup because valid JSON
/// cannot start with `<`.
fn detect_content_type(body: &str) -> &'static str {
    match body.trim_start().as_bytes().first() {
        Some(b'<') => "text/html; charset=utf-8",
        _ => "application/json",
    }
}

fn mount_handler_route(router: Router, route: RouteDefinition, task_locals: Arc<TaskLocals>) -> Router {
    let py_handler = GilPyObject::new(route.handler);

    let handler_fn = move |method: Method, uri: Uri, headers: HeaderMap, body: Bytes| {
        let py_handler = py_handler.clone().into_inner();
        let locals = Python::with_gil(|py| (*task_locals).clone_ref(py));
        async move {
            let request = extract_request_data(&method, &uri, &headers, &body);
            match call_python_handler(py_handler, request, &locals).await {
                Ok(body_str) => Response::builder()
                    .status(StatusCode::OK)
                    .header(header::CONTENT_TYPE, detect_content_type(&body_str))
                    .body(axum::body::Body::from(body_str))
                    .unwrap_or_else(|_| {
                        StatusCode::INTERNAL_SERVER_ERROR.into_response().into_response()
                    }),
                Err((status, msg)) => {
                    let err = serde_json::json!({"error": msg}).to_string();
                    Response::builder()
                        .status(status)
                        .header(header::CONTENT_TYPE, "application/json")
                        .body(axum::body::Body::from(err))
                        .unwrap_or_else(|_| {
                            StatusCode::INTERNAL_SERVER_ERROR.into_response().into_response()
                        })
                }
            }
        }
    };

    match route.method {
        HttpMethod::Get => router.route(&route.path, get(handler_fn)),
        HttpMethod::Post => router.route(&route.path, post(handler_fn)),
        HttpMethod::Put => router.route(&route.path, put(handler_fn)),
        HttpMethod::Delete => router.route(&route.path, delete(handler_fn)),
        HttpMethod::Patch => router.route(&route.path, patch(handler_fn)),
    }
}

fn mount_stream_route(
    router: Router,
    route: RouteDefinition,
    stream_manager: Arc<StreamManager>,
    _task_locals: Arc<TaskLocals>,
) -> Router {
    let py_handler = GilPyObject::new(route.handler);
    let sm = stream_manager;

    let handler_fn = move |method: Method, uri: Uri, headers: HeaderMap, body: Bytes| {
        let py_handler = py_handler.clone().into_inner();
        let sm = sm.clone();
        async move {
            let request = extract_request_data(&method, &uri, &headers, &body);

            // Stream ID from query param or generate.
            let query_params = parse_query(&request.query);
            let stream_id = query_params
                .get("stream_id")
                .cloned()
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

            // Reconnection: Last-Event-ID header.
            let last_event_id = headers
                .get("last-event-id")
                .and_then(|v| v.to_str().ok())
                .map(String::from);

            // Try to reconnect to an existing stream.
            if let Some(ref last_id) = last_event_id {
                if let Ok(rx) = sm.subscribe(&stream_id, Some(last_id)).await {
                    return sse_response(rx, &sm.config);
                }
            }

            // Create new stream: call Python handler to get async generator.
            let py_gen = match Python::with_gil(|py| -> Result<PyObject, String> {
                let req_obj =
                    Py::new(py, request).map_err(|e: PyErr| e.to_string())?;
                py_handler
                    .call1(py, (req_obj,))
                    .map_err(|e: PyErr| e.to_string())
            }) {
                Ok(gen) => gen,
                Err(msg) => return error_response(StatusCode::INTERNAL_SERVER_ERROR, &msg),
            };

            let (item_tx, item_rx) = mpsc::channel(32);
            spawn_python_generator(py_gen, item_tx);

            if let Err(e) = sm.create_stream(stream_id.clone(), item_rx).await {
                return error_response(StatusCode::INTERNAL_SERVER_ERROR, &e);
            }

            match sm.subscribe(&stream_id, None).await {
                Ok(rx) => sse_response(rx, &sm.config),
                Err(e) => error_response(StatusCode::INTERNAL_SERVER_ERROR, &e),
            }
        }
    };

    match route.method {
        HttpMethod::Get => router.route(&route.path, get(handler_fn)),
        HttpMethod::Post => router.route(&route.path, post(handler_fn)),
        HttpMethod::Put => router.route(&route.path, put(handler_fn)),
        HttpMethod::Delete => router.route(&route.path, delete(handler_fn)),
        HttpMethod::Patch => router.route(&route.path, patch(handler_fn)),
    }
}

/// Convert an SSE event receiver to an axum `Sse` response with keep-alive.
fn sse_response(rx: mpsc::Receiver<SseEvent>, config: &StreamConfig) -> Response {
    let stream = ReceiverStream::new(rx).map(|event| {
        let mut e = AxumSseEvent::default().id(event.id).data(event.data);
        if let Some(t) = event.event_type {
            e = e.event(t);
        }
        Ok::<_, Infallible>(e)
    });

    Sse::new(stream)
        .keep_alive(
            KeepAlive::new()
                .interval(config.heartbeat_interval)
                .text("heartbeat"),
        )
        .into_response()
}

fn error_response(status: StatusCode, msg: &str) -> Response {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json")
        .body(axum::body::Body::from(
            serde_json::json!({"error": msg}).to_string(),
        ))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

fn collect_endpoint_info(routes: &[(String, Vec<RouteDefinition>)]) -> Vec<EndpointInfo> {
    routes
        .iter()
        .flat_map(|(plugin_name, routes)| {
            routes.iter().map(move |route| EndpointInfo {
                plugin: plugin_name.clone(),
                method: route.method.as_str().to_string(),
                path: format!("/api/{}{}", plugin_name, route.path),
            })
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Static path detection
// ---------------------------------------------------------------------------

/// Detect the static file directory. If `explicit` is provided and exists, use
/// it. Otherwise search the standard paths (matches TS
/// `["dist", "client/dist", "build", "public", "out"]`).
pub fn detect_static_path(explicit: Option<&str>) -> Option<PathBuf> {
    if let Some(p) = explicit {
        let path = PathBuf::from(p);
        if path.exists() {
            return Some(path);
        }
        return None;
    }

    let candidates = ["dist", "client/dist", "build", "public", "out"];
    for dir in &candidates {
        let path = PathBuf::from(dir);
        if path.join("index.html").exists() {
            return Some(path);
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

/// Handle to a running server. Stores the shutdown sender so that
/// `PyAppKit.shutdown()` can trigger graceful shutdown.
pub struct ServerHandle {
    pub shutdown_tx: tokio::sync::watch::Sender<bool>,
    pub task: tokio::task::JoinHandle<()>,
}

/// Graceful shutdown timeout (matches TS `15000ms`).
const SHUTDOWN_TIMEOUT_SECS: u64 = 15;

/// Start the axum HTTP server. Returns a `ServerHandle` once the listener is
/// bound and the background server task is spawned.
pub async fn start_server(
    router: Router,
    host: &str,
    port: u16,
    stream_manager: Arc<StreamManager>,
) -> Result<ServerHandle, String> {
    let addr = format!("{host}:{port}");
    let listener = TcpListener::bind(&addr)
        .await
        .map_err(|e| format!("Failed to bind {addr}: {e}"))?;

    eprintln!("AppKit server listening on {addr}");

    let (shutdown_tx, mut shutdown_rx) = tokio::sync::watch::channel(false);
    let sm = stream_manager;

    let task = tokio::spawn(async move {
        let (shutdown_started_tx, shutdown_started_rx) =
            tokio::sync::oneshot::channel::<()>();

        let shutdown = async move {
            // Wait for SIGTERM, SIGINT, or manual shutdown.
            let ctrl_c = tokio::signal::ctrl_c();

            #[cfg(unix)]
            {
                let mut sigterm = tokio::signal::unix::signal(
                    tokio::signal::unix::SignalKind::terminate(),
                )
                .expect("Failed to install SIGTERM handler");

                tokio::select! {
                    _ = ctrl_c => {},
                    _ = sigterm.recv() => {},
                    _ = async {
                        loop {
                            if shutdown_rx.changed().await.is_err() { break; }
                            if *shutdown_rx.borrow() { break; }
                        }
                    } => {},
                }
            }

            #[cfg(not(unix))]
            {
                tokio::select! {
                    _ = ctrl_c => {},
                    _ = async {
                        loop {
                            if shutdown_rx.changed().await.is_err() { break; }
                            if *shutdown_rx.borrow() { break; }
                        }
                    } => {},
                }
            }

            eprintln!("Shutdown signal received, shutting down gracefully...");

            // Abort all active streams.
            sm.abort_all().await;

            // Signal that shutdown has started so the timeout can begin.
            let _ = shutdown_started_tx.send(());
        };

        let server = axum::serve(listener, router).with_graceful_shutdown(shutdown);

        // Race: graceful server drain vs. forced shutdown timeout.
        // When the timeout fires, dropping the server future aborts in-flight
        // connections — no std::process::exit needed, preserving normal
        // Rust cleanup/destructor semantics.
        tokio::select! {
            result = server => { result.ok(); },
            _ = async {
                let _ = shutdown_started_rx.await;
                tokio::time::sleep(Duration::from_secs(SHUTDOWN_TIMEOUT_SECS)).await;
                eprintln!("Force shutdown after {SHUTDOWN_TIMEOUT_SECS}s timeout");
            } => {}
        }
    });

    Ok(ServerHandle {
        shutdown_tx,
        task,
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_detect_static_path_explicit_missing() {
        assert!(detect_static_path(Some("/nonexistent/path")).is_none());
    }

    #[test]
    fn test_detect_static_path_none() {
        // In the test environment there's unlikely to be a dist/ with index.html.
        // Just verify it doesn't panic.
        let _ = detect_static_path(None);
    }

    #[test]
    fn test_detect_content_type() {
        assert_eq!(detect_content_type("{\"ok\":true}"), "application/json");
        assert_eq!(detect_content_type("[]"), "application/json");
        assert_eq!(detect_content_type(""), "application/json");
        assert_eq!(detect_content_type("plain text"), "application/json");
        assert_eq!(
            detect_content_type("<!DOCTYPE html><html></html>"),
            "text/html; charset=utf-8"
        );
        assert_eq!(
            detect_content_type("  \n<html>hi</html>"),
            "text/html; charset=utf-8"
        );
    }

    #[test]
    fn test_parse_query() {
        let q = parse_query("stream_id=abc&foo=bar");
        assert_eq!(q.get("stream_id").unwrap(), "abc");
        assert_eq!(q.get("foo").unwrap(), "bar");
    }

    #[test]
    fn test_parse_query_empty() {
        let q = parse_query("");
        assert!(q.is_empty());
    }

    #[test]
    fn test_collect_endpoint_info() {
        pyo3::prepare_freethreaded_python();
        let routes = vec![(
            "my-plugin".to_string(),
            vec![
                RouteDefinition {
                    method: HttpMethod::Get,
                    path: "/items".into(),
                    handler: Python::with_gil(|py| py.None().into()),
                    is_stream: false,
                },
                RouteDefinition {
                    method: HttpMethod::Post,
                    path: "/items".into(),
                    handler: Python::with_gil(|py| py.None().into()),
                    is_stream: false,
                },
            ],
        )];
        let info = collect_endpoint_info(&routes);
        assert_eq!(info.len(), 2);
        assert_eq!(info[0].method, "GET");
        assert_eq!(info[0].path, "/api/my-plugin/items");
        assert_eq!(info[1].method, "POST");
    }

    #[test]
    fn test_py_server_config_defaults() {
        let cfg = PyServerConfig::new("0.0.0.0".into(), 8000, true, None);
        assert_eq!(cfg.host, "0.0.0.0");
        assert_eq!(cfg.port, 8000);
        assert!(cfg.auto_start);
        assert!(cfg.static_path.is_none());
    }

    #[test]
    fn test_extract_request_data() {
        let method = Method::POST;
        let uri: Uri = "/api/test?foo=bar".parse().unwrap();
        let mut headers = HeaderMap::new();
        headers.insert("content-type", "application/json".parse().unwrap());
        let body = b"{\"key\":\"val\"}";

        let req = extract_request_data(&method, &uri, &headers, body);
        assert_eq!(req.method, "POST");
        assert_eq!(req.path, "/api/test");
        assert_eq!(req.query, "foo=bar");
        assert_eq!(req.body, "{\"key\":\"val\"}");
        assert_eq!(req.headers.get("content-type").unwrap(), "application/json");
    }
}
