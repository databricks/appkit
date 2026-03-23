import { Command } from "commander";

const DEFAULT_APP_PORT = 8000;
const DEFAULT_BRIDGE_PORT = 55107;

function getAppUrl(): string {
  if (process.env.DEVTOOLS_URL) return process.env.DEVTOOLS_URL;
  const port =
    process.env.DATABRICKS_APP_PORT || process.env.PORT || DEFAULT_APP_PORT;
  return `http://localhost:${port}/api/devtools`;
}

function getBridgeUrl(): string {
  return `http://127.0.0.1:${DEFAULT_BRIDGE_PORT}`;
}

async function tryFetch(
  url: string,
): Promise<Response | null> {
  try {
    const response = await fetch(url);
    if (response.ok) return response;
    return null;
  } catch {
    return null;
  }
}

async function resolveEndpoint(path: string): Promise<Response> {
  const appUrl = getAppUrl();
  const appResponse = await tryFetch(`${appUrl}${path}`);
  if (appResponse) return appResponse;

  const bridgeUrl = getBridgeUrl();
  const bridgeResponse = await tryFetch(`${bridgeUrl}${path}`);
  if (bridgeResponse) return bridgeResponse;

  console.error(
    `Could not connect to the devtools.\n\n` +
      `The CLI tried:\n` +
      `  1. AppKit server at ${appUrl} (set DEVTOOLS_URL to override)\n` +
      `  2. Standalone bridge at ${bridgeUrl}\n\n` +
      `Make sure your AppKit app is running with the devtools() plugin,\n` +
      `or start the standalone bridge: npx tsx tools/devtools-local-bridge.ts`,
  );
  process.exit(1);
}

async function fetchEndpoint(path: string): Promise<unknown> {
  const response = await resolveEndpoint(path);
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("text/plain")) {
    return response.text();
  }
  return response.json();
}

async function runContext() {
  const data = (await fetchEndpoint("/last")) as any;

  if (!data.bundle) {
    console.error(
      "No context available yet. Open the devtools in your browser (Cmd+K) and send context first.",
    );
    process.exit(1);
  }

  console.log(JSON.stringify(data.bundle, null, 2));
}

async function runPrompt() {
  const text = await fetchEndpoint("/last-prompt");

  if (typeof text === "string") {
    console.log(text);
  }
}

async function runSummary() {
  const data = (await fetchEndpoint("/last-summary")) as any;

  if (!data.summary) {
    console.error("No context available yet.");
    process.exit(1);
  }

  const s = data.summary;
  const lines = [
    `Route:          ${s.route || "(none)"}`,
    `Plugin:         ${s.plugin || "(unknown)"}`,
    `App:            ${s.appName || "(unnamed)"}`,
    `Picked element: ${s.pickedElement || "(none)"}`,
    `User prompt:    ${s.userPrompt || "(none)"}`,
    `Network calls:  ${s.recentNetwork}`,
    `Actions:        ${s.recentActions}`,
    `Server events:  ${s.recentServerEvents}`,
    `Has prompt:     ${data.hasPrompt ? "yes" : "no"}`,
    `Received at:    ${data.receivedAt || "(never)"}`,
  ];

  console.log(lines.join("\n"));
}

export const inspectCommand = new Command("inspect")
  .description(
    "Read live context from AppKit DevTools (auto-discovers the running app server)",
  )
  .action(runSummary);

inspectCommand
  .command("context")
  .description("Print the full context bundle as JSON")
  .action(runContext);

inspectCommand
  .command("prompt")
  .description("Print the generated AI prompt (ready to pipe to an agent)")
  .action(runPrompt);

inspectCommand
  .command("summary")
  .description("Print a one-line summary of the latest context")
  .action(runSummary);
