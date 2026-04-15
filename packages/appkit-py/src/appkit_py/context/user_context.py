"""User context dataclass for OBO (On-Behalf-Of) execution."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass
class UserContext:
    """Per-request user context created from x-forwarded-* headers."""

    user_id: str
    token: str
    user_name: str | None = None
