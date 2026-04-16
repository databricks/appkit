//! Python `contextvars`-based execution context.
//!
//! Mirrors the TypeScript `AsyncLocalStorage`-based execution context in
//! `packages/appkit/src/context/execution-context.ts`.
//!
//! Provides:
//! - `_USER_CONTEXT_VAR`: a module-level `contextvars.ContextVar` holding the
//!   current `UserContext` (or `None` when running as service principal).
//! - `run_in_user_context(user_ctx, fn)`: run a sync callable with user context.
//! - `as_user(user_ctx, async_fn)`: run an async callable with user context.
//! - `get_current_user()`: retrieve the current `UserContext`, or `None`.
//! - `is_in_user_context()`: check whether a user context is active.

use pyo3::prelude::*;

use crate::auth::UserContext;

// ---------------------------------------------------------------------------
// Module-level ContextVar helpers
// ---------------------------------------------------------------------------

/// Create the `_USER_CONTEXT_VAR` ContextVar and register it on a module.
pub fn create_context_var(py: Python<'_>, m: &Bound<'_, PyModule>) -> PyResult<()> {
    let contextvars = py.import("contextvars")?;
    let cv =
        contextvars.call_method1("ContextVar", ("appkit_user_context",))?;
    m.setattr("_USER_CONTEXT_VAR", cv)?;
    Ok(())
}

/// Retrieve the `_USER_CONTEXT_VAR` from the native appkit module.
fn get_context_var(py: Python<'_>) -> PyResult<PyObject> {
    let module = py.import("appkit.appkit")?;
    let cv = module.getattr("_USER_CONTEXT_VAR")?;
    Ok(cv.into())
}

// ---------------------------------------------------------------------------
// Public Python functions
// ---------------------------------------------------------------------------

/// Run a synchronous callable with the given `UserContext` set as the current
/// execution context for the duration of the call.
///
/// Mirrors TypeScript's `runInUserContext(userContext, fn)`.
///
/// ```python
/// result = run_in_user_context(user_ctx, lambda: do_work())
/// ```
#[pyfunction]
#[pyo3(signature = (user_context, func))]
pub fn run_in_user_context(
    py: Python<'_>,
    user_context: UserContext,
    func: PyObject,
) -> PyResult<PyObject> {
    let cv = get_context_var(py)?;
    let token = cv.call_method1(py, "set", (user_context,))?;
    let result = func.call0(py);
    // Always reset, even on error.
    let _ = cv.call_method1(py, "reset", (token,));
    result
}

/// Run an async callable with the given `UserContext` set for the duration.
///
/// Returns an awaitable coroutine. The context variable is set before calling
/// `async_fn()` and reset after it completes (or raises).
///
/// ```python
/// result = await as_user(user_ctx, my_async_fn)
/// ```
#[pyfunction]
#[pyo3(signature = (user_context, func))]
pub fn as_user<'py>(
    py: Python<'py>,
    user_context: UserContext,
    func: PyObject,
) -> PyResult<Bound<'py, PyAny>> {
    let user_ctx = Py::new(py, user_context)?;

    // Import the Python-side wrapper that sets the context var *inside*
    // a native coroutine, ensuring the value propagates correctly across
    // the PyO3-tokio bridge.
    let context_mod = py.import("appkit._context")?;
    let wrapper_fn = context_mod.getattr("_as_user_wrapper")?;

    let cv = get_context_var(py)?;
    let coroutine = wrapper_fn.call1((cv, user_ctx, func))?.unbind();

    pyo3_async_runtimes::tokio::future_into_py(py, async move {
        let future = Python::with_gil(|py| {
            pyo3_async_runtimes::tokio::into_future(coroutine.into_bound(py))
        })?;
        future.await
    })
}

/// Get the current `UserContext` from the execution context, or `None` if
/// running as service principal (no user context set).
///
/// ```python
/// user = get_current_user()
/// if user is not None:
///     print(user.user_id)
/// ```
#[pyfunction]
pub fn get_current_user(py: Python<'_>) -> PyResult<Option<UserContext>> {
    let cv = get_context_var(py)?;
    // Use sentinel to detect unset: cv.get(<sentinel>)
    let none = py.None();
    let val = cv.call_method1(py, "get", (none.clone_ref(py),))?;

    if val.is_none(py) {
        return Ok(None);
    }

    match val.extract::<UserContext>(py) {
        Ok(ctx) => Ok(Some(ctx)),
        Err(_) => Ok(None),
    }
}

/// Check whether the current execution is running in a user context.
///
/// ```python
/// if is_in_user_context():
///     user = get_current_user()
/// ```
#[pyfunction]
pub fn is_in_user_context(py: Python<'_>) -> PyResult<bool> {
    Ok(get_current_user(py)?.is_some())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_user_context_round_trip() {
        // Verify UserContext can be created in Rust — Python interop is
        // tested in the Python integration tests.
        let ctx = UserContext::new(
            "tok".into(),
            "u1".into(),
            Some("Alice".into()),
            "ws-1".into(),
            None,
        );
        assert_eq!(ctx.user_id, "u1");
        assert_eq!(ctx.workspace_id, "ws-1");
    }
}
