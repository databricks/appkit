import { describe, expect, test } from "vitest";
import { constructMlflowV4TraceId, resolveMlflowUcConfig } from "../../index";

const completeEnv = {
  MLFLOW_EXPERIMENT_ID: "123456789",
  MLFLOW_UC_CATALOG: "main",
  MLFLOW_UC_SCHEMA: "agent_traces",
  MLFLOW_UC_TABLE_PREFIX: "appkit",
  MLFLOW_OTEL_SPANS_TABLE: "main.agent_traces.appkit_otel_spans",
};

describe("resolveMlflowUcConfig", () => {
  test("resolves every required field from the environment", () => {
    expect(resolveMlflowUcConfig(completeEnv)).toEqual({
      experimentId: "123456789",
      catalogName: "main",
      schemaName: "agent_traces",
      tablePrefix: "appkit",
      otelSpansTableName: "main.agent_traces.appkit_otel_spans",
    });
  });

  test("an explicit object overrides only supplied environment-backed fields", () => {
    expect(
      resolveMlflowUcConfig(completeEnv, {
        experimentId: "987654321",
        tablePrefix: "custom",
        otelSpansTableName: "main.agent_traces.custom_otel_spans",
      }),
    ).toEqual({
      experimentId: "987654321",
      catalogName: "main",
      schemaName: "agent_traces",
      tablePrefix: "custom",
      otelSpansTableName: "main.agent_traces.custom_otel_spans",
    });
  });

  test("reports every missing or blank field in one startup error", () => {
    expect(() =>
      resolveMlflowUcConfig({
        MLFLOW_EXPERIMENT_ID: "",
        MLFLOW_UC_CATALOG: "   ",
      }),
    ).toThrow(
      "MLflow UC tracing configuration missing: MLFLOW_EXPERIMENT_ID, MLFLOW_UC_CATALOG, MLFLOW_UC_SCHEMA, MLFLOW_UC_TABLE_PREFIX, MLFLOW_OTEL_SPANS_TABLE",
    );
  });

  test("trims environment and override values before using them in URLs and headers", () => {
    expect(
      resolveMlflowUcConfig(
        {
          MLFLOW_EXPERIMENT_ID: " 123456789 ",
          MLFLOW_UC_CATALOG: " main ",
          MLFLOW_UC_SCHEMA: " agent_traces ",
          MLFLOW_UC_TABLE_PREFIX: " appkit ",
          MLFLOW_OTEL_SPANS_TABLE: " main.agent_traces.appkit_otel_spans ",
        },
        {
          tablePrefix: " custom ",
          otelSpansTableName: " main.agent_traces.custom_otel_spans ",
        },
      ),
    ).toEqual({
      experimentId: "123456789",
      catalogName: "main",
      schemaName: "agent_traces",
      tablePrefix: "custom",
      otelSpansTableName: "main.agent_traces.custom_otel_spans",
    });
  });

  test("rejects malformed or internally inconsistent UC routing values together", () => {
    expect(() =>
      resolveMlflowUcConfig({
        MLFLOW_EXPERIMENT_ID: "experiment-123",
        MLFLOW_UC_CATALOG: "main.bad",
        MLFLOW_UC_SCHEMA: "agent traces",
        MLFLOW_UC_TABLE_PREFIX: "appkit/unsafe",
        MLFLOW_OTEL_SPANS_TABLE: "main.agent_traces.somewhere_else",
      }),
    ).toThrow(
      /MLFLOW_EXPERIMENT_ID.*MLFLOW_UC_CATALOG.*MLFLOW_UC_SCHEMA.*MLFLOW_UC_TABLE_PREFIX.*MLFLOW_OTEL_SPANS_TABLE/,
    );
  });
});

test("constructMlflowV4TraceId uses the UC table-prefix location and OTel ID", () => {
  const config = resolveMlflowUcConfig(completeEnv);

  expect(
    constructMlflowV4TraceId(config, "0123456789abcdef0123456789abcdef"),
  ).toBe("trace:/main.agent_traces.appkit/0123456789abcdef0123456789abcdef");
});
