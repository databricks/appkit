#!/usr/bin/env python3
"""Provision an immutable MLflow Unity Catalog trace location for AppKit."""

from __future__ import annotations

import argparse
import json
import os
import tempfile
import time
from pathlib import Path
from typing import Any


def _quoted_identifier(value: str) -> str:
    return f"`{value.replace('`', '``')}`"


def _quoted_string(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def _location_name(location: Any) -> str:
    if location is None:
        return "<unbound>"
    catalog = getattr(location, "catalog_name", None)
    schema = getattr(location, "schema_name", None)
    prefix = getattr(location, "table_prefix", None)
    if all(isinstance(value, str) and value for value in (catalog, schema, prefix)):
        return f"{catalog}.{schema}.{prefix}"
    return repr(location)


def _execute(workspace: Any, warehouse_id: str, statement: str) -> Any:
    response = workspace.statement_execution.execute_statement(
        statement=statement,
        warehouse_id=warehouse_id,
        wait_timeout="50s",
    )
    for _ in range(120):
        status = getattr(response, "status", None)
        state = getattr(status, "state", None)
        state_value = getattr(state, "value", state)
        if state_value == "SUCCEEDED":
            return response
        if state_value in {"FAILED", "CANCELED", "CLOSED"}:
            error = getattr(status, "error", None)
            code = getattr(error, "error_code", None)
            message = getattr(error, "message", None)
            detail = ": ".join(str(value) for value in (code, message) if value)
            raise RuntimeError(
                f"SQL statement {state_value.lower()}: {detail or statement}"
            )
        if state_value not in {"PENDING", "RUNNING"}:
            raise RuntimeError(
                f"SQL statement returned unknown status {state_value!r}: {statement}"
            )
        statement_id = getattr(response, "statement_id", None)
        if not isinstance(statement_id, str) or not statement_id:
            raise RuntimeError(
                f"SQL statement is {state_value.lower()} without a statement ID"
            )
        response = workspace.statement_execution.get_statement(statement_id)
        next_state = getattr(getattr(response, "status", None), "state", None)
        if getattr(next_state, "value", next_state) in {"PENDING", "RUNNING"}:
            time.sleep(1)
    raise TimeoutError(f"SQL statement did not finish after 120 polls: {statement}")


def _discover_trace_tables(
    workspace: Any,
    warehouse_id: str,
    catalog_name: str,
    schema_name: str,
    table_prefix: str,
) -> list[str]:
    response = _execute(
        workspace,
        warehouse_id,
        " ".join(
            [
                "SELECT table_name",
                f"FROM {_quoted_identifier(catalog_name)}.information_schema.tables",
                f"WHERE table_schema = {_quoted_string(schema_name)}",
                f"AND table_name LIKE {_quoted_string(f'{table_prefix}%')}",
                "ORDER BY table_name",
            ]
        ),
    )
    rows = getattr(getattr(response, "result", None), "data_array", None) or []
    return [
        str(row[0])
        for row in rows
        if row
        and row[0] is not None
        and str(row[0]).startswith(table_prefix)
    ]


def _grant_trace_access(
    workspace: Any,
    warehouse_id: str,
    principal: str,
    catalog_name: str,
    schema_name: str,
    table_names: list[str],
) -> None:
    catalog = _quoted_identifier(catalog_name)
    schema = _quoted_identifier(schema_name)
    grantee = _quoted_identifier(principal)
    statements = [
        f"GRANT USE CATALOG ON CATALOG {catalog} TO {grantee}",
        f"GRANT USE SCHEMA ON SCHEMA {catalog}.{schema} TO {grantee}",
    ]
    for table_name in table_names:
        table = f"{catalog}.{schema}.{_quoted_identifier(table_name)}"
        statements.extend(
            [
                f"GRANT MODIFY ON TABLE {table} TO {grantee}",
                f"GRANT SELECT ON TABLE {table} TO {grantee}",
            ]
        )
    for statement in statements:
        _execute(workspace, warehouse_id, statement)


def provision_mlflow_uc(
    *,
    profile: str,
    experiment_name: str,
    catalog_name: str,
    schema_name: str,
    table_prefix: str,
    warehouse_id: str,
    mlflow_module: Any | None = None,
    workspace: Any | None = None,
    unity_catalog_type: type | None = None,
) -> dict[str, str]:
    if mlflow_module is None:
        import mlflow as mlflow_module
    if unity_catalog_type is None:
        from mlflow.entities.trace_location import UnityCatalog

        unity_catalog_type = UnityCatalog
    if workspace is None:
        from databricks.sdk import WorkspaceClient

        workspace = WorkspaceClient(profile=profile)

    tracking_uri = f"databricks://{profile}"
    os.environ["MLFLOW_TRACKING_URI"] = tracking_uri
    os.environ["MLFLOW_TRACING_SQL_WAREHOUSE_ID"] = warehouse_id
    mlflow_module.set_tracking_uri(tracking_uri)

    requested_location = unity_catalog_type(
        catalog_name=catalog_name,
        schema_name=schema_name,
        table_prefix=table_prefix,
    )
    experiment = mlflow_module.set_experiment(
        experiment_name=experiment_name,
        trace_location=requested_location,
    )
    existing_location = getattr(experiment, "trace_location", None)
    if existing_location != requested_location:
        raise ValueError(
            "MLflow experiment trace location is immutable: "
            f"existing={_location_name(existing_location)}, "
            f"requested={_location_name(requested_location)}"
        )

    table_names = _discover_trace_tables(
        workspace,
        warehouse_id,
        catalog_name,
        schema_name,
        table_prefix,
    )
    spans_table = f"{table_prefix}_otel_spans"
    if spans_table not in table_names:
        raise RuntimeError(
            f"Required MLflow trace table {catalog_name}.{schema_name}.{spans_table} "
            f"was not created; discovered: {', '.join(table_names) or '<none>'}"
        )

    current_user = workspace.current_user.me()
    principal = next(
        (
            value
            for value in (
                getattr(current_user, "user_name", None),
                getattr(current_user, "application_id", None),
                getattr(current_user, "id", None),
            )
            if isinstance(value, str) and value
        ),
        None,
    )
    if principal is None:
        raise RuntimeError("Could not resolve the principal receiving UC trace grants")

    _grant_trace_access(
        workspace,
        warehouse_id,
        principal,
        catalog_name,
        schema_name,
        table_names,
    )

    return {
        "MLFLOW_EXPERIMENT_ID": str(experiment.experiment_id),
        "MLFLOW_TRACING_SQL_WAREHOUSE_ID": warehouse_id,
        "MLFLOW_UC_CATALOG": catalog_name,
        "MLFLOW_UC_SCHEMA": schema_name,
        "MLFLOW_UC_TABLE_PREFIX": table_prefix,
        "MLFLOW_OTEL_SPANS_TABLE": f"{catalog_name}.{schema_name}.{spans_table}",
    }


def write_output_atomically(output_path: Path, values: dict[str, str]) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        "w",
        encoding="utf-8",
        dir=output_path.parent,
        prefix=f".{output_path.name}.",
        suffix=".tmp",
        delete=False,
    ) as temporary:
        json.dump(values, temporary, indent=2, sort_keys=True)
        temporary.write("\n")
        temporary.flush()
        os.fsync(temporary.fileno())
        temporary_path = Path(temporary.name)
    os.replace(temporary_path, output_path)


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", required=True)
    parser.add_argument("--experiment-name", required=True)
    parser.add_argument("--catalog", required=True)
    parser.add_argument("--schema", required=True)
    parser.add_argument("--table-prefix", required=True)
    parser.add_argument("--warehouse-id", required=True)
    parser.add_argument("--output-json", type=Path, required=True)
    return parser.parse_args()


def main() -> None:
    args = _parse_args()
    values = provision_mlflow_uc(
        profile=args.profile,
        experiment_name=args.experiment_name,
        catalog_name=args.catalog,
        schema_name=args.schema,
        table_prefix=args.table_prefix,
        warehouse_id=args.warehouse_id,
    )
    write_output_atomically(args.output_json, values)
    print(json.dumps(values, sort_keys=True))


if __name__ == "__main__":
    main()
