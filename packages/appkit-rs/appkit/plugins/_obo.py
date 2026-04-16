"""Shared OBO (On-Behalf-Of) token extraction helpers.

Plugin route handlers call :func:`obo_token` to pull the per-user access
token that Databricks Apps inject as ``X-Forwarded-Access-Token`` on every
proxied request. All comparison is lowercase because the Rust server
lowercases HTTP header names when it forwards them to Python handlers.
"""

from __future__ import annotations

from collections.abc import Mapping

from appkit import AuthenticationError

OBO_HEADER = "x-forwarded-access-token"
USER_HEADER = "x-forwarded-user"
EMAIL_HEADER = "x-forwarded-email"


def _get_header(headers: Mapping[str, str], name: str) -> str | None:
    target = name.lower()
    for key, value in headers.items():
        if key.lower() == target:
            return value
    return None


def obo_token(headers: Mapping[str, str]) -> str:
    """Extract the OBO bearer token, raising if absent.

    Raises :class:`appkit.AuthenticationError` when the header is missing so
    the default interceptor chain maps it to a 401 response.
    """
    token = _get_header(headers, OBO_HEADER)
    if not token:
        raise AuthenticationError(
            f"Missing {OBO_HEADER} header — plugin route requires OBO access."
        )
    return token


def obo_user_key(headers: Mapping[str, str]) -> str:
    """Resolve a stable per-user cache key from forwarded identity headers.

    Falls back to an empty string if neither user nor email is present; the
    cache interceptor treats that as a shared key, which is the intended
    behavior for unauthenticated routes.
    """
    user = _get_header(headers, USER_HEADER)
    if user:
        return user
    email = _get_header(headers, EMAIL_HEADER)
    return email or ""
