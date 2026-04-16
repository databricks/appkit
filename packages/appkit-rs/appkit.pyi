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
    def setup(self) -> Awaitable[None]: ...
    def exports(self) -> dict[str, str]: ...
    def client_config(self) -> dict[str, str]: ...
    def inject_routes(self, router: Router) -> None: ...
    def execute(
        self,
        func: Callable[[], Awaitable[str]],
        *,
        user_key: str = "",
        timeout_ms: Optional[int] = None,
        retry_attempts: Optional[int] = None,
        cache_key: Optional[list[str]] = None,
        cache_ttl: Optional[int] = None,
    ) -> Awaitable[ExecutionResult]: ...
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
    """AppKit orchestrator — registers plugins and manages initialization."""

    def __init__(self) -> None: ...
    def register(self, plugin: Plugin) -> None: ...
    def initialize(
        self,
        config: AppConfig,
        *,
        cache_config: Optional[CacheConfig] = None,
    ) -> Awaitable[None]: ...
    def get_plugin(self, name: str) -> Optional[Plugin]: ...
    def plugin_names(self) -> list[str]: ...
    def start_server(self, server_config: ServerConfig) -> Awaitable[None]: ...
    def shutdown(self) -> None: ...
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
    """Databricks Files API connector."""

    def __init__(self, host: str, *, default_volume: Optional[str] = None) -> None: ...
    def resolve_path(self, file_path: str) -> str: ...
    def list(
        self,
        token: str,
        *,
        directory_path: Optional[str] = None,
    ) -> Awaitable[list[FileDirectoryEntry]]: ...
    def read(
        self,
        token: str,
        file_path: str,
        *,
        max_size: Optional[int] = None,
    ) -> Awaitable[str]: ...
    def download(self, token: str, file_path: str) -> Awaitable[bytes]: ...
    def exists(self, token: str, file_path: str) -> Awaitable[bool]: ...
    def metadata(self, token: str, file_path: str) -> Awaitable[FileMetadata]: ...
    def upload(
        self,
        token: str,
        file_path: str,
        contents: bytes,
        *,
        overwrite: bool = True,
    ) -> Awaitable[None]: ...
    def create_directory(self, token: str, directory_path: str) -> Awaitable[None]: ...
    def delete(self, token: str, file_path: str) -> Awaitable[None]: ...
    def preview(
        self,
        token: str,
        file_path: str,
        *,
        max_chars: int = 1024,
    ) -> Awaitable[FilePreview]: ...
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
    """Databricks SQL Warehouse connector."""

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
    ) -> Awaitable[SqlStatementResult]: ...
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
    """Databricks Serving Endpoints connector."""

    def __init__(self, host: str) -> None: ...
    def invoke(
        self,
        token: str,
        endpoint_name: str,
        body: str,
    ) -> Awaitable[ServingResponse]: ...
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
    """Databricks Lakebase connector."""

    def __init__(self, host: str) -> None: ...
    def generate_credential(
        self,
        token: str,
        instance_names: list[str],
        *,
        request_id: Optional[str] = None,
    ) -> Awaitable[DatabaseCredential]: ...
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
