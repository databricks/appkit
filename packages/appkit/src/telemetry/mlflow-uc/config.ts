export interface MlflowUcConfig {
  experimentId: string;
  catalogName: string;
  schemaName: string;
  tablePrefix: string;
  otelSpansTableName: string;
}

const ENV_FIELDS = {
  experimentId: "MLFLOW_EXPERIMENT_ID",
  catalogName: "MLFLOW_UC_CATALOG",
  schemaName: "MLFLOW_UC_SCHEMA",
  tablePrefix: "MLFLOW_UC_TABLE_PREFIX",
  otelSpansTableName: "MLFLOW_OTEL_SPANS_TABLE",
} as const satisfies Record<keyof MlflowUcConfig, string>;

const UC_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,254}$/;

export function resolveMlflowUcConfig(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  overrides: Partial<MlflowUcConfig> = {},
): MlflowUcConfig {
  const resolved = Object.fromEntries(
    Object.entries(ENV_FIELDS).map(([field, envName]) => [
      field,
      (overrides[field as keyof MlflowUcConfig] ?? env[envName])?.trim(),
    ]),
  ) as unknown as MlflowUcConfig;
  const missing = Object.entries(ENV_FIELDS)
    .filter(([field]) => !resolved[field as keyof MlflowUcConfig]?.trim())
    .map(([, envName]) => envName);

  if (missing.length > 0) {
    throw new Error(
      `MLflow UC tracing configuration missing: ${missing.join(", ")}`,
    );
  }

  const invalid: string[] = [];
  if (!/^\d+$/.test(resolved.experimentId)) {
    invalid.push("MLFLOW_EXPERIMENT_ID must be numeric");
  }
  for (const [field, envName] of [
    ["catalogName", "MLFLOW_UC_CATALOG"],
    ["schemaName", "MLFLOW_UC_SCHEMA"],
    ["tablePrefix", "MLFLOW_UC_TABLE_PREFIX"],
  ] as const) {
    if (!UC_IDENTIFIER.test(resolved[field])) {
      invalid.push(`${envName} must be a simple Unity Catalog identifier`);
    }
  }
  const expectedSpansTable = `${resolved.catalogName}.${resolved.schemaName}.${resolved.tablePrefix}_otel_spans`;
  if (resolved.otelSpansTableName !== expectedSpansTable) {
    invalid.push(`MLFLOW_OTEL_SPANS_TABLE must equal ${expectedSpansTable}`);
  }
  if (invalid.length > 0) {
    throw new Error(
      `Invalid MLflow UC tracing configuration: ${invalid.join("; ")}`,
    );
  }

  return resolved;
}
