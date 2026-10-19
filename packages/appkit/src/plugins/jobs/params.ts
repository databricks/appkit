import type { TaskType } from "./types";

/** Throw if any value is not a string, number, or boolean. */
function assertPrimitiveValues(params: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(params)) {
    if (v !== null && v !== undefined && typeof v === "object") {
      throw new Error(
        `Parameter "${k}" must be a primitive value, got ${Array.isArray(v) ? "array" : "object"}`,
      );
    }
  }
}

/**
 * Maps validated parameters to SDK request fields based on the task type.
 * This is a pure function — stateless and testable in isolation.
 */
export function mapParams(
  taskType: TaskType,
  params: Record<string, unknown>,
): Record<string, unknown> {
  switch (taskType) {
    case "notebook":
      // notebookParams expects Record<string, string>, values coerced to string
      assertPrimitiveValues(params);
      return {
        notebookParams: Object.fromEntries(
          Object.entries(params).map(([k, v]) => [k, String(v)]),
        ),
      };
    case "python_wheel":
      assertPrimitiveValues(params);
      return {
        pythonNamedParams: Object.fromEntries(
          Object.entries(params).map(([k, v]) => [k, String(v)]),
        ),
      };
    case "python_script":
      // pythonParams expects string[] (positional args)
      return {
        pythonParams: Array.isArray(params.args) ? params.args.map(String) : [],
      };
    case "spark_jar":
      // jarParams expects string[]
      return {
        jarParams: Array.isArray(params.args) ? params.args.map(String) : [],
      };
    case "sql":
      assertPrimitiveValues(params);
      return {
        sqlParams: Object.fromEntries(
          Object.entries(params).map(([k, v]) => [k, String(v)]),
        ),
      };
    case "dbt":
      if (Object.keys(params).length > 0) {
        throw new Error("dbt tasks do not accept parameters");
      }
      return {};
    default: {
      const _exhaustive: never = taskType;
      throw new Error(`Unknown task type: ${_exhaustive}`);
    }
  }
}
