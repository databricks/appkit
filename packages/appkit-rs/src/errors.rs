//! Shared error hierarchy — TS-style typed errors exposed as Python exception
//! classes and a Rust `AppKitErrorKind` enum for internal classification.
//!
//! Mirrors `packages/appkit/src/errors/*.ts`:
//!   `AppKitError` (base) → `ValidationError`, `AuthenticationError`,
//!   `NotFoundError`, `PayloadTooLargeError`, `UpstreamError`, `TimeoutError`,
//!   `ConnectionError`, `ConfigurationError`, `InternalError`.
//!
//! Each Python class inherits from `appkit.AppKitError` (which inherits from
//! `Exception`). The Rust `AppKitErrorKind` enum maps them to HTTP status codes
//! and a stable string code. Plugin execute() and route handlers classify any
//! raised exception into this hierarchy so callers see consistent HTTP
//! responses and `ExecutionResult.status` values.

use pyo3::create_exception;
use pyo3::exceptions::{PyException, PyRuntimeError, PyValueError};
use pyo3::prelude::*;
use pyo3::types::PyType;
use pyo3::PyTypeInfo;

// ---------------------------------------------------------------------------
// Python exception classes
// ---------------------------------------------------------------------------

// Base: appkit.AppKitError(Exception)
create_exception!(appkit, AppKitError, PyException);

// Subclasses of AppKitError — kept in registration order so later lookups
// (is_instance_of) are stable across calls.
create_exception!(appkit, ValidationError, AppKitError);
create_exception!(appkit, AuthenticationError, AppKitError);
create_exception!(appkit, NotFoundError, AppKitError);
create_exception!(appkit, PayloadTooLargeError, AppKitError);
create_exception!(appkit, UpstreamError, AppKitError);
create_exception!(appkit, TimeoutError, AppKitError);
create_exception!(appkit, ConnectionError, AppKitError);
create_exception!(appkit, ConfigurationError, AppKitError);
create_exception!(appkit, InternalError, AppKitError);

// ---------------------------------------------------------------------------
// AppKitErrorKind — Rust-side classification
// ---------------------------------------------------------------------------

/// Typed error kind matching the TS error hierarchy.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AppKitErrorKind {
    Validation,
    Authentication,
    NotFound,
    PayloadTooLarge,
    Upstream,
    Timeout,
    Connection,
    Configuration,
    Internal,
}

impl AppKitErrorKind {
    /// HTTP status code matching the TS `statusCode` field.
    pub fn status(&self) -> u16 {
        match self {
            Self::Validation => 400,
            Self::Authentication => 401,
            Self::NotFound => 404,
            Self::PayloadTooLarge => 413,
            Self::Timeout => 408,
            Self::Upstream => 502,
            Self::Connection => 503,
            Self::Configuration => 500,
            Self::Internal => 500,
        }
    }

    /// Stable string code matching the TS `code` field.
    pub fn code(&self) -> &'static str {
        match self {
            Self::Validation => "VALIDATION_ERROR",
            Self::Authentication => "AUTHENTICATION_ERROR",
            Self::NotFound => "NOT_FOUND",
            Self::PayloadTooLarge => "PAYLOAD_TOO_LARGE",
            Self::Timeout => "TIMEOUT",
            Self::Upstream => "UPSTREAM_ERROR",
            Self::Connection => "CONNECTION_ERROR",
            Self::Configuration => "CONFIGURATION_ERROR",
            Self::Internal => "INTERNAL_ERROR",
        }
    }

    /// Classify an HTTP status code from an upstream response.
    pub fn from_http_status(status: u16) -> Self {
        match status {
            400 => Self::Validation,
            401 | 403 => Self::Authentication,
            404 => Self::NotFound,
            408 => Self::Timeout,
            413 => Self::PayloadTooLarge,
            500..=599 => Self::Upstream,
            _ => Self::Internal,
        }
    }

    /// Build a Python exception of the matching class with `message`.
    pub fn to_py_err(&self, message: impl Into<String>) -> PyErr {
        let msg = message.into();
        match self {
            Self::Validation => ValidationError::new_err(msg),
            Self::Authentication => AuthenticationError::new_err(msg),
            Self::NotFound => NotFoundError::new_err(msg),
            Self::PayloadTooLarge => PayloadTooLargeError::new_err(msg),
            Self::Timeout => TimeoutError::new_err(msg),
            Self::Upstream => UpstreamError::new_err(msg),
            Self::Connection => ConnectionError::new_err(msg),
            Self::Configuration => ConfigurationError::new_err(msg),
            Self::Internal => InternalError::new_err(msg),
        }
    }
}

// ---------------------------------------------------------------------------
// Classification helpers
// ---------------------------------------------------------------------------

/// Classify an arbitrary `PyErr` into the AppKit error hierarchy.
/// Returns `(status, code, message)` suitable for interceptor/route responses.
pub fn classify_pyerr(py: Python<'_>, err: &PyErr) -> (u16, &'static str, String) {
    let kind = classify_kind(py, err);
    (kind.status(), kind.code(), err.to_string())
}

fn classify_kind(py: Python<'_>, err: &PyErr) -> AppKitErrorKind {
    // Order matters: check most specific (subclasses) first.
    let cases: &[(fn(Python<'_>) -> Bound<'_, PyType>, AppKitErrorKind)] = &[
        (ValidationError::type_object, AppKitErrorKind::Validation),
        (
            AuthenticationError::type_object,
            AppKitErrorKind::Authentication,
        ),
        (NotFoundError::type_object, AppKitErrorKind::NotFound),
        (
            PayloadTooLargeError::type_object,
            AppKitErrorKind::PayloadTooLarge,
        ),
        (UpstreamError::type_object, AppKitErrorKind::Upstream),
        (TimeoutError::type_object, AppKitErrorKind::Timeout),
        (ConnectionError::type_object, AppKitErrorKind::Connection),
        (
            ConfigurationError::type_object,
            AppKitErrorKind::Configuration,
        ),
        (InternalError::type_object, AppKitErrorKind::Internal),
        (AppKitError::type_object, AppKitErrorKind::Internal),
    ];

    for (type_fn, kind) in cases {
        let ty = type_fn(py);
        if err.matches(py, &ty).unwrap_or(false) {
            return *kind;
        }
    }

    // Common stdlib exceptions → sensible fallbacks.
    if err.is_instance_of::<PyValueError>(py) {
        return AppKitErrorKind::Validation;
    }
    if err.is_instance_of::<PyRuntimeError>(py) {
        return AppKitErrorKind::Internal;
    }
    AppKitErrorKind::Internal
}

// ---------------------------------------------------------------------------
// Module registration
// ---------------------------------------------------------------------------

pub fn register(py: Python<'_>, m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add("AppKitError", py.get_type::<AppKitError>())?;
    m.add("ValidationError", py.get_type::<ValidationError>())?;
    m.add("AuthenticationError", py.get_type::<AuthenticationError>())?;
    m.add("NotFoundError", py.get_type::<NotFoundError>())?;
    m.add("PayloadTooLargeError", py.get_type::<PayloadTooLargeError>())?;
    m.add("UpstreamError", py.get_type::<UpstreamError>())?;
    m.add("TimeoutError", py.get_type::<TimeoutError>())?;
    m.add("ConnectionError", py.get_type::<ConnectionError>())?;
    m.add("ConfigurationError", py.get_type::<ConfigurationError>())?;
    m.add("InternalError", py.get_type::<InternalError>())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_status_codes() {
        assert_eq!(AppKitErrorKind::Validation.status(), 400);
        assert_eq!(AppKitErrorKind::Authentication.status(), 401);
        assert_eq!(AppKitErrorKind::NotFound.status(), 404);
        assert_eq!(AppKitErrorKind::Timeout.status(), 408);
        assert_eq!(AppKitErrorKind::PayloadTooLarge.status(), 413);
        assert_eq!(AppKitErrorKind::Upstream.status(), 502);
        assert_eq!(AppKitErrorKind::Connection.status(), 503);
        assert_eq!(AppKitErrorKind::Configuration.status(), 500);
        assert_eq!(AppKitErrorKind::Internal.status(), 500);
    }

    #[test]
    fn test_codes_are_stable_strings() {
        // Downstream telemetry relies on these; if they change, update docs.
        assert_eq!(AppKitErrorKind::Validation.code(), "VALIDATION_ERROR");
        assert_eq!(AppKitErrorKind::NotFound.code(), "NOT_FOUND");
        assert_eq!(AppKitErrorKind::Timeout.code(), "TIMEOUT");
    }

    #[test]
    fn test_from_http_status() {
        assert_eq!(AppKitErrorKind::from_http_status(400), AppKitErrorKind::Validation);
        assert_eq!(AppKitErrorKind::from_http_status(401), AppKitErrorKind::Authentication);
        assert_eq!(AppKitErrorKind::from_http_status(403), AppKitErrorKind::Authentication);
        assert_eq!(AppKitErrorKind::from_http_status(404), AppKitErrorKind::NotFound);
        assert_eq!(AppKitErrorKind::from_http_status(408), AppKitErrorKind::Timeout);
        assert_eq!(AppKitErrorKind::from_http_status(413), AppKitErrorKind::PayloadTooLarge);
        assert_eq!(AppKitErrorKind::from_http_status(500), AppKitErrorKind::Upstream);
        assert_eq!(AppKitErrorKind::from_http_status(502), AppKitErrorKind::Upstream);
        assert_eq!(AppKitErrorKind::from_http_status(418), AppKitErrorKind::Internal);
    }

    #[test]
    fn test_classify_pyerr_validation() {
        pyo3::prepare_freethreaded_python();
        Python::with_gil(|py| {
            let err = ValidationError::new_err("bad input");
            let (status, code, msg) = classify_pyerr(py, &err);
            assert_eq!(status, 400);
            assert_eq!(code, "VALIDATION_ERROR");
            assert!(msg.contains("bad input"));
        });
    }

    #[test]
    fn test_classify_pyerr_authentication() {
        pyo3::prepare_freethreaded_python();
        Python::with_gil(|py| {
            let err = AuthenticationError::new_err("bad token");
            let (status, _code, _msg) = classify_pyerr(py, &err);
            assert_eq!(status, 401);
        });
    }

    #[test]
    fn test_classify_pyerr_value_error_falls_back_to_validation() {
        pyo3::prepare_freethreaded_python();
        Python::with_gil(|py| {
            let err = PyValueError::new_err("bad");
            let (status, _code, _msg) = classify_pyerr(py, &err);
            assert_eq!(status, 400);
        });
    }

    #[test]
    fn test_classify_pyerr_generic_runtime_falls_back_to_internal() {
        pyo3::prepare_freethreaded_python();
        Python::with_gil(|py| {
            let err = PyRuntimeError::new_err("unexpected");
            let (status, _code, _msg) = classify_pyerr(py, &err);
            assert_eq!(status, 500);
        });
    }
}
