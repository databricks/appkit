---
sidebar_position: 9
---

# AI Functions plugin

<!-- AUTO-GENERATED: stability-banner-start -->
:::warning Beta plugin
This plugin is currently **beta**. APIs may change between minor releases. Import from `@databricks/appkit/beta`. See [Plugin Stability Tiers](./stability.md).
:::
<!-- AUTO-GENERATED: stability-banner-end -->

Turn text into labels, fields, or answers your app can act on, with [Databricks AI Functions](https://docs.databricks.com/api/ai-functions/v1).

| Use | To | Example |
|---|---|---|
| `classify` | Tag or filter text | `"spam"` |
| `extract` | Pull fields from a document | `{ total_due: 1250 }` |
| `decide` | Answer questions about text | `{ route: "billing", urgency: 1.5 }` |

Define a task once, then call it from React, server code, or an agent.

For open-ended chat, use the [agents plugin](./agents.md). For batch work over tables, use [SQL AI Functions](https://docs.databricks.com/aws/en/large-language-models/ai-functions).

## Basic usage

Define a task in a file the server and client can both import:

```ts
// shared/ai-tasks.ts
import type { AiFunctionTasks } from "@databricks/appkit/beta";

export const aiTasks = {
  triageTicket: {
    function: "decide",
    questions: {
      route: { type: "choice", instructions: "Pick a team", criteria: { billing: "Payments", support: null } },
      escalate: {
        type: "noul",
        instructions: "Does this ticket need a manager?",
        criteria: { true: "Fraud, a legal threat, or an exception to policy", false: "A routine issue" },
      },
      urgency: { type: "score", instructions: "How urgent?", criteria: ["low", "medium", "high"] },
    },
  },
} as const satisfies AiFunctionTasks;
```

Register it on the server:

```ts
import { createApp, server } from "@databricks/appkit";
import { aiFunctions } from "@databricks/appkit/beta";
import { aiTasks } from "../shared/ai-tasks";

const AppKit = await createApp({ plugins: [server(), aiFunctions({ tasks: aiTasks })] });
```

Call it from React:

```tsx
import { useAiFunction } from "@databricks/appkit-ui/react/beta";
import type { aiTasks } from "../shared/ai-tasks";

const { invoke, data, loading, error } = useAiFunction<typeof aiTasks.triageTicket>("triageTicket");

const result = await invoke({ state: "I was charged twice and need a refund today." });
const answers = result?.response?.answers;
answers?.route.choice;         // "billing"
answers?.escalate.probability; // 0
answers?.urgency.score;        // 1.5, which scoreLevel rounds to "high"; results can vary between calls
```

`invoke` resolves the result. `data`, `loading`, and `error` update on the next render, so use them in JSX.

`decide` is in beta on Databricks, so a workspace admin might need to turn it on from the **Previews** page. `classify` and `extract` tasks work the same way, but take `content` instead of `state`. See [Tasks](#tasks).

### Example: is it spam?

`classify` picks the label that best fits the text. The label descriptions say what each label means:

```ts
import type { AiFunctionTask } from "@databricks/appkit/beta";

const spamCheck = {
  function: "classify",
  labels: {
    spam: "Ads, scams, or links unrelated to the post",
    not_spam: "A genuine comment, including criticism",
  },
} as const satisfies AiFunctionTask;

async function isSpam(comment: string) {
  const result = await AppKit.aiFunctions.run(spamCheck, { content: comment });
  return result.response?.[0]?.value === "spam";
}
```

"WIN a FREE iPhone!!! Click here" is spam. "This tutorial is garbage" isn't, because criticism isn't spam.

## Configuration options

| Option | Type | Default | Description |
|---|---|---|---|
| `tasks` | `AiFunctionTasks` | `{}` | Named tasks. With none, the plugin logs a warning, and routes and tools are inactive. |
| `timeout` | `number` | `60000` | Milliseconds per attempt. A timeout returns 504 and isn't retried. |
| `retry` | `object` | `{ enabled: true, attempts: 3, initialDelay: 1000, maxDelay: 10000 }` | Retries 503 responses, and 429 if the SDK passes one through. `{ enabled: false }` turns it off. |

AppKit pins function versions: `"2.1"` for classify and extract, `"1.0"` for decide. Any other `options.version` returns 400 from a direct call, and stops the app at startup when it is in a task. Versions change only when you upgrade `@databricks/appkit`.

### Tasks

A task is an [AI Functions REST](https://docs.databricks.com/api/ai-functions/v1) request without its input, plus `function`:

| `function` | Task fields | Options (snake_case) | Input |
|---|---|---|---|
| `classify` | `labels`: 2 to 500, a string array or a label-to-description object | `multilabel`, `enable_confidence_scores`, `enable_rationales`, `instructions` | `content` |
| `extract` | `schema`: up to 256 fields, a field-name array (every value is text) or an object of field definitions | `enable_confidence_scores`, `enable_citations`, `instructions`, `mode: "precision"` | `content` |
| `decide` | `questions`: an object of `choice`, `noul`, or `score` questions | none | `state` |

Every task also accepts:

- `description`: the agent tool description (1 to 1,000 characters).
- `auth`: `"service-principal"` (default) or `"on-behalf-of-user"`. See [Execution context](#execution-context).

Task names must match `^[A-Za-z][A-Za-z0-9_-]{0,63}$`. The plugin validates every task at startup, and a bad task stops the app with an error that names it, for example `aiFunctions task "tagTicket": too_small: labels must have at least 2 items`.

Extract field definitions are `{ type: "string" | "number" | "integer" | "boolean" }`, `{ type: "enum", labels: [...] }`, `{ type: "array", items: <definition> }`, or `{ type: "object", properties: { ... } }`. Each field has an optional `description`. Each result is `{ value, confidence_score?, citation_ids? }`, with `value` `null` when the field isn't found. Extract with citations can take 5 to 20 seconds.

Decide has three question types. [Basic usage](#basic-usage) shows one of each.

- `choice`: pick one of the `criteria` keys. The answer has `choice`, `probabilities`, and `confidence`.
- `noul`: a yes-or-no question. The answer has `probability` (0 to 1) that the answer is yes. Say what counts as yes, in the question itself or with `criteria: { true: "...", false: "..." }`. A vague question alone, such as "Is this spam?", gives unstable results. For a label such as spam, `classify` is simpler.
- `score`: rate on 2 to 10 levels, listed lowest first. The answer has `score` (a probability-weighted level index, such as `1.5`), `probabilities`, `legend`, and `confidence`.

## Execution context

| Call | Runs as |
|---|---|
| Route or tool for a task with `auth: "service-principal"` (default) | App service principal |
| Route or tool for a task with `auth: "on-behalf-of-user"` | Signed-in user |
| Tool for a service-principal task inside an on-behalf-of-user agent, or `runAgent` with a `caller` | Signed-in user: those runs never widen to the app's identity |
| `run`, `classify`, `extract`, `decide` | Service principal, or the user inside `AppKit.asUser(req)` |

Service-principal tasks spend the app's AI Functions quota for every signed-in user who calls them, and the plugin doesn't rate-limit them. Use `auth: "on-behalf-of-user"` to attribute calls to users.

User tasks and calls inside `AppKit.asUser(req)` need the `ai-functions` user API scope. The plugin's manifest declares it, so a Databricks CLI that builds scopes from plugin manifests adds it for you. Check that `user_api_scopes` in `databricks.yml` lists it, and add it if it's missing:

```yaml
resources:
  apps:
    my_app:
      user_api_scopes:
        - ai-functions
```

In local development (`NODE_ENV=development`), AppKit injects your own user credentials when `DATABRICKS_TOKEN` or `DATABRICKS_CONFIG_PROFILE` is set, so user tasks run as you. With injection off (`APPKIT_DEV_OBO=false`, or no token or profile), a user task without a token falls back to the service principal and AppKit logs a warning. In production, a user task without a token returns 401. See [Real user execution locally](./execution-context.md#real-user-execution-locally).

## HTTP endpoints

`POST /api/ai-functions/:task/invoke`

The body is exactly `{ content }` for classify and extract, or `{ state }` for decide. The response is the AI Functions JSON, unchanged. For a classify task:

```json
{ "response": [{ "value": "billing", "confidence_score": 0.93 }], "metadata": { "version": "2.1" } }
```

| Status | When |
|---|---|
| 400 | Any other field in the body, for example `unrecognized_keys: request has unknown key "labels"`, or an empty `content` string |
| 401 | No user token for a user task (see local development above), or an expired user token (`IDENTITY_EXPIRED`) |
| 404 | `No task configured with name "<name>"` |

A service-principal task doesn't need a user token.

## Programmatic access

```ts
const ticket = "I was charged twice and need a refund today.";

await AppKit.aiFunctions.run(aiTasks.triageTicket, { state: ticket });
await AppKit.aiFunctions.classify({ content: ticket, labels: ["spam", "not_spam"] });
await AppKit.aiFunctions.extract({ content: "Ada Lovelace, born 1815", schema: ["name", "year"] });
await AppKit.aiFunctions.decide({ state: ticket, questions: { refund: { type: "noul", instructions: "Does the customer ask for a refund?" } } });
```

`run()` takes the task definition, not its name, so its result is typed from the definition. It accepts any valid task, registered or not. Server calls run as the service principal by default, or as the user with `AppKit.asUser(req).aiFunctions.run(...)`. A task's `auth` applies only to routes and tools.

### Result helpers

These pure functions are exported from both `@databricks/appkit/beta` and `@databricks/appkit-ui/react/beta`:

```ts
import { type AiFunctionTask, citedText, extractValues, scoreLevel } from "@databricks/appkit/beta";

const invoiceFields = {
  function: "extract",
  schema: {
    total_due: { type: "number" },
    status: { type: "enum", labels: ["paid", "unpaid"] },
  },
  options: { enable_citations: true },
} as const satisfies AiFunctionTask;

const content = "Invoice INV-1. Total due: $1,250.00. Status: unpaid.";
const result = await AppKit.aiFunctions.run(invoiceFields, { content });
const values = extractValues(result, invoiceFields.schema);
// { total_due: number | null, status: "paid" | "unpaid" | null }

citedText(content, result.response?.total_due, result.metadata);
// ["Invoice INV-1. Total due: $1,250.00. Status: unpaid."]: the passage each citation points to

const triage = await AppKit.aiFunctions.run(aiTasks.triageTicket, { state: "I need a refund today." });
const urgency = triage.response?.answers.urgency;
if (urgency) scoreLevel(urgency); // { index: 2, level: "high" } for a score of 1.5
```

- `extractValues` flattens extract results to plain values. It returns `undefined` when the response has no `response` field.
- `citedText` needs the same `content` you sent. It works for text content with span citations, and returns `[]` otherwise.
- `scoreLevel` rounds a score to the nearest level.

## Agent tools

Each task is an agent tool named `<task>.invoke` (agents see it as `aiFunctions.<task>.invoke`), with input `{ content }`, or `{ state }` for decide. Its description is the task's `description`, or one generated from the labels, fields, or questions. Tools aren't added to agents automatically. List them:

```yaml
tools:
  - plugin:aiFunctions: [triageTicket.invoke]
```

Or in code: `plugins.aiFunctions.toolkit({ only: ["triageTicket.invoke"] })`. A tool runs with its task's `auth`, with one exception: in an on-behalf-of-user agent, or `runAgent` with a `caller`, a service-principal task runs as the user, because those runs never widen to the app's identity. Outside local development, every agent tool call needs the forwarded user token, even for service-principal tasks, because agents run tools in the user's request context.

## Frontend hooks

### useAiFunction

`useAiFunction<T>(task)` calls `POST /api/ai-functions/:task/invoke` and returns:

| Field | Description |
|---|---|
| `invoke(input)` | Runs the task. Resolves the result, or `null` on error or abort. |
| `data` | The last successful result, or `null`. Reset on each invoke. |
| `loading` | Whether a call is in flight. |
| `error` | The server's error message, or `HTTP <status>`. |

A new invoke, an unmount, or a change of `task` aborts the call in flight. Pass the task's type with `import type` to type the input and `data`. The type argument isn't checked against the name, so keep the two next to each other.

## Errors

Programmatic calls throw an `AppKitError` (from `@databricks/appkit`) with `statusCode` and `isRetryable`, so `error.isRetryable` tells you whether a retry can help. Route errors from the plugin return `{ error, plugin: "aiFunctions" }`. A 401 (missing user token) and a 413 (body too large) come from the AppKit server and return `{ error }` only.

- **400 from the plugin's checks** names the problem, for example `too_small: labels must have at least 2 items`.
- **400 from the API** starts with `Invalid AI Functions request:` and adds the API's explanation, for routes and server calls. The explanation can quote your request, so it isn't logged or traced, and agent tools get only the generic message.
- **401** with code `IDENTITY_EXPIRED` means a user task's token was rejected or expired. Reauthenticate and retry.
- **403** means the identity can't call AI Functions. For user tasks, check the `ai-functions` scope.
- **499** means the caller canceled the request through its own `signal`.
- **504** means a timeout. The Databricks SDK retries rate-limited (429) requests until `timeout`, so a sustained rate limit returns 504, not 429. Slow down or queue work.

### Common mistakes

| Mistake | Result | Fix |
|---|---|---|
| camelCase options, such as `enableConfidenceScores` | 400 `unrecognized_keys` with a snake_case hint | Use `enable_confidence_scores` |
| Shorthand fields, such as `{ total_due: "number" }` | 400 from the API | Use `{ total_due: { type: "number" } }` |
| `{ type: "string", enum: [...] }` | Works, but returns a bare value instead of `{ value }`, typed `unknown` | Use `{ type: "enum", labels: [...] }` |
| `content` sent to a decide task, or `state` to classify or extract | 400 `unrecognized_keys` | Decide takes `state`; classify and extract take `content` |
| Labels, schema, or questions sent from the browser | 400 `unrecognized_keys` | Define them in the task; send only the input |
| Missing `as const` | Labels and field names widen to `string`, and results lose their types | End the object with `as const satisfies AiFunctionTasks` |
| `import { aiTasks }` (not `import type`) in client code | Task definitions shipped in the client bundle | Use `import type` |
| 403 even though the app lists the `ai-functions` scope | The forwarded token lacks the scope | Recreate the app (see below) |
| Request body over 1 MB | 413 | Raise it with `server({ bodyLimit: "2mb" })` |

Apps created before the `ai-functions` scope existed can list it in `effective_user_api_scopes` without putting it in the user token. Recreate the app with the scope set at create time, then regrant the new service principal's permissions.
