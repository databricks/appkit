use pyo3::prelude::*;
use serde_json::Value as JsonValue;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::{watch, Mutex};

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/// Cache configuration with defaults matching TypeScript `cacheDefaults`.
#[derive(Clone, Debug)]
#[pyclass(frozen, module = "appkit")]
pub struct CacheConfig {
    #[pyo3(get)]
    pub enabled: bool,
    #[pyo3(get)]
    pub ttl: u64,
    #[pyo3(get)]
    pub max_size: usize,
    #[pyo3(get)]
    pub cleanup_probability: f64,
}

#[pymethods]
impl CacheConfig {
    #[new]
    #[pyo3(signature = (*, enabled = true, ttl = 3600, max_size = 1000, cleanup_probability = 0.01))]
    pub fn new(enabled: bool, ttl: u64, max_size: usize, cleanup_probability: f64) -> Self {
        Self {
            enabled,
            ttl,
            max_size,
            cleanup_probability,
        }
    }

    fn __repr__(&self) -> String {
        format!(
            "CacheConfig(enabled={}, ttl={}, max_size={}, cleanup_probability={})",
            self.enabled, self.ttl, self.max_size, self.cleanup_probability
        )
    }

    fn __eq__(&self, other: &Self) -> bool {
        self.enabled == other.enabled
            && self.ttl == other.ttl
            && self.max_size == other.max_size
            && self.cleanup_probability == other.cleanup_probability
    }

    fn __hash__(&self) -> u64 {
        use std::hash::{Hash, Hasher};
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        self.enabled.hash(&mut hasher);
        self.ttl.hash(&mut hasher);
        self.max_size.hash(&mut hasher);
        hasher.finish()
    }
}

impl Default for CacheConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            ttl: 3600,
            max_size: 1000,
            cleanup_probability: 0.01,
        }
    }
}

// ---------------------------------------------------------------------------
// Internal storage
// ---------------------------------------------------------------------------

struct CacheEntry {
    value: JsonValue,
    expiry: u64, // milliseconds since epoch
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock before unix epoch")
        .as_millis() as u64
}

/// Probabilistic check using a randomly-seeded hasher.
fn rand_check(probability: f64) -> bool {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    let mut hasher = RandomState::new().build_hasher();
    hasher.write_u8(0);
    let hash = hasher.finish();
    (hash as f64 / u64::MAX as f64) < probability
}

/// In-memory LRU cache storage with bounded capacity.
/// Matches the semantics of the TypeScript `InMemoryStorage`.
struct InMemoryStorage {
    cache: HashMap<String, CacheEntry>,
    access_order: HashMap<String, u64>,
    access_counter: u64,
    max_size: usize,
}

impl InMemoryStorage {
    fn new(max_size: usize) -> Self {
        Self {
            cache: HashMap::new(),
            access_order: HashMap::new(),
            access_counter: 0,
            max_size,
        }
    }

    fn get(&mut self, key: &str) -> Option<&CacheEntry> {
        let expired = self
            .cache
            .get(key)
            .map(|e| now_millis() > e.expiry)
            .unwrap_or(true);

        if expired {
            self.cache.remove(key);
            self.access_order.remove(key);
            return None;
        }

        self.access_counter += 1;
        self.access_order
            .insert(key.to_string(), self.access_counter);
        self.cache.get(key)
    }

    fn set(&mut self, key: String, entry: CacheEntry) {
        if self.cache.len() >= self.max_size && !self.cache.contains_key(&key) {
            self.evict_lru();
        }
        self.access_counter += 1;
        self.access_order.insert(key.clone(), self.access_counter);
        self.cache.insert(key, entry);
    }

    fn delete(&mut self, key: &str) {
        self.cache.remove(key);
        self.access_order.remove(key);
    }

    fn has(&mut self, key: &str) -> bool {
        if let Some(entry) = self.cache.get(key) {
            if now_millis() > entry.expiry {
                let key = key.to_string();
                self.cache.remove(&key);
                self.access_order.remove(&key);
                return false;
            }
            true
        } else {
            false
        }
    }

    fn clear(&mut self) {
        self.cache.clear();
        self.access_order.clear();
        self.access_counter = 0;
    }

    fn size(&self) -> usize {
        self.cache.len()
    }

    fn cleanup_expired(&mut self) {
        let now = now_millis();
        let expired_keys: Vec<String> = self
            .cache
            .iter()
            .filter(|(_, entry)| now > entry.expiry)
            .map(|(key, _)| key.clone())
            .collect();
        for key in expired_keys {
            self.cache.remove(&key);
            self.access_order.remove(&key);
        }
    }

    fn evict_lru(&mut self) {
        if let Some((key, _)) = self
            .access_order
            .iter()
            .min_by_key(|(_, &counter)| counter)
            .map(|(k, v)| (k.clone(), *v))
        {
            self.cache.remove(&key);
            self.access_order.remove(&key);
        }
    }
}

// ---------------------------------------------------------------------------
// Cache manager (Rust-internal + PyO3)
// ---------------------------------------------------------------------------

type InFlightValue = Option<Result<JsonValue, String>>;

/// Cache manager with TTL, LRU eviction, concurrent in-flight deduplication,
/// and probabilistic cleanup.
///
/// Mirrors the TypeScript `CacheManager` with `InMemoryStorage`.
#[pyclass(module = "appkit")]
pub struct CacheManager {
    storage: Arc<Mutex<InMemoryStorage>>,
    config: CacheConfig,
    in_flight: Arc<Mutex<HashMap<String, watch::Sender<InFlightValue>>>>,
}

impl CacheManager {
    /// Create a CacheManager from Rust code (not via Python).
    pub fn new_internal(config: CacheConfig) -> Self {
        let max_size = config.max_size;
        Self {
            storage: Arc::new(Mutex::new(InMemoryStorage::new(max_size))),
            config,
            in_flight: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Generate a SHA256 cache key from composite parts.
    /// Matches the TypeScript `generateKey` which hashes `[userKey, ...parts]`.
    pub fn generate_key_from_parts(parts: &[&str], user_key: &str) -> String {
        let mut components: Vec<&str> = vec![user_key];
        components.extend_from_slice(parts);
        let serialized = serde_json::to_string(&components).unwrap_or_default();
        let hash = Sha256::digest(serialized.as_bytes());
        hash.iter().map(|b| format!("{b:02x}")).collect()
    }

    async fn maybe_cleanup(&self) {
        if rand_check(self.config.cleanup_probability) {
            let mut storage = self.storage.lock().await;
            storage.cleanup_expired();
        }
    }

    /// Core get_or_execute with in-flight deduplication (Rust-internal API).
    ///
    /// If a value for `key` is cached, returns it immediately.
    /// If another task is already computing the same key, waits for its result.
    /// Otherwise executes `func` and caches the result.
    pub async fn get_or_execute_internal<F, Fut>(
        &self,
        key: String,
        func: F,
        ttl: Option<u64>,
    ) -> Result<JsonValue, String>
    where
        F: FnOnce() -> Fut + Send,
        Fut: std::future::Future<Output = Result<JsonValue, String>> + Send,
    {
        if !self.config.enabled {
            return func().await;
        }

        // Check cache
        {
            let mut storage = self.storage.lock().await;
            if let Some(entry) = storage.get(&key) {
                return Ok(entry.value.clone());
            }
        }

        // Try to join an existing in-flight request, or become the executor.
        enum Action {
            Wait(watch::Receiver<InFlightValue>),
            Execute(watch::Sender<InFlightValue>),
        }

        let action = {
            let mut in_flight = self.in_flight.lock().await;
            if let Some(existing_tx) = in_flight.get(&key) {
                Action::Wait(existing_tx.subscribe())
            } else {
                let (tx, _rx) = watch::channel(None);
                in_flight.insert(key.clone(), tx.clone());
                Action::Execute(tx)
            }
        };

        match action {
            Action::Wait(mut rx) => {
                // Wait for the executor to broadcast its result.
                loop {
                    {
                        let val = rx.borrow().clone();
                        if let Some(result) = val {
                            return result;
                        }
                    }
                    if rx.changed().await.is_err() {
                        // Executor dropped without sending — execute ourselves as fallback.
                        return func().await;
                    }
                }
            }
            Action::Execute(tx) => {
                let result = func().await;

                // Cache successful results
                if let Ok(ref value) = result {
                    let ttl_secs = ttl.unwrap_or(self.config.ttl);
                    let expiry = now_millis() + ttl_secs * 1000;
                    let mut storage = self.storage.lock().await;
                    storage.set(
                        key.clone(),
                        CacheEntry {
                            value: value.clone(),
                            expiry,
                        },
                    );
                }

                // Broadcast result to waiting tasks
                let _ = tx.send(Some(result.clone()));

                // Remove from in-flight map
                {
                    let mut in_flight = self.in_flight.lock().await;
                    in_flight.remove(&key);
                }

                self.maybe_cleanup().await;
                result
            }
        }
    }

    // Rust-only convenience wrappers used by Rust callers (connectors, etc.)

    pub async fn get_internal(&self, key: &str) -> Option<JsonValue> {
        let mut storage = self.storage.lock().await;
        storage.get(key).map(|e| e.value.clone())
    }

    pub async fn set_internal(&self, key: String, value: JsonValue, ttl: Option<u64>) {
        let ttl_secs = ttl.unwrap_or(self.config.ttl);
        let expiry = now_millis() + ttl_secs * 1000;
        let mut storage = self.storage.lock().await;
        storage.set(key, CacheEntry { value, expiry });
    }

    pub async fn delete_internal(&self, key: &str) {
        let mut storage = self.storage.lock().await;
        storage.delete(key);
    }

    pub async fn has_internal(&self, key: &str) -> bool {
        let mut storage = self.storage.lock().await;
        storage.has(key)
    }

    pub async fn clear_internal(&self) {
        let mut storage = self.storage.lock().await;
        storage.clear();
    }

    pub async fn size_internal(&self) -> usize {
        let storage = self.storage.lock().await;
        storage.size()
    }
}

// ---------------------------------------------------------------------------
// Python bindings
// ---------------------------------------------------------------------------

#[pymethods]
impl CacheManager {
    #[new]
    #[pyo3(signature = (config = None))]
    fn new(config: Option<CacheConfig>) -> Self {
        let config = config.unwrap_or_default();
        let max_size = config.max_size;
        Self {
            storage: Arc::new(Mutex::new(InMemoryStorage::new(max_size))),
            config,
            in_flight: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Generate a SHA256 cache key from parts and user key.
    #[staticmethod]
    #[pyo3(signature = (parts, user_key))]
    fn generate_key(parts: Vec<String>, user_key: String) -> String {
        let refs: Vec<&str> = parts.iter().map(|s| s.as_str()).collect();
        Self::generate_key_from_parts(&refs, &user_key)
    }

    /// Get a cached value by key. Returns a JSON string or None.
    fn get<'py>(&self, py: Python<'py>, key: String) -> PyResult<Bound<'py, PyAny>> {
        let storage = self.storage.clone();
        let cleanup_prob = self.config.cleanup_probability;
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let mut guard = storage.lock().await;
            let result = guard.get(&key).map(|e| e.value.to_string());
            if rand_check(cleanup_prob) {
                guard.cleanup_expired();
            }
            Ok(result)
        })
    }

    /// Store a value (JSON string) with optional TTL in seconds.
    #[pyo3(signature = (key, value, *, ttl = None))]
    fn set<'py>(
        &self,
        py: Python<'py>,
        key: String,
        value: String,
        ttl: Option<u64>,
    ) -> PyResult<Bound<'py, PyAny>> {
        let storage = self.storage.clone();
        let default_ttl = self.config.ttl;
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let ttl_secs = ttl.unwrap_or(default_ttl);
            let expiry = now_millis() + ttl_secs * 1000;
            let json_value: JsonValue =
                serde_json::from_str(&value).unwrap_or(JsonValue::String(value));
            let mut guard = storage.lock().await;
            guard.set(key, CacheEntry { value: json_value, expiry });
            Ok(())
        })
    }

    /// Delete a cached entry by key.
    fn delete<'py>(&self, py: Python<'py>, key: String) -> PyResult<Bound<'py, PyAny>> {
        let storage = self.storage.clone();
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let mut guard = storage.lock().await;
            guard.delete(&key);
            Ok(())
        })
    }

    /// Check if a key exists and is not expired.
    fn has<'py>(&self, py: Python<'py>, key: String) -> PyResult<Bound<'py, PyAny>> {
        let storage = self.storage.clone();
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let mut guard = storage.lock().await;
            Ok(guard.has(&key))
        })
    }

    /// Clear all cached entries.
    fn clear<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyAny>> {
        let storage = self.storage.clone();
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let mut guard = storage.lock().await;
            guard.clear();
            Ok(())
        })
    }

    /// Return the number of cached entries.
    fn size<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyAny>> {
        let storage = self.storage.clone();
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let guard = storage.lock().await;
            Ok(guard.size())
        })
    }

    /// Execute a Python async callable with caching.
    ///
    /// The callable must be an async function (coroutine function) that returns
    /// a JSON string. On cache hit the callable is not invoked.
    #[pyo3(signature = (key, func, *, ttl = None))]
    fn get_or_execute<'py>(
        &self,
        py: Python<'py>,
        key: String,
        func: PyObject,
        ttl: Option<u64>,
    ) -> PyResult<Bound<'py, PyAny>> {
        let storage = self.storage.clone();
        let in_flight = self.in_flight.clone();
        let config = self.config.clone();

        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            if !config.enabled {
                let future = Python::with_gil(|py| {
                    let coroutine = func.call0(py)?;
                    pyo3_async_runtimes::tokio::into_future(coroutine.into_bound(py))
                })?;
                let result = future.await?;
                return Python::with_gil(|py| result.extract::<String>(py));
            }

            // Check cache
            {
                let mut guard = storage.lock().await;
                if let Some(entry) = guard.get(&key) {
                    return Ok(entry.value.to_string());
                }
            }

            // Check for existing in-flight request or register as executor.
            enum Action {
                Wait(watch::Receiver<InFlightValue>),
                Execute(watch::Sender<InFlightValue>),
            }

            let action = {
                let mut in_flight_guard = in_flight.lock().await;
                if let Some(existing_tx) = in_flight_guard.get(&key) {
                    Action::Wait(existing_tx.subscribe())
                } else {
                    let (tx, _rx) = watch::channel(None);
                    in_flight_guard.insert(key.clone(), tx.clone());
                    Action::Execute(tx)
                }
            };

            match action {
                Action::Wait(mut rx) => {
                    loop {
                        {
                            let val = rx.borrow().clone();
                            if let Some(result) = val {
                                return result
                                    .map(|v| v.to_string())
                                    .map_err(pyo3::exceptions::PyRuntimeError::new_err);
                            }
                        }
                        if rx.changed().await.is_err() {
                            // Executor dropped — fall back to calling the function ourselves.
                            let future = Python::with_gil(|py| {
                                let coroutine = func.call0(py)?;
                                pyo3_async_runtimes::tokio::into_future(coroutine.into_bound(py))
                            })?;
                            let result = future.await?;
                            return Python::with_gil(|py| result.extract::<String>(py));
                        }
                    }
                }
                Action::Execute(tx) => {
                    // Call the Python async function.
                    let py_result: PyResult<String> = async {
                        let future = Python::with_gil(|py| {
                            let coroutine = func.call0(py)?;
                            pyo3_async_runtimes::tokio::into_future(coroutine.into_bound(py))
                        })?;
                        let result = future.await?;
                        Python::with_gil(|py| result.extract::<String>(py))
                    }
                    .await;

                    // Convert to cache-compatible result.
                    let cache_result: Result<JsonValue, String> = match &py_result {
                        Ok(s) => Ok(serde_json::from_str(s)
                            .unwrap_or(JsonValue::String(s.clone()))),
                        Err(e) => Err(e.to_string()),
                    };

                    // Cache successful results.
                    if let Ok(ref value) = cache_result {
                        let ttl_secs = ttl.unwrap_or(config.ttl);
                        let expiry = now_millis() + ttl_secs * 1000;
                        let mut guard = storage.lock().await;
                        guard.set(
                            key.clone(),
                            CacheEntry {
                                value: value.clone(),
                                expiry,
                            },
                        );
                    }

                    // Broadcast result and clean up.
                    let _ = tx.send(Some(cache_result));
                    {
                        let mut in_flight_guard = in_flight.lock().await;
                        in_flight_guard.remove(&key);
                    }
                    if rand_check(config.cleanup_probability) {
                        let mut guard = storage.lock().await;
                        guard.cleanup_expired();
                    }

                    py_result
                }
            }
        })
    }

    fn __repr__(&self) -> String {
        format!(
            "CacheManager(enabled={}, ttl={}, max_size={})",
            self.config.enabled, self.config.ttl, self.config.max_size
        )
    }

    fn __bool__(&self) -> bool {
        self.config.enabled
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn make_cache(max_size: usize) -> CacheManager {
        CacheManager {
            storage: Arc::new(Mutex::new(InMemoryStorage::new(max_size))),
            config: CacheConfig {
                enabled: true,
                ttl: 60,
                max_size,
                cleanup_probability: 0.0, // deterministic tests
            },
            in_flight: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    #[test]
    fn test_generate_key_deterministic() {
        let a = CacheManager::generate_key_from_parts(&["q1", "p1"], "user-1");
        let b = CacheManager::generate_key_from_parts(&["q1", "p1"], "user-1");
        assert_eq!(a, b);
        assert_eq!(a.len(), 64); // SHA256 hex
    }

    #[test]
    fn test_generate_key_varies_by_user() {
        let a = CacheManager::generate_key_from_parts(&["q"], "alice");
        let b = CacheManager::generate_key_from_parts(&["q"], "bob");
        assert_ne!(a, b);
    }

    #[tokio::test]
    async fn test_set_and_get() {
        let cache = make_cache(10);
        cache
            .set_internal("k1".into(), JsonValue::String("hello".into()), None)
            .await;
        let val = cache.get_internal("k1").await;
        assert_eq!(val, Some(JsonValue::String("hello".into())));
    }

    #[tokio::test]
    async fn test_get_miss() {
        let cache = make_cache(10);
        assert!(cache.get_internal("nope").await.is_none());
    }

    #[tokio::test]
    async fn test_delete() {
        let cache = make_cache(10);
        cache
            .set_internal("k".into(), JsonValue::Bool(true), None)
            .await;
        assert!(cache.has_internal("k").await);
        cache.delete_internal("k").await;
        assert!(!cache.has_internal("k").await);
    }

    #[tokio::test]
    async fn test_clear() {
        let cache = make_cache(10);
        for i in 0..5 {
            cache
                .set_internal(format!("k{i}"), JsonValue::Null, None)
                .await;
        }
        assert_eq!(cache.size_internal().await, 5);
        cache.clear_internal().await;
        assert_eq!(cache.size_internal().await, 0);
    }

    #[tokio::test]
    async fn test_ttl_expiry() {
        let cache = make_cache(10);
        // Set with 0-second TTL → immediately expired
        cache
            .set_internal("k".into(), JsonValue::String("v".into()), Some(0))
            .await;
        // The entry's expiry is now_millis() + 0, so it should be expired on next get
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        assert!(cache.get_internal("k").await.is_none());
    }

    #[tokio::test]
    async fn test_lru_eviction() {
        let cache = make_cache(3);
        cache
            .set_internal("a".into(), JsonValue::String("1".into()), None)
            .await;
        cache
            .set_internal("b".into(), JsonValue::String("2".into()), None)
            .await;
        cache
            .set_internal("c".into(), JsonValue::String("3".into()), None)
            .await;

        // Access "a" to make it recently used
        cache.get_internal("a").await;

        // Insert "d" — should evict "b" (least recently used)
        cache
            .set_internal("d".into(), JsonValue::String("4".into()), None)
            .await;

        assert!(cache.has_internal("a").await);
        assert!(!cache.has_internal("b").await);
        assert!(cache.has_internal("c").await);
        assert!(cache.has_internal("d").await);
    }

    #[tokio::test]
    async fn test_get_or_execute_caches() {
        let cache = make_cache(10);
        let call_count = Arc::new(std::sync::atomic::AtomicU32::new(0));

        let cc = call_count.clone();
        let v1 = cache
            .get_or_execute_internal(
                "key1".into(),
                move || {
                    cc.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    async { Ok(JsonValue::Number(42.into())) }
                },
                None,
            )
            .await
            .unwrap();
        assert_eq!(v1, JsonValue::Number(42.into()));
        assert_eq!(call_count.load(std::sync::atomic::Ordering::SeqCst), 1);

        // Second call with same key should use cache — func not called
        let cc = call_count.clone();
        let v2 = cache
            .get_or_execute_internal(
                "key1".into(),
                move || {
                    cc.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    async { Ok(JsonValue::Null) }
                },
                None,
            )
            .await
            .unwrap();
        assert_eq!(v2, JsonValue::Number(42.into()));
        assert_eq!(call_count.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn test_get_or_execute_dedup() {
        let cache = Arc::new(make_cache(10));
        let call_count = Arc::new(std::sync::atomic::AtomicU32::new(0));

        let mut handles = Vec::new();
        for _ in 0..5 {
            let c = cache.clone();
            let cc = call_count.clone();
            handles.push(tokio::spawn(async move {
                c.get_or_execute_internal(
                    "shared".into(),
                    move || {
                        cc.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                        async {
                            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                            Ok(JsonValue::String("done".into()))
                        }
                    },
                    None,
                )
                .await
            }));
        }

        for handle in handles {
            let r = handle.await.unwrap().unwrap();
            assert_eq!(r, JsonValue::String("done".into()));
        }

        // The function should have been called at most twice (first executor +
        // possible fallback race), but never 5 times.
        let count = call_count.load(std::sync::atomic::Ordering::SeqCst);
        assert!(count <= 2, "expected dedup, got {count} calls");
    }

    #[tokio::test]
    async fn test_disabled_cache_always_executes() {
        let cache = CacheManager {
            storage: Arc::new(Mutex::new(InMemoryStorage::new(10))),
            config: CacheConfig {
                enabled: false,
                ..CacheConfig::default()
            },
            in_flight: Arc::new(Mutex::new(HashMap::new())),
        };

        let v = cache
            .get_or_execute_internal(
                "k".into(),
                || async { Ok(JsonValue::String("computed".into())) },
                None,
            )
            .await
            .unwrap();
        assert_eq!(v, JsonValue::String("computed".into()));
        // Nothing cached when disabled
        assert!(cache.get_internal("k").await.is_none());
    }

    #[test]
    fn test_cleanup_expired() {
        let mut storage = InMemoryStorage::new(100);
        let past = now_millis().saturating_sub(1000);
        storage.set(
            "expired".into(),
            CacheEntry {
                value: JsonValue::Null,
                expiry: past,
            },
        );
        storage.set(
            "valid".into(),
            CacheEntry {
                value: JsonValue::Null,
                expiry: now_millis() + 60_000,
            },
        );
        assert_eq!(storage.size(), 2);
        storage.cleanup_expired();
        assert_eq!(storage.size(), 1);
        assert!(storage.cache.contains_key("valid"));
    }
}
