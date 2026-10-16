import type { ExecuteStatementRequest } from "../../workspace-client";

interface ExecuteStatementDefaults {
  waitTimeout: string;
  disposition: ExecuteStatementRequest["disposition"];
  format: ExecuteStatementRequest["format"];
  onWaitTimeout: ExecuteStatementRequest["onWaitTimeout"];
  timeout: number;
}

// @TODO: Make these configurable globally and validate right values
export const executeStatementDefaults: ExecuteStatementDefaults = {
  waitTimeout: "30s",
  disposition: "INLINE",
  format: "JSON_ARRAY",
  onWaitTimeout: "CONTINUE",
  timeout: 60000,
};
