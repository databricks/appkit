import { createServer } from "node:http";

const host = process.env.INSPECTOR_BRIDGE_HOST || "127.0.0.1";
const port = Number(process.env.INSPECTOR_BRIDGE_PORT || "55107");
const logMode = process.env.INSPECTOR_BRIDGE_LOG_MODE || "both";

let lastBundle: unknown = null;
let lastPrompt = "";
let lastReceivedAt = "";

function readRequestBody(req: import("node:http").IncomingMessage) {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];

    req.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });

    req.on("error", reject);
  });
}

function summarizeBundle(bundle: unknown) {
  if (!bundle || typeof bundle !== "object") {
    return {
      appName: undefined,
      route: undefined,
      plugin: undefined,
      pickedElement: undefined,
      userPrompt: undefined,
      recentActions: 0,
      recentNetwork: 0,
      recentServerEvents: 0,
    };
  }

  const b = bundle as any;

  return {
    appName: b.app?.appName,
    route: b.page?.route,
    plugin: b.plugin?.name,
    pickedElement: b.page?.pickedElement?.selector || b.page?.pickedElement?.tagName || undefined,
    userPrompt: b.page?.userPrompt || undefined,
    recentActions: Array.isArray(b.page?.recentActions)
      ? b.page.recentActions.length
      : 0,
    recentNetwork: Array.isArray(b.client?.recentNetwork)
      ? b.client.recentNetwork.length
      : 0,
    recentServerEvents: Array.isArray(b.server?.recentEvents)
      ? b.server.recentEvents.length
      : 0,
  };
}

function printReceived(bundle: unknown, prompt: string) {
  const summary = summarizeBundle(bundle);

  if (logMode === "summary" || logMode === "both") {
    console.log(
      "[inspector-bridge] received context",
      JSON.stringify(summary, null, 2),
    );
    if (prompt) {
      console.log("[inspector-bridge] prompt length:", prompt.length, "chars");
    }
  }

  if (logMode === "full" || logMode === "both") {
    console.log("[inspector-bridge] full bundle start");
    console.log(JSON.stringify(bundle, null, 2));
    console.log("[inspector-bridge] full bundle end");
    if (prompt) {
      console.log("[inspector-bridge] prompt start");
      console.log(prompt);
      console.log("[inspector-bridge] prompt end");
    }
  }
}

const server = createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const url = new URL(req.url || "/", `http://${host}:${port}`);

  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, host, port }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/last") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ bundle: lastBundle, prompt: lastPrompt, receivedAt: lastReceivedAt }, null, 2));
    return;
  }

  if (req.method === "GET" && url.pathname === "/last-summary") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({ summary: summarizeBundle(lastBundle), hasPrompt: !!lastPrompt, receivedAt: lastReceivedAt }, null, 2),
    );
    return;
  }

  if (req.method === "GET" && url.pathname === "/last-prompt") {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end(lastPrompt || "No prompt available. Pick an element in the inspector first.");
    return;
  }

  if (req.method === "POST" && url.pathname === "/context") {
    try {
      const body = await readRequestBody(req);
      const parsed = body ? JSON.parse(body) : {};

      lastBundle = parsed.bundle || parsed;
      lastPrompt = typeof parsed.prompt === "string" ? parsed.prompt : "";
      lastReceivedAt = new Date().toISOString();

      const summary = summarizeBundle(lastBundle);
      printReceived(lastBundle, lastPrompt);

      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          receivedAt: lastReceivedAt,
          ...summary,
        }),
      );
    } catch (error) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: false,
          error: error instanceof Error ? error.message : "Invalid payload",
        }),
      );
    }
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: false, error: "Not found" }));
});

server.listen(port, host, () => {
  console.log(
    `[inspector-bridge] listening on http://${host}:${port} (POST /context)`,
  );
  console.log(
    `[inspector-bridge] endpoints: GET /last | /last-summary | /last-prompt | /health`,
  );
  console.log(
    `[inspector-bridge] log mode: ${logMode}`,
  );
});
