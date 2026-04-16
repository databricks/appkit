"""Type stubs for appkit — Databricks AppKit Python SDK."""

from __future__ import annotations

from typing import Any, AsyncIterator, Awaitable, Callable, Optional, Sequence

# ---------------------------------------------------------------------------
# Module-level context variable (created at import time)
# ---------------------------------------------------------------------------

_USER_CONTEXT_VAR: Any  # contextvars.ContextVar[UserContext | None]

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

class AppConfig:
    """Application configuration parsed from environment variables."""

    databricks_host: str
    client_id: Optional[str]
    client_secret: Optional[str]
    warehouse_id: Optional[str]
    app_port: int
    host: str
    otel_endpoint: Optional[str]

    def __init__(
        self,
        databricks_host: str,
        *,
        client_id: Optional[str] = None,
        client_secret: Optional[str] = None,
        warehouse_id: Optional[str] = None,
        app_port: int = 8000,
        host: str = "0.0.0.0",
        otel_endpoint: Optional[str] = None,
    ) -> None: ...
    @staticmethod
    def from_env() -> AppConfig: ...
    def __repr__(self) -> str: ...
    def __eq__(self, other: object) -> bool: ...
    def __hash__(self) -> int: ...

# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------

class ServiceContext:
    """Service-level authentication context (service principal)."""

    config: AppConfig

    def __init__(self, config: AppConfig) -> None: ...
    def get_token(self) -> Awaitable[str]: ...
    def __repr__(self) -> str: ...

class UserContext:
    """Per-request user context for OBO (On-Behalf-Of) flows."""

    token: str
    user_id: str
    user_name: Optional[str]
    workspace_id: str
    warehouse_id: Optional[str]

    @property
    def is_user_context(self) -> bool: ...
    def __init__(
        self,
        token: str,
        user_id: str,
        *,
        user_name: Optional[str] = None,
        workspace_id: str,
        warehouse_id: Optional[str] = None,
    ) -> None: ...
    def __repr__(self) -> str: ...
    def __eq__(self, other: object) -> bool: ...
    def __hash__(self) -> int: ...

# ---------------------------------------------------------------------------
# Cache
# ---------------------------------------------------------------------------

class CacheConfig:
    """Cache configuration with defaults matching TypeScript cacheDefaults."""

    enabled: bool
    ttl: int
    max_size: int
    cleanup_probability: float

    def __init__(
        self,
        *,
        enabled: bool = True,
        ttl: int = 3600,
        max_size: int = 1000,
        cleanup_probability: float = 0.01,
    ) -> None: ...
    def __repr__(self) -> str: ...
    def __eq__(self, other: object) -> bool: ...
    def __hash__(self) -> int: ...

class CacheManager:
    """Cache manager with TTL, LRU eviction, and in-flight deduplication."""

    def __init__(self, config: Optional[CacheConfig] = None) -> None: ...
    @staticmethod
    def generate_key(parts: list[str], user_key: str) -> str: ...
    def get(self, key: str) -> Awaitable[Optional[str]]: ...
    def set(self, key: str, value: str, *, ttl: Optional[int] = None) -> Awaitable[None]: ...
    def delete(self, key: str) -> Awaitable[None]: ...
    def has(self, key: str) -> Awaitable[bool]: ...
    def clear(self) -> Awaitable[None]: ...
    def size(self) -> Awaitable[int]: ...
    def get_or_execute(
        self,
        key: str,
        func: Callable[[], Awaitable[str]],
        *,
        ttl: Optional[int] = None,
    ) -> Awaitable[str]: ...
    def __repr__(self) -> str: ...
    def __bool__(self) -> bool: ...

# ---------------------------------------------------------------------------
# Plugin system
# ---------------------------------------------------------------------------

class PluginPhase:
    """Phase ordering constants for Python plugins."""

    CORE: str
    NORMAL: str
    DEFERRED: str

class PluginManifest:
    """Plugin manifest — metadata."""

    name: str
    display_name: Optional[str]
    description: Optional[str]

    def __init__(
        self,
        name: str,
        *,
        display_name: Optional[str] = None,
        description: Optional[str] = None,
    ) -> None: ...
    def __repr__(self) -> str: ...
    def __eq__(self, other: object) -> bool: ...
    def __hash__(self) -> int: ...

class StreamIterator:
    """Async iterator yielding JSON string items from a streaming execution.

    Used by ``Plugin.execute_stream()`` and ``ServingConnector.stream()``.

    Example::

        stream = await plugin.execute_stream(my_gen_fn)
        async for item in stream:
            data = json.loads(item)
    """

    def __aiter__(self) -> AsyncIterator[str]: ...
    def __anext__(self) -> Awaitable[str]: ...
    def __repr__(self) -> str: ...

class ExecutionResult:
    """Python-facing execution result (frozen, immutable)."""

    ok: bool
    data: Optional[str]
    status: Optional[int]
    message: Optional[str]

    def __repr__(self) -> str: ...
    def __bool__(self) -> bool: ...
    def __eq__(self, other: object) -> bool: ...
    def __hash__(self) -> int: ...

class Plugin:
    """Base class for Python plugins. Subclass to create custom plugins.

    Example::

        class MyPlugin(Plugin):
            def __init__(self):
                super().__init__("my-plugin", manifest=PluginManifest("my-plugin"))

            async def setup(self):
                pass
    """

    name: str
    phase: str
    manifest: PluginManifest
    is_ready: bool

    def __init__(
        self,
        name: str,
        *,
        phase: str = "normal",
        manifest: PluginManifest,
    ) -> None: ...
    def setup(self) -> Awaitable[None]:
        """One-time initialization hook called once during
        :meth:`AppKit.initialize` after the plugin's runtime is injected.
        """
        ...
    def exports(self) -> dict[str, str]:
        """Return string values exported to other plugins and the server."""
        ...
    def client_config(self) -> dict[str, str]:
        """Return per-plugin config surfaced to clients via ``/api/config``."""
        ...
    def inject_routes(self, router: Router) -> None:
        """Register HTTP routes with the server router. Called once per
        plugin, mounted under ``/api/<plugin-name>/``.
        """
        ...
    def execute(
        self,
        func: Callable[[], Awaitable[str]],
        *,
        user_key: str = "",
        timeout_ms: Optional[int] = None,
        retry_attempts: Optional[int] = None,
        cache_key: Optional[list[str]] = None,
        cache_ttl: Optional[int] = None,
    ) -> Awaitable[ExecutionResult]:
        """Execute a coroutine through the plugin's interceptor chain
        (telemetry, timeout, retry, cache).

        ``user_key`` scopes caches to a user for OBO flows. ``cache_key``
        parts are hashed together with ``user_key`` to form a stable key.
        Pass ``timeout_ms=None`` / ``retry_attempts=None`` to fall back to
        the plugin defaults.
        """
        ...
    def execute_stream(
        self,
        func: Callable[[], Any],
        *,
        user_key: str = "",
        timeout_ms: Optional[int] = None,
    ) -> Awaitable[StreamIterator]:
        """Execute a streaming function through the interceptor chain.

        The callable should return a Python async generator that yields
        JSON strings. Returns a StreamIterator for async iteration.

        Retry and cache are not supported for streams.
        """
        ...
    def __repr__(self) -> str: ...

class AppKit:
    """AppKit orchestrator — registers plugins and manages initialization.

    Most applications should use :func:`create_app` instead of driving
    this class directly; ``create_app`` wires registration, initialization
    and optional server startup in one call.
    """

    def __init__(self) -> None: ...
    def register(self, plugin: Plugin) -> None:
        """Register a plugin. Must be called before :meth:`initialize`."""
        ...
    def initialize(
        self,
        config: AppConfig,
        *,
        cache_config: Optional[CacheConfig] = None,
    ) -> Awaitable[None]:
        """Initialize telemetry, cache, and run phase-ordered ``Plugin.setup``.

        After this returns, plugins are ready to serve requests. Calling
        ``initialize`` twice is an error.
        """
        ...
    def get_plugin(self, name: str) -> Optional[Plugin]:
        """Look up a registered plugin by its manifest name."""
        ...
    def plugin_names(self) -> list[str]:
        """Return the manifest names of all registered plugins."""
        ...
    def start_server(self, server_config: ServerConfig) -> Awaitable[None]:
        """Start the HTTP server and block until it exits.

        Routes previously injected via ``Plugin.inject_routes`` are mounted
        under ``/api/<plugin-name>/...``.
        """
        ...
    def shutdown(self) -> None:
        """Stop the HTTP server and release resources."""
        ...
    def __repr__(self) -> str: ...
    def __len__(self) -> int: ...
    def __bool__(self) -> bool: ...
    def __contains__(self, name: str) -> bool: ...

# ---------------------------------------------------------------------------
# Server / routing
# ---------------------------------------------------------------------------

class Router:
    """Router passed to Plugin.inject_routes() for route registration."""

    plugin_name: str

    def get(
        self,
        path: str,
        handler: Callable[[Request], Awaitable[str]],
        *,
        stream: bool = False,
    ) -> None: ...
    def post(
        self,
        path: str,
        handler: Callable[[Request], Awaitable[str]],
        *,
        stream: bool = False,
    ) -> None: ...
    def put(
        self,
        path: str,
        handler: Callable[[Request], Awaitable[str]],
        *,
        stream: bool = False,
    ) -> None: ...
    def delete(
        self,
        path: str,
        handler: Callable[[Request], Awaitable[str]],
        *,
        stream: bool = False,
    ) -> None: ...
    def patch(
        self,
        path: str,
        handler: Callable[[Request], Awaitable[str]],
        *,
        stream: bool = False,
    ) -> None: ...
    def __repr__(self) -> str: ...

class Request:
    """HTTP request data forwarded to Python route handlers."""

    method: str
    path: str
    headers: dict[str, str]
    query: str
    body: str

    def json(self) -> Any:
        """Parse the request body as JSON and return Python-native data.

        Raises ValueError if the body is not valid JSON.
        """
        ...
    def __repr__(self) -> str: ...

class ServerConfig:
    """Server configuration."""

    host: str
    port: int
    auto_start: bool
    static_path: Optional[str]

    def __init__(
        self,
        *,
        host: str = "0.0.0.0",
        port: int = 8000,
        auto_start: bool = True,
        static_path: Optional[str] = None,
    ) -> None: ...
    def __repr__(self) -> str: ...
    def __eq__(self, other: object) -> bool: ...
    def __hash__(self) -> int: ...

# ---------------------------------------------------------------------------
# Connectors — Files
# ---------------------------------------------------------------------------

class FileDirectoryEntry:
    """A single entry in a directory listing."""

    path: str
    name: str
    is_directory: bool
    file_size: Optional[int]
    last_modified: Optional[int]

    def __repr__(self) -> str: ...
    def __eq__(self, other: object) -> bool: ...
    def __hash__(self) -> int: ...

class FileMetadata:
    """File metadata from a HEAD request."""

    content_length: Optional[int]
    content_type: Optional[str]
    last_modified: Optional[str]

    def __repr__(self) -> str: ...

class FilePreview:
    """File preview with optional text content."""

    content_length: Optional[int]
    content_type: Optional[str]
    last_modified: Optional[str]
    text_preview: Optional[str]
    is_text: bool
    is_image: bool

    def __repr__(self) -> str: ...

class FilesConnector:
    """Databricks Files API connector.

    Operates against Unity Catalog Volume paths. The ``default_volume``
    constructor argument is used as a prefix when a ``file_path`` is not
    already a ``/Volumes/...`` absolute path.
    """

    def __init__(self, host: str, *, default_volume: Optional[str] = None) -> None: ...
    def resolve_path(self, file_path: str) -> str:
        """Join ``file_path`` with the connector's default volume if the
        path is not already a fully-qualified ``/Volumes/...`` path.
        """
        ...
    def list(
        self,
        token: str,
        *,
        directory_path: Optional[str] = None,
    ) -> Awaitable[list[FileDirectoryEntry]]:
        """List entries under ``directory_path`` (or the default volume)."""
        ...
    def read(
        self,
        token: str,
        file_path: str,
        *,
        max_size: Optional[int] = None,
    ) -> Awaitable[str]:
        """Read a text file, optionally truncated to ``max_size`` bytes."""
        ...
    def download(self, token: str, file_path: str) -> Awaitable[bytes]:
        """Download a file as raw bytes."""
        ...
    def exists(self, token: str, file_path: str) -> Awaitable[bool]:
        """Return whether the given file or directory exists."""
        ...
    def metadata(self, token: str, file_path: str) -> Awaitable[FileMetadata]:
        """Fetch metadata for a file via a HEAD request."""
        ...
    def upload(
        self,
        token: str,
        file_path: str,
        contents: bytes,
        *,
        overwrite: bool = True,
    ) -> Awaitable[None]:
        """Upload ``contents`` to ``file_path``. Overwrites by default."""
        ...
    def create_directory(self, token: str, directory_path: str) -> Awaitable[None]:
        """Create a directory, creating parents as needed."""
        ...
    def delete(self, token: str, file_path: str) -> Awaitable[None]:
        """Delete a file or (empty) directory."""
        ...
    def preview(
        self,
        token: str,
        file_path: str,
        *,
        max_chars: int = 1024,
    ) -> Awaitable[FilePreview]:
        """Fetch metadata and a capped-length text preview if the file is
        recognized as text."""
        ...
    def __repr__(self) -> str: ...

# ---------------------------------------------------------------------------
# Connectors — SQL Warehouse
# ---------------------------------------------------------------------------

class SqlColumn:
    """Column schema information."""

    name: str
    type_name: str

    def __repr__(self) -> str: ...
    def __eq__(self, other: object) -> bool: ...
    def __hash__(self) -> int: ...

class SqlStatementResult:
    """Result of a SQL statement execution."""

    statement_id: str
    status: str
    columns: list[SqlColumn]
    data: str
    row_count: int

    def __repr__(self) -> str: ...
    def __len__(self) -> int: ...
    def __bool__(self) -> bool: ...

class SqlWarehouseConnector:
    """Databricks SQL Warehouse connector.

    Runs parameterised SQL statements against a Serverless or Pro warehouse
    via the ``/api/2.0/sql/statements`` endpoint and polls until the
    statement reaches a terminal status.
    """

    def __init__(self, host: str, *, timeout_ms: Optional[int] = None) -> None: ...
    def execute_statement(
        self,
        token: str,
        statement: str,
        warehouse_id: str,
        *,
        parameters: Optional[list[tuple[str, str]]] = None,
        catalog: Optional[str] = None,
        schema: Optional[str] = None,
        wait_timeout: Optional[str] = None,
        disposition: Optional[str] = None,
        format: Optional[str] = None,
        on_wait_timeout: Optional[str] = None,
        byte_limit: Optional[int] = None,
        row_limit: Optional[int] = None,
        timeout_ms: Optional[int] = None,
    ) -> Awaitable[SqlStatementResult]:
        """Execute ``statement`` on ``warehouse_id`` and return the result.

        ``parameters`` is a list of ``(name, value)`` pairs corresponding
        to ``:name`` placeholders in the SQL; values are always passed as
        strings and typed by the server via column metadata.
        """
        ...
    def __repr__(self) -> str: ...

# ---------------------------------------------------------------------------
# Connectors — Genie
# ---------------------------------------------------------------------------

class GenieAttachment:
    """Genie query attachment metadata."""

    attachment_id: Optional[str]
    query_title: Optional[str]
    query_description: Optional[str]
    query_sql: Optional[str]
    query_statement_id: Optional[str]
    text_content: Optional[str]
    suggested_questions: Optional[list[str]]

    def __repr__(self) -> str: ...

class GenieMessage:
    """Genie message response."""

    message_id: str
    conversation_id: str
    space_id: str
    status: str
    content: str
    attachments: list[GenieAttachment]
    error: Optional[str]

    def __repr__(self) -> str: ...

class GenieConversationHistory:
    """Full conversation history."""

    conversation_id: str
    space_id: str
    messages: list[GenieMessage]

    def __repr__(self) -> str: ...
    def __len__(self) -> int: ...

class GenieQueryResult:
    """Query result from a Genie attachment."""

    data: str

    def __repr__(self) -> str: ...

class GenieConnector:
    """Databricks Genie connector."""

    def __init__(
        self,
        host: str,
        *,
        timeout_ms: Optional[int] = None,
        max_messages: Optional[int] = None,
    ) -> None: ...
    def start_message(
        self,
        token: str,
        space_id: str,
        content: str,
        *,
        conversation_id: Optional[str] = None,
    ) -> Awaitable[tuple[str, str]]: ...
    def send_message(
        self,
        token: str,
        space_id: str,
        content: str,
        *,
        conversation_id: Optional[str] = None,
        timeout_ms: Optional[int] = None,
    ) -> Awaitable[GenieMessage]: ...
    def get_message(
        self,
        token: str,
        space_id: str,
        conversation_id: str,
        message_id: str,
        *,
        timeout_ms: Optional[int] = None,
    ) -> Awaitable[GenieMessage]: ...
    def list_messages(
        self,
        token: str,
        space_id: str,
        conversation_id: str,
        *,
        page_size: Optional[int] = None,
        page_token: Optional[str] = None,
    ) -> Awaitable[tuple[list[GenieMessage], Optional[str]]]: ...
    def get_query_result(
        self,
        token: str,
        space_id: str,
        conversation_id: str,
        message_id: str,
        attachment_id: str,
    ) -> Awaitable[GenieQueryResult]: ...
    def get_conversation(
        self,
        token: str,
        space_id: str,
        conversation_id: str,
    ) -> Awaitable[GenieConversationHistory]: ...
    def __repr__(self) -> str: ...

# ---------------------------------------------------------------------------
# Connectors — Serving
# ---------------------------------------------------------------------------

class ServingResponse:
    """Response from a serving endpoint invocation."""

    data: str
    status_code: int

    def __repr__(self) -> str: ...
    def __bool__(self) -> bool: ...
    def __eq__(self, other: object) -> bool: ...
    def __hash__(self) -> int: ...

class ServingConnector:
    """Databricks Serving Endpoints connector.

    Wraps ``/serving-endpoints/<name>/invocations`` for synchronous calls
    and the SSE streaming variant for LLM-style endpoints.
    """

    def __init__(self, host: str) -> None: ...
    def invoke(
        self,
        token: str,
        endpoint_name: str,
        body: str,
    ) -> Awaitable[ServingResponse]:
        """Invoke a serving endpoint with a JSON request body and return
        the raw response."""
        ...
    def stream(
        self,
        token: str,
        endpoint_name: str,
        body: str,
    ) -> Awaitable[StreamIterator]:
        """Stream from a serving endpoint (SSE).

        Returns a StreamIterator that yields parsed SSE data payloads
        as they arrive. The stream ends on ``data: [DONE]`` or connection close.
        """
        ...
    def __repr__(self) -> str: ...

# ---------------------------------------------------------------------------
# Connectors — Lakebase
# ---------------------------------------------------------------------------

class DatabaseCredential:
    """Generated database credential for Lakebase access."""

    token: str
    expiration_time: str

    def __repr__(self) -> str: ...
    def __eq__(self, other: object) -> bool: ...
    def __hash__(self) -> int: ...

class LakebasePgConfig:
    """PostgreSQL connection configuration for Lakebase."""

    host: str
    database: str
    port: int
    ssl_mode: str
    app_name: Optional[str]

    def __init__(
        self,
        *,
        host: Optional[str] = None,
        database: Optional[str] = None,
        port: Optional[int] = None,
        ssl_mode: Optional[str] = None,
        app_name: Optional[str] = None,
    ) -> None: ...
    @staticmethod
    def from_env() -> LakebasePgConfig: ...
    def __repr__(self) -> str: ...
    def __eq__(self, other: object) -> bool: ...
    def __hash__(self) -> int: ...

class LakebaseConnector:
    """Databricks Lakebase connector.

    Generates short-lived PostgreSQL credentials for a set of Lakebase
    instances via the database credentials API.
    """

    def __init__(self, host: str) -> None: ...
    def generate_credential(
        self,
        token: str,
        instance_names: list[str],
        *,
        request_id: Optional[str] = None,
    ) -> Awaitable[DatabaseCredential]:
        """Generate a credential good for one or more Lakebase instances.

        Use the returned token as the PostgreSQL password for the life of
        ``expiration_time`` — typically tens of minutes.
        """
        ...
    def __repr__(self) -> str: ...

# ---------------------------------------------------------------------------
# Connectors — Vector Search
# ---------------------------------------------------------------------------

class VsSearchRequest:
    """Parsed Vector Search request matching the TS ``SearchRequest`` shape.

    Parameters are passed by keyword; ``filters_json`` is a JSON object
    string of scalar-or-array filter values.
    """

    query_text: Optional[str]
    query_vector: Optional[list[float]]
    columns: Optional[list[str]]
    num_results: Optional[int]
    query_type: Optional[str]
    filters_json: Optional[str]
    reranker_columns: Optional[list[str]]

    def __init__(
        self,
        *,
        query_text: Optional[str] = None,
        query_vector: Optional[list[float]] = None,
        columns: Optional[list[str]] = None,
        num_results: Optional[int] = None,
        query_type: Optional[str] = None,
        filters_json: Optional[str] = None,
        reranker_columns: Optional[list[str]] = None,
    ) -> None: ...
    def __repr__(self) -> str: ...

class VectorSearchConnector:
    """Databricks Vector Search REST connector.

    Wraps the ``/api/2.0/vector-search`` endpoints; returns raw JSON response
    bodies as strings so Python callers can reuse their existing shaping
    logic without a second serde pass across the PyO3 boundary.
    """

    def __init__(self, host: str, *, timeout_ms: Optional[int] = None) -> None: ...
    def query(
        self,
        token: str,
        index_name: str,
        *,
        columns: list[str],
        num_results: int = 20,
        query_type: str = "hybrid",
        query_text: Optional[str] = None,
        query_vector: Optional[list[float]] = None,
        filters_json: Optional[str] = None,
        reranker_columns: Optional[list[str]] = None,
    ) -> Awaitable[str]:
        """Run a query against ``index_name`` and return the raw JSON
        response body.

        Pass ``query_text`` for text/hybrid queries, ``query_vector`` for
        ANN queries. ``filters_json`` is the JSON-serialised filter object.
        """
        ...
    def query_next_page(
        self,
        token: str,
        index_name: str,
        endpoint_name: str,
        page_token: str,
    ) -> Awaitable[str]:
        """Fetch the next page of a paginated query using ``page_token``
        from a prior :meth:`query` response."""
        ...
    def __repr__(self) -> str: ...

# ---------------------------------------------------------------------------
# Top-level functions
# ---------------------------------------------------------------------------

def create_app(
    *,
    config: AppConfig,
    plugins: list[Plugin] = ...,
    cache_config: Optional[CacheConfig] = None,
    server_config: Optional[ServerConfig] = None,
    auto_start: bool = True,
) -> Awaitable[AppKit]:
    """Create and initialize an AppKit instance in one call.

    This is the primary public API — mirrors TypeScript's ``createApp(...)``.

    Steps:
        1. Creates an AppKit instance
        2. Registers all provided plugins
        3. Initializes (telemetry, cache, phase-ordered plugin setup)
        4. Optionally starts the HTTP server (when ``auto_start=True``)

    Returns the initialized AppKit instance.
    """
    ...

def run_in_user_context(user_context: UserContext, func: Callable[[], Any]) -> Any:
    """Run a synchronous callable with the given UserContext set as the
    current execution context for the duration of the call.

    Mirrors TypeScript's ``runInUserContext(userContext, fn)``.
    """
    ...

def as_user(
    user_context: UserContext,
    func: Callable[[], Awaitable[Any]],
) -> Awaitable[Any]:
    """Run an async callable with the given UserContext set for the duration.

    Returns an awaitable coroutine.
    """
    ...

def get_current_user() -> Optional[UserContext]:
    """Get the current UserContext from the execution context, or None
    if running as service principal.
    """
    ...

def is_in_user_context() -> bool:
    """Check whether the current execution is running in a user context."""
    ...
