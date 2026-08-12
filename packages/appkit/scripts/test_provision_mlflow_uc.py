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


class FakeStatementExecution:
    def __init__(self, table_names: list[str]):
        self.table_names = table_names
        self.statements: list[str] = []

    def execute_statement(self, statement: str, warehouse_id: str, **_kwargs):
        assert warehouse_id == "0123456789abcdef"
        self.statements.append(statement)
        if "information_schema.tables" in statement:
            return SimpleNamespace(
                result=SimpleNamespace(
                    data_array=[[table_name] for table_name in self.table_names]
                )
            )
        return SimpleNamespace(result=SimpleNamespace(data_array=[]))


class FakeWorkspace:
    def __init__(self, table_names: list[str]):
        self.statement_execution = FakeStatementExecution(table_names)
        self.current_user = SimpleNamespace(
            me=lambda: SimpleNamespace(user_name="service-principal")
        )


def experiment(location: UnityCatalog):
    return SimpleNamespace(
        experiment_id="123456789",
        name="/Users/user@example.com/appkit-agent-traces",
        trace_location=location,
    )


def provision(module, *, location: UnityCatalog | None = None, tables=None):
    requested = UnityCatalog("main", "agent_traces", "appkit")
    mlflow_module = SimpleNamespace(
        set_tracking_uri=Mock(),
        set_experiment=Mock(return_value=experiment(location or requested)),
    )
    workspace = FakeWorkspace(
        tables
        or ["appkit_otel_spans", "appkit_otel_logs", "appkit_annotations"]
    )
    result = module.provision_mlflow_uc(
        profile="DEFAULT",
        experiment_name="/Users/user@example.com/appkit-agent-traces",
        catalog_name="main",
        schema_name="agent_traces",
        table_prefix="appkit",
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


def test_writes_configuration_atomically(tmp_path: Path):
    module = load_script()
    output = tmp_path / ".databricks" / "mlflow-uc.json"
    values = {"MLFLOW_EXPERIMENT_ID": "123456789"}

    module.write_output_atomically(output, values)

    assert json.loads(output.read_text()) == values
    assert list(output.parent.glob("*.tmp")) == []
