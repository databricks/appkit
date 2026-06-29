import { normalizeHost } from "./mlflow-rest";

/**
 * LLM-as-judge scoring via the `autoevals` library (the same scorers eve uses),
 * pointed at a Databricks serving endpoint. autoevals talks to an
 * OpenAI-compatible API; Databricks Model Serving exposes one at
 * `<host>/serving-endpoints`, so we set `OPENAI_BASE_URL`/`OPENAI_API_KEY` and
 * use the judge endpoint name as the model.
 *
 * There is no public REST to call Databricks' built-in judges directly (they're
 * Python/SDK-only and the rubric prompts live in the mlflow package), so we run
 * autoevals' equivalent scorers against a Databricks judge model.
 */
type AutoEvals = typeof import("autoevals");

let mod: AutoEvals | undefined;
let enabled = false;

export interface JudgeConfig {
  /** Databricks host (scheme optional). */
  host: string;
  /** Bearer token for the serving endpoint. */
  token: string;
  /** Serving endpoint name used as the judge model. */
  model: string;
}

/** A normalized judge result. `score` is 0..1. */
export interface JudgeScore {
  score: number;
  rationale?: string;
}

/**
 * Configure the judge once. Sets the OpenAI-compatible client env autoevals
 * reads and the default judge model. No-op-safe: on failure, judging stays
 * disabled and {@link isJudgeConfigured} returns false.
 */
export async function configureJudge(config: JudgeConfig): Promise<void> {
  try {
    mod = await import("autoevals");
    process.env.OPENAI_BASE_URL = `${normalizeHost(config.host)}/serving-endpoints`;
    process.env.OPENAI_API_KEY = config.token;
    mod.init({ defaultModel: config.model });
    enabled = true;
  } catch {
    enabled = false;
  }
}

export function isJudgeConfigured(): boolean {
  return enabled;
}

/** Normalize an autoevals `Score` into a `JudgeScore`. */
export function toJudgeScore(s: {
  score?: number | null;
  metadata?: Record<string, unknown>;
}): JudgeScore {
  const rationale = s.metadata?.rationale;
  return {
    score: typeof s.score === "number" ? s.score : 0,
    rationale: typeof rationale === "string" ? rationale : undefined,
  };
}

function ensure(): AutoEvals {
  if (!enabled || !mod) {
    throw new Error(
      "LLM judge is not configured. Set --judge-model (and DATABRICKS_HOST/DATABRICKS_TOKEN) to use t.judge.*",
    );
  }
  return mod;
}

/** Factuality of `output` vs an `expected` reference. */
export async function judgeFactuality(args: {
  input: string;
  output: string;
  expected: string;
}): Promise<JudgeScore> {
  return toJudgeScore(await ensure().Factuality(args));
}

/** Whether `output` answers the question in `input`, optionally constrained by `criteria`. */
export async function judgeClosedQA(args: {
  input: string;
  output: string;
  criteria: string;
}): Promise<JudgeScore> {
  return toJudgeScore(await ensure().ClosedQA(args));
}

/**
 * A custom LLM judge defined by a prompt template + choice→score map — the
 * TypeScript analog of MLflow's custom `@scorer`.
 */
export async function judgeCustom(
  spec: {
    name: string;
    promptTemplate: string;
    choiceScores: Record<string, number>;
  },
  args: { input: string; output: string },
): Promise<JudgeScore> {
  const scorer = ensure().LLMClassifierFromTemplate(spec);
  return toJudgeScore(await scorer(args));
}
