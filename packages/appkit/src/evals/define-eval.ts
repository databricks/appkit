import type { EvalConfig, EvalDefinition } from "./types";

/**
 * Define an agent eval. Default-export the result from a
 * `server/agents/<id>/evals/*.eval.ts` file.
 *
 * @example
 * ```ts
 * import { defineEval, includes } from "@databricks/appkit/beta";
 *
 * export default defineEval({
 *   description: "Weather agent basic coverage",
 *   async test(t) {
 *     await t.send("What's the weather in Brooklyn?");
 *     t.succeeded();
 *     t.calledTool("get_weather");
 *     t.check(t.reply, includes("Sunny"));
 *   },
 * });
 * ```
 */
export function defineEval(def: EvalDefinition): EvalDefinition {
  if (typeof def.test !== "function") {
    throw new Error("defineEval: `test` must be a function");
  }
  return def;
}

/** Define per-directory eval config. Default-export from `evals.config.ts`. */
export function defineEvalConfig(config: EvalConfig): EvalConfig {
  return config;
}
