//! Async middleware chain implementing the AppKit interceptor pattern.
//!
//! Execution order (outermost to innermost):
//!   **Telemetry → Timeout → Retry → Cache → user function**
//!
//! Each interceptor is a wrapping function that takes the "next" callable and
//! returns a new callable. The chain is built bottom-up so that the outermost
//! interceptor runs first.

use crate::cache::CacheManager;
use crate::telemetry::TelemetryProvider;
use serde_json::Value as JsonValue;
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

/// Error produced by the interceptor chain or user function.
#[derive(Clone, Debug)]
pub struct ExecutionError {
    pub status: u16,
    pub message: String,
}

impl std::fmt::Display for ExecutionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{}] {}", self.status, self.message)
    }
}

impl std::error::Error for ExecutionError {}

/// Context passed through the interceptor chain.
pub struct InterceptorContext {
    pub user_key: String,
    pub cancelled: Arc<AtomicBool>,
    pub metadata: HashMap<String, String>,
}

/// A callable that can be invoked multiple times (needed for retry).
/// Each invocation produces a new future that resolves to the execution result.
pub type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;
pub type ExecuteFn =
    Arc<dyn Fn() -> BoxFuture<Result<JsonValue, ExecutionError>> + Send + Sync>;

// ---------------------------------------------------------------------------
// Interceptor config types
// ---------------------------------------------------------------------------

/// Retry configuration matching TS `RetryConfig`.
#[derive(Clone, Debug)]
pub struct RetryConfig {
    pub enabled: bool,
    pub attempts: u32,
    pub initial_delay_ms: u64,
    pub max_delay_ms: u64,
}

impl Default for RetryConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            attempts: 3,
            initial_delay_ms: 1000,
            max_delay_ms: 30_000,
        }
    }
}

/// Cache interceptor configuration.
#[derive(Clone, Debug)]
pub struct CacheInterceptorConfig {
    pub enabled: bool,
    pub cache_key: Vec<String>,
    pub ttl: Option<u64>,
}

/// Telemetry interceptor configuration.
#[derive(Clone, Debug)]
pub struct TelemetryInterceptorConfig {
    pub enabled: bool,
    pub span_name: Option<String>,
    pub attributes: Vec<(String, String)>,
}

/// Combined configuration for a single `execute()` call.
#[derive(Clone, Debug, Default)]
pub struct PluginExecuteConfig {
    pub cache: Option<CacheInterceptorConfig>,
    pub retry: Option<RetryConfig>,
    pub telemetry: Option<TelemetryInterceptorConfig>,
    pub timeout_ms: Option<u64>,
}

// ---------------------------------------------------------------------------
// Interceptor wrappers
// ---------------------------------------------------------------------------

/// Wrap with telemetry span (outermost interceptor).
pub fn wrap_with_telemetry(
    next: ExecuteFn,
    telemetry: Arc<TelemetryProvider>,
    span_name: String,
    attributes: Vec<(String, String)>,
    cancelled: Arc<AtomicBool>,
) -> ExecuteFn {
    Arc::new(move || {
        let next = next.clone();
        let telemetry = telemetry.clone();
        let span_name = span_name.clone();
        let attributes = attributes.clone();
        let cancelled = cancelled.clone();

        Box::pin(async move {
            if cancelled.load(Ordering::Relaxed) {
                return Err(ExecutionError {
                    status: 499,
                    message: "Operation aborted before execution".into(),
                });
            }

            if !telemetry.traces_enabled() {
                return next().await;
            }

            use opentelemetry::trace::{Span, Status, Tracer};
            let tracer = telemetry.tracer();
            let mut span = tracer.start(span_name);

            for (k, v) in &attributes {
                span.set_attribute(opentelemetry::KeyValue::new(k.clone(), v.clone()));
            }

            let result = next().await;

            match &result {
                Ok(_) => {
                    span.set_status(Status::Ok);
                }
                Err(e) => {
                    span.set_status(Status::error(e.message.clone()));
                }
            }
            span.end();

            result
        })
    })
}

/// Wrap with timeout (second outermost).
pub fn wrap_with_timeout(
    next: ExecuteFn,
    timeout_ms: u64,
    cancelled: Arc<AtomicBool>,
) -> ExecuteFn {
    Arc::new(move || {
        let next = next.clone();
        let cancelled = cancelled.clone();

        Box::pin(async move {
            let timeout = Duration::from_millis(timeout_ms);
            match tokio::time::timeout(timeout, next()).await {
                Ok(result) => result,
                Err(_) => {
                    cancelled.store(true, Ordering::Relaxed);
                    Err(ExecutionError {
                        status: 408,
                        message: format!("Operation timed out after {timeout_ms} ms"),
                    })
                }
            }
        })
    })
}

/// Wrap with retry + exponential backoff with full jitter (third layer).
pub fn wrap_with_retry(
    next: ExecuteFn,
    config: RetryConfig,
    cancelled: Arc<AtomicBool>,
) -> ExecuteFn {
    Arc::new(move || {
        let next = next.clone();
        let cancelled = cancelled.clone();
        let attempts = config.attempts;
        let initial_delay = config.initial_delay_ms;
        let max_delay = config.max_delay_ms;

        Box::pin(async move {
            let mut last_error = None;

            for attempt in 1..=attempts {
                match next().await {
                    Ok(value) => return Ok(value),
                    Err(e) => {
                        if attempt == attempts || cancelled.load(Ordering::Relaxed) {
                            return Err(e);
                        }
                        last_error = Some(e);
                        let delay = calculate_delay(attempt, initial_delay, max_delay);
                        tokio::time::sleep(Duration::from_millis(delay)).await;
                    }
                }
            }

            Err(last_error.unwrap_or_else(|| ExecutionError {
                status: 500,
                message: "Retry exhausted with no error".into(),
            }))
        })
    })
}

/// Exponential backoff with full jitter: `min(initial * 2^(attempt-1), max) * rand()`.
fn calculate_delay(attempt: u32, initial_delay_ms: u64, max_delay_ms: u64) -> u64 {
    use rand::Rng;
    let exp = initial_delay_ms.saturating_mul(1u64 << (attempt - 1).min(30));
    let capped = exp.min(max_delay_ms);
    let jitter: f64 = rand::thread_rng().gen();
    (capped as f64 * jitter) as u64
}

/// Wrap with cache (innermost interceptor).
pub fn wrap_with_cache(
    next: ExecuteFn,
    cache: Arc<CacheManager>,
    cache_key: Vec<String>,
    user_key: String,
    ttl: Option<u64>,
    enabled: bool,
) -> ExecuteFn {
    if !enabled || cache_key.is_empty() {
        return next;
    }

    // Pre-compute the deterministic cache key.
    let refs: Vec<&str> = cache_key.iter().map(|s| s.as_str()).collect();
    let key = CacheManager::generate_key_from_parts(&refs, &user_key);

    Arc::new(move || {
        let next = next.clone();
        let cache = cache.clone();
        let key = key.clone();

        Box::pin(async move {
            cache
                .get_or_execute_internal(
                    key,
                    move || {
                        let fut = next();
                        async move { fut.await.map_err(|e| e.message) }
                    },
                    ttl,
                )
                .await
                .map_err(|msg| ExecutionError {
                    status: 500,
                    message: msg,
                })
        })
    })
}

// ---------------------------------------------------------------------------
// Chain builder
// ---------------------------------------------------------------------------

/// Build the full interceptor chain around `base_fn`.
///
/// Wrapping order (innermost first):
///   Cache → Retry → Timeout → Telemetry
///
/// Each layer is conditionally applied based on the config.
pub fn build_interceptor_chain(
    base_fn: ExecuteFn,
    config: &PluginExecuteConfig,
    context: &InterceptorContext,
    cache: Option<Arc<CacheManager>>,
    telemetry: Option<Arc<TelemetryProvider>>,
) -> ExecuteFn {
    let mut current = base_fn;

    // 1. Innermost: Cache
    if let (Some(cache), Some(ref cc)) = (cache, &config.cache) {
        current = wrap_with_cache(
            current,
            cache,
            cc.cache_key.clone(),
            context.user_key.clone(),
            cc.ttl,
            cc.enabled,
        );
    }

    // 2. Retry
    if let Some(ref rc) = config.retry {
        if rc.enabled {
            current = wrap_with_retry(current, rc.clone(), context.cancelled.clone());
        }
    }

    // 3. Timeout
    if let Some(timeout_ms) = config.timeout_ms {
        current = wrap_with_timeout(current, timeout_ms, context.cancelled.clone());
    }

    // 4. Outermost: Telemetry
    if let Some(telemetry) = telemetry {
        if let Some(ref tc) = config.telemetry {
            if tc.enabled {
                current = wrap_with_telemetry(
                    current,
                    telemetry,
                    tc.span_name
                        .clone()
                        .unwrap_or_else(|| "plugin.execute".into()),
                    tc.attributes.clone(),
                    context.cancelled.clone(),
                );
            }
        }
    }

    current
}

// ---------------------------------------------------------------------------
// Stream interceptors
// ---------------------------------------------------------------------------

/// Item type for streaming through interceptors.
/// Each item is either a JSON string payload or an execution error.
pub type StreamItem = Result<String, ExecutionError>;

/// Wrap a stream with a timeout on the full stream lifetime.
/// Sends a final timeout error if the deadline is exceeded.
pub fn wrap_stream_with_timeout(
    mut rx: mpsc::Receiver<StreamItem>,
    timeout_ms: u64,
) -> mpsc::Receiver<StreamItem> {
    let (tx, out_rx) = mpsc::channel(32);
    tokio::spawn(async move {
        let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout_ms);
        loop {
            tokio::select! {
                item = rx.recv() => {
                    match item {
                        Some(val) => {
                            if tx.send(val).await.is_err() { break; }
                        }
                        None => break,
                    }
                }
                _ = tokio::time::sleep_until(deadline) => {
                    let _ = tx.send(Err(ExecutionError {
                        status: 408,
                        message: format!("Stream timed out after {timeout_ms} ms"),
                    })).await;
                    break;
                }
            }
        }
    });
    out_rx
}

/// Wrap a stream with telemetry: a span covers the full stream lifetime.
/// The span is started immediately and ended when the stream completes or errors.
pub fn wrap_stream_with_telemetry(
    mut rx: mpsc::Receiver<StreamItem>,
    telemetry: Arc<TelemetryProvider>,
    span_name: String,
    attributes: Vec<(String, String)>,
) -> mpsc::Receiver<StreamItem> {
    if !telemetry.traces_enabled() {
        return rx;
    }

    let (tx, out_rx) = mpsc::channel(32);
    tokio::spawn(async move {
        use opentelemetry::trace::{Span, Status, Tracer};
        let tracer = telemetry.tracer();
        let mut span = tracer.start(span_name);
        for (k, v) in &attributes {
            span.set_attribute(opentelemetry::KeyValue::new(k.clone(), v.clone()));
        }

        let mut had_error = false;
        while let Some(item) = rx.recv().await {
            if let Err(ref e) = item {
                span.set_status(Status::error(e.message.clone()));
                had_error = true;
            }
            if tx.send(item).await.is_err() {
                break;
            }
        }

        if !had_error {
            span.set_status(Status::Ok);
        }
        span.end();
    });
    out_rx
}

/// Build the stream interceptor chain.
///
/// For streams, only telemetry and timeout are applied:
/// - **Timeout** (inner) — caps the total stream lifetime
/// - **Telemetry** (outer) — spans the full stream lifetime
/// - **Retry/Cache** are intentionally skipped (streams are non-repeatable)
pub fn build_stream_interceptor_chain(
    rx: mpsc::Receiver<StreamItem>,
    config: &PluginExecuteConfig,
    telemetry: Option<Arc<TelemetryProvider>>,
) -> mpsc::Receiver<StreamItem> {
    let mut current = rx;

    // 1. Timeout (inner — fires first)
    if let Some(timeout_ms) = config.timeout_ms {
        current = wrap_stream_with_timeout(current, timeout_ms);
    }

    // 2. Telemetry (outer — spans the full lifetime including timeout)
    if let Some(telemetry) = telemetry {
        if let Some(ref tc) = config.telemetry {
            if tc.enabled {
                current = wrap_stream_with_telemetry(
                    current,
                    telemetry,
                    tc.span_name
                        .clone()
                        .unwrap_or_else(|| "plugin.execute_stream".into()),
                    tc.attributes.clone(),
                );
            }
        }
    }

    current
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn ok_fn(value: JsonValue) -> ExecuteFn {
        Arc::new(move || {
            let v = value.clone();
            Box::pin(async move { Ok(v) })
        })
    }

    fn err_fn(status: u16, msg: &str) -> ExecuteFn {
        let msg = msg.to_string();
        Arc::new(move || {
            let msg = msg.clone();
            Box::pin(async move {
                Err(ExecutionError {
                    status,
                    message: msg,
                })
            })
        })
    }

    fn counting_fn(
        counter: Arc<std::sync::atomic::AtomicU32>,
        value: JsonValue,
    ) -> ExecuteFn {
        Arc::new(move || {
            let counter = counter.clone();
            let v = value.clone();
            Box::pin(async move {
                counter.fetch_add(1, Ordering::SeqCst);
                Ok(v)
            })
        })
    }

    fn make_context(user_key: &str) -> InterceptorContext {
        InterceptorContext {
            user_key: user_key.to_string(),
            cancelled: Arc::new(AtomicBool::new(false)),
            metadata: HashMap::new(),
        }
    }

    #[tokio::test]
    async fn test_no_interceptors_passthrough() {
        let f = ok_fn(JsonValue::String("hello".into()));
        let ctx = make_context("u1");
        let config = PluginExecuteConfig::default();
        let chain = build_interceptor_chain(f, &config, &ctx, None, None);
        let result = chain().await.unwrap();
        assert_eq!(result, JsonValue::String("hello".into()));
    }

    #[tokio::test]
    async fn test_timeout_passes_when_fast() {
        let f = ok_fn(JsonValue::Bool(true));
        let cancelled = Arc::new(AtomicBool::new(false));
        let wrapped = wrap_with_timeout(f, 5000, cancelled);
        let result = wrapped().await.unwrap();
        assert_eq!(result, JsonValue::Bool(true));
    }

    #[tokio::test]
    async fn test_timeout_fires() {
        let slow_fn: ExecuteFn = Arc::new(|| {
            Box::pin(async {
                tokio::time::sleep(Duration::from_secs(10)).await;
                Ok(JsonValue::Null)
            })
        });
        let cancelled = Arc::new(AtomicBool::new(false));
        let wrapped = wrap_with_timeout(slow_fn, 50, cancelled.clone());
        let result = wrapped().await;
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert_eq!(err.status, 408);
        assert!(cancelled.load(Ordering::Relaxed));
    }

    #[tokio::test]
    async fn test_retry_succeeds_on_first_attempt() {
        let counter = Arc::new(std::sync::atomic::AtomicU32::new(0));
        let f = counting_fn(counter.clone(), JsonValue::Number(42.into()));
        let cancelled = Arc::new(AtomicBool::new(false));
        let config = RetryConfig {
            enabled: true,
            attempts: 3,
            initial_delay_ms: 10,
            max_delay_ms: 100,
        };
        let wrapped = wrap_with_retry(f, config, cancelled);
        let result = wrapped().await.unwrap();
        assert_eq!(result, JsonValue::Number(42.into()));
        assert_eq!(counter.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn test_retry_retries_on_failure() {
        let attempt = Arc::new(std::sync::atomic::AtomicU32::new(0));
        let attempt_c = attempt.clone();
        let f: ExecuteFn = Arc::new(move || {
            let attempt = attempt_c.clone();
            Box::pin(async move {
                let n = attempt.fetch_add(1, Ordering::SeqCst);
                if n < 2 {
                    Err(ExecutionError {
                        status: 500,
                        message: "transient".into(),
                    })
                } else {
                    Ok(JsonValue::String("recovered".into()))
                }
            })
        });
        let config = RetryConfig {
            enabled: true,
            attempts: 5,
            initial_delay_ms: 1,
            max_delay_ms: 10,
        };
        let cancelled = Arc::new(AtomicBool::new(false));
        let wrapped = wrap_with_retry(f, config, cancelled);
        let result = wrapped().await.unwrap();
        assert_eq!(result, JsonValue::String("recovered".into()));
        assert_eq!(attempt.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn test_retry_exhausted() {
        let f = err_fn(503, "down");
        let config = RetryConfig {
            enabled: true,
            attempts: 2,
            initial_delay_ms: 1,
            max_delay_ms: 10,
        };
        let cancelled = Arc::new(AtomicBool::new(false));
        let wrapped = wrap_with_retry(f, config, cancelled);
        let result = wrapped().await;
        assert!(result.is_err());
        assert_eq!(result.unwrap_err().status, 503);
    }

    #[tokio::test]
    async fn test_retry_skips_when_cancelled() {
        let counter = Arc::new(std::sync::atomic::AtomicU32::new(0));
        let counter_c = counter.clone();
        let f: ExecuteFn = Arc::new(move || {
            let counter = counter_c.clone();
            Box::pin(async move {
                counter.fetch_add(1, Ordering::SeqCst);
                Err(ExecutionError {
                    status: 500,
                    message: "fail".into(),
                })
            })
        });
        let cancelled = Arc::new(AtomicBool::new(true)); // pre-cancelled
        let config = RetryConfig {
            enabled: true,
            attempts: 5,
            initial_delay_ms: 1,
            max_delay_ms: 10,
        };
        let wrapped = wrap_with_retry(f, config, cancelled);
        let result = wrapped().await;
        assert!(result.is_err());
        // Should stop after first attempt because cancelled
        assert_eq!(counter.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn test_full_chain_cache_then_retry() {
        let cache = Arc::new(CacheManager::new_internal(
            crate::cache::CacheConfig::default(),
        ));
        let counter = Arc::new(std::sync::atomic::AtomicU32::new(0));
        let counter_c = counter.clone();
        let f: ExecuteFn = Arc::new(move || {
            let counter = counter_c.clone();
            Box::pin(async move {
                counter.fetch_add(1, Ordering::SeqCst);
                Ok(JsonValue::String("computed".into()))
            })
        });

        let ctx = make_context("user-1");
        let config = PluginExecuteConfig {
            cache: Some(CacheInterceptorConfig {
                enabled: true,
                cache_key: vec!["query".into()],
                ttl: Some(60),
            }),
            retry: Some(RetryConfig {
                enabled: true,
                attempts: 3,
                initial_delay_ms: 1,
                max_delay_ms: 10,
            }),
            ..Default::default()
        };

        let chain = build_interceptor_chain(f, &config, &ctx, Some(cache), None);

        // First call computes
        let r1 = chain().await.unwrap();
        assert_eq!(r1, JsonValue::String("computed".into()));
        assert_eq!(counter.load(Ordering::SeqCst), 1);

        // Second call hits cache — function not called again
        let r2 = chain().await.unwrap();
        assert_eq!(r2, JsonValue::String("computed".into()));
        assert_eq!(counter.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn test_calculate_delay_bounded() {
        for _ in 0..100 {
            let d = calculate_delay(1, 1000, 30_000);
            assert!(d <= 1000);
            let d = calculate_delay(5, 1000, 30_000);
            assert!(d <= 30_000);
        }
    }

    #[tokio::test]
    async fn test_telemetry_disabled_passthrough() {
        let f = ok_fn(JsonValue::Number(7.into()));
        let provider = Arc::new(TelemetryProvider::new_disabled("test"));
        let cancelled = Arc::new(AtomicBool::new(false));
        let wrapped = wrap_with_telemetry(f, provider, "span".into(), vec![], cancelled);
        let result = wrapped().await.unwrap();
        assert_eq!(result, JsonValue::Number(7.into()));
    }

    // -- Stream interceptors --

    #[tokio::test]
    async fn test_stream_timeout_fires() {
        let (tx, rx) = mpsc::channel(32);
        let mut wrapped = wrap_stream_with_timeout(rx, 50);

        // Keep tx alive but don't send — timeout should fire.
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(10)).await;
            drop(tx);
        });

        let item = wrapped.recv().await.unwrap();
        assert!(item.is_err());
        assert_eq!(item.unwrap_err().status, 408);
    }

    #[tokio::test]
    async fn test_stream_timeout_passes_when_fast() {
        let (tx, rx) = mpsc::channel(32);
        let mut wrapped = wrap_stream_with_timeout(rx, 5000);

        tx.send(Ok("hello".into())).await.unwrap();
        drop(tx);

        let item = wrapped.recv().await.unwrap();
        assert_eq!(item.unwrap(), "hello");
        assert!(wrapped.recv().await.is_none());
    }

    #[tokio::test]
    async fn test_stream_telemetry_disabled_passthrough() {
        let provider = Arc::new(TelemetryProvider::new_disabled("test"));
        let (tx, rx) = mpsc::channel(32);
        let mut wrapped = wrap_stream_with_telemetry(rx, provider, "test".into(), vec![]);

        tx.send(Ok("data".into())).await.unwrap();
        drop(tx);

        let item = wrapped.recv().await.unwrap();
        assert_eq!(item.unwrap(), "data");
        assert!(wrapped.recv().await.is_none());
    }

    #[tokio::test]
    async fn test_build_stream_chain_no_config() {
        let (tx, rx) = mpsc::channel(32);
        let config = PluginExecuteConfig::default();
        let mut wrapped = build_stream_interceptor_chain(rx, &config, None);

        tx.send(Ok("item".into())).await.unwrap();
        drop(tx);

        let item = wrapped.recv().await.unwrap();
        assert_eq!(item.unwrap(), "item");
    }
}
