//! Plugin system — trait, manifest, phase ordering, execution runtime, and
//! Python base class.
//!
//! Mirrors the TypeScript plugin architecture:
//! - Three-phase init: Core → Normal → Deferred
//! - Plugin trait with `setup()`, `exports()`, `client_config()`
//! - `PluginRuntime` providing `execute()` / `execute_stream()` through the
//!   interceptor chain
//! - `PyPlugin` subclassable Python base class
//! - `PyAppKit` orchestrator for plugin registration and initialization

use pyo3::prelude::*;
use serde_json::Value as JsonValue;
use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use crate::cache::{CacheConfig, CacheManager};
use crate::errors::classify_pyerr;
use crate::interceptor::{
    build_interceptor_chain, build_stream_interceptor_chain, ExecuteFn, ExecutionError,
    InterceptorContext, PluginExecuteConfig, StreamItem,
};
use tokio::sync::mpsc;
use crate::telemetry::{TelemetryManager, TelemetryOptions, TelemetryProvider};

// ---------------------------------------------------------------------------
// Plugin types
// ---------------------------------------------------------------------------

/// Plugin initialization phase ordering.
/// Core plugins initialize first, then Normal, then Deferred.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum PluginPhase {
    Core,
    #[default]
    Normal,
    Deferred,
}

impl std::str::FromStr for PluginPhase {
    type Err = ();

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "core" => Ok(Self::Core),
            "normal" => Ok(Self::Normal),
            "deferred" => Ok(Self::Deferred),
            _ => Err(()),
        }
    }
}

impl PluginPhase {

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Core => "core",
            Self::Normal => "normal",
            Self::Deferred => "deferred",
        }
    }

    fn order(&self) -> u8 {
        match self {
            Self::Core => 0,
            Self::Normal => 1,
            Self::Deferred => 2,
        }
    }
}

/// Resource requirement declared in a plugin manifest.
#[derive(Clone, Debug)]
pub struct ResourceRequirement {
    pub resource_type: String,
    pub required: bool,
}

/// Plugin manifest — metadata and resource declarations.
#[derive(Clone, Debug)]
pub struct PluginManifest {
    pub name: String,
    pub display_name: Option<String>,
    pub description: Option<String>,
    pub required_resources: Vec<ResourceRequirement>,
    pub optional_resources: Vec<ResourceRequirement>,
}

// ---------------------------------------------------------------------------
// ExecutionResult
// ---------------------------------------------------------------------------

/// Discriminated result type matching TypeScript's `ExecutionResult<T>`.
/// Plugin execute() never throws; it returns `Ok` or `Err` variant.
#[derive(Clone, Debug)]
pub enum ExecutionResult {
    Ok { data: JsonValue },
    Err { status: u16, message: String },
}

impl ExecutionResult {
    pub fn is_ok(&self) -> bool {
        matches!(self, Self::Ok { .. })
    }

    pub fn data(&self) -> Option<&JsonValue> {
        match self {
            Self::Ok { data } => Some(data),
            _ => None,
        }
    }
}

// ---------------------------------------------------------------------------
// Plugin trait (Rust-internal)
// ---------------------------------------------------------------------------

/// Trait for Rust-implemented plugins.
pub trait Plugin: Send + Sync {
    fn name(&self) -> &str;

    fn phase(&self) -> PluginPhase {
        PluginPhase::Normal
    }

    fn manifest(&self) -> &PluginManifest;

    /// Called during AppKit initialization after plugin construction.
    fn setup(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + '_>> {
        Box::pin(async { Ok(()) })
    }

    /// Return the public API surface of this plugin.
    fn exports(&self) -> HashMap<String, JsonValue> {
        HashMap::new()
    }

    /// Return startup config that is sent to the client.
    fn client_config(&self) -> HashMap<String, JsonValue> {
        HashMap::new()
    }
}

// ---------------------------------------------------------------------------
// PluginRuntime — shared execution infrastructure
// ---------------------------------------------------------------------------

/// Shared execution infrastructure available to every plugin.
/// Provides `execute()` that runs user functions through the interceptor chain.
pub struct PluginRuntime {
    pub name: String,
    pub cache: Arc<CacheManager>,
    pub telemetry: Arc<TelemetryProvider>,
}

impl PluginRuntime {
    pub fn new(
        name: &str,
        cache: Arc<CacheManager>,
        telemetry_options: Option<TelemetryOptions>,
    ) -> Self {
        Self {
            name: name.to_string(),
            cache,
            telemetry: Arc::new(TelemetryManager::get_provider(name, telemetry_options)),
        }
    }

    /// Execute a function through the full interceptor chain.
    ///
    /// Never panics — all errors are captured into `ExecutionResult::Err`.
    pub async fn execute<F, Fut>(
        &self,
        f: F,
        config: PluginExecuteConfig,
        user_key: &str,
    ) -> ExecutionResult
    where
        F: Fn() -> Fut + Send + Sync + 'static,
        Fut: std::future::Future<Output = Result<JsonValue, ExecutionError>> + Send + 'static,
    {
        let context = InterceptorContext {
            user_key: user_key.to_string(),
            cancelled: Arc::new(AtomicBool::new(false)),
            metadata: HashMap::new(),
        };

        let base_fn: ExecuteFn = Arc::new(move || Box::pin(f()));

        let chain = build_interceptor_chain(
            base_fn,
            &config,
            &context,
            Some(self.cache.clone()),
            Some(self.telemetry.clone()),
        );

        match chain().await {
            Ok(data) => ExecutionResult::Ok { data },
            Err(e) => ExecutionResult::Err {
                status: e.status,
                message: e.message,
            },
        }
    }

    /// Apply stream interceptors to an item receiver.
    ///
    /// For streams, only telemetry and timeout are applied:
    /// - Telemetry spans the full stream lifetime
    /// - Timeout applies to the total stream duration
    /// - Retry and cache are intentionally skipped (streams are non-repeatable)
    pub fn wrap_stream(
        &self,
        input: mpsc::Receiver<StreamItem>,
        config: &PluginExecuteConfig,
    ) -> mpsc::Receiver<StreamItem> {
        build_stream_interceptor_chain(input, config, Some(self.telemetry.clone()))
    }
}

// ===========================================================================
// Python bindings
// ===========================================================================

// ---------------------------------------------------------------------------
// PyPluginPhase — class attributes for phase constants
// ---------------------------------------------------------------------------

/// Phase ordering constants for Python plugins.
#[pyclass(frozen, name = "PluginPhase", module = "appkit")]
pub struct PyPluginPhase;

#[pymethods]
impl PyPluginPhase {
    #[classattr]
    const CORE: &'static str = "core";
    #[classattr]
    const NORMAL: &'static str = "normal";
    #[classattr]
    const DEFERRED: &'static str = "deferred";
}

// ---------------------------------------------------------------------------
// PyExecutionResult
// ---------------------------------------------------------------------------

/// Python-facing execution result (frozen, immutable).
#[pyclass(frozen, name = "ExecutionResult", module = "appkit")]
#[derive(Clone)]
pub struct PyExecutionResult {
    #[pyo3(get)]
    pub ok: bool,
    /// JSON string of the result data (only set when ok=True).
    #[pyo3(get)]
    pub data: Option<String>,
    /// HTTP status code (only set when ok=False).
    #[pyo3(get)]
    pub status: Option<u16>,
    /// Error message (only set when ok=False).
    #[pyo3(get)]
    pub message: Option<String>,
}

#[pymethods]
impl PyExecutionResult {
    fn __repr__(&self) -> String {
        if self.ok {
            format!("ExecutionResult(ok=True, data={:?})", self.data)
        } else {
            format!(
                "ExecutionResult(ok=False, status={:?}, message={:?})",
                self.status, self.message
            )
        }
    }

    fn __bool__(&self) -> bool {
        self.ok
    }

    fn __eq__(&self, other: &Self) -> bool {
        self.ok == other.ok
            && self.data == other.data
            && self.status == other.status
            && self.message == other.message
    }

    fn __hash__(&self) -> u64 {
        use std::hash::{Hash, Hasher};
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        self.ok.hash(&mut hasher);
        self.data.hash(&mut hasher);
        self.status.hash(&mut hasher);
        hasher.finish()
    }
}

impl From<ExecutionResult> for PyExecutionResult {
    fn from(result: ExecutionResult) -> Self {
        match result {
            ExecutionResult::Ok { data } => PyExecutionResult {
                ok: true,
                data: Some(data.to_string()),
                status: None,
                message: None,
            },
            ExecutionResult::Err { status, message } => PyExecutionResult {
                ok: false,
                data: None,
                status: Some(status),
                message: Some(message),
            },
        }
    }
}

// ---------------------------------------------------------------------------
// PyPluginManifest
// ---------------------------------------------------------------------------

/// Plugin manifest exposed to Python.
#[pyclass(frozen, name = "PluginManifest", module = "appkit")]
#[derive(Clone)]
pub struct PyPluginManifest {
    #[pyo3(get)]
    pub name: String,
    #[pyo3(get)]
    pub display_name: Option<String>,
    #[pyo3(get)]
    pub description: Option<String>,
}

#[pymethods]
impl PyPluginManifest {
    #[new]
    #[pyo3(signature = (name, *, display_name = None, description = None))]
    fn new(name: String, display_name: Option<String>, description: Option<String>) -> Self {
        Self {
            name,
            display_name,
            description,
        }
    }

    fn __repr__(&self) -> String {
        format!("PluginManifest(name={:?})", self.name)
    }

    fn __eq__(&self, other: &Self) -> bool {
        self.name == other.name
            && self.display_name == other.display_name
            && self.description == other.description
    }

    fn __hash__(&self) -> u64 {
        use std::hash::{Hash, Hasher};
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        self.name.hash(&mut hasher);
        hasher.finish()
    }
}

// ---------------------------------------------------------------------------
// PyPlugin — subclassable base class
// ---------------------------------------------------------------------------

/// Base class for Python plugins. Subclass this to create custom plugins.
///
/// ```python
/// from appkit import Plugin, PluginManifest
///
/// class MyPlugin(Plugin):
///     def __init__(self):
///         super().__init__("my-plugin", manifest=PluginManifest("my-plugin"))
///
///     async def setup(self):
///         pass  # initialization logic
/// ```
#[pyclass(subclass, name = "Plugin", module = "appkit")]
pub struct PyPlugin {
    #[pyo3(get)]
    name: String,
    #[pyo3(get)]
    phase: String,
    #[pyo3(get)]
    manifest: PyPluginManifest,
    #[pyo3(get)]
    is_ready: bool,
    /// Rust-internal runtime — set by AppKit during initialization.
    runtime: Option<PluginRuntime>,
}

#[pymethods]
impl PyPlugin {
    /// Construct a `PyPlugin`. Accepts any `*args`/`**kwargs` so that
    /// Python subclasses with arbitrary constructor signatures
    /// (e.g. `AnalyticsPlugin(config)`) can inherit `__new__` without
    /// type errors. Best-effort extracts `name`/`phase` from positional
    /// args and `manifest` from kwargs so direct construction
    /// (`appkit.Plugin("name", manifest=m)`) still fully initializes
    /// fields without requiring a separate `__init__` call.
    #[new]
    #[pyo3(signature = (*args, **kwargs))]
    fn new(
        args: &Bound<'_, pyo3::types::PyTuple>,
        kwargs: Option<&Bound<'_, pyo3::types::PyDict>>,
    ) -> PyResult<Self> {
        let name = args
            .get_item(0)
            .ok()
            .and_then(|a| a.extract::<String>().ok())
            .unwrap_or_default();
        let phase = kwargs
            .and_then(|k| k.get_item("phase").ok().flatten())
            .and_then(|v| v.extract::<String>().ok())
            .or_else(|| {
                args.get_item(1)
                    .ok()
                    .and_then(|a| a.extract::<String>().ok())
            })
            .unwrap_or_else(|| "normal".to_string());
        let manifest = kwargs
            .and_then(|k| k.get_item("manifest").ok().flatten())
            .and_then(|m| m.extract::<PyPluginManifest>().ok())
            .unwrap_or_else(|| PyPluginManifest {
                name: name.clone(),
                display_name: None,
                description: None,
            });
        if !name.is_empty() && phase.parse::<PluginPhase>().is_err() {
            return Err(pyo3::exceptions::PyValueError::new_err(format!(
                "Invalid phase: {phase}. Must be 'core', 'normal', or 'deferred'"
            )));
        }
        Ok(Self {
            name,
            phase,
            manifest,
            is_ready: false,
            runtime: None,
        })
    }

    /// Re-initialize fields from Python `super().__init__(...)`.
    /// This enables the standard Python subclassing pattern:
    /// ```python
    /// class MyPlugin(Plugin):
    ///     def __init__(self):
    ///         super().__init__("my-plugin", manifest=PluginManifest("my-plugin"))
    /// ```
    #[pyo3(signature = (name, *, phase = "normal".to_string(), manifest))]
    fn __init__(&mut self, name: String, phase: String, manifest: PyPluginManifest) -> PyResult<()> {
        if phase.parse::<PluginPhase>().is_err() {
            return Err(pyo3::exceptions::PyValueError::new_err(format!(
                "Invalid phase: {phase}. Must be 'core', 'normal', or 'deferred'"
            )));
        }
        self.name = name;
        self.phase = phase;
        self.manifest = manifest;
        Ok(())
    }

    /// Called by AppKit during initialization. Override in subclass.
    fn setup<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyAny>> {
        // Default: return a coroutine that resolves immediately.
        pyo3_async_runtimes::tokio::future_into_py(py, async { Ok(()) })
    }

    /// Return export dict for this plugin. Override in subclass.
    fn exports(&self) -> HashMap<String, String> {
        HashMap::new()
    }

    /// Return client config dict. Override in subclass.
    fn client_config(&self) -> HashMap<String, String> {
        HashMap::new()
    }

    /// Override in subclass to register HTTP routes with the server.
    ///
    /// ```python
    /// def inject_routes(self, router):
    ///     router.get("/items", self.get_items)
    ///     router.post("/items", self.create_item)
    /// ```
    fn inject_routes(&self, _router: PyObject) -> PyResult<()> {
        Ok(())
    }

    /// Execute an async Python callable through the interceptor chain.
    ///
    /// ```python
    /// result = await plugin.execute(my_async_fn, user_key="user-1")
    /// ```
    #[allow(clippy::too_many_arguments)]
    #[pyo3(signature = (func, *, user_key = "".to_string(), timeout_ms = None, retry_attempts = None, cache_key = None, cache_ttl = None))]
    fn execute<'py>(
        &self,
        py: Python<'py>,
        func: PyObject,
        user_key: String,
        timeout_ms: Option<u64>,
        retry_attempts: Option<u32>,
        cache_key: Option<Vec<String>>,
        cache_ttl: Option<u64>,
    ) -> PyResult<Bound<'py, PyAny>> {
        let runtime = self.runtime.as_ref().ok_or_else(|| {
            pyo3::exceptions::PyRuntimeError::new_err(
                "Plugin not initialized — register with AppKit first",
            )
        })?;

        let cache = runtime.cache.clone();
        let telemetry = runtime.telemetry.clone();
        let name = runtime.name.clone();

        // Build execution config from keyword arguments.
        let config = PluginExecuteConfig {
            timeout_ms,
            retry: retry_attempts.map(|attempts| crate::interceptor::RetryConfig {
                enabled: true,
                attempts,
                ..Default::default()
            }),
            cache: cache_key.map(|keys| crate::interceptor::CacheInterceptorConfig {
                enabled: true,
                cache_key: keys,
                ttl: cache_ttl,
            }),
            telemetry: Some(crate::interceptor::TelemetryInterceptorConfig {
                enabled: true,
                span_name: Some(format!("{name}.execute")),
                attributes: vec![],
            }),
        };

        let context = InterceptorContext {
            user_key: user_key.clone(),
            cancelled: Arc::new(AtomicBool::new(false)),
            metadata: HashMap::new(),
        };

        // Wrap the Python callable as an ExecuteFn. Any Python exception is
        // classified through the AppKit error hierarchy so `ExecutionResult`
        // carries a meaningful HTTP status instead of always 500.
        let py_fn = Arc::new(func);
        let base_fn: ExecuteFn = Arc::new(move || {
            let py_fn = py_fn.clone();
            Box::pin(async move {
                let future = Python::with_gil(|py| {
                    let coroutine = py_fn.call0(py).map_err(|e| {
                        let (status, _code, msg) = classify_pyerr(py, &e);
                        ExecutionError { status, message: msg }
                    })?;
                    pyo3_async_runtimes::tokio::into_future(coroutine.into_bound(py))
                        .map_err(|e| {
                            let (status, _code, msg) = classify_pyerr(py, &e);
                            ExecutionError { status, message: msg }
                        })
                })?;

                let result = future.await.map_err(|e| {
                    Python::with_gil(|py| {
                        let (status, _code, msg) = classify_pyerr(py, &e);
                        ExecutionError { status, message: msg }
                    })
                })?;

                let json_str: String = Python::with_gil(|py| {
                    result.extract::<String>(py).map_err(|e| ExecutionError {
                        status: 500,
                        message: format!("Execute callable must return a JSON string: {e}"),
                    })
                })?;

                serde_json::from_str(&json_str).map_err(|e| ExecutionError {
                    status: 500,
                    message: format!("Invalid JSON from execute callable: {e}"),
                })
            })
        });

        let chain = build_interceptor_chain(
            base_fn,
            &config,
            &context,
            Some(cache),
            Some(telemetry),
        );

        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let result = match chain().await {
                Ok(data) => ExecutionResult::Ok { data },
                Err(e) => ExecutionResult::Err {
                    status: e.status,
                    message: e.message,
                },
            };
            Ok(PyExecutionResult::from(result))
        })
    }

    /// Execute a streaming function through the interceptor chain.
    ///
    /// The callable should return a Python async generator that yields
    /// JSON strings. Returns a `StreamIterator` for async iteration.
    ///
    /// Retry and cache are not supported for streams.
    ///
    /// ```python
    /// stream = await plugin.execute_stream(my_async_gen_fn)
    /// async for item in stream:
    ///     data = json.loads(item)
    /// ```
    #[pyo3(signature = (func, *, user_key = "".to_string(), timeout_ms = None))]
    fn execute_stream<'py>(
        &self,
        py: Python<'py>,
        func: PyObject,
        user_key: String,
        timeout_ms: Option<u64>,
    ) -> PyResult<Bound<'py, PyAny>> {
        let _ = user_key;
        let runtime = self.runtime.as_ref().ok_or_else(|| {
            pyo3::exceptions::PyRuntimeError::new_err(
                "Plugin not initialized — register with AppKit first",
            )
        })?;

        let telemetry = runtime.telemetry.clone();
        let name = runtime.name.clone();

        // Call the Python callable to get the async generator (requires GIL).
        let py_gen = func.call0(py).map_err(|e| {
            pyo3::exceptions::PyRuntimeError::new_err(format!(
                "Failed to call stream function: {e}"
            ))
        })?;
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let config = PluginExecuteConfig {
                timeout_ms,
                retry: None,
                cache: None,
                telemetry: Some(crate::interceptor::TelemetryInterceptorConfig {
                    enabled: true,
                    span_name: Some(format!("{name}.execute_stream")),
                    attributes: vec![],
                }),
            };

            let (tx, rx) = mpsc::channel::<StreamItem>(32);

            // Spawn task to drive the Python async generator.
            spawn_stream_generator(py_gen, tx);

            // Apply stream interceptors (telemetry + timeout).
            let output_rx = build_stream_interceptor_chain(rx, &config, Some(telemetry));

            Ok(PyStreamIterator::new(output_rx))
        })
    }

    fn __repr__(&self) -> String {
        format!(
            "Plugin(name={:?}, phase={:?}, ready={})",
            self.name, self.phase, self.is_ready
        )
    }
}

impl PyPlugin {
    /// Inject the shared runtime (called by PyAppKit during initialization).
    fn inject_runtime(&mut self, runtime: PluginRuntime) {
        self.runtime = Some(runtime);
        self.is_ready = true;
    }
}

// ---------------------------------------------------------------------------
// PyStreamIterator — async iterator for streaming execution results
// ---------------------------------------------------------------------------

/// Python async iterator backed by a tokio mpsc channel.
///
/// Yields JSON string items from a streaming execution. Used by
/// `Plugin.execute_stream()` and `ServingConnector.stream()`.
///
/// ```python
/// stream = await plugin.execute_stream(my_async_gen_fn)
/// async for item in stream:
///     data = json.loads(item)
/// ```
#[pyclass(name = "StreamIterator", module = "appkit")]
pub struct PyStreamIterator {
    rx: Arc<tokio::sync::Mutex<mpsc::Receiver<StreamItem>>>,
}

impl PyStreamIterator {
    pub fn new(rx: mpsc::Receiver<StreamItem>) -> Self {
        Self {
            rx: Arc::new(tokio::sync::Mutex::new(rx)),
        }
    }
}

#[pymethods]
impl PyStreamIterator {
    fn __aiter__(slf: PyRef<'_, Self>) -> PyRef<'_, Self> {
        slf
    }

    fn __anext__<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyAny>> {
        let rx = self.rx.clone();
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let mut guard = rx.lock().await;
            match guard.recv().await {
                Some(Ok(data)) => Ok(data),
                Some(Err(e)) => Err(pyo3::exceptions::PyRuntimeError::new_err(format!(
                    "[{}] {}",
                    e.status, e.message
                ))),
                None => Err(pyo3::exceptions::PyStopAsyncIteration::new_err(())),
            }
        })
    }

    fn __repr__(&self) -> String {
        "StreamIterator(...)".to_string()
    }
}

// ---------------------------------------------------------------------------
// Stream generator driver
// ---------------------------------------------------------------------------

/// Spawn a task that drives a Python async generator, forwarding items
/// as `StreamItem` values to the given sender.
fn spawn_stream_generator(py_gen: PyObject, tx: mpsc::Sender<StreamItem>) {
    tokio::spawn(async move {
        loop {
            // Step 1: acquire GIL, call __anext__, get a future, release GIL.
            let future_result: Result<Option<_>, ExecutionError> = Python::with_gil(|py| {
                match py_gen.call_method0(py, "__anext__") {
                    Ok(coroutine) => pyo3_async_runtimes::tokio::into_future(
                        coroutine.into_bound(py),
                    )
                    .map(Some)
                    .map_err(|e| ExecutionError {
                        status: 500,
                        message: e.to_string(),
                    }),
                    Err(e) => {
                        if e.is_instance_of::<pyo3::exceptions::PyStopAsyncIteration>(py) {
                            Ok(None)
                        } else {
                            Err(ExecutionError {
                                status: 500,
                                message: e.to_string(),
                            })
                        }
                    }
                }
            });

            match future_result {
                Ok(None) => break, // Generator exhausted.
                Err(e) => {
                    let _ = tx.send(Err(e)).await;
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
                            if tx.send(Ok(data)).await.is_err() {
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
                            let _ = tx
                                .send(Err(ExecutionError {
                                    status: 500,
                                    message: e.to_string(),
                                }))
                                .await;
                            break;
                        }
                    }
                }
            }
        }
    });
}

// ---------------------------------------------------------------------------
// PyAppKit — plugin orchestrator
// ---------------------------------------------------------------------------

/// AppKit orchestrator — registers plugins, manages phase-ordered
/// initialization, and provides access to registered plugins.
///
/// ```python
/// from appkit import AppKit, AppConfig
///
/// app = AppKit()
/// app.register(my_plugin)
/// await app.initialize(config)
/// ```
#[pyclass(name = "AppKit", module = "appkit")]
pub struct PyAppKit {
    plugins: Vec<PyObject>,
    initialized: bool,
    /// Shutdown sender for the running server (set by `start_server`).
    shutdown_tx: Arc<std::sync::Mutex<Option<tokio::sync::watch::Sender<bool>>>>,
}

impl Default for PyAppKit {
    fn default() -> Self {
        Self {
            plugins: Vec::new(),
            initialized: false,
            shutdown_tx: Arc::new(std::sync::Mutex::new(None)),
        }
    }
}

#[pymethods]
impl PyAppKit {
    #[new]
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a plugin instance. Must be called before `initialize()`.
    pub fn register(&mut self, plugin: PyObject) -> PyResult<()> {
        if self.initialized {
            return Err(pyo3::exceptions::PyRuntimeError::new_err(
                "Cannot register plugins after initialization",
            ));
        }
        self.plugins.push(plugin);
        Ok(())
    }

    /// Initialize all registered plugins in phase order (core → normal → deferred).
    ///
    /// This:
    /// 1. Initializes telemetry from the AppConfig
    /// 2. Creates the shared CacheManager
    /// 3. Injects PluginRuntime into each plugin
    /// 4. Calls `setup()` on each plugin in phase order
    #[pyo3(signature = (config, *, cache_config = None))]
    pub fn initialize<'py>(
        &mut self,
        py: Python<'py>,
        config: crate::config::AppConfig,
        cache_config: Option<CacheConfig>,
    ) -> PyResult<Bound<'py, PyAny>> {
        if self.initialized {
            return Err(pyo3::exceptions::PyRuntimeError::new_err(
                "AppKit already initialized",
            ));
        }

        // Initialize telemetry.
        let telem_config = crate::telemetry::TelemetryConfig::from_app_config(&config);
        TelemetryManager::initialize(&telem_config);

        // Create shared cache.
        let cache = Arc::new(CacheManager::new_internal(
            cache_config.unwrap_or_default(),
        ));

        // Sort plugins by phase and inject runtime.
        let mut indexed: Vec<(u8, usize)> = Vec::new();
        for (i, plugin_obj) in self.plugins.iter().enumerate() {
            let phase_str: String = plugin_obj
                .getattr(py, "phase")
                .and_then(|a| a.extract(py))
                .unwrap_or_else(|_| "normal".to_string());
            let phase = phase_str.parse::<PluginPhase>().unwrap_or_default();
            indexed.push((phase.order(), i));
        }
        indexed.sort_by_key(|(order, _)| *order);

        // Inject runtime into each plugin. Python subclasses of `Plugin`
        // (PyPlugin) inherit the parent's storage, so `PyRefMut<'_, PyPlugin>`
        // is obtainable from subclass instances. Fail loudly if extraction
        // fails — otherwise the plugin would silently stay uninitialized and
        // later `execute()` / `execute_stream()` calls would error with a
        // cryptic "Plugin not initialized" message.
        for &(_, i) in &indexed {
            let plugin_obj = &self.plugins[i];
            let name: String = plugin_obj
                .getattr(py, "name")
                .and_then(|a| a.extract(py))
                .unwrap_or_else(|_| format!("plugin-{i}"));
            let runtime = PluginRuntime::new(&name, cache.clone(), None);

            let mut py_plugin = plugin_obj
                .extract::<PyRefMut<'_, PyPlugin>>(py)
                .map_err(|e| {
                    pyo3::exceptions::PyTypeError::new_err(format!(
                        "Plugin '{name}' is not a subclass of appkit.Plugin (cannot inject runtime): {e}"
                    ))
                })?;
            py_plugin.inject_runtime(runtime);
        }

        // Call setup() on each plugin in phase order.
        let ordered_plugins: Vec<PyObject> =
            indexed.iter().map(|&(_, i)| self.plugins[i].clone_ref(py)).collect();

        self.initialized = true;

        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            for plugin_obj in ordered_plugins {
                let future = Python::with_gil(|py| {
                    let setup_result = plugin_obj.call_method0(py, "setup")?;
                    pyo3_async_runtimes::tokio::into_future(setup_result.into_bound(py))
                })?;
                future.await?;
            }
            Ok(())
        })
    }

    /// Get a registered plugin by name.
    fn get_plugin(&self, py: Python<'_>, name: &str) -> PyResult<Option<PyObject>> {
        for plugin_obj in &self.plugins {
            let plugin_name: String = plugin_obj
                .getattr(py, "name")
                .and_then(|a| a.extract(py))
                .unwrap_or_default();
            if plugin_name == name {
                return Ok(Some(plugin_obj.clone_ref(py)));
            }
        }
        Ok(None)
    }

    /// List all registered plugin names.
    fn plugin_names(&self, py: Python<'_>) -> Vec<String> {
        self.plugins
            .iter()
            .filter_map(|obj| {
                obj.getattr(py, "name")
                    .and_then(|a| a.extract(py))
                    .ok()
            })
            .collect()
    }

    /// Start the HTTP server. Collects routes from all registered plugins via
    /// `inject_routes()`, aggregates client configs, and starts an axum server.
    ///
    /// ```python
    /// await app.start_server(ServerConfig(host="0.0.0.0", port=8000))
    /// ```
    #[pyo3(signature = (server_config))]
    pub fn start_server<'py>(
        &self,
        py: Python<'py>,
        server_config: crate::server::PyServerConfig,
    ) -> PyResult<Bound<'py, PyAny>> {
        if !self.initialized {
            return Err(pyo3::exceptions::PyRuntimeError::new_err(
                "AppKit must be initialized before starting the server",
            ));
        }
        {
            let guard = self.shutdown_tx.lock().unwrap();
            if guard.is_some() {
                return Err(pyo3::exceptions::PyRuntimeError::new_err(
                    "Server already started",
                ));
            }
        }

        // Collect routes and client configs from all plugins.
        let mut all_routes: Vec<(String, Vec<crate::server::RouteDefinition>)> = Vec::new();
        let mut plugin_configs: HashMap<String, serde_json::Value> = HashMap::new();

        for plugin_obj in &self.plugins {
            let name: String = plugin_obj
                .getattr(py, "name")
                .and_then(|a| a.extract(py))
                .unwrap_or_default();

            // Call inject_routes if the plugin defines it.
            let router = crate::server::PyRouter::new(&name);
            let router_obj = Py::new(py, router)?;
            let _ = plugin_obj.call_method1(py, "inject_routes", (router_obj.clone_ref(py),));
            let routes = router_obj.borrow(py).take_routes();
            if !routes.is_empty() {
                all_routes.push((name.clone(), routes));
            }

            // Collect client_config (expects JSON string or dict).
            if let Ok(config_result) = plugin_obj.call_method0(py, "client_config") {
                if let Ok(config_dict) = config_result.extract::<HashMap<String, String>>(py) {
                    if !config_dict.is_empty() {
                        let json_val = serde_json::to_value(&config_dict).unwrap_or_default();
                        plugin_configs.insert(name.clone(), json_val);
                    }
                }
            }
        }

        let task_locals = pyo3_async_runtimes::tokio::get_current_locals(py)?;
        let stream_manager = crate::stream::StreamManager::new(crate::stream::StreamConfig::default());
        let static_path = crate::server::detect_static_path(server_config.static_path.as_deref());
        let router = crate::server::build_router(
            all_routes,
            plugin_configs,
            stream_manager.clone(),
            static_path,
            task_locals,
        );
        let host = server_config.host.clone();
        let port = server_config.port;
        let shutdown_slot = self.shutdown_tx.clone();

        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let handle =
                crate::server::start_server(router, &host, port, stream_manager)
                    .await
                    .map_err(pyo3::exceptions::PyRuntimeError::new_err)?;
            *shutdown_slot.lock().unwrap() = Some(handle.shutdown_tx);
            Ok(())
        })
    }

    /// Trigger graceful server shutdown.
    fn shutdown(&self) -> PyResult<()> {
        let guard = self.shutdown_tx.lock().unwrap();
        match guard.as_ref() {
            Some(tx) => {
                let _ = tx.send(true);
                Ok(())
            }
            None => Err(pyo3::exceptions::PyRuntimeError::new_err(
                "Server is not running",
            )),
        }
    }

    fn __repr__(&self) -> String {
        format!(
            "AppKit(plugins={}, initialized={})",
            self.plugins.len(),
            self.initialized
        )
    }

    fn __len__(&self) -> usize {
        self.plugins.len()
    }

    fn __bool__(&self) -> bool {
        self.initialized
    }

    fn __contains__(&self, py: Python<'_>, name: &str) -> bool {
        self.plugins.iter().any(|obj| {
            obj.getattr(py, "name")
                .and_then(|a| a.extract::<String>(py))
                .map(|n| n == name)
                .unwrap_or(false)
        })
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::Ordering;

    fn test_manifest(name: &str) -> PluginManifest {
        PluginManifest {
            name: name.to_string(),
            display_name: None,
            description: None,
            required_resources: vec![],
            optional_resources: vec![],
        }
    }

    // -- PluginPhase --

    #[test]
    fn test_phase_ordering() {
        assert!(PluginPhase::Core.order() < PluginPhase::Normal.order());
        assert!(PluginPhase::Normal.order() < PluginPhase::Deferred.order());
    }

    #[test]
    fn test_phase_from_str() {
        assert_eq!("core".parse(), Ok(PluginPhase::Core));
        assert_eq!("normal".parse(), Ok(PluginPhase::Normal));
        assert_eq!("deferred".parse(), Ok(PluginPhase::Deferred));
        assert!("invalid".parse::<PluginPhase>().is_err());
    }

    #[test]
    fn test_phase_roundtrip() {
        for phase in [PluginPhase::Core, PluginPhase::Normal, PluginPhase::Deferred] {
            assert_eq!(phase.as_str().parse(), Ok(phase));
        }
    }

    // -- ExecutionResult --

    #[test]
    fn test_execution_result_ok() {
        let r = ExecutionResult::Ok {
            data: JsonValue::String("hello".into()),
        };
        assert!(r.is_ok());
        assert_eq!(r.data(), Some(&JsonValue::String("hello".into())));
    }

    #[test]
    fn test_execution_result_err() {
        let r = ExecutionResult::Err {
            status: 404,
            message: "not found".into(),
        };
        assert!(!r.is_ok());
        assert!(r.data().is_none());
    }

    // -- PluginRuntime --

    #[tokio::test]
    async fn test_runtime_execute_success() {
        let cache = Arc::new(CacheManager::new_internal(CacheConfig::default()));
        let runtime = PluginRuntime {
            name: "test".into(),
            cache,
            telemetry: Arc::new(TelemetryProvider::new_disabled("test")),
        };

        let result = runtime
            .execute(
                || async { Ok(JsonValue::Number(42.into())) },
                PluginExecuteConfig::default(),
                "user-1",
            )
            .await;

        assert!(result.is_ok());
        assert_eq!(result.data(), Some(&JsonValue::Number(42.into())));
    }

    #[tokio::test]
    async fn test_runtime_execute_error() {
        let cache = Arc::new(CacheManager::new_internal(CacheConfig::default()));
        let runtime = PluginRuntime {
            name: "test".into(),
            cache,
            telemetry: Arc::new(TelemetryProvider::new_disabled("test")),
        };

        let result = runtime
            .execute(
                || async {
                    Err(ExecutionError {
                        status: 503,
                        message: "service unavailable".into(),
                    })
                },
                PluginExecuteConfig::default(),
                "user-1",
            )
            .await;

        assert!(!result.is_ok());
        match result {
            ExecutionResult::Err { status, message } => {
                assert_eq!(status, 503);
                assert_eq!(message, "service unavailable");
            }
            _ => panic!("expected Err"),
        }
    }

    #[tokio::test]
    async fn test_runtime_execute_with_timeout() {
        let cache = Arc::new(CacheManager::new_internal(CacheConfig::default()));
        let runtime = PluginRuntime {
            name: "test".into(),
            cache,
            telemetry: Arc::new(TelemetryProvider::new_disabled("test")),
        };

        let result = runtime
            .execute(
                || async {
                    tokio::time::sleep(std::time::Duration::from_secs(10)).await;
                    Ok(JsonValue::Null)
                },
                PluginExecuteConfig {
                    timeout_ms: Some(50),
                    ..Default::default()
                },
                "user-1",
            )
            .await;

        assert!(!result.is_ok());
        match result {
            ExecutionResult::Err { status, .. } => assert_eq!(status, 408),
            _ => panic!("expected timeout error"),
        }
    }

    #[tokio::test]
    async fn test_runtime_execute_with_cache() {
        let cache = Arc::new(CacheManager::new_internal(CacheConfig::default()));
        let runtime = PluginRuntime {
            name: "test".into(),
            cache,
            telemetry: Arc::new(TelemetryProvider::new_disabled("test")),
        };

        let counter = Arc::new(std::sync::atomic::AtomicU32::new(0));
        let counter_c = counter.clone();
        let f = move || {
            let counter = counter_c.clone();
            async move {
                counter.fetch_add(1, Ordering::SeqCst);
                Ok(JsonValue::String("value".into()))
            }
        };

        let config = PluginExecuteConfig {
            cache: Some(crate::interceptor::CacheInterceptorConfig {
                enabled: true,
                cache_key: vec!["test-key".into()],
                ttl: Some(60),
            }),
            ..Default::default()
        };

        // First call computes
        let r1 = runtime.execute(f.clone(), config.clone(), "user-1").await;
        assert!(r1.is_ok());
        assert_eq!(counter.load(Ordering::SeqCst), 1);

        // Second call hits cache
        let r2 = runtime.execute(f, config, "user-1").await;
        assert!(r2.is_ok());
        assert_eq!(counter.load(Ordering::SeqCst), 1);
    }

    // -- Plugin trait --

    struct TestPlugin {
        manifest: PluginManifest,
    }

    impl Plugin for TestPlugin {
        fn name(&self) -> &str {
            &self.manifest.name
        }

        fn manifest(&self) -> &PluginManifest {
            &self.manifest
        }

        fn phase(&self) -> PluginPhase {
            PluginPhase::Normal
        }
    }

    #[test]
    fn test_plugin_trait_defaults() {
        let p = TestPlugin {
            manifest: test_manifest("my-plugin"),
        };
        assert_eq!(p.name(), "my-plugin");
        assert_eq!(p.phase(), PluginPhase::Normal);
        assert!(p.exports().is_empty());
        assert!(p.client_config().is_empty());
    }

    // -- PyExecutionResult --

    #[test]
    fn test_py_execution_result_from_ok() {
        let r = ExecutionResult::Ok {
            data: JsonValue::Bool(true),
        };
        let py_r = PyExecutionResult::from(r);
        assert!(py_r.ok);
        assert_eq!(py_r.data, Some("true".to_string()));
        assert!(py_r.status.is_none());
    }

    #[test]
    fn test_py_execution_result_from_err() {
        let r = ExecutionResult::Err {
            status: 400,
            message: "bad request".into(),
        };
        let py_r = PyExecutionResult::from(r);
        assert!(!py_r.ok);
        assert!(py_r.data.is_none());
        assert_eq!(py_r.status, Some(400));
        assert_eq!(py_r.message, Some("bad request".into()));
    }
}
