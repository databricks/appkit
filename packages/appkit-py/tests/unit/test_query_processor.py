"""Unit tests for QueryProcessor (SQL parameter processing)."""

from __future__ import annotations

import pytest

pytestmark = pytest.mark.unit


class TestQueryProcessor:
    def test_import(self):
        from appkit_py.plugins.analytics.query import QueryProcessor

        qp = QueryProcessor()
        assert qp is not None

    def test_hash_query_deterministic(self):
        from appkit_py.plugins.analytics.query import QueryProcessor

        qp = QueryProcessor()
        h1 = qp.hash_query("SELECT * FROM table")
        h2 = qp.hash_query("SELECT * FROM table")
        assert h1 == h2

    def test_hash_query_different_for_different_queries(self):
        from appkit_py.plugins.analytics.query import QueryProcessor

        qp = QueryProcessor()
        h1 = qp.hash_query("SELECT * FROM table1")
        h2 = qp.hash_query("SELECT * FROM table2")
        assert h1 != h2

    def test_convert_to_sql_parameters_no_params(self):
        from appkit_py.plugins.analytics.query import QueryProcessor

        qp = QueryProcessor()
        result = qp.convert_to_sql_parameters("SELECT 1", None)
        assert result["statement"] == "SELECT 1"

    def test_convert_to_sql_parameters_with_named_params(self):
        from appkit_py.plugins.analytics.query import QueryProcessor

        qp = QueryProcessor()
        result = qp.convert_to_sql_parameters(
            "SELECT * FROM t WHERE id = :id AND name = :name",
            {
                "id": {"__sql_type": "NUMERIC", "value": "42"},
                "name": {"__sql_type": "STRING", "value": "test"},
            },
        )
        assert "parameters" in result
        assert isinstance(result["parameters"], list)
