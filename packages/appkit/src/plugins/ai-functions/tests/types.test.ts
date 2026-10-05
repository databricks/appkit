import type {
  AiFunctionTask,
  AiFunctionTaskInput,
  AiFunctionTaskResult,
  AiFunctionTasks,
  DecideAnswer,
  ExtractResult,
  ExtractValues,
} from "shared";
import { extractValues } from "shared";
import { expect, expectTypeOf, it } from "vitest";

import {
  aiFunctions,
  type ClassifyRequest,
  type ClassifyResponse,
  type DecideRequest,
  type DecideResponse,
  type ExtractField,
  type ExtractRequest,
  type ExtractResponse,
  type IAiFunctionsConfig,
} from "../../../beta";
import type { AiFunctionsPlugin } from "../ai-functions";

interface Ticket {
  id: string;
}

const ticket: Ticket = { id: "TICKET-1" };

const classifyRequest: ClassifyRequest = {
  content: ticket,
  labels: ["billing", "technical_support"],
  options: { version: "2.1", enable_confidence_scores: true },
};

const extractResponse: ExtractResponse<{
  company: ExtractField<string>;
}> = {
  response: {
    company: {
      value: "Acme",
      confidence_score: 0.98,
      citation_ids: [1],
    },
  },
  metadata: {
    version: "2.1",
    chunk_type: "span",
    citations: [
      { id: 1, start: 0, stop: 4 },
      {
        id: 2,
        bbox: [{ coord: [100, 200, 300, 240], page_id: 0 }],
      },
    ],
  },
};

const decideRequest: DecideRequest = {
  state: "A customer has reported suspected fraud.",
  questions: {
    team: {
      type: "choice",
      instructions: "Choose the responsible team.",
      criteria: { billing: "Payments and refunds" },
    },
    urgency: {
      type: "score",
      instructions: "Rate urgency.",
      criteria: ["Routine", "Critical"],
    },
  },
  options: { version: "1.0" },
};

// @ts-expect-error Choice questions require criteria.
const choiceWithoutCriteria: DecideRequest["questions"][string] = {
  type: "choice",
  instructions: "Choose one.",
};

const scoreWithInvalidCriteria: DecideRequest["questions"][string] = {
  type: "score",
  instructions: "Rate this.",
  // @ts-expect-error Score criteria must be an array.
  criteria: "high",
};

const extractWithArbitraryMode: ExtractRequest = {
  content: "text",
  schema: ["field"],
  // @ts-expect-error Extract mode only supports precision.
  options: { mode: "fast" },
};

const classifyWithUnsupportedVersion: ClassifyRequest = {
  content: "text",
  labels: ["one", "two"],
  // @ts-expect-error Classify only supports version 2.1.
  options: { version: "2.0" },
};

const decideWithUnsupportedVersion: DecideRequest = {
  state: "state",
  questions: decideRequest.questions,
  // @ts-expect-error Decide only supports version 1.0.
  options: { version: "2.1" },
};

const decideWithBooleanState: DecideRequest = {
  // @ts-expect-error Decide state cannot be boolean.
  state: true,
  questions: decideRequest.questions,
};

const classifyWithArrayContent: ClassifyRequest = {
  // @ts-expect-error Classify content cannot be an array.
  content: ["not", "allowed"],
  labels: ["one", "two"],
};

it("infers classify result values from the labels", () => {
  type Classify = InstanceType<typeof AiFunctionsPlugin>["classify"];
  const classify = (() => Promise.resolve({})) as unknown as Classify;
  type Value<F extends () => Promise<{ response?: { value: string }[] }>> =
    NonNullable<Awaited<ReturnType<F>>["response"]>[number]["value"];

  const fromArray = () =>
    classify({ content: "text", labels: ["billing", "technical"] });
  const fromObject = () =>
    classify({
      content: "text",
      labels: { billing: "Payments", account: "Login" },
    });
  const labelList: string[] = ["a", "b"];
  const fromWideArray = () => classify({ content: "text", labels: labelList });

  expectTypeOf<Value<typeof fromArray>>().toEqualTypeOf<
    "billing" | "technical"
  >();
  expectTypeOf<Value<typeof fromObject>>().toEqualTypeOf<
    "billing" | "account"
  >();
  expectTypeOf<Value<typeof fromWideArray>>().toEqualTypeOf<string>();
  const constLabels = ["spam", "ok"] as const;
  const fromConstArray = () =>
    classify({ content: "text", labels: constLabels });
  expectTypeOf<Value<typeof fromConstArray>>().toEqualTypeOf<"spam" | "ok">();
  expectTypeOf<ClassifyResponse>().toEqualTypeOf<ClassifyResponse<string>>();
});

it("infers each decide answer type from its question", () => {
  type Decide = InstanceType<typeof AiFunctionsPlugin>["decide"];
  const decide = (() => Promise.resolve({})) as unknown as Decide;
  const result = () =>
    decide({
      state: "message",
      questions: {
        spam: { type: "noul", instructions: "Is this spam?" },
        route: {
          type: "choice",
          instructions: "Which team?",
          criteria: { billing: "Billing", support: null },
        },
        urgency: {
          type: "score",
          instructions: "How urgent?",
          criteria: ["Low", "High"],
        },
      },
    });
  type Answers = NonNullable<
    Awaited<ReturnType<typeof result>>["response"]
  >["answers"];

  expectTypeOf<Answers["spam"]["probability"]>().toEqualTypeOf<number>();
  expectTypeOf<Answers["route"]["choice"]>().toEqualTypeOf<
    "billing" | "support"
  >();
  expectTypeOf<Answers["urgency"]["score"]>().toEqualTypeOf<number>();
  // @ts-expect-error Answers only exist for the questions you asked.
  expectTypeOf<Answers["missing"]>();
  const builtQuestions = {
    spam: { type: "noul", instructions: "Is this spam?" },
    route: {
      type: "choice",
      instructions: "Which team?",
      criteria: { billing: "Billing", support: null },
    },
    urgency: {
      type: "score",
      instructions: "How urgent?",
      criteria: ["Low", "High"],
    },
  } as const;
  const built = () => decide({ state: "message", questions: builtQuestions });
  type BuiltAnswers = NonNullable<
    Awaited<ReturnType<typeof built>>["response"]
  >["answers"];

  expectTypeOf<BuiltAnswers["spam"]["probability"]>().toEqualTypeOf<number>();
  expectTypeOf<BuiltAnswers["route"]["choice"]>().toEqualTypeOf<
    "billing" | "support"
  >();
  expectTypeOf<BuiltAnswers["urgency"]["score"]>().toEqualTypeOf<number>();
  expectTypeOf<DecideResponse["response"]>().toEqualTypeOf<
    { answers: Record<string, DecideAnswer> } | undefined
  >();
});

it("provides compile-time REST contract fixtures", () => {
  expectTypeOf(aiFunctions).toBeFunction();
  expectTypeOf<IAiFunctionsConfig>().toMatchTypeOf<{ timeout?: number }>();

  expect([
    classifyRequest,
    extractResponse,
    decideRequest,
    choiceWithoutCriteria,
    scoreWithInvalidCriteria,
    extractWithArbitraryMode,
    classifyWithUnsupportedVersion,
    decideWithUnsupportedVersion,
    decideWithBooleanState,
    classifyWithArrayContent,
  ]).toHaveLength(10);
});

const invoiceSchema = {
  invoice_number: { type: "string" },
  total_due: { type: "number", description: "Total due" },
  quantity: { type: "integer" },
  paid: { type: "boolean" },
  status: { type: "enum", labels: ["paid", "unpaid"] },
  tags: { type: "array", items: { type: "string" } },
  line_items: {
    type: "array",
    items: {
      type: "object",
      properties: { description: { type: "string" }, qty: { type: "integer" } },
    },
  },
  contact: { type: "object", properties: { email: { type: "string" } } },
  legacy: { type: "string", enum: ["a", "b"] },
} as const;

it("infers extract results from a literal schema", () => {
  type R = ExtractResult<typeof invoiceSchema>;
  expectTypeOf<R["invoice_number"]>().toEqualTypeOf<
    ExtractField<string | null>
  >();
  expectTypeOf<R["total_due"]>().toEqualTypeOf<ExtractField<number | null>>();
  expectTypeOf<R["quantity"]>().toEqualTypeOf<ExtractField<number | null>>();
  expectTypeOf<R["paid"]>().toEqualTypeOf<ExtractField<boolean | null>>();
  expectTypeOf<R["status"]>().toEqualTypeOf<
    ExtractField<"paid" | "unpaid" | null>
  >();
  expectTypeOf<R["tags"]>().toEqualTypeOf<ExtractField<string | null>[]>();
  expectTypeOf<R["line_items"][number]["qty"]>().toEqualTypeOf<
    ExtractField<number | null>
  >();
  expectTypeOf<R["contact"]["email"]>().toEqualTypeOf<
    ExtractField<string | null>
  >();
  expectTypeOf<R["legacy"]>().toEqualTypeOf<unknown>();
});

it("infers names-only and non-literal extract schemas", () => {
  expectTypeOf<ExtractResult<readonly ["name", "year"]>>().toEqualTypeOf<{
    name: ExtractField<string | null>;
    year: ExtractField<string | null>;
  }>();
  expectTypeOf<ExtractResult<string[]>>().toEqualTypeOf<
    Record<string, ExtractField<unknown>>
  >();
  expectTypeOf<
    ExtractResult<Record<string, unknown>>
  >().toEqualTypeOf<unknown>();
});

it("maps extract values without wrappers", () => {
  type V = ExtractValues<typeof invoiceSchema>;
  expectTypeOf<V["status"]>().toEqualTypeOf<"paid" | "unpaid" | null>();
  expectTypeOf<V["tags"]>().toEqualTypeOf<(string | null)[]>();
  expectTypeOf<V["line_items"][number]["qty"]>().toEqualTypeOf<number | null>();
  expectTypeOf<V["legacy"]>().toEqualTypeOf<unknown>();
});

const tasks = {
  routeTicket: {
    function: "classify",
    labels: { billing: "Payments", technical: "Bugs" },
    options: { enable_confidence_scores: true },
  },
  invoice: { function: "extract", schema: { total: { type: "number" } } },
  names: { function: "extract", schema: ["name", "year"] },
  triage: {
    function: "decide",
    questions: {
      route: {
        type: "choice",
        instructions: "Pick",
        criteria: { a: null, b: "B" },
      },
      urgent: { type: "noul", instructions: "Urgent?" },
      level: { type: "score", instructions: "Rate", criteria: ["low", "high"] },
    },
    auth: "on-behalf-of-user",
  },
} as const satisfies AiFunctionTasks;

it("types task inputs and results from as-const definitions", () => {
  expectTypeOf<AiFunctionTaskInput<typeof tasks.routeTicket>>().toEqualTypeOf<{
    content: string | import("shared").StructuredObject;
  }>();
  expectTypeOf<AiFunctionTaskInput<typeof tasks.triage>>().toEqualTypeOf<{
    state: import("shared").StructuredInput;
  }>();
  expectTypeOf<
    NonNullable<
      AiFunctionTaskResult<typeof tasks.routeTicket>["response"]
    >[number]["value"]
  >().toEqualTypeOf<"billing" | "technical">();
  expectTypeOf<
    NonNullable<AiFunctionTaskResult<typeof tasks.invoice>["response"]>["total"]
  >().toEqualTypeOf<ExtractField<number | null>>();
  expectTypeOf<
    NonNullable<AiFunctionTaskResult<typeof tasks.names>["response"]>["year"]
  >().toEqualTypeOf<ExtractField<string | null>>();
  type Answers = NonNullable<
    AiFunctionTaskResult<typeof tasks.triage>["response"]
  >["answers"];
  expectTypeOf<Answers["route"]["choice"]>().toEqualTypeOf<"a" | "b">();
  expectTypeOf<Answers["urgent"]["probability"]>().toEqualTypeOf<number>();
  expectTypeOf<Answers["level"]["score"]>().toEqualTypeOf<number>();
});

it("widens the default task type to a union", () => {
  expectTypeOf<AiFunctionTaskResult<AiFunctionTask>>().toEqualTypeOf<
    ClassifyResponse<string> | ExtractResponse<unknown> | DecideResponse
  >();
  expectTypeOf<AiFunctionTaskInput<AiFunctionTask>>().toEqualTypeOf<
    | { content: string | import("shared").StructuredObject }
    | { state: import("shared").StructuredInput }
  >();
});

it("rejects tasks that don't match the shape", () => {
  const bad = {
    // @ts-expect-error unknown function kind
    x: { function: "summarize", labels: ["a", "b"] },
  } satisfies AiFunctionTasks;
  expect(bad).toBeDefined();
});

it("run() types input from the task and infers inline tasks", () => {
  type Plugin = import("../ai-functions").AiFunctionsPlugin;
  type Run = Plugin["run"];
  // Never called: tsc checks the body, and vitest doesn't run it.
  const _typeChecks = (run: Run) => {
    // @ts-expect-error a classify task takes { content }, not { state }
    void run({ function: "classify", labels: ["a", "b"] }, { state: "x" });
    const inline = run(
      { function: "classify", labels: ["yes", "no"] },
      { content: "x" },
    );
    expectTypeOf(inline).resolves.toMatchTypeOf<{
      response?: { value: "yes" | "no" }[];
    }>();
  };
  expect(_typeChecks).toBeTypeOf("function");
});

it("extractValues accepts an untyped extract response and infers from the schema", () => {
  const schema = { name: { type: "string" } } as const;
  const untyped: ExtractResponse<unknown> = {
    response: { name: { value: "a" } },
  } as ExtractResponse<unknown>;
  const values = extractValues(untyped, schema);
  expectTypeOf(values).toEqualTypeOf<
    ExtractValues<typeof schema> | undefined
  >();
  expect(values).toEqual({ name: "a" });
});
