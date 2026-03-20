import { createServer } from "node:http";

const host = process.env.INSPECTOR_BRIDGE_HOST || "127.0.0.1";
const port = Number(process.env.INSPECTOR_BRIDGE_PORT || "55107");
const logMode = process.env.INSPECTOR_BRIDGE_LOG_MODE || "both";

let lastPayload: unknown = null;

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

function summarizePayload(payload: unknown) {
  if (!payload || typeof payload !== "object") {
    return {
      appName: undefined,
      route: undefined,
      plugin: undefined,
      recentActions: 0,
      recentNetwork: 0,
      recentServerEvents: 0,
    };
  }

  const bundle = payload as any;

  return {
    appName: bundle.app?.appName,
    route: bundle.page?.route,
    plugin: bundle.plugin?.name,
    recentActions: Array.isArray(bundle.page?.recentActions)
      ? bundle.page.recentActions.length
      : 0,
    recentNetwork: Array.isArray(bundle.client?.recentNetwork)
      ? bundle.client.recentNetwork.length
      : 0,
    recentServerEvents: Array.isArray(bundle.server?.recentEvents)
      ? bundle.server.recentEvents.length
      : 0,
  };
}

function printPayload(payload: unknown) {
  const summary = summarizePayload(payload);

  if (logMode === "summary" || logMode === "both") {
    console.log(
      "[inspector-bridge] received context summary",
      JSON.stringify(summary, null, 2),
    );
  }

  if (logMode === "full" || logMode === "both") {
    console.log("[inspector-bridge] full payload start");
    console.log(JSON.stringify(payload, null, 2));
    console.log("[inspector-bridge] full payload end");
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${host}:${port}`);

  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, host, port }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/last") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ payload: lastPayload }, null, 2));
    return;
  }

  if (req.method === "GET" && url.pathname === "/last-summary") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({ summary: summarizePayload(lastPayload) }, null, 2),
    );
    return;
  }

  if (req.method === "POST" && url.pathname === "/context") {
    try {
      const body = await readRequestBody(req);
      lastPayload = body ? JSON.parse(body) : null;
      const summary = summarizePayload(lastPayload);
      printPayload(lastPayload);

      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          receivedAt: new Date().toISOString(),
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
    `[inspector-bridge] log mode: ${logMode} | inspect latest payload at /last or /last-summary`,
  );
});
