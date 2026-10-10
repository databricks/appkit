import { getCurrentPrincipalKey } from "@databricks/appkit";
import { createAgent, tool } from "@databricks/appkit/beta";
import { z } from "zod";

/**
 * B5 runtime-identity probe agent (default chat agent, id = folder "identity").
 *
 * Two tools make the execution identity observable in one chat turn:
 *
 *   - `analytics.query` is a PLUGIN-TOOLKIT tool. The agents plugin dispatches
 *     it through `executeTool`, which opens the request's user scope, so the
 *     SQL runs on behalf of the signed-in USER (OBO). `current_user()` returns
 *     the user's email.
 *
 *   - `whoami_sp` is a HAND-ROLLED tool({ execute }). `execute` receives only
 *     its arguments and runs in the ambient app context, never a user scope.
 *     `getCurrentPrincipalKey()` therefore returns "app" (the service
 *     principal), the direct complement of the OBO tool's "user:<id>". We also
 *     surface the SP client id from the platform-injected env so the SP has a
 *     concrete identifier alongside the principal kind.
 *
 * Why the accessor and not a SQL round-trip: inside an agent `tools(plugins)`
 * builder, `plugins.<name>` is a toolkit provider (it only exposes
 * `toolkit()`), not the service-principal exports, so a hand-rolled execute
 * cannot call `plugins.analytics.query`. `getCurrentPrincipalKey()` is the
 * simplest correct way for a hand-rolled execute to prove its principal.
 *
 * The agent model (serving endpoint) call also runs as the service principal:
 * the endpoint is bound to the app SP and the app declares no `model-serving`
 * user scope, so a working chat proves the model call does not use the user
 * token.
 */
const WHOAMI_SQL = "SELECT current_user() AS identity";

export default createAgent({
  default: true,
  instructions: [
    "You are a runtime identity probe.",
    "When the user asks who they are, who is running, or to prove identity,",
    "you MUST call BOTH tools, each exactly once, then report both results.",
    `1. call \`analytics.query\` with the query "${WHOAMI_SQL}" to get the`,
    "on-behalf-of USER identity (read the `identity` column from the result).",
    "2. call `whoami_sp` to get the app SERVICE PRINCIPAL identity.",
    "Reply with exactly these two lines:",
    "USER (OBO): <identity column from analytics.query>",
    "SERVICE PRINCIPAL: <principal from whoami_sp> <servicePrincipalClientId from whoami_sp>",
  ].join(" "),
  tools: (plugins) => ({
    // Plugin-toolkit tool: dispatched via executeTool, runs OBO (user).
    ...plugins.analytics.toolkit({ only: ["query"] }),
    // Hand-rolled tool: runs in the ambient app context (service principal).
    whoami_sp: tool({
      description:
        "Return the running principal for a hand-rolled tool: the principal kind and the app service principal client id.",
      schema: z.object({}),
      annotations: { effect: "read" },
      execute: async () => ({
        // "app" when running as the service principal; "user:<id>" would mean
        // a user scope leaked into a hand-rolled tool (it must not).
        principal: getCurrentPrincipalKey(),
        servicePrincipalClientId: process.env.DATABRICKS_CLIENT_ID ?? null,
      }),
    }),
  }),
});
