import type { AiFunctionTask, AiFunctionTasks } from "@databricks/appkit/beta";

import {
  EXAMPLES,
  type FunctionName,
  injectionCheck,
} from "./ai-functions-examples";

/** Example options are typed `object`; this narrows them into a task. */
function toTask(fn: FunctionName, options: object): AiFunctionTask {
  return {
    function: fn,
    ...options,
    auth: "on-behalf-of-user",
  } as AiFunctionTask;
}

function withoutContent(request: { content?: unknown }): object {
  const copy: Record<string, unknown> = { ...request };
  delete copy.content;
  return copy;
}

/**
 * One task per playground example, keyed by example id. The examples run as
 * the signed-in user to show OBO; the page's "service principal" mode uses
 * the demo routes instead.
 */
export const playgroundTasks: AiFunctionTasks = Object.fromEntries([
  ...(Object.keys(EXAMPLES) as FunctionName[]).flatMap((fn) =>
    EXAMPLES[fn].map((example) => [example.id, toTask(fn, example.options)]),
  ),
  // Service principal (the default auth), so the playground also exercises a
  // service-principal task route.
  [
    "promptInjectionCheck",
    {
      ...withoutContent(injectionCheck("")),
      function: "classify",
    } as AiFunctionTask,
  ],
]);
