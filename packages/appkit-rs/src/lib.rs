use pyo3::prelude::*;

pub mod auth;
pub mod cache;
pub mod config;
pub mod connectors;
pub mod context;
pub mod errors;
pub mod interceptor;
pub mod plugin;
pub mod plugins;
pub mod server;
pub mod stream;
pub mod telemetry;

// ---------------------------------------------------------------------------
// Top-level create_app() convenience function
// ---------------------------------------------------------------------------

/// Create and initialize an AppKit instance in one call.
///
/// This is the primary public API — mirrors TypeScript's `createApp(...)`.
///
/// ```python
/// app = await create_app(
///     config=AppConfig.from_env(),
///     plugins=[my_plugin],
///     cache_config=CacheConfig(ttl=600),
///     auto_start=True,
/// )
/// ```
///
/// Steps:
/// 1. Creates an `AppKit` instance
/// 2. Registers all provided plugins
/// 3. Initializes (telemetry, cache, phase-ordered plugin setup)
/// 4. Optionally starts the HTTP server (when `auto_start=True`)
///
/// Returns the initialized `AppKit` instance.
#[pyfunction]
#[pyo3(signature = (*, config, plugins = vec![], cache_config = None, server_config = None, auto_start = true))]
fn create_app<'py>(
    py: Python<'py>,
    config: config::AppConfig,
    plugins: Vec<PyObject>,
    cache_config: Option<cache::CacheConfig>,
    server_config: Option<server::PyServerConfig>,
    auto_start: bool,
) -> PyResult<Bound<'py, PyAny>> {
    let server_cfg = server_config.unwrap_or_else(|| server::PyServerConfig {
        host: config.host.clone(),
        port: config.app_port,
        auto_start,
        static_path: None,
    });
    let should_start = server_cfg.auto_start;

    // Build the AppKit, register plugins synchronously.
    let mut app = plugin::PyAppKit::new();
    for p in plugins {
        app.register(p)?;
    }

    let app_obj = Py::new(py, app)?;

    // Call initialize (returns an awaitable coroutine).
    let init_coro: PyObject = {
        let mut app_mut = app_obj.borrow_mut(py);
        let coro = app_mut.initialize(py, config, cache_config)?;
        coro.unbind()
    };

    let app_clone = app_obj.clone_ref(py);
    let server_cfg = Py::new(py, server_cfg)?;

    pyo3_async_runtimes::tokio::future_into_py(py, async move {
        // Await initialization.
        let init_future = Python::with_gil(|py| {
            pyo3_async_runtimes::tokio::into_future(init_coro.into_bound(py))
        })?;
        init_future.await?;

        // Start server if auto_start is enabled.
        if should_start {
            let server_future = Python::with_gil(|py| -> PyResult<_> {
                let cfg = server_cfg.extract::<server::PyServerConfig>(py)?;
                let app = app_clone.borrow(py);
                let coro = app.start_server(py, cfg)?;
                pyo3_async_runtimes::tokio::into_future(coro)
            })?;
            server_future.await?;
        }

        Ok(app_clone)
    })
}

/// Python module entry point for `appkit`.
///
/// Exposes config, auth, cache, telemetry, plugin, server, streaming,
/// connector, and context types to Python. Async methods are bridged via
/// pyo3-async-runtimes + tokio so they can be awaited from Python's asyncio
/// event loop.
#[pymodule]
fn appkit(m: &Bound<'_, PyModule>) -> PyResult<()> {
    // Initialize the Tokio runtime for pyo3-async-runtimes so that
    // future_into_py-backed async methods work when called from Python.
    let mut builder = tokio::runtime::Builder::new_multi_thread();
    builder.enable_all();
    pyo3_async_runtimes::tokio::init(builder);

    // Config
    m.add_class::<config::AppConfig>()?;

    // Auth / context
    m.add_class::<auth::ServiceContext>()?;
    m.add_class::<auth::UserContext>()?;

    // Cache
    m.add_class::<cache::CacheConfig>()?;
    m.add_class::<cache::CacheManager>()?;

    // Plugin system
    m.add_class::<plugin::PyPluginPhase>()?;
    m.add_class::<plugin::PyPluginManifest>()?;
    m.add_class::<plugin::PyPlugin>()?;
    m.add_class::<plugin::PyExecutionResult>()?;
    m.add_class::<plugin::PyStreamIterator>()?;
    m.add_class::<plugin::PyAppKit>()?;

    // Server / routing
    m.add_class::<server::PyRouter>()?;
    m.add_class::<server::PyRequest>()?;
    m.add_class::<server::PyServerConfig>()?;

    // Connectors
    m.add_class::<connectors::files::FilesConnector>()?;
    m.add_class::<connectors::files::FileDirectoryEntry>()?;
    m.add_class::<connectors::files::FileMetadata>()?;
    m.add_class::<connectors::files::FilePreview>()?;
    m.add_class::<connectors::sql_warehouse::SqlWarehouseConnector>()?;
    m.add_class::<connectors::sql_warehouse::SqlColumn>()?;
    m.add_class::<connectors::sql_warehouse::SqlStatementResult>()?;
    m.add_class::<connectors::genie::GenieConnector>()?;
    m.add_class::<connectors::genie::GenieMessage>()?;
    m.add_class::<connectors::genie::GenieAttachment>()?;
    m.add_class::<connectors::genie::GenieConversationHistory>()?;
    m.add_class::<connectors::genie::GenieQueryResult>()?;
    m.add_class::<connectors::serving::ServingConnector>()?;
    m.add_class::<connectors::serving::ServingResponse>()?;
    m.add_class::<connectors::lakebase::LakebaseConnector>()?;
    m.add_class::<connectors::lakebase::DatabaseCredential>()?;
    m.add_class::<connectors::lakebase::LakebasePgConfig>()?;
    m.add_class::<connectors::vector_search::VectorSearchConnector>()?;
    m.add_class::<connectors::vector_search::PyVsSearchRequest>()?;

    // Top-level create_app function
    m.add_function(wrap_pyfunction!(create_app, m)?)?;

    // Context helpers
    m.add_function(wrap_pyfunction!(context::run_in_user_context, m)?)?;
    m.add_function(wrap_pyfunction!(context::as_user, m)?)?;
    m.add_function(wrap_pyfunction!(context::get_current_user, m)?)?;
    m.add_function(wrap_pyfunction!(context::is_in_user_context, m)?)?;

    // Error hierarchy — Python exception classes (AppKitError + subclasses).
    errors::register(m.py(), m)?;

    // Initialize the contextvars.ContextVar on the module.
    context::create_context_var(m.py(), m)?;

    Ok(())
}
