import type { Disposition, Format, OnWaitTimeout } from "./types";

interface ExecuteStatementDefaults {
  wait_timeout: string;
  disposition: Disposition;
  format: Format;
  on_wait_timeout: OnWaitTimeout;
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
