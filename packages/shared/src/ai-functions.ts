/**
 * Public request, response, and task types for the AI Functions plugin.
 * Shared by `@databricks/appkit` (server) and `@databricks/appkit-ui` (hooks).
 */

/** Object input that excludes arrays while allowing concrete interfaces. */
export type StructuredObject = object & { readonly [Symbol.iterator]?: never };

/** Input accepted by AI Functions fields that support structured content. */
export type StructuredInput = string | readonly unknown[] | StructuredObject;

// ── classify ────────────────────────────────────────────────────────────

export interface ClassifyOptions {
  version?: "2.1";
  instructions?: string;
  multilabel?: boolean;
  enable_confidence_scores?: boolean;
  enable_rationales?: boolean;
}

export type ClassifyLabels =
  | readonly string[]
  | Readonly<Record<string, string>>;

/** Label names from a labels array or a labels-to-descriptions object. */
export type ClassifyLabel<L extends ClassifyLabels> =
  L extends readonly (infer S extends string)[] ? S : Extract<keyof L, string>;

export interface ClassifyRequest<L extends ClassifyLabels = ClassifyLabels> {
  content: string | StructuredObject;
  labels: L;
  options?: ClassifyOptions;
}

export interface ClassifyResult<V extends string = string> {
  value: V;
  confidence_score?: number;
  rationale?: string;
}

export interface ClassifyMetadata {
  version?: string;
}

export interface ClassifyResponse<V extends string = string> {
  response?: ClassifyResult<V>[];
  metadata?: ClassifyMetadata;
}

// ── extract ─────────────────────────────────────────────────────────────

export interface ExtractOptions {
  version?: "2.1";
  instructions?: string;
  mode?: "precision";
  enable_citations?: boolean;
  enable_confidence_scores?: boolean;
}

/** A names-only list, or an object of field definitions (plain AI Functions JSON). */
export type ExtractSchema =
  | readonly string[]
  | Readonly<Record<string, unknown>>;

export interface ExtractRequest<S extends ExtractSchema = ExtractSchema> {
  content: string | StructuredObject;
  schema: S;
  options?: ExtractOptions;
}

export type ExtractField<V = unknown> = {
  value: V;
  confidence_score?: number;
  citation_ids?: number[];
};

export interface SpanCitation {
  id: number;
  start: number;
  stop: number;
}

export interface BoundingBoxCitation {
  id: number;
  bbox: Array<{ coord: [number, number, number, number]; page_id: number }>;
}

/** Metadata returned alongside an extract response. */
export interface ExtractMetadata {
  version?: string;
  /** Present when `options.mode` is set, for example "precision". */
  mode?: string;
  chunk_type?: "span" | "bbox";
  citations?: Array<SpanCitation | BoundingBoxCitation>;
}

export interface ExtractResponse<T = unknown> {
  response?: T;
  metadata?: ExtractMetadata;
}

/** Response type for one schema node. Rows are checked top to bottom; the first match wins. */
type ExtractNodeResult<N> = N extends { readonly enum: unknown }
  ? unknown
  : N extends { readonly type: "string" }
    ? ExtractField<string | null>
    : N extends { readonly type: "number" | "integer" }
      ? ExtractField<number | null>
      : N extends { readonly type: "boolean" }
        ? ExtractField<boolean | null>
        : N extends {
              readonly type: "enum";
              readonly labels: readonly (infer L)[];
            }
          ? ExtractField<L | null>
          : N extends { readonly type: "array"; readonly items: infer I }
            ? ExtractNodeResult<I>[]
            : N extends {
                  readonly type: "object";
                  readonly properties: infer P;
                }
              ? { -readonly [K in keyof P]: ExtractNodeResult<P[K]> }
              : unknown;

/** Plain value type for one schema node (ExtractNodeResult without wrappers). */
type ExtractNodeValue<N> = N extends { readonly enum: unknown }
  ? unknown
  : N extends { readonly type: "string" }
    ? string | null
    : N extends { readonly type: "number" | "integer" }
      ? number | null
      : N extends { readonly type: "boolean" }
        ? boolean | null
        : N extends {
              readonly type: "enum";
              readonly labels: readonly (infer L)[];
            }
          ? L | null
          : N extends { readonly type: "array"; readonly items: infer I }
            ? ExtractNodeValue<I>[]
            : N extends {
                  readonly type: "object";
                  readonly properties: infer P;
                }
              ? { -readonly [K in keyof P]: ExtractNodeValue<P[K]> }
              : unknown;

/** Response shape inferred from an extract schema. */
export type ExtractResult<S> = S extends readonly (infer K extends string)[]
  ? string extends K
    ? Record<string, ExtractField<unknown>>
    : { [P in K]: ExtractField<string | null> }
  : S extends Readonly<Record<string, unknown>>
    ? string extends keyof S
      ? unknown
      : { -readonly [K in keyof S]: ExtractNodeResult<S[K]> }
    : unknown;

/** `ExtractResult<S>` with every `{ value }` wrapper removed. */
export type ExtractValues<S> = S extends readonly (infer K extends string)[]
  ? string extends K
    ? Record<string, unknown>
    : { [P in K]: string | null }
  : S extends Readonly<Record<string, unknown>>
    ? string extends keyof S
      ? unknown
      : { -readonly [K in keyof S]: ExtractNodeValue<S[K]> }
    : unknown;

// ── decide ──────────────────────────────────────────────────────────────

export interface ChoiceQuestion {
  type: "choice";
  instructions: StructuredInput;
  criteria: Readonly<Record<string, StructuredInput | null>>;
}

export interface NoulQuestion {
  type: "noul";
  instructions: StructuredInput;
  criteria?: { true?: StructuredInput; false?: StructuredInput };
}

export interface ScoreQuestion {
  type: "score";
  instructions: StructuredInput;
  criteria: readonly StructuredInput[];
}

export type DecideQuestion = ChoiceQuestion | NoulQuestion | ScoreQuestion;

export type DecideQuestions = Readonly<Record<string, DecideQuestion>>;

export interface DecideOptions {
  version?: "1.0";
}

export interface DecideRequest<Q extends DecideQuestions = DecideQuestions> {
  state: StructuredInput;
  questions: Q;
  options?: DecideOptions;
}

export interface ChoiceAnswer<C extends string = string> {
  type: "choice";
  choice: C;
  probabilities: Record<C, number>;
  confidence: number;
}

export interface NoulAnswer {
  type: "noul";
  probability: number;
}

/** Answer to a score question: a numeric score with a confidence. */
export interface ScoreAnswer {
  type: "score";
  score: number;
  probabilities: Record<string, number>;
  legend: Record<string, unknown>;
  confidence: number;
}

export type DecideAnswer = ChoiceAnswer | NoulAnswer | ScoreAnswer;

/** Answer type for a question: choice, noul, or score, matching its `type`. */
export type DecideAnswerFor<Q extends DecideQuestion> = Q extends {
  type: "choice";
  criteria: infer C;
}
  ? ChoiceAnswer<Extract<keyof C, string>>
  : Q extends { type: "noul" }
    ? NoulAnswer
    : ScoreAnswer;

export type DecideAnswers<Q extends DecideQuestions = DecideQuestions> = {
  -readonly [K in keyof Q]: DecideAnswerFor<Q[K]>;
};

export interface DecideMetadata {
  version?: string;
}

export interface DecideResponse<Q extends DecideQuestions = DecideQuestions> {
  response?: { answers: DecideAnswers<Q> };
  metadata?: DecideMetadata;
}

// ── tasks ───────────────────────────────────────────────────────────────

/** The three wrapped AI Functions. */
export type AiFunctionName = "classify" | "extract" | "decide";

export type AiFunctionTaskAuth = "service-principal" | "on-behalf-of-user";

interface AiFunctionTaskCommon {
  /** Agent tool description. Plain text, 1 to 1,000 characters. */
  description?: string;
  /** Identity for HTTP routes and agent tools. @default "service-principal" */
  auth?: AiFunctionTaskAuth;
}

export interface ClassifyTask<
  L extends ClassifyLabels = ClassifyLabels,
> extends AiFunctionTaskCommon {
  function: "classify";
  labels: L;
  options?: ClassifyOptions;
}

export interface ExtractTask<
  S extends ExtractSchema = ExtractSchema,
> extends AiFunctionTaskCommon {
  function: "extract";
  schema: S;
  options?: ExtractOptions;
}

export interface DecideTask<
  Q extends DecideQuestions = DecideQuestions,
> extends AiFunctionTaskCommon {
  function: "decide";
  questions: Q;
  options?: DecideOptions;
}

/** An AI Functions REST request minus its input, plus `function`. */
export type AiFunctionTask = ClassifyTask | ExtractTask | DecideTask;

/** A named set of tasks, keyed by task name. */
export type AiFunctionTasks = Readonly<Record<string, AiFunctionTask>>;

/** `{ content }` for classify and extract, `{ state }` for decide. */
export type AiFunctionTaskInput<T extends AiFunctionTask> = T extends {
  function: "decide";
}
  ? { state: StructuredInput }
  : { content: string | StructuredObject };

/** The response type a task produces, inferred from its definition. */
export type AiFunctionTaskResult<T extends AiFunctionTask> = T extends {
  function: "classify";
  labels: infer L extends ClassifyLabels;
}
  ? ClassifyResponse<ClassifyLabel<L>>
  : T extends { function: "extract"; schema: infer S }
    ? ExtractResponse<ExtractResult<S>>
    : T extends {
          function: "decide";
          questions: infer Q extends DecideQuestions;
        }
      ? DecideResponse<Q>
      : never;

/** Client config published by the aiFunctions plugin: task names and kinds only. */
// A type alias (not an interface) so it is assignable to the
// `Record<string, unknown>` that `Plugin.clientConfig()` returns.
export type AiFunctionsClientConfig = {
  tasks: Record<string, { function: AiFunctionName }>;
};
