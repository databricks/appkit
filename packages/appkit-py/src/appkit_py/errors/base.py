"""AppKit error hierarchy matching the TypeScript implementation."""

from __future__ import annotations


class AppKitError(Exception):
    code: str = "APPKIT_ERROR"
    status_code: int = 500
    is_retryable: bool = False

    def __init__(self, message: str, *, cause: Exception | None = None) -> None:
        super().__init__(message)
        self.cause = cause

    def to_dict(self) -> dict:
        return {"error": str(self), "code": self.code, "statusCode": self.status_code}


class AuthenticationError(AppKitError):
    code = "AUTHENTICATION_ERROR"
    status_code = 401

    @classmethod
    def missing_token(cls, token_type: str = "access token") -> AuthenticationError:
        return cls(f"Missing {token_type}")


class ValidationError(AppKitError):
    code = "VALIDATION_ERROR"
    status_code = 400

    @classmethod
    def missing_field(cls, field: str) -> ValidationError:
        return cls(f"{field} is required")

    @classmethod
    def invalid_value(cls, field: str, value: str, expectation: str) -> ValidationError:
        return cls(f"Invalid {field}: {value}. Expected: {expectation}")


class ConfigurationError(AppKitError):
    code = "CONFIGURATION_ERROR"
    status_code = 500

    @classmethod
    def missing_env_var(cls, var_name: str) -> ConfigurationError:
        return cls(f"Missing environment variable: {var_name}")


class ExecutionError(AppKitError):
    code = "EXECUTION_ERROR"
    status_code = 500

    @classmethod
    def statement_failed(cls, message: str) -> ExecutionError:
        return cls(message)


class ConnectionError_(AppKitError):
    code = "CONNECTION_ERROR"
    status_code = 503
    is_retryable = True

    @classmethod
    def api_failure(cls, service: str, cause: Exception | None = None) -> ConnectionError_:
        return cls(f"Failed to connect to {service}", cause=cause)


class InitializationError(AppKitError):
    code = "INITIALIZATION_ERROR"
    status_code = 500

    @classmethod
    def not_initialized(cls, component: str, hint: str = "") -> InitializationError:
        msg = f"{component} is not initialized"
        if hint:
            msg += f". {hint}"
        return cls(msg)


class ServerError(AppKitError):
    code = "SERVER_ERROR"
    status_code = 500
