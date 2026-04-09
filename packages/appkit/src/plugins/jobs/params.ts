import type { TaskType } from "./types";

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
      // notebook_params expects Record<string, string>, values coerced to string
      return {
        notebook_params: Object.fromEntries(
          Object.entries(params).map(([k, v]) => [k, String(v)]),
        ),
      };
    case "python_wheel":
      return {
        python_named_params: Object.fromEntries(
          Object.entries(params).map(([k, v]) => [k, String(v)]),
        ),
      };
    case "python_script":
      // python_params expects string[] (positional args)
      return {
        python_params: Array.isArray(params.args)
          ? params.args.map(String)
          : [],
      };
    case "spark_jar":
      // parameters expects string[]
      return {
        parameters: Array.isArray(params.args) ? params.args.map(String) : [],
      };
    case "sql":
      return {
        parameters: Object.fromEntries(
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
