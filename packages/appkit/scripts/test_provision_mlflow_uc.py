from __future__ import annotations

import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from mlflow.entities.trace_location import UnityCatalog


SCRIPT_PATH = Path(__file__).with_name("provision-mlflow-uc.py")


def load_script():
    spec = importlib.util.spec_from_file_location("provision_mlflow_uc", SCRIPT_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def statement_response(
    state: str,
    *,
    table_names: list[str] | None = None,
    statement_id: str = "statement-1",
    error_message: str | None = None,
):
    error = (
        SimpleNamespace(message=error_message, error_code="PERMISSION_DENIED")
        if error_message
        else None
    )
    return SimpleNamespace(
        statement_id=statement_id,
        status=SimpleNamespace(state=state, error=error),
        result=SimpleNamespace(
            data_array=[[table_name] for table_name in (table_names or [])]
        ),
    )


class FakeStatementExecution:
    def __init__(
        self,
        table_names: list[str],
        *,
        failed_statement: str | None = None,
        pending_then_succeeded: bool = False,
    ):
        self.table_names = table_names
        self.statements: list[str] = []
        self.failed_statement = failed_statement
        self.pending_then_succeeded = pending_then_succeeded
        self.get_statement_calls: list[str] = []

    def execute_statement(self, statement: str, warehouse_id: str, **_kwargs):
        assert warehouse_id == "0123456789abcdef"
        self.statements.append(statement)
        if self.failed_statement and self.failed_statement in statement:
            return statement_response(
                "FAILED",
                error_message="principal lacks MODIFY",
            )
        if self.pending_then_succeeded:
            return statement_response("PENDING")
        if "information_schema.tables" in statement:
            return statement_response("SUCCEEDED", table_names=self.table_names)
        return statement_response("SUCCEEDED")

    def get_statement(self, statement_id: str):
        self.get_statement_calls.append(statement_id)
        return statement_response("SUCCEEDED", table_names=self.table_names)


class FakeWorkspace:
    def __init__(self, table_names: list[str], **statement_options):
        self.statement_execution = FakeStatementExecution(
            table_names, **statement_options
        )
        self.current_user = SimpleNamespace(
            me=lambda: SimpleNamespace(user_name="service-principal")
        )


def experiment(location: UnityCatalog):
    return SimpleNamespace(
        experiment_id="123456789",
        name="/Users/user@example.com/appkit-agent-traces",
        trace_location=location,
    )


def provision(
    module,
    *,
    location: UnityCatalog | None = None,
    tables=None,
    statement_options=None,
    table_prefix="appkit",
):
    requested = UnityCatalog("main", "agent_traces", table_prefix)
    mlflow_module = SimpleNamespace(
        set_tracking_uri=Mock(),
        set_experiment=Mock(return_value=experiment(location or requested)),
    )
    workspace = FakeWorkspace(
        tables
        or ["appkit_otel_spans", "appkit_otel_logs", "appkit_annotations"],
        **(statement_options or {}),
    )
    result = module.provision_mlflow_uc(
        profile="DEFAULT",
        experiment_name="/Users/user@example.com/appkit-agent-traces",
        catalog_name="main",
        schema_name="agent_traces",
        table_prefix=table_prefix,
        warehouse_id="0123456789abcdef",
        mlflow_module=mlflow_module,
        workspace=workspace,
        unity_catalog_type=UnityCatalog,
    )
    return result, mlflow_module, workspace


def test_provisions_supported_uc_location_and_grants_every_discovered_table(
    monkeypatch,
):
    module = load_script()
    monkeypatch.delenv("MLFLOW_TRACKING_URI", raising=False)
    monkeypatch.delenv("MLFLOW_TRACING_SQL_WAREHOUSE_ID", raising=False)

    result, mlflow_module, workspace = provision(module)

    mlflow_module.set_tracking_uri.assert_called_once_with("databricks://DEFAULT")
    mlflow_module.set_experiment.assert_called_once_with(
        experiment_name="/Users/user@example.com/appkit-agent-traces",
        trace_location=UnityCatalog(
            catalog_name="main",
            schema_name="agent_traces",
            table_prefix="appkit",
        ),
    )
    assert result == {
        "MLFLOW_EXPERIMENT_ID": "123456789",
        "MLFLOW_TRACING_SQL_WAREHOUSE_ID": "0123456789abcdef",
        "MLFLOW_UC_CATALOG": "main",
        "MLFLOW_UC_SCHEMA": "agent_traces",
        "MLFLOW_UC_TABLE_PREFIX": "appkit",
        "MLFLOW_OTEL_SPANS_TABLE": "main.agent_traces.appkit_otel_spans",
    }
    assert workspace.statement_execution.statements[1:] == [
        "GRANT USE CATALOG ON CATALOG `main` TO `service-principal`",
        "GRANT USE SCHEMA ON SCHEMA `main`.`agent_traces` TO `service-principal`",
        "GRANT MODIFY ON TABLE `main`.`agent_traces`.`appkit_otel_spans` TO `service-principal`",
        "GRANT SELECT ON TABLE `main`.`agent_traces`.`appkit_otel_spans` TO `service-principal`",
        "GRANT MODIFY ON TABLE `main`.`agent_traces`.`appkit_otel_logs` TO `service-principal`",
        "GRANT SELECT ON TABLE `main`.`agent_traces`.`appkit_otel_logs` TO `service-principal`",
        "GRANT MODIFY ON TABLE `main`.`agent_traces`.`appkit_annotations` TO `service-principal`",
        "GRANT SELECT ON TABLE `main`.`agent_traces`.`appkit_annotations` TO `service-principal`",
    ]


def test_repeated_setup_is_idempotent():
    module = load_script()

    first, _, _ = provision(module)
    second, _, _ = provision(module)

    assert second == first


def test_existing_different_uc_location_is_rejected_with_both_locations():
    module = load_script()

    with pytest.raises(ValueError) as error:
        provision(module, location=UnityCatalog("other", "traces", "legacy"))

    assert "other.traces.legacy" in str(error.value)
    assert "main.agent_traces.appkit" in str(error.value)


def test_missing_otel_spans_table_is_fatal():
    module = load_script()

    with pytest.raises(RuntimeError, match="appkit_otel_spans"):
        provision(module, tables=["appkit_otel_logs", "appkit_annotations"])


def test_wildcards_in_prefix_cannot_grant_unrelated_tables():
    module = load_script()

    _, _, workspace = provision(
        module,
        table_prefix="app%_kit",
        tables=["app%_kit_otel_spans", "appXXkit_unrelated"],
    )

    grants = "\n".join(workspace.statement_execution.statements)
    assert "app%_kit_otel_spans" in grants
    assert "appXXkit_unrelated" not in grants


def test_pending_statement_is_polled_to_terminal_success():
    module = load_script()
    workspace = FakeWorkspace(
        ["appkit_otel_spans"], pending_then_succeeded=True
    )

    response = module._execute(workspace, "0123456789abcdef", "SELECT 1")

    assert response.status.state == "SUCCEEDED"
    assert workspace.statement_execution.get_statement_calls == ["statement-1"]


def test_failed_grant_response_is_fatal():
    module = load_script()

    with pytest.raises(RuntimeError, match="principal lacks MODIFY"):
        provision(
            module,
            statement_options={"failed_statement": "GRANT MODIFY"},
        )


def test_writes_configuration_atomically(tmp_path: Path):
    module = load_script()
    output = tmp_path / ".databricks" / "mlflow-uc.json"
    values = {"MLFLOW_EXPERIMENT_ID": "123456789"}

    module.write_output_atomically(output, values)

    assert json.loads(output.read_text()) == values
    assert list(output.parent.glob("*.tmp")) == []
