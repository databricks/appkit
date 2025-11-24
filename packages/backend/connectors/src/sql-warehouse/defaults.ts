import type { sql } from "@databricks/sdk-experimental";
interface ExecuteStatementDefaults {
  wait_timeout: string;
  disposition: sql.ExecuteStatementRequest["disposition"];
  format: sql.ExecuteStatementRequest["format"];
  on_wait_timeout: sql.ExecuteStatementRequest["on_wait_timeout"];
  timeout: number;
}

// @TODO: Make these configurable globally and validate right values
export const executeStatementDefaults: ExecuteStatementDefaults = {
  wait_timeout: "30s",
  disposition: "INLINE",
  format: "JSON_ARRAY",
  on_wait_timeout: "CONTINUE",
  timeout: 60000,
};
