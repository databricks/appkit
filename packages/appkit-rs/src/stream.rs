//! SSE stream manager — event ring buffer, stream lifecycle, reconnection,
//! heartbeat, and multi-client broadcasting.
//!
//! Ports `packages/appkit/src/stream/stream-manager.ts` and
//! `packages/appkit/src/stream/buffers.ts`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::{broadcast, mpsc, Mutex, RwLock};

// ---------------------------------------------------------------------------
// Ring buffer
// ---------------------------------------------------------------------------

/// Generic fixed-capacity ring buffer with key-based O(1) lookup.
/// Matches the TypeScript `RingBuffer` in `buffers.ts`.
pub struct RingBuffer<T: Clone> {
    buffer: Vec<Option<T>>,
    capacity: usize,
    write_index: usize,
    size: usize,
    key_index: HashMap<String, usize>,
    key_fn: Box<dyn Fn(&T) -> String + Send + Sync>,
}

impl<T: Clone> RingBuffer<T> {
    pub fn new(capacity: usize, key_fn: impl Fn(&T) -> String + Send + Sync + 'static) -> Self {
        assert!(capacity > 0, "capacity must be > 0");
        Self {
            buffer: (0..capacity).map(|_| None).collect(),
            capacity,
            write_index: 0,
            size: 0,
            key_index: HashMap::new(),
            key_fn: Box::new(key_fn),
        }
    }

    /// Insert an item. If the key already exists, update in place.
    /// Otherwise, write at the current position (evicting the oldest if full).
    pub fn add(&mut self, item: T) {
        let key = (self.key_fn)(&item);

        // Update in-place if key already exists.
        if let Some(&idx) = self.key_index.get(&key) {
            self.buffer[idx] = Some(item);
            return;
        }

        // Evict old occupant at write position.
        if let Some(ref old) = self.buffer[self.write_index] {
            let old_key = (self.key_fn)(old);
            self.key_index.remove(&old_key);
        }

        self.key_index.insert(key, self.write_index);
        self.buffer[self.write_index] = Some(item);
        self.write_index = (self.write_index + 1) % self.capacity;
        if self.size < self.capacity {
            self.size += 1;
        }
    }

    pub fn get(&self, key: &str) -> Option<&T> {
        self.key_index.get(key).and_then(|&i| self.buffer[i].as_ref())
    }

    pub fn has(&self, key: &str) -> bool {
        self.key_index.contains_key(key)
    }

    /// All items in insertion order (oldest first).
    pub fn get_all(&self) -> Vec<&T> {
        (0..self.size)
            .filter_map(|i| {
                let idx = (self.write_index + self.capacity - self.size + i) % self.capacity;
                self.buffer[idx].as_ref()
            })
            .collect()
    }

    pub fn clear(&mut self) {
        self.buffer.iter_mut().for_each(|s| *s = None);
        self.key_index.clear();
        self.write_index = 0;
        self.size = 0;
    }

    pub fn len(&self) -> usize {
        self.size
    }

    pub fn is_empty(&self) -> bool {
        self.size == 0
    }
}

// ---------------------------------------------------------------------------
// Buffered event
// ---------------------------------------------------------------------------

/// An event stored in the ring buffer for replay on reconnection.
#[derive(Clone, Debug)]
pub struct BufferedEvent {
    pub id: String,
    pub event_type: Option<String>,
    pub data: String,
    pub timestamp: Instant,
}

// ---------------------------------------------------------------------------
// Event ring buffer
// ---------------------------------------------------------------------------

/// Event-specific ring buffer. Default capacity: 100 (matches TS).
pub struct EventRingBuffer {
    inner: RingBuffer<BufferedEvent>,
}

impl EventRingBuffer {
    pub fn new(capacity: usize) -> Self {
        Self {
            inner: RingBuffer::new(capacity, |e: &BufferedEvent| e.id.clone()),
        }
    }

    pub fn add(&mut self, event: BufferedEvent) {
        self.inner.add(event);
    }

    pub fn has(&self, event_id: &str) -> bool {
        self.inner.has(event_id)
    }

    /// Events after `last_event_id`, oldest first.
    /// Returns empty vec if `last_event_id` is not found in the buffer.
    pub fn get_events_since(&self, last_event_id: &str) -> Vec<BufferedEvent> {
        let all = self.inner.get_all();
        let mut found = false;
        all.into_iter()
            .filter(|e| {
                if found {
                    return true;
                }
                if e.id == last_event_id {
                    found = true;
                }
                false
            })
            .cloned()
            .collect()
    }

    pub fn clear(&mut self) {
        self.inner.clear();
    }
}

// ---------------------------------------------------------------------------
// SSE event (broadcast payload)
// ---------------------------------------------------------------------------

/// Event broadcast to subscribers. Converted to SSE wire format by the server.
#[derive(Clone, Debug)]
pub struct SseEvent {
    pub id: String,
    pub event_type: Option<String>,
    pub data: String,
}

// ---------------------------------------------------------------------------
// Stream config
// ---------------------------------------------------------------------------

/// Configuration for the stream manager. Defaults match the TS implementation.
pub struct StreamConfig {
    pub max_active_streams: usize,
    pub max_event_size: usize,
    /// How long to keep the buffer after a stream completes (for reconnection).
    pub buffer_ttl: Duration,
    /// Ring buffer capacity per stream.
    pub buffer_size: usize,
    /// Keep-alive comment interval (used by the server's SSE response).
    pub heartbeat_interval: Duration,
}

impl Default for StreamConfig {
    fn default() -> Self {
        Self {
            max_active_streams: 1000,
            max_event_size: 1024 * 1024, // 1 MB
            buffer_ttl: Duration::from_secs(600), // 10 minutes
            buffer_size: 100,
            heartbeat_interval: Duration::from_secs(10),
        }
    }
}

// ---------------------------------------------------------------------------
// Stream entry (internal state per stream)
// ---------------------------------------------------------------------------

struct StreamEntry {
    buffer: Mutex<EventRingBuffer>,
    tx: broadcast::Sender<SseEvent>,
    completed: AtomicBool,
    cancel_tx: tokio::sync::watch::Sender<bool>,
}

// ---------------------------------------------------------------------------
// Stream manager
// ---------------------------------------------------------------------------

/// Manages SSE stream lifecycle: creation, event buffering, multi-client
/// subscription, reconnection replay, and cancellation.
///
/// Mirrors the TypeScript `StreamManager` in `stream-manager.ts`.
pub struct StreamManager {
    pub config: StreamConfig,
    streams: RwLock<HashMap<String, Arc<StreamEntry>>>,
}

impl StreamManager {
    pub fn new(config: StreamConfig) -> Arc<Self> {
        Arc::new(Self {
            config,
            streams: RwLock::new(HashMap::new()),
        })
    }

    /// Create a new stream. Events arrive via `item_rx` as `(event_type, data)`
    /// tuples. They are buffered for reconnection and broadcast to all
    /// subscribers. The stream is automatically cleaned up after `buffer_ttl`
    /// once the item source is exhausted or cancelled.
    pub async fn create_stream(
        self: &Arc<Self>,
        stream_id: String,
        mut item_rx: mpsc::Receiver<(Option<String>, String)>,
    ) -> Result<(), String> {
        {
            let streams = self.streams.read().await;
            if streams.len() >= self.config.max_active_streams {
                return Err("Maximum active streams exceeded".into());
            }
            if streams.contains_key(&stream_id) {
                return Err(format!("Stream {stream_id} already exists"));
            }
        }

        let (tx, _) = broadcast::channel::<SseEvent>(256);
        let (cancel_tx, mut cancel_rx) = tokio::sync::watch::channel(false);

        let entry = Arc::new(StreamEntry {
            buffer: Mutex::new(EventRingBuffer::new(self.config.buffer_size)),
            tx: tx.clone(),
            completed: AtomicBool::new(false),
            cancel_tx,
        });

        self.streams
            .write()
            .await
            .insert(stream_id.clone(), entry.clone());

        let max_event_size = self.config.max_event_size;
        let buffer_ttl = self.config.buffer_ttl;
        let manager = Arc::clone(self);
        let sid = stream_id;

        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = async {
                        loop {
                            if cancel_rx.changed().await.is_err() { break; }
                            if *cancel_rx.borrow() { break; }
                        }
                    } => break,
                    item = item_rx.recv() => {
                        match item {
                            Some((event_type, data)) => {
                                if data.len() > max_event_size {
                                    let _ = tx.send(SseEvent {
                                        id: uuid::Uuid::new_v4().to_string(),
                                        event_type: Some("error".into()),
                                        data: "Event exceeds maximum size".into(),
                                    });
                                    break;
                                }

                                let event = SseEvent {
                                    id: uuid::Uuid::new_v4().to_string(),
                                    event_type,
                                    data,
                                };

                                // Buffer for replay, then broadcast.
                                {
                                    let mut buf = entry.buffer.lock().await;
                                    buf.add(BufferedEvent {
                                        id: event.id.clone(),
                                        event_type: event.event_type.clone(),
                                        data: event.data.clone(),
                                        timestamp: Instant::now(),
                                    });
                                }

                                let _ = tx.send(event);
                            }
                            None => break, // Source exhausted.
                        }
                    }
                }
            }

            entry.completed.store(true, Ordering::SeqCst);

            // Delayed cleanup — keep buffer available for reconnection.
            tokio::spawn(async move {
                tokio::time::sleep(buffer_ttl).await;
                manager.streams.write().await.remove(&sid);
            });
        });

        Ok(())
    }

    /// Subscribe to a stream's events. Returns an `mpsc::Receiver` that yields
    /// replay events (if reconnecting) followed by live broadcast events.
    pub async fn subscribe(
        &self,
        stream_id: &str,
        last_event_id: Option<&str>,
    ) -> Result<mpsc::Receiver<SseEvent>, String> {
        let entry = {
            let streams = self.streams.read().await;
            streams
                .get(stream_id)
                .cloned()
                .ok_or_else(|| format!("Stream {stream_id} not found"))?
        };

        let (tx, rx) = mpsc::channel::<SseEvent>(256);

        // Subscribe to broadcast BEFORE reading buffer to avoid missing events.
        let mut broadcast_rx = entry.tx.subscribe();

        // Replay missed events if reconnecting.
        let mut last_replayed_id: Option<String> = None;
        if let Some(last_id) = last_event_id {
            let buffer = entry.buffer.lock().await;
            if !buffer.has(last_id) {
                let _ = tx
                    .send(SseEvent {
                        id: uuid::Uuid::new_v4().to_string(),
                        event_type: Some("warning".into()),
                        data: "Buffer overflow: some events may have been missed".into(),
                    })
                    .await;
            }
            let missed = buffer.get_events_since(last_id);
            for event in &missed {
                let _ = tx
                    .send(SseEvent {
                        id: event.id.clone(),
                        event_type: event.event_type.clone(),
                        data: event.data.clone(),
                    })
                    .await;
            }
            last_replayed_id = missed.last().map(|e| e.id.clone());
        }

        // Forward live broadcast events, skipping any that overlap with replay.
        tokio::spawn(async move {
            let mut past_replay = last_replayed_id.is_none();
            loop {
                match broadcast_rx.recv().await {
                    Ok(event) => {
                        if !past_replay {
                            if Some(&event.id) == last_replayed_id.as_ref() {
                                past_replay = true;
                            }
                            continue;
                        }
                        if tx.send(event).await.is_err() {
                            break; // Subscriber disconnected.
                        }
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                }
            }
        });

        Ok(rx)
    }

    /// Cancel all active streams.
    pub async fn abort_all(&self) {
        let streams = self.streams.read().await;
        for entry in streams.values() {
            let _ = entry.cancel_tx.send(true);
        }
    }

    /// Number of active (not-yet-cleaned-up) streams.
    pub async fn active_count(&self) -> usize {
        self.streams.read().await.len()
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // -- RingBuffer --

    #[test]
    fn test_ring_buffer_basic_ops() {
        let mut rb = RingBuffer::new(3, |s: &String| s.clone());

        rb.add("a".into());
        rb.add("b".into());
        assert_eq!(rb.len(), 2);
        assert!(rb.has("a"));
        assert!(rb.has("b"));
        assert_eq!(rb.get("a"), Some(&"a".into()));
    }

    #[test]
    fn test_ring_buffer_overflow_evicts_oldest() {
        let mut rb = RingBuffer::new(2, |s: &String| s.clone());

        rb.add("a".into());
        rb.add("b".into());
        rb.add("c".into()); // evicts "a"

        assert!(!rb.has("a"));
        assert!(rb.has("b"));
        assert!(rb.has("c"));
        assert_eq!(rb.len(), 2);
    }

    #[test]
    fn test_ring_buffer_update_in_place() {
        let mut rb = RingBuffer::new(3, |s: &(String, i32)| s.0.clone());

        rb.add(("x".into(), 1));
        rb.add(("y".into(), 2));
        rb.add(("x".into(), 3)); // update, not new insert

        assert_eq!(rb.len(), 2);
        let val = rb.get("x").unwrap();
        assert_eq!(val.1, 3);
    }

    #[test]
    fn test_ring_buffer_get_all_order() {
        let mut rb = RingBuffer::new(4, |s: &String| s.clone());

        rb.add("a".into());
        rb.add("b".into());
        rb.add("c".into());

        let all: Vec<&str> = rb.get_all().into_iter().map(|s| s.as_str()).collect();
        assert_eq!(all, vec!["a", "b", "c"]);
    }

    #[test]
    fn test_ring_buffer_get_all_after_wrap() {
        let mut rb = RingBuffer::new(3, |s: &String| s.clone());

        rb.add("a".into());
        rb.add("b".into());
        rb.add("c".into());
        rb.add("d".into()); // evicts "a"

        let all: Vec<&str> = rb.get_all().into_iter().map(|s| s.as_str()).collect();
        assert_eq!(all, vec!["b", "c", "d"]);
    }

    #[test]
    fn test_ring_buffer_clear() {
        let mut rb = RingBuffer::new(3, |s: &String| s.clone());
        rb.add("a".into());
        rb.add("b".into());
        rb.clear();
        assert!(rb.is_empty());
        assert!(!rb.has("a"));
    }

    // -- EventRingBuffer --

    fn make_event(id: &str, data: &str) -> BufferedEvent {
        BufferedEvent {
            id: id.into(),
            event_type: None,
            data: data.into(),
            timestamp: Instant::now(),
        }
    }

    #[test]
    fn test_event_ring_buffer_get_events_since() {
        let mut erb = EventRingBuffer::new(10);
        erb.add(make_event("1", "a"));
        erb.add(make_event("2", "b"));
        erb.add(make_event("3", "c"));
        erb.add(make_event("4", "d"));

        let since = erb.get_events_since("2");
        let ids: Vec<&str> = since.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(ids, vec!["3", "4"]);
    }

    #[test]
    fn test_event_ring_buffer_get_events_since_not_found() {
        let mut erb = EventRingBuffer::new(10);
        erb.add(make_event("1", "a"));
        erb.add(make_event("2", "b"));

        let since = erb.get_events_since("99");
        assert!(since.is_empty());
    }

    #[test]
    fn test_event_ring_buffer_has() {
        let mut erb = EventRingBuffer::new(5);
        erb.add(make_event("x", "data"));
        assert!(erb.has("x"));
        assert!(!erb.has("y"));
    }

    // -- StreamManager --

    #[tokio::test]
    async fn test_stream_manager_create_and_subscribe() {
        let sm = StreamManager::new(StreamConfig::default());
        let (item_tx, item_rx) = mpsc::channel(32);

        sm.create_stream("s1".into(), item_rx).await.unwrap();
        assert_eq!(sm.active_count().await, 1);

        let mut rx = sm.subscribe("s1", None).await.unwrap();

        item_tx.send((None, "hello".into())).await.unwrap();

        let event = tokio::time::timeout(Duration::from_secs(1), rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(event.data, "hello");
    }

    #[tokio::test]
    async fn test_stream_manager_reconnection_replay() {
        let sm = StreamManager::new(StreamConfig::default());
        let (item_tx, item_rx) = mpsc::channel(32);

        sm.create_stream("s1".into(), item_rx).await.unwrap();

        // First subscriber to capture event IDs.
        let mut rx1 = sm.subscribe("s1", None).await.unwrap();

        item_tx.send((None, "event-a".into())).await.unwrap();
        item_tx.send((None, "event-b".into())).await.unwrap();

        let ev1 = tokio::time::timeout(Duration::from_secs(1), rx1.recv())
            .await
            .unwrap()
            .unwrap();
        let ev2 = tokio::time::timeout(Duration::from_secs(1), rx1.recv())
            .await
            .unwrap()
            .unwrap();

        // Reconnect with last_event_id = ev1.id → should replay ev2.
        let mut rx2 = sm.subscribe("s1", Some(&ev1.id)).await.unwrap();
        let replayed = tokio::time::timeout(Duration::from_secs(1), rx2.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(replayed.data, "event-b");
        assert_eq!(replayed.id, ev2.id);
    }

    #[tokio::test]
    async fn test_stream_manager_abort_all() {
        let sm = StreamManager::new(StreamConfig {
            buffer_ttl: Duration::from_millis(50),
            ..Default::default()
        });
        let (_item_tx, item_rx) = mpsc::channel::<(Option<String>, String)>(32);
        sm.create_stream("s1".into(), item_rx).await.unwrap();

        sm.abort_all().await;

        // Wait for cleanup.
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(sm.active_count().await, 0);
    }

    #[tokio::test]
    async fn test_stream_manager_duplicate_stream_id_rejected() {
        let sm = StreamManager::new(StreamConfig::default());
        let (_tx1, rx1) = mpsc::channel(1);
        let (_tx2, rx2) = mpsc::channel(1);

        sm.create_stream("dup".into(), rx1).await.unwrap();
        let result = sm.create_stream("dup".into(), rx2).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_stream_manager_oversized_event_terminates_stream() {
        let sm = StreamManager::new(StreamConfig {
            max_event_size: 10,
            buffer_ttl: Duration::from_millis(50),
            ..Default::default()
        });
        let (item_tx, item_rx) = mpsc::channel(32);
        sm.create_stream("s1".into(), item_rx).await.unwrap();

        let mut rx = sm.subscribe("s1", None).await.unwrap();

        // Send oversized event.
        item_tx
            .send((None, "x".repeat(100)))
            .await
            .unwrap();

        let event = tokio::time::timeout(Duration::from_secs(1), rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(event.event_type.as_deref(), Some("error"));
    }
}
