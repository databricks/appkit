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

export function resolveMlflowUcConfig(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  overrides: Partial<MlflowUcConfig> = {},
): MlflowUcConfig {
  const resolved = Object.fromEntries(
    Object.entries(ENV_FIELDS).map(([field, envName]) => [
      field,
      overrides[field as keyof MlflowUcConfig] ?? env[envName],
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

  return resolved;
}
