import type { TelemetryOptions } from "shared";

import type {
  BaseRun,
  GetJobResponse,
  GetRunOutputResponse,
  GetRunResponse,
} from "../../workspace-client";

export interface JobsConnectorConfig {
  telemetry?: TelemetryOptions;
}

/** A modular SDK model with its `bigint` int64s as `number` (JSON-safe). */
export type Numeric<T> = T extends bigint
  ? number
  : // Before the object branch: SDK enums are `"X" | (string & {})`.
    T extends string | number | boolean | null | undefined
    ? T
    : T extends readonly (infer U)[]
      ? Numeric<U>[]
      : T extends object
        ? { [K in keyof T]: Numeric<T[K]> }
        : T;

export type JobRun = Numeric<GetRunResponse>;
export type JobBaseRun = Numeric<BaseRun>;
export type JobRunOutput = Numeric<GetRunOutputResponse>;
export type JobDetails = Numeric<GetJobResponse>;
