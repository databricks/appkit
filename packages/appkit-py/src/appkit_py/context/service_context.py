"""Service context singleton for the Databricks workspace client."""

from __future__ import annotations

from .user_context import UserContext


class ServiceContext:
    """Singleton holding the service principal workspace client."""

    _instance: ServiceContext | None = None

    def __init__(self) -> None:
        self.service_user_id: str = "service-principal"

    @classmethod
    def initialize(cls) -> ServiceContext:
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    @classmethod
    def get(cls) -> ServiceContext:
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    @classmethod
    def reset(cls) -> None:
        cls._instance = None

    def create_user_context(self, token: str, user_id: str, user_name: str | None = None) -> UserContext:
        return UserContext(user_id=user_id, token=token, user_name=user_name)
