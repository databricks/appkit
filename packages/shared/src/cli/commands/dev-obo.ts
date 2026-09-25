import { execFile } from "node:child_process";
import {
  createServer,
  request,
  type Server,
  type OutgoingHttpHeaders,
} from "node:http";
import { promisify } from "node:util";

import { Command } from "commander";

const execute = promisify(execFile);
interface DevIdentity {
  token: string;
  userId: string;
  email?: string;
}

/** CLI output is credential-bearing. Never include it in an error or log. */
export async function loadDevOboIdentity(
  profile: string,
  run: (args: string[]) => Promise<{ stdout: string }> = (args) =>
    execute("databricks", args, { timeout: 30_000 }),
): Promise<DevIdentity> {
  try {
    const [tokenOutput, userOutput] = await Promise.all([
      run(["auth", "token", "--profile", profile]),
      run(["current-user", "me", "--profile", profile, "--output", "json"]),
    ]);
    const token = JSON.parse(tokenOutput.stdout).access_token;
    const user = JSON.parse(userOutput.stdout);
    if (
      typeof token !== "string" ||
      !token.trim() ||
      typeof user.id !== "string" ||
      !user.id.trim()
    )
      throw new Error();
    return {
      token,
      userId: user.id,
      email: typeof user.userName === "string" ? user.userName : undefined,
    };
  } catch {
    throw new Error(
      "Unable to obtain local OBO credentials. Authenticate the explicitly selected Databricks user profile and retry.",
    );
  }
}

/** A development-only HTTP proxy. Credentials travel only to a loopback target. */
export async function startDevOboProxy(options: {
  target: string;
  port: number;
  loadIdentity: () => Promise<DevIdentity>;
}): Promise<Server> {
  const target = new URL(options.target);
  if (
    target.protocol !== "http:" ||
    !["127.0.0.1", "[::1]"].includes(target.hostname) ||
    target.username ||
    target.password ||
    target.pathname !== "/" ||
    target.search ||
    target.hash
  ) {
    throw new Error(
      "Local OBO target must be an HTTP loopback origin, such as http://127.0.0.1:3000.",
    );
  }
  if (
    !Number.isInteger(options.port) ||
    options.port < 0 ||
    options.port > 65535
  )
    throw new Error("Invalid proxy port");
  if (
    process.env.NODE_ENV === "production" ||
    process.env.DATABRICKS_APP_NAME
  ) {
    throw new Error(
      "Local OBO emulation is disabled in production and deployed Apps.",
    );
  }
  // Revalidate credentials periodically; never save them to disk or environment.
  let identity = await options.loadIdentity();
  let loadedAt = Date.now();
  let refresh: Promise<void> | undefined;
  const server = createServer(async (req, res) => {
    const address = server.address();
    if (!address || typeof address === "string") {
      res.writeHead(503).end();
      return;
    }
    const host = `127.0.0.1:${address.port}`;
    const origin = `http://${host}`;
    // Reject browser cross-origin requests and DNS rebinding before loading credentials.
    if (
      req.headers.host !== host ||
      (req.headers.origin && req.headers.origin !== origin) ||
      (req.headers["sec-fetch-site"] &&
        !["same-origin", "none"].includes(
          String(req.headers["sec-fetch-site"]),
        ))
    ) {
      res
        .writeHead(403)
        .end("Local OBO proxy only accepts same-origin loopback requests.");
      return;
    }
    if (!req.url?.startsWith("/") || req.url.startsWith("//")) {
      res.writeHead(400).end();
      return;
    }
    try {
      if (Date.now() - loadedAt >= 30_000) {
        refresh ??= options
          .loadIdentity()
          .then((next) => {
            identity = next;
            loadedAt = Date.now();
          })
          .finally(() => {
            refresh = undefined;
          });
        await refresh;
      }
      const headers: OutgoingHttpHeaders = {
        ...req.headers,
        host: target.host,
      };
      // Drop hop-by-hop controls, including caller-supplied Connection tokens.
      for (const name of String(req.headers.connection ?? "").split(","))
        delete headers[name.trim().toLowerCase()];
      for (const name of [
        "connection",
        "proxy-authorization",
        "proxy-authenticate",
        "keep-alive",
        "upgrade",
        "authorization",
        "x-forwarded-email",
      ])
        delete headers[name];
      headers["x-forwarded-access-token"] = identity.token;
      headers["x-forwarded-user"] = identity.userId;
      if (identity.email) headers["x-forwarded-email"] = identity.email;
      const upstream = request(
        {
          hostname: target.hostname.replace(/^\[|\]$/g, ""),
          port: target.port || 80,
          path: req.url,
          method: req.method,
          headers,
        },
        (response) => {
          // No redirect following: credentials are sent to the fixed loopback target only.
          res.writeHead(response.statusCode ?? 502, response.headers);
          response.pipe(res);
        },
      );
      upstream.on("error", () => {
        if (!res.headersSent) res.writeHead(502);
        res.end("Local app unavailable.");
      });
      req.on("aborted", () => upstream.destroy());
      res.on("close", () => upstream.destroy());
      req.pipe(upstream);
    } catch {
      res
        .writeHead(401)
        .end(
          "Local OBO credentials unavailable. Reauthenticate the selected profile.",
        );
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

export const devOboCommand = new Command("dev-obo")
  .description(
    "Proxy a local app with an explicitly selected user's OBO credentials",
  )
  .requiredOption(
    "--profile <name>",
    "Databricks user profile (never defaults implicitly)",
  )
  .requiredOption("--target <origin>", "HTTP loopback app origin")
  .option("--port <port>", "Loopback proxy port", "3001")
  .action(
    async (options: { profile: string; target: string; port: string }) => {
      if (!options.profile.trim())
        throw new Error("Choose an explicit Databricks user profile.");
      const server = await startDevOboProxy({
        target: options.target,
        port: Number(options.port),
        loadIdentity: () => loadDevOboIdentity(options.profile),
      });
      const address = server.address();
      if (address && typeof address !== "string")
        console.log(
          `Local OBO proxy: http://127.0.0.1:${address.port}. For trusted local development only.`,
        );
      const close = () => {
        server.close();
        server.closeAllConnections();
      };
      process.once("SIGINT", close);
      process.once("SIGTERM", close);
    },
  );
